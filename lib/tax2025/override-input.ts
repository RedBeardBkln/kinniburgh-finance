// Pure helpers for the override dialog (components/tax/forms/override-*.tsx). There is
// no component-test infrastructure in this repo (no jsdom), so everything the dialog
// DECIDES lives here as plain functions with unit tests (lib/__tests__/tax2025-override-input.test.ts):
//   - parsing the typed amount (whole dollars only),
//   - validating the reason,
//   - whether Save is allowed,
//   - how a history row and a server result are worded.
// Dependency-free on purpose (the client bundle imports it): it imports only the shared
// formatters and TYPES.

import {
  OVERRIDE_MAX_ABS_DOLLARS,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  formatDollars,
  formatOverrideDate,
} from "@/lib/tax2025/override-format";
import type { OverrideActionResult, OverrideHistoryRow } from "@/lib/tax2025/overrides";

// ── Amount ────────────────────────────────────────────────────────────────────

export type ParsedAmount = { ok: true; dollars: number; cents: number } | { ok: false; error: string };

const AMOUNT_SHAPE = /^(-)?\$?(-)?(\d{1,3}(?:,\d{3})+|\d+)$/;

/**
 * "12345", "$12,345", "-500", "-$500" and "$-500" are whole dollars. Cents ("12.50", even "12.00"),
 * blanks, text, exponents ("1e3") and amounts past the bound are rejected with a plain sentence.
 * The result is exact integer cents (no float arithmetic on cents).
 */
export function parseWholeDollarInput(text: string, maxAbsDollars: number = OVERRIDE_MAX_ABS_DOLLARS): ParsedAmount {
  const raw = text.trim();
  if (raw === "") return { ok: false, error: "Enter the amount in whole dollars." };
  if (/[.]/.test(raw)) return { ok: false, error: "Whole dollars only: leave out the cents." };
  const m = AMOUNT_SHAPE.exec(raw);
  if (m === null) return { ok: false, error: "Type a whole-dollar amount, like 12345 or $12,345 (a minus sign is allowed)." };
  const negative = m[1] !== undefined || m[2] !== undefined;
  if (m[1] !== undefined && m[2] !== undefined) return { ok: false, error: "Type a whole-dollar amount, like 12345 or $12,345 (a minus sign is allowed)." };
  const digits = (m[3] ?? "").replace(/,/g, "");
  const magnitude = parseInt(digits, 10);
  if (!Number.isSafeInteger(magnitude) || magnitude > maxAbsDollars) {
    return { ok: false, error: `The amount cannot be more than ${formatDollars(maxAbsDollars)} (or less than -${formatDollars(maxAbsDollars)}).` };
  }
  const dollars = negative && magnitude !== 0 ? -magnitude : magnitude;
  return { ok: true, dollars, cents: dollars * 100 };
}

/**
 * Lines whose printed form shows pre-printed parentheses, so the amount is a LOSS held as a negative number (Form 8995 lines 3, 7,
 * 16 and 17). The PDF prints the magnitude of a negative amount inside those parentheses and leaves a zero or positive amount blank
 * (specs/09, "Sign convention for the loss lines"). A plain sentence for the amount field of the override dialog; null for other lines.
 */
const LOSS_ENTRY_LINES: ReadonlySet<string> = new Set(["f8995.3", "f8995.7", "f8995.16", "f8995.17"]);

export function amountEntryHint(lineKey: string): string | null {
  if (!LOSS_ENTRY_LINES.has(lineKey)) return null;
  return "This is a loss line. Enter a loss as a negative number, for example -3000. The form prints it without the minus sign, inside its own parentheses. A positive number leaves the box empty on the form.";
}

// ── Reason ────────────────────────────────────────────────────────────────────

export type ReasonCheck = { ok: true; length: number } | { ok: false; error: string; length: number };

/** The server trims the reason; the counter and the check do the same. */
export function checkReasonInput(text: string): ReasonCheck {
  const length = text.trim().length;
  if (length < REASON_MIN_LENGTH) return { ok: false, error: `Give a reason (at least ${REASON_MIN_LENGTH} characters).`, length };
  if (length > REASON_MAX_LENGTH) return { ok: false, error: `The reason can be at most ${REASON_MAX_LENGTH} characters.`, length };
  return { ok: true, length };
}

