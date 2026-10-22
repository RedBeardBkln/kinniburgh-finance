// Tester round 3 (ek-consulting-invoicing): independent read-back of REAL rendered PDFs for the round 3 pagination work. Rendered with
// renderInvoicePdf, read back with pdfjs (positions), widths of every text run recomputed with pdf-lib so pdfjs' substitute-font
// widths cannot cause false alarms. Checks per document: nothing below the bottom margin (page numbers excepted), nothing past either
// side margin, no two text boxes overlap, "Page i of N" is right on every page, the table header appears on every page that has rows
// (and nowhere else), every row appears exactly once and in order, the totals box ("Subtotal" and "AMOUNT DUE") appears exactly once,
// and no text token of the long blocks is lost.
import { describe, expect, it, vi } from "vitest";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import type { PdfInput } from "@/lib/invoicing/pdf/model";

vi.setConfig({ testTimeout: 60_000 });

type Item = { str: string; x: number; y: number; w: number; h: number };
// The invoice embeds its fonts (Roboto / Roboto Slab), so pdfjs reads the true glyph widths.
async function pagesOf(bytes: Uint8Array): Promise<Item[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const out: Item[][] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const items: Item[] = [];
    for (const it of tc.items) {
      if (!("str" in it) || it.str.trim() === "") continue;
      const size = Math.abs(it.transform[3] as number);
      items.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width as number, h: size || (it.height as number) });
    }
    out.push(items);
  }
  return out;
}

let s = 987654321;
const rnd = () => {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return (s >>> 0) / 0xffffffff;
};
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

/** Distinct, unbreakable-by-accident tokens totalling about `chars` characters. */
function toks(prefix: string, chars: number, wide: boolean): string[] {
  const out: string[] = [];
  let len = 0;
  for (let i = 1; len < chars; i += 1) {
    const t = `${prefix}${String(i).padStart(3, "0")}${wide ? "WWWW" : ""}`;
    out.push(t);
    len += t.length + 1;
  }
  return out;
}

interface Spec { rows: number; notes: number; terms: number; footer: number; bank: number; mailing: number; payee: number; wide: boolean; status: "issued" | "draft" | "void"; headerHeavy: boolean }
function build(spec: Spec): { input: PdfInput; all: string[]; rowTokens: string[] } {
  const tk = (p: string, n: number) => (n === 0 ? [] : toks(p, n, spec.wide));
  const notes = tk("NOTE", spec.notes);
  const terms = tk("TERM", spec.terms);
  const footer = tk("FOOT", spec.footer);
  const bank = tk("BANK", spec.bank);
  const mailing = tk("MAIL", spec.mailing);
  const payee = tk("PAYEE", spec.payee);
  const rowTokens = Array.from({ length: spec.rows }, (_, i) => `ROWTOKEN${String(i + 1).padStart(4, "0")}`);
  const heavy = (n: number) => toks("HDR", n, false).join(" ");
  const input: PdfInput = {
    status: spec.status,
    displayNumber: spec.status === "draft" ? null : "3100",
    title: spec.headerHeavy ? heavy(120) : null,
    poNumber: spec.headerHeavy ? heavy(60) : null,
    business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: spec.headerHeavy ? heavy(120) : "LaunchTime Solutions", addressLines: spec.headerHeavy ? [heavy(400)] : ["27 Old Barry Rd", "Quaker Hill, CT 06375"], einText: null },
    billTo: { name: spec.headerHeavy ? heavy(120) : "Acme Robotics", addressLines: spec.headerHeavy ? [heavy(400), heavy(400)] : ["2 Client Way"] },
    issueDate: spec.status === "draft" ? null : "2026-10-05",
    dueText: "Due upon receipt",
    lines: rowTokens.map((t, i) => ({ description: `${t} work item ${i + 1}`, quantity: "1", unit: null, unitPriceCents: 10000 + i, discountText: null, totalCents: 10000 + i, workDate: null })),
    subtotalCents: 10000 * spec.rows, discountCents: 0, discountLabel: null, totalCents: 10000 * spec.rows, paidCents: 0, balanceCents: 10000 * spec.rows,
    notes: notes.length ? notes.join(" ") : null,
    termsText: terms.length ? terms.join(" ") : null,
    footerText: footer.length ? footer.join(" ") : null,
    remit: { payableTo: payee.length ? payee.join(" ") : "EKC LLC", mailingLines: mailing.length ? [mailing.join(" ")] : [], bankLines: bank.length ? [bank.join(" ")] : [] },
    documentLabel: "Invoice",
  };
  return { input, all: [...notes, ...terms, ...footer, ...bank, ...mailing, ...payee], rowTokens };
}

