// Pure, client-safe: which TD Bank statement mask ("x1234" in "Online Xfer Transfer to CK x1234") identifies exactly ONE
// active household TD account. Shared by the transfer matcher (lib/transfer-match-runner.ts) and the dashboard's
// own-transfer label check (lib/own-account-masks-build.ts), so both resolve a mask the same way. No DB, no logging: the
// masks stay server-side as Map keys and never go into a log line, an AuditLog row or a client payload.

export interface TdFormerMaskAlias {
  /** The last four digits the bank still prints on old (and some new) transfer labels. */
  formerMask: string;
  /** The CURRENT mask of the one active TD account that former number belongs to. */
  currentMask: string;
  /** Where the fact comes from. Never add an alias without an owner statement. */
  source: string;
}

/**
 * Former account numbers of household TD accounts. Exactly one entry, from an owner statement. Do NOT add others
 * without a new owner statement (a test pins this list).
 */
export const TD_FORMER_MASK_ALIASES: readonly TdFormerMaskAlias[] = [
  {
    formerMask: "8815",
    currentMask: "3950",
    source:
      "Owner statement 2026-10-19: SV x8815 is the old number of the household Savings account (TD Bank), changed after a hack",
  },
];

/**
 * Builds mask -> account id over the rows passed in (callers pass active TD accounts only). Rules, in order:
 * 1. A current mask held by two or more accounts is ambiguous and never in the map.
 * 2. An alias resolves to the ONE account whose current mask is `currentMask`; with no target, or an ambiguous one, the
 *    alias is ignored.
 * 3. If an alias's `formerMask` is also some account's CURRENT mask, that mask is ambiguous: it is removed from the map
 *    entirely (neither account) and the alias is ignored.
 * 4. Two aliases sharing a `formerMask` with different targets drop that mask too.
 */
export function buildTdMaskMap(
  rows: readonly { id: string; mask: string | null }[],
  aliases: readonly TdFormerMaskAlias[] = TD_FORMER_MASK_ALIASES
): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.mask) continue;
    seen.set(r.mask, seen.has(r.mask) ? null : r.id);
  }
  const out = new Map<string, string>();
  for (const [mask, id] of seen) if (id) out.set(mask, id);

  // Resolve aliases against the current masks only (an alias never resolves through another alias).
  const aliasTargets = new Map<string, string | null>();
  for (const a of aliases) {
    const target = out.get(a.currentMask) ?? null;
    if (!target) continue; // no target, or an ambiguous one: ignored
    const prev = aliasTargets.get(a.formerMask);
    aliasTargets.set(a.formerMask, prev === undefined ? target : prev === target ? target : null);
  }
  for (const [formerMask, target] of aliasTargets) {
    if (seen.has(formerMask)) {
      // also some active account's current mask: ambiguous, drop it entirely
      out.delete(formerMask);
      continue;
    }
    if (target) out.set(formerMask, target);
  }
  return out;
}
