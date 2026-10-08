# Review: upcoming-ledger (forecast enhancement, step 1)

## Verdict: CHANGES_REQUESTED

Small, mechanical changes only. No finding is architectural and nothing needs re-planning. Everything else is approved as built. Once the three items under "Required changes" are done and the tests/typecheck/lint re-run green, this can be approved without another full review (a diff read of those items is enough).

**Route-back target: `coder`.** The plan is sound. The three items are execution gaps. Item 1 is a direct miss of the request's rule that an amount is never shown as $0 when it is really not set. Items 2 and 3 are a cosmetic inconsistency and a documentation inaccuracy.

## What I verified myself (not from the write-ups)

- Read in full: `lib/upcoming-ledger.ts` (1328 lines), `lib/upcoming-ledger-view.ts`, `lib/upcoming-ledger-build.ts`, `components/upcoming/{upcoming-parts,upcoming-agenda,upcoming-widget}.tsx`, the real `git diff` of `app/page.tsx`, `app/forecast/page.tsx` and `CLAUDE.md`, plus `allMonthDays` in `lib/forecast.ts`.
- `pnpm typecheck`: clean (exit 0). `eslint` on all new/changed files: 0 errors, 1 warning, not in a new file. `pnpm vitest run` on upcoming-ledger* plus forecast, forecast-rollup, annual-bill and business-forecast: 9 files, 296 tests, all passed.
- `git status` / `git diff --stat` on `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/annual-bill.ts`, `lib/recurring-expenses.ts`, `prisma/`, `actions/`, `package.json`, `pnpm-lock.yaml`: empty. The must-stay-identical files are untouched. Tracked changes are exactly `CLAUDE.md` (+2 lines), `app/page.tsx` and `app/forecast/page.tsx`, all additive. The untracked `pnpm-workspace.yaml` and `scripts/setup-eva-account.ts` are not part of this task and must not be staged with it.

## Correctness against the request and ground rules

- **Dedupe and precedence (central risk): correct.** Stage A is exact `entityId|tagId`: bill, then Budget schedule, then RecurringExpense. Only the winner is expanded. Losers become `alsoRecordedAs`. Discrepancies use a $1 tolerance on monthly-equivalent and a day compare. The Budget row compared is the one for the item's own month, and a "No budget line" note appears only when other months have data. The key never crosses entities. Stage C (untagged records) compares only within one entity, holds the loser back (visible, never counted), and never merges two untagged records of the same kind. I checked deviation 2 against the code (`consider()`, `k.source !== o.source`) and it is justified. Without it the five Sudden Valley "(Arbor Retreat)" bills would collapse into each other, which the plan itself says must not happen. Residual risk, accepted: two genuinely identical untagged same-kind rows are both counted. The DB unique index only protects tagged bills.
- **Never fabricate: holds for bills, Budget lines, recurring and cards.** An unknown amount uses a placeholder to get the dates, is emitted as `amount: null` / `unknown`, is listed, and is excluded from totals. An unknown day goes to `undated` and is never guessed as the 1st. A zero or negative accrual draw keeps its date and becomes unknown (deviation 8, good). A past-due card with a null balance is listed rather than dropped (good). The one exception is item 1 below.
- **Ground rule 6 (bucket separation): holds.** Scope is applied to every source. The aggregate view builds `totalsByEntity` and the UI shows one line per entity with no blended total and no "Biggest" line. Row links use the row's own entity slug.
- **Ground rule 8 (observational wording): holds.** The wording is "due", "expected in", "~$", "estimate", "records disagree", and the footer says "Not financial advice". No imperative or advice phrasing in any component.
- **Money:** `Decimal` throughout the builder. The view layer does integer-cent arithmetic on strings, with no float money. No `any` in the new files.
- **Dates:** the `from` date is the America/New_York calendar date (`todayForNewYork`). Items are UTC-midnight calendar dates. They are formatted with `getUTC*` in the view, and the loader's tax-deadline and policy windows are widened by a day and normalized to the UTC date, which matches `inWindow`. Window operators match between loader and builder for every source (card, rental, tax, policy), so there is no inclusive-vs-exclusive boundary mismatch.
- **Auth:** `auth()` and the redirect run at line 26-27 of `app/page.tsx` and 47-48 of `app/forecast/page.tsx`, before the loader. The loader is auth-free by design (the same pattern as `lib/monthly-review-build.ts`) and a test pins that only the two pages import it.
- **Fail-soft:** both pages wrap the loader and the `toUiLedger` conversion in their own try/catch, outside the existing `Promise.all`. They log `err.name` only and render a small notice. The rest of each page is unaffected.
- **Leakage:** the loader's explicit `select`s read account `nickname` only. No account number, mask or token is selected or rendered.
- **Reads only:** no write, raw SQL or `"use server"` anywhere in the new code.

