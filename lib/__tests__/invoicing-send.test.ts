// Invoice e-mail delivery (plan task 1.10): the pure e-mail module, and `sendInvoice` over the in-memory fake db with the e-mail
// provider and the PDF renderer mocked. Pins: nothing is e-mailed except by an explicit send (issuing never sends), pre-flight fails
// closed before any provider call, recipients are the contacts ticked "Receives invoices", a send stamps sentAt / lastSentAt /
// sendCount and an "emailed" timeline row with counts only (never an address), a resend counts up, a provider failure changes nothing
// but the timeline.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase-storage", () => ({ uploadLogoFile: vi.fn(), downloadLogoFile: vi.fn() }));
vi.mock("@/lib/resend", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/invoicing/pdf/render", () => ({ renderInvoicePdf: vi.fn(async () => ({ bytes: Uint8Array.from([37, 80, 68, 70]), pageCount: 1 })) }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { sendEmail } from "@/lib/resend";
import { issueInvoice, saveDraft, sendInvoice } from "@/actions/invoices";
import { addContact, createClient } from "@/actions/clients";
import { buildInvoiceEmail, emailPreflight, headerSafe, invoiceRecipients, SEND_FAILURE_MESSAGES } from "@/lib/invoicing/email";
import { formatNyDateTime } from "@/lib/invoicing/state";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const sendMock = vi.mocked(sendEmail);
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const GL = "33333333-3333-4333-8333-333333333333";
const KEY1 = "44444444-4444-4444-8444-444444444444";
const KEY2 = "55555555-5555-4555-8555-555555555555";
const SLUG = "ek-consulting";
const asUser = (id: string) => authMock.mockResolvedValue({ user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Eva" } });

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  process.env.RESEND_API_KEY = "test-placeholder";
  process.env.EMAIL_FROM = "Banana Stand <app@banana.test>"; // the app's other mail; never the invoice sender
  process.env.INVOICE_EMAIL_FROM = "LaunchTime Solutions <invoices@example.test>";
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: "LaunchTime Solutions", archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null,
      replyToEmail: "owner@example.test", footerText: "Thank you for your business!",
      glMap: { ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" },
    },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document]) t.rows = [];
}

async function issuedInvoice(contacts: { email: string; receivesInvoices: boolean }[]): Promise<string> {
  asUser(ERIC);
  const c = await createClient({ slug: SLUG, name: "Acme Robotics" });
  if (!("id" in c)) throw new Error("client not created");
  let n = 0;
  for (const ct of contacts) {
    n += 1;
    const r = await addContact({ slug: SLUG, clientId: c.id, name: `Contact ${n}`, email: ct.email, role: "billing", receivesInvoices: ct.receivesInvoices });
    if ("error" in r) throw new Error(r.error);
  }
  const d = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "Consulting", quantity: "10", unitPrice: "100.00", glCodeId: GL }] } });
  if (!("id" in d)) throw new Error("draft not saved");
  const i = await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
  if (!("success" in i)) throw new Error(`not issued: ${(i as { error: string }).error}`);
  return d.id;
}

const doc = (id: string) => fake.billingDocument.rows.find((r) => r.id === id)!;
const events = (id: string, kind: string) => fake.billingEvent.rows.filter((r) => r.documentId === id && r.kind === kind);

beforeEach(() => {
  seed();
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});

