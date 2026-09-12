# Plan: Multi-horizon forecast view

## Restated goal

Extend `/forecast` (currently a daily/schedule-based account-balance projection
with a 30/60/90-day range picker) with a Daily/Weekly/Monthly/Quarterly
*granularity* selector that rolls the same underlying day-by-day balance
forecast up into coarser summary buckets, and add a new, separate "Category
Spend Pace" section (Personal bucket only) that surfaces
`projectPeriodEndSpend()`'s per-tag month-end projections so the household can
see which budget categories are pacing over/under, without adding any new
forecasting math to the two existing reviewed primitives.

## Scope

**In scope:**
- New pure rollup module `lib/forecast-rollup.ts` that groups an existing
  `DayForecast[]` into weekly/monthly/quarterly buckets (daily = passthrough).
- Extending `app/forecast/page.tsx` to compute rollups for each TD account and
  to fetch/compute per-tag spend-pace data for the Personal bucket only.
- Extending `components/forecast/forecast-account-card.tsx` with a
  Daily/Weekly/Monthly/Quarterly granularity toggle (in addition to, not
  replacing, the existing 30/60/90-day range toggle).
- A small, additive, backward-compatible prop change to
  `components/forecast/balance-chart.tsx` (optional subtitle override).
- A new presentational component `components/forecast/spend-pace-section.tsx`.
- Unit tests for the new pure rollup module.

**Out of scope (explicitly, per task):**
- Any change to the public API/signatures of `lib/forecast.ts` or
  `lib/spend-forecast.ts`.
- Business-entity quarterly P&L or estimated-tax-payment forecasting (Tier 1
  item 3 — separate task).
- Spend-pace data for business buckets (Sudden Valley / EK Consulting /
  Mezzo) — Personal only, see Design decision 2 below.
- Prisma schema changes.
- New npm/pnpm dependencies (recharts, which the chart already uses, is
  already a dependency — no new charting library needed).
