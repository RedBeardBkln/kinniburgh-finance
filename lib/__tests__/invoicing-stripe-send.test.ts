// The pay link in the invoice e-mail and its PDF (plan S5), over the in-memory fake db with the REAL actions, store, PDF source and renderer
// (only the e-mail provider is mocked, so the attached PDF can be read back). Env values are fake strings built at run time.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

// Renders real PDFs inside the action and reads them back with pdfjs.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase-storage", () => ({ uploadLogoFile: vi.fn(), downloadLogoFile: vi.fn() }));
vi.mock("@/lib/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { sendEmail } from "@/lib/resend";
import { issueInvoice, saveDraft, sendInvoice } from "@/actions/invoices";
import { addContact, createClient } from "@/actions/clients";
import { buildInvoiceEmail } from "@/lib/invoicing/email";
import { LINK_SEND_IN_PROGRESS } from "@/lib/invoicing/store";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const sendMock = vi.mocked(sendEmail);
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const GL = "33333333-3333-4333-8333-333333333333";
const SLUG = "ek-consulting";
const K = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE", "NEXTAUTH_URL", "VERCEL_ENV", "RESEND_API_KEY", "INVOICE_EMAIL_FROM", "ENCRYPTION_KEY"] as const;
const saved: Record<string, string | undefined> = {};
function stripeEnv(on: boolean) {
  if (on) {
    process.env.STRIPE_SECRET_KEY = "rk_" + "test_" + "x".repeat(24);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec" + "_" + "y".repeat(24);
    process.env.STRIPE_MODE = "test";
  } else {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_MODE;
  }
}

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  process.env.RESEND_API_KEY = "test-placeholder";
  process.env.INVOICE_EMAIL_FROM = "LaunchTime Solutions <invoices@example.test>";
  process.env.NEXTAUTH_URL = "https://finance.example.test";
  delete process.env.VERCEL_ENV;
  stripeEnv(true);
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: "LaunchTime Solutions", archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null,
      replyToEmail: "owner@example.test", footerText: "Thank you for your business!", glMap: { ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" },
      termsText: null, checkPayableTo: null, remitToMailingAddress: null, logoKey: null, logoMime: null, einLast4: null, fromName: null,
      stripePayEnabled: true, publicTokenTtlDays: 90,
    },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document, fake.billingAccessToken, fake.stripeEvent]) t.rows = [];
}

async function issuedInvoice(unitPrice = "100.00"): Promise<string> {
  authMock.mockResolvedValue({ user: { id: ERIC, name: "Eric Kinniburgh" } });
  const c = await createClient({ slug: SLUG, name: "Acme Robotics" });
  if (!("id" in c)) throw new Error("client not created");
  const ct = await addContact({ slug: SLUG, clientId: c.id, name: "Pat", email: "pat@example.test", role: "billing", receivesInvoices: true });
  if ("error" in ct) throw new Error(ct.error);
  const d = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "Consulting", quantity: "1", unitPrice, glCodeId: GL }] } });
  if (!("id" in d)) throw new Error("draft not saved");
  const i = await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
  if (!("success" in i)) throw new Error("not issued");
  return d.id;
}

