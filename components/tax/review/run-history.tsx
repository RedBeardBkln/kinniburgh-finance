"use client";

import { useState } from "react";
import { getReviewRun } from "@/actions/tax-review";
import { FindingsTable } from "@/components/tax/review/findings-table";
import type { FindingDto, RunDto } from "@/lib/tax-review/state";
import { formatNewYork, SEVERITY_LABELS, SEVERITIES } from "@/lib/tax-review/ui";

// Run history: every stored run (date, who, fingerprint, whether it is for the current return, counts) and a read-only view of a past
// run's findings (loaded through the getReviewRun action; nothing can be accepted or reopened from an earlier run).

export function RunHistory({ runs, year }: { runs: RunDto[]; year: 2025 }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; findings: FindingDto[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(id: string) {
    if (busy) return;
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await getReviewRun({ taxYear: year, runId: id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLoaded({ id, findings: res.findings });
      setOpenId(id);
    } catch {
      setError("Something went wrong and that run could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (runs.length === 0) {
    return (
      <section aria-labelledby="history-heading" className="space-y-2 rounded-lg border p-4" data-testid="review-history">
        <h2 id="history-heading" className="text-base font-semibold">
          Earlier runs
        </h2>
        <p className="text-sm text-muted-foreground">None yet.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="history-heading" className="space-y-2 rounded-lg border p-4" data-testid="review-history">
      <h2 id="history-heading" className="text-base font-semibold">
        Earlier runs
      </h2>
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.id} className="rounded-md border" data-testid="history-row">
            <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
              <span className="font-medium">{formatNewYork(r.startedAt)}</span>
              <span className="text-muted-foreground">by {r.startedByName}</span>
              <code className="rounded bg-muted px-1 font-mono text-xs">{r.fingerprint12}</code>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${r.isCurrent ? "border-green-400 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
                {r.isCurrent ? "for the current return" : "for an earlier state"}
              </span>
              {r.counts !== null ? (
                <span className="text-xs text-muted-foreground">{SEVERITIES.filter((s) => (r.counts?.[s] ?? 0) > 0).map((s) => `${r.counts?.[s]} ${SEVERITY_LABELS[s].toLowerCase()}`).join(", ") || "no findings"}</span>
              ) : null}
              <button type="button" className="ml-auto text-xs underline" onClick={() => void toggle(r.id)} disabled={busy} aria-expanded={openId === r.id}>
                {openId === r.id ? "Hide" : "View (read only)"}
              </button>
            </div>
            {openId === r.id && loaded !== null && loaded.id === r.id ? (
              <div className="border-t p-3">
                <FindingsTable findings={loaded.findings} year={year} canDecide={false} whyNotDecide="This is an earlier run." readOnly />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <p aria-live="polite" className={`min-h-[1.25rem] text-sm ${error === null ? "" : "text-red-700"}`}>
        {error}
      </p>
    </section>
  );
}
