# Plan: net income + budget date wins (net-income-budget-dates)

Baseline = working tree INCLUDING the uncommitted credit-card-full-pay edits (forecast.ts, cc-funding.ts, upcoming-ledger*.ts, notifications.ts, app/forecast/page.tsx, advisor queries/tools, ...). A Tester is still verifying them. The Coder must re-read each file right before editing it, and should start after that task is committed (or at least keep this task's hunks separate). All new logic goes in NEW files; edits to existing files are small call-site swaps. `lib/forecast.ts` is NOT edited (wrapper design). Line endings: files are mixed LF/CRLF (git warns on several); edit in a way that preserves each file's existing endings.

## 1. Restated goal
(A) Every forecast path that uses a paycheck must use take-home (net), not the gross stored in `IncomeSource.amount`, with the basis stated, never silently gross. (B) For a bill tied to a Budget line, the occurrence date comes from that month's Budget row (money must be in the account then); the bank's few-day clearing lag is explanation only and never moves an item or triggers a "late" flag.

## 2. Evidence (read-only live run 2026-10-09, temp script deleted; no writes)

Sources: Eric "payroll (Alpine Bio Inc)" semi_monthly [15,31], 9000; Eva "payroll (Seacoast Mushrooms LLC)" biweekly anchor 2026-08-28, 2555. BOTH deposit into Primary Checking, so the account alone cannot separate them. Both confirmed Paystubs have `depositAccountId` NULL, so the stub cannot be tied to an account either.

Deposit matching rule (evidence): bank payee text (`Transaction.payeeNormalized`) is "alpine bio inc payroll" (12 rows since Mar) and "seacoast mushroo payroll" (13 rows): the bank TRUNCATES ("mushroo"). No other payroll-like payee exists in Primary Checking. So match = same account as the source + entity equal + amount > 0 + not a transfer pair + payee contains every employer token, where a payee token may be a prefix (>= 5 chars) of the employer token. Employer tokens come from the parenthetical in `IncomeSource.description` (the paystub sync writes it: `actions/paystubs.ts:132`) or the matched stub's `employerName`. Drop words inc/llc/corp/co/the. Do not require the word "payroll". Non-payroll inflows seen and correctly ignored: "iaic claim pymt" 943.74, "venmo" 914.74.

How many deposits: median of the most recent 6 (minimum 3, lookback 150 days, newest deposit must be within max(45 days, 2.5 cycles) of today or the source is treated as stale).

Backtest (each deposit vs the median of the N deposits before it):
| | deposits | median of prior 3 | prior 4 | prior 6 | latest stub net | gross as now |
|---|---|---|---|---|---|---|
| Eric (stub net 6064.85) | 12 | mean err $0.01, max $0.02 (n=9) | max $0.01 | max $0.01 | max $0.02 | off by $2,935 every paycheck (+48%) |
| Eva (stub net 2089.45) | 13 | mean $194, max $450 (n=10) | $184 / $319 (n=9) | $224 / $304 (n=7) | mean $171, max $389 | about $600 too high on average (+31%; deposits 1700.68 to 2259.28, mean 1953, last-6 median 2066.52) |
Conclusions: Eric is deposits == stub net to the cent (use deposits, "from your last 6 deposits"). Eva's pay genuinely varies (hours-based); no window size is clearly better, so use up to 6; show "about $2,066.52 (usually $1,700.68 to $2,259.28)". The stub net is a fine fallback (Eva's 2089.45 is inside the range).

Timing: Eva's deposits are Wednesdays every 14 days since Jul 1 (Jul 1, 15, 29, Aug 12, 26, Sep 9, 23, Oct 7); her source is anchored Fri 2026-08-28, so forecast paychecks land 2 days AFTER the money arrives (conservative for low-balance warnings, but wrong). Eric: deposits land 1-4 calendar days (1 or 2 business days) before the 15th / last day, mixed (Apr 14, 28; May 13, 27; Jun 11, 29; Jul 13, 29; Aug 12, 28; Sep 14, 28), no consistent rule. Also the forecast puts Eric on the stated day, i.e. later than the money arrives (conservative).

