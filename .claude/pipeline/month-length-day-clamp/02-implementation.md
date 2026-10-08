# Implementation: month-length-day-clamp (pass 1, restricted scope)

## Summary of changes
- `lib/forecast.ts` `allMonthDays`: per month compute `daysInMonth` once, map every listed day to `Math.min(day, daysInMonth)`, de-duplicate through a `Set`, then build the UTC date and keep the existing `d >= from && d < to` filter and final ascending sort. The month-walk loop is untouched. Doc comment updated (clamp + duplicates collapse). All 6 call sites go through it, so transfers, income, monthly bills and accrued bills all clamp. `annualDueDate`, weekly, biweekly and the lump-sum branch are untouched. The file stays CRLF as in the working tree (diff is 16 lines).
- `lib/notifications.ts` `checkBillReminders`: comment only (the "day-31 skips February, Feb 1 -> Mar 31" justification is gone). New comment says consecutive monthly occurrences are now at most 31 days apart and 65 days is kept as a margin. The `65 * 86400000` value is unchanged.
- New `lib/__tests__/month-length-clamp.test.ts` (21 tests, uses only the exported generators; `allMonthDays` stays private):
  - Monthly day-31 bill across 2027: Jan 31, Feb 28, Mar 31, Apr 30, May 31, Jun 30, Jul 31, Aug 31, Sep 30, Oct 31, Nov 30, Dec 31.
  - Feb leap (2028-02-29) vs non-leap (2027-02-28) for days 29, 30 and 31.
  - 30-day months: day 31 gives the 30th, day 30 stays the 30th.
  - Toyota day 30, Oct 2026 - Mar 2027: includes 2027-02-28.
  - Day 15 and day 1 unchanged.
  - Accrued bill with no draws, day 31, clamps.
  - Annual bill day 30 in Feb is still 2027-02-28.
  - Eric `[15,31]`: Oct 2026 - Jan 2027 gives exactly 2 per month including 2026-11-30 and 2026-12-31; a calendar year gives 24 unique ascending dates including Feb 28, Apr 30, Jun 30, Sep 30 and Nov 30; `[1,15]` unchanged.
  - `[30,31]`: one date in Nov, two in Dec.
  - `[15,30,31]` in Feb gives Feb 15 and Feb 28 only; `[28,29,30,31]` gives one date in Feb 2027 and two (28, 29) in Feb 2028.
  - Out-of-order rule `[31,15]` is still ascending; monthly income day 31 clamps.
  - Transfers: `[30,31]` in Nov is exactly one out + one in on a single date, Dec is 2 outs + 2 ins; a monthly transfer day 31 lands on Feb 28.
  - Window edges: `from` equal to Feb 28 includes it; `to` equal to Feb 28 excludes it; `from` after the date excludes it; a window ending Mar 1 00:00Z includes Feb 28.
  - UTC: dates are `T00:00:00.000Z`; a `from` of 23:30Z the evening before still yields the 28th; a `from` of 05:00Z on the 28th excludes it.

No existing expectation was changed. No existing test encoded the old skip, as the plan predicted.

## Deviations from the plan
- Per the restricted scope for this pass, `lib/upcoming-ledger.ts`, `CLAUDE.md` and the upcoming-ledger tests were NOT edited, so plan acceptance criterion 6 is only partly met (see "Still to update"). The plan's extra upcoming-ledger test (`[15,31]` includes 2026-11-30) was not added to `upcoming-ledger.test.ts` for the same reason. The forecast-level equivalent is covered in the new test file.
- Skipped the optional `checkBillReminders` test (notifications mock harness not cheap; not required).
- Tests went in a new file rather than `forecast.test.ts` (allowed by the instructions).

## Confirmations
- Eric's income rule: the only evidence in the repo is the fixture at `lib/__tests__/upcoming-ledger.test.ts:295` (`semi_monthly`, `daysOfMonth: [15, 31]`, 9000). The plan notes the live rule was read only as "contains a 29-31 value", so `[15, 31]` is not verified against the live row (I did not query the DB).
- `lib/business-forecast.ts` imports only `Decimal` from `@prisma/client/runtime/library`. It does not import `lib/forecast` and does not call any generator. Non-test importers of `@/lib/forecast` are `lib/notifications.ts`, `lib/upcoming-ledger.ts`, `app/forecast/page.tsx`, `lib/advisor/tools/get-forecast.ts`, `actions/envelope.ts` and `lib/forecast-rollup.ts`.
- Low-risk note from the plan on ledger matching (a Budget day-30 row and a bill day-31 row now landing on the same date in a 30-day month): the full suite passes, and the plan says live data only has Toyota day 30 on both. I did not investigate further.

## Commands run and results
- `pnpm vitest run lib/__tests__/month-length-clamp.test.ts lib/__tests__/forecast.test.ts`: 2 files, 64 tests passed (21 new + 43 existing).
- `TZ=America/New_York pnpm vitest run lib/__tests__/month-length-clamp.test.ts`: 21 passed.
- `pnpm typecheck`: clean (`tsc --noEmit`, no output).
- `pnpm lint`: 0 errors, 52 warnings. All 52 are pre-existing unused-var style warnings in other files (e.g. `lib/plaid-sync.ts`, `prisma/seed.ts`). None are in the files I touched.
- `pnpm test` (full): **409 test files passed, 11719 tests passed** (prior baseline 408 files / 11698 tests, plus my 1 file / 21 tests). No failures, no skips noticed.
- I did not re-run the new tests against the old `allMonthDays` to watch them fail (stashing would disturb the other task's uncommitted files). The Feb/Nov/Apr assertions cannot pass under the old skip logic by construction.
- Nothing was committed, staged or pushed. No DB access, no migrations.

## Still to update in the later pass (exact text)
1. `lib/upcoming-ledger.ts` lines 10-16, the whole "KNOWN INHERITED GAP ..." comment block. Replace with one line: days 29-31 clamp to the month's last day inside `allMonthDays` (duplicates collapse), so nothing is skipped in short months.
2. `CLAUDE.md` line 115 (the "Upcoming ledger" paragraph), this sentence group: "Inherited gap: `allMonthDays` skips any listed day that does not exist in that month, so days 29, 30 and 31 of any monthly bill, Budget schedule or paycheck are skipped in months too short to have them (the [15, 31] paycheck in Sep/Nov/Feb/Apr/Jun, a day-30 bill such as Toyota in February), with no note and no `undated` entry, until the generator is fixed in its own task; a missing day-29/30/31 line in a short month is a known gap, not a paid-off bill." Replace with a statement that `allMonthDays` clamps days 29-31 to the month's last day and collapses duplicate dates. The following sentence starts "A zero, null or negative amount on a paycheck, ..." and must stay.
3. Optional: add a ledger test that `[15,31]` over a window covering Nov 2026 includes `2026-11-30` (plan "Update/add" item), in the upcoming-ledger test file.
4. Searched `lib/__tests__`, `components`, `app`, `actions` and `lib/advisor` for other text describing the skip ("inherited", "known gap", "allMonthDays"): no other stale mentions.

## Open items
- Live-data effect (from the plan, unchanged): Eric's payroll gains Nov 30 (+$9,000 on the forecast), Feb 28 and so on, and Toyota gains Feb 28 from 2027. Real-world check on /forecast after deploy is the owner's.
- Line endings: `lib/forecast.ts` and `lib/notifications.ts` are CRLF in the working tree (LF in the index). I preserved that, so the diff is minimal. The new test file was written with LF.