## Coder's seven documented deviations (plus the eighth the Coder listed)

All justified. 1 (shared parts file) is a harmless de-duplication. 2 (same-kind untagged never merged) is justified above. 3 (like-for-like monthly comparison) matches the plan's intent. 4 (note only when other months have a Budget row) avoids a misleading note. 5 (per-occurrence rounding) is fine for "~$" figures. 6 (hide a zero "expected in" on the dashboard) is good, and is the precedent for required change 2. 7 (one representative held-back item) is fine. 8 (zero draw becomes unknown, null-balance card listed) is good.

## Required changes

1. **(blocking, small) A zero-amount inflow or transfer must not render as a known $0.00; treat it as "amount not set".** Request item 7 says an unknown amount is shown as "amount not set", "not as $0". The tester's probe showed that `ProjectedRevenue.amountCents = 0`, `RentalBooking.grossEarnings = 0`, `IncomeSource.amount = 0` and `ScheduledTransfer.amount = 0` are emitted as `amountStatus: "known"` with amount 0.00 and render as "+~$0.00". Fix in `lib/upcoming-ledger.ts`:
   - Rental payout (about line 1199), projected revenue (about line 1231), income (about line 1173) and transfers (about line 1147): if the amount is null, zero or negative, emit the item with `amount: null`, `amountStatus: "unknown"` and the note `"Amount not set"`. For rows that go through a generator, use the same placeholder trick the bills use (`ONE` for the amount, only to get the dates). Keep the date, and do not drop the row.
   - Do not count it in `inflow` or `transferTotal`. `addToTotals` already only counts `known`, and it counts unknowns in `unknownAmountCount`. Check that the transfer branch there does not add an unknown transfer to `transferTotal`.
   - Add unit tests (one per source: zero amount gives an unknown item that is listed, dated and not in totals) and one render assertion that the row shows "amount not set" and no "$0.00".
2. **(should-fix, in this task) Agenda week header shows "~$0.00 due, ~$0.00 expected in".** In `components/upcoming/upcoming-agenda.tsx` (lines 91-95), mirror `TotalsLine`'s rule from the dashboard (deviation 6). Show the "due" segment only when the week's outflow is greater than zero, and the "expected in" segment only when the week's inflow is greater than zero. When the week has any unknown-amount item, append "N without an amount" (add an `unknownCount` field to `WeekGroup` in `lib/upcoming-ledger-view.ts`; keep the existing `outflow`/`inflow` string fields, because the tester's reconciliation test reads them). If a week shows nothing, render no subtotal text at all, not a zero. This fixes the false-reassurance read where a week with only unknown-amount bills said "~$0.00 due".
3. **(should-fix, in this task) The documented scope of the inherited month-length gap is wrong; correct it.** I read `allMonthDays` (`lib/forecast.ts` lines 56-78). It skips any listed day that does not exist in that month, so it affects day 29, 30 and 31 for every monthly bill, Budget schedule and paycheck, not only the `[15, 31]` paycheck. The tester's repro is real: Toyota (day 30) in February is silently absent and has no note and no `undated` entry, which cuts against "no bill silently dropped". Today's 30/60/90-day windows are not affected (Nov 30 and Dec 30 Toyota are present), but a 90-day window starting from about 2027-01-08 will omit the February Toyota $420. Update three places so the owner is not misled: the header comment in `lib/upcoming-ledger.ts` (lines 10-13), the "Inherited gap" sentence in the CLAUDE.md "Upcoming ledger" paragraph, and `02-implementation.md` "Open items". Say "days 29, 30 and 31 of any monthly bill, Budget schedule or paycheck are skipped in months too short to have them". Do not change `lib/forecast.ts` in this task.

## Findings not requiring change (decisions on the tester's observations)

