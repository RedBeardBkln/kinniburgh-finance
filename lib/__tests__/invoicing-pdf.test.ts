import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildPdfModel, wrapText, type Measure, type PdfInput } from "@/lib/invoicing/pdf/model";
import { cleanInput, renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { safeFilename } from "@/lib/invoicing/pdf/filename";

// Fake measure: 5 points per character (deterministic pagination without fonts).
const measure: Measure = (text) => text.length * 5;

// S3 (review round 3): every test in this file may render a real PDF (and read it back with pdfjs). The default 5 s timeout flaked under
// a loaded machine, so the whole file gets a generous explicit timeout (a guard test pins that it stays at least this large).
vi.setConfig({ testTimeout: 30_000 });

const TINY_PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function input(over: Partial<PdfInput> = {}, lineCount = 2): PdfInput {
  return {
    status: "issued",
    displayNumber: "3100",
    title: null,
    poNumber: null,
    business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: "LaunchTime Solutions", addressLines: ["1 Test Road", "Testville, CT 00000"], einText: null },
    billTo: { name: "Acme Robotics", addressLines: ["2 Client Way", "Clientown, NY 11111"] },
    issueDate: "2026-10-05",
    dueText: "Due upon receipt",
    lines: Array.from({ length: lineCount }, (_, i) => ({ description: `Consulting work item ${i + 1}`, quantity: "7.25", unit: "hr", unitPriceCents: 17500, discountText: null, totalCents: 126875, workDate: null })),
    subtotalCents: 126875 * lineCount,
    discountCents: 0,
    discountLabel: null,
    totalCents: 126875 * lineCount,
    paidCents: 0,
    balanceCents: 126875 * lineCount,
    notes: null,
    termsText: null,
    footerText: "Thank you for your business.",
    remit: { payableTo: "Eric Kinniburgh Consulting, LLC", mailingLines: ["1 Test Road", "Testville, CT 00000"], bankLines: [] },
    documentLabel: "Invoice",
    ...over,
  };
}

describe("wrapText", () => {
  it("wraps on words and hard-breaks a word wider than the column", () => {
    expect(wrapText("aaa bbb ccc", 40, 10, measure)).toEqual(["aaa bbb", "ccc"]);
    const hard = wrapText("x".repeat(30), 50, 10, measure);
    expect(hard.length).toBeGreaterThan(1);
    expect(hard.join("")).toBe("x".repeat(30));
    expect(wrapText("", 50, 10, measure)).toEqual([""]);
  });
});

describe("page model", () => {
  it("a short invoice is one page with totals on it", () => {
    const m = buildPdfModel(input(), measure);
    expect(m.pages).toHaveLength(1);
    expect(m.pages[0]!.showTotals).toBe(true);
    expect(m.pages[0]!.showFullHeader).toBe(true);
  });
  it("many lines paginate; the full header is on page 1 only and totals only on the last page", () => {
    const m = buildPdfModel(input({}, 80), measure);
    expect(m.pages.length).toBeGreaterThanOrEqual(3);
    expect(m.pages.map((p) => p.showFullHeader)).toEqual(m.pages.map((_, i) => i === 0));
    expect(m.pages.map((p) => p.showTotals)).toEqual(m.pages.map((_, i) => i === m.pages.length - 1));
    const total = m.pages.reduce((s, p) => s + p.rows.length, 0);
    expect(total).toBe(80);
  });
  it("when the last page has no room for the totals block, it gets a page of its own", () => {
    // Find a line count where the rows exactly fill the last page so the block cannot fit.
    let found = false;
    for (let n = 1; n < 120 && !found; n += 1) {
      const m = buildPdfModel(input({ notes: "n ".repeat(120) }, n), measure);
      const last = m.pages[m.pages.length - 1]!;
      if (m.pages.length > 1 && last.rows.length === 0) found = true;
    }
    expect(found).toBe(true);
  });
  it("EIN appears only when provided; VOID and DRAFT marks; draft has no number", () => {
    expect(buildPdfModel(input(), measure).headerLeft.join("|")).not.toMatch(/EIN/);
    expect(buildPdfModel(input({ business: { ...input().business, einText: "12-3456789" } }), measure).headerLeft.join("|")).toMatch(/EIN 12-3456789/);
    expect(buildPdfModel(input({ status: "void" }), measure).watermark).toBe("VOID");
    const draft = buildPdfModel(input({ status: "draft", displayNumber: null }), measure);
    expect(draft.watermark).toBe("DRAFT");
    expect(draft.headerRight[0]!.value).toBe("DRAFT");
    expect(buildPdfModel(input(), measure).watermark).toBeNull();
  });
  it("payment block: mailing address and payee whenever set; bank lines only when supplied", () => {
    const without = buildPdfModel(input(), measure).paymentLines.join("\n");
    expect(without).toMatch(/Mail checks to:/);
    expect(without).toMatch(/Testville/);
    expect(without).not.toMatch(/Bank/);
    const withBank = buildPdfModel(input({ remit: { payableTo: null, mailingLines: [], bankLines: ["Routing 021000021"] } }), measure).paymentLines.join("\n");
    expect(withBank).toMatch(/Bank \/ ACH details:/);
    expect(withBank).toMatch(/021000021/);
  });
  it("partially paid shows paid and balance due", () => {
    const m = buildPdfModel(input({ paidCents: 50000, balanceCents: 76875, totalCents: 126875, subtotalCents: 126875 }, 1), measure);
    expect(m.totals.map((t) => t.label)).toEqual(["Subtotal", "Total", "Paid", "Balance due"]);
  });
  it("a discount line appears in the totals", () => {
    const m = buildPdfModel(input({ discountCents: 1000, discountLabel: "Discount (10%)" }, 1), measure);
    expect(m.totals.map((t) => t.label)).toContain("Discount (10%)");
  });
});

