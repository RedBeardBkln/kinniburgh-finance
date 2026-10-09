import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatShort,
  groupByWeek,
  HORIZONS,
  weekSubtotalText,
  type Horizon,
  type UiLedger,
} from "@/lib/upcoming-ledger-view";
import {
  AmountText,
  Disagreements,
  Disclosures,
  EntityChip,
  EstimateBadge,
  ItemLabel,
  LearnedBlock,
  SummaryStrip,
  TransferNote,
  UPCOMING_FOOTER,
} from "@/components/upcoming/upcoming-parts";

interface UpcomingAgendaProps {
  /** null = the loader failed: show a small notice only. */
  ledger: UiLedger | null;
  bucketSlug: string;
  horizon: Horizon;
  showTransfers: boolean;
}

function agendaHref(bucketSlug: string, horizon: Horizon, showTransfers: boolean): Route {
  return `/forecast?bucket=${bucketSlug}&horizon=${horizon}${showTransfers ? "&transfers=1" : ""}#upcoming` as Route;
}

/** Forecast-page agenda: the same ledger over 30 / 60 / 90 days, grouped by week. Presentational, no hooks. */
export function UpcomingAgenda({ ledger, bucketSlug, horizon, showTransfers }: UpcomingAgendaProps) {
  return (
    <div id="upcoming" className="scroll-mt-20">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span>Upcoming - next {horizon} days</span>
            <nav aria-label="Agenda horizon" className="flex items-center gap-1">
              {HORIZONS.map((n) => (
                <Link
                  key={n}
                  href={agendaHref(bucketSlug, n, showTransfers)}
                  aria-current={n === horizon ? "page" : undefined}
                  className={`rounded-md border px-2.5 py-1 text-xs font-normal ${
                    n === horizon ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
                  }`}
                >
                  {n} days
                </Link>
              ))}
            </nav>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!ledger ? (
            <p className="text-sm text-muted-foreground">Upcoming items are unavailable right now.</p>
          ) : (
            <AgendaBody ledger={ledger} bucketSlug={bucketSlug} horizon={horizon} showTransfers={showTransfers} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AgendaBody({
  ledger,
  bucketSlug,
  horizon,
  showTransfers,
}: {
  ledger: UiLedger;
  bucketSlug: string;
  horizon: Horizon;
  showTransfers: boolean;
}) {
  const weeks = groupByWeek(ledger.items);
  const toggleHref = agendaHref(bucketSlug, horizon, !showTransfers);
  return (
    <>
      <p className="text-xs text-muted-foreground">Through {formatShort(ledger.lastDayIso)}.</p>
      <SummaryStrip ledger={ledger} />

      {weeks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing due in the next {horizon} days.</p>
      ) : (
        <div className="space-y-4">
          {weeks.map((week) => {
            const subtotal = weekSubtotalText(week, !ledger.isAggregate);
            return (
            <div key={week.weekStartIso} className="overflow-x-auto">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-1">
                <h3 className="text-sm font-semibold">{week.label}</h3>
                {subtotal && <span className="text-xs text-muted-foreground">{subtotal}</span>}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Date</th>
                    <th className="py-1.5 pr-3 font-medium">Item</th>
                    <th className="py-1.5 pr-3 font-medium">Source</th>
                    <th className="py-1.5 pr-3 font-medium">Confidence</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
                    <th className="py-1.5 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {week.items.map((item) => (
                    <tr key={item.id} className="border-t align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{item.dateLabel}</td>
                      <td className="py-1.5 pr-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <ItemLabel item={item} />
                          {ledger.isAggregate && <EntityChip item={item} />}
                        </div>
                        {item.accountName && <p className="text-xs text-muted-foreground">{item.accountName}</p>}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-xs text-muted-foreground">{item.sourceLabel}</td>
                      <td className="py-1.5 pr-3">
                        {item.estimate ? (
                          <div className="space-y-0.5">
                            <EstimateBadge item={item} />
                            {item.tierNote && <p className="text-xs text-muted-foreground">{item.tierNote}</p>}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">scheduled</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                        <AmountText item={item} />
                      </td>
                      <td className="py-1.5">
                        <Disagreements item={item} />
                        {item.notes.map((n) => (
                          <p key={n} className="text-xs text-muted-foreground">
                            {n}
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            );
          })}
        </div>
      )}

      <LearnedBlock ledger={ledger} />

      <div className="flex flex-wrap items-center gap-3">
        <TransferNote ledger={ledger} />
        {(ledger.transferSummary.count > 0 || showTransfers) && (
          <Link href={toggleHref} className="text-xs text-primary underline-offset-4 hover:underline">
            {showTransfers ? "Hide envelope transfers" : "Show envelope transfers"}
          </Link>
        )}
      </div>

      <Disclosures ledger={ledger} open />
      <p className="text-xs text-muted-foreground">{UPCOMING_FOOTER}</p>
    </>
  );
}
