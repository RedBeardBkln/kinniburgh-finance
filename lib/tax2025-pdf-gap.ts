// The PDF gap report (plan sections 5.4 and 9/T9): for every mapped form, what the
// packet cannot fill and why. Pure (the script supplies the view, the maps and the
// parsed catalogs), so it is unit-tested with the fixture and needs no database.
//
//   - pendingKeysUsed:   map lines keyed by a PENDING_LINE_KEYS entry (the engine does not
//                        emit them yet; the owners of 1a/1b/Phase 2 add the keys);
//   - unmappedMoneyLines: printed money-line fields no map line claims (HEURISTIC: a text
//                        field whose IRS "speak" text carries a line number, not claimed by
//                        a line/header/table, not an identity/bank field);
//   - blankLines:        mapped money lines that print blank for this return, with the reason.

import { collectClaims } from "@/lib/tax2025/pdf/completeness";
import { resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import { PENDING_LINE_KEYS } from "@/lib/tax2025/pdf/pending-line-keys";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";
import type { FormMap, MapMoneyLine, PdfReturnView } from "@/lib/tax2025/pdf/types";

export interface GapUnmappedLine {
  field: string;
  /** Line text from the IRS description, e.g. "11a. Subtract line 10 from line 9". */
  text: string;
  /** Why the map does not fill it: the blank reason, or "unclaimed". */
  claimedAs: string;
}

export interface GapBlankLine {
  key: string;
  field: string;
  reason: string;
}

export interface FormGap {
  formId: string;
  mappedMoneyLines: number;
  filledMoneyLines: number;
  pendingKeysUsed: { key: string; field: string }[];
  unmappedMoneyLines: GapUnmappedLine[];
  blankLines: GapBlankLine[];
}

/** Last two path segments of a field name, for readable output. */
export function shortField(name: string): string {
  const parts = name.split(".");
  return parts.slice(-2).join(".");
}

const IDENTITY_WORDS =
  /social security|identifying number|routing|account number|\bPIN\b|personal identification|phone|e-?mail|address|preparer|designee|signature|occupation|\bname\b|\bnames\b|\bdate\b|\bSSN\b|\bEIN\b/i;
const LINE_NUMBER = /(?:^|[\s.])(\d{1,2}[a-z]?\.\s+\S.*)$/;

/** The printed line text of a field's IRS description, or null when it does not look like a money line. */
export function printedLineText(speak: string | null): string | null {
  if (speak === null) return null;
  if (/^Page \d/.test(speak) || IDENTITY_WORDS.test(speak)) return null;
  const m = LINE_NUMBER.exec(speak);
  const text = m?.[1]?.trim();
  if (!text) return null;
  return text.length > 110 ? `${text.slice(0, 107)}...` : text;
}

function blankReason(view: PdfReturnView, entry: MapMoneyLine, pending: ReadonlySet<string>): string | null {
  const line = view.lines[entry.line];
  const decision = resolveFieldValue("gap", line, entry, view.answers);
  if (decision.write !== null) return null;
  if (line === undefined) {
    return pending.has(entry.line)
      ? "pending key: the engine does not emit this line yet"
      : "the engine emits no line for this key";
  }
  const item = decision.items[0];
  if (item) {
    // "Schedule C line 30 (...): left blank - <why>": keep only the why.
    const at = item.message.indexOf("left blank - ");
    return at === -1 ? item.message : item.message.slice(at + "left blank - ".length);
  }
  return line.status === "not_applicable"
    ? "not applicable (blank is zero)"
    : "computed zero (blank is zero; printed only where the form needs it)";
}

export function buildGapReport(
  view: PdfReturnView,
  maps: readonly FormMap[],
  catalogs: Readonly<Record<string, FormCatalog>>,
): FormGap[] {
  const pending: ReadonlySet<string> = new Set<string>(PENDING_LINE_KEYS);
  const out: FormGap[] = [];
  for (const map of maps) {
    const catalog = catalogs[map.formId];
    const fieldNames = catalog ? catalog.fields.map((f) => f.name) : [];
    const money = map.lines.filter((l): l is MapMoneyLine => l.kind === "money");

    const blankLines: GapBlankLine[] = [];
    let filled = 0;
    for (const entry of money) {
      const reason = blankReason(view, entry, pending);
      if (reason === null) filled += 1;
      else blankLines.push({ key: entry.line, field: shortField(entry.field), reason });
    }

    const pendingKeysUsed = money
      .filter((l) => pending.has(l.line))
      .map((l) => ({ key: l.line as string, field: shortField(l.field) }));

    const unmapped: GapUnmappedLine[] = [];
    if (catalog) {
      const claims = collectClaims(map, fieldNames);
      const claimedBy = new Map<string, string>();
      for (const c of claims) claimedBy.set(c.field, c.by);
      const notModeled = new Set<string>();
      for (const b of map.blank) {
        if (b.reason !== "not_modeled") continue;
        for (const n of fieldNames) {
          if ("field" in b) {
            if (n === b.field) notModeled.add(n);
          } else {
            b.match.lastIndex = 0;
            if (b.match.test(n)) notModeled.add(n);
          }
        }
      }
      for (const f of catalog.fields) {
        if (f.type !== "text") continue;
        const by = claimedBy.get(f.name);
        if (by !== undefined && !notModeled.has(f.name)) continue; // modeled (or blank by design)
        const text = printedLineText(f.speak);
        if (text === null) continue;
        unmapped.push({ field: shortField(f.name), text, claimedAs: by === undefined ? "unclaimed" : "not_modeled" });
      }
    }

    out.push({
      formId: map.formId,
      mappedMoneyLines: money.length,
      filledMoneyLines: filled,
      pendingKeysUsed,
      unmappedMoneyLines: unmapped,
      blankLines,
    });
  }
  return out;
}

/** Plain-text rendering used by `pnpm tax2025:pdf-gap`. */
export function formatGapReport(gaps: readonly FormGap[]): string {
  const lines: string[] = [];
  for (const g of gaps) {
    lines.push(`== ${g.formId} ==`);
    lines.push(`  mapped money lines: ${g.mappedMoneyLines}, filled for this return: ${g.filledMoneyLines}, blank: ${g.blankLines.length}`);
    lines.push(`  pending keys still used (${g.pendingKeysUsed.length}):`);
    for (const p of g.pendingKeysUsed) lines.push(`    ${p.key}  (${p.field})`);
    lines.push(`  printed money lines with no mapping (${g.unmappedMoneyLines.length}, heuristic):`);
    for (const u of g.unmappedMoneyLines) lines.push(`    [${u.claimedAs}] ${u.field}: ${u.text}`);
    lines.push(`  lines blank with reasons (${g.blankLines.length}):`);
    for (const b of g.blankLines) lines.push(`    ${b.key}  (${b.field}): ${b.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}