- **Fix in this task:** zero-amount inflow (required change 1) and the week header (required change 2). Both are cheap, local to the new files, need no change to `lib/forecast.ts`, and one of them breaches an explicit request rule.
- **Defer to the follow-up task:** the day 29/30/31 skipping (nit about code, should-fix for the owner). The fix is in `lib/forecast.ts#allMonthDays` (clamp to the last day of the month, and avoid emitting the same date twice when a rule lists several days, such as `[30, 31]` in a short month). It changes the balance charts, notifications, and `lib/business-forecast.ts`, so it needs its own plan and its own tests, as the request ("do not change the existing cash-flow engine output") and plan section 9 already say. This is why I am not asking for any code change for it here, only for accurate wording (change 3). The owner should be told plainly that this one task will fix Nov 30 $9,000, the 2027 February Toyota payment and the other short-month gaps together, and that until then a missing day-29/30/31 line in short months is a known gap, not a paid-off bill.
- **Nit:** `MiniRow` and the disclosure notes use `key={n}` on note strings, which would collide if two identical notes appeared on one row. Not currently reachable.
- **Nit:** the Coder's "53 warnings" figure is 52 per the tester. No action.
- **Open follow-ups to keep on the owner's list (not this task):** the Budget-vs-bill drift now surfaced (Toyota Nov/Dec $1,500 vs $420, Doggy Daycare $268 vs $310.56, Solar day 14 vs 17, Eversource recurring $200 vs $172, Firewood and McCarthy set-asides); the five untagged Sudden Valley bills and Lexus with no pay day; the `Reimbursement` $350 modelled as a Sudden Valley outflow with no Personal mirror; the advisor-tool wrapper (deferred by design).

## Tests

Strong. The Coder's 86 tests plus the tester's 115 cover each source, dedupe precedence (including the live Eversource three-way and the three historical untagged pairs with negative controls), horizon boundaries, unknown amount, undated, scoping, DST/midnight handling, and source-scan purity. The tester's 36-mutant run, with one equivalent survivor, is evidence the suite pins behavior and not just coverage. The only coverage gap is the one in required change 1 (zero-amount inflow and transfer behavior), which the new tests close. A render-level test for the week header (change 2) should also be added.

## Not verified by anyone (needs human eyes, no browser in the pipeline)

Layout and visual placement of the widget and the agenda, `<details>` open/close, `#upcoming` scroll, and actual link clicks. The Coder's list of five visual checks in `02-implementation.md` still stands. I approve on static markup, SSR renders against live data, and hand-traced render logic. This gap is named, not hidden.

## What's good

- The pure builder is cleanly separated from the DB-aware loader and the presentation layer, and reuses `lib/forecast.ts` generators without copying any date math.
- Unknown amount and unknown day are handled by explicit gating and not by silent defaults, which is more honest than the existing charts. Estimated items carry a plain-language reason.
- Dedupe errs toward "visible but not counted", never deleting, and the per-month Budget comparison surfaced real live drift (Firewood, McCarthy, Toyota, Doggy) with no change to any stored data.
- Scope discipline is clean: no schema change, no migration, no dependency, no touch to the must-stay-identical files, additive-only page diffs, and fail-soft on both pages.
- The tester's live read-only smoke checks tie out to the Coder's figures.

---

## Re-review (round 1 fixes)

### Verdict: APPROVED

All three required changes are done in the code, not just in the write-up. I found no regression and no new blocking or should-fix finding. This is ready to ship as far as static review can tell. The visual gap named above (no browser in the pipeline) still stands.

### Verified by reading the code and running the checks myself

- `pnpm typecheck`: clean, exit 0.
- `pnpm vitest run lib/__tests__/upcoming-ledger`: 5 files, 210 tests, all passed (62 builder, 15 view, 18 render, 99 tester, 16 tester-ui). This matches the Coder's figures.
- `git status` on `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/annual-bill.ts`, `lib/recurring-expenses.ts`, `prisma`, `actions`, `package.json` and `pnpm-lock.yaml`: empty. `CLAUDE.md` is still a pure +2-line addition against HEAD.

### Required change 1 (zero, null or negative amount shows "Amount not set"): done

Checked each branch in `lib/upcoming-ledger.ts`. Each one runs the amount through `positive()` (present and greater than zero). When it fails, the item keeps its date and gets `amount: null`, `amountStatus: "unknown"` and the note "Amount not set". Where a generator supplies the dates it gets the `ONE` placeholder, and the emitted amount is nulled.
- Transfers (about line 1152): done. `addToTotals` adds to `transferTotal` only when `item.amount` is set, so an unknown transfer adds nothing there. It still counts in `transferCount` and `unknownAmountCount`, which is correct.
- Income (about line 1181): done.
- Rental payouts (about line 1210): done. A null gross used to be dropped silently. It is now listed as unknown, which is better.
- Projected revenue (about line 1244): done in the window and in `pastDue`. The unknown note comes first, then the "date has passed" note.
- Inflow: `addToTotals` skips anything that is not `known`, so none of these reach `inflow`.
- Unit tests: one per source, in `upcoming-ledger.test.ts` lines 435-513. They cover amounts 0, -5 and null for transfers, and the past-due projected-revenue case. Each asserts the date, `unknown`, a null amount, the note, and that the item is absent from `inflow` and `transferTotal`. The mixed known and zero transfer case sums only the known one (1024.00).
- Render test: zero paycheck, payout and revenue in the widget give at least 3 "amount not set" and "3 items have no amount set". The only "~$0.00" is the summary strip's counted-bills total, asserted by count (1).

