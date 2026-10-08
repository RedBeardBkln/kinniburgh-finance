# Implementation: upcoming-ledger (forecast enhancement, step 1)

Nothing committed, staged or pushed. No DB writes, no migrations, no `prisma generate`. Owner-approved defaults 1-8 from plan section 12 were all applied.

## Files

New
- `lib/upcoming-ledger.ts` - pure builder (`buildUpcomingLedger`, `todayForNewYork`, `nameWords`, `CARD_PAST_DUE_LOOKBACK_DAYS`, all types from plan 5.1). Imports only `Decimal` (runtime/library), `@/lib/forecast` generators, `@/lib/annual-bill`, `@/lib/recurring-expenses`.
- `lib/upcoming-ledger-view.ts` - pure formatting/grouping/link helpers and `toUiLedger` (Decimal/Date to plain strings; components receive no Decimal/Date).
- `lib/upcoming-ledger-build.ts` - read-only loader `loadUpcomingLedger` (13 parallel explicit-`select` reads, no writes, no auth; callers have already run `auth()`).
- `components/upcoming/upcoming-widget.tsx`, `components/upcoming/upcoming-agenda.tsx`, and `components/upcoming/upcoming-parts.tsx` (shared row/summary/disclosure pieces; see deviation 1).
- `lib/__tests__/upcoming-ledger.test.ts` (58), `upcoming-ledger-view.test.ts` (14), `upcoming-ledger-render.test.tsx` (14).

Modified
- `app/page.tsx` - widget directly under the 3 summary cards, current month only; loader in its own try/catch, not in the existing `Promise.all`.
- `app/forecast/page.tsx` - `searchParams` gains `horizon` and `transfers`; `<UpcomingAgenda>` (wrapper `id="upcoming"`) placed after "Next 14 Days", before spend pace; loader in try/catch. Nothing else on the page changed.
- `CLAUDE.md` - one Architecture paragraph ("Upcoming ledger") inserted before "Testing pattern".

Untouched (verified with `git status`): `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/annual-bill.ts`, `lib/recurring-expenses.ts`, `prisma/**`, `actions/**`. No new dependency.

## Deviations from the plan (and why)

1. Extra file `components/upcoming/upcoming-parts.tsx` (shared pieces for widget and agenda) so the two components do not duplicate row markup.
2. Stage C: two untagged records of the SAME kind (bill vs bill, recurring vs recurring, envelope vs envelope) are never merged with each other. Plan 5.3 literally lets an untagged bill be compared against already-kept untagged bills; with the shared-word rule that would merge today's Sudden Valley bills "Amica - Home insurance (Arbor Retreat)", "Eversource (Arbor Retreat)", "McCarthy Oil (Arbor Retreat)" and "Property taxes - 56 Arbor Rd" (shared words "arbor"/"retreat"), contradicting the plan's own requirement that all five stay separate. Untagged records are still compared against every tagged winner and against kept untagged records of a different kind. Pure-number words are also excluded from name matching.
3. Discrepancy monthly-equivalent: a lump-sum record is compared by `payment / cycleMonths` on both sides (bill vs Budget); accrued bills compare their stored monthly set-aside (`expectedAmount`, falling back to `annualBudget / 12`) to `Budget.budgeted`. This matches the plan's "payment x payments per year / 12" for lump sums and keeps like with like.
4. A tagged bill's "No budget line for YYYY-MM" note is only added when the key has a Budget row in some other loaded month (avoids a note on bills that never had a Budget row).
5. Items are rounded to cents per occurrence (e.g. weekly 310.56 monthly gives 71.67).
6. Dashboard "expected in" segment is hidden when the counted inflow is zero (showing "~$0.00 expected in" read as a claim). "Due" is always shown.
7. A held-back record is shown as ONE representative item (first in-window occurrence, or undated), not every occurrence.
8. A zero/negative accrual draw amount is treated as unknown (date kept) rather than silently skipped by the generator; a past-due card with a null balance is listed under past due (plan said positive balance only).

