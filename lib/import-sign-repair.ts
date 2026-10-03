// Pure helpers for debit-only CSV imports — client-safe, no DB, no floats.
//
// Background: the CSV importer once mapped only a bank's Debit column, so every
// imported amount was stored positive (inflow) and every credit row was silently
// dropped. These helpers (a) plan the one-time repair of rows already stored that
// way and (b) let the importer warn before it happens again.

// ── Money-string helpers ──────────────────────────────────────────────────────

/** Canonical absolute value of a decimal string in whole cents, e.g. "-92.5" → "9250". */
export function absCentsKey(amount: string): string {
  const unsigned = amount.trim().replace(/^[-+]/, "");
  const [whole = "0", frac = ""] = unsigned.split(".");
  const cents = `${whole}${frac.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  return cents === "" ? "0" : cents;
}

function isNegative(amount: string): boolean {
  return /^-/.test(amount.trim()) && absCentsKey(amount) !== "0";
}

function isPositive(amount: string): boolean {
  return !/^-/.test(amount.trim()) && absCentsKey(amount) !== "0";
}

/** Flips the sign of a decimal string ("12.30" → "-12.30", "-5" → "5", "0" stays "0"). */
export function negateAmount(amount: string): string {
  const t = amount.trim();
  if (absCentsKey(t) === "0") return t;
  return t.startsWith("-") ? t.slice(1) : `-${t.replace(/^\+/, "")}`;
}

function dayKey(d: Date | string): string {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

// ── Importer guard ────────────────────────────────────────────────────────────

/** Minimum row count before "every row has the same sign" is suspicious rather than coincidence. */
export const SINGLE_SIGN_MIN_ROWS = 10;

/**
 * Returns "positive"/"negative" when every non-zero amount in a parsed file shares one
 * sign (and there are enough rows for that to be suspicious); otherwise null.
 * A real bank statement has both purchases and credits; a single-sign file usually
 * means a Debit-only column mapping or an opposite-sign export convention.
 */
export function detectSingleSign(amounts: string[]): "positive" | "negative" | null {
  const nonZero = amounts.filter((a) => absCentsKey(a) !== "0");
  if (nonZero.length < SINGLE_SIGN_MIN_ROWS) return null;
  if (nonZero.every(isPositive)) return "positive";
  if (nonZero.every(isNegative)) return "negative";
  return null;
}

// ── Repair planning ───────────────────────────────────────────────────────────

export const REPAIRABLE_ACCOUNT_TYPES = ["checking", "savings"] as const;

/**
 * An account needs repair when it holds enough imported rows and not one of them is an
 * outflow. Restricted to checking/savings: a card statement can legitimately be all-positive.
 */
export function isDebitOnlyImportAccount(accountType: string, importAmounts: string[]): boolean {
  return (
    (REPAIRABLE_ACCOUNT_TYPES as readonly string[]).includes(accountType) &&
    importAmounts.length >= SINGLE_SIGN_MIN_ROWS &&
    importAmounts.every(isPositive)
  );
}

export interface RepairImportRow {
  id: string;
  postedAt: Date | string;
  amount: string; // expected > 0
  tagIds: string[];
  projectId: string | null;
  /** Receipt, note, GL code, scheduled transfer, or transfer pair attached — never archive silently. */
  hasLinks: boolean;
}

export interface RepairPlaidRow {
  id: string;
  postedAt: Date | string;
  amount: string; // outflows only (< 0)
  tagIds: string[];
  projectId: string | null;
}

export interface OverlapPair {
  /** Import row that duplicates a Plaid row and will be archived (reversibly). */
  importId: string;
  /** The Plaid row that survives. */
  keptId: string;
  /** Tags to copy from the import row — only when the Plaid row has none of its own. */
  tagIdsToCopy: string[];
  /** Project to carry onto the Plaid row (only when it has none of its own). */
  projectIdToCopy: string | null;
}

export interface SignRepairPlan {
  /** Every positive import row — all are flipped to outflows. */
  negateIds: string[];
  /** Import rows matched 1:1 to a Plaid outflow (same day + same |amount|) → archived after flipping. */
  overlap: OverlapPair[];
  /** Matched to a Plaid row but carry links (or a conflicting project), so they're flipped but left active for review. */
  linkedOverlapIds: string[];
}

/**
 * Plans the repair. Matching is 1:1 and multiplicity-aware: two identical same-day import
 * rows only archive two Plaid-matched rows if Plaid also has two. Deterministic by id.
 */
export function planImportSignRepair(
  importRows: RepairImportRow[],
  plaidRows: RepairPlaidRow[]
): SignRepairPlan {
  const positives = importRows
    .filter((r) => isPositive(r.amount))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const buckets = new Map<string, RepairPlaidRow[]>();
  for (const p of [...plaidRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!isNegative(p.amount)) continue;
    const key = `${dayKey(p.postedAt)}|${absCentsKey(p.amount)}`;
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }

  const overlap: OverlapPair[] = [];
  const linkedOverlapIds: string[] = [];

  for (const row of positives) {
    const key = `${dayKey(row.postedAt)}|${absCentsKey(row.amount)}`;
    const match = buckets.get(key)?.shift();
    if (!match) continue;
    const projectConflict =
      row.projectId !== null && match.projectId !== null && row.projectId !== match.projectId;
    if (row.hasLinks || projectConflict) {
      linkedOverlapIds.push(row.id);
      continue;
    }
    overlap.push({
      importId: row.id,
      keptId: match.id,
      tagIdsToCopy: match.tagIds.length === 0 ? row.tagIds : [],
      projectIdToCopy: match.projectId === null ? row.projectId : null,
    });
  }

  return { negateIds: positives.map((r) => r.id), overlap, linkedOverlapIds };
}
