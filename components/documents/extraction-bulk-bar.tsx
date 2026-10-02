"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runDocumentExtraction } from "@/actions/documents";
import { runBulkExtraction, type BulkProgress, type BulkResult } from "@/lib/bulk-extraction";
import { BULK_CONCURRENCY, MAX_BULK_EXTRACT } from "@/lib/document-extraction-state";

interface Props {
  /**
   * missing:  extract documents that are not extracted (or failed).
   * outdated: re-extract unverified, uncorrected tax documents read with the older format.
   */
  mode: "missing" | "outdated";
  /** Ids of the visible documents the mode applies to. Computed on the server. */
  ids: string[];
  /** Display names by id, for the failure list. */
  names: Record<string, string>;
  /** outdated mode: older-format documents that are verified or hand-corrected (never bulk-touched). */
  needIndividual?: number;
}

/**
 * User-initiated bulk extraction. Nothing runs until the owner clicks and
 * confirms; each document is one paid API call, so a click runs at most
 * MAX_BULK_EXTRACT of them, BULK_CONCURRENCY at a time, from this client loop
 * (every call is its own request), with a Stop button. The "outdated" mode only
 * ever includes unverified, uncorrected documents (the server re-checks each
 * one with `expect: "outdated"`), so verified or corrected values are never
 * overwritten by a bulk run.
 */
export function ExtractionBulkBar({ mode, ids: missingIds, names, needIndividual = 0 }: Props) {
  const router = useRouter();
  const stopRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [stopping, setStopping] = useState(false);

  const count = missingIds.length;
  const batchSize = Math.min(count, MAX_BULK_EXTRACT);

  async function handleClick() {
    const docs = `${batchSize} document${batchSize === 1 ? "" : "s"}`;
    const calls = `${batchSize} paid AI API call${batchSize === 1 ? "" : "s"}`;
    const limits =
      `At most ${MAX_BULK_EXTRACT} run per click, ${BULK_CONCURRENCY} at a time. You can stop part-way.`;
    const message =
      mode === "outdated"
        ? `Re-extract ${docs} now?\n\n` +
          "The existing AI reading of each document is replaced with a new one " +
          "(the old reading is not kept). Verified or hand-corrected documents are " +
          "excluded and are not touched.\n\n" +
          `This makes ${calls}; multi-page PDFs cost more. ${limits}`
        : `Extract ${docs} now?\n\n` +
          `This makes ${calls}; multi-page PDFs cost more. ${limits}`;
    if (!window.confirm(message)) return;

    stopRef.current = false;
    setStopping(false);
    setResult(null);
    setProgress({ done: 0, total: batchSize, succeeded: 0, failed: 0, skipped: 0 });
    setRunning(true);
    try {
      const outcome = await runBulkExtraction({
        ids: missingIds,
        // force: "missing" rows are not-extracted/failed (unusable data), so a forced
        // run is how a failed/"complete but empty" row is retried; "outdated" rows
        // already have data. `expect` makes the server re-check the row is still
        // wanted (still unextracted / still older-format, unverified and
        // uncorrected), so a stale tab cannot double-spend or overwrite anything.
        // discardVerification is deliberately never sent from a bulk run.
        run: (id) => runDocumentExtraction(id, { force: true, expect: mode === "outdated" ? "outdated" : "unextracted" }),
        shouldStop: () => stopRef.current,
        onProgress: setProgress,
      });
      setResult(outcome);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  if (count === 0 && !result && !(mode === "outdated" && needIndividual > 0)) return null;
  const idleLabel =
    mode === "outdated"
      ? count === 0
        ? "No older-format documents to re-extract in bulk"
        : `Re-extract ${count} older-format tax document${count === 1 ? "" : "s"}`
      : count === 0
        ? "Nothing left to extract"
        : `Extract ${count} not-yet-extracted document${count === 1 ? "" : "s"}`;

  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleClick()}
          disabled={running || count === 0}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {idleLabel}
        </button>
        {running && (
          <button
            type="button"
            onClick={() => {
              stopRef.current = true;
              setStopping(true);
            }}
            disabled={stopping}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            {stopping ? "Stopping after current documents..." : "Stop"}
          </button>
        )}
        {count > MAX_BULK_EXTRACT && !running && (
          <span className="text-xs text-muted-foreground">
            {MAX_BULK_EXTRACT} of {count} run per click; click again for the rest.
          </span>
        )}
        {!running && !result && count > 0 && (
          <span className="text-xs text-muted-foreground">
            Never runs automatically. Each document is one AI call.
            {mode === "outdated" ? " Verified and hand-corrected documents are skipped." : ""}
          </span>
        )}
        {mode === "outdated" && needIndividual > 0 && !running && (
          <span className="text-xs text-muted-foreground">
            {needIndividual} older-format document{needIndividual === 1 ? " is" : "s are"} verified or hand-corrected:
            re-extract {needIndividual === 1 ? "it" : "them"} one at a time.
          </span>
        )}
      </div>

      {progress && running && (
        <p role="status" className="text-xs text-muted-foreground">
          {progress.done} of {progress.total} done
          {progress.failed > 0 ? `, ${progress.failed} failed` : ""}
          {progress.skipped > 0 ? `, ${progress.skipped} already up to date` : ""}. Each takes 20-60 seconds.
        </p>
      )}

      {result && !running && (
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p>
            Finished: {result.succeeded} {mode === "outdated" ? "re-extracted" : "extracted"}
            {result.failed > 0 ? `, ${result.failed} failed` : ""}
            {result.skipped > 0 ? `, ${result.skipped} already up to date` : ""}
            {result.stopped > 0 ? `, ${result.stopped} not started (stopped)` : ""}
            {result.remaining > 0 ? `, ${result.remaining} more remain beyond this run's cap` : ""}.
          </p>
          {result.failures.length > 0 && (
            <ul className="list-disc pl-5 text-destructive">
              {result.failures.map((f) => (
                <li key={f.id}>
                  {names[f.id] ?? f.id}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
