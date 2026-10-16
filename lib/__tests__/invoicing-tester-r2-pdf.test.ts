// Tester round 2 (ek-consulting-invoicing): layout fuzz over the REAL pdf render read back with pdfjs. Widths are recomputed with pdf-lib
// (pdfjs measures its substitute font up to ~5 pt wider, which is a reading artefact, not a layout fault). Checks: no two text boxes overlap,
// nothing past the right/left margin, totals only on the last page. The bottom-margin checks (D-11 and the last-block cases of review item S2) are separate cases below.
import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { buildPdfModel, LAYOUT } from "@/lib/invoicing/pdf/model";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { PdfInput } from "@/lib/invoicing/pdf/model";

// S3 (review round 3): every test in this file may render a real PDF (and read it back with pdfjs). The default 5 s timeout flaked under
// a loaded machine, so the whole file gets a generous explicit timeout (a guard test pins that it stays at least this large).
vi.setConfig({ testTimeout: 30_000 });

type Item = { str: string; x: number; y: number; w: number; h: number };

let FR: { widthOfTextAtSize(t: string, s: number): number } | null = null;
let FB: { widthOfTextAtSize(t: string, s: number): number } | null = null;
function exactW(str: string, size: number, pdfjsW: number): number {
  if (!FR || !FB) return pdfjsW;
  let a: number; let b: number;
  try { a = FR.widthOfTextAtSize(str, size); b = FB.widthOfTextAtSize(str, size); } catch { return pdfjsW; }
  return Math.abs(a - pdfjsW) <= Math.abs(b - pdfjsW) ? a : b;
}

async function textItems(bytes: Uint8Array): Promise<Item[][]> {
  if (!FR) { const d = await PDFDocument.create(); FR = await d.embedFont(StandardFonts.Helvetica); FB = await d.embedFont(StandardFonts.HelveticaBold); }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const pages: Item[][] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const items: Item[] = [];
    for (const it of tc.items) if ("str" in it && it.str.trim() !== "") items.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: exactW(it.str, Math.abs(it.transform[3] as number), it.width as number), h: Math.abs(it.transform[3] as number) || (it.height as number) });
    pages.push(items);
  }
  return pages;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y += 1) raw[y * (w * 3 + 1)] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// deterministic rng
let seed = 20261015;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0xffffffff;
};
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const WORDS = ["Northeastern", "Regional", "Cooperative", "Consulting", "Pharmacists", "Incorporated", "Boulevard", "Suite", "1200", "Springfield", "Township", "of", "and", "the", "Building"];
const phrase = (maxChars: number) => {
  let s = "";
  while (s.length < maxChars) s += (s ? " " : "") + pick(WORDS);
  return s.slice(0, maxChars).trim() || "x";
};

