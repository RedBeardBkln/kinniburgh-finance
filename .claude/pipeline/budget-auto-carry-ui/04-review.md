# Review: budget-auto-carry-ui

**Verdict: APPROVED** (no blocking findings; the should-fix items below are not required to ship, but S1-S3 should be done soon).

Reviewed against HEAD e9be236, uncommitted tree, by reading the real code (not the write-ups): `lib/budget-materialize.ts`, `lib/budget-materialize-build.ts`, every export of `actions/budgets.ts`, `app/budgets/page.tsx`, `components/budgets/*`, the dashboard drill dialog and `lib/dashboard-drill*.ts`, `app/page.tsx`, `lib/monthly-review-build.ts`, `exportBudgetCsv`, `lib/budget-carry-forward*.ts`, the guard-test diffs and the CLAUDE.md paragraph.

Independently re-run: `pnpm typecheck` clean. `pnpm lint` 0 errors (52 warnings; the one above the 51 baseline is `_opts` in a Tester-named file, not Coder code). Budget/dashboard/materialize/guard slice: 27 files, 482 tests, all pass (includes the 400-world x 5-edit and 400-world x 5-delete property tests against an independent oracle that does not import the resolver). Full `vitest run`: 13,594 pass, 3 fail, all 3 in the Tester's in-progress `lib/__tests__/budget-auto-carry-tester-oracle.test.ts` (its regex `hashtext\(\?\)\)\?` expects a literal `?` after `))`; the code's actual first statement `SELECT pg_advisory_xact_lock(hashtext(?))` is correct). That is a bug in the Tester's test file, not in the implementation; it must be fixed or removed by the Tester before the suite is declared green.

## Checks against the ground rules and the owner's rule

- Rule 3 (immutable facts): no Transaction is touched. Budgets are mutable metadata. The first edit writes many rows (46 for Personal in 2027-01; 276 in 2027-06 with the gap fill) but every saved row equals what the owner already sees and what the forecast already uses (invariant I1, proven by the oracle test), so no month's figures change. Proportionate for metadata; disclosure is partly incomplete (S1).
- Rule 5: `requireAuth()` is the first statement of all five exports (a guard test pins it by source scan; I read each). No Budget id is accepted anywhere: locator `{entityId uuid, tagId uuid, period YYYY-MM}`, a synthetic `carried:` id can only be a React key. The locator is client-supplied but is validated by the in-lock "line must be on this month's effective budget for THAT entity" check, so a forged entity/tag pair is refused. `createBudget`'s entityId/accountId pairing is not cross-checked, exactly as before (pre-existing, not a regression). AuditLog rows carry entityId, tagId, period lists and counts only (`budget_materialize`, `budget_end_line`); no amounts.
- Rule 6: the planner filters by entity first (I5 property-tested); the only cross-entity read is the household-wide "tag can have one holder per period" check, now over the EFFECTIVE view (a carried tag counts, as on screen). Verified in the code.
- Rule 8 / tax: nothing in `lib/tax2025/**` or `lib/tax-review/**` changed; the guard keeps them away from the carry modules.

## Correctness of the mechanism (all verified by reading)

