import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FactActions } from "@/components/tax/facts/fact-row-actions";
import {
  CHANGE_LABELS,
  POLICY_LABELS,
  POLICY_SHORT_LABELS,
  confirmationWord,
  formatFactDate,
  formatFactValue,
  provenanceLabel,
} from "@/lib/tax-facts/format";
import type { FactGroup, GroupedFacts } from "@/lib/tax-facts/group";
import { FACT_CATEGORY_LABELS } from "@/lib/tax-facts/types";

// Presentational (server) component for /tax/facts: facts by category with provenance and the full version history.
// Read-only: it never writes. Retired facts and resolved open items stay visible in a collapsed group.

function FactCard({ group }: { group: FactGroup }) {
  const f = group.latest;
  const isOpenItem = f.valueKind === "open_item";
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{f.label}</p>
          <p className="break-words text-sm">{formatFactValue(f)}</p>
          <p className="text-xs text-muted-foreground">{provenanceLabel(f)}</p>
          {f.sourceRef && <p className="text-xs text-muted-foreground">Source: {f.sourceRef}</p>}
          {f.category === "decision" && (
            <p className="text-xs text-muted-foreground">
              Recorded copy for recall; the return uses the decision recorded on the Tax Forms page.
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {isOpenItem ? (
            <span className="rounded-full border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs text-purple-900">
              Open item: stays open until you resolve it
            </span>
          ) : (
            <span className="rounded-full border px-2 py-0.5 text-xs" title={POLICY_LABELS[f.carryPolicy]}>
              {POLICY_SHORT_LABELS[f.carryPolicy]}: {POLICY_LABELS[f.carryPolicy].toLowerCase()}
            </span>
          )}
          {!group.retired && (
            <FactActions
              isOpenItem={isOpenItem}
              fact={{
                factKey: f.factKey,
                label: f.label,
                valueKind: f.valueKind,
                valueText: f.valueText,
                valueCents: f.valueCents,
                carryPolicy: f.carryPolicy,
                taxYear: f.taxYear,
              }}
            />
          )}
        </div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">History ({group.history.length} version{group.history.length === 1 ? "" : "s"})</summary>
        <ol className="mt-2 space-y-1.5 border-l pl-3">
          {group.history.map((h) => (
            <li key={h.id}>
              <p>
                <span className="font-medium">v{h.version}</span> {CHANGE_LABELS[h.changeKind]} for TY{h.taxYear}:{" "}
                {formatFactValue(h)}
              </p>
              <p className="text-muted-foreground">
                {POLICY_SHORT_LABELS[h.carryPolicy]}; {confirmationWord(h)} {formatFactDate(h.confirmedAt)}; recorded by {h.setByName} on{" "}
                {formatFactDate(h.setAt)}
                {h.archivedAt ? `; replaced ${formatFactDate(h.archivedAt)}` : "; current"}
              </p>
              {h.reason && <p className="text-muted-foreground">Reason: {h.reason}</p>}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

export function FactsBrowser({ grouped }: { grouped: GroupedFacts }) {
  return (
    <div className="space-y-4">
      {grouped.active.map(({ category, groups }) => (
        <Card key={category} className={category === "open_item" ? "border-purple-200" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {FACT_CATEGORY_LABELS[category]} ({groups.length})
            </CardTitle>
            {category === "open_item" && (
              <p className="text-xs text-muted-foreground">
                Questions still open. They are not facts and are never marked confirmed; they carry into every new year until
                you resolve them.
              </p>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {groups.map((g) => (
                <FactCard key={g.factKey} group={g} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
      {grouped.retired.length > 0 && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground">
            Retired facts and resolved items ({grouped.retired.length})
          </summary>
          <ul className="divide-y border-t">
            {grouped.retired.map((g) => (
              <FactCard key={g.factKey} group={g} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
