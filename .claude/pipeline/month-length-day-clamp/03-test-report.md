# Test report: month-length-day-clamp

## Verdict: PASS

No defects found in the change. All acceptance criteria that were in scope at the time of testing pass with evidence below. One note on timing: criterion 6 (stale comments/docs) was partly outside the Coder's pass 1, but by the time I ran, `lib/upcoming-ledger.ts` and `CLAUDE.md` had already been edited (see criterion 6).

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `allMonthDays` clamps: 31 in Feb 2027 -> 28, Feb 2028 -> 29, Apr/Jun/Sep/Nov -> 30th; 30 and 29 in Feb -> 28/29 | PASS | Coder test + tester tests (leap/century block: 2024/2028/2000/2400 leap; 1900/2100/2200/2026/2027 not). Oracle fuzz (3000 cases) agrees. |
| 2 | `[30,31]` / `[15,30,31]` give no duplicate in short month; both dates in a 31-day month | PASS | Tester: `[30,30,31]` Dec -> 30,31; Nov -> 30 only. `[30,31]` transfer legs 1:1 in all 12 months of 2027 (19 dates). Mutation M2 (no de-dupe) is killed (9 failures). |
| 3 | Output ascending, `[from,to)` respected, day 15 / weekly / biweekly unchanged | PASS | Fuzz asserts strictly ascending, unique, UTC midnight, inside the window. Old-vs-new differential: identical when every day is <= 28 (after collapsing literal duplicates in the rule list), and a superset of old output otherwise (1500 cases). Weekly and biweekly bills with autopayDay 31 unchanged. |
| 4 | Eric `[15,31]` over a calendar year gives 24 dates incl. Nov 30, Feb 28, Apr 30, Jun 30, Sep 30 | PASS | Coder test; live run of the real generator over calendar 2027 returned 24 for Eric's payroll. |
| 5 | `annualDueDate` / annual / semiannual unchanged | PASS | Tester: annual day 31 pay month 2 -> 2027-02-28; semiannual -> 2027-02-28 and 2027-08-31. Existing `forecast.test.ts` and `annual-bill.test.ts` pass. |
| 6 | Stale comments in upcoming-ledger.ts, notifications.ts, CLAUDE.md no longer describe skipping | PASS (observed state) | `notifications.ts` comment reworded (value still `65 * 86400000`). `lib/upcoming-ledger.ts` "KNOWN INHERITED GAP" block now replaced with a 2-line clamp note. `grep -c "Inherited gap" CLAUDE.md` = 0 (CLAUDE.md shows a 1-line diff). I did not review the CLAUDE.md wording; that is the Reviewer's job. These edits landed while I was testing, so my full-suite run (410 files) includes them. |
| 7 | typecheck, lint, test pass; no DB/migration/schema; nothing under `lib/tax2025/**` or `lib/tax-review/**` touched | PASS | See commands. `git status` shows only forecast.ts, notifications.ts, upcoming-ledger.ts, CLAUDE.md modified plus the two new test files (other untracked items are other tasks' pipeline folders). |

## Commands run (real results)

- `pnpm typecheck` -> `tsc --noEmit`, exit 0, no output (run twice).
- `pnpm lint` -> `52 problems (0 errors, 52 warnings)`, all pre-existing style warnings (run twice, same count).
- `pnpm test` (first run, Coder's files only): `Test Files 409 passed (409)`, `Tests 11719 passed (11719)`.
- `pnpm test` (second run, with my tester file and the Coder's later doc edits): `Test Files 410 passed (410)`, `Tests 11738 passed (11738)`, duration ~250s. No failures.
- `TZ=America/New_York` and `TZ=Pacific/Kiritimati` on both clamp test files: 40/40 pass each.

## Tests added

`lib/__tests__/month-length-clamp-tester.test.ts` (19 tests):
- Oracle fuzz, 3000 random day lists (1-5 days from 1..31) and windows (years 1899, 1900, 2024-2028, 2099, 2100, with and without non-midnight times) compared with an independent oracle (own leap rule, per-month `min(day,last)`, set, filter `[from,to)`, sort) via `generateIncomeOccurrences`, `generateTransferOccurrences` (both legs), `generateBillOccurrences` (static and accrued), and monthly income.
- Ascending/unique/UTC-midnight/in-window invariant fuzz (500 cases).
- Differential against a pasted copy of the OLD skip implementation (1500 cases).
- Leap and century years (1900, 2000, 2100, 2200, 2400), `[28,29,30,31]` in Feb, year boundary.
- Window edges (from == clamped date, to == clamped date, empty window), day 0 and -1 behavior unchanged, weekly/biweekly bills ignore the clamp, annual/semiannual unchanged, accrued-with-draws ignores it, null autopayDay -> day 1, empty list, default `[15,30]`.
- Downstream: `buildAccountForecast` with Eric `[15,31]` (Nov 30 has exactly one 9000 event, balance steps exactly 9000, 6 paychecks Oct 8 - Jan 6); `rollupForecast` monthly buckets (cumulative 18k...108k, 2 paychecks every month incl. Feb); Toyota day 30 from 2027-01-10 for 90 days -> Jan 30, Feb 28, Mar 30; 65-day lookahead for day 29/30/31 bills from every start day across 4 years (1461 days x 3) never empty, and next occurrence never more than 31 days away.

## Mutation checks (temp copies only; real source untouched)

Method: script copied `lib/forecast.ts` to a temporary `lib/zz-mut-forecast.ts`, applied one mutation, ran copies of the Coder test, the tester test and `forecast.test.ts` against it, then deleted all temp files (verified gone). Failures per mutation (total):

| Mutation | Killed? | Failures |
|---|---|---|
| M0 control (no change) | n/a | 0 |
| M1 revert to old skip | killed | 26 |
| M2 clamp without de-dupe | killed | 9 |
| M3a Feb always 28 | killed | 6 |
| M3b leap by `%4` only (breaks 1900/2100) | killed, ONLY by tester tests (Coder's file has no century test) | 2 |
| M3c leap computed from year+1 | killed | 20 |
| M3d daysInMonth minus 1 | killed | 29 |
| M3e `day >= dim ? dim : day` | survives: equivalent mutant (same function as `min`) | 0 |
| M4a window `<= to` | killed | 12 |
| M4b window `> from` | killed | 14 |
| M4c no window filter | killed | 40 |
| M4d end month exclusive | killed | 5 |
| M5 day < 1 clamped up to 1 | killed (tester only) | 1 |
| M6a weekly bill routed through clamp | killed | 2 |
| M6b biweekly bill routed through clamp | killed | 2 |
| M7a accrued branch skips short months | killed (tester only) | 1 |
| M7b annual branch unclamped | killed | 3 |
| M7c annual branch skips short months | killed | 3 |
| M7d accrued default day changed | killed (existing forecast.test.ts only) | 2 |
| M8 final sort removed | killed | 4 |
| M9 clamp overflow to day 1 instead of last day | killed | 27 |

Every non-equivalent mutant is killed. The century-year and day<1 cases were only covered after my additions.

## Live read-only check

Temporary repo-root script (`zz-live-clamp.mts`, run with `node --env-file=.env --import tsx`, `findMany` only, deleted afterwards; verified gone). No account numbers printed.

- Eric income rule is live `{"daysOfMonth":[15,31]}`, semi_monthly, 9000. This confirms the plan's assumption. Eva is biweekly (anchor 2026-08-28), unaffected.
- Active bills with day >= 29: only "Toyota Financial — Eric truck", monthly, day 30, 420. Budgets with payDay >= 29: only Tacoma payment day 30 (2026-10/11/12). No transfers with day >= 29 (weekly Mon/Fri plus PennyMac `[1,15]`).
- Real generators over live rows, Nov 30 2026: Toyota bill -420, Eric payroll +9000, plus two weekly Monday envelope transfers (-256, -400, which are Mondays and unrelated to the change). Feb 28 2027: Toyota bill -420 and Eric payroll +9000, nothing else. The 90-day forecast window (2026-10-08 to 2027-01-06) contains the Oct 31 and Nov 30 and Dec 31 payroll dates once each (no duplicates), and Toyota on Oct 30, Nov 30.
- Eric payroll gives 24 occurrences in calendar 2027.

## Defects found

None in the changed code.

Observations (non-blocking, not caused by this change):
1. Day 0 or negative days stay "previous month's last day" semantics as before. Combined with the new clamp, a hypothetical rule such as `[0, 31]` could produce the same calendar date twice (day 0 of one month and the clamped 31 of the previous month). Plan scoped day < 1 out, no live data has it; mentioned only for completeness.
2. Nine monthly live bills have `autopayDay = null` and so are scheduled on day 1 by the existing default (pre-existing behavior, unrelated).
3. Coder test file lacks century-year (1900/2100) coverage; I added it.

## Not tested

- No browser/UI check of the /forecast page or the upcoming-ledger render after deploy (the plan puts the real-world check with the owner); only the pure generators, `buildAccountForecast` and `rollupForecast` were exercised.
- `checkBillReminders` itself (needs a db mock; the Coder skipped its optional test). I verified the underlying property instead: a monthly day 29-31 bill's 65-day lookahead is never empty and the next occurrence is at most 31 days away, for every start day across four years.
- `lib/upcoming-ledger.ts` budget-vs-bill same-date matching when a Budget day-30 row and a bill day-31 row collide in a 30-day month: no such live data, and the full suite passes; I did not write a dedicated collision test.
- I did not review the exact wording of the CLAUDE.md edit.
- Files changed on disk (`lib/upcoming-ledger.ts` comment, `CLAUDE.md`) while I was testing, apparently from the Coder's second pass; my second full run includes them.