- Transaction shape: one interactive `db.$transaction`, advisory lock FIRST (`pg_advisory_xact_lock(hashtext(?))`, parameterised; I confirmed the same statement and options are deployed in `lib/review-queue-server.ts` `lockAssignPair`, so the "no precedent" worry in the plan is moot), then a full read of the rows INSIDE the lock (READ COMMITTED, so a second tab sees the first tab's commit), plan, `createMany({ skipDuplicates: true })` (never overwrites; a second call creates 0), the edit by the unique key, and the audit row only when rows were created. `BudgetRefusal` throws roll everything back, so a refused or failed edit leaves nothing half-saved. 15 s timeout, fail-closed above 5000 rows.
- Planner: months planned = target plus every row-less month from the entity's first row through max(target, frontier); only `source === "carried"` rows are created; rolloverAmount -> null, additionalAmountCents -> 0, rolloverEnabled copied; a month before the entity's first row plans nothing. Both the loader and the planner call the single `resolveEffectiveRows`, so the `carryVariable` option cannot drift between what is shown and what is saved.
- Variable lines (Electric/Oil/Firewood) saved with their flat figure: right. Nothing in the seasonal code branches on `source`/`carriedFrom` (grep: only descriptive notes in `budgetAlertNote`, ledger and advisor), the seasonal model is keyed by entity+tag, and 2026's own rows are already flat, so the owner sees no new behaviour on /budgets or the dashboard; the only change is the "carried forward" note disappearing for a saved month.
- Delete = end the line from that month on: logic traced for M <= frontier (delete the line's rows >= M, fill other lines' empty months first), M > frontier (save the other lines for the gap and M without the line), the line's own gap months before M (saved first so no earlier month changes: the Coder's deviation 2, found by the oracle and correct), and the refusal when the entity's latest month would empty. Resolver unchanged, so UI and forecast agree. Confirm text states "removed from <month> and every later month" and that the bill is deactivated; the dialog is adequate for the stated rule.
- Bill deactivated immediately even if the end month is in the future: ACCEPTABLE as shipped (old `deleteBudget` did the same for any period, the confirm text says it, and the alternative, leaving it active, would project a phantom bill after the end because `ScheduledBill` has no end date). Deferred (D3).
- 24-month write horizon / 12+12 picker: sound. URL-only months beyond the horizon render but refuse writes with a plain message. Largest UI-reachable first edit today is about 460 Personal rows (Oct 2027 picker edge); the 24-month ceiling is about 1,000. Acceptable for a one-time, idempotent, view-preserving write.
- Interaction with the recurring-expense override and nesting: materialization copies RAW `budgeted` (null stays null), not the displayed override value; `resolveEffectiveBudgets` is untouched, so override/nesting/roots-only totals are unchanged. Dashboard Total Budgeted and /budgets both read the loader, so they reconcile.
- Failure modes: /budgets, monthly review and the CSV still throw on a read error as before; the dashboard keeps `settle` fail-soft. New minor coupling: the loader also reads the `seasonal_budget_lines` AppSetting, which /budgets, the CSV and the monthly review do not need (N2).
- Guard tests: the allow-list changes are deliberate and reasoned in comments (loader, write module, actions, recurring-suggestions existence checks; four former real-row readers moved to the consumers list). New source-scan tests pin: locator not id, requireAuth first, lock first, create-only/`skipDuplicates`, single `deleteMany`, planner purity. Two additional old-contract guard tests were changed (`budget-carry-forward-tester-guard`, `dashboard-drill-guard`), disclosed in deviation 3; I read both diffs and they are narrowings tied to the new design, not weakenings. The page-test assertion change `where {entityId, period}` -> `{entityId}` is the loader's real shape.
- CLAUDE.md: HAZARD sentence and the "NOT changed" list are gone; the new paragraph matches the code (I checked the locator, 24-month refusal, delete semantics, additional buffer not carried, CSV gap). No emojis, ASCII.

## Findings

### Blocking
None.

### Should-fix (not required to ship; do next)
- S1. Disclosure of the multi-month write. The `/budgets` notice says "the whole list is saved for this month", but an edit in a month beyond the entity's latest saved month also saves EVERY empty month in between (2027-06 saves 2027-01..06). It also freezes those in-between months: later amount edits to an earlier month no longer flow into them (the carry only reaches row-less months, and `applyToFuture` pushes schedule fields, not amounts). Suggested: when the viewed month is more than one month after the entity's latest saved month, append "and the N months between" (can be computed in `carriedMonthNotice` / the page from the same rows). `lib/budget-materialize.ts` `carriedMonthNotice`, `app/budgets/page.tsx`.
- S2. The dashboard inline "Budget" edit (`components/dashboard/drilldown-dialog.tsx` -> `updateBudgetLine`) can silently trigger the same save on a carried month, with no "carried" indication anywhere on the dashboard. For the current month it is small (EK Consulting October = 10 rows), but add a muted "carried from <month>" line in the line dialog, or pass a carried flag through `lineEdit`.
- S3. Delete confirm does not say how much saved data goes with it. Deleting in a past or middle month removes the line's real rows in every later month (history of that line's budget on the dashboard/monthly review), and the dialog only says "every later month". Cheap improvement: have the page pass, per line, the count of saved months at or after the viewed one and print "(N saved months)". The button is still labelled "Delete" while the action is "end"; consider "End line".
- S4. Rename the stale `describe("TESTER: the frontier hazard is real and documented")` in `lib/__tests__/budget-carry-forward-tester-oracle.test.ts:253` to say it pins the RESOLVER's behaviour in isolation and that the app no longer produces that state. The assertions are still correct (resolver unchanged).

### Nits
- N1. Dashboard "Overspent Lines"/Total Budgeted for EK Consulting now show the 10 carried 2026-09 lines (Utilities 361 vs 200 etc.) for October on. That is the owner's rule and was already firing in notifications; make sure Eric is told it is expected (the implementation report does state it).
- N2. `loadEffectiveBudgetRows` reads the `seasonal_budget_lines` AppSetting even for callers that cannot use it (/budgets, CSV, monthly review); a read failure there now fails those pages. Negligible probability; a `skipVariableKeys` option would remove the coupling.
- N3. Delete's "already gone" returns success without a message, correct for a double click but gives no feedback if the user's view was stale (it simply refreshes). Fine.

