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
import { GET as clientPdf } from "@/app/i/[token]/pdf/route";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const sendMock = vi.mocked(sendEmail);
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const GL = "33333333-3333-4333-8333-333333333333";
const SLUG = "ek-consulting";
const K = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE", "NEXTAUTH_URL", "VERCEL_ENV", "RESEND_API_KEY", "INVOICE_EMAIL_FROM", "ENCRYPTION_KEY", "INVOICE_PUBLIC_BASE_URL"] as const;
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
  delete process.env.INVOICE_PUBLIC_BASE_URL;
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
    // Scope addition 2: a button; the URL is ONLY in the href (exactly once) and never visible text in the HTML.
    expect(html.split(inText[0]!)).toHaveLength(2);
    expect(html.split(`href="${inText[0]}"`)).toHaveLength(2);
    const visible = html.replace(/<[^>]*>/g, " ");
    expect(visible).toContain("View and pay online");
    expect(visible).not.toMatch(/https?:|\/i\//);
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

// stripe-ach-pending-hide-pay: a bank payment still processing omits the pay link; the ACH-preferred sentence rides with the link only.
describe("a bank (ACH) payment still processing", () => {
  const ACH = "Bank transfer (ACH) is preferred.";
  const addPending = (documentId: string) =>
    fake.billingEvent.rows.push({ id: "bp1", entityId: E, kind: "bank_payment_pending", actorId: null, documentId, paymentId: null, clientId: null, eventKey: "stripe:evt_1:bank_pending", createdAt: new Date(), data: { amountCents: 10_000, paymentIntentId: "pi_b1", livemode: false } });

  it("the e-mail goes out WITHOUT a link (no token minted) and the result says why", async () => {
    const id = await issuedInvoice();
    addPending(id);
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toEqual({ success: true, recipientCount: 1, sendCount: 1, payLink: "omitted_bank_pending" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const { text, html, attachments } = lastSent();
    expect(text).not.toMatch(/\/i\//);
    expect(html).not.toMatch(/\/i\//);
    expect(text).not.toContain(ACH);
    expect(html).not.toContain(ACH);
    expect(fake.billingAccessToken.rows).toHaveLength(0);
    expect(await pdfText(attachments[0]!.content)).not.toMatch(/Pay online/i);
  });

  it("a failed check also omits the link (fail closed), never the e-mail", async () => {
    const id = await issuedInvoice();
    const real = fake.billingEvent.findMany.bind(fake.billingEvent);
    const spy = vi.spyOn(fake.billingEvent, "findMany").mockImplementation(async (args) => {
      const kind = args?.where?.kind as { in?: string[] } | undefined;
      if (kind && Array.isArray(kind.in) && kind.in.includes("bank_payment_pending")) throw Object.assign(new Error("db"), { name: "PrismaClientUnknownRequestError" });
      return real(args);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toMatchObject({ success: true, payLink: "omitted_check_failed" });
    spy.mockRestore();
    log.mockRestore();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(lastSent().text).not.toMatch(/\/i\//);
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });

  it("with a link, the text and the HTML carry 'Bank transfer (ACH) is preferred.' once, right after it", async () => {
    const id = await issuedInvoice();
    await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    const { text, html } = lastSent();
    const link = [...text.matchAll(LINK)][0]![0];
    expect(text).toContain(`View and pay online: ${link}\n${ACH}`);
    expect(text.split(ACH)).toHaveLength(2);
    expect(html.split(ACH)).toHaveLength(2);
    expect(html.indexOf(ACH)).toBeGreaterThan(html.indexOf(`<a href="${link}"`));
    expect(`${text}${html}`).not.toMatch(/surcharge|\bfee\b/i);
  });

  it("INVOICE_PUBLIC_BASE_URL set: the e-mail (text and button) and its PDF carry the link on that origin, never NEXTAUTH_URL's", async () => {
    process.env.INVOICE_PUBLIC_BASE_URL = "https://pay.example.test/";
    const id = await issuedInvoice();
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toMatchObject({ success: true, payLink: "included" });
    const { text, html, attachments } = lastSent();
    const PAY = /https:\/\/pay\.example\.test\/i\/([A-Za-z0-9_-]{43})/g;
    const inText = [...text.matchAll(PAY)].map((m) => m[0]);
    expect(inText).toHaveLength(1);
    expect(html.split(`href="${inText[0]}"`)).toHaveLength(2);
    expect(`${text}${html}`).not.toContain("finance.example.test");
    const pdf = (await pdfText(attachments[0]!.content)).replace(/\s+/g, "");
    expect(pdf).toContain(inText[0]!.replace(/\s+/g, ""));
    expect(pdf).not.toContain("finance.example.test");
  });

  it("an invalid INVOICE_PUBLIC_BASE_URL sends the e-mail without a link (no fallback to NEXTAUTH_URL)", async () => {
    process.env.INVOICE_PUBLIC_BASE_URL = "http://pay.example.test";
    const id = await issuedInvoice();
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) })).toMatchObject({ success: true, payLink: "omitted_not_configured" });
    expect(lastSent().text).not.toMatch(/\/i\//);
    expect(lastSent().html).not.toMatch(/\/i\//);
    expect(fake.billingAccessToken.rows).toHaveLength(0);
  });

  it("the no-link e-mail is byte-identical to the Phase-1 e-mail", () => {
    const base = { displayNumber: "3100", businessName: "LaunchTime Solutions", totalText: "$100.00", balanceText: "$100.00", dueText: "Due upon receipt", footerText: null };
    const a = buildInvoiceEmail(base);
    expect(buildInvoiceEmail({ ...base, payUrl: null })).toEqual(a);
    expect(a.text).toBe(["Hello,", "", "Please find attached invoice 3100 from LaunchTime Solutions for $100.00.", "Due upon receipt.", "", "If you have any questions, simply reply to this e-mail.", "", "Thank you for your business.", "LaunchTime Solutions"].join("\n"));
    expect(a.html).not.toContain(ACH);
  });

  it("the client's PDF (/i/<token>/pdf) has no pay line while the payment is processing, and has it again once it closes", async () => {
    const id = await issuedInvoice();
    await sendInvoice({ slug: SLUG, documentId: id, requestKey: K(1) });
    const token = /\/i\/([A-Za-z0-9_-]{43})/.exec(lastSent().text)![1]!;
    const get = async () => {
      const res = await clientPdf(new Request(`https://finance.example.test/i/${token}/pdf`), { params: Promise.resolve({ token }) });
      expect(res.status).toBe(200);
      return pdfText(new Uint8Array(await res.arrayBuffer()));
    };
    expect(await get()).toMatch(/Pay online/i);
    addPending(id);
    expect(await get()).not.toMatch(/Pay online/i);
    fake.billingEvent.rows.push({ id: "rel1", entityId: E, kind: "bank_payment_released", documentId: id, createdAt: new Date(), data: { pendingEventId: "bp1" } });
    expect(await get()).toMatch(/Pay online/i);
  });
});
