import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatShort, groupByDate, truncateItems, type UiLedger } from "@/lib/upcoming-ledger-view";
import {
  AmountText,
  Disagreements,
  Disclosures,
  EntityChip,
  EstimateBadge,
  ItemLabel,
  SummaryStrip,
  TransferNote,
  UPCOMING_FOOTER,
} from "@/components/upcoming/upcoming-parts";

const MAX_ROWS = 12;

interface UpcomingWidgetProps {
  /** null = the loader failed: show a small notice and nothing else (the dashboard must not break). */
  ledger: UiLedger | null;
  bucketSlug: string;
}

/** Dashboard "Next 30 days" card. Presentational, no hooks. */
export function UpcomingWidget({ ledger, bucketSlug }: UpcomingWidgetProps) {
  if (!ledger) {
    return <p className="text-xs text-muted-foreground">Upcoming items are unavailable right now.</p>;
  }

  const { shown, hiddenCount } = truncateItems(ledger.items, MAX_ROWS);
  const groups = groupByDate(shown);
  const agendaHref = `/forecast?bucket=${bucketSlug}#upcoming` as Route;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-base">
          <span>
            Next {ledger.days} days{" "}
            <span className="text-sm font-normal text-muted-foreground">through {formatShort(ledger.lastDayIso)}</span>
          </span>
          <Link href={agendaHref} className="text-sm font-normal text-muted-foreground underline-offset-4 hover:underline">
            Full agenda →
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <SummaryStrip ledger={ledger} />

        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing due in the next {ledger.days} days.</p>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => (
              <div key={group.dateIso}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h3>
                <ul className="divide-y">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <ItemLabel item={item} />
                          <span className="text-xs text-muted-foreground">{item.sourceLabel}</span>
                          {ledger.isAggregate && <EntityChip item={item} />}
                          <EstimateBadge item={item} />
                        </div>
                        {item.estimate && item.tierNote && (
                          <p className="text-xs text-muted-foreground">{item.tierNote}</p>
                        )}
                        <Disagreements item={item} />
                      </div>
                      <AmountText item={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {hiddenCount > 0 && (
              <p className="text-xs text-muted-foreground">
                +{hiddenCount} more in the{" "}
                <Link href={agendaHref} className="underline underline-offset-4">
                  agenda
                </Link>
              </p>
            )}
          </div>
        )}

        <TransferNote ledger={ledger} />
        <Disclosures ledger={ledger} open={false} />
        <p className="text-xs text-muted-foreground">{UPCOMING_FOOTER}</p>
      </CardContent>
    </Card>
  );
}
