# Implementation: recurring-detection (forecast step 2, history-learned recurring bills)

Nothing committed, staged or pushed. No migration, no `prisma generate`, no schema change, no DB write from any script. All owner-approved defaults from the plan's section 11 were applied (learned bills outside the totals; dismissal = AppSetting JSON, Option B; deposits as a review list only; grace 5 days monthly / 3 weekly (4 biweekly); the Lexus "history differs" heads-up; price-change flags for fixed-amount series only).

Stray `_x.ts`: none existed at the repo root, so nothing was removed. My own temporary live-check scripts (`_cx.ts`) were deleted after each run; none remains.

## Summary of changes (file by file)

New
- `lib/recurring-detect.ts` - the pure detector (`detectRecurring`, `canonicalPayee`, `circularDays`, `cycleDates`, `expandSeriesDates`, dismissal helpers `parseDismissed` / `serializeDismissed` / `addDismissed` / `removeDismissed` / `isDismissed` / `keysRelated` / `applyDismissals`). Imports only `Decimal` and helpers from `lib/upcoming-ledger.ts`; no DB, no clock, no `next/*`, `getUTC*` only (a source-scan test pins it). Every threshold is a named constant with the live evidence in a comment. Algorithm exactly as plan section 5 (canonicalization, prefix merge with per-sub-group fallback, same-day rule, cadence bands and minimum occurrences, 80% fit with one skipped cycle tolerated, fixed/varies amount modes, circular 30-day day rule, stale = 1.5 cycles + 7 days, confidence + `why`, suppression by tag / name / amount+day, late / amount-change / history-differs flags).
- `lib/recurring-detect-build.ts` - read-only loader in two phases: `fetchDetectionData` (ONE `db.transaction.findMany` with an explicit select, `archivedAt: null, transferPairId: null, pending: false`, last 18 months, plus the dismissal setting) and the pure `runDetection`; `loadRecurringDetection` wraps both.
- `lib/upcoming-ledger-input.ts` - the ledger's 13 explicit-select reads, moved out of `lib/upcoming-ledger-build.ts` unchanged (`loadUpcomingLedgerInput`), so the server action can get the recorded items without importing the page-only loader (see deviation 1).
- `actions/recurring-suggestions.ts` - `addSuggestedRecurringExpense`, `dismissSuggestion`, `restoreSuggestion`. Each export starts with `await requireAuth();` (file-local, same as `actions/recurring-expenses.ts`). The client sends only `{ entityId, seriesKey }`; the SERVER re-runs the detector and builds the `RecurringExpense` from its own values (name = Title Case payee, `amountCents` = median, `frequency` = cadence with annual -> "annually", `dueDay` for monthly, `nextDueDate` = next expected date, `tagId` only at 60%+ tag share and only when no Budget / ScheduledBill / RecurringExpense already uses that tag, notes "Added from a recurring pattern in your transactions."). A suppressed key or an existing same-name row answers "Already recorded" and writes nothing. No AuditLog row (the existing recurring-expense actions write none). Revalidates `/forecast`, `/`, `/budgets`.
- `components/upcoming/recurring-suggestions.tsx` - the `/forecast#looks-recurring` review list (sections: "Looks recurring, not in your budget" with Add / Not a bill, "Heads up", "Regular deposits" without buttons, collapsed "Dismissed (N)" with Show again, hidden-count line, footer "Based on your last 18 months of transactions. These are patterns, not bills, and are not included in the totals above.").
- `components/upcoming/recurring-hint.tsx` - the dashboard one-liner ("3 items look recurring but are not in your budget, 1 expected bill has not posted. Review" + a `<details>` of up to 5 late lines), or the muted "Recurring-pattern checks are unavailable right now." when detection failed.
- `components/upcoming/suggestion-actions.tsx` - the only client leaf (`useTransition`, no `window.confirm`), buttons call the three actions and show a status message.
- Tests: `lib/__tests__/recurring-detect.test.ts` (76), `recurring-detect-ledger.test.ts` (9), `recurring-suggestions-render.test.tsx` (16), `recurring-suggestions-actions.test.ts` (13) = 114 new tests.

