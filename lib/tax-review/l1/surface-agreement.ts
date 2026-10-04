// L1.X1: the same figures on every surface (plan section 5.3). The review sheet, the CSV export, the PDF view (and so the
// forms), and the cover page are all built from the same effective return, but by different code. This check compares them
// line by line and headline by headline: the same whole-dollar amount, the same override note, the same headline figures.

import { SHEET_CSV_COLUMNS } from "@/lib/tax2025-sheet-csv";
import type { SheetLine } from "@/lib/tax2025-sheet";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { carriesAmount, lineName, lineTitle, parseMoneyText, usd } from "@/lib/tax-review/l1/helpers";
import { isLineKey } from "@/lib/tax-review/types";

/** RFC 4180 CSV text -> rows of cells (handles quoted cells, doubled quotes and CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

interface CsvLine {
  amount: string;
  overrideNote: string;
}

function csvLines(csvText: string): { lines: Map<string, CsvLine>; headerFound: boolean } {
  const rows = parseCsv(csvText);
  const headerIdx = rows.findIndex((r) => r[0] === SHEET_CSV_COLUMNS[0] && r[2] === "line_key");
  const lines = new Map<string, CsvLine>();
  if (headerIdx === -1) return { lines, headerFound: false };
  const col = (name: (typeof SHEET_CSV_COLUMNS)[number]): number => SHEET_CSV_COLUMNS.indexOf(name);
  for (const r of rows.slice(headerIdx + 1)) {
    const key = r[col("line_key")] ?? "";
    if (!isLineKey(key)) continue;
    // a text cell starting with = + - @ is guarded with a leading quote by the exporter; amounts are never guarded
    lines.set(key, { amount: r[col("amount")] ?? "", overrideNote: (r[col("override_note")] ?? "").replace(/^'/, "") });
  }
  return { lines, headerFound: true };
}

function sheetLines(ctx: L1Context): Map<string, SheetLine> {
  const out = new Map<string, SheetLine>();
  for (const g of [...ctx.sheet.federal, ...ctx.sheet.connecticut]) for (const l of g.lines) out.set(l.key, l);
  return out;
}

/** The sheet prints a balance as "owed $N" / "refund $N" / "$0 (no balance)"; every other figure as "$N". Null = not computed or unreadable. */
export function parseHeadlineText(text: string): number | null {
  const t = text.trim();
  if (t === "not computed" || t === "") return null;
  if (t === "$0 (no balance)") return 0;
  const owed = /^owed\s+(.+)$/.exec(t);
  if (owed) return parseMoneyText(owed[1] ?? "");
  const refund = /^refund\s+(.+)$/.exec(t);
  if (refund) {
    const v = parseMoneyText(refund[1] ?? "");
    return v === null ? null : -v;
  }
  return parseMoneyText(t);
}

const COVER_ROWS: { label: string; get: (c: L1Context) => number | null }[] = [
  { label: "Federal AGI", get: (c) => c.view.headline.federal.agi.amount },
  { label: "Federal taxable income", get: (c) => c.view.headline.federal.taxableIncome.amount },
  { label: "Federal total tax", get: (c) => c.view.headline.federal.totalTax.amount },
  { label: "Federal total payments", get: (c) => c.view.headline.federal.totalPayments.amount },
  { label: "Federal balance", get: (c) => c.view.headline.federal.balance.amount },
  { label: "CT AGI", get: (c) => c.view.headline.connecticut.ctAgi.amount },
  { label: "CT tax", get: (c) => c.view.headline.connecticut.tax.amount },
  { label: "CT total payments", get: (c) => c.view.headline.connecticut.totalPayments.amount },
  { label: "CT balance", get: (c) => c.view.headline.connecticut.balance.amount },
];

function finding(check: string, tag: string, severity: "blocker" | "high", message: string, ref: string, amount: number | null, status: string): Finding {
  return makeFinding({
    layer: "L1",
    check,
    severity,
    area: "packaging",
    ruleTag: tag,
    message,
    evidence: [{ ref, amount, status }],
    recommendedAction: "Do not file while two outputs disagree. Rebuild every output from the app and run the review again.",
    acceptable: false,
  });
}

