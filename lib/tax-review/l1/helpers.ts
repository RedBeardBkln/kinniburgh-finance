// Small shared helpers for the L1 checks. Pure.

import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import type { PdfLine, PdfLineStatus } from "@/lib/tax2025/pdf/types";
import type { EvidenceItem } from "@/lib/tax-review/types";
import type { L1Context } from "@/lib/tax-review/l1/context";
import type { FormId } from "@/lib/tax2025/types";

/** "$1,234" / "-$1,234" (the thousands commas keep a long amount from looking like an identifier). */
export function usd(n: number): string {
  const body = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-$${body}` : `$${body}`;
}

export function usdOrNone(n: number | null): string {
  return n === null ? "no amount" : usd(n);
}

/** True for a status that carries a whole-dollar amount (computed, overridden or a not-applicable zero). */
export function carriesAmount(status: PdfLineStatus | "absent"): boolean {
  return status === "computed" || status === "overridden" || status === "not_applicable";
}

export interface LineState {
  amount: number | null;
  status: PdfLineStatus | "absent";
  line: PdfLine | undefined;
}

/** The EFFECTIVE state of a line (overrides applied), as every printed surface shows it. */
export function lineState(ctx: Pick<L1Context, "view">, key: string): LineState {
  const line = (ctx.view.lines as Partial<Record<string, PdfLine>>)[key];
  if (line === undefined) return { amount: null, status: "absent", line: undefined };
  return { amount: carriesAmount(line.status) ? line.amount : null, status: line.status, line };
}

export function evidenceOf(ctx: Pick<L1Context, "view">, keys: readonly string[]): EvidenceItem[] {
  return keys.map((k) => {
    const s = lineState(ctx, k);
    return { ref: k, amount: s.amount, status: s.status };
  });
}

/** "Form 1040 line 9". */
export function lineName(key: string): string {
  try {
    const m = lineMeta(key as LineKey);
    return `${m.form} line ${m.formLine}`;
  } catch {
    return key;
  }
}

/** The label of a line for a plain sentence: "Form 1040 line 9 (Total income)". */
export function lineTitle(key: string): string {
  try {
    const m = lineMeta(key as LineKey);
    return `${m.form} line ${m.formLine} (${m.label})`;
  } catch {
    return key;
  }
}

/**
 * Engine text can still say "the CPA"; nothing the reviewer writes may imply one reviews the return. This is the minimal rewrite
 * the checks apply to engine-supplied prose they quote; the wording layer that replaces it is a separate step of the task.
 */
export function plainText(text: string, max = 300): string {
  const t = text
    .replace(/\bthe CPA\b/gi, "you")
    .replace(/\bCPA\b/g, "a tax professional")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** Engine FormId of a line key (null for a worksheet line that has no form of its own). */
export function engineFormOfLine(key: string): FormId | null {
  const prefix = key.split(".")[0] ?? "";
  switch (prefix) {
    case "f1040":
    case "sch1":
    case "sch2":
    case "sch3":
    case "scha":
    case "schb":
    case "schc":
    case "schd":
    case "f8995":
    case "f8959":
    case "f6251":
    case "f8960":
    case "f2210":
    case "sch1a":
    case "f8880":
    case "ct1040":
      return prefix;
    case "se":
      return "schse";
    case "f8889a":
    case "f8889b":
      return "f8889";
    default:
      return null;
  }
}

/** The form is in the packet (Form 1040 always), or the engine says it is required / cannot rule it out. */
export function formIsFiled(ctx: Pick<L1Context, "packet" | "view">, mapFormId: string, engineForm?: FormId): boolean {
  if (mapFormId === "f1040") return true;
  if (ctx.packet.forms.some((f) => f.formId === mapFormId && f.included)) return true;
  if (engineForm !== undefined) {
    const v = ctx.view.formsRequired?.[engineForm];
    if (v !== undefined && v.required !== false) return true;
  }
  return false;
}

/** Whole dollars of "$1,234" / "-$1,234" / "1,234" / "-1,234" (also a leading minus before or after the symbol); null when not a plain amount. */
export function parseMoneyText(text: string): number | null {
  const t = text.trim();
  const m = /^(-?)\$?(-?)(\d{1,3}(?:,\d{3})*|\d+)$/.exec(t);
  if (m === null) return null;
  const n = Number((m[3] ?? "").replace(/,/g, ""));
  if (!Number.isSafeInteger(n)) return null;
  return m[1] === "-" || m[2] === "-" ? -n : n;
}

/** Integer cents -> whole dollars, half up on the magnitude (the IRS whole-dollar rule), restated here for the independent checks. */
export function roundCentsHalfUp(cents: number): number {
  const mag = Math.floor((Math.abs(cents) + 50) / 100);
  return cents < 0 ? -mag : mag;
}

/** Plain words for a line status (the engine status ids contain an identifier that must not reach owner-facing text). */
export function plainStatus(status: string): string {
  switch (status) {
    case "missing_input":
      return "missing input";
    case "needs_cpa_rule_unverified":
      return "rule not verified";
    case "needs_cpa_judgment":
      return "needs your decision";
    case "not_yet_computed":
      return "not yet computed";
    case "not_applicable":
      return "not applicable";
    default:
      return status.replace(/_/g, " ");
  }
}
