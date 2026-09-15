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
