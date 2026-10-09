// Tool: get_forecast. The builder is PURE (over the same lib/forecast.ts generators the Forecast page uses) and unit-tested; the rows come
// from queries/forecast.ts. Personal checking accounts with a minimum balance only; the business-bucket forecast is not covered.
// Card payments are the same as on the Forecast page: every card is paid in full, so each is a whole statement balance, taken from the
// account that really pays the card (inferred from past payments, lib/card-next-statement.ts); a statement found paid is left out; the
// next statements are estimates labelled as such; a card whose paying account is not determined is assigned to no account.

import { Decimal } from "@prisma/client/runtime/library";
import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadForecastInputs, type ForecastInputs } from "@/lib/advisor/queries/forecast";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf, isoDay, isoDateTime } from "@/lib/advisor/tools/format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import { cardPaymentEvents } from "@/lib/card-next-statement";
import { buildAccountForecast, findBreachDays, generateIncomeOccurrences, generateTransferOccurrences, type ScheduleEvent } from "@/lib/forecast";
import { generateBillOccurrencesBudgetDated } from "@/lib/bill-dates";

export const MIN_FORECAST_DAYS = 7;
export const MAX_FORECAST_DAYS = 90;
export const DEFAULT_FORECAST_DAYS = 30;
const MAX_EVENTS = 60;
const MAX_ACCOUNTS = 10;
const FIRST_BREACHES = 5;

const schema = z.object({ account: optional(shortText), days: optional(z.number().int().min(1).max(365)) }).strict();
type Input = z.output<typeof schema>;

export function clampForecastDays(days: number | undefined): number {
  return Math.min(MAX_FORECAST_DAYS, Math.max(MIN_FORECAST_DAYS, days ?? DEFAULT_FORECAST_DAYS));
}

const DAY_MS = 86_400_000;

