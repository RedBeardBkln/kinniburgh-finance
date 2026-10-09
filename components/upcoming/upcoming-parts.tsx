import Link from "next/link";
import type { Route } from "next";
import {
  approx,
  formatShort,
  type UiItem,
  type UiLedger,
  type UiTotals,
} from "@/lib/upcoming-ledger-view";

// Presentational pieces shared by the dashboard widget and the Forecast agenda. Plain server components:
// no hooks, no client JS (disclosures use native <details>). Every value arrives as a plain string / number.

export const UPCOMING_FOOTER =
  "From your scheduled bills, budgets and statements. Estimates are marked. Not financial advice.";

export function EstimateBadge({ item }: { item: UiItem }) {
  if (!item.estimate) return null;
  return (
    <span
      className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-amber-700"
      title={item.tierNote ?? undefined}
    >
      estimate
    </span>
  );
}

export function AmountText({ item }: { item: UiItem }) {
  if (item.amountStatus === "unknown") {
    return <span className="text-muted-foreground italic">amount not set</span>;
  }
  if (item.amountStatus !== "known") return <span className="text-muted-foreground">-</span>;
  return (
    <span className={`font-medium tabular-nums ${item.direction === "in" ? "text-green-600" : ""}`}>
      {item.direction === "in" ? "+" : ""}
      {item.amountText}
    </span>
  );
}

export function ItemLabel({ item }: { item: UiItem }) {
  return (
    <Link href={item.href as Route} className="font-medium underline-offset-4 hover:underline">
      {item.label}
    </Link>
  );
}

export function EntityChip({ item }: { item: UiItem }) {
  return (
    <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] whitespace-nowrap text-muted-foreground">
      {item.entityName}
    </span>
  );
}

export function Disagreements({ item }: { item: UiItem }) {
  if (item.disagreements.length === 0) return null;
  return (
    <>
      {item.disagreements.map((text) => (
        <p key={text} className="text-xs text-amber-700">
          {text}
        </p>
      ))}
    </>
  );
}

function TotalsLine({ totals }: { totals: UiTotals }) {
  return (
    <>
      <span>
        <span className="font-semibold tabular-nums">{approx(totals.outflow)}</span> due
      </span>
      {Number(totals.inflow) > 0 && (
        <span>
          <span className="font-semibold tabular-nums text-green-600">{approx(totals.inflow)}</span> expected in
        </span>
      )}
    </>
  );
}

