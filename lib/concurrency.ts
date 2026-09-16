// Generic bounded-concurrency batch runner. Used by the bank statement
// batch/folder upload UI to run many independent per-file upload flows
// without either fully serializing them (slow for 100 files) or firing them
// all at once (unbounded parallel storage/network load).
//
// Contract: results are returned in the same order as `items`, regardless of
// completion order; at most `limit` calls to `fn` are in-flight at once.
// `fn` is expected to never reject — callers are responsible for catching
// their own per-item errors and resolving with an error-shaped result, so
// this helper stays simple scheduling logic with no rejection-aggregation
// semantics to worry about.
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      // Safe: index < items.length was just checked above.
      results[index] = await fn(items[index]!, index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