export function reasonCounterText(text: string): string {
  return `${text.trim().length}/${REASON_MAX_LENGTH}`;
}

// ── Save gating ───────────────────────────────────────────────────────────────

export interface LineFormState {
  amountText: string;
  reasonText: string;
  /** The dialog is already saving. */
  busy: boolean;
}

export interface LineFormCheck {
  canSave: boolean;
  amountError: string | null;
  reasonError: string | null;
  cents: number | null;
}

/** An untouched (empty) field shows no error yet; Save stays disabled until both are valid. */
export function checkLineForm(state: LineFormState): LineFormCheck {
  const amount = parseWholeDollarInput(state.amountText);
  const reason = checkReasonInput(state.reasonText);
  return {
    canSave: !state.busy && amount.ok && reason.ok,
    amountError: state.amountText.trim() === "" ? null : amount.ok ? null : amount.error,
    reasonError: state.reasonText.trim() === "" ? null : reason.ok ? null : reason.error,
    cents: amount.ok ? amount.cents : null,
  };
}

export interface DecisionFormState {
  choice: string | null;
  reasonText: string;
  busy: boolean;
}

export function checkDecisionForm(state: DecisionFormState): { canSave: boolean; reasonError: string | null } {
  const reason = checkReasonInput(state.reasonText);
  return {
    canSave: !state.busy && state.choice !== null && reason.ok,
    reasonError: state.reasonText.trim() === "" ? null : reason.ok ? null : reason.error,
  };
}

// ── Server results ────────────────────────────────────────────────────────────

/** Plain text for a failed action result. */
export function describeActionFailure(res: Extract<OverrideActionResult, { ok: false }>): string {
  if (res.code === "conflict") return "Someone changed this just now. Reload and try again.";
  return res.error;
}

// ── History ───────────────────────────────────────────────────────────────────

export interface HistoryRowText {
  /** "Version 2 (current)" / "Version 1 (replaced on 2026-10-12)" / "Version 3 (cleared on 2026-10-13)". */
  title: string;
  /** "$13,000" / "choice: actual" / "acknowledged". */
  valueText: string;
  authorityLabel: string;
  /** "Set by Eric Kinniburgh on 2026-10-11". */
  setText: string;
  reasonText: string;
  /** The clear reason, for a cleared row; else null. */
  clearReasonText: string | null;
  state: "current" | "superseded" | "cleared";
}

function valueOfRow(r: OverrideHistoryRow): string {
  if (r.valueKind === "money_cents" && r.valueCents !== null) return formatDollars(r.valueCents / 100);
  if (r.valueKind === "choice" && r.valueText !== null) return `choice: ${r.valueText}`;
  return "acknowledged";
}

/** One history row, in words (dates are America/New_York). */
export function formatOverrideHistoryRow(r: OverrideHistoryRow): HistoryRowText {
  const state: HistoryRowText["state"] = r.archivedAt === null ? "current" : r.archiveKind === "cleared" ? "cleared" : "superseded";
  const when = r.archivedAt === null ? "" : formatOverrideDate(r.archivedAt);
  const title =
    state === "current"
      ? `Version ${r.version} (current)`
      : state === "cleared"
        ? `Version ${r.version} (cleared on ${when})`
        : `Version ${r.version} (replaced on ${when})`;
  return {
    title,
    valueText: valueOfRow(r),
    authorityLabel: r.authority === "cpa" ? "CPA" : "Owner (Eric/Eva)",
    setText: `Set by ${r.setByName} on ${formatOverrideDate(r.setAt)}`,
    reasonText: r.reason,
    clearReasonText: state === "cleared" ? r.archiveReason : null,
    state,
  };
}

/** Newest version first (the action already returns them that way; this keeps the dialog correct if it ever did not). */
export function sortHistoryNewestFirst(rows: readonly OverrideHistoryRow[]): OverrideHistoryRow[] {
  return [...rows].sort((a, b) => b.version - a.version);
}
