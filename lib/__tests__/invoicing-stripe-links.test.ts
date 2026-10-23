// The owner's client-link management and the "Online payments" settings (plan S4), over the in-memory fake db with the real actions,
// store and gate. Env values are obviously fake strings built at run time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase-storage", () => ({ uploadLogoFile: vi.fn(), downloadLogoFile: vi.fn() }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createPayLink, replacePayLink, revokePayLinks } from "@/actions/invoice-links";
import { setOnlinePayments, setPublicLinkTtl } from "@/actions/invoicing-setup";
import { hashInvoiceToken } from "@/lib/invoicing/access-token";
import { MAX_LIVE_LINKS_PER_INVOICE, PAY_FEATURE_NOT_SET_UP } from "@/lib/invoicing/constants";
import { NOT_INVOICING_OWNER_MESSAGE } from "@/lib/invoicing/owner";
import { STRIPE_MODE_MISMATCH_MESSAGE, STRIPE_NOT_CONFIGURED_MESSAGE } from "@/lib/invoicing/stripe/preflight";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const SLUG = "ek-consulting";
const K = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
const asUser = (id: string) => authMock.mockResolvedValue({ user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Eva" } });

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE", "NEXTAUTH_URL", "VERCEL_ENV"] as const;
const saved: Record<string, string | undefined> = {};
const fakeKey = (mode: "test" | "live") => "sk_" + mode + "_" + "x".repeat(24);
function setEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  const base = { STRIPE_SECRET_KEY: fakeKey("test"), STRIPE_WEBHOOK_SECRET: "whsec" + "_" + "y".repeat(24), STRIPE_MODE: "test", NEXTAUTH_URL: "https://finance.example.test", VERCEL_ENV: undefined };
  for (const k of ENV_KEYS) {
    const v = k in over ? over[k] : base[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function seed(status = "issued") {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: "LaunchTime Solutions", archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    { id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3101, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null, glMap: null, stripePayEnabled: false, publicTokenTtlDays: 90 },
  ];
  fake.billingDocument.rows = [{ id: DOC, entityId: E, kind: "invoice", clientId: CLIENT, status, number: 3100, displayNumber: "3100", archivedAt: null, totalCents: 10_000 }];
  for (const t of [fake.billingAccessToken, fake.billingEvent, fake.auditLog, fake.stripeEvent, fake.billingPayment, fake.billingAllocation]) t.rows = [];
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setEnv({});
  seed();
  asUser(ERIC);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("client links (owner)", () => {
  it("createPayLink returns the URL once (NEXTAUTH_URL origin + /i/ + a 43-character token) and stores only its hash", async () => {
    const r = await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) });
    expect("url" in r).toBe(true);
    const url = (r as { url: string }).url;
    const m = /^https:\/\/finance\.example\.test\/i\/([A-Za-z0-9_-]{43})$/.exec(url);
    expect(m).not.toBeNull();
    const token = m![1]!;
    const rows = fake.billingAccessToken.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashInvoiceToken(token));
    expect(rows[0]!.purpose).toBe("manual");
    expect(rows[0]!.createdById).toBe(ERIC);
    expect((rows[0]!.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    // The raw token and the URL are in no stored row, audit row or timeline row.
    const everything = JSON.stringify([fake.billingAccessToken.rows, fake.auditLog.rows, fake.billingEvent.rows]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(url);
    expect(fake.auditLog.rows.map((a) => a.changeType)).toEqual(["invoicing_paylink_create"]);
    expect(fake.billingEvent.rows.map((e) => e.kind)).toEqual(["link_created"]);
  });

  it("the same request key twice mints one link", async () => {
    await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) });
    const again = await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) });
    expect(again).toEqual({ error: "This link was already created. Reload the page." });
    expect(fake.billingAccessToken.rows).toHaveLength(1);
  });

  it.each(["draft", "void"])("refuses a %s invoice", async (status) => {
    seed(status);
    const r = await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) });
    expect(r).toEqual({ error: "Only an issued invoice can have a client link." });
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });

  it(`enforces the cap of ${MAX_LIVE_LINKS_PER_INVOICE} live links (expired and revoked ones do not count)`, async () => {
    for (let i = 0; i < MAX_LIVE_LINKS_PER_INVOICE; i += 1) expect("url" in (await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(i + 1) }))).toBe(true);
    expect(await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(99) })).toEqual({ error: "This invoice already has the most client links allowed. Revoke old links first." });
    fake.billingAccessToken.rows[0]!.expiresAt = new Date(Date.now() - 1);
    expect("url" in (await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(100) }))).toBe(true);
  });

  it("revoke sets revokedAt on the live links only; replace revokes and mints in one step", async () => {
    await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) });
    await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(2) });
    const oldRevoked = new Date("2026-01-01T00:00:00Z");
    fake.billingAccessToken.rows.push({ id: "old", entityId: E, documentId: DOC, tokenHash: "h-old", mintKey: null, purpose: "manual", expiresAt: new Date(Date.now() + 1e9), revokedAt: oldRevoked });
    const r = await revokePayLinks({ slug: SLUG, documentId: DOC });
    expect(r).toEqual({ success: true, count: 2 });
    expect(fake.billingAccessToken.rows.find((t) => t.id === "old")!.revokedAt).toEqual(oldRevoked);
    expect(fake.billingAccessToken.rows.every((t) => t.revokedAt instanceof Date)).toBe(true);
    const rep = await replacePayLink({ slug: SLUG, documentId: DOC, requestKey: K(3) });
    expect("url" in rep).toBe(true);
    expect(fake.billingAccessToken.rows.filter((t) => t.revokedAt === null)).toHaveLength(1);
  });

  it("a non-owner is refused before any link is minted", async () => {
    asUser(EVA);
    expect(await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(await revokePayLinks({ slug: SLUG, documentId: DOC })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(fake.billingAccessToken.rows).toHaveLength(0);
    expect(fake.auditLog.rows).toHaveLength(0);
  });

  it("without NEXTAUTH_URL (or with localhost in production) no link is made", async () => {
    setEnv({ NEXTAUTH_URL: undefined });
    expect(await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) })).toEqual({ error: expect.stringMatching(/NEXTAUTH_URL/) });
    setEnv({ NEXTAUTH_URL: "http://localhost:3000", VERCEL_ENV: "production" });
    expect(await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(2) })).toEqual({ error: expect.stringMatching(/NEXTAUTH_URL/) });
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });

  it("before the Phase-2 migration (no Phase-2 columns on the profile) the link actions answer 'not set up'", async () => {
    const p = fake.invoicingProfile.rows[0]!;
    delete p.stripePayEnabled;
    delete p.publicTokenTtlDays;
    expect(await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) })).toEqual({ error: PAY_FEATURE_NOT_SET_UP });
  });
});