### Deferred, agreed with the Coder (record, do not do now)
- D1. CSV ignores the recurring-expense override that /budgets and the dashboard apply, and has no "carried" column (plan Q5/Q6).
- D2. Non-action writers of Budget rows (`scripts/import-budgets.ts`, manual SQL) bypass copy-on-first-edit and could still move an entity's latest month; none runs in the app.
- D3. Linked bill is deactivated when a line is ended in a FUTURE month (needs an end date on `ScheduledBill`; schema change).
- D4. Per-month "skip once" needs a tombstone column (plan Q1 answered no).
- D5. Advisory lock not exercised live against the pooler (no writes allowed); first real edit is the proof, failure symptom would be the 15 s timeout, never a partial save.
- D6. Items needing a human with a browser (impl report list): carried banner/readability, the real first edit in a far month, confirm dialog wrapping, picker across the year boundary.

## Route-back target
Not applicable (APPROVED). If S1-S3 are taken up, they are coder-level changes.

## What's good
- Single source of truth done properly: one `resolveEffectiveRows` for the loader and the planner, resolver semantics untouched, and an independent brute-force oracle (not importing the resolver) proving "saving never changes any view", idempotence, entity separation and delete semantics over random worlds, which already caught a real planner gap (the line's own gap months).
- Safe write design: global advisory lock first, read inside the lock, DB-enforced no-overwrite, whole-edit rollback, audit with ids/periods/counts only, and an existing deployed precedent for the pooler pattern.
- The contract change from Budget id to locator was done deliberately across all five paths, including the fifth one the request did not list (dashboard inline edit), and the guard tests were updated with reasons rather than loosened silently.
- Honest reporting: deviations, the changed guard tests and the open items are all disclosed; live numbers (46/8/10 lines, 276 rows in 2027-06) match the planner.

---

# Re-review (round 1)

**Verdict: APPROVED** (narrow re-review of the round-1 fixes; no blocking findings; one should-fix and a few nits below).

Scope: I read the new resolver (`lib/budget-carry-forward.ts`), the planner and guards (`lib/budget-materialize.ts`: `planMaterialization`, `planEndLine`, `addChangesEarlierMonth`, `carriedMonthNotice`), `createBudget` in `actions/budgets.ts`, `lib/budget-first-edit-note.ts`, `loadFirstEditContext(Safe)` in `lib/budget-carry-forward-build.ts` and its two call sites (`app/budgets/page.tsx`, `app/page.tsx`), plus the Coder's "Round 1 fixes" and the Tester's "Re-test (round 1)". Re-run by me: `pnpm typecheck` clean; slice `lib/__tests__/budget* dashboard* budgets*` = 31 files, 536 tests, all pass (includes the Tester's 400-world and 300x14-write invariants). I also grepped production callers of the resolver: only the loader and the planner call it, so no consumer passes a partial row set that the "month with rows is authoritative" test could misjudge. No source edited, nothing staged.

## (1) Is the authoritative-month rule coherent, and can it silently drop a line?

Coherent. The owner's stated rules are: budgets carry forward automatically; a dropped line stops carrying; no one-month skip. The new rule keeps all three: carry still applies to every month in which the entity has no rows (everything after its latest month, and an entity-level empty gap), still from the line's latest own row, still guarded by "line is in the entity's latest month", still no rollover/additional. What it removes is the old behaviour of filling an individual missing line into a month that already has rows, which is what let a re-added ended line leak backwards (the Tester's D1). It also makes the resolver, the planner and the saved rows agree by construction: a first-edit save produces exactly "months with rows", so I1 (saving never changes a view) holds, and the oracle tests cover it independently of the resolver.

Live effect: none. Coder and Tester both compared the HEAD resolver with the new one on real rows (494 cells, 0 differ, Total Budgeted identical per entity-month), and the Tester's own SQL found 0 live months where a line present in the latest month is missing from a month that has rows. Consistent with the plan's live finding (0 gap months, 0 row-less months inside any range).

Silent-drop exposure (accepted, non-blocking):
- A month filled by hand with a partial set (manual SQL, `scripts/import-budgets.ts`, a restore) now shows just those lines; before, the missing lines would have been carried into it. That is the intended consequence of "a month with rows is authoritative", and it matches what that same month already did to every LATER month under the frontier rule (a single-line latest month already ended everything else), so it is not a new class of surprise. The app's own writes cannot produce such a month: the first change saves the whole carried set and ending a line refuses to empty a month.
- An entity whose latest month was entered line by line: lines absent from that latest month are by definition ended (step-1 owner answer 1), unchanged.
- Variable lines (Electric, Oil, Firewood) follow the same rule: a month with rows but no Electric row shows no Electric instead of the flat carry. Live: none.
- Every reader uses the one resolver through the loader (grep confirmed), so Forecast, ledger, advisor, notifications, dashboard and /budgets all drop the same line in the same month.

Question for the owner (pre-existing semantics, not a round-1 regression, but worth saying): a NEW line added to a month that is earlier than the entity's latest saved month (for example a new bill added in October 2026 while Personal has saved months through December) is, by the ended-line rule, present only in that month: it is not in the latest month, so it neither fills the saved months after it nor carries into 2027. The app has always behaved this way with the pre-created 2026 rows, and the re-add guard does not address it. The owner's stated model ("whatever is listed in the budget is what is used to forecast forward") suggests he may expect it to continue. See S5.

## (2) Are the new refusals clear and non-blocking in normal use?

- End-line refusal (no month that holds rows may be left with none): no normal case triggers it; the only live-reachable case is ending the last remaining line of a month. The Tester's fuzz shows refusals write nothing (no rows, no bill change, no audit row) and always name a month. Message: "This is the only line left in <Month>; add another line or remove it from the earlier month." Acceptable. Nit N4: for a MIDDLE month that holds only this line, "or remove it from the earlier month" does not help; the useful advice is just "add another line to <Month> first".
- Re-add guard `addChangesEarlierMonth`: fires only for a re-added line (older rows exist) when an earlier ENTITY-LEVEL empty month exists in which nothing is carried today. The app's own writes never create such a month, so it is effectively a safety net for hand-made data. Message: "Adding this line here would also make it appear in <Month>, an earlier month that has no budget lines. Add it to that month first, or choose that month instead." Actionable (names the earliest month), nothing is written, and the Tester followed the advice in 60 cases to success.
- Both refusals run inside the lock before any write (`createBudget` calls the guard before `materializeForEdit`) and `BudgetRefusal` rolls back, so they cannot leave half-saved rows.

## (3) Is the wording honest and proportionate?

- S1 notice: yes. It states the number and span of months that will be saved ("saved for 6 months (January 2027 to June 2027): this month and every empty month before it") and the real consequence ("those months then keep their own amounts and no longer follow later changes made to earlier months"). The count comes from the same `planMaterialization` the write uses (`loadFirstEditContext`: explicit select, no relations); the Tester's fuzz proves told months equal created months (301 edits, 208 multi-month). Fail-soft: if the context read fails the sentence drops the count and says earlier empty months may also be saved, which is true; `console.error` logs `err.name` only.
- S2 dashboard note: appears only on a carried line, same counts, under the Budget amount. Adequate.
- S3 "End line" button and confirm: the count is the number of later SAVED months that hold the line, equal to the rows removed after the viewed month. Singular/plural correct. The confirm still says the scheduled bill is deactivated (accepted, D3).
- S4: describe renamed, assertions unchanged.
- Nit N5: the All-view sentence ("that line's entity is saved for this month and any empty month before it (Personal: 1 month, EK Consulting: 4 months)") is accurate but dense.

## (4) Ground rules

- Rule 3: no Transaction touched. Writes are still Budget metadata in one locked transaction, create-only (`skipDuplicates`) plus the single end-line `deleteMany`; the number of rows saved is now disclosed before the owner acts (the main proportionality gap from round 0).
- Rule 5: `requireAuth()` is still first in every export; no Budget id is accepted; the new loaders are read-only with explicit selects and no account/amount leakage (they run only from authenticated pages); AuditLog unchanged (ids, periods, counts). `budget-first-edit-note.ts` is pure and client-safe, and the guard tests still keep the carry/materialize modules out of client components.
- Rule 6: planning, the guard and the counts are all per entity; the cross-entity tag check is unchanged.
- Rule 8 / tax: no tax code touched.

## Findings from the re-review

Blocking: none.

Should-fix (not required to ship):
- S5. When a line is added to a month earlier than the entity's latest saved month, tell the owner in the Add dialog ("This month is before your latest saved month (December 2026). The line will exist in this month only unless you also add it to the later months.") or offer "also add to later saved months". This is the one place the app can still differ from "it carries forward automatically"; it is pre-existing and a product decision, so do not block on it.

Nits:
- N4. End-line refusal wording for a middle month holding only this line (see 2).
- N5. All-view notice wording is dense.
- N6. CLAUDE.md first rule sentence ("A month with no row for an entity + tag uses the latest EARLIER row") is immediately qualified by the authoritative-month sentence; consider putting the exception first (the Tester noted this too).

Deferred: D1 to D6 from the first review stand; no new deferrals.

Route-back target: not applicable (APPROVED).