describe("text safety", () => {
  it("SSN-like text in any ordinary field is replaced and counted, never echoed", () => {
    const { input: cleaned, refused } = cleanInput(input({ notes: "Ref 123-45-6789", billTo: { name: "Acme 123456789", addressLines: [] } }));
    expect(refused).toBe(2);
    expect(JSON.stringify(cleaned)).not.toMatch(/6789/);
  });
  it("owner-typed bank lines keep a nine-digit routing number (the scoped exception) but are still WinAnsi-safe", () => {
    const { input: cleaned, refused } = cleanInput(input({ remit: { payableTo: null, mailingLines: [], bankLines: ["Routing 021000021", "Banque 日本"] } }));
    expect(refused).toBe(0);
    expect(cleaned.remit.bankLines[0]).toBe("Routing 021000021");
    expect(cleaned.remit.bankLines[1]).not.toMatch(/日/);
  });
  it("the same nine digits in a NON-bank field are still refused", () => {
    expect(cleanInput(input({ notes: "Routing 021000021" })).refused).toBe(1);
  });
});

describe("render", () => {
  it("produces a loadable PDF with the model's page count", async () => {
    const r = await renderInvoicePdf(input({}, 3));
    const loaded = await PDFDocument.load(r.bytes);
    expect(loaded.getPageCount()).toBe(r.pageCount);
    expect(r.pageCount).toBe(1);
    expect(r.refusedCount).toBe(0);
  });
  it("paginates long invoices", async () => {
    const r = await renderInvoicePdf(input({}, 80));
    expect(r.pageCount).toBeGreaterThanOrEqual(3);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(r.pageCount);
  });
  it("does not throw on non-Latin names, emoji or curly quotes", async () => {
    const r = await renderInvoicePdf(input({ billTo: { name: "Дмитрий 日本語 😀 “Quoted”", addressLines: ["Übung 5"] } }));
    expect(r.pageCount).toBe(1);
  });
  it("void and draft documents render", async () => {
    expect((await renderInvoicePdf(input({ status: "void" }))).pageCount).toBe(1);
    expect((await renderInvoicePdf(input({ status: "draft", displayNumber: null, issueDate: null }))).pageCount).toBe(1);
  });
  it("embeds a PNG logo, and a corrupt logo never blocks the invoice", async () => {
    const withLogo = await renderInvoicePdf(input(), { logo: { bytes: TINY_PNG, mime: "image/png" } });
    expect(withLogo.pageCount).toBe(1);
    const bad = await renderInvoicePdf(input(), { logo: { bytes: Uint8Array.from([1, 2, 3]), mime: "image/png" } });
    expect(bad.pageCount).toBe(1);
  });
  it("is deterministic for a frozen document (same bytes length, creation date from the issue date)", async () => {
    const a = await renderInvoicePdf(input());
    const b = await renderInvoicePdf(input());
    expect(a.bytes.length).toBe(b.bytes.length);
    const loaded = await PDFDocument.load(a.bytes);
    expect(loaded.getCreationDate()?.toISOString().slice(0, 10)).toBe("2026-10-05");
  });
});

describe("filename", () => {
  it("is header-safe", () => {
    expect(safeFilename("3100")).toBe("3100.pdf");
    expect(safeFilename("INV/42 \"x\"\r\n")).toBe("INV-42-x.pdf");
    expect(safeFilename(null)).toBe("draft.pdf");
  });
});