Modified
- `lib/upcoming-ledger.ts` - `UpcomingSource` += `learned_history`; `UpcomingLedger` += `learned`, `learnedTotals`, `learnedDropped`; input += optional `learned?: LearnedSeriesRow[]`; new exported types `LearnedSeriesRow`, `ModelledRef`, `ModelledCadence`; `accountsCompatible` / `amountsClose` exported; `likelySameObligation` takes a `Pick` of `Obligation`; new step 9 builds the learned block (only high/medium outflow series with a date in the window, never annual/low, re-checked against kept obligations, kept OUT of items/undated/pastDue/totals/totalsByEntity/biggest); new exported `collectModelledRefs(input)` (same active/schedule filters and one-record-per-category rule as the builder; weekly/biweekly bills are converted from the monthly-total convention to one payment). Existing output for an input without `learned` is unchanged (the 5 existing upcoming test files pass unmodified).
- `lib/upcoming-ledger-view.ts` - labels for `learned_history`; `UiLedger` += `learned`, `learnedTotal`; `toUiDetection` + `UiDetection` / `UiSuggestion` / `UiFlag` (strings only); shared copy constants `RECURRING_UNAVAILABLE`, `RECURRING_FOOTER`.
- `lib/upcoming-ledger-build.ts` - now the thin orchestrator: starts the detection reads in parallel with the ledger reads, runs the pure detector, expands dates for high/medium outflow series, passes `learned` to the builder, returns `detection` (null on any failure, logged by error name only).
- `lib/settings.ts` - `getDismissedSuggestions`, `setDismissedSuggestions`, `getAllDismissedSuggestions` (AppSetting key `recurring_dismissed:{entityId}`, JSON `{ v: 1, keys: [{ k, at }] }`, cap 200, unreadable value = empty).
- `components/upcoming/upcoming-parts.tsx` (`LearnedBadge`, `LearnedBlock`: "Looks recurring, not counted (N items, ~$X)", no blended money in the all-entities view), `upcoming-agenda.tsx` (mounts the block after the weeks), `upcoming-widget.tsx` (optional `detection` prop + hint).
- `app/forecast/page.tsx` - passes `detection` and mounts `<RecurringSuggestions>` after the Upcoming agenda. The other task's `formatCalendarDate` changes in this file were left exactly as they were (verified in `git diff`).
- `app/page.tsx` - passes `detection` to the widget; existing try/catch kept.
- `CLAUDE.md` - added ONE paragraph, **"Recurring detection"**, inserted immediately before the "**Testing pattern**" paragraph (right after "Upcoming ledger"), and changed one stale sentence in the "Upcoming ledger" paragraph ("`learned` is defined but never produced" -> produced only by the detector, never in a total).