function scenario(): { input: PdfInput; logo: { w: number; h: number } | null; desc: string } {
  const nLines = pick([1, 2, 5, 15, 30, 60]);
  const logo = pick([null, null, { w: 1, h: 1 }, { w: 150, h: 56 }, { w: 40, h: 300 }, { w: 400, h: 30 }]);
  const status = pick(["issued", "issued", "draft", "void"] as const);
  const lines = Array.from({ length: nLines }, (_, i) => {
    const d = pick([phrase(20), phrase(150), phrase(500), "W".repeat(int(1, 500)), "line one\nline two\nline three"]);
    return { description: d, quantity: pick(["1", "7.25", "100.5"]), unit: pick([null, "hr", "ea"]), unitPriceCents: 17500, discountText: pick([null, "10% off"]), totalCents: 126875, workDate: pick([null, "2026-10-0" + ((i % 9) + 1)]) };
  });
  const total = lines.length * 126875;
  const input: PdfInput = {
    status,
    displayNumber: status === "draft" ? null : String(int(1, 999999)),
    title: pick([null, null, phrase(40), phrase(250)]),
    poNumber: pick([null, "PO-1", "PO-2026-REGIONAL-COOPERATIVE-PHARMACY-NETWORK-BLANKET-ORDER-0000012345-REVISION-7", phrase(60)]),
    business: { name: pick(["Eric Kinniburgh Consulting, LLC", phrase(120)]), dbaName: pick([null, "LaunchTime Solutions", phrase(100)]), addressLines: Array.from({ length: int(0, 6) }, () => pick([phrase(20), phrase(200)])), einText: pick([null, "12-3456789"]) },
    billTo: { name: pick(["Acme", phrase(120)]), addressLines: Array.from({ length: int(0, 5) }, () => pick([phrase(20), phrase(400)])) },
    issueDate: status === "draft" ? null : "2026-10-05",
    dueText: pick(["Due upon receipt", "Net 30 days, due 2026-11-15", "Net 120 days, due 2027-02-03", phrase(80)]),
    lines,
    subtotalCents: total,
    discountCents: pick([0, 5000]),
    discountLabel: pick([null, "Early payment discount"]),
    totalCents: total,
    paidCents: pick([0, 1000]),
    balanceCents: total,
    notes: pick([null, phrase(300), phrase(1500)]),
    termsText: pick([null, phrase(300)]),
    footerText: pick([null, phrase(200)]),
    remit: { payableTo: pick([null, "EKC LLC", phrase(150)]), mailingLines: Array.from({ length: int(0, 4) }, () => pick([phrase(20), phrase(160)])), bankLines: Array.from({ length: int(0, 4) }, () => pick(["Routing 021000021", phrase(200)])) },
    documentLabel: "Invoice",
  };
  return { input, logo, desc: `lines=${nLines} logo=${JSON.stringify(logo)} status=${status}` };
}

