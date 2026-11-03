// The two-page month-end summary sheet (server component, no client JavaScript): every budget line of the month,
// budgeted against spent, from lib/personal-reports.ts (buildMonthlyReport). Page 1 has the headline numbers and the
// Primary Checking lines over two columns; page 2 the other accounts, the money outside any line and the total.
import { splitColumns, splitPages, splitRows, type MonthlyReport, type MonthlyRow, type MonthlySection } from "@/lib/personal-reports";
import { Stat } from "@/components/reports/report-parts";
import { OVER, UsedMeter, whole } from "@/components/reports/report-charts";
import { TableScroll } from "@/components/ui/table-scroll";

export function MonthlySheet({ report: r, printedOn }: { report: MonthlyReport; printedOn: string }) {
  const over = r.remainingCents < 0;
  const { first, rest } = splitPages(r.sections);
  const [firstLeft, firstRight] = first ? splitRows(first.rows) : [[], []];
  const [left, right] = splitColumns(rest, r.outside.length > 0 ? r.outside.length + 2 : 0);
  const hasPageTwo = rest.length > 0 || r.outside.length > 0;
  return (
    <article
      id="print-report"
      className="mx-auto space-y-3 rounded-lg border bg-white p-5 text-[#1f1f1d] shadow-sm"
      style={{ maxWidth: "8.5in", colorScheme: "light" }}
    >
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[#d6d5d0] pb-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6b6a66]">Personal · Month-end summary</p>
          <h2 className="text-xl font-bold leading-tight">
            {r.periodLabel}: expenses against budget{r.partial && " (month in progress)"}
          </h2>
        </div>
        <p className="text-right text-[11px] text-[#6b6a66]">Printed {printedOn}</p>
      </header>

      <section className="avoid-break grid grid-cols-2 gap-2 sm:grid-cols-4 print:grid-cols-4">
        <Stat label="Budgeted" value={whole(r.budgetCents)} sub={`${r.lineCount} budget lines`} />
        <Stat label="Spent" value={whole(r.spentCents)} sub={r.usedPct === null ? "nothing budgeted" : `${r.usedPct}% of the budget`} alert={over} />
        <Stat label={over ? "Over budget by" : "Under budget by"} value={whole(Math.abs(r.remainingCents))} sub={over ? "spent more than budgeted" : "left unspent"} alert={over} />
        <Stat label="Lines over budget" value={`${r.overspentCount}`} sub={`${r.underCount} lines at or under budget`} alert={r.overspentCount > 0} />
      </section>

      {r.topOver.length > 0 && (
        <p className="text-[11px] leading-snug">
          <span className="font-bold">Biggest overruns: </span>
          {r.topOver.map((t, i) => (
            <span key={t.key}>
              {i > 0 && " · "}
              {t.label} <span style={{ color: OVER }}>+{whole(t.overCents)}</span>
              <span className="text-[#6b6a66]">
                {" "}
                ({whole(t.spentCents)} of {whole(t.budgetCents)})
              </span>
            </span>
          ))}
        </p>
      )}

      {first && (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2">
          <SectionTable section={{ ...first, rows: firstLeft }} subtotal={firstRight.length === 0} />
          {firstRight.length > 0 && <SectionTable section={{ ...first, title: `${first.title} (continued)`, rows: firstRight }} />}
        </section>
      )}

      {hasPageTwo && (
        <div className="space-y-3 border-t border-dashed border-[#d6d5d0] pt-3 print:break-before-page print:border-0 print:pt-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6b6a66]">
            Personal · {r.periodLabel} · other accounts
          </p>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2">
            <div className="space-y-2">
              {left.map((s) => (
                <SectionTable key={s.key} section={s} />
              ))}
            </div>
            <div className="space-y-2">
              {right.map((s) => (
                <SectionTable key={s.key} section={s} />
              ))}
              {r.outside.length > 0 && (
                <SectionTable
                  section={{ key: "outside", title: "Not in any budget line", budgetCents: 0, spentCents: r.outsideCents, rows: r.outside }}
                  noBudget
                />
              )}
            </div>
          </section>
        </div>
      )}

      <section className="avoid-break border-t-2 border-[#1f1f1d] pt-1.5">
        <div className="flex flex-wrap justify-between gap-x-4 text-[12px] font-bold tabular-nums">
          <span>Total</span>
          <span>
            Budgeted {whole(r.budgetCents)} · Spent {whole(r.spentCents)} ·{" "}
            <span style={over ? { color: OVER } : undefined}>
              {over ? "Over" : "Left"} {whole(Math.abs(r.remainingCents))}
            </span>
          </span>
        </div>
      </section>

      <footer className="text-[9px] leading-snug text-[#6b6a66]">
        Spent = money out on Personal accounts in the month ({whole(r.outflowCents)})
        {r.refundCount > 0 && ` minus ${r.refundCount} refund${r.refundCount === 1 ? "" : "s"} (${whole(r.refundsCents)})`}; transfers between our own accounts, card payments and
        loan-account mirrors are not counted. A parent line&apos;s spent includes the lines nested under it. Income deposits
        in the month: {whole(r.incomeCents)} (not part of Spent).
        {r.pendingCount > 0 && ` ${r.pendingCount} pending transaction${r.pendingCount === 1 ? " is" : "s are"} included.`}
        {!r.reconciles && <span style={{ color: OVER }}> The categories do not add up to Spent; check the dashboard before relying on this page.</span>}
      </footer>
    </article>
  );
}

function SectionTable({ section, noBudget = false, subtotal = true }: { section: MonthlySection; noBudget?: boolean; subtotal?: boolean }) {
  return (
    <TableScroll className="avoid-break">
      <table className="w-full border-collapse text-[10px] leading-tight tabular-nums">
        <thead>
          <tr className="border-b border-[#1f1f1d] text-left">
            <th className="py-0.5 pr-1 font-bold">{section.title}</th>
            <th className="w-[52px] py-0.5 text-right font-semibold text-[#6b6a66]">{noBudget ? "" : "Budget"}</th>
            <th className="w-[52px] py-0.5 text-right font-semibold text-[#6b6a66]">Spent</th>
            <th className="w-[52px] py-0.5 text-right font-semibold text-[#6b6a66]">{noBudget ? "" : "Left"}</th>
            <th className="w-[46px] py-0.5" aria-label="Share used" />
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
          {!noBudget && subtotal && (
            <tr className="border-t border-[#d6d5d0] font-semibold">
              <td className="py-0.5 pr-1">Subtotal</td>
              <td className="py-0.5 text-right">{whole(section.budgetCents)}</td>
              <td className="py-0.5 text-right">{whole(section.spentCents)}</td>
              <td className="py-0.5 text-right" style={section.spentCents > section.budgetCents ? { color: OVER } : undefined}>
                {whole(section.budgetCents - section.spentCents)}
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </TableScroll>
  );
}

function Row({ row }: { row: MonthlyRow }) {
  const left = row.remainingCents;
  return (
    <tr className="border-b border-[#eeede9]">
      <td className="py-[2px] pr-1" style={{ paddingLeft: `${row.depth * 10}px` }}>
        <span className={row.parent ? "font-semibold" : undefined}>{row.label}</span>
        {row.over && (
          <span className="ml-1 font-bold" style={{ color: OVER }}>
            over
          </span>
        )}
      </td>
      <td className="py-[2px] text-right">{row.budgetCents === null ? "" : whole(row.budgetCents)}</td>
      <td className="py-[2px] text-right">{whole(row.spentCents)}</td>
      <td className="py-[2px] text-right" style={left !== null && left < 0 ? { color: OVER } : undefined}>
        {left === null ? "" : whole(left)}
      </td>
      <td className="py-[2px] pl-1.5">
        <UsedMeter usedPct={row.usedPct} over={left !== null && left < 0} />
      </td>
    </tr>
  );
}