Bill vs Budget (live, Budget periods exist only 2026-09..12): the only real date disagreement is Solar (Budget day 14, bill day 17; history posts on the 17th/18th, i.e. lag ~3). Toyota, Northwestern Mutual, Amica, Progressive differ only because the 2026-09 Budget row has NO schedule (payDay null / frequency monthly) while Oct-Dec rows match the bill, which is exactly the "fall back to the bill when the period's row has no schedule" case. Lexus, Firewood, McCarthy, Doggy (weekly Wed agrees) have no conflict. Mortgage day 1 posts 3rd-5th; Northwestern Mutual day 2 posts 3rd-7th (lag evidence for the explanation text only).

Code facts that change the shape of the work:
- Late flag (`lib/recurring-detect.ts` `lateText`, lines ~824-852): monthly already measures from the OBSERVED posting day (circular median of matched rows) + 5 days grace, not from the recorded day, so Solar (due 14, posts 17) is not flagged until ~22nd today. Weekly/biweekly use last-seen + cycle. So the stated late-flag problem does not exist today; the one real gap is the reverse: if the owner moves a due date LATER (14 -> 20) while history still shows the 14th, "expected" stays at 14 and the flag fires on the 19th, before the 20th due date. Fix: for modelled monthly refs use max(observed day, recorded due day) (circular-aware, only when the due day is within 7 days after the observed day). Learned series keep today's logic.
- `checkLowBalance` (`lib/notifications.ts:298`) contains NO bills (transfers + paychecks only). Only its income source changes; adding bills there is out of scope (recommendation in section 9).
- `checkBillReminders` query filters `autopayDay not null OR frequency != monthly`; a bill whose own day is null but whose Budget row has a day would be dropped. The query must be widened and the "no resolvable date => no reminder" behavior preserved in code.
- `generateBillOccurrences` fabricates day 1 for a null monthly day (forecast page keeps this existing behavior; reminders/ledger gate it).
- Ledger Stage A: bill beats Budget row; the day mismatch is currently a `Discrepancy{kind:"day"}` rendered by `disagreementText` as "Records disagree: ...".

## 3. Scope
In: shared net-income resolver + loader; shared budget-date resolver + wrapper generator + loader; swap in every consumer below; Forecast page Income table labels + timing note; ledger date/notes; modelled-ref day; late-flag floor; clearing-lag explanatory text; tests.
Out: changing `IncomeSource.amount` data/meaning (stays gross on /personal/income and /settings/income-sources; only a column header relabel); changing any stored schedule (no Eva anchor edit, no Budget/bill edit); amount precedence between Budget/bill/recurring (unchanged); `lib/forecast.ts` generators; migrations/DB writes; tax code; app/envelope/page.tsx and review pages that show the bill RECORD's own day for editing/listing (left as the record); business-bucket forecast; adding bills to checkLowBalance.

## 4. Design

