// Pure duplicate-transaction detection — client-safe.

export interface DedupeTxRow {
  id: string;
  accountId: string;
  entityId: string;
  postedAt: Date | string; // ISO strings OK
  amount: string;          // decimal string; sign kept
  payeeNormalized: string | null;
  transferPairId: string | null;
}

export interface DuplicateGroup {
  /** The transaction that stays (earliest created, then lowest id for stability) */
  keep: DedupeTxRow;
  /** Exact duplicates to archive */
  duplicates: DedupeTxRow[];
}

/**
 * Exact-duplicate definition (per owner spec): same account, same posted DATE,
 * same amount, same normalized payee. Transfer legs are skipped — matching
 * pairs are legitimate. Rows already logged as duplicates are skipped by the
 * caller (so undo-restored transactions aren't re-archived).
 */
export function findDuplicateGroups(rows: DedupeTxRow[]): DuplicateGroup[] {
  const keyOf = (r: DedupeTxRow) => {
    const iso =
      r.postedAt instanceof Date ? r.postedAt.toISOString() : new Date(r.postedAt).toISOString();
    const day = iso.slice(0, 10);
    return `${r.accountId}|${day}|${r.amount}|${r.payeeNormalized ?? ""}`;
  };

  // Bucket by exact key
  const buckets = new Map<string, DedupeTxRow[]>();
  for (const row of rows) {
    if (row.transferPairId !== null) continue; // transfer legs are expected pairs
    const key = keyOf(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // Keep the earliest-inserted row (createdAt ordering handled by caller);
    // ties broken by id for deterministic runs.
    const sorted = [...bucket].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    groups.push({ keep: sorted[0]!, duplicates: sorted.slice(1) });
  }

  return groups;
}