export const surfaceAgreementCheck: L1Check = {
  id: "L1.X1",
  description: "The review sheet, the CSV export, the forms and the cover show the same figures and the same override notes",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const sheet = sheetLines(ctx);
    const csv = csvLines(ctx.csvText);
    if (!csv.headerFound) out.push(finding("L1.X1.csv", "header", "high", "The CSV export has no recognisable header row, so its figures cannot be compared with the return.", "csv:header", null, "unreadable"));

    // per line
    for (const [key, line] of Object.entries(ctx.view.lines)) {
      if (line === undefined || !isLineKey(key)) continue;
      const viewAmount = carriesAmount(line.status) ? line.amount : null;
      const sl = sheet.get(key);
      if (sl === undefined) {
        out.push(finding("L1.X1.sheet-missing", key, "high", `${lineTitle(key)} is on the forms but not on the review sheet.`, `sheet:${key}`, viewAmount, "missing"));
      } else {
        const sheetAmount = sl.status === "informational" || sl.amount === null ? null : sl.amount;
        const sameAmount = viewAmount === sheetAmount || (viewAmount !== null && sl.amount === viewAmount);
        if (!sameAmount) {
          out.push(
            finding(
              "L1.X1.sheet",
              key,
              "blocker",
              `${lineTitle(key)}: the forms use ${viewAmount === null ? "no amount" : usd(viewAmount)} but the review sheet shows ${sl.amount === null ? "no amount" : usd(sl.amount)}.`,
              `sheet:${key}`,
              sl.amount,
              "differs"
            )
          );
        }
        const vNote = line.override?.note ?? null;
        const sNote = sl.override?.note ?? null;
        if (vNote !== sNote) {
          out.push(finding("L1.X1.override-note", key, "blocker", `${lineName(key)}: the override note on the forms and on the review sheet differ.`, `sheet:${key}`, null, "note differs"));
        }
      }
      const cl = csv.lines.get(key);
      if (csv.headerFound) {
        if (cl === undefined) {
          out.push(finding("L1.X1.csv-missing", key, "high", `${lineTitle(key)} is on the forms but not in the CSV export.`, `csv:${key}`, viewAmount, "missing"));
        } else {
          const csvAmount = cl.amount === "" ? null : parseMoneyText(cl.amount);
          if (cl.amount !== "" && csvAmount === null) {
            out.push(finding("L1.X1.csv", key, "blocker", `${lineName(key)}: the CSV amount is not a whole-dollar number.`, `csv:${key}`, null, "unreadable"));
          } else if (csvAmount !== viewAmount) {
            out.push(
              finding("L1.X1.csv", key, "blocker", `${lineTitle(key)}: the forms use ${viewAmount === null ? "no amount" : usd(viewAmount)} but the CSV export shows ${csvAmount === null ? "no amount" : usd(csvAmount)}.`, `csv:${key}`, csvAmount, "differs")
            );
          }
          const vNote = line.override?.note ?? "";
          if (vNote !== "" && !cl.overrideNote.startsWith(vNote)) {
            out.push(finding("L1.X1.override-note", `csv-${key}`, "blocker", `${lineName(key)}: the override note in the CSV export differs from the one on the forms.`, `csv:${key}`, null, "note differs"));
          }
        }
      }
    }
    for (const key of sheet.keys()) {
      if (ctx.view.lines[key as keyof typeof ctx.view.lines] === undefined) {
        out.push(finding("L1.X1.sheet-extra", key, "high", `${lineTitle(key)} is on the review sheet but not on the forms.`, `sheet:${key}`, null, "extra"));
      }
    }

    // headline: sheet rows (same order as the headline), cover rows (matched by label)
    const h = ctx.view.headline;
    const headRows = [...ctx.sheet.summary.federal, ...ctx.sheet.summary.connecticut];
    const expected = COVER_ROWS.map((r) => r.get(ctx));
    if (h.complete) {
      headRows.forEach((row, i) => {
        const want = expected[i] ?? null;
        const got = row.status === "computed" ? parseHeadlineText(row.computedText) : null;
        if (want !== got) {
          out.push(finding("L1.X1.headline-sheet", String(i), "blocker", `The review sheet headline "${row.label}" shows ${got === null ? "no amount" : usd(got)} but the return says ${want === null ? "no amount" : usd(want)}.`, `sheet:head.${i}`, got, "differs"));
        }
      });
      if (ctx.cover !== null) {
        COVER_ROWS.forEach((r, i) => {
          const blk = ctx.cover?.blocks.find((b) => b.kind === "kv" && b.label.startsWith(r.label));
          if (blk === undefined || blk.kind !== "kv") return;
          const want = expected[i] ?? null;
          const got = blk.value === "not computed" ? null : parseMoneyText(blk.value);
          if (want !== got) {
            out.push(finding("L1.X1.headline-cover", String(i), "blocker", `The cover page shows ${r.label} as ${got === null ? "no amount" : usd(got)} but the return says ${want === null ? "no amount" : usd(want)}.`, `head:${r.label}`, got, "differs"));
          }
        });
      }
    }
    return out;
  },
};
