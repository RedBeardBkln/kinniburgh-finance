// Pure presentation shaping for the "Seasonal bills" card on /forecast: turns the model's results (Decimals, Dates) into
// plain strings and numbers a server component can render and a client leaf can receive. No database, no clock, no
// Next.js. Money is formatted here with the same `usd` helper the model's basis text uses, so text and table agree.
// Wording is observational ("based on your payments"), never advice.

import { Decimal } from "@prisma/client/runtime/library";
import { activeOilPrices } from "@/lib/seasonal-energy-prices";
import { formatCalendarDate } from "@/lib/card-due";
import {
  isoToDate,
  monthYearLabel,
  usd,
  type Confidence,
  type DrawFact,
  type EnergyKind,
  type SiteEnergy,
} from "@/lib/seasonal-energy";

export interface UiMonthRow {
  period: string;
  label: string;
  amount: string;
  range: string;
  budget: string | null;
  source: string;
}

export interface UiPaymentRow {
  key: string;
  date: string;
  amount: string;
  account: string | null;
  /** Muted tag such as "yearly furnace service (not counted as oil)" or the other-entity label. */
  tag: string | null;
}

/** A McCarthy row with a one-click toggle ("Not heating oil" / "Count it again"). */
export interface UiToggleRow {
  txId: string;
  date: string;
  amount: string;
  account: string | null;
  /** Why it is listed (check list), or where it sits (excluded list). */
  notes: string[];
}

export const CHECK_TITLE = "Check these McCarthy charges";
export const PENDING_NOTE = "Pending: the mark carries over when it posts.";
export const EXCLUDED_TITLE = "Left out of the oil history (you marked it not heating oil)";

export interface UiPriceRow {
  id: string;
  effectiveOn: string;
  date: string;
  price: string;
  note: string | null;
}

export interface UiSeasonalLine {
  kind: EnergyKind;
  title: string;
  status: "estimate" | "gated";
  /** "Estimate (low confidence)" or "Using the budget figure". */
  badge: string;
  confidence: Confidence | null;
  /** One sentence above the table, e.g. "About $3,312.10 over the next 12 months (net of solar)". */
  headline: string | null;
  /** Gate reason; set exactly when status is "gated". No number belongs to a gated line. */
  reason: string | null;
  basis: string | null;
  /** The flat figure that stays in use when gated (or sits beside the estimate), e.g. "$172.00 a month". */
  budgetNote: string | null;
  table: UiMonthRow[];
  paymentsTitle: string;
  payments: UiPaymentRow[];
  /** Oil only: counted rows that may not be heating oil. They stay counted until the owner marks them. */
  check: UiToggleRow[];
  /** Oil only: rows the owner marked "not heating oil" (left out of every figure). */
  excluded: UiToggleRow[];
  /** Hand-entered draws and other muted lines under the table. */
  extra: string[];
}

export interface UiOilPrices {
  entityId: string;
  rows: UiPriceRow[];
  corrupt: boolean;
}

export interface UiSeasonalSite {
  entityId: string;
  entityName: string;
  notes: string[];
  lines: UiSeasonalLine[];
  oilPrices: UiOilPrices | null;
}

export function fullDate(iso: string): string {
  const d = isoToDate(iso);
  return `${formatCalendarDate(d)}, ${d.getUTCFullYear()}`;
}