describe("the e-mail module (pure)", () => {
  it("pre-flight reads INVOICE_EMAIL_FROM only and fails closed when it is missing, malformed or on resend.dev", () => {
    const k = { RESEND_API_KEY: "k" };
    expect(emailPreflight({ ...k, INVOICE_EMAIL_FROM: "LaunchTime Solutions <invoices@launchtime.solutions>" })).toEqual({ ok: true, from: "LaunchTime Solutions <invoices@launchtime.solutions>" });
    expect(emailPreflight({ ...k, INVOICE_EMAIL_FROM: "  invoices@launchtime.solutions " })).toEqual({ ok: true, from: "invoices@launchtime.solutions" });
    expect(emailPreflight({ ...k, INVOICE_EMAIL_FROM: "LaunchTime   <invoices@launchtime.solutions>" })).toEqual({ ok: true, from: "LaunchTime <invoices@launchtime.solutions>" });
    // EMAIL_FROM (Banana Stand) is never a fallback
    expect(emailPreflight({ ...k, EMAIL_FROM: "Banana Stand <app@launchtime.solutions>" })).toEqual({ ok: false, category: "not_configured" });
    expect(emailPreflight({ INVOICE_EMAIL_FROM: "invoices@launchtime.solutions" })).toEqual({ ok: false, category: "not_configured" });
    for (const bad of ["", "  ", "Banana Stand <onboarding@resend.dev>", "onboarding@RESEND.dev", "LaunchTime <invoices@launchtime.solutions>\r\nBcc: x@y.z", "not an address", "\"Quoted\" <a@b.co>", "a@b.co, c@d.co", "Name <a@b.co"]) {
      expect(emailPreflight({ ...k, INVOICE_EMAIL_FROM: bad }), bad).toEqual({ ok: false, category: "not_configured" });
    }
  });

  it("recipients: only ticked contacts, valid single addresses, de-duplicated case-insensitively, order kept", () => {
    expect(
      invoiceRecipients([
        { email: "ap@acme.test", receivesInvoices: true },
        { email: "boss@acme.test", receivesInvoices: false },
        { email: "AP@acme.test", receivesInvoices: true },
        { email: "lead@acme.test ", receivesInvoices: true },
        { email: "x@acme.test\r\nBcc: evil@bad.test", receivesInvoices: true },
        { email: "a@b.test, c@d.test", receivesInvoices: true },
      ])
    ).toEqual(["ap@acme.test", "lead@acme.test"]);
    expect(invoiceRecipients([])).toEqual([]);
  });

  it("the message: subject from number and business, no CR/LF in the subject, escaped HTML, balance line only when part-paid", () => {
    const e = buildInvoiceEmail({ displayNumber: "3100", businessName: "LaunchTime\r\nBcc: x@y.z", totalText: "$1,000.00", balanceText: "$1,000.00", dueText: "Due upon receipt", footerText: "Thanks <b>!" });
    expect(e.subject).toBe("Invoice 3100 from LaunchTime Bcc: x@y.z");
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.text).toContain("Please find attached invoice 3100");
    expect(e.text).not.toContain("balance due");
    expect(e.html).toContain("Thanks &lt;b&gt;!");
    expect(e.html).not.toContain("<b>");
    const part = buildInvoiceEmail({ displayNumber: "3101", businessName: "LaunchTime Solutions", totalText: "$1,000.00", balanceText: "$400.00", dueText: "Due 2026-11-07", footerText: null });
    expect(part.text).toContain("The balance due is $400.00.");
    expect(part.text).toContain("Thank you for your business.");
    expect(headerSafe(" a\u0000b\nc ")).toBe("a b c");
  });

  it("timeline timestamps are shown in New York time", () => {
    expect(formatNyDateTime("2026-10-22T19:41:00.000Z")).toBe("Oct 22, 2026, 3:41 PM ET");
    expect(formatNyDateTime("not a date")).toBe("");
  });
});

