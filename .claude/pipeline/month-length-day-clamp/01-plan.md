# Plan: month-length-day-clamp

## Restated goal
In `lib/forecast.ts`, a day-of-month that a month is too short to have (29/30/31) must land on that month's last day instead of vanishing, and a rule listing several such days (e.g. `[30, 31]`) must give one date, not two, in a month where they collapse.

## Scope
In:
- Rewrite the body of `allMonthDays` (lib/forecast.ts:56-78) to clamp and dedupe. This is the single source; all 6 call sites go through it (lines 140, 143, 201, 215, 387, 404).
- Update the tests and comments/docs that describe the old skip behavior (listed below).
- New tests for the clamp.

Out (do not touch):
- `annualDueDate` / the lump-sum (annual, semiannual) branch in `generateBillOccurrences` and `lib/annual-bill.ts`: verified it ALREADY clamps (`Math.min(day, daysInMonth)`, annual-bill.ts:69-71), pinned by forecast.test.ts:469-475 and upcoming-ledger tests (:141-142, tester :563-564). No change.
- `allWeekdays`, `allBiweekly` (weekly/biweekly), `generateCardStatementPayment`, accrual-draw dates.
- Any per-caller logic, DB schema, migrations, DB data, UI components, advisor tool code. No live data changes.
- Behavior for day < 1 or non-integer days: leave as it is today (not a requirement; do not add validation).
- Shrinking the 65-day horizon in `checkBillReminders` (see Approach step 3).

## Decision: fix at the single source
Per-caller fixes would need 6 edits plus every future caller. `allMonthDays` is a private (non-exported) helper, so there is no other consumer. Fix it once there.

Callers verified by reading (all via forecast.ts generators): `app/forecast/page.tsx` (270, 402-410, 494-502), `actions/envelope.ts` (524-540), `lib/notifications.ts` (323-327 low-balance check, 505 `checkBillReminders`), `lib/upcoming-ledger.ts` (474, 1153, 1182), `lib/advisor/tools/get-forecast.ts` (58-61). Downstream of `buildAccountForecast`/`DayForecast`: `lib/forecast-rollup.ts` (monthly/quarterly buckets). `lib/business-forecast.ts`, `business-quarter-forecast.ts`, `review-forecast.ts`, `spend-forecast.ts` do NOT call the generators (they have their own month-length helpers; I grepped imports and `Date.UTC` use, not read in full) so they change only if they consume DayForecast data, which rollup does.

Not verified: `lib/business-forecast.ts` was only grepped, not read in full. The Coder should confirm it does not import `allMonthDays`-derived events (it does not import `lib/forecast` per grep).

## Approach
1. In `allMonthDays`, per month compute `daysInMonth`, map each listed day to `Math.min(day, daysInMonth)`, de-duplicate with a `Set` (so `[30,31]` in Nov/Feb gives one date), build `Date.UTC(year, month, clampedDay)`, keep the existing `d >= from && d < to` filter, keep the final ascending sort. Keep UTC throughout. Update the doc comment ("clamped to the month's last day; duplicates collapse"). Do not change the month-walk loop.
2. Update stale comments/docs:
   - `lib/upcoming-ledger.ts` lines 10-16 ("KNOWN INHERITED GAP"): remove/replace with a one-line note that days 29-31 clamp to the last day via `allMonthDays`.
   - `CLAUDE.md` "Upcoming ledger" paragraph: delete the "Inherited gap: `allMonthDays` skips ..." sentences (and the "a missing day-29/30/31 line in a short ... is a known gap" clause that follows); state that days 29-31 clamp to the month's last day. Edit with care: that paragraph is one very long line; the Coder must read the whole sentence group before cutting.
3. `lib/notifications.ts` 493-497 comment and `horizon = 65 days`: the comment explains 65 as covering a day-31 bill skipping February (Feb 1 -> Mar 31). After the fix the longest gap between consecutive monthly occurrences is 31 days, so the reason is gone. Recommended minimal change: reword the comment only (65 days still covers every cadence and costs nothing); do not alter the number. If the Coder prefers to shrink the horizon, that is a separate decision and needs a test update; default is leave the number.
4. Run `pnpm vitest run` for the full suite and `pnpm typecheck`, `pnpm lint`. Fix any test that relied on skipping (expected: none, see next section). Do not weaken assertions to make tests pass; update only an expectation that encoded the old skip.