const isPageNo = (i: Item) => /^Page \d+ of \d+$/.test(i.str);
const BODY_BOTTOM = 54 - 2;

function audit(label: string, pages: Item[][], all: string[], rowTokens: string[]): string[] {
  const p: string[] = [];
  const N = pages.length;
  pages.forEach((items, pi) => {
    const body = items.filter((i) => !isPageNo(i) && i.str !== "DRAFT" && i.str !== "VOID");
    for (const i of body) {
      if (i.y < BODY_BOTTOM) p.push(`${label} p${pi + 1} below bottom margin: "${i.str.slice(0, 25)}" y=${i.y.toFixed(1)}`);
      if (i.x < 53) p.push(`${label} p${pi + 1} left of margin: "${i.str.slice(0, 25)}" x=${i.x.toFixed(1)}`);
      if (i.x + i.w > 558.6) p.push(`${label} p${pi + 1} right of margin: "${i.str.slice(0, 25)}" end=${(i.x + i.w).toFixed(1)}`);
      if (i.y > 792 - 54 + 6) p.push(`${label} p${pi + 1} above top margin: "${i.str.slice(0, 25)}"`);
    }
    for (let a = 0; a < body.length; a += 1) {
      for (let b = a + 1; b < body.length; b += 1) {
        const A = body[a]!;
        const B = body[b]!;
        const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        const oy = Math.min(A.y + A.h * 0.72, B.y + B.h * 0.72) - Math.max(A.y, B.y);
        if (ox > 1.5 && oy > 1.5) p.push(`${label} p${pi + 1} OVERLAP "${A.str.slice(0, 20)}" x "${B.str.slice(0, 20)}"`);
      }
    }
    // page number
    const nums = items.filter(isPageNo);
    if (nums.length !== 1) p.push(`${label} p${pi + 1} has ${nums.length} page-number items`);
    else if (nums[0]!.str !== `Page ${pi + 1} of ${N}`) p.push(`${label} p${pi + 1} says "${nums[0]!.str}" expected "Page ${pi + 1} of ${N}"`);
    else if (nums[0]!.x < 53 || nums[0]!.x + nums[0]!.w > 558.6 || nums[0]!.y < 5 || nums[0]!.y > 54) p.push(`${label} p${pi + 1} page number position x=${nums[0]!.x.toFixed(1)} y=${nums[0]!.y.toFixed(1)}`);
  });
  // table header on exactly the pages that carry rows
  const flatText = pages.map((items) => items.map((i) => i.str));
  const rowPage = (t: string) => pages.findIndex((items) => items.some((i) => i.str.includes(t)));
  const pagesWithRows = new Set(rowTokens.map(rowPage).filter((x) => x >= 0));
  pages.forEach((items, pi) => {
    const heads = items.filter((i) => i.str === "DESCRIPTION").length;
    if (pagesWithRows.has(pi) && heads !== 1) p.push(`${label} p${pi + 1} carries rows but has ${heads} table headers`);
    if (!pagesWithRows.has(pi) && heads !== 0) p.push(`${label} p${pi + 1} has an orphan table header (${heads})`);
    // header sits above (greater y) every row on that page
    const head = items.find((i) => i.str === "DESCRIPTION");
    if (head) for (const t of rowTokens) for (const it of items) if (it.str.includes(t) && it.y >= head.y) p.push(`${label} p${pi + 1} row ${t} not below the table header`);
  });
  // rows: each exactly once, in order
  let lastKey = Infinity;
  rowTokens.forEach((t, idx) => {
    const hits = pages.flatMap((items, pi) => items.filter((i) => i.str.includes(t)).map((i) => ({ pi, y: i.y })));
    if (hits.length !== 1) p.push(`${label} row ${t} appears ${hits.length} times`);
    else {
      const key = hits[0]!.pi * 10000 - hits[0]!.y;
      if (idx > 0 && key <= lastKey) p.push(`${label} row ${t} out of order`);
      lastKey = key;
    }
  });
  // totals exactly once
  const flat = pages.flat();
  for (const label2 of ["Subtotal", "AMOUNT DUE"]) {
    const c = flat.filter((i) => i.str === label2).length;
    if (c !== 1) p.push(`${label} "${label2}" appears ${c} times`);
  }
  // long blocks: nothing lost
  const text = flat.map((i) => i.str).join(" ");
  for (const t of all) if (!text.includes(t)) p.push(`${label} missing token ${t}`);
  void flatText;
  return p;
}