describe("sendInvoice", () => {
  it("issuing an invoice never e-mails it", async () => {
    await issuedInvoice([{ email: "ap@acme.test", receivesInvoices: true }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("e-mails the PDF to the ticked contacts and records the send (counts only, never an address)", async () => {
    const id = await issuedInvoice([
      { email: "ap@acme.test", receivesInvoices: true },
      { email: "lead@acme.test", receivesInvoices: true },
      { email: "ceo@acme.test", receivesInvoices: false },
    ]);
    const r = await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 });
    expect(r).toEqual({ success: true, recipientCount: 2, sendCount: 1, payLink: "not_applicable" }); // Phase 2: online payments are off here
    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0]![0];
    expect(arg.to).toEqual(["ap@acme.test", "lead@acme.test"]);
    expect(arg.subject).toBe("Invoice 3100 from LaunchTime Solutions");
    expect(arg.from).toBe("LaunchTime Solutions <invoices@example.test>");
    expect(arg.replyTo).toBe("owner@example.test");
    expect(arg.idempotencyKey).toBe(`invoice-send/${id}/${KEY1}`);
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments![0]!.filename).toMatch(/\.pdf$/);
    const d = doc(id);
    expect(d.sendCount).toBe(1);
    expect(d.sentAt).toBeInstanceOf(Date);
    expect(d.lastSentAt).toEqual(d.sentAt);
    const ev = events(id, "emailed");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toEqual({ recipientCount: 2, sendNumber: 1, payLink: false });
    expect(JSON.stringify(fake.billingEvent.rows)).not.toContain("@");
    expect(JSON.stringify(fake.auditLog.rows)).not.toContain("@");
  });

  it("a resend counts up and moves lastSentAt, keeping the first sentAt", async () => {
    const id = await issuedInvoice([{ email: "ap@acme.test", receivesInvoices: true }]);
    await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 });
    const first = doc(id).sentAt as Date;
    await new Promise((r) => setTimeout(r, 5));
    const r = await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY2 });
    expect(r).toEqual({ success: true, recipientCount: 1, sendCount: 2, payLink: "not_applicable" });
    expect(doc(id).sentAt).toEqual(first);
    expect((doc(id).lastSentAt as Date).getTime()).toBeGreaterThan(first.getTime());
    expect(events(id, "emailed").map((e) => (e.data as { sendNumber: number }).sendNumber)).toEqual([1, 2]);
  });

  it("not configured: refused before any provider call, nothing recorded", async () => {
    const id = await issuedInvoice([{ email: "ap@acme.test", receivesInvoices: true }]);
    process.env.INVOICE_EMAIL_FROM = "LaunchTime Solutions <onboarding@resend.dev>";
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 })).toEqual({ error: SEND_FAILURE_MESSAGES.not_configured, sendFailure: "not_configured" });
    delete process.env.INVOICE_EMAIL_FROM; // EMAIL_FROM is still set: it must not be used instead
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 })).toMatchObject({ sendFailure: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(doc(id).sendCount).toBe(0);
    expect(events(id, "emailed")).toHaveLength(0);
  });

  it("no contact ticked \"Receives invoices\": refused, nothing sent", async () => {
    const id = await issuedInvoice([{ email: "ap@acme.test", receivesInvoices: false }]);
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 })).toEqual({ error: SEND_FAILURE_MESSAGES.no_recipients, sendFailure: "no_recipients" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a provider failure leaves the invoice unsent and adds an e-mail-failed row", async () => {
    const id = await issuedInvoice([{ email: "ap@acme.test", receivesInvoices: true }]);
    sendMock.mockRejectedValueOnce(new Error("Email failed: provider said no to ap@acme.test"));
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 })).toEqual({ error: SEND_FAILURE_MESSAGES.provider_error, sendFailure: "provider_error" });
    expect(doc(id).sendCount).toBe(0);
    expect(doc(id).sentAt ?? null).toBeNull();
    expect(events(id, "email_failed").map((e) => e.data)).toEqual([{ category: "provider_error" }]);
    expect(JSON.stringify(fake.billingEvent.rows)).not.toContain("@");
  });

  it("a draft cannot be e-mailed; Eva cannot send", async () => {
    asUser(ERIC);
    const c = await createClient({ slug: SLUG, name: "Draft Co" });
    if (!("id" in c)) throw new Error("client");
    await addContact({ slug: SLUG, clientId: c.id, name: "Pat", email: "pat@draft.test", role: "billing", receivesInvoices: true });
    const d = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "x", quantity: "1", unitPrice: "1.00", glCodeId: GL }] } });
    if (!("id" in d)) throw new Error("draft");
    expect(await sendInvoice({ slug: SLUG, documentId: d.id, requestKey: KEY1 })).toMatchObject({ error: expect.stringMatching(/final/) });
    const id = await issuedInvoice([{ email: "ap@acme.test", receivesInvoices: true }]);
    asUser(EVA);
    expect(await sendInvoice({ slug: SLUG, documentId: id, requestKey: KEY1 })).toMatchObject({ error: expect.any(String) });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("source pins", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  it("only sendInvoice reaches the e-mail provider in the invoicing code, and no cron or issue path calls it", () => {
    const actions = read("actions/invoices.ts");
    expect([...actions.matchAll(/\bsendEmail\(/g)]).toHaveLength(1);
    const issueBody = actions.slice(actions.indexOf("export async function issueInvoice"), actions.indexOf("export async function voidInvoice"));
    expect(issueBody).not.toMatch(/sendEmail|sendInvoice/);
    const code = (rel: string) => read(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const f of ["lib/invoicing/store.ts", "lib/invoicing/email.ts", "app/api/cron/notifications/route.ts"]) expect(code(f), f).not.toMatch(/sendInvoice|from "@\/lib\/resend"/);
  });
  it("the editor's only send path is the 'Save as final and send' choice", () => {
    const ed = read("components/invoicing/invoice-editor.tsx");
    expect([...ed.matchAll(/sendInvoice\(/g)]).toHaveLength(1);
    expect(ed).toMatch(/Save as draft/);
    expect(ed).toMatch(/Save as final and send/);
    expect(ed).not.toMatch(/Save and issue/);
  });
});