## Existing tests that pin the old behavior
Searched for 29/30/31 day rules and short-month dates across `lib/__tests__`: I found NO test that asserts a skipped occurrence. Fixtures with day 30/31 and their windows:
- forecast.test.ts:184-198 `[15,30]` Jun-Jul: both months have 30 days, unchanged.
- upcoming-ledger.test.ts:291-305 Eric `[15,31]`, 30 days from 2026-10-08: Oct 31 exists, unchanged (expects `2026-10-15, 2026-10-31`).
- upcoming-ledger.test.ts:591-605 Toyota day 30 Oct-Dec, and :685, view :187: Nov has 30, unchanged.
- income-sources.test.ts:49-57, advisor-tools-business.test.ts:221-229, schedule-display.test.ts:117: no generator date math through a short month.
I did not run the suite (planner does not modify code). The Coder must run it; any failure in a test with a window crossing Feb/Apr/Jun/Sep/Nov is the thing to look for (e.g. 365-day ledger windows at upcoming-ledger.test.ts:128 use annual bills, which already clamp).

## Live-data effect (read-only query run 2026-10-08, temp script deleted, no writes)
Active rows with a day >= 29:
- ScheduledBill: one, "Toyota Financial — Eric truck", personal, monthly, day 30.
- ScheduledTransfer: none (4 active transfers, none with 29-31).
- IncomeSource: one, "Eric Kinniburgh payroll (Alpine Bio Inc)", semi_monthly, `daysOfMonth` contains 29-31 (the printout showed `[Array]`; the Tester/ledger fixture say `[15, 31]`; Coder should re-read the exact values).
- Budget: only Toyota/Tacoma payment day 30 for periods 2026-10, 2026-11, 2026-12.
So the whole live effect is Eric's payroll (Sep/Nov/Feb/Apr/Jun 30-or-28/29 dates) and the Toyota bill/budget in February (2027 and later).

