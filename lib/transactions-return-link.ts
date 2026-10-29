// "Return to transactions": the list's own query travels to the detail page as `?from=` and comes back with an anchor on
// the row that was opened, so the owner lands on the same page, filters and row. Pure (no DB, no next/*): the detail page
// and the list table both use it. Only the list's known query keys are carried; anything else in `from` is dropped.

export const RETURN_PARAM_KEYS = [
  "bucket",
  "tab",
  "page",
  "search",
  "accountId",
  "tagId",
  "dateFrom",
  "dateTo",
  "sort",
  "sortDir",
] as const;

type ReturnParamKey = (typeof RETURN_PARAM_KEYS)[number];

const MAX_VALUE_LENGTH = 200;
const ROW_ANCHOR_PREFIX = "tx-";

/** The DOM id of a transaction's row in the list (the return link's hash target). */
export function rowAnchorId(transactionId: string): string {
  return `${ROW_ANCHOR_PREFIX}${transactionId}`;
}

/** The transaction id named by a location hash such as "#tx-<id>", or null. */
export function transactionIdFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith(ROW_ANCHOR_PREFIX)) return null;
  const id = raw.slice(ROW_ANCHOR_PREFIX.length);
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

/** Keeps only the list's known keys (non-empty, bounded length), in a fixed order. */
export function sanitizeListQuery(query: string | URLSearchParams | Partial<Record<ReturnParamKey, string | undefined>>): string {
  const source =
    query instanceof URLSearchParams
      ? query
      : typeof query === "string"
        ? new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)
        : null;
  const out = new URLSearchParams();
  for (const key of RETURN_PARAM_KEYS) {
    const value = source ? source.get(key) : (query as Partial<Record<ReturnParamKey, string | undefined>>)[key];
    if (typeof value === "string" && value !== "" && value.length <= MAX_VALUE_LENGTH) out.set(key, value);
  }
  return out.toString();
}

/** Link from a list row to the detail page, carrying the list's query. */
export function transactionDetailHref(transactionId: string, listQuery: string): string {
  const q = sanitizeListQuery(listQuery);
  const base = `/transactions/${encodeURIComponent(transactionId)}`;
  return q ? `${base}?from=${encodeURIComponent(q)}` : base;
}

/**
 * Link from the detail page back to the list. With a `from` query it returns to that page of the list and to the row;
 * without one it is the plain list (no anchor: the row may not be on its first page).
 */
export function transactionsReturnHref(transactionId: string, from: string | undefined | null): string {
  const q = from ? sanitizeListQuery(from) : "";
  if (!q) return "/transactions";
  return `/transactions?${q}#${rowAnchorId(transactionId)}`;
}
