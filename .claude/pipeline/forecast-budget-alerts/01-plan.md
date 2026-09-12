# Plan: forecast-budget-alerts

## Restated goal

Wire the already-built `projectPeriodEndSpend()` forecasting engine
(`lib/spend-forecast.ts`) into the notification system so the household gets an
early, forecast-based "trending over budget" warning — in addition to, not instead
of, the existing 80%-used threshold alert.

## Scope

**In scope:**
- New pure decision module `lib/budget-pace.ts` (analogous to `lib/card-due.ts` /
  `lib/cc-funding.ts`): wraps `projectPeriodEndSpend()` with the suppression rules
  and fire/no-fire decision described below. Fully unit-testable, no DB, no
  `"use server"`.
- New DB-touching check function `checkBudgetPace(period: string): Promise<number>`
  added to `lib/notifications.ts`, following the exact structural pattern of
  `checkBudgetOverspend` (own raw-SQL queries, `getAllUserIds`,
  `alreadyNotifiedToday`, `createNotification`).
- New raw SQL query inside `checkBudgetPace` for trailing-N-months spend per tag
  (see exact query below).
- Wire `checkBudgetPace(period)` into `app/api/cron/notifications/route.ts`
  (add to the `Promise.all`, add to the response JSON, same as every other check).
- New test file `lib/__tests__/budget-pace.test.ts` covering `evaluateBudgetPace`
  (the pure decision function) exhaustively.

**Explicitly NOT in scope (out of scope):**
- No changes to `lib/spend-forecast.ts`'s public API (confirmed sufficient — see
  Risks/unknowns).
- No changes to `checkBudgetOverspend` itself — it is not refactored, not
  enriched with forecast data, and not touched at all. (Design decision 1 below
  explains why.) This also means no shared helper is extracted for the
  current-month tag-spend query; `checkBudgetPace` duplicates that query inline,
  matching this file's existing convention where `checkAnomalies` also
  independently re-declares its own tag-spend `$queryRaw` rather than sharing one
  with `checkBudgetOverspend`.
- No Prisma schema changes. `Notification.type` is a plain `String` column (not
  a Postgres enum — confirmed by reading `prisma/schema.prisma` lines 620–632),
  so the new `"budget_pace"` type value requires no migration.
- No new dependencies.
- No changes to `app/settings/notifications/page.tsx` or any per-user
  `notificationPrefs` gating. Confirmed by reading that page and
  `checkBudgetOverspend`: the overspend check sends to **all** users
  unconditionally via `getAllUserIds()` with no prefs check (unlike
  `checkDocumentExpiry`/`checkLargeSpend`, which do gate on
  `notificationPrefs`). `checkBudgetPace` follows the same unconditional
  all-users pattern as `checkBudgetOverspend`, since it's a peer of that check,
  not a peer of the opt-in ones. If the user later wants a per-type opt-out for
  `budget_pace`, that's a separate task.
- No new notification-center/UI rendering work — the existing generic
  notification list already renders `payload.title`/`payload.body` for any
  `type` value (confirmed: `checkAnomalies`, `checkCardPaymentsDue`, etc. all
  ship new `type` strings the same way with no corresponding UI-side switch
  statement found).

## Affected files/modules