## Commands run and results

- `pnpm typecheck` - clean (exit 0, no output after `tsc --noEmit`).
- `pnpm lint` - 0 errors, 53 warnings, all pre-existing in unrelated files; 0 warnings in any new/changed file (one unused-import warning in my test file was fixed).
- `pnpm vitest run lib/__tests__/upcoming-ledger*` - 3 files, 86 tests, all passed (58 + 14 + 14).
- `pnpm test` (full) - 406 test files, 11574 tests, all passed (346 s). That run began before I removed one unused import from my own test file; the three new files were re-run afterwards (86/86) and lint showed 0 warnings in new files. The 5 pre-existing forecast/notification/annual-bill/business-forecast tests passed unmodified.
- Read-only live smoke (temporary in-tree tsx script calling `loadUpcomingLedger` against the real DB, deleted afterwards; no writes). Against live data on 2026-10-08, 90 days:
  - Personal: 88 items (45 of them envelope transfers, uncounted), counted outflow 24,081.40, inflow 62,885.00, 0 unknown amounts, 1 undated (Lexus Financial 250.00), 1 past due (Barclay 623.19), 0 held back.
  - Present as the plan predicted: jetBlue Oct 12 51.26; Eva pay Oct 9 and Oct 23 2,555.00; Eric pay Oct 15, Oct 31, Dec 15, Dec 31 9,000.00 (Nov 30 absent: the inherited day-31 gap); Solar Oct 17 505.70 with "budget says day 14"; Eversource Oct 20 172.00 with "recurring expense says 200.00"; Toyota Oct 30 420.00 clean, Nov 30 and Dec 30 flagged (budget 1,500); Mortgage Nov 1; NWM Nov 2 760.00; Doggy Daycare each Wednesday 71.67 flagged vs budget 268; Amica Dec 4 1,182.00; Firewood Dec 14 315.00 and McCarthy Dec 16 2,000.00 as estimates.
  - Newly visible real disagreements: Firewood bill 83.33/month vs Budget 80.00; McCarthy Heating & Oil bill 333.33/month vs Budget 308.00 (these are accrued set-asides).
  - Sudden Valley: Airbnb gross payout Oct 19 1,075.00; Reimbursement 350.00 on the 24th (Oct, Nov, Dec); 5 bills under Day not set; 0 held back.
  - All-entities view: also shows Capital One Oct 12 792.68 and "2025 Schedule C - extended filing" Oct 15 (EK Consulting).
  - Items outside the Sep-Jan windows were not checked. I did not run the pages in a browser (see below).

## Needs human visual verification (no browser tool available to the Coder)

1. Dashboard `/?bucket=personal`: card sits under the three summary cards; header "Next 30 days through Nov 6", summary strip, grouped rows, estimate badges, amber "Records disagree" lines, collapsed "Day not set (1)" / "Past due date, may already be paid (1)" disclosures, transfer line, footer. Check `/?bucket=taxes` shows one line per entity and no blended total, and a past `?period=` hides the widget.
2. Forecast `/forecast?bucket=personal`: agenda below "Next 14 Days"; 30/60/90 tabs keep `bucket`; "Show envelope transfers" toggle; week headings and subtotals; `#upcoming` anchor scroll; Sudden Valley bucket agenda; existing charts and funding card unchanged.
3. Row links (budgets with period, forecast, envelope, accounts, business revenue, tax, vault) land on real pages; typed-route casts compile but were not click-tested.
4. Force the loader to throw once to see the error notice on both pages (code paths are try/catch and render-tested, not exercised live).
5. Dates: Oct 12 card shows Oct 12 (UTC formatting on stored calendar dates).

## Open items / notes

