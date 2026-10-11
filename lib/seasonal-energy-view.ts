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
  siteFactsFor,
  usd,
  type Confidence,
  type DrawFact,
  type EnergyKind,
  type SiteEnergy,
} from "@/lib/seasonal-energy";
import { seasonOfIso, type UsageInfo, type UsageRow, type UsageStatus } from "@/lib/seasonal-energy-usage";

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

/** What the uploaded usage did for a line, as one muted sentence under the badge. */
export interface UiUsageNote {
  text: string;
  used: boolean;
}

export interface UiUsageRow {
  id: string;
  /** "Mar 2024" (electric) or a full delivery / purchase date. */
  date: string;
  quantity: string;
  cost: string | null;
  note: string | null;
}

export interface UiUsageYear {
  year: number;
  /** Twelve cells, January first: the month's total quantity in the history's unit, or null when nothing is on file. */
  cells: Array<string | null>;
  total: string;
  rows: UiUsageRow[];
}

export interface UiUsageHistory {
  kind: EnergyKind;
  title: string;
  /** "kWh", "gallons" or "cords" (as entered). */
  unit: string;
  count: number;
  years: UiUsageYear[];
}

export interface UiSeasonalLine {
  kind: EnergyKind;
  /** Set when uploaded usage rows exist for this line. */
  usage?: UiUsageNote | null;
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
  /** Whether the usage table could be read; anything but "ok" hides the usage block and says so. */
  usageStatus: UsageStatus;
  /** The kinds this site has a line for (what the upload form offers). */
  usageKinds: Array<{ kind: EnergyKind; title: string }>;
  /** True for a house with solar (owner statement): the upload help then explains net kWh. */
  usageHasSolar: boolean;
  usageHistory: UiUsageHistory[];
}

