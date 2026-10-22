// Tester probes (ek-consulting-invoicing) on the REAL pdf-lib render, read back with pdfjs text positions. D-3 .. D-5 (03-test-report.md)
// were fixed in round 2: their former `it.fails` pins are plain `it` tests now, plus extra layout cases (no-logo header, wrapping, ellipsis).
import { describe, expect, it, vi } from "vitest";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import type { PdfInput } from "@/lib/invoicing/pdf/model";

// S3 (review round 3): every test in this file may render a real PDF (and read it back with pdfjs). The default 5 s timeout flaked under
// a loaded machine, so the whole file gets a generous explicit timeout (a guard test pins that it stays at least this large).
vi.setConfig({ testTimeout: 30_000 });

type Item = { str: string; x: number; y: number; w: number };

async function textItems(bytes: Uint8Array): Promise<Item[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const pages: Item[][] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const items: Item[] = [];
    for (const it of tc.items) if ("str" in it) items.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width as number });
    pages.push(items);
  }
  return pages;
}

function base(over: Partial<PdfInput> = {}, lineCount = 2): PdfInput {
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
    remit: { payableTo: "Eric Kinniburgh Consulting, LLC", mailingLines: ["1 Test Road"], bankLines: [] },
    documentLabel: "Invoice",
    ...over,
  };
}

