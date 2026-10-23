// Tester (stripe-ach-pending-hide-pay): the REAL /i/<token> page and /i/<token>/pdf route, with the loaders mocked at the module
// boundary, prove the client's paths fail CLOSED when the processing-bank-payment read throws (no Pay button, no notice, no pay line),
// show the notice instead of the button while pending, and offer Pay online + the ACH sentence when nothing is pending.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfInput } from "@/lib/invoicing/pdf/model";
import type { BankPendingState } from "@/lib/invoicing/stripe/bank-pending";

const h = vi.hoisted(() => ({
  pending: vi.fn(),
  rendered: [] as unknown[],
}));

vi.mock("@/actions/public-invoice", () => ({ markInvoiceViewed: vi.fn(), startCheckout: vi.fn() }));
vi.mock("@/lib/invoicing/pay-build", () => ({
  resolvePublicAccess: vi.fn(async () => ({ ok: true, entityId: "ent-1", documentId: "doc-1" })),
  loadPaySettings: vi.fn(async () => ({ status: "ok", stripePayEnabled: true, publicTokenTtlDays: 90 })),
  loadBankPendingFor: h.pending,
}));
vi.mock("@/lib/invoicing/stripe/pay-env", () => ({
  payEnvironment: () => ({ preflight: { ok: true, mode: "test" }, configured: true, mode: "test", baseUrl: "https://app.example.test" }),
}));
vi.mock("@/lib/invoicing/pdf-build", () => ({
  loadInvoicePdfSource: vi.fn(async () => ({ status: "ok", entityId: "ent-1", input: input(), logo: null, filename: "invoice-3100.pdf" })),
}));
vi.mock("@/lib/invoicing/pdf/render", () => ({
  renderInvoicePdf: vi.fn(async (i: unknown) => {
    h.rendered.push(i);
    return { ok: true, bytes: new Uint8Array([37, 80, 68, 70]), filename: "invoice-3100.pdf" };
  }),
}));

function input(over: Partial<PdfInput> = {}): PdfInput {
  return {
    status: "issued",
    displayNumber: "3100",
    title: "Website build",
    poNumber: null,
    business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: "LaunchTime Solutions", addressLines: ["1 Test Road"], einText: null },
    billTo: { name: "Acme Robotics", addressLines: [] },
    issueDate: "2026-10-20",
    dueText: "Due upon receipt",
    lines: [{ description: "Consulting", quantity: "10", unit: "hr", unitPriceCents: 10_000, discountText: null, totalCents: 100_000, workDate: null }],
    subtotalCents: 100_000,
    discountCents: 0,
    discountLabel: null,
    totalCents: 100_000,
    paidCents: 0,
    balanceCents: 100_000,
    notes: null,
    termsText: null,
    footerText: null,
    remit: { payableTo: "LaunchTime Solutions", mailingLines: ["PO Box 1"], bankLines: [] },
    documentLabel: "Invoice",
    ...over,
  } as PdfInput;
}

(globalThis as unknown as { React: typeof React }).React = React;
const TOKEN = "Ab3_-".repeat(8) + "xyz";
const STATE: BankPendingState = {
  items: [{ id: "11111111-1111-4111-8111-111111111111", amountCents: 100_000, startedOn: "2026-10-21", overdue: false, livemode: false }],
  totalCents: 100_000,
  startedOn: "2026-10-21",
  overdue: false,
};

async function pageHtml(): Promise<string> {
  const { default: Page } = await import("@/app/i/[token]/page");
  const el = await Page({ params: Promise.resolve({ token: TOKEN }) });
  return renderToStaticMarkup(el);
}

describe("tester: the real /i/<token> page", () => {
  beforeEach(() => {
    h.pending.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("control: nothing pending -> the Pay button and the ACH-preferred sentence", async () => {
    h.pending.mockResolvedValue(null);
    const out = await pageHtml();
    expect(out).toContain("Pay $1,000.00 online");
    expect(out).toContain("Bank transfer (ACH) is preferred.");
  });

  it("pending -> the processing notice, no Pay button, no ACH sentence", async () => {
    h.pending.mockResolvedValue(STATE);
    const out = await pageHtml();
    expect(out).toContain("A bank payment of $1,000.00 is processing (started Oct 21, 2026); it usually takes up to 4 business days.");
    expect(out).not.toMatch(/Pay \$[\d,.]+ online/);
    expect(out).not.toContain("Bank transfer (ACH) is preferred.");
    expect(out).toContain("Download PDF");
  });

  it("a thrown pending read fails CLOSED: no Pay button, no notice, the rest still renders", async () => {
    h.pending.mockRejectedValue(new Error("db down"));
    const out = await pageHtml();
    expect(out).not.toMatch(/Pay \$[\d,.]+ online/);
    expect(out).not.toContain("Bank transfer (ACH) is preferred.");
    expect(out).not.toContain("is processing");
    expect(out).toContain("3100");
    expect(out).toContain("Download PDF");
  });
});

describe("tester: the real /i/<token>/pdf route", () => {
  beforeEach(() => {
    h.pending.mockReset();
    h.rendered.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  const get = async () => {
    const { GET } = await import("@/app/i/[token]/pdf/route");
    return GET(new Request(`https://app.example.test/i/${TOKEN}/pdf`), { params: Promise.resolve({ token: TOKEN }) });
  };
  const payOnlineOf = () => (h.rendered[0] as { payOnline?: { url: string } }).payOnline;

  it("control: nothing pending -> the pay line is rendered", async () => {
    h.pending.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(payOnlineOf()?.url).toContain(`/i/${TOKEN}`);
  });

  it("pending -> no pay line, PDF still served", async () => {
    h.pending.mockResolvedValue(STATE);
    const res = await get();
    expect(res.status).toBe(200);
    expect(payOnlineOf()).toBeUndefined();
  });

  it("a thrown pending read fails CLOSED -> no pay line, PDF still served", async () => {
    h.pending.mockRejectedValue(new Error("db down"));
    const res = await get();
    expect(res.status).toBe(200);
    expect(payOnlineOf()).toBeUndefined();
  });
});
