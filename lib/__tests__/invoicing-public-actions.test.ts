// The client's token-gated actions (actions/public-invoice.ts) and the token loader, over the in-memory fake db (modelled on
// review-queue-action.test.ts). The REAL token validation runs (shape check, sha256 lookup, revoked / expired / foreign / draft), so these
// tests exercise the security claim: no export works without a valid token, an implausible token never reaches the database, every
// invalid case gives the same neutral sentence, and the invoice is derived only from the token's own row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/invoicing/stripe/client", () => ({ createCheckoutSession: vi.fn(), retrieveCheckoutSession: vi.fn(), retrievePaymentIntentFee: vi.fn(), verifyStripeEvent: vi.fn() }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { markInvoiceViewed, startCheckout } from "@/actions/public-invoice";
import { hashInvoiceToken, mintInvoiceToken } from "@/lib/invoicing/access-token";
import { INVALID_LINK_MESSAGE } from "@/lib/invoicing/constants";
import { resolvePublicAccess } from "@/lib/invoicing/pay-build";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const DOC2 = "33333333-3333-4333-8333-333333333334";
const SLUG = "ek-consulting";

function seed() {
  fake.entity.rows = [
    { id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: "LaunchTime Solutions", archivedAt: null },
    { id: OTHER, name: "Sudden Valley Property Management LLC", slug: "sudden-valley", dbaName: null, archivedAt: null },
  ];
  fake.invoicingProfile.rows = [{ id: "p1", entityId: E, enabled: true, stripePayEnabled: false, publicTokenTtlDays: 90 }];
  fake.client.rows = [{ id: CLIENT, entityId: E, name: "Acme", archivedAt: null }];
  const doc = (id: string, over: Record<string, unknown> = {}) => ({
    id, entityId: E, kind: "invoice", clientId: CLIENT, status: "issued", number: 3100, displayNumber: "3100", archivedAt: null, totalCents: 10_000, subtotalCents: 10_000,
    discountCents: 0, sendCount: 0, sentAt: null, dueDate: null, issueDate: new Date("2026-10-20T00:00:00Z"), ...over,
  });
  fake.billingDocument.rows = [doc(DOC), doc(DOC2, { number: 3101, displayNumber: "3101" })];
  for (const t of [fake.billingAccessToken, fake.billingEvent, fake.billingAllocation, fake.billingPayment, fake.auditLog, fake.stripeEvent]) t.rows = [];
}

function addToken(over: Record<string, unknown> = {}): string {
  const { token, tokenHash } = mintInvoiceToken();
  fake.billingAccessToken.rows.push({
    id: `tok-${fake.billingAccessToken.rows.length + 1}`, entityId: E, documentId: DOC, tokenHash, mintKey: null, purpose: "manual",
    expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, createdById: null, firstViewedAt: null, lastViewedAt: null, viewCount: 0, ...over,
  });
  return token;
}

beforeEach(() => {
  vi.restoreAllMocks();
  seed();
  authMock.mockResolvedValue(null);
});

