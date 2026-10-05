import type { SheetOverridesSummary } from "@/lib/tax2025-sheet";
import { SHEET_ANCHORS } from "@/lib/tax-anchors";

// The overrides panel at the top of the review sheet. A server component: always
// visible AND printed, so a reader of the printout can never miss that a figure is a
// recorded owner override rather than something the engine computed. Plain
// strings only (everything comes from the SheetModel).

function List({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className={`text-xs font-semibold ${tone === "warn" ? "text-red-800" : ""}`}>{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-xs">
        {items.map((i, idx) => (
          <li key={`${idx}-${i.slice(0, 40)}`}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function OverridesPanel({ summary }: { summary: SheetOverridesSummary }) {
  const any =
    summary.lineCount + summary.decisionCount + summary.ackCount > 0 ||
    summary.stale.length + summary.engineChanged.length + summary.orphans.length + summary.anomalies.length + summary.invalid.length > 0;
  if (!any) {
    return (
      <p id={SHEET_ANCHORS.overrides} className="anchor-target text-xs text-muted-foreground" data-testid="overrides-none">
        No overrides are in force. Every figure below is the app&apos;s own computation.
      </p>
    );
  }
  return (
    <section id={SHEET_ANCHORS.overrides} className="anchor-target space-y-3 rounded-md border-2 border-violet-400 bg-violet-50/60 p-3" aria-label="Overrides in force" data-testid="overrides-panel">
      <h3 className="text-sm font-semibold text-violet-950">
        Overrides in force: {summary.lineCount} line figure(s), {summary.decisionCount} decision(s), {summary.ackCount} acknowledgement(s)
      </h3>
      {summary.totalsNotice !== null ? (
        <p className="rounded border border-red-300 bg-red-50 px-2 py-1 text-sm font-medium text-red-900" data-testid="totals-not-recomputed">
          {summary.totalsNotice}
        </p>
      ) : null}
      <List title="Line figures (each replaces what the app computed)" items={summary.lines.map((l) => `${l.lineText} (${l.label}): ${l.note}${l.stale ? " [STALE]" : ""}${l.supplied ? " [supplied: the app had no value]" : ""}`)} />
      <List title="Decisions recorded (the return was recomputed with them)" items={summary.decisions.map((d) => d.note)} />
      <List title="Acknowledged rules (no number changed)" items={summary.acknowledgements.map((a) => a.note)} />
      <List
        title="Lines that depend on an override and were NOT recomputed"
        items={summary.dependents.map((d) => `${d.lineText} (depends on ${d.dependsOn.join(", ")})`)}
      />
      {summary.resolvedByOverride.length > 0 ? (
        <div className="space-y-1" data-testid="resolved-by-override">
          <h4 className="text-xs font-semibold">Resolved by override (no longer counted as blocking, still listed)</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {summary.resolvedByOverride.map((r) => (
              <li key={r.id}>
                {r.message}
                {r.lines.length > 0 ? ` Lines: ${r.lines.map((l) => l.text).join(", ")}.` : ""} {r.notes.join(" ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <List title="STALE: the computed value changed after the override was set (re-confirm or clear)" items={summary.stale.map((s) => s.message)} tone="warn" />
      <List title="The return engine was updated after these were set (their values did not change)" items={summary.engineChanged.map((s) => s.message)} />
      <List title="Not applied" items={[...summary.orphans, ...summary.invalid]} tone="warn" />
      <List title="Check these" items={summary.anomalies} />
    </section>
  );
}