### Required change 2 (week header): done

- `WeekGroup.unknownCount` is added. The `outflow` and `inflow` string fields are unchanged.
- `weekSubtotalText(week, withMoney)` shows "~$X due" only when outflow is above zero and "~$Y expected in" only when inflow is above zero. It appends "N without an amount" when `unknownCount > 0`, and returns "" when there is nothing to say.
- `upcoming-agenda.tsx` line 95 renders the span only when the text is non-empty.
- In the all-entities view (`withMoney = false`) no money is ever shown, only the unknown count. A count is not a blended money total, so ground rule 6 is intact.
- View tests cover every branch, including `withMoney = false`. Render tests cover "~$83.00 due, 1 without an amount", a week with only an unknown bill (no "~$0.00"), a week with only a paycheck, and a week with only an informational tax deadline (no subtotal span).

### Required change 3 (month-length gap wording): done in all three places

The header comment in `lib/upcoming-ledger.ts` (lines 10-16), the "Inherited gap" sentence in the CLAUDE.md "Upcoming ledger" paragraph, and the Open items in `02-implementation.md` all now say that days 29, 30 and 31 of any monthly bill, Budget schedule or paycheck are skipped in months too short to have them. The CLAUDE.md text also says plainly that a missing line is "a known gap, not a paid-off bill", and that no note or `undated` entry is made. `lib/forecast.ts` is untouched.

### The unrequested addition: harmless

`TransferNote` in `upcoming-parts.tsx` now omits the "~$X," segment when the transfer total is "0.00", so it reads "4 envelope transfers, not counted (they move your own money)." The total is `toFixed(2)`, so the string compare is exact. A non-zero total prints as before ("4 envelope transfers, ~$1,024.00, not counted ..."). It also stops the agenda from printing a "~$0.00" for unset transfers. It is in scope as a direct consequence of change 1, it is covered by a render test, and it adds no advice wording. I accept it.

### Render test file after the rewrite

The file is `lib/__tests__/upcoming-ledger-render.test.tsx` (the task text said `lib/upcoming-ledger-render.test.tsx`; no file exists at that path). It has 18 `it` blocks: 10 in the widget describe and 8 in the agenda describe.
- The 4 new tests are: the zero-amount widget test, the week-header test, the informational-week test, and the zero-transfer agenda test.
- The remaining 14 match the earlier 14 in name and intent: empty state, error state, estimate badge and unknown amount, records disagreement, transfers summarized but not listed, undated / past-due / held-back disclosures, aggregate per-entity lines with no blended total, row links and footer, 12-row truncation, horizon tabs, week grouping with confidence column, transfers toggle, agenda error state, and disclosures open by default.
- The assertions are substantive. I saw no weakened or stub assertions, the count and the suite pass, and the separate tester-ui file (untouched) also passes.
- Caveat: the file is untracked, so there is no git baseline for a byte-level comparison. This is a comparison against the descriptions in `02-implementation.md` and the prior test counts. The rewrite was a recovery from a scripted line-removal accident that the Coder disclosed. It is covered by passing tests.

### Findings

- Nit: "~$0.00 due" can still show in the summary strip when every counted outflow is zero. This is the earlier deviation 6 choice ("Due is always shown"), the Coder disclosed it, and the strip sits next to the "N items have no amount set" line. It is not blocking.
- Nit: mixed CRLF and LF line endings in the new untracked files. Harmless to tooling, but worth normalizing at commit time if the repo prefers one.
- Reminder: stage only this task's files. The untracked `pnpm-workspace.yaml` and `scripts/setup-eva-account.ts` are not part of it.
- Still open for the owner, unchanged: a separate follow-up task on `lib/forecast.ts#allMonthDays` (clamp to the last day of the month, no duplicate dates) fixes Nov 30 $9,000, the 2027 February Toyota $420 and the other short-month gaps together. Until then those are known gaps, not paid-off bills.