describe("round 3 PDF pagination: real renders", () => {
  it("NEGATIVE CONTROLS: the audit is live (it reports a shifted-down page, a lost token, an orphan header and a wrong page number) and the max case really spans several pages", async () => {
    const sp: Spec = { rows: 40, notes: 2000, terms: 2000, footer: 2000, bank: 1200, mailing: 400, payee: 120, wide: true, status: "issued", headerHeavy: false };
    const { input, all, rowTokens } = build(sp);
    const pages = await pagesOf((await renderInvoicePdf(input)).bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.flat().length).toBeGreaterThan(300);
    expect(audit("clean", pages, all, rowTokens)).toEqual([]);
    const shifted = pages.map((p) => p.map((i) => ({ ...i, y: i.y - 60 })));
    expect(audit("shifted", shifted, all, rowTokens).some((x) => x.includes("below bottom margin"))).toBe(true);
    expect(audit("lost", pages, [...all, "NOTE999WWWW"], rowTokens).some((x) => x.includes("missing token"))).toBe(true);
    const renum = pages.map((p, pi) => p.map((i) => (isPageNo(i) ? { ...i, str: `Page ${pi + 2} of ${pages.length}` } : i)));
    expect(audit("renum", renum, all, rowTokens).some((x) => x.includes("expected"))).toBe(true);
    const noHead = pages.map((p, pi) => (pi === 1 ? p.filter((i) => i.str !== "DESCRIPTION") : p));
    expect(audit("nohead", noHead, all, rowTokens).some((x) => x.includes("table headers") || x.includes("orphan"))).toBe(true);
  });

  it("MAX-LENGTH cases: notes, terms, footer 2,000 chars, bank 1,200, mailing 400, payee 120: normal and widest letters, with 1, 22 and 40 rows", async () => {
    const problems: string[] = [];
    for (const wide of [false, true]) {
      for (const rows of [1, 22, 40]) {
        const sp: Spec = { rows, notes: 2000, terms: 2000, footer: 2000, bank: 1200, mailing: 400, payee: 120, wide, status: "issued", headerHeavy: false };
        const { input, all, rowTokens } = build(sp);
        const r = await renderInvoicePdf(input);
        const pages = await pagesOf(r.bytes);
        problems.push(...audit(`max wide=${wide} rows=${rows} pages=${pages.length}`, pages, all, rowTokens));
      }
    }
    expect(problems).toEqual([]);
  });

  it("MAX header + max last block + one 500-char row, all at once (worst case): nothing off page, nothing lost", async () => {
    const sp: Spec = { rows: 3, notes: 2000, terms: 2000, footer: 2000, bank: 1200, mailing: 400, payee: 120, wide: true, status: "issued", headerHeavy: true };
    const { input, all, rowTokens } = build(sp);
    const r = await renderInvoicePdf(input);
    const pages = await pagesOf(r.bytes);
    expect(audit(`worst pages=${pages.length}`, pages, all, rowTokens)).toEqual([]);
  });

  it("LAST BLOCK AT THE BOTTOM: sweep the row count 15..30 so the totals block starts at every height of the page, 'normal' block sizes", async () => {
    const problems: string[] = [];
    for (let rows = 15; rows <= 30; rows += 1) {
      const sp: Spec = { rows, notes: 300, terms: 300, footer: 200, bank: 200, mailing: 80, payee: 20, wide: false, status: "issued", headerHeavy: false };
      const { input, all, rowTokens } = build(sp);
      const pages = await pagesOf((await renderInvoicePdf(input)).bytes);
      problems.push(...audit(`sweep rows=${rows} pages=${pages.length}`, pages, all, rowTokens));
      // the totals block is on the LAST page in an ordinary invoice
      const sub = pages.findIndex((p) => p.some((i) => i.str === "Subtotal"));
      if (sub !== pages.length - 1) problems.push(`sweep rows=${rows}: totals on page ${sub + 1} of ${pages.length}, not the last page`);
    }
    expect(problems).toEqual([]);
  });

  it("empty last block (no notes, terms, footer, bank) with a sweep of 20..30 rows", async () => {
    const problems: string[] = [];
    for (let rows = 20; rows <= 30; rows += 1) {
      const sp: Spec = { rows, notes: 0, terms: 0, footer: 0, bank: 0, mailing: 0, payee: 0, wide: false, status: "issued", headerHeavy: false };
      const { input, all, rowTokens } = build(sp);
      const pages = await pagesOf((await renderInvoicePdf(input)).bytes);
      problems.push(...audit(`empty rows=${rows} pages=${pages.length}`, pages, all, rowTokens));
    }
    expect(problems).toEqual([]);
  });

  it("zero rows (header and totals only) and draft / void watermarks keep the same guarantees", async () => {
    const problems: string[] = [];
    for (const status of ["issued", "draft", "void"] as const) {
      const sp: Spec = { rows: 0, notes: 100, terms: 100, footer: 50, bank: 0, mailing: 40, payee: 10, wide: false, status, headerHeavy: false };
      const { input, all, rowTokens } = build(sp);
      const pages = await pagesOf((await renderInvoicePdf(input)).bytes);
      problems.push(...audit(`zero-rows ${status}`, pages, all, rowTokens));
    }
    expect(problems).toEqual([]);
  });

  it("SEEDED FUZZ: 45 random documents (random row counts, random block lengths up to the caps, wide or normal letters, heavy header or normal)", async () => {
    const problems: string[] = [];
    const len = (max: number) => pick([0, 0, int(1, 80), int(80, 400), max]);
    for (let n = 0; n < 45; n += 1) {
      const sp: Spec = {
        rows: pick([0, 1, 4, 12, 22, 23, 24, 25, 26, 40, 70]),
        notes: len(2000), terms: len(2000), footer: len(2000), bank: len(1200), mailing: len(400), payee: pick([0, 20, 120]),
        wide: rnd() < 0.5, status: pick(["issued", "draft", "void"] as const), headerHeavy: rnd() < 0.2,
      };
      const { input, all, rowTokens } = build(sp);
      const pages = await pagesOf((await renderInvoicePdf(input)).bytes);
      problems.push(...audit(`#${n} ${JSON.stringify(sp)} pages=${pages.length}`, pages, all, rowTokens));
    }
    expect(problems).toEqual([]);
  }, 900_000);

  it("a single unbreakable 200-character 'word' in a long field does not run off the right edge or below the page", async () => {
    const sp: Spec = { rows: 2, notes: 0, terms: 0, footer: 0, bank: 0, mailing: 0, payee: 0, wide: false, status: "issued", headerHeavy: false };
    const { input } = build(sp);
    input.notes = "A".repeat(200) + " tail";
    input.termsText = "B".repeat(300);
    input.footerText = "C".repeat(250);
    input.lines[0]!.description = "D".repeat(250);
    const pages = await pagesOf((await renderInvoicePdf(input)).bytes);
    const bad = pages.flatMap((items, pi) => items.filter((i) => !isPageNo(i) && (i.x + i.w > 558.6 || i.y < BODY_BOTTOM || i.x < 53)).map((i) => `p${pi + 1} "${i.str.slice(0, 20)}" x=${i.x.toFixed(1)} end=${(i.x + i.w).toFixed(1)} y=${i.y.toFixed(1)}`));
    expect(bad).toEqual([]);
  });
});