describe("the Online payments toggle and the link lifetime", () => {
  const profile = () => fake.invoicingProfile.rows[0]!;
  it("turning on succeeds with a configured env and writes an id-only audit row", async () => {
    expect(await setOnlinePayments({ slug: SLUG, enabled: true })).toEqual({ success: true });
    expect(profile().stripePayEnabled).toBe(true);
    expect(fake.auditLog.rows.at(-1)).toMatchObject({ changeType: "invoicing_online_payments", after: { entityId: E, enabled: true } });
  });
  it("turning on is refused when Stripe is not configured, on a mode mix-up, and without a usable public address; values are never echoed", async () => {
    setEnv({ STRIPE_SECRET_KEY: undefined });
    expect(await setOnlinePayments({ slug: SLUG, enabled: true })).toEqual({ error: STRIPE_NOT_CONFIGURED_MESSAGE });
    setEnv({ STRIPE_SECRET_KEY: fakeKey("live"), STRIPE_MODE: "test" });
    expect(await setOnlinePayments({ slug: SLUG, enabled: true })).toEqual({ error: STRIPE_MODE_MISMATCH_MESSAGE });
    setEnv({ NEXTAUTH_URL: "http://localhost:3000", VERCEL_ENV: "production" });
    const r = await setOnlinePayments({ slug: SLUG, enabled: true });
    expect(r).toEqual({ error: expect.stringMatching(/NEXTAUTH_URL/) });
    setEnv({ STRIPE_SECRET_KEY: fakeKey("live"), STRIPE_MODE: "live", NEXTAUTH_URL: "http://finance.example.test" });
    expect(await setOnlinePayments({ slug: SLUG, enabled: true })).toEqual({ error: expect.stringMatching(/https/) });
    expect(profile().stripePayEnabled).toBe(false);
    for (const msg of [STRIPE_NOT_CONFIGURED_MESSAGE, STRIPE_MODE_MISMATCH_MESSAGE]) expect(msg).not.toMatch(/x{10}|y{10}/);
  });
  it("turning off is always allowed", async () => {
    profile().stripePayEnabled = true;
    setEnv({ STRIPE_SECRET_KEY: undefined, NEXTAUTH_URL: undefined });
    expect(await setOnlinePayments({ slug: SLUG, enabled: false })).toEqual({ success: true });
    expect(profile().stripePayEnabled).toBe(false);
  });
  it("the link lifetime is 7 to 365 days", async () => {
    expect(await setPublicLinkTtl({ slug: SLUG, days: 6 })).toEqual({ error: "A link must stay valid between 7 and 365 days." });
    expect(await setPublicLinkTtl({ slug: SLUG, days: 366 })).toEqual({ error: "A link must stay valid between 7 and 365 days." });
    expect(await setPublicLinkTtl({ slug: SLUG, days: 30 })).toEqual({ success: true });
    expect(profile().publicTokenTtlDays).toBe(30);
    await createPayLink({ slug: SLUG, documentId: DOC, requestKey: K(1) });
    const ms = (fake.billingAccessToken.rows[0]!.expiresAt as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(29 * 86_400_000);
    expect(ms).toBeLessThanOrEqual(30 * 86_400_000);
  });
  it("Eva cannot change either", async () => {
    asUser(EVA);
    expect(await setOnlinePayments({ slug: SLUG, enabled: true })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(await setPublicLinkTtl({ slug: SLUG, days: 30 })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
  });
});
