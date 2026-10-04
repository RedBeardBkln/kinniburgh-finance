// L1.B1: the PDF equals the engine (plan section 5.3). Every filled PDF is read back from its bytes and every money field,
// table cell and header field is compared with what the EFFECTIVE return says should be printed there:
//   - nothing is printed that the return does not say;
//   - nothing the return computed is left blank (a blank is only right for a computed zero, a not-applicable line or a
//     line with no amount);
//   - a line the engine could not compute (missing input / needs a professional's input / not yet computed) is blank, never "0".
// The expected value is RE-STATED here from the blank-line policy of the plan (it is not read from policy.ts), so a bug in
// the policy or the filler is a finding, not a self-fulfilling pass.

import { splitName } from "@/lib/tax2025/pdf/format";
import { safeText } from "@/lib/tax2025/pdf/safe-text";
import type { HeaderSource, MapMoneyLine, MapTable, PdfAnswer, PdfLine, PdfReturnView, PdfTableRow } from "@/lib/tax2025/pdf/types";
import type { LineKey } from "@/lib/tax2025/line-catalog";
import { isLineKey, makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { carriesAmount, parseMoneyText, plainStatus, usd } from "@/lib/tax-review/l1/helpers";
import { bindFiles, evidenceRefForField, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";

/** The text of the last row of an overflowing table (fill.ts OVERFLOW_LABEL, re-stated; a test pins that they are equal). */
export const OVERFLOW_ROW_LABEL = "Other (see statement)";

/** Whole dollars as printed: thousands commas, a leading minus. */
export function printedDollars(n: number): string {
  const body = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${body}` : body;
}

export interface Expected {
  /** What the field must hold; null = it must be empty. */
  text: string | null;
  /** An inconsistency in the engine's own line that the printed value cannot settle. */
  anomaly?: string;
}

/** What the blank-line policy says one money field must print. */
export function expectedMoney(line: PdfLine | undefined, entry: MapMoneyLine, answers: Readonly<Record<string, PdfAnswer>>): Expected {
  if (line === undefined) return { text: null };
  const printZero = entry.zero === "print" || (entry.zeroWhen !== undefined && answers[entry.zeroWhen.choice] === entry.zeroWhen.equals);
  if (!carriesAmount(line.status)) return { text: null };
  const amount = line.amount;
  if (amount === null || !Number.isSafeInteger(amount)) return { text: null, anomaly: "the line is marked as having an amount but carries none" };
  if (entry.sign !== undefined) {
    const magnitude = entry.sign === "owed" ? amount : -amount;
    return { text: magnitude > 0 ? printedDollars(magnitude) : null };
  }
  if (line.status === "not_applicable") {
    return { text: printZero ? "0" : null, ...(amount !== 0 ? { anomaly: "a line marked not applicable carries a non-zero amount" } : {}) };
  }
  if (amount === 0) return { text: line.status === "overridden" || printZero ? "0" : null };
  return { text: printedDollars(amount) };
}

/** Header text a header field must hold (re-stated from the header sources of the maps). */
export function expectedHeader(source: HeaderSource, view: PdfReturnView): string | null {
  const h = view.header;
  const t = (s: string | null): string | null => (s !== null && s.trim() !== "" ? s : null);
  switch (source) {
    case "household.names":
      return t(h.householdNames);
    case "household.taxpayer":
      return t(h.taxpayerName);
    case "household.spouse":
      return t(h.spouseName);
    case "household.taxpayerFirst":
      return h.taxpayerName ? t(splitName(h.taxpayerName).first) : null;
    case "household.taxpayerLast":
      return h.taxpayerName ? t(splitName(h.taxpayerName).last) : null;
    case "household.spouseFirst":
      return h.spouseName ? t(splitName(h.spouseName).first) : null;
    case "household.spouseLast":
      return h.spouseName ? t(splitName(h.spouseName).last) : null;
    case "entity.ekcName":
      return t(h.ekcName);
    case "year":
      return String(view.taxYear);
  }
}

/** The text a table must print, row by row and column by column: null = empty cell, number = whole dollars. */
export function expectedTableCells(table: MapTable, view: PdfReturnView): Array<Record<string, string | number | null>> {
  const data: PdfTableRow[] = view.tables[table.table] ?? [];
  const capacity = table.rows.length;
  const blankRow = (): Record<string, string | number | null> => ({});
  const out: Array<Record<string, string | number | null>> = Array.from({ length: capacity }, blankRow);
  const place = (i: number, cells: Readonly<Record<string, string | number | null>>): void => {
    const row = out[i];
    if (row === undefined) return;
    for (const [col, v] of Object.entries(cells)) row[col] = v === undefined || v === "" ? null : v;
  };
  if (data.length <= capacity) {
    data.forEach((r, i) => place(i, r.cells));
    return out;
  }
  if (table.overflow === "none") return out; // fill throws for this; the packet then raises its own blocking item
  for (let i = 0; i < capacity - 1; i++) {
    const r = data[i];
    if (r) place(i, r.cells);
  }
  let total = 0;
  for (const r of data.slice(capacity - 1)) {
    const v = r.cells[table.amountColumn];
    if (typeof v === "number" && Number.isSafeInteger(v)) total += v;
  }
  place(capacity - 1, { [table.labelColumn]: OVERFLOW_ROW_LABEL, [table.amountColumn]: total });
  return out;
}

const MAX_PER_CHECK = 40;

export const pdfValuesCheck: L1Check = {
  id: "L1.B1",
  description: "Every printed number, table cell and header field in every PDF equals the effective return",
  async run(ctx: L1Context): Promise<Finding[]> {
    const files = ctx.read ?? (await readPacketFiles(ctx.packet.files));
    const out: Finding[] = [];
    for (const { file, map, view } of bindFiles(ctx, files)) {
      if (map === null || view === null) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.B1.unbound",
            severity: "blocker",
            area: "packaging",
            formKey: file.formId,
            ruleTag: file.name,
            message: `The packet file "${file.name}" cannot be matched to a form map${map === null ? "" : " copy"}, so what it prints cannot be compared with the return.`,
            evidence: [{ ref: `form:${file.formId}`, amount: null, status: "unbound" }],
            recommendedAction: "Do not file this packet. Rebuild it; if this repeats, the form map registry is inconsistent.",
            acceptable: false,
          })
        );
        continue;
      }
      const printed = (field: string): string => {
        const v = file.fields.get(field);
        return typeof v === "string" ? v.trim() : "";
      };
      // money lines
      for (const entry of map.lines) {
        if (entry.kind !== "money") continue;
        const line = view.lines[entry.line];
        const exp = expectedMoney(line, entry, view.answers);
        const got = printed(entry.field);
        const gotNum = got === "" ? null : parseMoneyText(got);
        const title = `${line?.formLabel ?? map.formId} line ${line?.formLine ?? entry.line}`;
        if (exp.anomaly !== undefined) {
          out.push(
            makeFinding({
              layer: "L1",
              check: "L1.B1.anomaly",
              severity: "high",
              area: "forms",
              formKey: file.formId,
              ruleTag: `${file.name}|${entry.field}`,
              message: `${title}: ${exp.anomaly}.`,
              evidence: [{ ref: String(entry.line), amount: line?.amount ?? null, status: line?.status ?? "absent" }],
              recommendedAction: "Check this line in the return; the engine's own line is inconsistent.",
              acceptable: true,
            })
          );
        }
        if ((exp.text ?? "") === got) continue;
        const state = line?.status ?? "absent";
        const wantNum = exp.text === null ? null : parseMoneyText(exp.text);
        const shown = gotNum === null ? "text that is not an amount" : usd(gotNum);
        const why =
          exp.text !== null && got === ""
            ? `the return has ${wantNum === null ? "an amount" : usd(wantNum)} for it but the field is blank`
            : exp.text === null
              ? state === "missing_input" || state.startsWith("needs_cpa") || state === "not_yet_computed"
                ? `the return has NO amount for this line (${plainStatus(state)}) but the field prints ${shown} (a line with no amount must stay blank, never 0)`
                : `the return prints nothing here but the field holds ${shown}`
              : `the return says ${wantNum === null ? "a different amount" : usd(wantNum)} but the field prints ${shown}`;
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.B1.money",
            severity: "blocker",
            area: "forms",
            formKey: file.formId,
            ...(isLineKey(String(entry.line)) ? { lineKey: entry.line as LineKey } : {}),
            ruleTag: `${file.name}|${entry.field}`,
            message: `${title} (${file.name}): ${why}.`,
            evidence: [
              { ref: String(entry.line), amount: line?.amount ?? null, status: state },
              { ref: evidenceRefForField(file.formId, entry.field), amount: gotNum, status: got === "" ? "blank" : "printed" },
            ],
            recommendedAction: "Do not file this PDF. Rebuild the packet; if the difference remains, the form map or the filler has a defect (do not hand-edit the field).",
            acceptable: false,
          })
        );
      }
      // header
      for (const h of map.header) {
        const want = expectedHeader(h.source, view);
        const wantText = want === null ? "" : safeText(want).text.trim();
        const got = printed(h.field);
        if (wantText !== got) {
          out.push(
            makeFinding({
              layer: "L1",
              check: "L1.B1.header",
              severity: "blocker",
              area: "forms",
              formKey: file.formId,
              ruleTag: `${file.name}|${h.field}`,
              message: `${file.name}: the ${h.source.replace("household.", "").replace("entity.", "")} field ${got === "" ? "is blank" : wantText === "" ? "holds text the return does not have" : "prints a different name than the return"}.`,
              evidence: [{ ref: evidenceRefForField(file.formId, h.field), amount: null, status: got === "" ? "blank" : "printed" }],
              recommendedAction: "Do not file this PDF. Rebuild the packet.",
              acceptable: false,
            })
          );
        }
      }
      // tables
      for (const table of map.tables) {
        const expected = expectedTableCells(table, view);
        table.rows.forEach((cols, i) => {
          for (const [col, field] of Object.entries(cols)) {
            const want = expected[i]?.[col] ?? null;
            const got = printed(field);
            let ok: boolean;
            if (want === null) ok = got === "";
            else if (typeof want === "number") ok = parseMoneyText(got) === want && got !== "";
            else if (table.fit?.[col] !== undefined) ok = got !== ""; // a fitted text cell may be shortened (an advisory item says so)
            else ok = got === safeText(want).text.trim();
            if (ok) continue;
            out.push(
              makeFinding({
                layer: "L1",
                check: "L1.B1.table",
                severity: "blocker",
                area: "forms",
                formKey: file.formId,
                ruleTag: `${file.name}|${field}`,
                message: `${file.name}: ${table.table} row ${i + 1} column "${col}" ${want === null ? "holds a value but the return has no row there" : got === "" ? "is blank but the return has a value" : typeof want === "number" ? `prints ${parseMoneyText(got) === null ? "text" : usd(parseMoneyText(got) ?? 0)} but the return says ${usd(want)}` : "prints different text than the return"}.`,
                evidence: [{ ref: evidenceRefForField(file.formId, field), amount: typeof want === "number" ? want : null, status: got === "" ? "blank" : "printed" }],
                recommendedAction: "Do not file this PDF. Rebuild the packet.",
                acceptable: false,
              })
            );
          }
        });
      }
    }
    return out.length > MAX_PER_CHECK
      ? [
          ...out.slice(0, MAX_PER_CHECK),
          makeFinding({
            layer: "L1",
            check: "L1.B1.more",
            severity: "blocker",
            area: "forms",
            ruleTag: "more",
            message: `${out.length - MAX_PER_CHECK} more differences between the PDFs and the return were found; only the first ${MAX_PER_CHECK} are listed.`,
            evidence: [{ ref: "check:L1.B1", amount: out.length, status: "count" }],
            recommendedAction: "Do not file this packet. Rebuild it and run the review again.",
            acceptable: false,
          }),
        ]
      : out;
  },
};