describe("round 2 layout fuzz", () => {
  it("no overprint, nothing past the left/right margin, totals only on the last page, over 60 random invoices (seeded)", async () => {
    const problems: string[] = [];
    for (let n = 0; n < 60; n += 1) {
      const sc = scenario();
      const r = await renderInvoicePdf(sc.input, sc.logo ? { logo: { bytes: png(sc.logo.w, sc.logo.h), mime: "image/png" } } : {});
      const pages = await textItems(r.bytes);
      pages.forEach((items, pi) => {
        const body = items.filter((i) => !/^Page \d+ of \d+$/.test(i.str) && i.str !== "DRAFT" && i.str !== "VOID");
        for (const i of body) {
          if (i.x < 54 - 1) problems.push(`#${n} p${pi + 1} left of margin: ${i.str.slice(0, 30)} x=${i.x.toFixed(1)} (${sc.desc})`);
          if (i.x + i.w > 558 + 0.6) problems.push(`#${n} p${pi + 1} right of margin: ${i.str.slice(0, 30)} end=${(i.x + i.w).toFixed(1)} (${sc.desc})`);
          if (i.y > 792 - 54 + 6) problems.push(`#${n} p${pi + 1} above top margin: ${i.str.slice(0, 30)} y=${i.y.toFixed(1)}`);
        }
        // pairwise overlap of boxes
        for (let a = 0; a < body.length; a += 1) {
          for (let b = a + 1; b < body.length; b += 1) {
            const A = body[a]!;
            const B = body[b]!;
            const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
            const ya0 = A.y;
            const ya1 = A.y + A.h * 0.72;
            const yb0 = B.y;
            const yb1 = B.y + B.h * 0.72;
            const oy = Math.min(ya1, yb1) - Math.max(ya0, yb0);
            if (ox > 1.5 && oy > 1.5) problems.push(`#${n} p${pi + 1} OVERLAP "${A.str.slice(0, 25)}" x"${B.str.slice(0, 25)}" ox=${ox.toFixed(1)} oy=${oy.toFixed(1)} (${sc.desc})`);
          }
        }
      });
      // totals on last page only
      const last = pages.length - 1;
      const withTotal = pages.map((p, i) => (p.some((it) => it.str === "Subtotal") ? i : -1)).filter((x) => x >= 0);
      if (withTotal.length !== 1 || withTotal[0] !== last) problems.push(`#${n} totals not only on last page: ${JSON.stringify(withTotal)} of ${pages.length}`);
    }
    expect(problems).toEqual([]);
  }, 600_000);

  const BOTTOM = 54 - 2; // baselines must stay on or above the bottom margin (page numbers sit below it and are excluded)
  const bodyItems = (items: Item[]) => items.filter((i) => !/^Page \d+ of \d+$/.test(i.str) && i.str !== "DRAFT" && i.str !== "VOID");

  it("D-11 (fixed): with EVERY header field at its validated maximum the first table row moves to a continuation page instead of running below the bottom margin", async () => {
    const mk = (n: number) => "WORD ".repeat(200).slice(0, n).trim();
    const input: PdfInput = {
      status: "issued", displayNumber: "3100", title: null, poNumber: null,
      business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: null, addressLines: [], einText: null },
      billTo: { name: "Acme", addressLines: [] },
      issueDate: "2026-10-05", dueText: "Due upon receipt", lines: [],
      subtotalCents: 100, discountCents: 0, discountLabel: null, totalCents: 100, paidCents: 0, balanceCents: 100,
      notes: null, termsText: null, footerText: "Thank you", remit: { payableTo: "EKC LLC", mailingLines: ["1 Test Road"], bankLines: [] }, documentLabel: "Invoice",
    };
    const r = await renderInvoicePdf({
      ...input,
      title: mk(120),
      poNumber: mk(60),
      business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: mk(120), addressLines: [mk(400)], einText: "12-3456789" },
      billTo: { name: mk(120), addressLines: [mk(400), mk(400), mk(80) + ", " + mk(2) + " " + mk(20), mk(60)] },
      dueText: "Net 365 days, due 2027-10-05",
      lines: [{ description: mk(500), quantity: "1", unit: null, unitPriceCents: 100, discountText: "10% off", totalCents: 100, workDate: "2026-10-01" }],
    });
    const pages = await textItems(r.bytes);
    const below = pages.flat().filter((i) => i.y < BOTTOM && !/^Page \d+ of \d+$/.test(i.str) && i.str !== "DRAFT" && i.str !== "VOID");
    expect(below).toEqual([]);
    // The row's table header sits with it on a later page, never alone at the bottom of page 1.
    const withHead = pages.map((p, i) => (p.some((it) => it.str === "Description") ? i : -1)).filter((x) => x >= 0);
    expect(withHead).toHaveLength(1);
    expect(pages.flat().some((i) => i.str === "Amount")).toBe(true);
  });

  it("the first row is not forced onto page 1 (model level): page 1 keeps only the header and bill-to block when the row does not fit", () => {
    const measure = (t: string, size: number, bold?: boolean) => t.length * size * (bold ? 0.6 : 0.55);
    const long = Array.from({ length: 30 }, (_, i) => `Billing address line ${i + 1} of a very long block`);
    const input: PdfInput = {
      status: "issued", displayNumber: "3100", title: null, poNumber: null,
      business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: null, addressLines: [], einText: null },
      billTo: { name: "Acme", addressLines: long },
      issueDate: "2026-10-05", dueText: "Due upon receipt",
      lines: [{ description: Array.from({ length: 60 }, () => "word").join(" ").repeat(3), quantity: "1", unit: null, unitPriceCents: 100, discountText: null, totalCents: 100, workDate: null }],
      subtotalCents: 100, discountCents: 0, discountLabel: null, totalCents: 100, paidCents: 0, balanceCents: 100,
      notes: null, termsText: null, footerText: null, remit: { payableTo: null, mailingLines: [], bankLines: [] }, documentLabel: "Invoice",
    };
    const m = buildPdfModel(input, measure, 0);
    expect(m.pages.length).toBeGreaterThanOrEqual(2);
    expect(m.pages[0]!.rows).toHaveLength(0);
    expect(m.pages[0]!.items.some((i) => i.kind === "tableHead")).toBe(false); // no orphan table header on page 1
    expect(m.pages[1]!.items[0]!.kind).toBe("tableHead");
    expect(m.pages.flatMap((p) => p.rows)).toHaveLength(1);
  });

  // The last block (totals, payment lines, notes, terms, footer) at its validated maximum lengths: notes, terms and footer 2,000
  // characters each, bank text 1,200, mailing address 400, check payee 120. With the widest letters that is taller than a page.
  const tokens = (prefix: string, chars: number) => {
    const out: string[] = [];
    let len = 0;
    for (let i = 1; len < chars; i += 1) {
      const t = `${prefix}${String(i).padStart(3, "0")}`;
      out.push(t);
      len += t.length + 1;
    }
    return out;
  };
  const lastBlockInput = (opts: { notes: number; terms: number; footer: number; bank: number; mailing: number; wide: boolean; lines: number }): { input: PdfInput; all: string[] } => {
    const tk = (p: string, n: number) => (n === 0 ? [] : tokens(p, n));
    const notes = tk("NOTE", opts.notes);
    const terms = tk("TERM", opts.terms);
    const footer = tk("FOOT", opts.footer);
    const bank = tk("BANK", opts.bank);
    const mailing = tk("MAIL", opts.mailing);
    const wide = (t: string[]) => (opts.wide ? t.map((x) => x + "W".repeat(6)) : t);
    const input: PdfInput = {
      status: "issued", displayNumber: "3100", title: null, poNumber: null,
      business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: null, addressLines: ["1 Test Road"], einText: null },
      billTo: { name: "Acme", addressLines: ["2 Client Way"] },
      issueDate: "2026-10-05", dueText: "Due upon receipt",
      lines: Array.from({ length: opts.lines }, (_, i) => ({ description: `Work item ${i + 1}`, quantity: "1", unit: null, unitPriceCents: 100, discountText: null, totalCents: 100, workDate: null })),
      subtotalCents: 100 * opts.lines, discountCents: 0, discountLabel: null, totalCents: 100 * opts.lines, paidCents: 0, balanceCents: 100 * opts.lines,
      notes: opts.notes ? wide(notes).join(" ") : null,
      termsText: opts.terms ? wide(terms).join(" ") : null,
      footerText: opts.footer ? wide(footer).join(" ") : null,
      remit: { payableTo: "EKC LLC", mailingLines: mailing.length ? [wide(mailing).join(" ")] : [], bankLines: bank.length ? [wide(bank).join(" ")] : [] },
      documentLabel: "Invoice",
    };
    return { input, all: [...wide(notes), ...wide(terms), ...wide(footer), ...wide(bank), ...wide(mailing)] };
  };
  const checkRendered = (pages: Item[][], all: string[], label: string): string[] => {
    const problems: string[] = [];
    pages.forEach((items, pi) => {
      for (const i of bodyItems(items)) {
        if (i.y < BOTTOM) problems.push(`${label} p${pi + 1} below the bottom margin: ${i.str.slice(0, 30)} y=${i.y.toFixed(1)}`);
        if (i.x + i.w > 558 + 0.6) problems.push(`${label} p${pi + 1} past the right margin: ${i.str.slice(0, 30)}`);
      }
    });
    const text = pages.flat().map((i) => i.str).join(" ");
    for (const t of all) if (!text.includes(t)) problems.push(`${label} text missing from the PDF: ${t}`);
    const subtotal = pages.map((p, i) => (p.some((it) => it.str === "Subtotal") ? i : -1)).filter((x) => x >= 0);
    if (subtotal.length !== 1) problems.push(`${label} totals box appears on ${subtotal.length} pages`);
    if (pages.flat().filter((i) => i.str === "Amount due").length !== 1) problems.push(`${label} "Amount due" does not appear exactly once`);
    return problems;
  };

  it("S2: notes, terms and footer at their 2,000-character caps (plus 1,200 of bank text) are never drawn below the bottom margin, in either letter width, and none of the text is lost", async () => {
    const problems: string[] = [];
    for (const wide of [false, true]) {
      const { input, all } = lastBlockInput({ notes: 2000, terms: 2000, footer: 2000, bank: 1200, mailing: 400, wide, lines: 3 });
      const r = await renderInvoicePdf(input);
      const pages = await textItems(r.bytes);
      problems.push(...checkRendered(pages, all, wide ? "wide" : "normal"));
      if (wide) expect(pages.length).toBeGreaterThanOrEqual(2); // taller than one page: it must continue on another page
      // continuation pages are labelled
      if (pages.length > 1) expect(pages[1]!.some((i) => i.str.includes("(continued)"))).toBe(true);
    }
    expect(problems).toEqual([]);
  });

  it("S2 fuzz: the last block at random lengths up to the caps, with a table of random length (so the block starts anywhere on a page), stays above the bottom margin with nothing lost and one totals box (seeded, 40 real renders)", async () => {
    const problems: string[] = [];
    const pickLen = (max: number) => pick([0, 0, int(1, 80), int(80, 400), max]);
    for (let n = 0; n < 40; n += 1) {
      const { input, all } = lastBlockInput({
        notes: pickLen(2000), terms: pickLen(2000), footer: pickLen(2000), bank: pickLen(1200), mailing: pickLen(400),
        wide: rnd() < 0.5, lines: pick([0, 1, 5, 12, 22, 23, 24, 25, 26, 40]),
      });
      const r = await renderInvoicePdf(input);
      problems.push(...checkRendered(await textItems(r.bytes), all, `#${n}`));
    }
    expect(problems).toEqual([]);
  }, 600_000);

  it("S2 model fuzz: for 600 random documents the paginator never reserves more than a page for a page, keeps the row order, and places the totals box exactly once", () => {
    const measure = (t: string, size: number, bold?: boolean) => t.length * size * (bold ? 0.62 : 0.56);
    const usable = LAYOUT.pageH - LAYOUT.margin * 2;
    const problems: string[] = [];
    for (let n = 0; n < 600; n += 1) {
      const pickLen = (max: number) => pick([0, 0, int(1, 80), int(80, 400), max]);
      const mk = (chars: number) => (chars === 0 ? null : tokens("T", chars).join(" "));
      const nLines = pick([0, 1, 3, 10, 20, 24, 25, 26, 30, 50]);
      const input: PdfInput = {
        status: "issued", displayNumber: "3100", title: pick([null, mk(300)]), poNumber: null,
        business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: pick([null, mk(120)]), addressLines: [pick(["1 Test Road", mk(400)!])], einText: null },
        billTo: { name: "Acme", addressLines: Array.from({ length: int(0, 4) }, () => pick(["2 Client Way", mk(400)!])) },
        issueDate: "2026-10-05", dueText: "Due upon receipt",
        lines: Array.from({ length: nLines }, (_, i) => ({ description: pick(["Work", mk(500)!]), quantity: "1", unit: null, unitPriceCents: 100, discountText: null, totalCents: 100, workDate: pick([null, `2026-10-0${(i % 9) + 1}`]) })),
        subtotalCents: 100, discountCents: 0, discountLabel: null, totalCents: 100, paidCents: 0, balanceCents: 100,
        notes: mk(pickLen(2000)), termsText: mk(pickLen(2000)), footerText: mk(pickLen(2000)),
        remit: { payableTo: "EKC LLC", mailingLines: [mk(pickLen(400))].filter((x): x is string => x !== null), bankLines: [mk(pickLen(1200))].filter((x): x is string => x !== null) },
        documentLabel: "Invoice",
      };
      const logo = pick([0, 0, 64]);
      const m = buildPdfModel(input, measure, logo);
      m.pages.forEach((pg, pi) => {
        const reserved = pg.items.reduce((t, it) => t + it.height, 0);
        const cap = pi === 0 ? usable - m.headerBlockH : usable - LAYOUT.contHeaderH;
        // A continuation page may exceed its room only when it holds a single unit taller than the page (never the case for validated input).
        if (reserved > cap + 0.001) problems.push(`#${n} page ${pi + 1} reserves ${reserved} of ${cap}`);
        const firstTable = pg.items.find((it) => it.kind === "tableHead" || it.kind === "row");
        if (pg.rows.length > 0 && firstTable?.kind !== "tableHead") problems.push(`#${n} page ${pi + 1} has rows without a table header above them`);
      });
      if (m.pages.flatMap((p) => p.rows).length !== nLines) problems.push(`#${n} rows lost`);
      if (m.pages.filter((p) => p.showTotals).length !== 1) problems.push(`#${n} totals on ${m.pages.filter((p) => p.showTotals).length} pages`);
      if (m.pages.slice(1).some((p) => p.showFullHeader) || !m.pages[0]!.showFullHeader) problems.push(`#${n} full header misplaced`);
    }
    expect(problems).toEqual([]);
  });
});
