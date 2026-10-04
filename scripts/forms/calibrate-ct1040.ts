/**
 * Calibrate the CT-1040 (flat PDF, no form fields) overlay geometry.
 *
 *   pnpm forms:calibrate-ct
 *
 * Reads the pinned blank data/forms/2025/ct1040.pdf (sha256-verified against the
 * manifest) with pdfjs-dist and writes data/forms/2025/geometry/ct1040.json:
 * one rectangle per text field this app adds over the flat page (lib/tax2025/pdf/ct-overlay.ts).
 *
 * How a rectangle is found (nothing is typed in by hand except the expected line list):
 *  - the form DRAWS every input box as a white filled rectangle (pdfjs operator list,
 *    fill colour tracked through save/restore/transform), so an amount field is exactly
 *    the inside of the white box that sits right of a printed line label ("11.", "18a.");
 *  - each amount row also prints a ".00" cents text; its x is the ANCHOR the field's right
 *    edge must stay left of (guard test);
 *  - withholding columns A/B, Schedule 3 description cells and the name boxes are white
 *    boxes found the same way, relative to a printed label;
 *  - the one checkbox (Married filing jointly) has no drawn box a script can find (the
 *    squares are font glyphs), so its rectangle is DERIVED from the label position and marked
 *    "derived" (visual check only).
 *
 * Dev tool, never run at request time. pdfjs-dist is a devDependency used only here.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { getBlankBytes, getManifestEntry } from "../../lib/tax2025/pdf/registry";

const FORM_ID = "ct1040";
const OUT = path.join(process.cwd(), "data", "forms", "2025", "geometry", "ct1040.json");

/** Printed line ids to give an amount field, per 1-based page. (Schedules 2 and 5 are not filled by this app.) */
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const AMOUNT_LINES: Readonly<Record<number, readonly string[]>> = {
  1: range(1, 16),
  2: ["17", "18a", "18b", "18c", "18d", "18e", "18f", "18", "19", "20", "20a", "20b", "20c", "20d", "21", "22", "23", "24", "24a", "25", "26", "27", "28", "29", "30"],
  3: [...range(31, 36), "36a", ...range(37, 48), "48a", "48b", "48c", "48d", "49", "50"],
  // 64 (pre-printed 300) and 66 (a decimal) are not dollar boxes the app fills.
  4: ["60", "61", "62", "63", "65", "67", "68", "69a", "69b", "69c", "69d", "69"],
};
const WITHHOLDING_ROWS = ["18a", "18b", "18c", "18d", "18e"] as const;
const PROPERTY_ROWS = ["60", "61", "62"] as const;

export type FieldKind = "amount" | "text" | "check";
export type Basis = "drawn" | "derived";

export interface GeometryField {
  name: string;
  /** 0-based page index. */
  page: number;
  kind: FieldKind;
  /** Printed line id this field belongs to ("11", "18a", "name"). */
  line: string;
  rect: { x: number; y: number; width: number; height: number };
  /** The pre-printed ".00" this amount box must stay left of, when one exists. */
  anchor: { x: number; y: number } | null;
  basis: Basis;
}

interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const mul = (m: number[], n: number[]): number[] => [
  m[0]! * n[0]! + m[2]! * n[1]!,
  m[1]! * n[0]! + m[3]! * n[1]!,
  m[0]! * n[2]! + m[2]! * n[3]!,
  m[1]! * n[2]! + m[3]! * n[3]!,
  m[0]! * n[4]! + m[2]! * n[5]! + m[4]!,
  m[1]! * n[4]! + m[3]! * n[5]! + m[5]!,
];

/** White filled rectangles (the drawn input boxes) of one page, in user space. */
async function whiteBoxes(page: pdfjs.PDFPageProxy): Promise<Box[]> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const paintOps = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  interface State {
    fill: string;
    ctm: number[];
  }
  let st: State = { fill: "", ctm: [1, 0, 0, 1, 0, 0] };
  const stack: State[] = [];
  const boxes: Box[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]!;
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push({ fill: st.fill, ctm: [...st.ctm] });
    else if (fn === OPS.restore) st = stack.pop() ?? st;
    else if (fn === OPS.transform) st.ctm = mul(st.ctm, args as number[]);
    else if (fn === OPS.setFillRGBColor) st.fill = String(args);
    else if (fn === OPS.constructPath && st.fill === "#ffffff" && paintOps.has(args[0] as number)) {
      const mm = args[2] as ArrayLike<number>;
      const c = st.ctm;
      const pts: Array<[number, number]> = [
        [mm[0]!, mm[1]!],
        [mm[2]!, mm[3]!],
      ].map(([x, y]) => [c[0]! * x! + c[2]! * y! + c[4]!, c[1]! * x! + c[3]! * y! + c[5]!] as [number, number]);
      boxes.push({
        x0: Math.min(pts[0]![0], pts[1]![0]),
        y0: Math.min(pts[0]![1], pts[1]![1]),
        x1: Math.max(pts[0]![0], pts[1]![0]),
        y1: Math.max(pts[0]![1], pts[1]![1]),
      });
    }
  }
  return boxes;
}