/** The next `n` periods (YYYY-MM) starting with the one containing `now`. */
export function periodsFrom(now: Date, n: number): string[] {
  const idx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return Array.from({ length: n }, (_, i) => {
    const t = idx + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}

function confidenceWord(c: Confidence): string {
  return `${c} confidence`;
}

function drawsLine(draws: readonly DrawFact[], budgetLine: string | null): string[] {
  if (draws.length === 0) return [];
  const total = draws.reduce((a, d) => a.plus(d.amount), new Decimal(0));
  return [
    `Hand-entered draws: ${draws.map((d) => `${fullDate(d.date)} ${usd(d.amount)}`).join("; ")} (${usd(total)} in all${budgetLine ? `, against ${budgetLine}` : ""}). Your entered draws are always used as they are.`,
  ];
}

export function toUiSite(site: SiteEnergy, now: Date, opts: { pricesCorrupt: boolean }): UiSeasonalSite {
  const periods = periodsFrom(now, 12);
  const lines: UiSeasonalLine[] = [];

  if (site.electric) {
    const { result, history, flat, line } = site.electric;
    const title = line.tagName.includes("/") ? line.tagName.slice(line.tagName.lastIndexOf("/") + 1).trim() : line.tagName;
    const payments: UiPaymentRow[] = history.map((m) => ({
      key: m.period,
      date: monthYearLabel(m.period),
      amount: usd(m.net),
      account: null,
      tag: m.payments > 1 ? `${m.payments} payments` : null,
    }));
    const budgetNote = flat ? `${usd(flat)} a month` : null;
    if (result.status === "estimate") {
      const byMonth = new Map(result.months.map((m) => [m.month, m]));
      const table: UiMonthRow[] = periods.map((p) => {
        const m = byMonth.get(Number(p.slice(5, 7)))!;
        return {
          period: p,
          label: monthYearLabel(p),
          amount: usd(m.amount),
          range: `${usd(m.low)} to ${usd(m.high)}`,
          budget: flat ? usd(flat) : null,
          source: m.basis === "own" ? "your payment that month plus the season average" : "season average (no payment seen that month)",
        };
      });
      const twelve = table.reduce((a, _r, i) => a.plus(byMonth.get(Number(periods[i]!.slice(5, 7)))!.amount), new Decimal(0));
      lines.push({
        kind: "electric",
        title,
        status: "estimate",
        badge: `Estimate (${confidenceWord(result.confidence)})`,
        confidence: result.confidence,
        headline: `About ${usd(twelve)} over the next 12 months, in net dollars paid${site.siteNotes.some((n) => /solar/i.test(n)) ? " (net of solar)" : ""}.`,
        reason: null,
        basis: result.basis,
        budgetNote,
        table,
        paymentsTitle: "Payments found, by month",
        payments,
        check: [],
        excluded: [],
        extra: [],
      });
    } else {
      lines.push({
        kind: "electric",
        title,
        status: "gated",
        badge: "Using the budget figure",
        confidence: null,
        headline: null,
        reason: result.reason,
        basis: null,
        budgetNote,
        table: [],
        paymentsTitle: "Payments found, by month",
        payments,
        check: [],
        excluded: [],
        extra: [],
      });
    }
  }

  if (site.oil) {
    const { result, facts, flat, line, draws } = site.oil;
    const title = line.tagName.includes("/") ? line.tagName.slice(line.tagName.lastIndexOf("/") + 1).trim() : line.tagName;
    const toggleRow = (p: (typeof facts.payments)[number], notes: string[]): UiToggleRow => ({
      txId: p.id,
      date: fullDate(p.date),
      amount: usd(p.amount),
      account: p.account,
      notes,
    });
    const check = facts.check.map((p) =>
      toggleRow(p, [
        ...p.checkWhy.map((w) => w.charAt(0).toUpperCase() + w.slice(1)),
        ...(p.fromOtherEntity ? [`Paid on the ${p.fromOtherEntity} card by mistake; read here, nothing changed`] : []),
        ...(p.pending ? [PENDING_NOTE] : []),
      ])
    );
    const excluded = facts.excluded.map((p) => toggleRow(p, [...(p.fromOtherEntity ? [`On the ${p.fromOtherEntity} books`] : []), ...(p.pending ? [PENDING_NOTE] : [])]));
    const checkIds = new Set(facts.check.map((p) => p.id));
    const payments: UiPaymentRow[] = facts.payments
      .filter((p) => !p.excluded && !checkIds.has(p.id))
      .map((p) => ({
      key: p.id,
      date: fullDate(p.date),
      amount: usd(p.amount),
      account: p.account,
      tag: p.service
        ? `${facts.service?.label ?? "service"}: a yearly item, not counted as oil`
        : p.fromOtherEntity
          ? `paid on the ${p.fromOtherEntity} card by mistake; read here, nothing changed`
          : p.pending
            ? "pending: the bank may replace this row when it posts"
            : null,
    }));
    const budgetNote = flat ? `${usd(flat)} a month` : null;
    const extra: string[] = [];
    if (facts.check.length > 0) {
      extra.push(
        `${facts.check.length} McCarthy charge${facts.check.length === 1 ? " is" : "s are"} unconfirmed: tags on McCarthy rows are not reliable, so ${facts.check.length === 1 ? "it is" : "they are"} counted until you mark ${facts.check.length === 1 ? "it" : "them"} not heating oil (see below).`
      );
    }
    extra.push(
      `Last 12 months, as paid: ${usd(facts.trailingAsPaid)} in ${facts.trailingCount} payment${facts.trailingCount === 1 ? "" : "s"}${facts.service ? ` (the ${facts.service.label} left out)` : ""}.`
    );
    if (facts.service) {
      extra.push(
        `Suggestion: the ${facts.service.label} (${usd(facts.service.amount)}, paid ${facts.service.dates.map(fullDate).join(" and ")}) looks like a yearly item. You could record it as an annual item under Recurring expenses below; it is kept out of the monthly oil figure.`
      );
    }
    extra.push(...drawsLine(draws, flat ? `${usd(flat.times(12))} a year in the budget` : null));
    if (result.status === "estimate") {
      const table: UiMonthRow[] = periods.map((p) => ({
        period: p,
        label: monthYearLabel(p),
        amount: usd(result.monthly),
        range: `${usd(result.low)} to ${usd(result.high)}`,
        budget: flat ? usd(flat) : null,
        source: "spread evenly (payments do not show gallons)",
      }));
      extra.push(
        `Each +$0.50 per gallon adds about ${usd(result.sensitivity)} over the last 12 months of use (about ${result.impliedGallons.toFixed(0)} gallons implied by your prices).`
      );
      if (draws.length > 0) {
        const last = draws[draws.length - 1]!.date;
        extra.push(
          site.replaceDraws
            ? "Forecasts use this estimate instead of your hand-entered draws (your opt-in); the draws stay saved."
            : `Forecasts use your hand-entered draws, then this estimate for the months after ${fullDate(last)}.`
        );
      }
      lines.push({
        kind: "oil",
        title,
        status: "estimate",
        badge: `Estimate (${confidenceWord(result.confidence)})`,
        confidence: result.confidence,
        headline: `About ${usd(result.annual)} a year (${usd(result.monthly)} a month) at $${result.price.pricePerGal} a gallon.`,
        reason: null,
        basis: result.basis,
        budgetNote,
        table,
        paymentsTitle: "McCarthy payments, last 12 months",
        payments,
        check,
        excluded,
        extra,
      });
    } else {
      if (draws.length > 0) {
        extra.push(`Nothing is projected after ${fullDate(draws[draws.length - 1]!.date)} (your last entered draw) until the estimate is available.`);
      }
      lines.push({
        kind: "oil",
        title,
        status: "gated",
        badge: "Using the budget figure",
        confidence: null,
        headline: null,
        reason: result.reason,
        basis: null,
        budgetNote,
        table: [],
        paymentsTitle: "McCarthy payments, last 12 months",
        payments,
        check,
        excluded,
        extra,
      });
    }
  }

  if (site.firewood) {
    const { result, facts, flat, line, draws } = site.firewood;
    const title = line.tagName.includes("/") ? line.tagName.slice(line.tagName.lastIndexOf("/") + 1).trim() : line.tagName;
    lines.push({
      kind: "firewood",
      title,
      status: "gated",
      badge: "Using the budget figure",
      confidence: null,
      headline: null,
      reason: result.reason,
      basis: null,
      budgetNote: flat ? `${usd(flat)} a month` : null,
      table: [],
      paymentsTitle: "Firewood purchases found",
      payments: facts.purchases.map((p) => ({ key: p.id, date: fullDate(p.date), amount: usd(p.amount), account: p.account, tag: null })),
      check: [],
      excluded: [],
      extra: drawsLine(draws, flat ? `${usd(flat.times(12))} a year in the budget` : null),
    });
  }

  const oilPrices: UiOilPrices | null = site.oil
    ? {
        entityId: site.entityId,
        corrupt: opts.pricesCorrupt,
        rows: activeOilPrices(site.oil.entries)
          .reverse()
          .map((e) => ({
            id: e.id,
            effectiveOn: e.effectiveOn,
            date: fullDate(e.effectiveOn),
            price: `$${e.pricePerGal}`,
            note: e.note ?? null,
          })),
      }
    : null;

  return { entityId: site.entityId, entityName: site.entityName, notes: site.siteNotes, lines, oilPrices };
}