Not touched (verified with `git status` / `git diff --name-only`): `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `prisma/**`, `actions/recurring-expenses.ts`, advisor files, `lib/card-due.ts`, `lib/__tests__/card-due.test.ts`, `components/accounts/accounts-page-client.tsx` (the other task's work).

## Deviations from the plan (and why)

1. Two extra files. `lib/upcoming-ledger-input.ts`: an existing guard test (`upcoming-ledger-tester-ui.test.tsx`, "imported only by the two pages") forbids any other importer of `lib/upcoming-ledger-build`, and the plan has the action re-run the loader; so the 13 reads moved to the new file and the action uses it plus `fetchDetectionData` / `runDetection` (cheaper too: no ledger build). `components/upcoming/recurring-hint.tsx`: when the hint lived next to the review list the widget transitively imported the client buttons -> server actions -> `lib/auth` -> next-auth, which cannot load under vitest and broke two existing render test files; the widget now imports only the hint file. Both existing test files were NOT modified.
2. Annual series must have a FIXED amount (plan only said "always low"). Live, a convenience store ("Jiffy Mart") passed as a yearly "varies" bill from two purchases; Teacher AI (fixed 147.00) still shows.
3. The day-rule text for a 4-7 day spread is "around the 13th, day varies" (plan: "mid-month, day varies", which is wrong for an end-of-month bill).
4. A series whose last two payments moved to a new price (price rise) stays a FIXED series at the new price (needed so the "was about X, now about Y (2 in a row)" flag can exist; otherwise a 2-in-a-row price rise made the series "varies" or rejected).
5. Plan 5.6 refinements, all conservative: weekly/biweekly late flags stop after 3 cycles (plan only gave the monthly 25-day stop); a recorded item is not flagged late when its last matched payment is more than 75 days before the expected date (a stopped bill is not "late"); tag matching uses only the DOMINANT payee of a budget category (60%+ of its rows), so a category holding several payees is never treated as one bill; "history differs" needs 4+ matched payments, a history steady at its cadence (80% of intervals fit), a steady amount for the amount-only variant, and a $5 floor on the 25% amount gap.
6. `ModelledRef` gained `direction` (outflow/inflow), `DetectResult` / `DetectionBundle` gained `suppressed` (the add action needs it for "Already recorded"), `Flag` gained `entityId` and carries the label inside `text`.
7. "Add as recurring expense" is allowed for annual series (the plan's "refuse low-confidence annual with no date" contradicted its own test list "annual maps to annually"); it is refused for deposits.
8. Detection reads run in parallel with the ledger reads (not after them) to limit dashboard cost.

## Commands run and results

- `pnpm typecheck` - clean (`tsc --noEmit`, no output), run after the final change.
- `pnpm lint` - 0 errors, 52 warnings (identical to the previous task's baseline of 52; all in unrelated pre-existing files). `npx eslint` on every new/changed file of this task prints only one warning, `DAY_NAMES` unused in `app/forecast/page.tsx` (pre-existing at that line, not mine).
- `pnpm vitest run lib/__tests__/recurring` - 4 files, 114 tests, all passed.
- `pnpm vitest run lib/__tests__/upcoming lib/__tests__/recurring` - 9 files, 324 tests, all passed (the 5 existing upcoming files unmodified).
- `pnpm test` (full, run after the final code change) - **414 test files, 11,854 tests, all passed** (270 s). An earlier full run (before deviation 1) failed 2 existing render-test files on the next-auth import; fixed as described, then re-run clean.
- Read-only live smoke through the real loader (temporary tsx script, deleted; reads only, names/counts/amounts printed). 2026-10-08, 30 days:
  - All entities: 18 suggestions, 5 suppressed, 15 stale; 14 learned items (625.58) in `ledger.learned`; counted outflow 8,038.32 (identical to the figure without learned). Personal: 15 suggestions, 3 suppressed, 10 stale; 12 learned items (599.66); counted outflow 6,895.64.
  - Suppressed (not offered): Mortgage (PennyMac), Solar (Enerbank), Toyota/Lexus (tag), SV Amica (name), SV Xfinity (amount+day vs the "Comcast" bill). Paychecks never appear (payroll skip word). No grocery/gas/retail series.
  - Suggestions include Google One 21.76, Tmna 15.15, YouTube Premium 28.70, bank Maintenance Fee 15.00 (two accounts), Ring 21.26, Arstrat 137.94, Aff Cozyla 109.18, Comcast ~75 (varies), Max 19.66, quarterly Newlondon ~53 and Waterford Ct Utility ~88, SV Sqsp 8.93 and Ueni 16.99 (all-entities view), low: Github 4.25 (3 times), Netflix 21.26, Onlinenexu 34.95, Teacher AI 147.00 (annual).
  - Flags: exactly one, the Lexus heads-up: "Lexus Financial ...: your records say $250.00 monthly; history shows about $250.00 every week." No late flag (Mortgage is not late today), no amount-change flag.
  - Timing: the detection reads alone take about 1.7-2.5 s against the remote DB; the full ledger + detection load was about 1.8 s warm (2.6 s cold) for Personal after running the reads in parallel. I did not time the pre-change ledger alone.
  - I did not run either page in a browser or click any button.

## Needs human visual verification (no browser tool for the Coder; static markup is test-covered only)

1. `/forecast?bucket=personal`: the "Looks recurring" card appears below the Upcoming agenda; `#looks-recurring` scroll anchor; sections "Looks recurring, not in your budget", "Heads up" (Lexus line), "Regular deposits" (likely empty today), "Dismissed (N)" collapsed; the footer line; the 30/60/90 tabs still keep `bucket`.
2. In the agenda: the blue "Looks recurring, not counted (12 items, ~$599.66)" block sits after the weeks, rows carry the "Learned from history" badge, and the summary strip total did NOT change. Check `?bucket=taxes` (all-entities): heading shows the count only, no blended money, entity chips on rows and on the review list.
3. Click "Not a bill" on one suggestion: it disappears after the refresh and shows under "Dismissed (1)"; "Show again" brings it back (this writes one AppSetting row; do it once on purpose).
4. Click "Add as recurring expense" on ONE suggestion you really want (e.g. Google One): a row appears on `/budgets` recurring list / forecast, the suggestion leaves the list, a second click (or reload) says "Already recorded". Check the created name, amount, frequency and day.
5. Dashboard `/?bucket=personal`: the muted line under the summary strip ("15 items look recurring but are not in your budget. Review"), the link lands on `/forecast?bucket=personal#looks-recurring`; no line at all when there is nothing to say.
6. Force a failure once (for example by temporarily renaming the setting read) to see "Recurring-pattern checks are unavailable right now." on both pages without the page breaking (code path is try/catch and render-tested only).
7. Wording read-through: nothing reads as advice or certainty; every dollar figure is "~" or "about".

## Open items

- Dashboard cost: detection adds roughly one more query of ~4,600 rows (+ tags) to every dashboard and forecast load (about 1.7-2.5 s on its own, overlapped with the ledger reads). If the dashboard feels slower, wrap the widget in `Suspense` (not pre-built).
- The "low" label reads "Weak pattern, 17 times" for Netflix 21.26 because its charge day drifts (day spread > 7 caps confidence at low per the plan). The wording is accurate to the rule but looks odd for 17 payments; the owner may prefer a "day varies" label. Not changed.
- Netflix and Comcast price-creep thresholds (10% and $2) could not be exercised live: no live series currently has a price change. Constants are unchanged; the Tester may re-check after the next price change.
- A dismissed series is matched by key or token prefix; a merchant whose bank descriptor changes later can resurface once (harmless).
- `ModelledRef.expectedAmount` for budget lines is derived from the monthly budget (per payment for weekly/biweekly); lump-sum and quarterly budgets give null, so they are never compared by amount.
- Pre-existing, not touched: `/forecast` card table date formatting is the other task's fix; the month-length clamp lives in `lib/forecast.ts` (done by another task).
- Untracked `pnpm-workspace.yaml` and `scripts/setup-eva-account.ts` are not mine.

## Review round 1 fixes

Addressed `04-review.md` required items 1 and 2 and should-fix 3. Defects 3-6 left deferred as the Reviewer decided. Nothing staged or committed; no DB access; `lib/forecast.ts`, `lib/business-forecast.ts`, notifications, prisma and the committed jetBlue edits untouched.

1. **Card-payment descriptors (`lib/recurring-detect.ts`, `SKIP_PAYEE_RE`).** Appended `crcardpmt`, `\bepayment\b`, `\bmobile pmt\b`, `\bcard pmt\b`, `barclaycard`, `\bamex\b`, `american express`. Plain `payment` / `paymt` deliberately NOT added (comment explains why). Tests in `lib/__tests__/recurring-detect.test.ts` ("exclusions"): one test per descriptor (7 payees: `capital one crcardpmt`, `amex epayment ach pmt`, `capital one mobile pmt`, `citi card pmt`, `barclaycard us payment`, `amex`, `american express autopay`), each checking no suggestion (six monthly 100.00 rows, checking) and no late flag (tag-linked modelled ref, today 2026-10-20); plus one negative test that `enerbank usa acct paymt` and `invoice cloud webpayment` still yield exactly 1 suggestion.
2. **Empty canonical payee (`filterRows`).** `if (canon === "") continue;` after canonicalizing. Test: `***` and `###` monthly rows plus a tag-linked `***` series give 0 suggestions, 0 suppressed, staleCount 0 and 0 flags.
3. **Fail-soft isolation (`app/page.tsx`, `app/forecast/page.tsx`).** `toUiLedger(...)` now runs first; `toUiDetection(...)` is in its own try/catch after it, setting `upcomingDetection = null` and logging only `err.name` on failure. Semantics kept: `undefined` = ledger failed, `null` = only pattern checks failed. New cheap source-reading pin `lib/__tests__/recurring-detect-page-isolation.test.ts` (4 tests: one call per page, after `toUiLedger`, inside own try whose catch resets to null).

Mutation check (temporary, restored): with the new regex tokens and the empty-canon guard removed, 8 of the new tests fail (7 descriptor tests + the punctuation test); the negative test passes either way as expected. File restored and re-verified.

No existing test was modified (tester files `recurring-detect-tester*.test.ts` and `recurring-suggestions-tester-actions.test.ts` untouched and passing).

### Commands run (this round)
- `pnpm vitest run lib/__tests__/recurring-detect.test.ts`: 85 passed (was 76: +7 descriptor, +1 negative, +1 punctuation).
- `pnpm vitest run lib/__tests__/recurring-detect-page-isolation.test.ts`: 4 passed.
- `pnpm typecheck`: exit 0, no output.
- `pnpm lint`: 0 errors, 52 warnings, all pre-existing in other files (none in the files touched here).
- `pnpm test` (full): 420 files passed, 11965 tests passed, 2 skipped (the `UL_OLD` differential tests), 267.5 s.
