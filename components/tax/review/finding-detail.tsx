"use client";

import { LinkList } from "@/components/tax/review/finding-links";
import type { FindingLink } from "@/lib/tax-review/links";
import type { FindingDto } from "@/lib/tax-review/state";
import { formatNewYork, SEVERITY_LABELS } from "@/lib/tax-review/ui";
import { BUTTON_PLAIN, BUTTON_PRIMARY } from "@/components/tax/forms/override-parts";

// One finding in full: what was found, the figures it rests on (evidence), the source it cites, what to do, and who accepted it
// and why. Presentational: the parent owns the dialog and the actions. Plain JSON in.

const SOURCE_LABELS: Record<string, string> = {
  constant: "A constant verified against irs.gov / Connecticut DRS",
  source_pack: "A quoted IRS / Connecticut source",
  form_text: "The printed form",
  spec09: "The tax-year constants specification",
  heuristic: "A rule of thumb, not a rule of law",
  engine: "The app's own computation",
};

export function FindingDetail({
  finding,
  links,
  canDecide,
  whyNotDecide,
  onAccept,
  onReopen,
}: {
  finding: FindingDto;
  /** Where to go to see or fix what this finding is about (lib/tax-review/links.ts findingLinks). */
  links: readonly FindingLink[];
  canDecide: boolean;
  /** Plain reason the Accept / Reopen buttons are not offered (stale checks, not the owner's account). */
  whyNotDecide: string | null;
  onAccept: () => void;
  onReopen: () => void;
}) {
  const unverified = finding.citation.sourceStatus === "unverified";
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm" data-testid="finding-detail" data-finding={finding.key}>
      <p className="font-medium">{finding.message}</p>

      {links.length > 0 ? (
        <div data-testid="finding-links">
          <p className="text-xs font-semibold">Go to it</p>
          <LinkList links={links} />
        </div>
      ) : null}

      {finding.evidence.length > 0 ? (
        <div>
          <p className="text-xs font-semibold">The figures it rests on</p>
          <ul className="mt-1 space-y-0.5 text-xs" data-testid="finding-evidence">
            {finding.evidence.map((e, i) => (
              <li key={`${e.ref}-${i}`}>
                <code className="rounded bg-background px-1 font-mono">{e.ref}</code>
                {e.amount === null ? " (no amount)" : ` = ${e.amount.toLocaleString("en-US")}`} <span className="text-muted-foreground">({e.status})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="text-xs font-semibold">Source</p>
        {finding.citation.sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">No outside source: this comes from the app&apos;s own checks.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs" data-testid="finding-sources">
            {finding.citation.sources.map((s, i) => (
              <li key={`${s.id}-${i}`}>
                {SOURCE_LABELS[s.kind] ?? s.kind}: <code className="font-mono">{s.id}</code>
                {s.quote !== undefined ? <span className="block italic text-muted-foreground">&ldquo;{s.quote}&rdquo;</span> : null}
              </li>
            ))}
          </ul>
        )}
        {unverified ? <p className="mt-1 text-xs font-medium text-amber-900">Unverified: confirm this yourself before relying on it.</p> : null}
      </div>

      <div>
        <p className="text-xs font-semibold">What to do</p>
        <p className="text-xs">{finding.recommendedAction}</p>
      </div>

      {finding.challenge !== undefined && finding.challenge !== null ? (
        <div className="rounded-md border border-slate-300 bg-slate-50 p-2 text-xs" data-testid="finding-challenge">
          <p className="font-medium">A second AI pass questions this finding</p>
          <p className="mt-0.5">{finding.challenge}</p>
          <p className="mt-0.5 text-muted-foreground">This note is only a note: it does not close, accept or change the finding. You decide.</p>
        </div>
      ) : null}

      {finding.layer === "L3" ? <p className="text-xs text-muted-foreground">Raised by the AI review. It can be wrong; check it against your documents and the source before you act or accept.</p> : null}

      {finding.status === "accepted" ? (
        <div className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-950" data-testid="finding-accepted">
          <p className="font-medium">
            Accepted{finding.acceptedBy !== null ? ` by ${finding.acceptedBy}` : ""}
            {finding.acceptedAt !== null ? ` on ${formatNewYork(finding.acceptedAt)}` : ""}
          </p>
          {finding.acceptedReason !== null ? <p className="mt-0.5">Reason: {finding.acceptedReason}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {!finding.acceptable ? (
          <p className="text-xs font-medium text-red-800" data-testid="finding-not-acceptable">
            This one cannot be accepted: it is something the return must get right. Fix the return, then run the checks again.
          </p>
        ) : finding.status === "open" ? (
          <button type="button" className={BUTTON_PRIMARY} onClick={onAccept} disabled={!canDecide} data-testid="finding-accept-button">
            Accept with a reason
          </button>
        ) : (
          <button type="button" className={BUTTON_PLAIN} onClick={onReopen} disabled={!canDecide} data-testid="finding-reopen-button">
            Reopen
          </button>
        )}
        {finding.acceptable && !canDecide && whyNotDecide !== null ? <span className="text-xs text-muted-foreground">{whyNotDecide}</span> : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {SEVERITY_LABELS[finding.severity]} - {finding.layer} - {finding.check}
        </span>
      </div>
    </div>
  );
}
