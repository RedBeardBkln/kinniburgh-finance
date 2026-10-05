"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runReviewChecks } from "@/actions/tax-review";
import { BUTTON_PRIMARY } from "@/components/tax/forms/override-parts";
import { REVIEW_ANCHORS } from "@/lib/tax-anchors";

// "Run checks": runs every deterministic check for the CURRENT return on the server (footing, forms read back from the PDFs, source
// documents, process state, the final package) and stores the run. Busy-state locking like the override dialog: the button is
// disabled while the request is in flight, the result is announced in a live region, and the page is refreshed on success so the
// gate, the findings and the history show the new run. The server computes everything; this component sends only the year.

export function RunControls({ year, hasRun, runIsStale }: { year: 2025; hasRun: boolean; runIsStale: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const resultId = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await runReviewChecks({ taxYear: year });
      if (!res.ok) {
        setResult({ ok: false, text: res.error });
        return;
      }
      setResult({
        ok: true,
        text: res.reused ? "These checks were just run for this exact state of the return; showing them." : `Checks finished: ${res.findingCount} finding${res.findingCount === 1 ? "" : "s"} recorded.`,
      });
      startTransition(() => router.refresh());
    } catch {
      setResult({ ok: false, text: "Something went wrong and the checks were not saved. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id={REVIEW_ANCHORS.runChecks} aria-labelledby="run-heading" className="anchor-target space-y-2 rounded-lg border p-4" data-testid="review-run-controls">
      <div>
        <h2 id="run-heading" className="text-base font-semibold">
          Run the checks
        </h2>
        <p className="text-sm text-muted-foreground">
          Builds the forms for the return as it is now, reads them back and checks them against the return and your documents. It changes nothing in the return, and it can take up to a minute.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BUTTON_PRIMARY} onClick={() => void run()} disabled={busy} aria-busy={busy} aria-describedby={resultId} data-testid="run-checks-button">
          {busy ? "Checking..." : hasRun ? (runIsStale ? "Run the checks again (the return changed)" : "Run the checks again") : "Run the checks"}
        </button>
        {busy ? <span className="h-2 w-40 animate-pulse rounded-full bg-primary/40" role="presentation" /> : null}
      </div>
      <p id={resultId} aria-live="polite" className={`min-h-[1.25rem] text-sm ${result === null ? "" : result.ok ? "text-green-800" : "text-red-700"}`} data-testid="run-checks-result">
        {busy ? "Running the checks. Keep this page open." : result?.text}
      </p>
    </section>
  );
}