/** Quantity with up to 3 decimals (trailing zeros dropped) and thousands separators. */
export function fmtQty(q: Decimal): string {
  let s = q.toDecimalPlaces(3).toFixed(3);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  const neg = s.startsWith("-");
  const [whole = "0", frac] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

function unitWord(row: Pick<UsageRow, "kind" | "unit">, qty: Decimal): string {
  if (row.kind === "electric") return "kWh";
  if (row.kind === "oil") return "gal";
  return row.unit === "face_cord" ? "face cord" : "cord" + (qty.equals(1) ? "" : "s");
}

const KIND_UNIT: Record<EnergyKind, string> = { electric: "kWh", oil: "gallons", firewood: "cords" };

function usageNote(u: UsageInfo | null | undefined, kind: EnergyKind, fallbackInUse: string): UiUsageNote | null {
  if (!u || u.count === 0) return null;
  const span = u.from && u.to ? ` (${monthYearLabel(u.from)} to ${monthYearLabel(u.to)})` : "";
  const what =
    kind === "electric"
      ? `${u.count} month${u.count === 1 ? "" : "s"} of kWh`
      : kind === "oil"
        ? `${u.count} oil deliver${u.count === 1 ? "y" : "ies"}`
        : `${u.count} firewood purchase${u.count === 1 ? "" : "s"}`;
  const ignored = u.ignored > 0 ? ` ${u.ignored} row${u.ignored === 1 ? " is" : "s are"} from before solar went live: kept, not used.` : "";
  const text = u.used
    ? `${what} on file${span}: used for the monthly shape.${ignored}`
    : `${what} on file${span}: not used yet. ${u.why ?? ""} ${fallbackInUse}${ignored}`.replace(/\s+/g, " ").trim();
  return { text, used: u.used };
}

function usageHistoryOf(rows: readonly UsageRow[], kind: EnergyKind, title: string): UiUsageHistory | null {
  const mine = rows.filter((r) => r.kind === kind);
  if (mine.length === 0) return null;
  const years = [...new Set(mine.map((r) => Number(r.period.slice(0, 4))))].sort((a, b) => b - a);
  return {
    kind,
    title,
    unit: KIND_UNIT[kind],
    count: mine.length,
    years: years.map((year) => {
      const inYear = mine
        .filter((r) => Number(r.period.slice(0, 4)) === year)
        .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
      const cells = Array.from({ length: 12 }, (_, m) => {
        const inMonth = inYear.filter((r) => Number(r.period.slice(5, 7)) === m + 1);
        return inMonth.length === 0 ? null : fmtQty(inMonth.reduce((a, r) => a.plus(r.quantity), new Decimal(0)));
      });
      return {
        year,
        cells,
        total: fmtQty(inYear.reduce((a, r) => a.plus(r.quantity), new Decimal(0))),
        rows: inYear.map((r) => ({
          id: r.id,
          date: kind === "electric" ? monthYearLabel(r.period) : fullDate(r.occurredOn),
          quantity: `${fmtQty(r.quantity)} ${unitWord(r, r.quantity)}`,
          cost: r.cost === null ? null : usd(r.cost),
          note: r.note,
        })),
      };
    }),
  };
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

export function toUiSite(site: SiteEnergy, now: Date, opts: { pricesCorrupt: boolean; usageStatus?: UsageStatus }): UiSeasonalSite {
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
          source:
            m.basis === "usage"
              ? `your kWh history (${m.ownObservations} year${m.ownObservations === 1 ? "" : "s"})`
              : m.basis === "own"
                ? "your payment that month plus the season average"
                : "season average (no payment seen that month)",
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
        usage: usageNote(site.electric.usage, "electric", "The estimate from your payments is used."),
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
        usage: usageNote(site.electric.usage, "electric", "The budget figure stays in use."),
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
      const byUsage = result.method === "usage" && result.byMonth !== undefined;
      const table: UiMonthRow[] = periods.map((p) => {
        const mi = Number(p.slice(5, 7)) - 1;
        const range = byUsage ? result.byMonthRange?.[mi] : undefined;
        return {
          period: p,
          label: monthYearLabel(p),
          amount: usd(byUsage ? (result.byMonth as Decimal[])[mi]! : result.monthly),
          range: range ? `${usd(range.low)} to ${usd(range.high)}` : `${usd(result.low)} to ${usd(result.high)}`,
          budget: flat ? usd(flat) : null,
          source: byUsage ? "your oil deliveries, spread over neighbouring months" : "spread evenly (payments do not show gallons)",
        };
      });
      extra.push(
        byUsage
          ? `Each +$0.50 per gallon adds about ${usd(result.sensitivity)} over a year of use (about ${result.impliedGallons.toFixed(0)} gallons a year from your delivery history).`
          : `Each +$0.50 per gallon adds about ${usd(result.sensitivity)} over the last 12 months of use (about ${result.impliedGallons.toFixed(0)} gallons implied by your prices).`
      );
      if (result.priceSource === "delivery") {
        extra.push("The price per gallon comes from your newest delivery that had an amount, not today's price; enter today's price above to use it instead.");
      }
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
        headline: `About ${usd(result.annual)} a year (${usd(result.monthly)} a month${byUsage ? " on average" : ""}) at $${result.price.pricePerGal} a gallon${result.priceSource === "delivery" ? " (from a past delivery)" : ""}.`,
        reason: null,
        basis: result.basis,
        budgetNote,
        table,
        paymentsTitle: "McCarthy payments, last 12 months",
        payments,
        check,
        excluded,
        extra,
        usage: usageNote(site.oil.usage, "oil", "The estimate from your payments is used."),
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
        usage: usageNote(site.oil.usage, "oil", "The budget figure stays in use."),
      });
    }
  }

  if (site.firewood) {
    const { result, facts, flat, line, draws } = site.firewood;
    const title = line.tagName.includes("/") ? line.tagName.slice(line.tagName.lastIndexOf("/") + 1).trim() : line.tagName;
    const covered = (iso: string): boolean => {
      if (result.status !== "estimate") return false;
      const s = seasonOfIso(iso);
      return s >= result.firstSeason && s <= result.lastSeason;
    };
    const woodPayments: UiPaymentRow[] = facts.purchases.map((p) => ({
      key: p.id,
      date: fullDate(p.date),
      amount: usd(p.amount),
      account: p.account,
      tag: covered(p.date) ? "covered by your uploaded history (not counted twice)" : null,
    }));
    const woodBudget = flat ? `${usd(flat)} a month` : null;
    const woodExtra = drawsLine(draws, flat ? `${usd(flat.times(12))} a year in the budget` : null);
    if (result.status === "estimate") {
      const table: UiMonthRow[] = periods.map((p) => {
        const mi = Number(p.slice(5, 7)) - 1;
        const range = result.byMonthRange[mi]!;
        return {
          period: p,
          label: monthYearLabel(p),
          amount: usd(result.byMonth[mi]!),
          range: `${usd(range.low)} to ${usd(range.high)}`,
          budget: flat ? usd(flat) : null,
          source: "your firewood purchases, spread over neighbouring months",
        };
      });
      if (draws.length > 0) {
        const lastDraw = draws[draws.length - 1]!.date;
        woodExtra.push(
          site.replaceDraws
            ? "Forecasts use this estimate instead of your hand-entered draws (your opt-in); the draws stay saved."
            : `Forecasts use your hand-entered draws, then this estimate for the months after ${fullDate(lastDraw)}.`
        );
      }
      lines.push({
        kind: "firewood",
        title,
        status: "estimate",
        badge: `Estimate (${confidenceWord(result.confidence)})`,
        confidence: result.confidence,
        headline: `About ${usd(result.annual)} a year (${usd(result.monthly)} a month on average), from your firewood purchases.`,
        reason: null,
        basis: result.basis,
        budgetNote: woodBudget,
        table,
        paymentsTitle: "Firewood purchases found",
        payments: woodPayments,
        check: [],
        excluded: [],
        extra: woodExtra,
        usage: usageNote(site.firewood.usage, "firewood", ""),
      });
    } else {
      lines.push({
        kind: "firewood",
        title,
        status: "gated",
        badge: "Using the budget figure",
        confidence: null,
        headline: null,
        reason: result.reason,
        basis: null,
        budgetNote: woodBudget,
        table: [],
        paymentsTitle: "Firewood purchases found",
        payments: woodPayments,
        check: [],
        excluded: [],
        extra: woodExtra,
        usage: usageNote(site.firewood.usage, "firewood", "The budget figure stays in use."),
      });
    }
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

  const usageKinds = lines.map((l) => ({ kind: l.kind, title: l.title }));
  const usageHistory = lines.flatMap((l) => {
    const h = usageHistoryOf(site.usageRows ?? [], l.kind, l.title);
    return h ? [h] : [];
  });
  return {
    entityId: site.entityId,
    entityName: site.entityName,
    notes: site.siteNotes,
    lines,
    oilPrices,
    usageStatus: opts.usageStatus ?? "ok",
    usageKinds,
    usageHasSolar: siteFactsFor(site.slug)?.solarLiveFrom != null,
    usageHistory,
  };
}
