// The one-page weekly check-in sheet (server component, no client JavaScript): the numbers come from
// lib/personal-reports.ts (buildWeeklyReport), the "coming up" rows from the page's read of the Upcoming ledger.
// A past month is drawn in the same format as the whole month (report.complete); it has no "coming up" box.
import { firstWeekdayOf, type WeeklyReport } from "@/lib/personal-reports";
import { Panel, Stat } from "@/components/reports/report-parts";
import { BudgetRing, CategoryBullets, MonthCalendar, OVER, SplitBar, WeekBars, whole } from "@/components/reports/report-charts";

export interface ComingUp {
  key: string;
  day: string;
  label: string;
  cents: number | null;
  estimate: boolean;
}

export function WeeklySheet({
  report: r,
  printedOn,
  period,
  comingUp,
}: {
  report: WeeklyReport;
  printedOn: string;
  period: string;
  /** null = the read failed; undefined = a past month (the box is left out). */
  comingUp?: { rows: ComingUp[]; totalCents: number; more: number } | null;
}) {
  const past = r.complete;
  const over = r.leftCents < 0;
  const aheadOfPace = r.usedPct !== null && r.usedPct > r.elapsedPct;
  return (
    <article
      id="print-report"
      className="mx-auto space-y-2.5 rounded-lg border bg-white p-5 text-[#1f1f1d] shadow-sm"
      style={{ maxWidth: "8.5in", colorScheme: "light" }}
    >
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[#d6d5d0] pb-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6b6a66]">Personal · Weekly check-in</p>
          <h2 className="text-xl font-bold leading-tight">
            {r.periodLabel}: {past ? "how the month ended" : "where we stand"}
          </h2>
        </div>
        <p className="text-right text-[11px] text-[#6b6a66]">
          {past ? `Whole month · printed ${printedOn}` : `As of ${printedOn}`}
          <br />
          {past ? `All ${r.daysInMonth} days` : `Day ${r.dayOfMonth} of ${r.daysInMonth} · ${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"} left`}
        </p>
      </header>

      {/* Row 1: the headline */}
      <section className="avoid-break grid grid-cols-1 items-center gap-3 sm:grid-cols-[auto_1fr_auto] print:grid-cols-[auto_1fr_auto]">
        <div className="flex justify-center">
          <BudgetRing usedPct={r.usedPct} elapsedPct={r.elapsedPct} size={118} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat label={past ? "Spent" : "Spent so far"} value={whole(r.spentCents)} sub={`of ${whole(r.budgetCents)} budgeted`} />
          <Stat
            label={over ? "Over budget by" : past ? "Left unspent" : "Left in budget"}
            value={whole(Math.abs(r.leftCents))}
            sub={r.perDayLeftCents !== null ? `about ${whole(r.perDayLeftCents)} a day for ${r.daysLeft} days` : over ? "past the month's budget" : past ? "at the end of the month" : "last day of the month"}
            alert={over}
          />
          <Stat
            label="Pace"
            value={r.usedPct === null ? "—" : `${r.usedPct}% vs ${r.elapsedPct}%`}
            sub={r.usedPct === null ? "nothing budgeted" : aheadOfPace ? "budget used is ahead of the month gone" : "budget used is behind the month gone"}
            alert={aheadOfPace}
          />
          <Stat
            label="At this pace"
            value={r.projectedCents !== null ? whole(r.projectedCents) : "—"}
            sub={r.projectedCents !== null ? "by month end (straight line)" : past ? "month complete" : "shown from a quarter of the month on"}
            alert={r.projectedCents !== null && r.projectedCents > r.budgetCents}
          />
        </div>
        <div className="flex flex-col items-center gap-1">
          <MonthCalendar dayOfMonth={r.dayOfMonth} daysInMonth={r.daysInMonth} firstWeekday={firstWeekdayOf(period)} />
          <p className="text-[10px] text-[#6b6a66]">{past ? "Month complete" : `${r.elapsedPct}% of the month gone (black tick on the ring)`}</p>
        </div>
      </section>

      {/* Row 2: weeks + last seven days */}
      <section className="avoid-break grid grid-cols-1 gap-3 sm:grid-cols-[3fr_2fr] print:grid-cols-[3fr_2fr]">
        <Panel title="Spending by week" note="Dashed line: the week's even share of the monthly budget.">
          <WeekBars weeks={r.weeks} budgetCents={r.budgetCents} daysInMonth={r.daysInMonth} />
        </Panel>
        <div className="space-y-3">
          <Panel title={`${past ? "Last 7 days of the month" : "Last 7 days"} (${r.lastSeven.fromDay} to ${r.lastSeven.toDay})`}>
            <p className="text-2xl font-bold leading-none">{whole(r.lastSeven.spentCents)}</p>
            <p className="text-[11px] text-[#6b6a66]">
              {r.lastSeven.count} purchase{r.lastSeven.count === 1 ? "" : "s"}
              {r.pendingCount > 0 && ` · ${r.pendingCount} pending in the month (counted)`}
            </p>
          </Panel>
          <Panel title="Fixed vs variable" note={r.splitFromHistory ? undefined : "Recent months could not be read: everything is counted as variable."}>
            {r.fixed && r.variable ? (
              <SplitBar fixedCents={r.fixed.actualCents} variableCents={r.variable.actualCents} />
            ) : (
              <p className="text-[11px] text-[#6b6a66]">Unavailable.</p>
            )}
          </Panel>
        </div>
      </section>

      {/* Row 3: every category */}
      <Panel
        title="Categories against budget"
        note={`Bar: spent as a share of the category's budget (scale to 150%). Black tick: ${past ? "100% (the full budget)" : `${r.elapsedPct}% (an even pace today)`}. ${r.overspentCount} of ${r.lineCount} lines over budget.`}
      >
        {r.categories.length > 0 ? (
          <CategoryBullets bars={r.categories} elapsedPct={r.elapsedPct} />
        ) : (
          <p className="text-[11px] text-[#6b6a66]">No budget lines this month.</p>
        )}
      </Panel>

      {/* Row 4: lists */}
      <section
        className={
          comingUp === undefined
            ? "avoid-break grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2"
            : "avoid-break grid grid-cols-1 gap-3 sm:grid-cols-3 print:grid-cols-3"
        }
      >
        <Panel title="Worth a look">
          {r.watch.length > 0 ? (
            <ul className="space-y-1">
              {r.watch.map((w) => (
                <li key={w.key} className="text-[11px] leading-snug">
                  <span className="font-semibold">{w.name}:</span> {w.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-[#6b6a66]">
              {past ? "No variable line ended over budget or well above its usual month." : "No variable line is over budget or on pace to pass it."}
            </p>
          )}
        </Panel>
        <Panel title={past ? "Biggest purchases, last 7 days of the month" : "Biggest purchases, last 7 days"}>
          {r.biggest.length > 0 ? (
            <ul className="space-y-1">
              {r.biggest.map((b) => (
                <li key={b.id} className="flex justify-between gap-2 text-[11px] leading-snug">
                  <span className="min-w-0 truncate">
                    <span className="text-[#6b6a66]">{b.day}</span> {b.payee}
                    <span className="text-[#6b6a66]"> · {b.category}</span>
                    {b.pending && <span className="text-[#6b6a66]"> (pending)</span>}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{whole(b.cents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-[#6b6a66]">No purchases in {past ? "the month's last 7 days" : "the last 7 days"}.</p>
          )}
        </Panel>
        {comingUp !== undefined && (
        <Panel title="Coming up, next 7 days">
          {comingUp === null ? (
            <p className="text-[11px] text-[#6b6a66]">Upcoming bills are unavailable right now.</p>
          ) : comingUp.rows.length === 0 ? (
            <p className="text-[11px] text-[#6b6a66]">No scheduled bills or card payments.</p>
          ) : (
            <>
              <ul className="space-y-1">
                {comingUp.rows.map((c) => (
                  <li key={c.key} className="flex justify-between gap-2 text-[11px] leading-snug">
                    <span className="min-w-0 truncate">
                      <span className="text-[#6b6a66]">{c.day}</span> {c.label}
                      {c.estimate && <span className="text-[#6b6a66]"> (estimate)</span>}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{c.cents === null ? "amount not set" : whole(c.cents)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 border-t border-[#d6d5d0] pt-1 text-[11px]">
                <span className="font-semibold">{whole(comingUp.totalCents)}</span> scheduled
                {comingUp.more > 0 && <span className="text-[#6b6a66]"> ({comingUp.more} more not listed)</span>}
              </p>
            </>
          )}
        </Panel>
        )}
      </section>

      <footer className="border-t border-[#d6d5d0] pt-2 text-[9px] leading-snug text-[#6b6a66]">
        Spent = money out on Personal accounts in the month minus refunds (transfers between our own accounts, card payments
        and loan-account mirrors are not counted), the same figure as the dashboard. Income deposits in the month:{" "}
        {whole(r.incomeCents)}. Observations from our own records, not financial advice.
        {!r.reconciles && (
          <span style={{ color: OVER }}> The weekly bars do not add up to Spent; check the dashboard before relying on them.</span>
        )}
      </footer>
    </article>
  );
}
