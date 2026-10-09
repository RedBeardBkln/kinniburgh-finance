import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RECURRING_FOOTER, RECURRING_UNAVAILABLE, type UiDetection, type UiFlag, type UiSuggestion } from "@/lib/upcoming-ledger-view";
import { SuggestionActions } from "@/components/upcoming/suggestion-actions";

// "Looks recurring" review list (Forecast page). Presentational server
// components; the only client code is the buttons leaf. Wording is observational: patterns, not bills.

function EntityTag({ name }: { name: string }) {
  return (
    <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] whitespace-nowrap text-muted-foreground">
      {name}
    </span>
  );
}

function SuggestionRow({
  s,
  showEntity,
  mode,
}: {
  s: UiSuggestion;
  showEntity: boolean;
  mode: "suggest" | "restore" | "none";
}) {
  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.payee}</span>
        {showEntity && <EntityTag name={s.entityName} />}
        <span className="rounded-full border px-2 py-0.5 text-[10px] whitespace-nowrap text-muted-foreground">
          {s.confidenceLabel}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{s.summary}</p>
      <p className="text-xs text-muted-foreground">{s.why}</p>
      {s.nextLabel && <p className="text-xs text-muted-foreground">{s.nextLabel}</p>}
      {mode !== "none" && (
        <SuggestionActions entityId={s.entityId} seriesKey={s.key} mode={mode} canAdd={s.canAdd} />
      )}
    </li>
  );
}

function FlagLine({ f, showEntity }: { f: UiFlag; showEntity: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
      <span className="text-amber-700">{f.text}</span>
      {showEntity && <EntityTag name={f.entityName} />}
    </li>
  );
}

interface RecurringSuggestionsProps {
  /** undefined = the page has nothing to say (the ledger itself failed); null = detection failed. */
  detection: UiDetection | null | undefined;
  /** The all-entities views show an entity chip on every row. */
  isAggregate: boolean;
}

/** Forecast-page section (anchor `#looks-recurring`). */
export function RecurringSuggestions({ detection, isAggregate }: RecurringSuggestionsProps) {
  if (detection === undefined) return null;
  return (
    <div id="looks-recurring" className="scroll-mt-20">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Looks recurring</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {detection === null ? (
            <p className="text-sm text-muted-foreground">{RECURRING_UNAVAILABLE}</p>
          ) : (
            <DetectionBody detection={detection} isAggregate={isAggregate} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DetectionBody({ detection, isAggregate }: { detection: UiDetection; isAggregate: boolean }) {
  const { suggestions, deposits, dismissed, flags, suppressedCount } = detection;
  const empty = suggestions.length === 0 && flags.length === 0 && deposits.length === 0 && dismissed.length === 0;
  return (
    <>
      {empty && <p className="text-sm text-muted-foreground">No new recurring patterns found in your recent transactions.</p>}

      {suggestions.length > 0 && (
        <section aria-label="Looks recurring, not in your budget">
          <h3 className="text-sm font-semibold">Looks recurring, not in your budget</h3>
          <ul className="divide-y">
            {suggestions.map((s) => (
              <SuggestionRow key={s.key} s={s} showEntity={isAggregate} mode="suggest" />
            ))}
          </ul>
        </section>
      )}

      {flags.length > 0 && (
        <section aria-label="Heads up">
          <h3 className="text-sm font-semibold">Heads up</h3>
          <ul className="divide-y">
            {flags.map((f) => (
              <FlagLine key={`${f.type}|${f.entityId}|${f.text}`} f={f} showEntity={isAggregate} />
            ))}
          </ul>
        </section>
      )}

      {deposits.length > 0 && (
        <section aria-label="Regular deposits">
          <h3 className="text-sm font-semibold">Regular deposits</h3>
          <p className="text-xs text-muted-foreground">For review only. Deposits are never placed on the calendar.</p>
          <ul className="divide-y">
            {deposits.map((s) => (
              <SuggestionRow key={s.key} s={s} showEntity={isAggregate} mode="none" />
            ))}
          </ul>
        </section>
      )}

      {dismissed.length > 0 && (
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Dismissed ({dismissed.length})</summary>
          <ul className="divide-y">
            {dismissed.map((s) => (
              <SuggestionRow key={s.key} s={s} showEntity={isAggregate} mode="restore" />
            ))}
          </ul>
        </details>
      )}

      {suppressedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {suppressedCount} more look{suppressedCount === 1 ? "s" : ""} already recorded, so {suppressedCount === 1 ? "it is" : "they are"} not listed.
        </p>
      )}
      <p className="text-xs text-muted-foreground">{RECURRING_FOOTER}</p>
    </>
  );
}
