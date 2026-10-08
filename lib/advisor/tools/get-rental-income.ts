// Tool: get_rental_income. Shaper is PURE and unit-tested; the read is in queries/rental.ts.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { RENTAL_SCAN_CAP, loadRentalBookings, type RentalRow } from "@/lib/advisor/queries/rental";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf, isoDay } from "@/lib/advisor/tools/format";
import { isoDate, optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const MAX_SPAN_DAYS = 1_100;
const MAX_MONTHS = 36;
const DEFAULT_LIMIT = 30;

const schema = z
  .object({ entity: optional(shortText), from: optional(isoDate), to: optional(isoDate), limit: optional(z.number().int().min(1).max(60)) })
  .strict()
  .refine((v) => v.from === undefined || v.to === undefined || v.to >= v.from, { path: ["to"], message: "to before from" })
  .refine((v) => v.from === undefined || v.to === undefined || (new Date(`${v.to}T00:00:00Z`).getTime() - new Date(`${v.from}T00:00:00Z`).getTime()) / 86_400_000 <= MAX_SPAN_DAYS, {
    path: ["to"],
    message: "range too long",
  });
type Input = z.output<typeof schema>;

export interface RentalRange {
  from: string;
  to: string;
}

/** Default range: January 1 to December 31 of the current UTC year. */
export function defaultRentalRange(now: Date): RentalRange {
  const y = now.getUTCFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

export function shapeRental(rows: readonly RentalRow[], range: RentalRange, now: Date, limit: number = DEFAULT_LIMIT): ToolOutput {
  const usd = rows.filter((r) => r.currency === "USD");
  let grossCents = 0;
  let nights = 0;
  let upcomingCents = 0;
  const months = new Map<string, { cents: number; bookings: number }>();
  for (const r of usd) {
    const cents = centsOf(r.grossEarnings) ?? 0;
    grossCents += cents;
    nights += r.nights;
    if (r.payoutDate.getTime() > now.getTime()) upcomingCents += cents;
    const key = (isoDay(r.payoutDate) ?? "").slice(0, 7);
    const m = months.get(key) ?? { cents: 0, bookings: 0 };
    m.cents += cents;
    m.bookings += 1;
    months.set(key, m);
  }
  const byMonth = [...months.entries()]
    .filter(([k]) => k !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_MONTHS)
    .map(([month, m]) => ({ month, gross: dollarsOf(m.cents), bookings: m.bookings }));
  const shown = rows.slice(0, limit).map((r) => ({
    payout_date: isoDay(r.payoutDate),
    check_in: isoDay(r.startDate),
    check_out: isoDay(r.endDate),
    nights: r.nights,
    gross_earnings: dollarsOf(centsOf(r.grossEarnings)),
    currency: safeField(r.currency, 6),
  }));
  const entities = [...new Set(rows.map((r) => safeField(r.entity.name, 80)))].slice(0, 5);
  return {
    data: {
      range,
      entities,
      rows: shown,
      totals: { gross: dollarsOf(grossCents), nights, bookings: usd.length },
      by_month: byMonth,
      upcoming_payouts_total: dollarsOf(upcomingCents),
      notes: [
        "Gross earnings are the platform payout amounts before any fees or expenses; dates are payout dates unless named check_in / check_out.",
        "Totals cover US-dollar bookings only." + (usd.length !== rows.length ? ` ${rows.length - usd.length} booking(s) in another currency are listed but not totaled.` : ""),
        ...(rows.length >= RENTAL_SCAN_CAP ? ["The range has more bookings than the tool scans; narrow the dates for exact totals."] : []),
        ...(rows.length > limit ? [`Showing the first ${limit} of ${rows.length} bookings by payout date; the totals cover all of them.`] : []),
      ],
    },
    rows: shown.length,
    total: rows.length,
    links: [links.forecast()],
  };
}

export const getRentalIncomeTool = defineTool<Input>({
  name: "get_rental_income",
  description:
    "Rental (Airbnb) payouts: per booking the payout date, check-in and check-out, nights and gross earnings, plus totals, a month-by-month summary and the total of payouts still to come. Renter names, listing titles and confirmation codes are not available. entity (name or slug), from and to are optional; the default range is the current calendar year, and a range may span at most about three years. limit is 1 to 60 bookings, default 30; totals always cover the whole range.",
  inputJsonSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Optional. Entity name or slug to restrict to." },
      from: { type: "string", description: "Optional. Start date YYYY-MM-DD (payout date), inclusive. Default January 1 of this year." },
      to: { type: "string", description: "Optional. End date YYYY-MM-DD, inclusive. Default December 31 of this year." },
      limit: { type: "integer", description: "Optional. Bookings to list, 1 to 60. Default 30." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up rental income",
  summarizeArgs: (i) => `entity=${i.entity === undefined ? "all" : "set"}, ${i.from ?? "year start"}..${i.to ?? "year end"}, limit ${i.limit ?? DEFAULT_LIMIT}`,
  run: async (ctx, i) => {
    const def = defaultRentalRange(ctx.now);
    const range = { from: i.from ?? def.from, to: i.to ?? def.to };
    const rows = await loadRentalBookings({
      ...(i.entity !== undefined ? { entity: i.entity } : {}),
      from: new Date(`${range.from}T00:00:00.000Z`),
      to: new Date(`${range.to}T23:59:59.999Z`),
    });
    return shapeRental(rows, range, ctx.now, i.limit ?? DEFAULT_LIMIT);
  },
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
