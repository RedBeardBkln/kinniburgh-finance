import Link from "next/link";
import type { Route } from "next";
import { statusLabel } from "@/lib/tax-questionnaire";
import type { CpaSummaryBlock, CpaSummaryData } from "@/lib/tax-questionnaire-build";

// Read-only, printable summary of every questionnaire for a tax year. Free text
// (the note) is rendered as escaped text with whitespace preserved - never as HTML.
// Facts reported by the owner for the CPA - not tax advice, no form is decided here.

const DATE_ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium" });
const DATE_TIME_ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "medium",
  timeStyle: "short",
});

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE_TIME_ET.format(d);
}

function Block({ block, names }: { block: CpaSummaryBlock; names: Record<string, string> }) {
  const s = block.summary;
  return (
    <section className="break-inside-avoid space-y-2 rounded-lg border p-4 print:rounded-none print:border-0 print:border-t print:px-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{block.title}</h3>
          <p className="text-xs text-muted-foreground">{block.formName}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{statusLabel(s.status)}</span>
          <Link href={block.href as Route} className="text-xs text-primary hover:underline print:hidden">
            Open questionnaire
          </Link>
        </div>
      </div>

      {s.outcomeText && <p className="text-sm">{s.outcomeText}</p>}
      {block.stale && (
        <p className="text-xs text-amber-800">These questions changed since the answers were saved - review them.</p>
      )}

      {s.facts.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            Facts reported by owner
          </h4>
          <ul className="mt-1 space-y-1.5">
            {s.facts.map((f) => (
              <li key={f.nodeId} className="text-sm">
                <span className="text-muted-foreground">{f.prompt}</span>{" "}
                <span className={f.unsure ? "font-medium text-amber-800" : "font-medium"}>{f.answerLabel}</span>
                <span className="block text-xs text-muted-foreground">
                  {f.source === "planning" && !f.by
                    ? `Answered on the Planning screen${f.answeredAt ? ` ${when(f.answeredAt)}` : ""}`
                    : `${f.sourceNote ? "Accepted" : "Answered"}${f.by && names[f.by] ? ` by ${names[f.by]}` : ""}${f.answeredAt ? ` on ${when(f.answeredAt)}` : ""}`}
                  {f.sourceNote ? ` - ${f.sourceNote}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.openQuestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            Open questions for the CPA
          </h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
            {s.openQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {block.planningLinks.some((l) => l.answer !== null) && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            Related Planning answers
          </h4>
          <ul className="mt-1 space-y-0.5 text-sm">
            {block.planningLinks
              .filter((l) => l.answer !== null)
              .map((l) => (
                <li key={l.key}>
                  <span className="text-muted-foreground">{l.label}:</span>{" "}
                  <span className="whitespace-pre-wrap">{l.answer}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {s.note && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">Note for the CPA</h4>
          <p className="mt-1 whitespace-pre-wrap text-sm">{s.note}</p>
          {block.noteMeta && (
            <p className="text-xs text-muted-foreground">
              {block.noteMeta.byName ? `${block.noteMeta.byName}, ` : ""}
              {when(block.noteMeta.at)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function CpaSummaryView({ data }: { data: CpaSummaryData }) {
  const { counts } = data;
  const all = [...data.household, ...data.entities.flatMap((g) => g.blocks)];
  const notStarted = all.filter((b) => b.summary.status.kind === "not_started");
  const started = (blocks: CpaSummaryBlock[]) => blocks.filter((b) => b.summary.status.kind !== "not_started");
  const householdStarted = started(data.household);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">CPA summary - {data.year}</h1>
        <p className="text-sm text-muted-foreground">
          {data.householdLabel} household - as of {DATE_ET.format(new Date())}
        </p>
        <p className="text-sm">
          Questionnaires: {counts.answered} answered, {counts.inProgress} in progress, {counts.notStarted} not started.
        </p>
        <p className="text-xs text-muted-foreground">
          Facts reported by the owner for the CPA to review - not tax advice. The CPA decides whether a form is
          required.
        </p>
      </header>

      {householdStarted.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Household</h2>
          {householdStarted.map((b) => (
            <Block key={b.key} block={b} names={data.userNames} />
          ))}
        </section>
      )}

      {data.entities.map((g) => {
        const blocks = started(g.blocks);
        if (blocks.length === 0) return null;
        return (
          <section key={g.entityId} className="space-y-3">
            <h2 className="text-lg font-semibold">{g.entityName}</h2>
            {blocks.map((b) => (
              <Block key={b.key} block={b} names={data.userNames} />
            ))}
          </section>
        );
      })}

      {notStarted.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold">Not started</h2>
          <ul className="list-disc pl-5 text-sm">
            {notStarted.map((b) => (
              <li key={b.key}>
                {b.title}
                {b.entityName ? ` - ${b.entityName}` : ""} ({b.formName})
              </li>
            ))}
          </ul>
        </section>
      )}

      {all.length === 0 && <p className="text-sm text-muted-foreground">No questionnaires exist for {data.year}.</p>}
    </div>
  );
}
