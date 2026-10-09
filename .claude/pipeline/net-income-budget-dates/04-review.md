# Review: net-income-budget-dates

## Verdict: CHANGES_REQUESTED

Route-back target: **coder** (implementation-level, text/copy only). The plan was sound; nothing here is architectural. All three required changes are small wording fixes with no logic, schema or data effect, so this should be a one-pass fix followed by a quick Tester re-run of the affected render/text tests.

The substance is approved: both owner corrections are honored in every consumer, the numbers are derived from real data with a stated basis, fail-soft holds, and nothing unsafe shipped. What blocks is user-visible copy that either contradicts the new behaviour or reads wrongly in the one flagged state this feature exists to make honest.

## What I verified myself (not from the write-ups)

- Read the real diff (22 modified files, 4 new source files) plus the full text of `lib/net-income.ts`, `lib/net-income-build.ts`, `lib/bill-dates.ts`, `lib/bill-dates-build.ts`.
- `pnpm typecheck`: clean. Targeted run (net-income, bill-dates, late-flag, upcoming-ledger, notifications, account-scheduled, advisor, recurring; 79 files): 1536 passed, 8 skipped. Full `pnpm vitest run`: 455 files, 12612 passed, 11 skipped, 0 failed.
- Line endings: every changed or new file is uniformly CRLF or uniformly LF (no mixed file); new files are LF; diffs are small (685 insertions / 113 deletions), no whole-file churn.
- Repo-wide grep: the only readers of `incomeSource` are the loader, the three gross-display/writer files (`actions/income-sources.ts`, `actions/paystubs.ts`, `app/settings/income-sources/page.tsx`, `app/personal/income/page.tsx`) and `actions/envelope.ts upsertIncomeSource`; no consumer reads gross for projection. The plain `generateBillOccurrences` is called only from `lib/bill-dates.ts`. No prisma/migration change, no tax-code change, no `any`.

## Ground rules

1. No fabricated numbers: PASS. Net is the median of up to 6 real matched deposits (min 3, recency-gated, sanity band, entity+account equality) or the latest confirmed paystub net (gross must match within 1%), otherwise gross is used and carried as `assumption: true` with the label "take-home unknown"; the deposit/stub read-failure path is also flagged. Money is Decimal throughout; `formatMoneyDecimal` is string-based. Eva's variability is stated ("about ... usually A to B"), not hidden. The Eric $6,064.87 vs plan $6,064.86 difference is correct half-up rounding of an even median.
5. Security: PASS. Loaders are read-only (`findMany` only), explicit selects, log `err.name` only; no names leave the machine; advisor output carries amounts/labels only (no employer field added), `take_home_note` passes `safeField`; no new route or action, so no new auth surface.
6. Entity separation: PASS. A deposit must equal the source's `entityId` and `accountId`; stubs are filtered per source entity; the Budget index key is `entity|tag`.
8. Tax: PASS. Nothing in `lib/tax2025`, `lib/tax-review`, `lib/tax-compute` touched; wording is observational ("usually", "about", "may take a few days").

## Owner corrections in every consumer