async function textItems(page: pdfjs.PDFPageProxy): Promise<TextItem[]> {
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    if (it.str.trim() === "") continue;
    out.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, width: it.width });
  }
  return out;
}

function inset(b: Box): GeometryField["rect"] {
  const x = b.x0 + 1;
  const y = b.y0 + 0.6;
  return { x: r2(x), y: r2(y), width: r2(b.x1 - 1 - x), height: r2(b.y1 - 0.6 - y) };
}

async function main(): Promise<void> {
  const entry = getManifestEntry(FORM_ID);
  if (entry.sourceKind !== "flat") throw new Error(`${FORM_ID} is expected to be a flat form`);
  const bytes = getBlankBytes(FORM_ID); // sha256-verified
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  if (doc.numPages !== entry.pages) throw new Error(`${FORM_ID}: expected ${entry.pages} pages, pdfjs reports ${doc.numPages}`);

  const fields: GeometryField[] = [];
  const pages: Array<{ width: number; height: number }> = [];
  const problems: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [vx0, vy0, vx1, vy1] = page.view as [number, number, number, number];
    if (vx0 !== 0 || vy0 !== 0 || page.rotate !== 0) throw new Error(`page ${p}: unexpected origin or rotation`);
    pages.push({ width: r2(vx1), height: r2(vy1) });
    const items = await textItems(page);
    const boxes = (await whiteBoxes(page)).filter((b) => b.x1 - b.x0 >= 8 && b.y1 - b.y0 >= 8 && b.y1 - b.y0 <= 30);
    const labels = items.filter((i) => /^\d+[a-z]?\.$/.test(i.str));
    const cents = items.filter((i) => i.str.trim() === ".00");

    const used = new Set<Box>();
    const claim = (b: Box): Box => {
      used.add(b);
      return b;
    };
    const rowBoxes = (baseline: number): Box[] => boxes.filter((b) => b.y0 - 3 <= baseline && baseline <= b.y1).sort((a, b) => a.x0 - b.x0);

    // Right-hand amount boxes: the white box left of a ".00", with its printed line label just left of the box.
    const amountByLine = new Map<string, { box: Box; anchor: TextItem }>();
    for (const c of cents) {
      const candidates = boxes.filter((b) => b.x1 <= c.x + 0.5 && c.x - b.x1 <= 14 && b.y0 - 3 <= c.y && c.y <= b.y1);
      const box = candidates.sort((a, b) => b.x1 - a.x1)[0];
      if (!box) continue;
      const label = labels
        .filter((l) => box.x0 - (l.x + l.width) >= -2 && box.x0 - (l.x + l.width) <= 24 && Math.abs(l.y - c.y) <= 8)
        .sort((a, b) => b.x - a.x)[0];
      if (!label) continue; // e.g. Schedule 2's two-column rows: not filled by this app
      const id = label.str.slice(0, -1);
      if (amountByLine.has(id)) problems.push(`page ${p}: line ${id} matched two amount boxes`);
      amountByLine.set(id, { box, anchor: c });
    }

    for (const id of AMOUNT_LINES[p] ?? []) {
      const hit = amountByLine.get(id);
      if (!hit) {
        problems.push(`page ${p}: no amount box found for line ${id}`);
        continue;
      }
      claim(hit.box);
      fields.push({
        name: `ct1040.l${id}`,
        page: p - 1,
        kind: "amount",
        line: id,
        rect: inset(hit.box),
        anchor: { x: r2(hit.anchor.x), y: r2(hit.anchor.y) },
        basis: "drawn",
      });
    }

    if (p === 2) {
      // Withholding schedule: Column C is the amount box (above); Column B (wages) and Column A (employer ID) are the white boxes left of it in the same row.
      for (const id of WITHHOLDING_ROWS) {
        const colC = amountByLine.get(id);
        if (!colC) continue;
        const baseline = colC.anchor.y;
        const left = rowBoxes(baseline).filter((b) => b.x1 < colC.box.x0 - 5);
        const colB = left.sort((a, b) => b.x1 - a.x1)[0];
        const colA = left.filter((b) => b !== colB).sort((a, b) => b.x1 - a.x1)[0];
        if (!colA || !colB) {
          problems.push(`page ${p}: withholding row ${id} lacks column A or B boxes`);
          continue;
        }
        fields.push({ name: `ct1040.l${id}A`, page: p - 1, kind: "text", line: `${id}A`, rect: inset(claim(colA)), anchor: null, basis: "drawn" });
        fields.push({ name: `ct1040.l${id}B`, page: p - 1, kind: "amount", line: `${id}B`, rect: inset(claim(colB)), anchor: null, basis: "drawn" });
      }
    }

    if (p === 4) {
      // Schedule 3 rows: description cell (the wide white box left of the date cells).
      for (const id of PROPERTY_ROWS) {
        const amt = amountByLine.get(id);
        if (!amt) continue;
        const cells = rowBoxes(amt.anchor.y).filter((b) => b.x1 < 350);
        const desc = cells.sort((a, b) => b.x1 - a.x1)[0];
        if (!desc || desc.x1 - desc.x0 < 100) {
          problems.push(`page ${p}: Schedule 3 row ${id} has no description cell`);
          continue;
        }
        fields.push({ name: `ct1040.l${id}d`, page: p - 1, kind: "text", line: `${id}d`, rect: inset(claim(desc)), anchor: null, basis: "drawn" });
      }
    }

    if (p === 1) {
      // Name boxes: the white box right under its printed label.
      const under = (label: TextItem): Box | undefined =>
        boxes.filter((b) => Math.abs(b.x0 - label.x) <= 2 && b.y1 <= label.y + 1 && label.y - b.y1 <= 8).sort((a, b) => b.y1 - a.y1)[0];
      const find = (startsWith: string, y: number): TextItem | undefined =>
        items.find((i) => i.str.startsWith(startsWith) && Math.abs(i.y - y) <= 2);
      const specs: Array<[string, TextItem | undefined, string]> = [
        ["ct1040.firstName", find("Your first name", 606.2), "your first name"],
        ["ct1040.lastName", find("Last name", 606.2), "your last name"],
        ["ct1040.spouseFirstName", find("If joint return, spouse", 577.0), "spouse first name"],
        ["ct1040.spouseLastName", find("Last name", 577.0), "spouse last name"],
      ];
      for (const [name, label, what] of specs) {
        const box = label ? under(label) : undefined;
        if (!box) {
          problems.push(`page 1: no box found for ${what}`);
          continue;
        }
        fields.push({ name, page: 0, kind: "text", line: "name", rect: inset(claim(box)), anchor: null, basis: "drawn" });
      }
      // Filing status "Married filing jointly": the check squares are font glyphs, so derive the square from the label.
      const mfj = items.find((i) => i.str === "Married filing jointly");
      if (!mfj) problems.push("page 1: label 'Married filing jointly' not found");
      else {
        fields.push({
          name: "ct1040.fsMfj",
          page: 0,
          kind: "check",
          line: "filing-status",
          rect: { x: r2(mfj.x - 14.2), y: r2(mfj.y - 2.2), width: 9.6, height: 9.6 },
          anchor: null,
          basis: "derived",
        });
      }
    }
  }

  if (problems.length > 0) {
    console.error(`CT-1040 calibration FAILED:\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
  const names = new Set(fields.map((f) => f.name));
  if (names.size !== fields.length) throw new Error("duplicate field names");

  const header = {
    schemaVersion: 1,
    formId: FORM_ID,
    taxYear: 2025,
    source: { sha256: createHash("sha256").update(readFileSync(path.join(process.cwd(), "data", "forms", "2025", "ct1040.pdf"))).digest("hex"), bytes: entry.bytes, pdfjsDist: pdfjs.version },
    pages,
  };
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, "");
  const body = fields.map((f) => `    ${JSON.stringify(f)}`).join(",\n");
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${head},\n  "fields": [\n${body}\n  ]\n}\n`, "utf8");
  const perPage = pages.map((_, i) => fields.filter((f) => f.page === i).length);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${fields.length} fields (per page: ${perPage.join(", ")})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