describe("source pins (every export is token-gated)", () => {
  const src = readFileSync(join(process.cwd(), "actions/public-invoice.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  const exports = [...code.matchAll(/export async function (\w+)\(([^)]*)\)[^\n]*\{\n\s*([^\n]*)/g)];
  it("exports exactly markInvoiceViewed and startCheckout, each taking only the token", () => {
    expect(exports.map((m) => m[1]).sort()).toEqual(["markInvoiceViewed", "startCheckout"]);
    for (const m of exports) expect(m[2], m[1]).toBe("token: string");
    expect(code).not.toMatch(/export (const|let|var|class|default)/);
  });
  it("every export's FIRST statement is the token gate", () => {
    expect(exports).toHaveLength(2);
    for (const m of exports) expect(m[3], m[1]).toMatch(/^(const \w+ = )?await requireInvoiceAccess\(token\);$/);
  });
  it("is a 'use server' file that never uses requireAuth (the token is the gate) and touches no model directly", () => {
    expect(src.trimStart().startsWith('"use server"')).toBe(true);
    expect(code).not.toMatch(/requireAuth\(|requireInvoicingOwner\(/);
    expect(code).not.toMatch(/\bdb\.|from "@\/lib\/db"/);
  });
});

describe("the token gate", () => {
  it("an implausible token never touches the database", async () => {
    const spy = vi.spyOn(fake.billingAccessToken, "findUnique");
    for (const t of ["", "short", "A".repeat(42), `${"A".repeat(42)}=`, "../../etc/passwd"]) {
      await expect(markInvoiceViewed(t)).rejects.toThrow(INVALID_LINK_MESSAGE);
      await expect(startCheckout(t)).rejects.toThrow(INVALID_LINK_MESSAGE);
      expect(await resolvePublicAccess(t, new Date())).toEqual({ ok: false });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("unknown, revoked, expired, draft, archived, foreign-entity and disabled-profile links all refuse with the same sentence", async () => {
    const cases: (() => string)[] = [
      () => mintInvoiceToken().token, // unknown
      () => addToken({ revokedAt: new Date(Date.now() - 1000) }),
      () => addToken({ expiresAt: new Date(Date.now() - 1) }),
      () => {
        fake.billingDocument.rows[0]!.status = "draft";
        return addToken();
      },
      () => {
        fake.billingDocument.rows[0]!.archivedAt = new Date();
        return addToken();
      },
      () => addToken({ entityId: OTHER }),
      () => {
        fake.invoicingProfile.rows[0]!.enabled = false;
        return addToken();
      },
      () => {
        fake.entity.rows[0]!.slug = "not-allow-listed";
        return addToken();
      },
    ];
    for (const make of cases) {
      seed();
      const t = make();
      expect(await resolvePublicAccess(t, new Date())).toEqual({ ok: false });
      await expect(markInvoiceViewed(t)).rejects.toThrow(INVALID_LINK_MESSAGE);
      await expect(startCheckout(t)).rejects.toThrow(INVALID_LINK_MESSAGE);
    }
  });

  it("the invoice comes from the token's own row (a valid token for invoice A can only ever act on A)", async () => {
    const t = addToken();
    const a = await resolvePublicAccess(t, new Date());
    expect(a).toMatchObject({ ok: true, documentId: DOC, entityId: E, status: "issued" });
    // Another invoice's link is a different token row; the actions accept no id, so there is nothing to point elsewhere.
    expect(markInvoiceViewed.length).toBe(1);
    expect(startCheckout.length).toBe(1);
  });

  it("only a SHA-256 hash is looked up (the raw token is never a query value)", async () => {
    const t = addToken();
    const spy = vi.spyOn(fake.billingAccessToken, "findUnique");
    await resolvePublicAccess(t, new Date());
    const arg = JSON.stringify(spy.mock.calls[0]![0]);
    expect(arg).toContain(hashInvoiceToken(t));
    expect(arg).not.toContain(t);
  });

  it("a void invoice's live link still resolves (the client must learn it was cancelled)", async () => {
    fake.billingDocument.rows[0]!.status = "void";
    const t = addToken();
    expect(await resolvePublicAccess(t, new Date())).toMatchObject({ ok: true, status: "void" });
  });
});

describe("view tracking", () => {
  it("the first view writes one link_viewed event; a second view counts but adds no event", async () => {
    const t = addToken();
    await markInvoiceViewed(t);
    await markInvoiceViewed(t);
    const row = fake.billingAccessToken.rows[0]!;
    expect(row.viewCount).toBe(2);
    expect(row.firstViewedAt).toBeInstanceOf(Date);
    expect(row.lastViewedAt).toBeInstanceOf(Date);
    const ev = fake.billingEvent.rows.filter((e) => e.kind === "link_viewed");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actorId).toBeNull();
    expect(JSON.stringify(ev[0])).not.toContain(t);
    expect(JSON.stringify(ev[0])).not.toContain(hashInvoiceToken(t));
  });

  it("a household member who is signed in does not count as a view", async () => {
    authMock.mockResolvedValue({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", name: "Eric Kinniburgh" } });
    const t = addToken();
    expect(await markInvoiceViewed(t)).toEqual({ ok: true });
    expect(fake.billingAccessToken.rows[0]!.viewCount).toBe(0);
    expect(fake.billingEvent.rows).toHaveLength(0);
  });

  it("no AuditLog row is written by the public actions", async () => {
    const t = addToken();
    await markInvoiceViewed(t);
    expect(fake.auditLog.rows).toHaveLength(0);
  });
});