export function buildForecastView(inputs: ForecastInputs, now: Date, days: number, accountFilter?: string): ToolOutput {
  const horizon = clampForecastDays(days);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + horizon * DAY_MS);
  const wanted = accountFilter?.trim().toLowerCase();
  const chosen = inputs.accounts.filter((a) => wanted === undefined || a.nickname.toLowerCase() === wanted).slice(0, MAX_ACCOUNTS);

  if (chosen.length === 0) {
    return {
      data: {
        accounts: [],
        hint:
          inputs.accounts.length === 0
            ? "No checking account with a minimum balance is set up, so there is nothing to project."
            : `No projected account matches that name. Accounts that are projected: ${inputs.accounts.map((a) => safeField(a.nickname, 60)).join(", ")}.`,
      },
      rows: 0,
      links: [links.forecast()],
    };
  }

  const nameById = new Map(inputs.accounts.map((a) => [a.id, a.nickname]));
  const allEvents: { event: ScheduleEvent; account: string }[] = [];
  const accounts = chosen.map((acct) => {
    const transferEvents = inputs.transfers.flatMap((t) => generateTransferOccurrences(t, start, end)).filter((e) => e.accountId === acct.id);
    // Paychecks are take-home; a source whose take-home is unknown is projected with its gross and marked in the description.
    const incomeEvents = inputs.incomes
      .flatMap((s) =>
        generateIncomeOccurrences(s, start, end).map((e) =>
          s.amountBasis === "gross_unknown" ? { ...e, description: `${e.description} (gross, take-home unknown)` } : e,
        ),
      )
      .filter((e) => e.accountId === acct.id);
    // Bills are dated by their Budget row (month by month) when it has a usable date, else by the bill record.
    const budgetIndex = inputs.budgetIndex ?? new Map();
    const billEvents = inputs.bills
      .flatMap((b) =>
        generateBillOccurrencesBudgetDated(b, budgetIndex, start, end, (b.accrualEnvelope?.draws ?? []).map((d) => ({ estimatedDate: d.estimatedDate, estimatedAmount: d.estimatedAmount }))),
      )
      .filter((e) => e.accountId === acct.id);
    // The cards THIS account pays (inferred), of any entity; a card of another entity is labelled with its entity.
    const cardEvents = inputs.cardProjections
      .filter((p) => p.funding?.accountId === acct.id)
      .flatMap((p) => {
        const otherEntity = acct.entityId !== undefined && p.entityId !== acct.entityId ? (inputs.entityNameById[p.entityId] ?? "another entity") : null;
        return cardPaymentEvents(p, start, end).map((e) =>
          otherEntity === null ? e : { ...e, description: e.description.replace(" statement payment", ` (${otherEntity} card) statement payment`) },
        );
      });
    const events = [...transferEvents, ...incomeEvents, ...billEvents, ...cardEvents];
    const startBalance = acct.currentBalance !== null ? new Decimal(acct.currentBalance.toString()) : new Decimal(0);
    const minBalance = acct.minimumBalance !== null ? new Decimal(acct.minimumBalance.toString()) : null;
    const days = buildAccountForecast(startBalance, events, minBalance, start, end);
    const breaches = findBreachDays(days);

    let low = days[0];
    for (const d of days) if (low === undefined || d.balanceAfter.lessThan(low.balanceAfter)) low = d;
    for (const ev of events) allEvents.push({ event: ev, account: acct.nickname });

    return {
      account: safeField(acct.nickname, 60),
      last4: acct.mask !== null && /^\d{4}$/.test(acct.mask) ? acct.mask : null,
      current_balance: acct.currentBalance === null ? null : dollarsOf(centsOf(acct.currentBalance)),
      balance_known: acct.currentBalance !== null,
      as_of: isoDateTime(acct.currentBalanceAt),
      minimum_balance: minBalance === null ? null : dollarsOf(centsOf(minBalance)),
      projected_minimum_balance: low === undefined ? null : dollarsOf(centsOf(low.balanceAfter)),
      projected_minimum_date: low === undefined ? null : isoDay(low.date),
      ending_balance: days.length === 0 ? null : dollarsOf(centsOf(days[days.length - 1]!.balanceAfter)),
      breach_days: breaches.length,
      first_breach_days: breaches.slice(0, FIRST_BREACHES).map((b) => ({ date: isoDay(b.date), balance: dollarsOf(centsOf(b.balanceAfter)) })),
    };
  });

  const sorted = allEvents
    .filter((e) => !e.event.amount.isZero())
    .sort((a, b) => a.event.date.getTime() - b.event.date.getTime() || a.account.localeCompare(b.account) || a.event.description.localeCompare(b.event.description));
  const shown = sorted.slice(0, MAX_EVENTS).map(({ event, account }) => ({
    date: isoDay(event.date),
    description: safeField(event.description, 80),
    amount: dollarsOf(centsOf(event.amount)),
    type: event.type,
    account: safeField(nameById.get(event.accountId) ?? account, 60),
    ...(event.description.endsWith("(estimate)") ? { estimate: true } : {}),
  }));
  // Cards that exist but whose paying account could not be determined (never assigned to an account), by nickname only.
  const grossUnknownPaychecks = inputs.incomes.filter((s) => s.amountBasis === "gross_unknown").length;
  const unassigned = inputs.cardProjections.filter((p) => !p.funding && (p.onFile?.paid === null || p.estimates.length > 0)).map((p) => safeField(p.nickname, 60));

  return {
    data: {
      horizon_days: horizon,
      from: isoDay(start),
      to: isoDay(new Date(end.getTime() - DAY_MS)),
      accounts,
      events: shown,
      ...(sorted.length > shown.length ? { events_truncated: true, event_count: sorted.length } : {}),
      ...(unassigned.length > 0 ? { cards_without_paying_account: unassigned } : {}),
      notes: [
        "A projection from scheduled transfers, income sources, bills and credit card statement payments only; actual spending is not predicted. It starts from the last known balance, which may be a day or more old. Transfers appear as an outflow on one account and an inflow on the other.",
        "Only the household's personal checking accounts with a minimum balance are projected. The business-account forecast is not covered here; see the Forecast page.",
        "Paychecks are take-home pay (the median of recent deposits or the latest confirmed paystub), not the gross amount; an income source whose take-home is unknown uses its gross and its events are marked '(gross, take-home unknown)'. Bills are dated by their budget line when it has a date, because the money has to be in the account then; the bank may clear a bill a few days later.",
        ...(grossUnknownPaychecks > 0 ? [`${grossUnknownPaychecks} income source(s) use the gross amount because take-home is unknown, so the projection may be too high.`] : []),
        "Every card is paid in full, so a card payment is the whole statement balance, drawn from the account that paid that card in the past. A statement already found paid is left out. Statements not issued yet are estimates (marked estimate: true, with '(estimate)' in the description), based on this cycle's charges or a typical month; they can change.",
        ...(inputs.cardProjectionsFailed ? ["Credit card payments could not be loaded just now, so they are missing from this projection."] : []),
        ...(unassigned.length > 0 ? ["Cards listed under cards_without_paying_account are not in any account projection because past payments do not clearly show which account pays them."] : []),
      ],
    },
    rows: accounts.length,
    links: [links.forecast()],
  };
}

export const getForecastTool = defineTool<Input>({
  name: "get_forecast",
  description:
    "Projected balances for the household's personal checking accounts that have a minimum balance, over the next 7 to 90 days (default 30), built from scheduled transfers, paychecks, bills and credit card statement payments. Returns per account the current balance, the lowest projected balance and its date, the ending balance, the number of days below the minimum balance with the first few of them, and the dated list of scheduled events. account (a nickname) is optional. Business accounts are not covered.",
  inputJsonSchema: {
    type: "object",
    properties: {
      account: { type: "string", description: "Optional. Account nickname, for example Primary Checking." },
      days: { type: "integer", description: "Optional. Days to project, 7 to 90. Default 30." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Projecting balances",
  summarizeArgs: (i) => `days=${clampForecastDays(i.days)}, account=${i.account === undefined ? "all" : "set"}`,
  run: async (ctx, i) => buildForecastView(await loadForecastInputs(ctx.now), ctx.now, clampForecastDays(i.days), i.account),
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