- Any new `actions/*.ts` server action (see Design decision 4 — this page's
  read path has never used one and won't start now).
- Changing the existing 30/60/90-day range toggle's *daily* behavior — it is
  preserved pixel-for-pixel when granularity = Daily.

## Design decisions (resolved, not left to the Coder)

### 1. What "daily/weekly/monthly/quarterly" means for the account-balance side

**Decision: it changes display *granularity/grouping* of the existing 90-day
`DayForecast[]`, not the forecast's date range.** The existing 90-day window
computed in `page.tsx` (`forecastStart` → `forecastEnd90`) is unchanged.

Concretely, each `ForecastAccountCard` gets a **second, independent** toggle
row, added below the existing 30/60/90-day range row:

`Daily | Weekly | Monthly | Quarterly` (default: `Daily`).

- **Daily** (default): behaves exactly as today. The existing 30/60/90-day
  range row is shown and fully functional; `chartData90` is sliced to `days`
  as it is now. No behavior change in this mode.
- **Weekly / Monthly / Quarterly**: the 30/60/90-day range row is **hidden**
  (a day-count range doesn't compose meaningfully with a coarser bucket size),
  and the card renders the *entire* 90-day forecast rolled up into buckets of
  that granularity (server-computed — see below). At 90 days this yields
  roughly 13 weekly buckets, 3-4 monthly buckets, and 1-2 quarterly buckets.
  This is an accepted consequence of not extending the date range (see Risks).

Rollup buckets are computed **server-side in `page.tsx`** (money/date math
stays in Decimal/Date land, never crosses into client components as raw
`Decimal`/`Date` — matching how `chartData90` is already built server-side
and handed to the client as plain `{label, balance, isBreachDay}` objects).
The client component (`ForecastAccountCard`) never does date math; it only
picks which of four pre-computed arrays to render, mirroring its existing
30/60/90 pattern of slicing a pre-computed array in local `useState`.

Two different bucket-alignment strategies are used deliberately:
- **Weekly** buckets are *relative*, anchored to the forecast's first day
  (`forecast[0].date`, i.e. "today"): bucket 1 = days 0-6, bucket 2 = days
  7-13, etc. This avoids picking an arbitrary Mon-Sun vs Sun-Sat convention
  and is trivially testable.
- **Monthly** and **quarterly** buckets are *calendar-aligned* (UTC month /
  calendar quarter of the date), matching the rest of the codebase's
  `"YYYY-MM"` period convention (budgets, `spend-forecast.ts`). The first
  and/or last bucket may be partial (doesn't span the full calendar month or
  quarter) because the 90-day window doesn't start on a period boundary —
  each bucket carries an `isPartial` flag for this so the UI can label it.

Each bucket reports **both** an `endingBalance` (the balance as of the last
day in the bucket — the literal "end of week 1: $X" the task describes) and a
`minBalance`/`hasBreach`/`firstBreachDate` (the worst balance and whether any
day within the bucket breached the minimum). This distinction matters: a
mid-bucket dip below minimum balance would otherwise be invisible if the UI
only showed the ending balance. See Test 3 in the plan below for a concrete
case where this distinction is load-bearing.

### 2. Where spend-pace fits, which tags, and what "quarterly" means for it

**Decision: spend-pace is a separate, always-visible section, independent of
the account-balance granularity toggle, and does not have its own
daily/weekly/quarterly variants — it is monthly-only, full stop.**

Justification: `projectPeriodEndSpend()` is fundamentally a
within-one-in-progress-month projection (`period: "YYYY-MM"`,
`daysElapsed`/`daysInPeriod` are month-scoped). A "weekly" or "daily" spend
pace has no different meaning than the monthly one (the projection doesn't
change moment-to-moment in a way that's useful to re-bucket by day/week — the
signal is "how does this month look"). A "quarterly" spend-pace *could* be
built by summing three months of budgets/actuals (two of which would need
either real historical actuals for already-elapsed months of the quarter, or
would themselves need `projectPeriodEndSpend` run against future months that
haven't started) — but that's meaningfully new logic layered on top of the
existing reviewed primitive, not just a display rollup, and risks
under-tested edge cases (e.g. a quarter that just started has 2 unstarted
months). Building that is exactly the kind of scope growth this task's
instructions warn against ("don't invent requirements the user didn't ask
for"). **Recommendation for a future task** (not built here): a
`sumQuarterlyPace()` helper in `lib/spend-forecast.ts` or a new small pure
module, once there's a concrete need — flagged under Risks/unknowns.

So: the account-balance granularity toggle (Daily/Weekly/Monthly/Quarterly)
affects *only* the balance charts. The new "Category Spend Pace" section
always shows the *current calendar month's* pace for every tag, regardless of
which balance granularity is selected. This is visually and conceptually a
second, independent feature on the same page — acceptable per the task's own
framing ("this page or a clearly-linked new section").

**Which tags:** every tag with an active `Budget` row for the Personal
entity in the current period (`YYYY-MM` for "today") **and**
`effectiveBudget > 0` (mirrors `evaluateBudgetPace`'s own zero/negative-budget
guard in `lib/budget-pace.ts` — no meaningful "pace" against a $0 budget).
Unlike `checkBudgetPace` (which suppresses low-confidence/near-threshold
signals to avoid notification noise), this is a *view*, so it shows **every**
qualifying tag, not just the ones that would fire a notification — the whole
point of a page is full visibility. Rows are sorted by projected % of budget
descending (highest pacing risk first) — this sort order is a presentational
choice, not user-specified; flagged under Risks/unknowns.

**Personal bucket only:** the account-balance side of this page already
varies by `bucket` (business buckets show their own TD accounts, if any).
Spend-pace is explicitly scoped to Personal in the task. Decision: render the
new section **only when `entity?.slug === "personal"`**; render nothing (no
empty card) for business buckets or the `taxes`/`projects` buckets. Flagged
as a scope-limiting decision under Risks/unknowns in case a later task wants
this for business budgets too.

### 3. Server vs. client boundary

Confirmed by reading `app/forecast/page.tsx`, `app/budgets/page.tsx`, and
`components/forecast/forecast-account-card.tsx`: this codebase's established
pattern for this page is **a big async Server Component (`page.tsx`) that
queries `db` directly (including raw `$queryRaw` for aggregates) and passes
fully-serialized plain data (numbers, strings, plain objects — never
`Decimal`/`Date` class instances) down to small `"use client"` leaf
components that hold only display-toggle `useState`** (see
`ForecastAccountCard`'s existing `days` state sliced from a
server-precomputed `chartData90` array). There is no client-side data
fetching anywhere on this page today.

This task follows the same shape exactly:
- All rollup math (`rollupForecast`) runs server-side in `page.tsx`, over the
  `Decimal`/`Date`-typed `DayForecast[]` already produced by
  `buildAccountForecast`.
- All spend-pace math (`projectPeriodEndSpend`, `computeBudgetSummary`) runs
  server-side in `page.tsx`.
- `ForecastAccountCard` (already `"use client"`) gains a second `useState`
  for the granularity toggle; it receives all four pre-computed, serialized
  arrays as props (exactly like it already receives `chartData90` for all 90
  days and slices client-side) — it does **no** date/Decimal math.
- `SpendPaceSection` is a **new, plain (non-`"use client"`) presentational
  component** — it has no interactivity/hooks, so unlike
  `RecurringExpensesSection`/`RentalBookingsSection` (which are `"use
  client"` because they contain forms), this one stays a server component,
  purely for organizing `page.tsx`'s JSX (which is already ~700 lines).

### 4. New server action(s)

**Decision: none.** Confirmed by reading `app/forecast/page.tsx` and
`app/budgets/page.tsx` in full: neither page fetches its display data through
an `actions/*.ts` server action — both query `db` directly inside the async
Server Component, including hand-written `$queryRaw` for the exact
"sum transactions by tag for a period" aggregate this task also needs (see
`app/budgets/page.tsx` lines 66-92, and `checkBudgetPace` in
`lib/notifications.ts` lines 149-190, which needs the same per-tag
history-plus-current-period data for its own, unscoped-by-entity, use case).
`actions/*.ts` files in this repo are reserved for **mutations** (forms
posting back to the server — `createBudget`, `updateBudgetLine`, etc., all
`requireAuth()`-gated). This task adds no new mutation, so it adds no new
action file. The new spend-pace queries are added as additional inline `db`
calls inside `ForecastPage`, following the `app/budgets/page.tsx` precedent
byte-for-byte in shape (same raw SQL grouped by `tt."tagId"`, same
`Prisma.Decimal` wrapping).

One deliberate deviation from `checkBudgetPace`'s history query: that query
in `lib/notifications.ts` is **not** scoped by entity (it processes every
budget regardless of bucket, in a single global cron sweep). This page *is*
per-bucket (driven by the `bucket` search param), so its analogous history
query must add `AND t."entityId" = ${entity.id}` — matching the
already-entity-scoped variant that `app/budgets/page.tsx` itself uses for its
current-period spend query. The Coder should copy the entity-scoped shape,
**not** blindly copy `checkBudgetPace`'s unscoped one.

## Affected files/modules

**New:**
- `lib/forecast-rollup.ts` — pure rollup module.
- `lib/__tests__/forecast-rollup.test.ts` — unit tests.
- `components/forecast/spend-pace-section.tsx` — new presentational section.

**Modified:**
- `app/forecast/page.tsx` — compute rollups per account; fetch/compute
  spend-pace rows for Personal; render the new section and pass new props to
  `ForecastAccountCard`.
- `components/forecast/forecast-account-card.tsx` — add granularity toggle
  and three new props.
- `components/forecast/balance-chart.tsx` — add one optional prop
  (`subtitleOverride`), fully backward compatible.

**Not touched:** `lib/forecast.ts`, `lib/spend-forecast.ts`, `lib/budget-pace.ts`,
`lib/notifications.ts`, `lib/budget.ts`, `prisma/schema.prisma`, any
`actions/*.ts` file, `app/forecast/loading.tsx` (generic skeleton, no change
needed).

## Approach — ordered steps

1. **`lib/forecast-rollup.ts`** (new file, no DB/Prisma-client imports beyond
   the `Decimal` runtime type, no `"use server"` — pure module, mirrors the
   header-comment style of `lib/spend-forecast.ts` and `lib/budget-pace.ts`):

   ```ts
   import { Decimal } from "@prisma/client/runtime/library";
   import type { DayForecast } from "./forecast";

   export type RollupHorizon = "daily" | "weekly" | "monthly" | "quarterly";

   export interface RollupBucket {
     index: number;            // 0-based sequence within the rollup
     periodStart: Date;        // first day covered, inclusive, UTC midnight
     periodEnd: Date;          // last day covered, inclusive, UTC midnight
     daysIncluded: number;     // number of forecast days rolled into this bucket
     isPartial: boolean;       // true if this bucket doesn't span a full
                                // natural period (7 days for weekly; the full
                                // calendar month/quarter for monthly/quarterly)
     endingBalance: Decimal;   // balanceAfter of the LAST day in the bucket
     minBalance: Decimal;      // lowest balanceAfter across all days in the bucket
     hasBreach: boolean;       // true if any day in the bucket has isBreachDay
     firstBreachDate: Date | null; // earliest breach date in the bucket, else null
   }

   export function rollupForecast(
     forecast: DayForecast[],
     horizon: RollupHorizon
   ): RollupBucket[]
   ```

   Behavior:
   - `forecast` is assumed already sorted ascending by date (guaranteed by
     `buildAccountForecast`'s day-by-day walk). Empty input → `[]`.
   - `"daily"`: one `RollupBucket` per `DayForecast` — `periodStart ===
     periodEnd === date`, `daysIncluded = 1`, `isPartial = false`,
     `endingBalance = minBalance = balanceAfter`, `hasBreach = isBreachDay`,
     `firstBreachDate = isBreachDay ? date : null`.
   - `"weekly"`: chunk the array into consecutive groups of 7 (in order,
     starting at index 0). `isPartial = daysIncluded < 7` (only the final,
     trailing chunk can be partial).
   - `"monthly"`: group consecutive days sharing the same UTC
     `(year, month)`. `isPartial = true` if `periodStart.getUTCDate() !== 1`
     OR `periodEnd.getUTCDate() !== <days in that month>` (via
     `new Date(Date.UTC(year, month + 1, 0)).getUTCDate()`, same technique
     `lib/spend-forecast.ts`'s `daysInPeriodMonth` and
     `lib/period-balance-sheet.ts`'s `monthRange` already use).
   - `"quarterly"`: group consecutive days sharing the same UTC
     `(year, Math.floor(month / 3))`. `isPartial = true` if `periodStart`
     isn't the 1st day of that quarter's first month OR `periodEnd` isn't the
     last day of that quarter's last month.
   - For every bucket: `minBalance` = min of `balanceAfter` across its days;
     `hasBreach` = OR of `isBreachDay` across its days; `firstBreachDate` =
     earliest `date` among days where `isBreachDay` is true, else `null`.
   - No `any`; exhaustive `switch`/`if` over `RollupHorizon` (TS should be
     able to prove exhaustiveness, or use a `default: { const _exhaustive:
     never = horizon; throw ... }` guard consistent with strict mode).

2. **`lib/__tests__/forecast-rollup.test.ts`** (new file, Vitest,
   `describe`/`it`/`expect`, local `D = (s) => new Decimal(s)` and
   `d = (iso) => new Date(iso + "T00:00:00Z")` helpers exactly as in
   `lib/__tests__/spend-forecast.test.ts`, plus a local
   `makeDay(iso, balance, isBreachDay = false): DayForecast` factory
   returning `{ date: d(iso), balanceAfter: D(balance), events: [], isBreachDay }`).
   Implement and pass all of the following (values below are the *exact*
   expected results the Coder should assert — do not recompute differently):

   1. **Daily passthrough** — 3 days (`2026-09-01` bal `1000`, `2026-09-02`
      bal `900`, `2026-09-03` bal `950`, all `isBreachDay: false`) →
      `rollupForecast(f, "daily")` returns 3 buckets; each has
      `periodStart === periodEnd === date`, `daysIncluded: 1`,
      `isPartial: false`, `endingBalance`/`minBalance` both equal to that
      day's balance, `hasBreach: false`, `firstBreachDate: null`.
   2. **Weekly, exact multiple of 7** — 14 days from `2026-09-01`, balance
      `1000 + 10*i` for `i = 0..13` (all `isBreachDay: false`) →
      2 buckets. Bucket 0: `periodStart = 2026-09-01`, `periodEnd =
      2026-09-07`, `daysIncluded: 7`, `isPartial: false`, `endingBalance:
      "1060"` (day index 6), `minBalance: "1000"` (day index 0). Bucket 1:
      `periodStart = 2026-09-08`, `periodEnd = 2026-09-14`, `daysIncluded: 7`,
      `isPartial: false`, `endingBalance: "1130"` (index 13),
      `minBalance: "1070"` (index 7).
   3. **Weekly, breach mid-bucket not on the ending day** (demonstrates why
      `hasBreach`/`minBalance` must be tracked separately from
      `endingBalance`) — 10 days from `2026-09-01`: balances `500, 400, 100,
      600, 650, 700, 750, 800, 820, 830` for Sep 1-10 respectively; `Sep 3`
      (`balance 100`) has `isBreachDay: true`, all others `false` →
      Bucket 0 (Sep 1-7, 7 days, `isPartial: false`): `endingBalance: "750"`,
      `minBalance: "100"`, `hasBreach: true`, `firstBreachDate` = `2026-09-03`.
      Bucket 1 (Sep 8-10, 3 days, `isPartial: true`): `endingBalance: "830"`,
      `minBalance: "800"`, `hasBreach: false`, `firstBreachDate: null`.
   4. **Weekly, `firstBreachDate` picks the earliest breach, not the last** —
      3 days from `2026-09-01`, `Sep 1` and `Sep 2` both `isBreachDay: true`,
      `Sep 3` `false` → single bucket (`daysIncluded: 3`, `isPartial: true`),
      `hasBreach: true`, `firstBreachDate = 2026-09-01` (not `Sep 2`).
   5. **Monthly, spans a month boundary, both ends partial** — 7 days,
      `2026-01-28` through `2026-02-03`, balances `100, 110, 120, 130, 140,
      150, 160` in order → 2 buckets. Bucket 0: `periodStart = 2026-01-28`,
      `periodEnd = 2026-01-31`, `daysIncluded: 4`, `isPartial: true`,
      `endingBalance: "130"`, `minBalance: "100"`. Bucket 1:
      `periodStart = 2026-02-01`, `periodEnd = 2026-02-03`,
      `daysIncluded: 3`, `isPartial: true` (Feb 2026 has 28 days — 2026 is
      not a leap year — and this bucket only reaches Feb 3),
      `endingBalance: "160"`, `minBalance: "140"`.
   6. **Monthly, exact full calendar month** — 28 days, `2026-02-01` through
      `2026-02-28`, constant balance `"500"`, all `isBreachDay: false` →
      single bucket: `periodStart = 2026-02-01`, `periodEnd = 2026-02-28`,
      `daysIncluded: 28`, `isPartial: false`, `endingBalance: "500"`,
      `minBalance: "500"`, `hasBreach: false`.
   7. **Quarterly, spans a quarter boundary** — 11 days, `2026-03-26` through
      `2026-04-05`, balance `10*i` for `i = 0..10` → 2 buckets. Bucket 0
      (Q1 2026, Jan-Mar): `periodStart = 2026-03-26`, `periodEnd =
      2026-03-31`, `daysIncluded: 6`, `isPartial: true`, `endingBalance:
      "50"` (index 5), `minBalance: "0"` (index 0). Bucket 1 (Q2 2026,
      Apr-Jun): `periodStart = 2026-04-01`, `periodEnd = 2026-04-05`,
      `daysIncluded: 5`, `isPartial: true`, `endingBalance: "100"`
      (index 10), `minBalance: "60"` (index 6).
   8. **Quarterly, exact full calendar quarter** — every day from
      `2026-04-01` through `2026-06-30` inclusive (91 days: Apr 30 + May 31 +
      Jun 30), constant balance `"1"`, no breaches → single bucket:
      `periodStart = 2026-04-01`, `periodEnd = 2026-06-30`,
      `daysIncluded: 91`, `isPartial: false`.
   9. **Empty input** — `rollupForecast([], "weekly")` (and `"monthly"`,
      `"quarterly"`, `"daily"`) all return `[]`.
   10. **Single-day input, weekly horizon** — one day `2026-09-01` bal
       `"500"` → 1 bucket, `daysIncluded: 1`, `isPartial: true`,
       `periodStart === periodEnd === 2026-09-01`, `endingBalance:
       minBalance: "500"`.

3. **`components/forecast/balance-chart.tsx`** — add one new optional prop:

   ```ts
   interface BalanceChartProps {
     data: BalanceChartPoint[];
     minimumBalance: number | null;
     accountName: string;
     days?: number;
     subtitleOverride?: string; // NEW — when set, replaces the "{days}-day
                                 // projection" subtitle text entirely
   }
   ```

   Render `subtitleOverride ?? \`${days}-day projection\`` in place of the
   current hard-coded `${days}-day projection` string. No other change. When
   the prop is omitted (all existing/daily call sites), output is byte-for-
   byte identical to today.

4. **`components/forecast/forecast-account-card.tsx`**:
   - Extend `ForecastAccountCardProps` with three new required props, reusing
     the already-exported `ChartPoint` type (no new type needed):
     `chartDataWeekly: ChartPoint[]`, `chartDataMonthly: ChartPoint[]`,
     `chartDataQuarterly: ChartPoint[]`.
   - Add `const [granularity, setGranularity] = useState<"daily" | "weekly" |
     "monthly" | "quarterly">("daily")`.
   - Add a second segmented-button row directly below the existing 30/60/90
     row, styled identically (`flex rounded-md border text-xs overflow-hidden`
     wrapper, same button classes), with labels `Daily`, `Weekly`, `Monthly`,
     `Quarterly` mapped from `(["daily","weekly","monthly","quarterly"] as
     const)`.
   - Render logic:
     - If `granularity === "daily"`: show the existing 30/60/90 row; compute
       `sliced = chartData90.slice(0, days)` exactly as today; `hasBreaches`
       computed exactly as today (`sliced.some(d => d.balance < minimumBalance)`
       — leave this line untouched, do not "improve" it as part of this task).
     - Else: hide the 30/60/90 row; `sliced` = the corresponding full array
       (`chartDataWeekly` / `chartDataMonthly` / `chartDataQuarterly`) with no
       further slicing; `hasBreaches = sliced.some(d => d.isBreachDay)` (use
       the already-known flag from the rollup rather than re-deriving from
       `balance < minimumBalance`, since — per Design decision 1 — a bucket's
       `endingBalance` can be safely above the minimum even though the bucket
       contains a breach day).
     - Pass `subtitleOverride={granularity === "daily" ? undefined :
       \`${granularity[0]!.toUpperCase()}${granularity.slice(1)} rollup\`}`
       to `<BalanceChart>` (i.e. "Weekly rollup" / "Monthly rollup" /
       "Quarterly rollup"; `undefined` for daily preserves today's text).

5. **`app/forecast/page.tsx`**:
   - Import `rollupForecast` from `@/lib/forecast-rollup`; import
     `projectPeriodEndSpend` from `@/lib/spend-forecast`; import
     `computeBudgetSummary` from `@/lib/budget`; import `PACE_TRAILING_MONTHS`
     from `@/lib/budget-pace`.
   - Inside the existing `accountForecasts = tdAccounts.map((acct) => {...})`
     block, after `forecast` is computed (right after the existing
     `chartData90` construction), add:
     ```ts
     function toChartPoints(buckets: RollupBucket[]): ChartPoint[] {
       return buckets.map((b, i) => ({ label: labelFor(b, granularityKind), ... }));
     }
     ```
     Concretely: build three label-formatting helpers (module-level, plain
     functions, server-side only — never passed to the client):
     - Weekly label: `` `Week ${b.index + 1} (${fmtShort(b.periodStart)}–${fmtShort(b.periodEnd)})` ``
       where `fmtShort` = `d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })`
       (same formatter already used for `chartData90` labels in this file).
     - Monthly label: `` `${b.periodStart.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}${b.isPartial ? " (partial)" : ""}` ``
     - Quarterly label: compute `q = Math.floor(b.periodStart.getUTCMonth() / 3) + 1`;
       `` `Q${q} ${b.periodStart.getUTCFullYear()}${b.isPartial ? " (partial)" : ""}` ``
     - Each `ChartPoint`: `{ label, balance: b.endingBalance.toNumber(), isBreachDay: b.hasBreach }`.
     - Build `chartDataWeekly = rollupForecast(forecast, "weekly").map(...)`,
       `chartDataMonthly = rollupForecast(forecast, "monthly").map(...)`,
       `chartDataQuarterly = rollupForecast(forecast, "quarterly").map(...)`.
     - Add these three arrays to the object returned from the `.map()` (alongside
       the existing `acct, forecast, breaches, chartData90, startBal, minBal`).
   - In the JSX, pass the three new props through to `<ForecastAccountCard>`.
   - Add a new block, gated `entity?.slug === "personal"`, placed after the
     account-forecast computation and before the JSX return (or inline right
     before the return, matching this file's existing style of computing
     everything up front):
     ```ts
     const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
     const [pYear, pMonth] = period.split("-").map(Number) as [number, number];
     const monthStart = new Date(Date.UTC(pYear, pMonth - 1, 1));
     const monthEnd = new Date(Date.UTC(pYear, pMonth, 1));
     const historyStart = new Date(Date.UTC(pYear, pMonth - 1 - PACE_TRAILING_MONTHS, 1));

     let paceRows: TagPaceRow[] = [];
     if (entity?.slug === "personal") {
       const paceBudgets = await db.budget.findMany({
         where: { entityId: entity.id, period },
         include: { tag: true },
       });

       const tagSpendRows = await db.$queryRaw<{ tagId: string; total: string }[]>`
         SELECT tt."tagId", SUM(t.amount)::text AS total
         FROM "Transaction" t
         JOIN "TransactionTag" tt ON tt."transactionId" = t.id
         WHERE t."entityId" = ${entity.id}
           AND t."archivedAt" IS NULL
           AND t."transferPairId" IS NULL
           AND t."postedAt" >= ${monthStart}
           AND t."postedAt" < ${monthEnd}
         GROUP BY tt."tagId"
       `;
       const spendByTagId = new Map(tagSpendRows.map((r) => [r.tagId, new Prisma.Decimal(r.total)]));

       const historyRows = await db.$queryRaw<{ tagId: string; period: string; total: string }[]>`
         SELECT tt."tagId" AS "tagId", to_char(t."postedAt", 'YYYY-MM') AS period, SUM(t.amount)::text AS total
         FROM "Transaction" t
         JOIN "TransactionTag" tt ON tt."transactionId" = t.id
         WHERE t."entityId" = ${entity.id}
           AND t."archivedAt" IS NULL
           AND t."transferPairId" IS NULL
           AND t."postedAt" >= ${historyStart}
           AND t."postedAt" < ${monthStart}
         GROUP BY tt."tagId", period
       `;
       const historyByTagId = new Map<string, { period: string; total: Prisma.Decimal }[]>();
       for (const row of historyRows) {
         const pts = historyByTagId.get(row.tagId) ?? [];
         pts.push({ period: row.period, total: new Prisma.Decimal(row.total) });
         historyByTagId.set(row.tagId, pts);
       }

       for (const b of paceBudgets) {
         const actualSpend = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
         const summary = computeBudgetSummary({
           budgeted: b.budgeted,
           rolloverAmount: b.rolloverAmount ?? new Prisma.Decimal(0),
           actualSpend,
         });
         if (summary.effectiveBudget.lessThanOrEqualTo(0)) continue;

         const forecast = projectPeriodEndSpend({
           period,
           spendToDate: actualSpend,
           asOfDate: forecastStart, // already computed above in this file
           history: historyByTagId.get(b.tagId) ?? [],
           trailingMonths: PACE_TRAILING_MONTHS,
         });

         const projectedPercentOfBudget = summary.effectiveBudget.isZero()
           ? 0
           : Math.min(
               forecast.projectedTotal.abs().div(summary.effectiveBudget.abs()).times(100).toNumber(),
               999
             );

         paceRows.push({
           tagId: b.tagId,
           tagName: b.tag.shortName,
           budgeted: summary.effectiveBudget.toNumber(),
           actualSpend: actualSpend.abs().toNumber(),
           projectedTotal: forecast.projectedTotal.abs().toNumber(),
           percentUsed: Math.round(summary.percentUsed),
           projectedPercentOfBudget: Math.round(projectedPercentOfBudget),
           confidence: forecast.confidence,
           method: forecast.method,
           trailingMonthsUsed: forecast.trailingMonthsUsed,
         });
       }
       paceRows.sort((a, b) => b.projectedPercentOfBudget - a.projectedPercentOfBudget);
     }
     ```
     (`forecastStart` is already defined earlier in this file as
     `new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))`
     — reuse it as-is for `asOfDate` rather than introducing a second "today"
     constant.)
   - Render `<SpendPaceSection period={period} periodLabel={monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} rows={paceRows} />`
     only when `entity?.slug === "personal" && paceRows.length > 0`, placed
     after the "Next 14 Days — Primary Checking" `Card` and before the
     "Recurring expenses" section.

6. **`components/forecast/spend-pace-section.tsx`** (new file, plain function
   component, no `"use client"`, no hooks):

   ```ts
   import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
   import { formatUSD } from "@/lib/utils";

   export interface TagPaceRow {
     tagId: string;
     tagName: string;
     budgeted: number;
     actualSpend: number;
     projectedTotal: number;
     percentUsed: number;
     projectedPercentOfBudget: number;
     confidence: "low" | "medium" | "high";
     method: "blended" | "pace_only";
     trailingMonthsUsed: number;
   }

   interface SpendPaceSectionProps {
     period: string;
     periodLabel: string;
     rows: TagPaceRow[];
   }

   export function SpendPaceSection({ periodLabel, rows }: SpendPaceSectionProps) { ... }
   ```

   Rendering rules (exact, so the Coder isn't guessing):
   - Card title: `` `Category Spend Pace — ${periodLabel}` ``.
   - One static disclaimer line under the title, always shown:
     `"Projections are estimates based on spending pace and recent history — not a guarantee, and not tax or financial advice."`
     (ground rule 8 — mirrors the tone/caveat already in `checkBudgetPace`'s
     notification body and `spend-forecast.ts`'s own doc comment).
   - Table columns: Tag | Spent so far | Budget | Projected (month end) | Status.
   - Status badge logic, evaluated in this order:
     1. `confidence === "low"` → badge "Not enough history yet" (neutral/muted
        styling), and prefix the "Projected" cell value with `"~"` to signal
        it's a bare pace extrapolation with no historical damping.
     2. else if `projectedPercentOfBudget >= 100` → badge "Trending over"
        (red/destructive styling, matching `border-destructive` conventions
        used elsewhere on this page).
     3. else if `projectedPercentOfBudget >= 80` → badge "On pace" (amber,
        matching the `amber-*` classes already used for the "at_risk" CC
        funding state on this same page).
     4. else → badge "Under pace" (green, matching the `green-*` classes
        already used for the "covered" CC funding state on this page).
     (The `>= 80` threshold intentionally matches
     `PACE_SUPPRESS_AT_PERCENT_USED` / `checkBudgetOverspend`'s existing 80%
     threshold for consistency — not a new arbitrary number.)
   - If `rows.length === 0`, the parent (`page.tsx`) doesn't render this
     component at all (see step 5) — no empty-state needed inside it.

7. **Verify**: run `pnpm typecheck`, `pnpm lint`, `pnpm vitest run
   lib/__tests__/forecast-rollup.test.ts`, then the full `pnpm test`. Confirm
   0 regressions against the 317/317 baseline (re-verified live on
   2026-09-11 immediately before writing this plan) and that the new test
   file's cases are all included in the new total.

8. **Explicit hand-off note for a human** (not automatable by this pipeline):
   load `/forecast?bucket=personal` and a business bucket
   (e.g. `/forecast?bucket=sudden-valley`, using whatever real business slug
   exists in the seeded data) in a browser and confirm:
   - Daily granularity looks and behaves exactly as it did before this
     change (30/60/90 toggle present and working).
   - Switching to Weekly/Monthly/Quarterly visibly changes the chart to
     fewer, wider buckets with the expected labels, and hides the 30/60/90
     row.
   - A bucket containing a mid-period breach (not on its last day) is still
     visually flagged (destructive styling) even though its ending balance
     might be healthy.
   - The Category Spend Pace section renders sensible numbers for the
     Personal bucket and does **not** appear on the business bucket page.
   - No layout breakage at mobile width.
   `pnpm typecheck`/`lint`/`test` cannot catch any of the above — this step
   must not be skipped before calling the task done.

## Risks / unknowns

- **Quarterly granularity is data-limited.** Because this task explicitly
  does not extend the forecast's date range, "Quarterly" over a 90-day window
  will typically render only 1 full quarter bucket plus a partial adjacent
  one — never a true multi-quarter view. This is an accepted, documented
  limitation (see Design decision 1), not a bug, but a human reviewing the
  page might expect more and should be told this up front.
- **Spend-pace has no quarterly variant.** Flagged explicitly in Design
  decision 2 with a recommendation for a future `sumQuarterlyPace()`-style
  helper if the household wants quarter-level category pacing later —
  deliberately not built now to avoid inventing new forecasting logic beyond
  what was asked.
- **Spend-pace is Personal-bucket-only.** If the intent was actually to show
  this for business entities too, that's a scope change this plan
  deliberately did not make (task text scoped it to Personal). Flag before
  building if that assumption is wrong.
- **Row sort order (highest pacing-risk first) and the exact status-badge
  thresholds (100% / 80%) are presentational choices** made by the Planner,
  not specified verbatim by the user. The 80% threshold reuses the existing
  `checkBudgetOverspend` constant for consistency rather than inventing a new
  number, which reduces (but doesn't eliminate) this risk.
- **No browser access in this pipeline.** Typecheck/lint/unit tests cannot
  verify that the granularity toggle actually swaps rendered content, that
  chart labels render legibly, or that layout holds at small widths. Step 8
  above is a hard requirement, not a nice-to-have.
- **`lib/forecast.ts` / `lib/spend-forecast.ts` APIs were confirmed
  sufficient as-is** for everything this task needs — no gaps found that
  would require changing either stable, reviewed module.
- **Raw SQL duplication.** The new spend-pace queries in `page.tsx`
  duplicate (rather than share) the shape of similar queries in
  `app/budgets/page.tsx` and `lib/notifications.ts`. This matches this
  repo's existing convention (those three call sites don't currently share a
  helper either) — not introducing a new shared query helper is intentional,
  to avoid a refactor beyond this task's scope, but is worth revisiting if a
  fourth call site appears.

## Acceptance criteria

1. `lib/forecast-rollup.ts` exists, exports `RollupHorizon`, `RollupBucket`,
   `rollupForecast()` exactly per the signature/behavior above, with no
   changes to `lib/forecast.ts` or `lib/spend-forecast.ts`.
2. `lib/__tests__/forecast-rollup.test.ts` exists and all 10 specified cases
   pass.
3. `/forecast` (Personal bucket) shows, per TD account, a working
   Daily/Weekly/Monthly/Quarterly granularity toggle in addition to the
   existing 30/60/90-day range toggle; Daily mode is behaviorally identical
   to the pre-change page.
4. A bucket with a breach that isn't on its final day is still visually
   flagged in non-daily granularities (verifies `hasBreach`/`minBalance`
   wiring, not just `endingBalance`).
5. `/forecast?bucket=personal` shows a new "Category Spend Pace" section
   listing every Personal-entity tag with a current-period budget > 0,
   each row showing spent-to-date, budget, projected total, and a status
   badge per the exact thresholds specified, plus the required observational
   disclaimer line.
6. The same section does not render on any business-entity bucket.
7. No copy anywhere reads as advice/certainty ("you will...", "you should
   sell...") — only observational/projection framing, consistent with
   `checkBudgetPace`'s existing tone.
8. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with zero
   regressions; total test count is 317 + (count of new rollup tests, i.e.
   at least 10), 0 failures.
9. No Prisma schema changes, no new dependencies in `package.json`, no
   changes to any `actions/*.ts` file, no new server action added.
10. A human has visually verified the rendered page per step 8 of the
    Approach before this task is considered fully done (record this
    explicitly in the Tester/Reviewer notes — it cannot be inferred from CI
    passing).

## Test expectations

- **Unit tests (required):** `lib/__tests__/forecast-rollup.test.ts` — the 10
  cases specified above, Vitest, following the exact `D`/`d`/local-factory
  style already used in `lib/__tests__/spend-forecast.test.ts` and
  `lib/__tests__/budget-pace.test.ts`.
- **No unit tests required for** (confirmed by how this repo already treats
  equivalent existing code):
  - `app/forecast/page.tsx`'s new inline DB queries and JSX — this file has
    no test file today and none of its existing inline `db`/`$queryRaw` logic
    is unit tested (confirmed by reading it in full; there is no
    `app/forecast/*.test.ts`, and `app/budgets/page.tsx`, which uses the
    identical inline-query pattern, has none either).
  - `ForecastAccountCard`'s new `granularity` state and toggle — client
    component state, no DB, but UI-only; consistent with `ForecastAccountCard`
    having no existing test file for its current `days` state.
  - `BalanceChart`'s new optional prop — presentational only.
  - `SpendPaceSection`'s rendering and status-badge branching — this is
    genuinely branchy (4-way badge logic) but it's *display* logic over
    already-computed, already-tested numbers (`projectPeriodEndSpend`,
    `computeBudgetSummary` are both covered elsewhere); per this repo's
    established "pure-decision-module" pattern (see `lib/budget-pace.ts` /
    `checkBudgetPace` precedent), if the Coder finds themselves writing
    non-trivial *new* decision logic here (beyond simple threshold
    comparisons), it should be pulled into a small pure `lib/` function and
    tested there instead of left inline — but as specified, the thresholds
    are simple enough to stay inline and untested, matching how
    `app/budgets/page.tsx`'s own percent-based styling is handled today.
- **Manual/browser verification (required, not optional):** see step 8 of
  the Approach. This pipeline's Coder/Tester/Reviewer agents have no browser
  access; a human (or a separate browser-driving step) must confirm the
  granularity toggle visibly changes rendered content, breach styling still
  works for non-ending-day breaches, the spend-pace section appears/doesn't
  appear on the correct buckets, and layout holds at mobile width, before
  this task is considered fully done.
