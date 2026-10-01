// ─── GL code type-change warning copy ──────────────────────────────────────
//
// Pure string-building for the retroactive-reclassification confirmation
// shown when a user edits an in-use GL code's `type` (e.g. expense →
// revenue). Business P&L (`computePL`) is computed live from each
// transaction's *current* glCodeId, so changing a code's type retroactively
// changes how already-reported historical periods classify those
// transactions going forward — this message spells that out before the
// caller shows it via `window.confirm(...)` (this repo's only confirmation
// pattern; see plan Risk 6).

export function buildTypeChangeWarning(
  impact: { transactionCount: number; distinctPeriods: number },
  fromType: string,
  toType: string
): string {
  const { transactionCount, distinctPeriods } = impact;
  const txWord = transactionCount === 1 ? "transaction" : "transactions";
  const periodWord = distinctPeriods === 1 ? "month" : "months";

  return (
    `This code is used on ${transactionCount} ${txWord} across ${distinctPeriods} ${periodWord}. ` +
    `Changing its type from ${fromType} to ${toType} will change how those ${periodWord}' P&L reports ` +
    `classify them going forward. Continue?`
  );
}

// ─── Balance-sheet (non-P&L) GL code guards ────────────────────────────────
//
// `computePL` only counts GL codes of type `revenue` / `expense`. Anything
// else (asset / liability / equity, or an unexpected legacy string) is
// silently left off the Profit & Loss. These helpers define that boundary in
// one place and build the user-facing copy that makes the exclusion visible.
// "Excluded" is defined as "not a P&L type" rather than "is asset/liability/
// equity" so an unexpected type string is surfaced instead of dropped.

const PL_GL_TYPES: ReadonlySet<string> = new Set(["revenue", "expense"]);

/** True only for GL types that `computePL` includes (revenue / expense). */
export function isPLGlType(type: string): boolean {
  return PL_GL_TYPES.has(type);
}

/**
 * Confirmation text shown before a tag is mapped to a non-P&L GL code.
 * Returns null when the code is a P&L type (no warning needed). The text
 * ends with a question so it can be passed straight to `window.confirm`.
 */
export function buildNonPLMappingWarning(args: {
  tagName: string;
  glCode: { code: string; name: string; type: string };
  usageCount: number;
}): string | null {
  const { tagName, glCode, usageCount } = args;
  if (isPLGlType(glCode.type)) return null;

  const usage =
    usageCount > 0
      ? ` This tag is currently used on ${usageCount} ${usageCount === 1 ? "transaction" : "transactions"}.`
      : "";

  return (
    `"${tagName}" maps to ${glCode.code} ${glCode.name} (${glCode.type}), a balance-sheet account. ` +
    `Transactions with this tag will NOT appear on the Profit & Loss. ` +
    `That is correct for things like owner contributions/draws or loan principal, but not for revenue or expenses.` +
    usage +
    ` This does not recode transactions that are already coded; it applies to future auto-coding and backfill. ` +
    `Save anyway?`
  );
}

/**
 * P&L page notice text. The caller formats the amount (kept as a string so
 * this helper stays pure and Decimal-free).
 */
export function buildPLExclusionNotice(args: {
  transactionCount: number;
  formattedAmount: string;
}): string {
  const { transactionCount, formattedAmount } = args;
  const isOne = transactionCount === 1;
  return (
    `${transactionCount} ${isOne ? "transaction" : "transactions"} (net ${formattedAmount}) ` +
    `${isOne ? "is" : "are"} coded to balance-sheet accounts (asset/liability/equity) ` +
    `and ${isOne ? "is" : "are"} not included in this P&L.`
  );
}
