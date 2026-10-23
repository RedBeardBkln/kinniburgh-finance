// The "Pay online" block of the invoice PDF (plan S5): absent unless supplied (every Phase-1 layout is unchanged), placed in the left
// payment column under "Mail checks to", wrapped inside that column, and passed through safeText like every other string.
import { describe, expect, it, vi } from "vitest";
import { buildPdfModel, LAYOUT, type Measure, type PdfInput } from "@/lib/invoicing/pdf/model";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { SSN_PLACEHOLDER } from "@/lib/tax2025/pdf/safe-text";

// Renders real PDFs (the guard test pins this timeout).
vi.setConfig({ testTimeout: 30_000 });

const measure: Measure = (t, size) => t.length * size * 0.5;
const URL_ = `https://finance.example.test/i/${"Ab3_-".repeat(8)}xyz`;

const input = (over: Partial<PdfInput> = {}): PdfInput => ({
  status: "issued",
  displayNumber: "3100",
  title: null,
  poNumber: null,
  business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: "LaunchTime Solutions", addressLines: ["1 Test Road"], einText: null },
  billTo: { name: "Acme Robotics", addressLines: [] },
  issueDate: "2026-10-20",
  dueText: "Due upon receipt",
  lines: [{ description: "Consulting", quantity: "1", unit: null, unitPriceCents: 10_000, discountText: null, totalCents: 10_000, workDate: null }],
  subtotalCents: 10_000,
  discountCents: 0,
  discountLabel: null,
  totalCents: 10_000,
  paidCents: 0,
  balanceCents: 10_000,
  notes: null,
  termsText: null,
  footerText: null,
  remit: { payableTo: "LaunchTime Solutions", mailingLines: ["PO Box 1"], bankLines: [] },
  documentLabel: "Invoice",
  ...over,
});

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i += 1) out += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join("");
  return out;
}

describe("the Pay online block", () => {
  it("absent or null: the model is exactly the Phase-1 model", () => {
    const base = buildPdfModel(input(), measure);
    expect(buildPdfModel(input({ payOnline: null }), measure)).toEqual(base);
    expect(base.paymentLines.join("\n")).not.toMatch(/Pay online/);
  });

  it("supplied: a label, one sentence and the link, after Mail checks to, in the left column", () => {
    const m = buildPdfModel(input({ payOnline: { url: URL_ } }), measure);
    const left = m.payment.left.map((c) => c.text);
    expect(left.indexOf("Pay online")).toBeGreaterThan(left.indexOf("Mail checks to"));
    expect(m.paymentLines).toContain("Pay online:");
    expect(m.paymentLines).toContain(`  ${URL_}`);
    expect(m.payment.left.filter((c) => c.style === "muted").map((c) => c.text).join("")).toContain(URL_.replace(/\s/g, ""));
  });

  it("a long link wraps inside the column and nothing is clipped", () => {
    const longUrl = `https://a-very-long-subdomain.of-a-long-host.example.test/i/${"Zz9-_".repeat(8)}abc`;
    const m = buildPdfModel(input({ payOnline: { url: longUrl } }), measure);
    const colW = (LAYOUT.pageW - LAYOUT.margin * 2 - LAYOUT.colGap) / 2;
    const cells = m.payment.left.filter((c) => c.style === "muted");
    for (const c of cells) expect(measure(c.text, LAYOUT.textSize)).toBeLessThanOrEqual(colW);
    expect(cells.map((c) => c.text).join("")).toContain(longUrl);
  });

  it("the real PDF carries the link, and safeText still refuses SSN-like text in it", async () => {
    const ok = await renderInvoicePdf(input({ payOnline: { url: URL_ } }));
    expect(ok.refusedCount).toBe(0);
    const text = (await pdfText(ok.bytes)).replace(/\s+/g, "");
    expect(text.toLowerCase()).toContain("payonline");
    expect(text).toContain(URL_);
    const bad = await renderInvoicePdf(input({ payOnline: { url: "https://x.example.test/i/123-45-6789" } }));
    expect(bad.refusedCount).toBe(1);
    const badText = await pdfText(bad.bytes);
    expect(badText).not.toContain("123-45-6789");
    expect(badText.replace(/\s+/g, " ")).toContain(SSN_PLACEHOLDER.slice(0, 20));
  });
});