export function SummaryStrip({ ledger }: { ledger: UiLedger }) {
  const { totals, biggest } = ledger;
  const estimatedNote =
    Number(totals.outflowEstimated) > 0 ? `includes ${approx(totals.outflowEstimated)} of estimates` : null;
  return (
    <div className="space-y-1 text-sm" data-testid="upcoming-summary">
      {ledger.isAggregate ? (
        // All-entities view: one line per entity, never a single blended total (personal / business separation).
        <ul className="space-y-1">
          {ledger.entityTotals.map((e) => (
            <li key={e.entityId} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium">{e.entityName}</span>
              <TotalsLine totals={e.totals} />
              {e.totals.unknownAmountCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {e.totals.unknownAmountCount} without an amount
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <TotalsLine totals={totals} />
          {biggest && biggest.amount !== null && (
            <span>
              Biggest: <span className="font-medium">{biggest.label}</span>{" "}
              <span className="tabular-nums">{biggest.amountText}</span>
              {biggest.dateIso ? ` on ${formatShort(biggest.dateIso)}` : ""}
            </span>
          )}
        </div>
      )}
      {!ledger.isAggregate && estimatedNote && <p className="text-xs text-muted-foreground">{estimatedNote}</p>}
      {!ledger.isAggregate && totals.unknownAmountCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {totals.unknownAmountCount} item{totals.unknownAmountCount === 1 ? " has" : "s have"} no amount set
        </p>
      )}
    </div>
  );
}

function MiniRow({ item, showEntity }: { item: UiItem; showEntity: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          {item.dateLabel && <span className="text-xs text-muted-foreground">{item.dateLabel}</span>}
          <ItemLabel item={item} />
          {showEntity && <EntityChip item={item} />}
        </div>
        {item.notes.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
      </div>
      <AmountText item={item} />
    </li>
  );
}

/** The three collapsed lists: day not set, past its due date, possible duplicates. */
export function Disclosures({ ledger, open }: { ledger: UiLedger; open: boolean }) {
  const showEntity = ledger.isAggregate;
  return (
    <div className="space-y-2">
      {ledger.undated.length > 0 && (
        <details open={open} className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Day not set ({ledger.undated.length})</summary>
          <p className="mt-1 text-xs text-muted-foreground">
            These bills have no payment day on file, so they are not placed on a date and are not in the totals.
          </p>
          <ul className="divide-y">
            {ledger.undated.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <ItemLabel item={item} />
                    {showEntity && <EntityChip item={item} />}
                    <EstimateBadge item={item} />
                  </div>
                  {item.notes.map((n) => (
                    <p key={n} className="text-xs text-muted-foreground">
                      {n}
                    </p>
                  ))}
                </div>
                <AmountText item={item} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {ledger.pastDue.length > 0 && (
        <details open={open} className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Past due date, may already be paid ({ledger.pastDue.length})
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            The last statement on file is past its due date. It may already be paid; these are not in the totals.
          </p>
          <ul className="divide-y">
            {ledger.pastDue.map((item) => (
              <MiniRow key={item.id} item={item} showEntity={showEntity} />
            ))}
          </ul>
        </details>
      )}
      {ledger.heldBack.length > 0 && (
        <details open={open} className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Possible duplicates held back ({ledger.heldBack.length})
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            These records look like another bill that is already counted, so they are shown here and not counted.
          </p>
          <ul className="divide-y">
            {ledger.heldBack.map((item) => (
              <MiniRow key={item.id} item={item} showEntity={showEntity} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function LearnedBadge() {
  return (
    <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-sky-700">
      Learned from history
    </span>
  );
}

/**
 * History-learned recurring bills. A block of its own, OUTSIDE every total (the summary strip counts only bills
 * the owner has recorded). Renders nothing when there are none.
 */
export function LearnedBlock({ ledger }: { ledger: UiLedger }) {
  if (ledger.learned.length === 0) return null;
  const count = ledger.learned.length;
  const heading = `Looks recurring, not counted (${count} item${count === 1 ? "" : "s"}${
    !ledger.isAggregate && Number(ledger.learnedTotal) > 0 ? `, ${approx(ledger.learnedTotal)}` : ""
  })`;
  return (
    <section aria-label="Looks recurring, not counted" className="rounded-md border border-sky-200 px-3 py-2" data-testid="learned-block">
      <h3 className="text-sm font-semibold">{heading}</h3>
      <p className="text-xs text-muted-foreground">
        These repeat in your transaction history but are not in your bills or budget. They are not in the totals above.
      </p>
      <ul className="divide-y">
        {ledger.learned.map((item) => (
          <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                {item.dateLabel && <span className="text-xs text-muted-foreground">{item.dateLabel}</span>}
                <ItemLabel item={item} />
                <LearnedBadge />
                {ledger.isAggregate && <EntityChip item={item} />}
              </div>
              {item.tierNote && <p className="text-xs text-muted-foreground">{item.tierNote}</p>}
              {item.notes.map((n) => (
                <p key={n} className="text-xs text-muted-foreground">
                  {n}
                </p>
              ))}
            </div>
            <AmountText item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TransferNote({ ledger }: { ledger: UiLedger }) {
  if (ledger.transferSummary.count === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {ledger.transferSummary.count} envelope transfer{ledger.transferSummary.count === 1 ? "" : "s"},{" "}
      {/* A zero total means every amount is unset: say nothing rather than "~$0.00". */}
      {ledger.transferSummary.total !== "0.00" && <>{approx(ledger.transferSummary.total)}, </>}not counted (they move
      your own money).
    </p>
  );
}
