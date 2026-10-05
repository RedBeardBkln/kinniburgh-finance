import type { RegisterEntry } from "@/lib/tax-review/llm/register";
import { byImpact } from "@/lib/tax-review/llm/register";

// The judgments register: every decision that used to be left to a third party is a decision for Eric, with a recommended position, the
// alternative, the source and the dollar impact the engine can actually compute ("not quantified" otherwise). Server component, plain
// props. Nothing here decides: it lists what is left to the owner (record decisions on the Forms page, answer questions in the
// Return completeness questionnaire). The wording of an entry marked "AI-worded" came from the AI review and was validated by code
// (no invented dollar figures, sources checked); the status, the topic and the dollar impact never come from the AI.

const STATUS_LABEL: Record<RegisterEntry["status"], string> = { undecided: "Needs your decision", decided: "You decided", noted: "For your information" };
const STATUS_TONE: Record<RegisterEntry["status"], string> = {
  undecided: "border-amber-400 bg-amber-50 text-amber-950",
  decided: "border-green-400 bg-green-50 text-green-950",
  noted: "border-slate-300 bg-slate-50 text-slate-900",
};

function dollars(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

export function RegisterTable({ entries, narrated }: { entries: readonly RegisterEntry[]; narrated: boolean }) {
  const ordered = byImpact(entries);
  const open = entries.filter((e) => e.status === "undecided").length;
  return (
    <section aria-labelledby="register-heading" className="space-y-3 rounded-lg border p-4" data-testid="review-register">
      <div>
        <h2 id="register-heading" className="text-base font-semibold">
          Decisions that are yours
        </h2>
        <p className="text-sm text-muted-foreground">
          {entries.length === 0
            ? "Nothing in this return is waiting on a decision of yours."
            : `${entries.length} item${entries.length === 1 ? "" : "s"} the return leaves to you (${open} still need${open === 1 ? "s" : ""} a decision), largest dollar impact first. Each shows the position the return uses, the alternative, the source and what the engine can say about the dollars. ${
                narrated ? "The wording was written by the AI review and checked by code." : "The wording is the engine's own; run the AI review for a plainer explanation."
              } Record a decision on the Forms page; answer open questions in the Return completeness questions.`}
        </p>
      </div>
      {entries.length > 0 ? (
        <ul className="space-y-2">
          {ordered.map((e) => (
            <li key={e.id} className="space-y-1 rounded-md border p-3 text-sm" data-testid="register-entry" data-entry={e.id}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[e.status]}`}>{STATUS_LABEL[e.status]}</span>
                <span className="font-medium">{e.topic}</span>
                {e.narrated ? <span className="text-[11px] text-muted-foreground">AI-worded, checked by code</span> : null}
              </div>
              <p>
                <span className="font-medium">Position: </span>
                {e.recommendedPosition}
              </p>
              {e.alternative !== null ? (
                <p>
                  <span className="font-medium">Alternative: </span>
                  {e.alternative}
                </p>
              ) : null}
              {e.rationale !== null ? <p className="text-xs text-muted-foreground">{e.rationale}</p> : null}
              <p className="text-xs">
                <span className="font-medium">Dollar impact: </span>
                {e.dollarImpact.amountDollars === null ? "not quantified" : dollars(e.dollarImpact.amountDollars)} <span className="text-muted-foreground">({e.dollarImpact.note})</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Who decides: {e.whoDecides}. Where: {e.where}. Sources:{" "}
                {e.sources.map((s, i) => (
                  <span key={`${s.kind}-${s.id}-${i}`}>
                    {i > 0 ? "; " : ""}
                    <code className="font-mono">{s.id}</code>
                    {s.verified ? "" : " (unverified: confirm yourself)"}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
