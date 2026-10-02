// Client-driven bulk extraction loop (pure; the per-document `run` function is
// injected so it can be tested without any server action or API call).
//
// Why a client loop rather than one server action: each extraction takes
// 20-60 s and no maxDuration is configured, so one request looping many of
// them would hit the platform request limit. Driving the loop from the browser
// keeps every extraction in its own request (same pattern as the statement and
// tax-document upload flows).

import { runWithConcurrencyLimit } from "@/lib/concurrency";
import { ALREADY_UP_TO_DATE_ERROR, BULK_CONCURRENCY, MAX_BULK_EXTRACT } from "@/lib/document-extraction-state";

export type BulkRunOutcome = { ok: true } | { ok: false; error: string };

export interface BulkProgress {
  /** Documents whose call has finished (any outcome) or that were skipped. */
  done: number;
  total: number;
  succeeded: number;
  failed: number;
  /** Already up to date when re-checked on the server (no API call was made). */
  skipped: number;
}

export interface BulkFailure {
  id: string;
  error: string;
}

export interface BulkResult extends BulkProgress {
  failures: BulkFailure[];
  /** Documents never started because the user pressed Stop. */
  stopped: number;
  /** Candidates beyond the per-click cap that were not part of this run. */
  remaining: number;
}

export interface BulkOptions {
  ids: string[];
  /** Runs one document's extraction. Rejections are caught and counted as failures. */
  run: (id: string) => Promise<BulkRunOutcome>;
  /** Checked before each NEW call; calls already in flight always finish. */
  shouldStop?: () => boolean;
  onProgress?: (progress: BulkProgress) => void;
  maxItems?: number;
  concurrency?: number;
}

export async function runBulkExtraction(options: BulkOptions): Promise<BulkResult> {
  const maxItems = options.maxItems ?? MAX_BULK_EXTRACT;
  const concurrency = options.concurrency ?? BULK_CONCURRENCY;
  const batch = options.ids.slice(0, maxItems);
  const remaining = Math.max(0, options.ids.length - batch.length);

  const progress: BulkProgress = { done: 0, total: batch.length, succeeded: 0, failed: 0, skipped: 0 };
  const failures: BulkFailure[] = [];
  let stopped = 0;
  const emit = () => options.onProgress?.({ ...progress });

  await runWithConcurrencyLimit(batch, concurrency, async (id) => {
    if (options.shouldStop?.()) {
      stopped += 1;
      return;
    }
    let outcome: BulkRunOutcome;
    try {
      outcome = await options.run(id);
    } catch {
      outcome = { ok: false, error: "The request failed before extraction finished" };
    }
    if (outcome.ok) {
      progress.succeeded += 1;
    } else if (outcome.error === ALREADY_UP_TO_DATE_ERROR) {
      progress.skipped += 1;
    } else {
      progress.failed += 1;
      failures.push({ id, error: outcome.error });
    }
    progress.done += 1;
    emit();
  });

  return { ...progress, failures, stopped, remaining };
}
