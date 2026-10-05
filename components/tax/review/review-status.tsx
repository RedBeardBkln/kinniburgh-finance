import { LinkList } from "@/components/tax/review/finding-links";
import { gateLinks, EMPTY_LINK_CONTEXT, type LinkContext } from "@/lib/tax-review/links";
import { gateItemAnchorId, REVIEW_ANCHORS } from "@/lib/tax-anchors";
import type { ReviewStateDto } from "@/lib/tax-review/state";
import { formatNewYork, gateStateLabel, verdictChip } from "@/lib/tax-review/ui";

// Server components for the top of the Final review page: the status banner and the gate checklist. Plain props (the state DTO
// the server built); nothing here decides anything: the gate is computed by code (lib/tax-review/gate.ts) and the page only shows it.

const TONE: Record<"neutral" | "ok" | "bad" | "warn", string> = {
  neutral: "border-slate-300 bg-slate-50 text-slate-900",
  ok: "border-green-400 bg-green-50 text-green-950",
  bad: "border-red-400 bg-red-50 text-red-950",
  warn: "border-amber-400 bg-amber-50 text-amber-950",
};

export function ReviewStatusBanner({ state }: { state: ReviewStateDto }) {
  const chip = verdictChip(state);
  const run = state.latestRun;
  return (
    <section aria-labelledby="review-status-heading" className="space-y-2 rounded-lg border p-4" data-testid="review-status">
      <h2 id="review-status-heading" className="text-base font-semibold">
        Where this return stands
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${TONE[chip.tone]}`} data-testid="review-verdict">
          {chip.label}
        </span>
        <span className="text-muted-foreground">
          Return fingerprint <code className="rounded bg-muted px-1 font-mono text-xs" data-testid="review-fingerprint">{state.currentFingerprint12}</code>
        </span>
        {run !== null ? (
          <span className="text-muted-foreground" data-testid="review-last-run">
            Last checks: {formatNewYork(run.startedAt)}
            {run.isCurrent ? "" : " (for an earlier state of the return)"}
          </span>
        ) : (
          <span className="text-muted-foreground">No checks have been run yet.</span>
        )}
      </div>
      {state.approval.current ? (
        <p className="rounded-md border border-green-400 bg-green-50 px-3 py-2 text-sm text-green-950" data-testid="review-approved">
          Approved by owner{state.approval.at !== null ? ` on ${formatNewYork(state.approval.at)}` : ""} for this exact state of the return.
        </p>
      ) : state.approval.inForce ? (
        <p className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="review-approval-stale">
          {state.approval.revokedReasons !== undefined
            ? `An approval from ${state.approval.at !== null ? formatNewYork(state.approval.at) : "earlier"} exists, but it no longer counts: ${state.approval.revokedReasons.join("; ")}. The clean copies are locked until you approve again.`
            : `An approval from ${state.approval.at !== null ? formatNewYork(state.approval.at) : "earlier"} exists, but the return has changed since (it was for fingerprint ${state.approval.fingerprint12}). It no longer counts, and the clean copies are locked until you approve the current state.`}
        </p>
      ) : null}
      {state.runIsStale ? (
        <p className="text-sm text-amber-900">The return changed after the last checks. Run the checks again; the findings below are for the earlier state.</p>
      ) : null}
    </section>
  );
}

const ITEM_TONE: Record<"pass" | "fail" | "not_run", string> = {
  pass: "border-green-300 bg-green-50 text-green-950",
  fail: "border-red-300 bg-red-50 text-red-950",
  not_run: "border-slate-300 bg-slate-50 text-slate-900",
};

export function GateChecklist({ state, links = EMPTY_LINK_CONTEXT }: { state: ReviewStateDto; links?: LinkContext }) {
  // for each row that is not green: where to go to fix it (nothing here changes the gate)
  const jumps = gateLinks({ items: state.gate.items, findings: state.findings }, links);
  return (
    <section id={REVIEW_ANCHORS.gate} aria-labelledby="gate-heading" className="anchor-target space-y-3 rounded-lg border p-4" data-testid="review-gate">
      <div>
        <h2 id="gate-heading" className="text-base font-semibold">
          What must be green before you can approve
        </h2>
        <p className="text-sm text-muted-foreground">Every line below is worked out by the app from the checks; nothing can be switched on by hand and there is no way around a red line.</p>
      </div>
      <ol className="space-y-2">
        {state.gate.items.map((item) => (
          <li key={item.id} id={gateItemAnchorId(item.id)} className={`anchor-target rounded-md border px-3 py-2 text-sm ${ITEM_TONE[item.state]}`} data-testid={`gate-item-${item.id}`} data-state={item.state}>
            <span className="font-medium">{item.label}</span>: <span className="font-semibold">{gateStateLabel(item.state)}</span>
            <span className="block text-xs">{item.detail}</span>
            {jumps[item.id] !== undefined ? (
              <div className="mt-1" data-testid={`gate-jump-${item.id}`}>
                <LinkList links={jumps[item.id] ?? []} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {state.notRunNotice !== null ? (
        <p className="rounded-md border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950" data-testid="review-not-run-notice">
          {state.notRunNotice}
        </p>
      ) : null}
    </section>
  );
}