- Month-length gap is inherited (corrected in review round 1): `allMonthDays` skips days 29, 30 and 31 of ANY monthly bill, Budget schedule or paycheck in months too short to have them (e.g. Nov 30 $9,000 paycheck, February Toyota day 30), not only the [15, 31] paycheck; documented in a code comment and in CLAUDE.md; not fixed (separate task as instructed). No test pins it as correct.
- Untracked `pnpm-workspace.yaml` and `scripts/setup-eva-account.ts` appear in `git status`; I did not create or touch them.
- Loader loads Budget rows only for months the window touches, so the "No budget line" note appears for the first month with no Budget data (live: Jan 2027 for Mortgage and NWM).
- Dashboard adds about 13 small parallel reads for the current month view; if slow, wrap the widget in `Suspense`.
- Advisor tool not built (decision 6/8); the pure builder takes plain rows so a follow-up needs no change to it.
- Live Budget/bill drift (Toyota Nov/Dec, Doggy, Solar day, Eversource recurring 200, Firewood, McCarthy) is surfaced, not fixed.

## Review round 1 fixes

Route-back from `04-review.md` (CHANGES_REQUESTED, 3 required changes). Nothing committed, staged or pushed; no DB writes; `lib/forecast.ts` and the other must-stay-identical files untouched (`git status --short` on `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/annual-bill.ts`, `lib/recurring-expenses.ts`, `prisma`, `actions`, `package.json`, `pnpm-lock.yaml` prints nothing).

### 1. Zero / null / negative amount is "Amount not set", never a known $0.00 (`lib/upcoming-ledger.ts`)

For each of these sources the amount now goes through `positive()` (present and > 0). When it is not, the item is still emitted with its date, `amount: null`, `amountStatus: "unknown"` and the note `"Amount not set"`; generator-backed sources get the `ONE` placeholder purely to obtain dates (same trick as bills). The row is therefore listed, counted in `unknownAmountCount`, and kept out of `inflow` and `transferTotal`:
- scheduled transfers (`generateTransferOccurrences` with placeholder; kind `transfer`, still not in `outflow`; `addToTotals` adds to `transferTotal` only when `item.amount` is set, so an unknown transfer adds nothing to the total; it still counts in `transferCount`);
- paychecks / income sources (`generateIncomeOccurrences` with placeholder);
- rental payouts (previously a null gross was silently dropped; now listed as unknown);
- projected revenue, both in the window and in `pastDue` (unknown note first, then the "date has passed" note).

Related one-line change in `components/upcoming/upcoming-parts.tsx` (`TransferNote`): when the transfer total is `0.00` (every transfer unset) the note reads "4 envelope transfers, not counted (they move your own money)." instead of "..., ~$0.00, not counted". Without it the agenda still printed a "~$0.00" from unset transfers. Output for a non-zero total is unchanged.

Tests added (all pass):
- `lib/__tests__/upcoming-ledger.test.ts` (58 -> 62): one test per source (transfer with amounts 0, -5 and null; income; rental payout; projected revenue in window and past due), each asserting dated + `unknown` + `amount: null` + "Amount not set" note + not in `inflow` / `transferTotal` + `unknownAmountCount`; the transfer test also checks a known transfer next to an unset one sums only the known one.
- `lib/__tests__/upcoming-ledger-render.test.tsx` (14 -> 18): zero paycheck + zero payout + zero projected revenue in the widget show "amount not set" three times and "3 items have no amount set", and the only "~$0.00" in the markup is the summary strip's counted-bills total (asserted by count = 1); a zero transfer in the agenda reads "amount not set" with "4 envelope transfers, not counted".

### 2. Agenda week header (`lib/upcoming-ledger-view.ts`, `components/upcoming/upcoming-agenda.tsx`)