type SentArgs = { text: string; html: string; attachments: { content: Buffer }[] };
const lastSent = () => sendMock.mock.calls.at(-1)![0] as unknown as SentArgs;
const LINK = /https:\/\/finance\.example\.test\/i\/([A-Za-z0-9_-]{43})/g;

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i += 1) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out += tc.items.map((it) => ("str" in it ? it.str : "")).join("");
  }
  return out;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  seed();
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pay link in the e-mail and its PDF", () => {
  it("toggle OFF: the e-mail is exactly the Phase-1 e-mail, no link is minted", async () => {
    fake.invoicingProfile.rows[0]!.stripePayEnabled = false;
    const id = await issuedInvoice();
    const r = await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    expect(r).toEqual({ success: true, recipientCount: 1, sendCount: 1, payLink: "not_applicable" });
    const expected = buildInvoiceEmail({ displayNumber: "3100", businessName: "LaunchTime Solutions", totalText: "$100.00", balanceText: "$100.00", dueText: "Due upon receipt", footerText: "Thank you for your business!" });
    expect(lastSent().text).toBe(expected.text);
    expect(lastSent().html).toBe(expected.html);
    expect(lastSent().text).not.toMatch(/\/i\//);
    expect(fake.billingAccessToken.rows).toHaveLength(0);
    expect(await pdfText(lastSent().attachments[0]!.content)).not.toMatch(/Pay online/i);
  });

  it("toggle ON, configured, balance due: the body and the PDF carry the same single link, and only its hash is stored", async () => {
    const id = await issuedInvoice();
    const r = await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    expect(r).toEqual({ success: true, recipientCount: 1, sendCount: 1, payLink: "included" });
    const { text, html, attachments } = lastSent();
    const inText = [...text.matchAll(LINK)].map((m) => m[0]);
    expect(inText).toHaveLength(1);
    expect(text).toContain(`View and pay online: ${inText[0]}`);
    expect(html).toContain(`<a href="${inText[0]}"`);
    expect(new Set([...html.matchAll(LINK)].map((m) => m[0]))).toEqual(new Set(inText));
    const pdf = (await pdfText(attachments[0]!.content)).replace(/\s+/g, "");
    expect(pdf.toLowerCase()).toContain("payonline");
    expect(pdf).toContain(inText[0]!.replace(/\s+/g, ""));
    const token = /\/i\/([A-Za-z0-9_-]{43})$/.exec(inText[0]!)![1]!;
    const rows = fake.billingAccessToken.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(rows[0]!.purpose).toBe("email");
    expect(rows[0]!.revokedAt).toBeNull();
    const logs = JSON.stringify([fake.auditLog.rows, fake.billingEvent.rows, rows]);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("finance.example.test/i/");
    expect(fake.auditLog.rows.find((a) => a.changeType === "invoicing_invoice_email")!.after).toMatchObject({ payLink: true });
    expect(fake.billingEvent.rows.find((e) => e.kind === "emailed")!.data).toEqual({ recipientCount: 1, sendNumber: 1, payLink: true });
  });

  it("each send mints its own link", async () => {
    const id = await issuedInvoice();
    await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    const first = [...lastSent().text.matchAll(LINK)][0]![0];
    await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(2) });
    const second = [...lastSent().text.matchAll(LINK)][0]![0];
    expect(first).not.toBe(second);
    expect(fake.billingAccessToken.rows).toHaveLength(2);
  });

  it("no link when nothing (or less than $0.50) is due", async () => {
    const small = await issuedInvoice("0.40");
    expect(await sendInvoice({ slug: SLUG, documentId: small, requestKey: K(1) })).toMatchObject({ success: true, payLink: "not_applicable" });
    expect(lastSent().text).not.toMatch(/\/i\//);
    seed();
    const paid = await issuedInvoice();
    fake.billingAllocation.rows.push({ id: "al1", entityId: E, invoiceId: paid, paymentId: "pay1", amountCents: 10_000, appliedOn: new Date(), voidedAt: null });
    expect(await sendInvoice({ slug: SLUG, documentId: paid, requestKey: K(2) })).toMatchObject({ success: true, payLink: "not_applicable" });
    expect(lastSent().text).not.toMatch(/\/i\//);
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });

  it("toggle ON but Stripe not configured: sent WITHOUT a link, and the result says so", async () => {
    stripeEnv(false);
    const id = await issuedInvoice();
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toEqual({ success: true, recipientCount: 1, sendCount: 1, payLink: "omitted_not_configured" });
    expect(lastSent().text).not.toMatch(/\/i\//);
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });

  it("a double-submitted send (same request key) is refused before the provider is called", async () => {
    const id = await issuedInvoice();
    await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toEqual({ error: LINK_SEND_IN_PROGRESS });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fake.billingAccessToken.rows).toHaveLength(1);
  });

  it("a provider failure revokes the link that was minted for it", async () => {
    sendMock.mockRejectedValueOnce(new Error("provider down"));
    const id = await issuedInvoice();
    const r = await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    expect(r).toMatchObject({ sendFailure: "provider_error" });
    expect(fake.billingAccessToken.rows).toHaveLength(1);
    expect(fake.billingAccessToken.rows[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it("before the Phase-2 migration (profile without the Phase-2 columns) the e-mail goes out as in Phase 1", async () => {
    const p = fake.invoicingProfile.rows[0]!;
    delete p.stripePayEnabled;
    delete p.publicTokenTtlDays;
    const id = await issuedInvoice();
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toMatchObject({ success: true, payLink: "not_applicable" });
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });
});