- `lib/budget-pace.ts` — **new**. Pure decision logic.
- `lib/__tests__/budget-pace.test.ts` — **new**. Unit tests for the above.
- `lib/notifications.ts` — **modified**. Add `checkBudgetPace` export; add one
  new import (`evaluateBudgetPace`, `PACE_TRAILING_MONTHS` from
  `./budget-pace`; `projectPeriodEndSpend`'s types are not imported here directly
  — `budget-pace.ts` re-exports what's needed). No changes to any existing
  exported function's behavior or signature.
- `app/api/cron/notifications/route.ts` — **modified**. Add `checkBudgetPace` to
  the `Promise.all` array and the JSON response, same shape as every other check.
- `lib/__tests__/notifications.test.ts` — **not modified**. Per the codebase's
  existing precedent, `checkCardPaymentsDue` and `checkCcFundingShortfall` (both
  DB-touching checks that wrap a pure decision module) are **not** imported or
  tested in this file — only `checkBudgetOverspend`, `checkLowBalance`,
  `checkAccrualShortfall`, `checkBillReminders`, `checkAnomalies` are. Verified
  by reading the file's import list. `checkBudgetPace` follows that same
  precedent: it is DB glue around an already-fully-tested pure function, so it is
  not separately unit tested. Do not add it to this file.

## Design decisions (resolved, not left to the Coder)

### 1. Separate check, not an enrichment of checkBudgetOverspend

`checkBudgetPace` is a **new, independent check function and notification
type** (`"budget_pace"`), not a payload enrichment of the existing `"overspend"`
type. Rationale:

- Spec 05 explicitly describes the 80%/100%-used alert as its own signal
  ("Overspend (or approaching threshold, e.g., 80%/100% of a tag budget)").
  That's a snapshot fact ("you've used X% of Y"), independently true and useful
  regardless of forecasting.
- The roadmap's forecast signal is valuable specifically because it can fire
  **before** 80% actual usage is reached (e.g., day 3 of the month, 20% used,
  but pace says the tag will land 130% over budget). A snapshot check
  mathematically cannot produce that warning — `percentUsed` is capped by
  reality until spend actually happens. Folding the forecast into
  `checkBudgetOverspend`'s existing `percentUsed >= 80` gate would mean the
  early-warning case never fires, defeating the entire point of the roadmap
  item.
- Keeping them separate means each stays simple and independently testable, and
  neither's existing, already-passing tests need to change.
- To avoid the two signals firing redundantly once spend is well underway
  (see decision 3), `checkBudgetPace` explicitly stands down once
  `percentUsed >= 80` — at that point `checkBudgetOverspend` owns the signal.

### 2. Trailing-month history source: new raw SQL query, same shape as existing ones

`checkBudgetPace` needs, per tag, up to `PACE_TRAILING_MONTHS` (= 3, matching
`projectPeriodEndSpend`'s own default) prior months of spend. Query (grouped by
tag **and** calendar month, over a bounded lookback window immediately before
the current period — mirrors `checkAnomalies`'s existing `historicalRows` query
pattern of an unfiltered date-range group-by that's joined against budgets
in-memory):

```ts
const trailingMonths = PACE_TRAILING_MONTHS; // 3
const historyStart = new Date(Date.UTC(year, month - 1 - trailingMonths, 1));
// monthStart/monthEnd/year/month computed exactly as in checkBudgetOverspend

const historyRows = await db.$queryRaw<{ tagId: string; period: string; total: string }[]>`
  SELECT tt."tagId" AS "tagId", to_char(t."postedAt", 'YYYY-MM') AS period, SUM(t.amount)::text AS total
  FROM "Transaction" t
  JOIN "TransactionTag" tt ON tt."transactionId" = t.id
  WHERE t."archivedAt" IS NULL
    AND t."transferPairId" IS NULL
    AND t."postedAt" >= ${historyStart}
    AND t."postedAt" < ${monthStart}
  GROUP BY tt."tagId", period
`;
```

Notes for the Coder:
- `to_char(t."postedAt", 'YYYY-MM')` is safe with no timezone conversion because
  `Transaction.postedAt` is a plain `DateTime` in `prisma/schema.prisma` with no
  `@db.Timestamptz` modifier anywhere in the schema (confirmed by grep) — it's
  stored as Postgres `timestamp` (no tz), holding UTC wall-clock values per
  CLAUDE.md's "all dates stored UTC" rule. This matches how
  `monthStart`/`monthEnd` in `checkBudgetOverspend` are already computed with
  `Date.UTC(...)` and compared directly against `postedAt` with no tz
  conversion — same convention, just extended to a `GROUP BY` bucket.
- The `WHERE t."postedAt" < ${monthStart}` bound naturally excludes the current,
  in-progress period from `history`, satisfying `projectPeriodEndSpend`'s (and
  `computeTrailingAverage`'s) requirement that the current period never leak
  into its own baseline — no extra filtering needed on the JS side for that.
- Because the `GROUP BY` only emits a row when a tag actually had transactions
  in a given month, a month with zero activity for a tag is naturally *absent*
  from the rows — never a `$0` row. This satisfies `spend-forecast.ts`'s
  documented caller contract ("Only include periods that actually had data —
  do not pass a $0 entry").
- Bucket `historyRows` into `Map<string, MonthlySpendPoint[]>` keyed by `tagId`
  in JS (same style as `checkAnomalies`'s `histMap`), then pass
  `historyByTagId.get(budget.tagId) ?? []` as `history` into `evaluateBudgetPace`.
- The current-period actual-spend query is a **second**, separate query — reuse
  the identical shape already in `checkBudgetOverspend` (same `monthStart`/
  `monthEnd` bounds, same `SUM(t.amount)` GROUP BY tagId), duplicated inline in
  `checkBudgetPace` rather than shared (see Scope note above on why no helper
  extraction).

### 3. Confidence gating: suppress `"low"` confidence entirely; suppress once actual usage crosses 80%

Two independent suppression rules, both implemented inside the pure
`evaluateBudgetPace` function so they're unit-testable without a DB:

- **Suppress when `forecast.confidence === "low"`.** `confidence` is `"low"`
  exactly when `trailingMonthsUsed === 0` (verified against
  `spend-forecast.ts`'s `projectPeriodEndSpend` — `confidence` is computed from
  `monthsUsed`, and `monthsUsed === 0` is the only path to `"low"`, which is
  also the only path to `method === "pace_only"`, since `trailingAverage` is
  `null` in exactly that case too). A `"low"`-confidence projection is a bare
  linear extrapolation off a single partial month with **no** historical
  baseline to damp it (see `spend-forecast.ts`'s own documented risk: front- or
  back-loaded spend can wildly over/under-project until enough of the month has
  elapsed). Surfacing that as a household alert this early would violate ground
  rule 8's "observational, not alarming with a shaky number" spirit — a
  brand-new or sparse-history tag should accumulate at least one qualifying
  prior month before its pace is trusted enough to page anyone. Once
  `confidence` is `"low"` is ruled out, `method` is *always* `"blended"` for
  every case that can fire (see the same code-reading above) — so notification
  copy never needs a `"pace_only"` variant.
- **Suppress when `percentUsed >= 80`** (the same threshold
  `checkBudgetOverspend` uses to fire — duplicated as a literal `80` in
  `budget-pace.ts` with a comment noting it must stay in sync with
  `checkBudgetOverspend`'s threshold; not extracted into a shared constant,
  to avoid touching `checkBudgetOverspend`'s file for a one-line dependency).
  This is what makes `checkBudgetPace` a genuine *early* warning rather than a
  duplicate of the overspend alert: once actual spend is at/above 80% of
  budget, `checkBudgetOverspend` already owns telling the household "you're at
  X%" — a second "you're trending over" notification for the same underlying
  condition at that point is redundant noise, not new information.
- **Materiality margin:** even outside those two suppressions, `evaluateBudgetPace`
  only fires when the projected total exceeds the effective budget by more than
  5% (`PACE_OVERAGE_MARGIN = 0.05`), i.e.
  `projectedTotal.abs() > effectiveBudget.abs() * 1.05`. Forecasting math
  (blended pace + trailing average) is inherently noisy near the boundary;
  firing on a projection that's $1 or 0.1% over budget would be alarm fatigue,
  not a useful signal — mirrors `checkAnomalies`'s existing use of a noise
  floor (`$50` there) for the same reason.
- **Zero/negative-budget guard:** if `effectiveBudget.lessThanOrEqualTo(0)`,
  never fire — there's no meaningful "over budget" concept to project against
  (mirrors `computeBudgetSummary`'s own `effectiveBudget.isZero()` guard for
  `percentUsed`).

### 4. Notification copy (ground rule 8 — observational, never advice)

Both `title` and `body` are deterministic string templates built from the
`evaluateBudgetPace` result — no branching on `method` (always `"blended"`
when firing, per decision 3), and no advice language ("cut back", "you should",
etc.).

```ts
const title = `Trending over budget: ${budget.tag.shortName}`;

const body =
  `${budget.tag.shortName} is on pace to reach ${formatUSD(evaluation.forecast.projectedTotal)} ` +
  `by month end, above the ${formatUSD(summary.effectiveBudget)} budget — projected from ` +
  `${formatUSD(actualSpend)} spent so far plus the last ${evaluation.forecast.trailingMonthsUsed} ` +
  `month${evaluation.forecast.trailingMonthsUsed === 1 ? "" : "s"} of history.`;
```

Example rendered output: `"Groceries is on pace to reach $1,340 by month end, above
the $1,200 budget — projected from $410 spent so far plus the last 3 months of
history."` — reuses the existing `formatUSD()` helper already defined at the top
of `lib/notifications.ts` (abs value, no-decimal, comma-grouped).

### 5. Anti-spam scopeKey

`const scopeKey = \`pace:${budget.tagId}:${period}\`;` — distinct prefix
(`pace:`) from `checkBudgetOverspend`'s `overspend:${budget.tagId}:${period}`,
so `alreadyNotifiedToday` never conflates the two. Like every other check in
this file, it re-fires at most once per UTC calendar day for as long as the
firing condition holds (same `alreadyNotifiedToday` semantics as
`low_balance`/`bill_due`/etc. — no new anti-spam mechanism needed).

## Approach (ordered steps)

1. Create `lib/budget-pace.ts`:
   - Import `Decimal` from `@prisma/client/runtime/library` and
     `projectPeriodEndSpend`, `type MonthlySpendPoint`, `type SpendForecast`
     from `./spend-forecast`.
   - Export constants: `export const PACE_TRAILING_MONTHS = 3;`,
     `export const PACE_SUPPRESS_AT_PERCENT_USED = 80;`,
     `export const PACE_OVERAGE_MARGIN = 0.05;`.
   - Export `interface BudgetPaceEvaluation { fire: boolean; forecast: SpendForecast; projectedOverageAbs: Decimal | null; }`.
   - Export function:
     ```ts
     export function evaluateBudgetPace(opts: {
       period: string;
       effectiveBudget: Decimal;
       actualSpend: Decimal; // signed, current period-to-date
       percentUsed: number;  // from computeBudgetSummary
       asOfDate: Date;
       history: MonthlySpendPoint[];
       trailingMonths?: number; // default PACE_TRAILING_MONTHS
     }): BudgetPaceEvaluation
     ```
   - Body: apply the zero/negative-budget guard, the `percentUsed >= 80` guard,
     call `projectPeriodEndSpend`, apply the `confidence === "low"` guard,
     apply the 5% materiality margin, return `{ fire, forecast, projectedOverageAbs }`
     (`projectedOverageAbs` is `forecast.projectedTotal.abs().minus(effectiveBudget.abs())`
     when firing, `null` otherwise). Guards short-circuit in this order: budget
     guard → percentUsed guard → (only then) call `projectPeriodEndSpend` →
     confidence guard → margin check. Short-circuiting before calling
     `projectPeriodEndSpend` avoids doing forecast math when it can't matter,
     but still needs `forecast` in the return type — when a guard short-circuits
     before computing it, still call `projectPeriodEndSpend` to populate
     `forecast` in the return value (callers besides `checkBudgetPace` may want
     the number even when not firing), i.e. only the `fire` boolean and
     `projectedOverageAbs` are gated, not the computation itself.

2. Add `checkBudgetPace` to `lib/notifications.ts`:
   - New imports: `import { evaluateBudgetPace, PACE_TRAILING_MONTHS } from "./budget-pace";`
   - Signature: `export async function checkBudgetPace(period: string): Promise<number>`
   - Mirror `checkBudgetOverspend`'s structure: parse `year`/`month`, compute
     `monthStart`/`monthEnd`, fetch `budgets = await db.budget.findMany({ where: { period }, include: { tag: true, entity: true } })`.
   - Run the current-month tag-spend query (identical to `checkBudgetOverspend`'s,
     duplicated inline).
   - Run the new trailing-history query from decision 2, bucket into
     `Map<string, MonthlySpendPoint[]>`.
   - `const userIds = await getAllUserIds();`
   - Loop over `budgets`: compute `actualSpend`, `summary = computeBudgetSummary(...)`,
     call `evaluateBudgetPace({ period, effectiveBudget: summary.effectiveBudget, actualSpend, percentUsed: summary.percentUsed, asOfDate: startOfDayUTC(new Date()), history: historyByTagId.get(budget.tagId) ?? [], trailingMonths: PACE_TRAILING_MONTHS })`.
   - `if (!evaluation.fire) continue;` then the `scopeKey`/`alreadyNotifiedToday`
     check, then build `title`/`body` per decision 4, then `createNotification`
     with:
     ```ts
     payload: {
       scopeKey, title, body,
       tagName: budget.tag.shortName,
       effectiveBudget: summary.effectiveBudget.toFixed(2),
       actualSpend: actualSpend.abs().toFixed(2),
       projectedTotal: evaluation.forecast.projectedTotal.abs().toFixed(2),
       projectedOverage: evaluation.projectedOverageAbs!.toFixed(2),
       confidence: evaluation.forecast.confidence,
       method: evaluation.forecast.method,
       trailingMonthsUsed: evaluation.forecast.trailingMonthsUsed,
       daysElapsed: evaluation.forecast.daysElapsed,
       daysInPeriod: evaluation.forecast.daysInPeriod,
       percentUsed: Math.round(summary.percentUsed),
     }
     ```
     `type: "budget_pace"`, `entityId: budget.entityId`, `userIds`.
   - Return `generated`.

3. Wire into `app/api/cron/notifications/route.ts`:
   - Add `checkBudgetPace` to the import list from `@/lib/notifications`.
   - Add it to the `Promise.all` array (e.g. `budgetPace = await checkBudgetPace(period)` alongside the others) and to both the `generated` sum and the returned JSON object (`budgetPace` key), following the exact existing pattern for every other check in that file.

4. Write `lib/__tests__/budget-pace.test.ts` (see Test expectations below).

5. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and confirm 307 existing tests
   still pass plus the new ones, zero regressions.

## Risks/unknowns

- **`spend-forecast.ts` API sufficiency:** confirmed sufficient for this task.
  `projectPeriodEndSpend` exposes everything `evaluateBudgetPace` needs
  (`projectedTotal`, `confidence`, `method`, `trailingMonthsUsed`,
  `daysElapsed`, `daysInPeriod`) with no gaps found. No change to that file is
  planned or needed.
- **`percentUsed >= 80` duplication:** the threshold is duplicated as a literal
  between `checkBudgetOverspend` (inline in `lib/notifications.ts`) and
  `evaluateBudgetPace` (`PACE_SUPPRESS_AT_PERCENT_USED` in `lib/budget-pace.ts`).
  This is an accepted, deliberate risk to avoid touching
  `checkBudgetOverspend`'s file for a one-line shared constant — if the 80%
  threshold ever becomes user-configurable (spec 05 calls it out as
  "thresholds configurable" but nothing in the current codebase implements that
  configurability yet), both places will need updating together. Flagging this
  now so it isn't a surprise later.
- **5% materiality margin and 80%-suppression are this plan's assumptions, not
  explicit user requirements.** The task said "decide and justify," which this
  plan does, but the exact numbers (5%, 80%, "low confidence suppressed
  entirely" rather than e.g. shown with a caveat) are judgment calls. If the
  user wants different tuning, that's a one-line constant change in
  `lib/budget-pace.ts`, not a redesign.
- **No per-user opt-out for `budget_pace`.** Matches `checkBudgetOverspend`'s
  existing behavior (also no opt-out), but means both budget-related
  notification types are "always on" while `policy_expiry`/`large_spend` are
  configurable. Not fixed in this task — flagged as a possible future
  inconsistency for the user to weigh in on, not something this plan silently
  resolves by adding new prefs plumbing (that would be scope creep).
- **`checkBudgetPace` itself is untested against a DB**, per the codebase's
  established convention (same as `checkCardPaymentsDue`/`checkCcFundingShortfall`).
  This means a wiring-level mistake (e.g. wrong `Map` key, wrong SQL column
  alias) would only surface at runtime against a real DB or via manual/staging
  verification, not in `pnpm test`. This is a known, accepted trade-off
  inherent to the existing testing pattern, not something this task changes.

## Acceptance criteria

1. `lib/budget-pace.ts` exports `evaluateBudgetPace`, `PACE_TRAILING_MONTHS`,
   `PACE_SUPPRESS_AT_PERCENT_USED`, `PACE_OVERAGE_MARGIN`, and
   `BudgetPaceEvaluation`. No DB imports, no `"use server"`.
2. `evaluateBudgetPace` correctly suppresses firing when: `percentUsed >= 80`;
   `confidence === "low"`; `effectiveBudget <= 0`; projected total is within
   5% of (or under) the effective budget.
3. `evaluateBudgetPace` correctly fires (returns `fire: true` with a populated
   `projectedOverageAbs`) when none of the above suppressions apply and the
   projection exceeds the budget by more than 5%.
4. `lib/notifications.ts` exports a new `checkBudgetPace(period: string): Promise<number>` that:
   - Queries budgets for the period, current-month actual spend per tag, and
     trailing `PACE_TRAILING_MONTHS` months of spend per tag from the DB.
   - Calls `evaluateBudgetPace` per budget and creates a `"budget_pace"`
     notification (via the existing `createNotification` helper) only when it
     fires and `alreadyNotifiedToday(scopeKey)` is false.
   - Notification body/title follow the exact templates in decision 4 — purely
     observational language, no advice.
   - `scopeKey` is `pace:${tagId}:${period}`, distinct from
     `checkBudgetOverspend`'s `overspend:${tagId}:${period}`.
5. `app/api/cron/notifications/route.ts` invokes `checkBudgetPace(period)`
   alongside the other checks and includes its count in the response.
6. `checkBudgetOverspend` is byte-for-byte unchanged in behavior — its existing
   tests in `lib/__tests__/notifications.test.ts` still pass with zero
   modification to that test file.
7. `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass clean; the full suite
   count is 307 + (new `budget-pace.test.ts` test count) with zero regressions
   and zero skipped/failing tests.
8. No Prisma schema changes, no new dependencies added to `package.json`.

## Test expectations

All new coverage lives in `lib/__tests__/budget-pace.test.ts`, testing
`evaluateBudgetPace` directly (pure function, `Decimal` fixtures, no mocks
needed — same style as `lib/__tests__/spend-forecast.test.ts`, reuse its
`D = (s) => new Decimal(s)` / `d = (iso) => new Date(iso + "T00:00:00Z")`
helper pattern and its `history(...)` builder for `MonthlySpendPoint[]`).
`checkBudgetPace` itself is intentionally NOT added to
`lib/__tests__/notifications.test.ts` (see Scope/Affected files above — matches
existing precedent for `checkCardPaymentsDue`/`checkCcFundingShortfall`).

Specific cases for `budget-pace.test.ts`:

1. **Fires** — high confidence (3/3 trailing months), actual spend below 80%
   used, projected total > 105% of effective budget. Assert `fire === true`,
   `projectedOverageAbs` equals the exact expected `Decimal` (compute by hand
   from the fixture, e.g. mirroring spend-forecast test 5's "-700 projected vs
   -300 budget" shape).
2. **Fires** — medium confidence (1–2 of 3 trailing months present, e.g. reuse
   spend-forecast test 9's fixture shape) and otherwise-qualifying inputs.
   Confirms medium confidence is NOT suppressed (only `"low"` is).
3. **Does not fire** — `confidence === "low"` (empty `history`), even though
   the bare pace projection alone would exceed budget. Assert `fire === false`.
4. **Does not fire** — `percentUsed >= 80` (e.g. `85`), even though the
   projection would otherwise exceed budget by a wide margin. Assert
   `fire === false`. Include a boundary case at exactly `percentUsed === 80`
   (suppressed — `>=`, not `>`).
5. **Does not fire** — projected total is under the effective budget (on pace,
   healthy) with high confidence. Assert `fire === false`,
   `projectedOverageAbs === null`.
6. **Does not fire** — projected total exceeds budget by less than the 5%
   margin (e.g. exactly 2% over). Assert `fire === false`. Include a boundary
   case just over the margin (e.g. 6% over) that DOES fire, to pin the exact
   cutoff behavior.
7. **Does not fire** — `effectiveBudget` is zero. Assert `fire === false`,
   no throw, no `NaN`/`Infinity` anywhere in the returned `forecast`.
8. **Does not fire** — `effectiveBudget` is negative (defensive case; shouldn't
   occur in practice but must not crash or produce a nonsensical `fire: true`).
9. **`forecast` is always populated** even when a guard suppresses firing
   before or after the `projectPeriodEndSpend` call (assert `result.forecast`
   is a well-formed `SpendForecast`, not `undefined`, across at least one
   suppressed case from each of tests 3–6 above).
10. **`trailingMonths` override threads through** — passing a custom
    `trailingMonths` (e.g. `1`) changes which suppression/fire outcome results
    for a fixture where the default `3` and an override of `1` would disagree
    (mirrors spend-forecast test 10's fixture shape).

Edge cases intentionally covered above because they're the ones a naive
implementation is likely to get wrong: the `>=` vs `>` boundary at 80%
`percentUsed`; the `>` vs `>=` boundary at the 5% margin; `"low"` vs
`"medium"` confidence being treated differently (only `"low"` suppresses);
zero/negative budget not crashing; `forecast` being populated even in
non-firing paths (a real caller — e.g. a future dashboard widget — may want
the raw projection even when it doesn't cross the alert threshold).

No integration/e2e test is planned for `checkBudgetPace` or the cron route
itself — consistent with the codebase's stated "no DB in unit tests" testing
pattern and the existing precedent of `checkCardPaymentsDue`/
`checkCcFundingShortfall` being untested at that layer.
