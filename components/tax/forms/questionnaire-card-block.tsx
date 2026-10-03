import Link from "next/link";
import type { Route } from "next";
import { questionnaireHref, statusLabel, type QuestionnaireCardState } from "@/lib/tax-questionnaire";

// The questionnaire strip inside a "Needs CPA input" card: status, the
// owner-reported outcome sentence, and a plain link (works without JS). It never
// changes the card's badge, reason, applicability or readiness.

const CHIP: Record<QuestionnaireCardState["status"]["kind"], string> = {
  not_started: "border-border bg-muted text-muted-foreground",
  in_progress: "border-amber-300 bg-amber-50 text-amber-800",
  answered: "border-green-300 bg-green-50 text-green-700",
};

export function QuestionnaireCardBlock({ state, taxYear }: { state: QuestionnaireCardState; taxYear: number }) {
  const href = questionnaireHref(taxYear, { id: state.questionnaireId, scope: state.scope }, state.entityId);
  const action =
    state.status.kind === "not_started"
      ? "Start questionnaire"
      : state.status.kind === "in_progress"
        ? "Continue questionnaire"
        : "Review answers";

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3" data-testid="questionnaire-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">Questionnaire</span>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP[state.status.kind]}`}
          >
            {statusLabel(state.status)}
          </span>
          {state.status.kind === "answered" && state.status.unsureCount > 0 && (
            <span className="text-xs text-muted-foreground">{state.status.unsureCount} marked Not sure</span>
          )}
        </div>
        <Link
          href={href as Route}
          className="inline-flex min-h-11 items-center rounded-md border border-primary/40 px-3 text-sm font-medium text-primary hover:bg-primary/10"
        >
          {action}
        </Link>
      </div>
      {state.ownerLine && <p className="mt-2 text-sm">{state.ownerLine}</p>}
      {state.outcomeText && <p className="mt-0.5 text-xs text-muted-foreground">{state.outcomeText}</p>}
      {state.stale && (
        <p className="mt-1 text-xs text-amber-800">
          These questions changed since the answers were saved - review them.
        </p>
      )}
    </div>
  );
}