## Owner-facing description of what visibly changes
- Eric's second paycheck of the month now appears on the last day of every short month: Nov 30 ($9,000 gross-as-entered), then Feb 28 2027, Apr 30, Jun 30, Sep 30. On the Forecast page (90-day charts, today -> about Jan 6 2027) the only change is the Nov 30 paycheck: the personal account balance line steps up by $9,000 on Nov 30 and stays higher from there on. Any "below minimum balance" days between Nov 30 and the next income date can disappear, and "lowest projected balance" and the low-balance warnings improve accordingly.
- Monthly income totals in the forecast rollup for November (and Feb, Apr, Jun, Sep 2027) rise by one paycheck each, and the 14-day / 90-day views match.
- Toyota day 30: nothing changes in Oct-Jan (Nov and Dec already have a 30th); from February 2027 a $420 Toyota payment appears on Feb 28 (it used to be missing in February, and the next payment showed Mar 30).
- Upcoming ledger (/ and /forecast): the same Nov 30 paycheck appears; no more silent missing lines. Advisor `get_forecast` reports the same numbers as the charts.
- Bill reminders: a day-30/31 bill now gets its reminder in short months (Toyota on Feb 28); before, there was none that month.
- Nothing is changed for day-15, weekly or biweekly items (Eva's biweekly pay, Doggy Daycare weekly), annual/semi-annual bills, or any stored data.

## Risks / unknowns
- Duplicate-collapse semantics: `[30,31]` in a 30-day month now yields ONE date (as the owner approved). A rule like `[28,29,30,31]` in Feb gives one date on Feb 28. This reduces occurrences vs. listing both days; intended.
- Mixed rules: `[15,31]` pay rule vs a separate day-30 bill collide on Nov 30 etc. — harmless (different events).
- Ledger merging: a Budget row with day 30 and a bill with day 31 in a 30-day month now fall on the same date; the ledger's de-dupe/disagreement logic may start treating them as same-day. Not seen in live data (only Toyota day 30 on both). Low risk; Coder should glance at upcoming-ledger matching after the change if the suite passes only by luck.
- Past-dated charts: forecast starts today, so no historical balance recomputation. Notification dedupe keys use the occurrence date (`bill_due:<id>:<date>`), so a Feb 28 reminder is a new key; no duplicate notices.
- Fixed `from` mid-month on a clamped day (e.g. from = Feb 28, rule day 30): the date is Feb 28 and is included (>= from). Correct and expected; test it.
- Assumption: the live Eric payroll rule is `[15, 31]` (from fixtures/memory), verified only as "contains a 29-31 value".
- Recommendation only (not in scope): none needed; no migration.

## Acceptance criteria
1. `allMonthDays` clamps: day 31 in Feb 2027 -> Feb 28, in Feb 2028 -> Feb 29, in Apr/Jun/Sep/Nov -> the 30th; day 30 in Feb -> 28/29; day 29 in Feb 2027 -> Feb 28, Feb 2028 -> Feb 29.
2. `[30, 31]` or `[15, 30, 31]` in a short month gives no duplicate dates; in a 31-day month gives both.
3. Output ascending, window `[from, to)` respected; day 15 and weekly/biweekly results byte-identical to before.
4. Full-year check: Eric `[15,31]` over a calendar year yields 24 dates, with Nov 30, Feb 28, Apr 30, Jun 30, Sep 30 present.
5. `annualDueDate` and annual/semiannual behavior unchanged (existing tests still pass).
6. Stale comments in `lib/upcoming-ledger.ts`, `lib/notifications.ts` and `CLAUDE.md` no longer describe skipping.
7. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; no DB/migration/schema change; no file under `lib/tax2025/**` or `lib/tax-review/**` touched.

## Test expectations (unit only, pure; mock at function boundary; use `d()`/makers already in `lib/__tests__/forecast.test.ts`)
Add to `lib/__tests__/forecast.test.ts` via the exported generators (allMonthDays is private; do not export it just for tests):
- Monthly bill day 31 across Jan-Dec 2027: dates are Jan 31, Feb 28, Mar 31, Apr 30, May 31, Jun 30, Jul 31, Aug 31, Sep 30, Oct 31, Nov 30, Dec 31.
- Feb leap vs non-leap: day 29/30/31 -> 2028-02-29 and 2027-02-28.
- 30-day months: day 31 -> the 30th; day 30 stays the 30th.
- Income `semi_monthly [15,31]` Oct 2026 - Jan 2027: includes 2026-11-30 (the $9,000 case) and 2026-12-31, exactly 2 per month.
- `[30,31]` dedupe: Nov 2026 gives exactly one date (Nov 30), Dec gives two; transfer legs stay in pairs (one out + one in per date).
- Day 15 and `[1,15]` unchanged; weekly and biweekly outputs unchanged (reuse existing tests).
- Window edges: `from` equal to the clamped date is included, `to` equal to it is excluded; `from` after a clamped date in the same month excludes it; a window ending Mar 1 00:00Z includes Feb 28; a window that starts on Feb 28 with day-30 rule includes Feb 28.
- UTC: dates are `T00:00:00.000Z`; use `from` values with a non-midnight UTC time to confirm no off-by-one and no local-time dependence (also run once with `TZ=America/New_York` if easy).
- Accrued bill branch (`generateBillOccurrences` with `amountType: "accrued"`, no draws, day 31) clamps like static bills.
- Annual bill day 30 in Feb still `2027-02-28` (guard that existing behavior did not move).
- Optionally one `checkBillReminders` test in notifications.test.ts: a day-31 bill with now = Feb 1 finds Feb 28 as next occurrence (only if the existing mock harness makes this cheap; otherwise skip).
Update/add: one ledger test (upcoming-ledger.test.ts) that a `[15,31]` paycheck over a window covering Nov 2026 includes `2026-11-30`, replacing nothing (the existing Oct test stays).

## Notes for Coder
- No other file should need code changes. If the full suite shows a failure outside the files above, stop and report rather than patching around it.
- After implementing, memory/docs in `.claude/` are not the Coder's job.