### 4.1 `lib/net-income.ts` (pure, no DB/clock; `today` passed in)
```ts
export type NetBasis = "deposits" | "paystub" | "gross_unknown";
export interface DepositRow { postedAt: Date; amount: Decimal; payee: string | null; accountId: string; entityId: string }
export interface StubRow { employerName: string | null; payDate: Date | null; payFrequency: string | null; grossPayCents: number | null; netPayCents: number | null; depositAccountId: string | null }
export interface IncomeSourceInput { id; accountId; entityId; description; cadence; dayRules: unknown; amount: Decimal|string|number; active: boolean }
export interface NetIncomeInfo { basis: NetBasis; net: Decimal; gross: Decimal; samples: number; min: Decimal|null; max: Decimal|null; variable: boolean; lastDepositOn: Date|null; stubPayDate: Date|null; label: string; assumption: boolean; timing: PayTimingNote|null }
export function employerTokens(description: string, stubEmployer?: string|null): string[]
export function matchDeposits(src, tokens, deposits): DepositRow[]
export function resolveNetIncome(src, deposits, stubs, today): NetIncomeInfo
export function payTimingNote(src, matched, today): PayTimingNote | null
```
Order: (a) deposits: >= 3 matched, newest fresh; sanity: drop amounts > gross*1.05 or < gross*0.25 (wrong match / advance); median of last <= 6 (even count: mean of middle two, 2 dp); `variable` when (max-min)/median > 5%. Label stable: "take-home $6,064.86, from your last 6 deposits"; variable: "about $2,066.52 take-home (usually $1,700.68 to $2,259.28), median of your last 6 deposits". (b) paystub: confirmedAt set (loader filters), netPay > 0, matched by employer tokens OR (gross == source amount within 1% AND payFrequency == cadence); if depositAccountId non-null it must equal the source account; newest payDate; label "take-home $X from your confirmed paystub of <date> (no recent deposits matched)". (c) otherwise net = gross, basis "gross_unknown", `assumption: true`, label "gross $X used, take-home unknown: confirm a paystub on the Income page". Never throws; money Decimal; no floats.
`payTimingNote`: for biweekly/weekly sources only, with >= 4 matched deposits in the last 6: if every deposit shares one weekday and all gaps are multiples of the cycle, and the source's own schedule dates fall on a different weekday, return {kind:"offset", depositWeekday, scheduleWeekday, days, suggestedAnchor: latest deposit date}. For semi_monthly/monthly return {kind:"irregular"|"early", text} (informational: "deposits arrive 1 to 4 days before the stated day; forecast uses the stated day"). NEVER alters dates; display/report only.