- Net, not gross: forecast page (chart, 14-day schedule, funding events), `account-scheduled-flows`, ledger input/build, advisor `get_forecast` and `list_recurring_and_scheduled`, `advisor-context`, `checkLowBalance`, `getEnvelopeForecastData`/`getEnvelopeSummary`: all go through `loadNetIncomeSources`. The source-scan guard pins it and the Tester mutation-tested the guard.
- Budget date wins: forecast page (3 call sites), account flows, advisor `get_forecast`, ledger (month by month), `checkBillReminders`, `getEnvelopeForecastData` (generation and `billsThisMonth`), advisor schedule (`budget_day`): all use `generateBillOccurrencesBudgetDated`. Amount precedence is unchanged (amounts, account, payee, type always the bill's; a Budget row of a different frequency is not used, a justified deviation recorded in 02). The late flag is measured from the observed posting day with a due-day floor, so a bill due the 14th that clears the 17th is not flagged on the 15th/16th/20th, and a due date moved later is not flagged early. Clearing lag is text only and never moves an item.
- The lump-sum branch (`annualBudget`/`payMonth`/`autopayDay` null returns []) is consistent with the new `hasResolvableDay` filter in `checkBillReminders`, so widening that query does not change any lump-sum reminder.

## Cron safety (decision on Tester observation 4)

`app/api/cron/notifications/route.ts` runs all checks in one `Promise.all` and then `dispatchPending`. This change adds NO new rejection path: `loadBudgetScheduleIndex` never rejects, and a deposit or paystub read failure inside `loadNetIncomeSources` degrades to flagged gross instead of throwing. The only remaining rejection (the income-SOURCES read in `checkLowBalance`) is the same query on the same database that the old `account.findMany` include already depended on, and every other check in that `Promise.all` has the same property. **Decision: defer, do not fix now.** Making it fail-soft here (`...Safe` returning `[]`) would silently drop paychecks and produce false low-balance alarms, which is worse than a loud 500. If the cron ever needs per-check isolation, that is a route-level `Promise.allSettled` change for all ten checks, as its own task.

## Required changes (blocking; all text-only)

1. **`app/forecast/page.tsx`, Income Sources table row (the `<p>` under the description, about line 1125 to 1130): remove the hard-coded prefix `"Gross used, take-home unknown: "`.** `netInfo.label` already says "gross $X used, take-home unknown: confirm a paystub on the Income page" (and "gross $X used, take-home could not be read" for the unreadable case), so the flagged state currently renders the phrase twice ("Gross used, take-home unknown: gross $9,000.00 used, take-home unknown: confirm ..."). Keep the amber class and the "gross, take-home unknown" sub-line in the Take-home column. This is the one state the feature exists to make honest and it has never been seen live, so it must read cleanly. (Tester observation 1.)
2. **Stale copy that says the forecast uses the gross amount** (Tester observation 2, widened by me after grepping; the owner's complaint was exactly this confusion):
   - `app/settings/income-sources/page.tsx` line 45 ("Recurring income events used by the 30-day forecast and low-balance alerts.") and the `Amount` column header at line 66: header becomes "Gross per paycheck"; the sentence should say the forecast and low-balance alerts use take-home estimated from recent deposits, not this gross figure.
   - `components/settings/add-income-source-form.tsx` line 152 and `components/settings/edit-income-source-button.tsx` line 188: label "Amount ($)" becomes "Gross amount per paycheck ($)".
   - `components/income/paystub-confirm-form.tsx` line 209: "the forecast now uses this cadence and amount" is false for amount; say it uses this cadence and the gross is kept for reference (take-home comes from your deposits). Line 638 tooltip ("... with this cadence and amount") likewise. The line 654 helper text ("so the predictive balance forecast reflects real take-home") is acceptable once the above are true; leave it or tighten it.
   - `components/income/income-sources-card.tsx` line 52 and `app/personal/income/page.tsx` lines 112 and 327: the copy is generic ("feeds the cash-flow forecast"); acceptable, leave unless trivially adjusted.
   - `actions/paystubs.ts` doc comment at lines 102 to 107: it says the forecast reflects "net take-home per paycheck" and then "the gross amount is used"; rewrite so it states the stored amount is the gross and the forecast derives take-home separately.
   Keep it to labels and comments; do not change any stored value or action logic. Preserve each file's line endings.
3. **Eva anchor double-count: state the consequence, not only the offset.** The Forecast note (`payTimingNote`, `kind: "offset"`, `lib/net-income.ts` lines 419 to 423) correctly says the schedule lands 2 days after the money and what to edit, and it changes nothing. But it never says what the owner actually experiences today: the projection still counts an Eva paycheck on 2026-10-09 whose money arrived 2026-10-07 and is already in the balance, so near-term balances are overstated by about one of her paychecks until the anchor is moved. Add one sentence, only when `days > 0`, e.g. "Until then, the first paycheck shown after today may already be in your balance, so near-term projections can be too high by about one paycheck." Update the pinned text in the tests that assert this string. (This is the only place the double count is visible to the owner; the Coder's 02 write-up and the Tester's note are not user-facing.)

## Disposition of the Tester's other low observations

| # | Observation | Decision |
|---|---|---|
| 1 | Doubled phrase on gross-unknown row | FIX NOW (required change 1) |
| 2 | Settings/Income copy + stale comment | FIX NOW (required change 2) |
| 3 | Monthly review lists the bill record's day (Solar 17) | DEFER, but name it. `lib/monthly-review-build.ts` lines 247 to 260 + `app/review/[year]/[month]/page.tsx` list the record's day, so the owner's rule "bills default to the Budget date" is not true on that page. It is a listing, not a forecast, and fixing it needs a Budget read per review period; make it the first follow-up (small). |
| 4 | `checkLowBalance` income-read failure rejects | DEFER (see Cron safety). Not a regression. |
| 5 | Bill with no own day dated only by Budget rows gets nothing past the Budget rows (Jan 2027+), silently | DEFER. No live bill is in this state (pinned by an OBSERVATION test). Should-fix when it first matters: emit the existing "Day not set" undated item for months with no usable schedule instead of omitting them. |
| 6 | Monthly bill vs Budget row of another frequency raises no day discrepancy | DEFER. Rows are not comparable; amount discrepancy still shows. Acceptable. |
| 7 | N+1 per-account loaders, 400-row deposit cap | DEFER. 6 accounts, 49 inflows in 400 days live; a cap overflow degrades to flagged stub/gross, not silent. |
| 8 | Solar returns to the 17th in Jan 2027 | DEFER (owner-approved default 3). It is partly surfaced: the ledger already appends "No budget line for <period>" for a month without a row (existing behaviour, still applies), but the Forecast chart flips silently. Suggest the owner add 2027 Budget rows when planning; consider carrying the latest Budget row forward as a later decision. |
| 9 | Paystub accepted when frequency differs but employer + gross match | DEFER. Harmless for a per-paycheck net. |
| 10 | Annual/semiannual Budget rows disagreeing month to month | DEFER. Live rows are identical; same family as "one ScheduledBill per category". |

## Findings (by severity)

Blocking: the three required changes above.

Should-fix (not blocking):
- `lib/monthly-review-build.ts` / review page record-day listing (observation 3), as the first follow-up.
- `lib/net-income.ts` `employerTokens`: a manually added non-payroll income source (rent, dividends) with no "(employer)" parenthetical will be labelled "take-home unknown: confirm a paystub on the Income page". Honest (it is flagged, not silent) but the wording assumes payroll. None exists live; consider a neutral label if such a source is ever added.
- Eva's anchor itself (`Wed 2026-08-26`) is an owner data edit; it remains the real fix for the near-term overstatement and for every later Eva paycheck being 2 days late. Nothing was changed, correctly.

Nit:
- `lib/net-income.ts` `payTimingNote(src, matched, today)` takes `today` and immediately `void today;`; drop the parameter or use it.
- Guard-test regex gaps (shorthand `select: { incomeSources }`, raw SQL, aliasing) are acknowledged by the Tester and negligible for this code base.

## Test quality

Good. Beyond the Coder's 118 tests the Tester added an integer-cents oracle fuzz of the resolver (1,500 households, all three bases exercised), a 1,200-bill day-by-day oracle for the Budget-dated generator including window-split and golden-vs-plain-generator properties, boundary tests for every threshold, and 77 mutants with 0 survivors (two surviving mutants were turned into tests). The guard test is itself mutation-tested. No test touches a real database (verified with an unreachable `DATABASE_URL`). The OBSERVATION tests honestly pin the known gaps (observations 4 and 5) rather than hiding them. What is NOT covered is any browser rendering (acknowledged), and the doubled-phrase defect slipped through precisely because the gross-unknown row is only exercised through the view-model, not the page text; after change 1 a small assertion on the rendered row text would be worthwhile.

## What's good

- Wrapper design: `lib/forecast.ts` and the schema are untouched; all new logic lives in four new files and the consumer edits are small call-site swaps, which kept a high-merge-risk working tree (uncommitted credit-card-full-pay changes) tractable.
- Evidence-led design: the backtest (Eric to the cent, Eva within her real spread) drove the choice of median-of-6 and the "about X (usually A to B)" presentation instead of a false-precision number.
- Honest fallbacks everywhere: gross is never silently presented as net, a failed Budget read is announced on the page, a stale Budget row cannot move an amount, and the clearing lag is explicitly text-only.
- The late-flag floor is narrow (1 to 7 days after the observed day), leaves learned series and weekly/biweekly untouched, and is property-tested not to flag earlier.
- Report-only pay timing: the Eva/Eric findings are surfaced with the exact edit to make and "Nothing was changed", respecting the instruction not to touch owner data.
- CLAUDE.md gained one accurate paragraph; line endings preserved byte-for-byte per file.

## Not verified by me

No browser (Forecast Income table layout/colours, Upcoming muted date line, `/personal/income` header, `/envelope` panel), no `next build`, and no notification dispatch (writes). The amber gross-unknown state has never been exercised live (both real sources resolve from deposits). The owner should glance at `/forecast?bucket=personal` and `/upcoming` after the fix.