- `WeekGroup` gains `unknownCount` (items in the week with `amountStatus: "unknown"`); the existing `outflow` / `inflow` string fields are unchanged (the tester's reconciliation tests still read them and pass).
- New pure helper `weekSubtotalText(week, withMoney)`: "~$X due" only when outflow > 0, "~$Y expected in" only when inflow > 0, then "N without an amount" when `unknownCount > 0`, joined with ", "; returns an empty string when there is nothing to report, and the agenda then renders no subtotal span at all. In the all-entities view (`withMoney = false`) no money subtotal is ever shown, only the count (the old behavior also showed none there).
- Tests: `upcoming-ledger-view.test.ts` (14 -> 15) covers per-week `unknownCount` and every branch of the text; render tests cover "~$83.00 due, 1 without an amount", a week with only an unknown bill ("1 without an amount" and no "~$0.00 due"), a week with only a paycheck ("~$50.00 expected in", no "due" segment), and a week with only a tax deadline (heading with no subtotal span).

### 3. Month-length gap documented correctly

Corrected to "days 29, 30 and 31 of any monthly bill, Budget schedule or paycheck are skipped in months too short to have them" (the skipped occurrence has no item, no note and no `undated` entry; e.g. Toyota day 30 in February, the [15, 31] paycheck in Sep/Nov/Feb/Apr/Jun) in: the header comment of `lib/upcoming-ledger.ts`; the "Inherited gap" sentence of the CLAUDE.md "Upcoming ledger" paragraph (still a 2-line diff against HEAD; I also added one sentence there that unset amounts are listed as "Amount not set" and never shown as $0.00); and the corrected Open items entry below. `lib/forecast.ts` was not changed. Per the review: a missing day-29/30/31 line in a short month is a known gap, not a paid-off bill; one follow-up task on `allMonthDays` (clamp to the last day of the month, no duplicate dates) fixes Nov 30 $9,000, the 2027 February Toyota $420 and the other short-month gaps together. A 90-day window starting about 2027-01-08 will omit the February Toyota payment.

### Commands run and results (after the changes)

- `pnpm typecheck` - clean (`tsc --noEmit`, no output).
- `pnpm lint` - 0 errors, 52 warnings, all in unrelated pre-existing files (the earlier "53" was 52 per the tester); `eslint` run directly on `lib/upcoming-ledger.ts`, `lib/upcoming-ledger-view.ts`, `components/upcoming`, and all `lib/__tests__/upcoming-ledger*` files printed nothing (0 warnings).
- `pnpm vitest run lib/__tests__/upcoming-ledger` - 5 files, 210 tests, all passed: `upcoming-ledger.test.ts` 62, `upcoming-ledger-view.test.ts` 15, `upcoming-ledger-render.test.tsx` 18, `upcoming-ledger-tester.test.ts` 99, `upcoming-ledger-tester-ui.test.tsx` 16. The two tester files were NOT modified and none of their assertions encoded the old $0.00 behavior.
- `pnpm test` (full) - 408 test files, 11698 tests, all passed (254 s).
- During this round one of my own test edits briefly emptied `upcoming-ledger-render.test.tsx` (a bad scripted line-removal); I rewrote the whole file from the content I had read plus the new tests, and it is covered by the run above. Line endings in the new untracked files are now mixed (some CRLF, some LF); harmless to tooling.

### Open items after round 1

- The inherited month-length gap is wider than first documented: every monthly bill, Budget schedule or paycheck on day 29, 30 or 31 is skipped in short months (not only the [15, 31] paycheck). Wording corrected above; the fix (in `lib/forecast.ts#allMonthDays`) is a separate task because it also changes balance charts, notifications and `lib/business-forecast.ts`.
- Nit left as is (per review): `key={n}` on note strings in `MiniRow` and the disclosure notes would collide only if two identical notes appeared on one row; not reachable today.
- The summary strip still shows "~$0.00 due" when every counted outflow is zero (the pre-existing "Due is always shown" choice, deviation 6), next to the "N items have no amount set" line. Not changed; out of the 3 required items.
- The five visual checks listed above still need human eyes (no browser in the pipeline); the new week-header text and the transfer note wording are covered only by static-markup tests.