### 4.2 `lib/net-income-build.ts` (DB, read-only, no auth, explicit selects, fail-soft)
`loadNetIncomeSources(opts?: { where?: Prisma.IncomeSourceWhereInput; includeInactive?: boolean; withAccount?: boolean; withEntity?: boolean; take?: number; now?: Date }): Promise<NetIncomeSourceRow[]>`
- Reads sources (active by default; orderBy description,id), then in parallel: `transaction.findMany` (accountId in the sources' accounts, archivedAt null, transferPairId null, amount > 0, postedAt >= now-150d, select postedAt/amount/payeeNormalized/accountId/entityId, take 400) and `paystub.findMany` (archivedAt null, confirmedAt not null, netPayCents not null, select 6 fields, orderBy payDate desc, take 24).
- Returns rows = the source fields with `amount` REPLACED by the net Decimal, plus `grossAmount`, `amountBasis`, `netInfo` (NetIncomeInfo) and optional `account {nickname, mask}` / `entity {name}`. Source read errors propagate (callers are already fail-soft); deposit/stub read errors are caught (log `err.name` only) and degrade to basis "gross_unknown" with label "take-home could not be read".
- Matching is local text compare only; no names go to any model; advisor output gets amounts, counts and the label only (no new employer-name field).

### 4.3 `lib/bill-dates.ts` (pure) and `lib/bill-dates-build.ts` (DB read-only)
```ts
export interface BudgetScheduleRow { entityId; tagId; period; payDay: number|null; frequency: string; payDayOfWeek: number|null; biweeklyAnchorDate: Date|string|null; payMonth: number|null; annualAmountDue: Decimal|string|number|null }
export type BudgetScheduleIndex = Map<string /* `${entityId}|${tagId}` */, Map<string /* YYYY-MM */, BudgetScheduleRow>>
export function budgetKeyOfBill(b): string | null      // `${b.budgetEntityId ?? b.entityId}|${b.budgetTagId}`; null when untagged
export function budgetRowUsable(row, bill): boolean
export function effectiveSchedule(bill, index, period): { fields; basis: "budget"|"bill"; budgetDay: number|null; recordDay: number|null }
export function generateBillOccurrencesBudgetDated(bill, index, from, to, draws?): ScheduleEvent[]
```
Month-by-month algorithm (`generateBillOccurrencesBudgetDated`):
1. If `bill.amountType==="accrued" && draws.length>0` or no tag key or index empty: return `generateBillOccurrences(bill, from, to, draws)` unchanged (draw dates are their own dates).
2. For each calendar month M (UTC) overlapping [from,to): window_M = [max(from, M start), min(to, next M start)); row = index.get(key).get("YYYY-MM"); `usable` = row exists AND schedule complete for its frequency (monthly: payDay; weekly: payDayOfWeek; biweekly: biweeklyAnchorDate; annual/semiannual: payDay AND payMonth) AND amounts stay valid: if row frequency is lump-sum it needs `bill.annualBudget` (amount precedence stays the bill's) and a lump-sum bill is not given a non-lump row; a row with `payDay` null and frequency "monthly" is "no schedule" (live: the 2026-09 rows).
3. clone = bill with {frequency, autopayDay, payDayOfWeek, biweeklyAnchorDate, payMonth} taken from the row when usable, else the bill's own; amount fields (`expectedAmount`, `annualBudget`, `amountType`, account, payee) ALWAYS the bill's. Call `generateBillOccurrences(clone, windowStart, windowEnd, [])` and concat.
 - monthly: day clamped by the existing `allMonthDays` (31 -> month end). weekly: Budget `payDayOfWeek` weekdays inside the month window. biweekly: 14-day cycle from that month's Budget anchor, restricted to the month (two different anchors in adjacent months restart the cycle; documented limitation). annual/semiannual: the generator's year x dueMonths loop filtered to the window (`annualDueDate` clamps Feb 29/30).
4. Month with no Budget row (e.g. 2027 today) or unusable row: the bill's own schedule (same as today).
Loader `loadBudgetScheduleIndex({ from, to, keys?: string[] }): Promise<{ index: BudgetScheduleIndex; failed: boolean }>`: `budget.findMany` where period in the months touched, select the 8 fields above (explicit), build the index; on error return empty index + `failed:true` (callers then behave exactly as before and may show one muted note).

### 4.4 `lib/clearing-lag` (inside `lib/recurring-detect.ts`, exported)
`clearingLagFor(refs: ModelledRef[], rows): Map<sourceId, { typicalDay: number; lagDays: number; samples: number }>`: reuse `matchRows` + `occurrencesOf`; only monthly outflow refs with a recorded day; needs >= 3 matched payments in the last 6 months with day spread <= 2 (circular) and 1 <= lag <= 7. Surfaced through `runDetection` bundle (`clearing`), consumed only by `lib/upcoming-ledger-build.ts` to append a note. Pure explanatory text; never moves a date.

## 5. Consumers: exact before / after

Income (all become `loadNetIncomeSources`, no module outside the allow-list reads `incomeSource` amounts):
| File (current line) | Before | After |
|---|---|---|
| app/forecast/page.tsx:107 (+348, 440, 522) | `db.incomeSource.findMany` gross into 3 generator calls + table | loader (withAccount, withEntity); generator calls unchanged; table shows both (see 6) |
| lib/account-scheduled-flows.ts:45 | raw select incl. amount | loader `{ where: { accountId } }` |
| lib/upcoming-ledger-input.ts:153 (+266) | raw select | loader (entity filter via `where`); `UpcomingIncomeRow` gains optional `grossAmount`, `amountBasis`, `netLabel` |
| lib/upcoming-ledger.ts:1376 / 1760 | paycheck item `scheduled`, amount = gross; modelled ref `expectedAmount` = gross | item amount = net; tier `estimated` + tierNote when variable or gross_unknown, plain `scheduled` + note when exact; note carries the label; ref expectedAmount = net |
| lib/advisor/queries/forecast.ts:87 + tools/get-forecast.ts:60 | gross `incomes` | loader; tool `notes` gains one sentence "Paychecks are take-home (median of recent deposits or latest paystub); an income source with unknown take-home uses gross and is marked." and event description for such a paycheck gets " (gross, take-home unknown)" |
| lib/advisor/queries/schedule.ts:114 + tools/list-recurring-and-scheduled.ts:118 | `amount` gross | loader (`where` entity match, take); fields `gross_amount`, `take_home`, `take_home_basis` |
| lib/notifications.ts:309,326 (checkLowBalance) | `incomeSources` include, gross | loader per account (`where:{accountId}`) |
| actions/envelope.ts:508,539 (getEnvelopeForecastData) | include, gross | loader per account |
| lib/advisor-context.ts:62,225 | `Number(s.amount)` gross | loader; line prints take-home plus "(gross $X)" |
| lib/business-forecast.ts:7 | comment only | no change |
Unchanged on purpose (gross is correct there): app/personal/income/page.tsx + components/income/income-sources-card.tsx (header "Per paycheck" -> "Gross per paycheck"), app/settings/income-sources/**, actions/income-sources.ts, actions/paystubs.ts (writer), the "Add income source" form label on the Forecast page ("Amount" -> "Gross amount per paycheck").

Bills (all become `generateBillOccurrencesBudgetDated` + `loadBudgetScheduleIndex`; ScheduledBill queries keep their selects):
| File | Before | After |
|---|---|---|
| app/forecast/page.tsx:349, 445, 527 | `generateBillOccurrences(b, ...)` | wrapper with one index loaded for [today, today+90d] (a `billEvents(b, from, to)` closure replaces the 3 calls) |
| lib/account-scheduled-flows.ts:71 | bill record dates | wrapper; loads the index for [from,to) |
| lib/advisor/queries/forecast.ts + tools/get-forecast.ts:62 | bill record dates | `ForecastInputs.budgetIndex` + wrapper; note sentence "Bills are dated by the budget line when one exists" |
| lib/upcoming-ledger-input.ts / upcoming-ledger.ts | bill record date wins; day mismatch is a "Records disagree" discrepancy | the bill obligation expands one payload per month in the window (`Shape.payloads` already supports a list; add an optional month restriction to the payload and filter events like `o.period` does); `Obligation.day`, `billDay` and `ModelledRef.day` use the CURRENT period's effective day; `compare()` no longer emits kind "day" between a bill and its OWN Budget row (amount discrepancies and recurring-expense day discrepancies stay) |
| lib/notifications.ts:485 checkBillReminders | `scheduledBill` where autopayDay/frequency filter; record date | query widened to all active tagged-or-day bills; wrapper; skip a bill with no resolvable date (keeps today's "no fabricated day 1" behavior); reminder fires `daysAhead` before the BUDGET date; scopeKey/body unchanged |
| lib/notifications.ts:298 checkLowBalance | no bills | unchanged except income (net) |
| actions/envelope.ts:532-537, 566-568, 623-625 | `generateBillOccurrences`; `billsThisMonth.dueDay = b.autopayDay` | wrapper; `dueDay` = effective current-period day |
Left as the bill RECORD (listing/editing, not forecasting): app/envelope/page.tsx edit form, lib/monthly-review-build.ts + app/review page, advisor `list_recurring_and_scheduled` bill timing (add `budget_day` field only when it differs, so the model is not told two dates).

## 6. UI and wording
- Forecast "Income Sources" table (app/forecast/page.tsx ~1077-1112): columns Description | Cadence | "Take-home used" | Gross | Account. Under the description, a muted line = `netInfo.label` ("from your last 6 deposits", "about ..., usually $1,700.68 to $2,259.28"). `gross_unknown`: amber text "Gross used, take-home unknown". Pay-timing note (muted, Eva): "Deposits arrive on Wednesdays; this schedule starts Fri Aug 28, so forecast paychecks land 2 days after the money does. To match, set the first paycheck date to Wed Aug 26 in Settings > Income sources. Nothing was changed." Eric: "Deposits arrive 1 to 4 days before the stated day; the forecast uses the stated day."
- Ledger: day-mismatch becomes an info line (new `UiItem.dateNote`, muted style in `components/upcoming/upcoming-parts.tsx`, NOT the discrepancy style): "Dated by the budget (day 14) because the money has to be in the account then. The bill record says day 17. The bank may take a few days to clear it." plus, when `clearing` has data: "Usually clears about the 17th." Wording observational, no advice.
- Notifications body unchanged.

## 7. Ordered steps (each checkable)
1. Write `lib/net-income.ts` + unit tests (matching, truncated payee, tokens, sanity filters, median even/odd, staleness, stub fallback, gross_unknown, timing note). Done = tests green.
2. Write `lib/net-income-build.ts` (+ mock-db loader test incl. degraded read). Done = explicit selects, no `any`, fail-soft proven.
3. Swap income consumers one file at a time per section 5 table; update the mocks in affected tests (notifications, account-scheduled-flows-failsoft, card-full-pay-tester-loader, advisor-phase2-tester-selects, advisor-tools-money/business). Done = `pnpm typecheck` + those tests green.
4. Forecast page Income table + labels; Income page header relabel. Done = render check on `/forecast` and `/personal/income`.
5. Write `lib/bill-dates.ts` + `lib/bill-dates-build.ts` + tests (algorithm cases in section 8).
6. Swap bill consumers per table (forecast page, account flows, advisor, notifications, envelope action).
7. Ledger: per-month payloads, effective day, `compare()` change, `dateNote` in view + parts, update the "Records disagree" day tests.
8. Detector: `lateText` due-day floor for modelled monthly refs; `ModelledRef.altDay` so suppression's amount+day rule accepts either the budget or the record day; `clearingLagFor`; ledger-build note.
9. Guard test (section 8). Run `pnpm typecheck && pnpm lint && pnpm test`, then manual: /forecast, /upcoming, /personal/income.

## 8. Tests
- `net-income.test.ts` (pure): Eric-like stable (6064.85-.87) -> 6064.86 basis deposits, not "about"; Eva-like variable -> median + range + "about"; "mushroo" truncated payee matches; transfer/refund/venmo/claim rows ignored; both sources in ONE account do not cross-match; 2 deposits -> stub; stub gross != amount -> not used; no stub, no deposits -> gross_unknown + `assumption`; stale newest deposit -> not deposits; deposit above gross ignored; Decimal results (no float drift); timing note: Eva Wed vs Fri anchor -> offset 2 + suggestedAnchor 2026-08-26, Eric -> irregular, never changes dates.
- `net-income-build` loader test: explicit selects, entity equality enforced, deposit read failure degrades to gross_unknown with label, source read failure propagates.
- `bill-dates.test.ts`: Solar (record 17, Budget 14) -> 14th each month; month without Budget row -> record day; Sep-style row (payDay null, monthly) -> record day; Budget day 31 in Nov/Feb -> clamped; weekly Budget Wed vs record Mon -> Wednesdays; biweekly anchor from the month's row, window split mid-month produces no duplicates/gaps across the month boundary; annual/semiannual Budget payDay/payMonth with the BILL's annualBudget; lump row with bill lacking annualBudget -> falls back; accrued-with-draws untouched; amounts identical to the unwrapped generator (precedence unchanged); untagged bill unchanged; empty index == old behavior (golden compare against `generateBillOccurrences`).
- Consumers: forecast/advisor `get_forecast` event dates and paycheck amounts; `checkBillReminders` fires N days before the Budget date, no reminder when no resolvable date, widened query still skips a null/null bill; `checkLowBalance` uses net.
- Ledger: dated by Budget, no "Records disagree" for day, `dateNote` text, amount discrepancy still shown, held-back/same-obligation logic and Stage A precedence unchanged (existing suppression tests stay green), paycheck item amount/tier/notes for each basis.
- Detector: due 14th, clears 17th: not flagged on 15/16/20, flagged ~23rd+; due moved 14 -> 20 with history on the 14th: not flagged on 19th (new floor); learned series unchanged; `ModelledRef.altDay` suppression; `clearingLagFor` (needs >=3, spread <=2, lag 1..7) and note text.
- Guard `net-income-guard.test.ts` (source-scan, pattern of `card-full-pay-guard.test.ts`): the listed consumer files must not match `/incomeSource\.(findMany|findFirst)|incomeSources:\s*\{/` nor `generateBillOccurrences\(` (only `lib/bill-dates.ts` and `lib/forecast.ts` may call/define it, plus tests); `lib/net-income-build.ts` is the only non-writer module that reads `db.incomeSource`. Allow-list (comments say why): actions/income-sources.ts, actions/paystubs.ts, actions/envelope.ts `upsertIncomeSource` (writer), app/settings/income-sources/page.tsx, app/personal/income/page.tsx (gross display).
- Existing tests that encode gross income or bill-record dates are updated with an explanation in the test (ledger render/view/tester day-disagreement cases; upcoming-ledger income cases; notifications mocks).

## 9. Risks / unknowns
- Uncommitted card-full-pay work in the same files: highest merge risk; sequence after its commit or keep hunks tiny.
- Net is an estimate for Eva (spread about +-$300); the UI says "about" and shows the range. Pre-tax changes (401k, new benefits) show up after 3 new deposits; a stub is not needed to adapt.
- Bonus or off-cycle payroll deposits skew only the min/max, not the median.
- A source description without the employer in parentheses (manually added) cannot be matched by payee: falls to a stub matched by gross == amount, else gross_unknown (flagged). Matching uses payee text; if the bank renames the payee the net silently drops to the stub (label says so).
- `ScheduledBill` is one row per category overwritten by whichever period saved last; Budget exists only for 2026-09..12 now. For 2027 months the bill's (latest-saved) schedule is used, which is the best available but can be stale; labelled in notes only through the ledger line when no row exists ("No budget line for <period>" already exists).
- Biweekly bills with different anchors in adjacent months restart the cycle (rare; no live case).
- Recommendation (NOT in scope): checkLowBalance ignores bills and card payments entirely, so its warnings are optimistic; worth its own task. Also recommend the owner edit Eva's anchor to Wed 2026-08-26.
- Wording check: all new owner-visible text is observational ("usually", "about"); no tax/CPA wording touched.

## 10. Acceptance criteria
1. On /forecast the Income table shows take-home used (Eric $6,064.86 "from your last 6 deposits"; Eva about $2,066.52 with range) AND gross, and every projected paycheck uses take-home; none uses 9000 or 2555.
2. A source with no usable deposits/stub shows gross with the "take-home unknown" flag everywhere it appears (page, ledger tier note, advisor).
3. `IncomeSource.amount` values and the Income/Settings pages are unchanged except the "Gross per paycheck" header.
4. Solar occurs on the 14th (not 17th) in the forecast chart, 14-day schedule, account flows, advisor `get_forecast`, Upcoming ledger, reminders (fire relative to the 14th) and envelope data; a month without a usable Budget schedule still uses the bill's day; amounts unchanged.
5. Ledger shows the info line (no "Records disagree" for day) with the clearing explanation when history supports it; amount mismatches still show "Records disagree".
6. A bill due the 14th that clears the 17th is not flagged late on the 15th/16th/20th; a bill whose due date moved later is not flagged before its new date.
7. Pay timing is reported (Eva offset note, Eric irregular note) and nothing is auto-shifted.
8. Guard test passes; `pnpm typecheck`, `pnpm lint`, `pnpm test` green; no migration, no DB writes, no new `any`.

## 11. Owner questions (none blocking; defaults used)
1. Eva's pay arrives Wednesdays but the schedule starts Friday Aug 28. Default: show a note, change nothing; you edit the first paycheck date to Aug 26 if you agree.
2. Eric's deposits land 1-4 days before the 15th and month end with no fixed rule. Default: keep the stated days (conservative).
3. When a month has no budget line yet (2027), use the bill's saved day. Default: yes.
4. Should low-balance warnings also include bills and card payments (they currently do not)? Default: not in this task.
5. Eva's take-home varies; default shows the median of her last 6 deposits "about $2,066".

## 12. Files
New: lib/net-income.ts, lib/net-income-build.ts, lib/bill-dates.ts, lib/bill-dates-build.ts, lib/__tests__/{net-income,net-income-build,bill-dates,net-income-guard,late-flag-budget-date}.test.ts.
Edited: app/forecast/page.tsx, lib/account-scheduled-flows.ts, lib/upcoming-ledger-input.ts, lib/upcoming-ledger.ts, lib/upcoming-ledger-view.ts, lib/upcoming-ledger-build.ts, components/upcoming/upcoming-parts.tsx, lib/recurring-detect.ts, lib/recurring-detect-build.ts, lib/notifications.ts, actions/envelope.ts, lib/advisor/queries/{forecast,schedule}.ts, lib/advisor/tools/{get-forecast,list-recurring-and-scheduled}.ts, lib/advisor-context.ts, components/income/income-sources-card.tsx (header), plus the test files named in step 3 and the ledger day-disagreement tests. CLAUDE.md: one sentence under the Forecast/ledger text after merge (Coder may leave to Reviewer).