describe("tester: invoice PDF (real render)", () => {
  it("non-Latin and emoji names do not throw; unsupported characters become '?' (documented limit R7), Latin-1 survives", async () => {
    const r = await renderInvoicePdf(base({ billTo: { name: "日本語株式会社 Ωmega 🚀 Café Zoë", addressLines: ["Straße 5", "東京都"] } }));
    const t = (await textItems(r.bytes)).flat().map((i) => i.str).join(" ");
    expect(r.pageCount).toBe(1);
    expect(t).toContain("Café Zoë");
    expect(t).toContain("Straße 5");
  });

  it("a realistic 500-character description is rendered in full", async () => {
    const desc = "Architecture review and threat modelling workshop for the payments platform, including written findings. ".repeat(5).slice(0, 500).trim();
    const r = await renderInvoicePdf(base({ lines: [{ description: desc, quantity: "1", unit: null, unitPriceCents: 100, discountText: null, totalCents: 100, workDate: null }], subtotalCents: 100, totalCents: 100, balanceCents: 100 }));
    const t = (await textItems(r.bytes)).flat().map((i) => i.str).join("").replace(/\s+/g, "");
    expect(t).toContain(desc.slice(-30).replace(/\s+/g, ""));
  });

  it("200 lines: 7 pages, totals only on the last page, nothing below the bottom margin, deterministic bytes", async () => {
    const r = await renderInvoicePdf(base({ status: "void" }, 200));
    const pages = await textItems(r.bytes);
    expect(r.pageCount).toBe(pages.length);
    const below = pages.flatMap((p) => p.filter((it) => it.y < 54 - 24 && !it.str.startsWith("Page ")));
    expect(below).toEqual([]);
    expect(pages.map((p, i) => (p.some((it) => it.str === "Subtotal") ? i : -1)).filter((x) => x >= 0)).toEqual([pages.length - 1]);
    const again = await renderInvoicePdf(base({ status: "void" }, 200));
    expect(Buffer.from(again.bytes).equals(Buffer.from(r.bytes))).toBe(true);
  });

  it("SSN-like text injected past validation is replaced; a 9-digit routing number in the bank lines is kept; the EIN prints only when given", async () => {
    const r = await renderInvoicePdf(base({ notes: "Call 123-45-6789 please", remit: { payableTo: "Pay 987654321", mailingLines: ["1 Test Road"], bankLines: ["Routing 021000021", "Acct 1234567890"] } }));
    const t = (await textItems(r.bytes)).flat().map((i) => i.str).join(" ");
    expect(t).not.toContain("123-45-6789");
    expect(t).not.toContain("987654321");
    expect(t).toContain("021000021");
    expect(t).not.toMatch(/EIN/);
    const r2 = await renderInvoicePdf(base({ business: { name: "X LLC", dbaName: null, addressLines: [], einText: "12-3456789" } }));
    expect((await textItems(r2.bytes)).flat().map((i) => i.str).join(" ")).toContain("EIN 12-3456789");
  });

  it("'Due upon receipt' terms do not collide with the Terms label", async () => {
    const items = (await textItems((await renderInvoicePdf(base())).bytes))[0]!;
    const label = items.find((i) => i.str === "TERMS" && i.x > 300)!;
    const value = items.find((i) => i.str === "Due upon receipt" && i.x > 300)!;
    expect(value.x).toBeGreaterThanOrEqual(label.x + label.w);
  });

  it("D-3: 'Net N days, due <date>' terms text does not overlap the 'Terms:' label in the header", async () => {
    const items = (await textItems((await renderInvoicePdf(base({ dueText: "Net 30 days, due 2026-11-15" }))).bytes))[0]!;
    const label = items.find((i) => i.str === "TERMS" && i.x > 300)!;
    const value = items.find((i) => i.str.startsWith("Net 30 days") && i.x > 300)!;
    expect(value.x).toBeGreaterThanOrEqual(label.x + label.w);
  });

  it("D-4: a very wide 500-character description is wrapped in full (nothing cut)", async () => {
    const r = await renderInvoicePdf(base({ lines: [{ description: "W".repeat(500), quantity: "1", unit: null, unitPriceCents: 100, discountText: null, totalCents: 100, workDate: null }], subtotalCents: 100, totalCents: 100, balanceCents: 100 }));
    const t = (await textItems(r.bytes)).flat().map((i) => i.str).join("");
    expect((t.match(/W/g) ?? []).length).toBeGreaterThanOrEqual(500);
  });

  it("D-5: header, bill-to and address lines are wrapped and stay inside the right margin", async () => {
    const long = "Northeastern Regional Cooperative of Independent Pharmacists and Healthcare Providers Incorporated International Group".slice(0, 120);
    const street = "1234 Very Long Street Name Boulevard Extension, Building 7, Suite 1200, Springfield Township, ".repeat(3).trim();
    const r = await renderInvoicePdf(base({ billTo: { name: long, addressLines: [street] } }));
    const over = (await textItems(r.bytes)).flat().filter((i) => i.x + i.w > 612 - 54 + 1);
    expect(over).toEqual([]);
  });
  it("no-logo header: the document label, the invoice number and the labels do not overprint each other", async () => {
    const items = (await textItems((await renderInvoicePdf(base())).bytes))[0]!;
    const title = items.find((i) => i.str === "INVOICE")!;
    const number = items.find((i) => i.str === "3100")!;
    const numberLabel = items.find((i) => i.str === "INVOICE NUMBER")!;
    // vertically apart (the 18 pt title sits above the detail rows) ...
    expect(title.y - number.y).toBeGreaterThanOrEqual(12);
    // ... and the number never sits inside the label's box
    expect(number.x).toBeGreaterThanOrEqual(numberLabel.x + numberLabel.w);
  });

  it("D-3/D-5: a long PO number and a long business name wrap inside their own columns; no text runs into another or off the page", async () => {
    const po = "PO-2026-REGIONAL-COOPERATIVE-PHARMACY-NETWORK-BLANKET-ORDER-0000012345-REVISION-7";
    const name = "Northeastern Regional Cooperative of Independent Pharmacists and Healthcare Providers Incorporated";
    const r = await renderInvoicePdf(base({ poNumber: po, dueText: "Net 30 days, due 2026-11-15", business: { name, dbaName: "LaunchTime Solutions", addressLines: ["1234 Very Long Street Name Boulevard Extension, Building 7, Suite 1200, Springfield Township"], einText: null } }));
    const items = (await textItems(r.bytes))[0]!;
    expect(items.filter((i) => i.x + i.w > 612 - 54 + 3)).toEqual([]); // pdfjs measures its substitute bold font about 1-2 pt wider
    const all = items.map((i) => i.str).join("");
    expect(all.replace(/\s+/g, "")).toContain(po.replace(/\s+/g, "").slice(-20));
    expect(all.replace(/\s+/g, "")).toContain("Healthcare");
    // the left block stays left of the right-hand labels on every shared baseline
    const leftMaxRight = Math.max(...items.filter((i) => Math.abs(i.x - 54) < 0.5 && i.y > 620 && i.str.trim() !== "").map((i) => i.x + i.w));
    const labelMinLeft = Math.min(...items.filter((i) => i.y > 600 && /^(INVOICE NUMBER|ISSUE DATE|TERMS|PO NUMBER)$/.test(i.str)).map((i) => i.x));
    expect(leftMaxRight).toBeLessThan(labelMinLeft);
  });

  it("D-4: a description beyond the safety cap ends with a visible ellipsis instead of being cut silently (model level)", async () => {
    const { buildPdfModel, LAYOUT } = await import("@/lib/invoicing/pdf/model");
    const measure = (t: string, size: number) => t.length * size * 0.5;
    const model = buildPdfModel(base({ lines: [{ description: "word ".repeat(2000).trim(), quantity: "1", unit: null, unitPriceCents: 100, discountText: null, totalCents: 100, workDate: null }] }), measure);
    const lines = model.pages.flatMap((p) => p.rows)[0]!.descriptionLines; // a 40-line row no longer fits page 1, so it sits on a continuation page
    expect(lines).toHaveLength(LAYOUT.maxDescLines);
    expect(lines[lines.length - 1]!.endsWith("...")).toBe(true);
    // a validated (500 character) description of the widest letters never reaches the cap with the real font widths
    expect(Math.ceil(500 / Math.floor(LAYOUT.descColW / 10.15))).toBeLessThan(LAYOUT.maxDescLines);
  });

  it("long payment lines (payable-to, mailing and bank text) wrap instead of running off the page, keeping the indent", async () => {
    const long = "Eric Kinniburgh Consulting, LLC c/o The Very Long Named Property Management and Bookkeeping Services Company, Attention: Accounts Receivable Department";
    const r = await renderInvoicePdf(base({ remit: { payableTo: long, mailingLines: [long], bankLines: ["Routing 021000021 Account ending 1234 Wire reference please include the invoice number in the memo field of the transfer"] } }));
    const items = (await textItems(r.bytes)).flat();
    expect(items.filter((i) => i.x + i.w > 612 - 54 + 1)).toEqual([]);
  });
});
