# Test report: budget-auto-carry-ui (automatic carry-forward on /budgets, copy-on-first-edit)

**Verdict: FAIL**

One in-scope defect (D1, medium): `createBudget` for a tag whose line has ended changes earlier months' effective view (the line comes back as "carried" in every month between its last row and the new month). That violates the stated key invariant ("saving a month never changes any other month's effective view except the intended edit"). Everything else verified passes. HEAD e9be236, work uncommitted. No write was made to the live database (read-only SELECTs via two temporary repo-root scripts, both deleted).

## Acceptance criteria (plan section 9) and the lead's checklist

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `/budgets?period=2027-01` shows carried lines labelled, one notice, no copy button; Personal 46 / SV 8 / EKC 10 | PASS | Live read-only: Personal 2027-01 = 46 carried from 2026-12, Total Budgeted 15,214.58 (equal to 2026-12 own); SV 8 from 2026-12, 1,399.00; EKC 10 from 2026-09, 100.00 (also 2026-10..12). My loader-vs-own-oracle comparison on live rows: 0 mismatches over 9 periods x 4 entities. My page test (own fixtures, real page + client): 5 carried lines "Carried from December 2026", exactly 1 `carried-notice`, no `<button>` containing "copy", ended line absent. UI render itself NOT seen in a browser. |
| 2 | Total Budgeted on /budgets equals dashboard; Spent unchanged | PASS | Coder's page test renders both. Live: dashboard-model Spent for Personal 2026-09 = 17,162.22 and 2026-10 = 12,081.34, identical with the loader rows and with own-rows-only (the old input). My independent total (nesting, recurring override, additional not carried) 810.00 carried vs 815.00 own month (5.00 buffer not carried) in my page test. |
| 3 | First edit/add/additional/delete saves carried set + empty months in the same tx; second call creates none; nothing overwritten | PASS | My own fake (unique index, undo-log rollback, real mutex) + independent view oracle: 1400 edit steps (386 own-at-M, 642 carried-at-M, 603 M after frontier, 365 before, 712 with gap fill, 153 applyToFuture, 372 stale refusals). Expected row set == actual row set field by field, no extra rows, other entities untouched, idempotent re-call changes nothing, audit row only when rows created. |
| 4 | Materialization never changes any consumer's effective view | PASS for the 4 edit paths + delete; FAIL for create (D1) | Fuzz compares views over 2025-10..2029-12 for 3 entities after every step. Only create-of-an-ended-tag deviates. |
| 5 | No action accepts a Budget id / `carried:` id; dashboard inline edit uses the locator | PASS | Locator zod (uuid, uuid, `^\d{4}-(0[1-9]|1[0-2])$`): `carried:` ids, `2027-13`, `2027-1`, trailing space, null, missing fields all answer `Invalid budget line` with zero transactions (my test). Grep of components/budgets/*, drilldown-dialog, dashboard-drill: no row id passed to an action; `lineEdit` = `{entityId, tagId, period, ...}`. |
| 6 | Delete ends line from month on; refusal when latest month would be emptied | PASS | 350 seeds x 3 deletes vs strict oracle (view before minus line at months >= M; earlier months and other lines identical): >300 completed deletes (M before frontier, at frontier, after frontier each > 30), >10 refusals (exact message), gone-line = `{success:true, removedMonths:0}` and no writes, second delete no-op, bill deactivated, audit `{entityId, tagId, fromPeriod, deletedRows}` with TRUE count, `removedMonths` = rows removed + 1 when only carried. |
| 7 | rollover/additional not copied; variable lines saved flat | PASS | Every created row has `rolloverAmount` null and additional 0 in the fuzz; live plan on real rows: all creates null/0; `rolloverEnabled` copied (mutant killed). Variable lines are saved because the planner calls `resolveEffectiveRows` (carryVariable true). |
| 8 | Dashboard, monthly review, CSV use effective rows; no direct `.budget.` read left; guard updated | PASS | Code read of the three diffs + Coder consumer tests; grep: Budget table touched only by loader, `budget-materialize-build.ts`, `actions/budgets.ts`, `actions/recurring-suggestions.ts` (existence checks, unchanged); only writers are `actions/budgets.ts` and `lib/budget-materialize-build.ts` (plus `scripts/import-budgets.ts`, not app code). |
| 9 | No schema/migration/backfill; auth first; audit ids/counts only; hazard note removed | PASS | `git status`: no prisma, tax, or migration change. `requireAuth()` first in all 5 exports (5 mutants killed, see below). Audit keys whitelisted and value-checked in fuzz (no amounts/names). CLAUDE.md diff = lines 123 and 125 only, hazard sentence and "NOT changed: /budgets..." removed, ASCII only, CRLF intact (CR=LF=131). |
| 10 | typecheck, lint, test green incl. unreachable DB | PASS | below |

Lead items: (1) PASS; requireAuth removal killed for each of the 5 exports; `updateBudgetLine/updateBudget/updateBudgetAdditionalAmount/deleteBudget/createBudget` behaviour matches the old messages (existing error strings preserved; `applyToFuture` only touches later real rows, verified in fuzz with 153 cases). (2) PASS (lock first op, createMany skipDuplicates, double click, two tabs, 24-month limit incl. New York month boundary, stale refusal, rollback incl. audit row). (3) key invariant: PASS for the 4 edits + delete, FAIL for create (D1). (4) PASS (see 1/2; Mezzo empty state, entity separation, picker 2025-10..2027-10 + URL-only 2030-05, recurring override and nesting totals, rollover dash). (5) PASS incl. live 2026-09/10/12 and 2027-01 numbers; Coder's table reproduced exactly (46/276, 8/48, 40/90 first-edit sizes). (6) guard changes judged deliberate, see below. (7) PASS. (8) PASS; line endings per `git ls-files --eol`: modified CRLF files still all-CRLF (no lone LF), new files LF.

## Tests run (exact commands, real results)

- `pnpm typecheck` -> `tsc --noEmit`, exit 0 (re-run after adding my files: exit 0).
- `pnpm lint` -> `51 problems (0 errors, 51 warnings)`, exit 0. Same count as the Coder's baseline. The only budget-area warning is `components/budgets/budget-page-client.tsx:168 no-unused-expressions` in `toggleExpand`, present at HEAD (line 159 there). My two new test files: eslint clean.
- `npx vitest run` (normal env, as submitted, before I added files): `Test Files 501 passed (501)`, `Tests 13588 passed | 11 skipped (13599)`, exit 0. Identical to the Coder's numbers.
- Same with `DATABASE_URL`/`DIRECT_URL=postgresql://x:y@127.0.0.1:1/z`: this run also picked up my first draft of the new oracle file: `Test Files 1 failed | 501 passed (502)`, `Tests 3 failed | 13594 passed | 11 skipped`. The 3 failures were bugs in MY new test (fake lacked column defaults on `create`, wrong lock-string regex, an over-strict select assertion), all fixed; all 501 pre-existing files passed with the database unreachable; 0 lines matching `PrismaClientInit|Can't reach|ECONNREFUSED` in either run. After the fix: `DATABASE_URL=... npx vitest run lib/__tests__/budget lib/__tests__/dashboard lib/__tests__/monthly` -> `29 passed`, `502 tests passed`. (I did not repeat the 8-minute full suite after my later test-only edits; my 2 files alone: `npx vitest run lib/__tests__/budget-auto-carry-tester` -> 2 files, 20 tests passed.)
- Live read-only scripts (SELECT only, deleted): loader vs my oracle (0 mismatches), planner sizes, Spent, ended-line impact (below).

## Tests added (tester-named only)

- `lib/__tests__/budget-auto-carry-tester-oracle.test.ts` (12 tests incl. 1 `it.fails`): own fake db (unique index, undo-log rollback, advisory-lock mutex, setImmediate yields) and an own effective-view oracle (integer month index); real actions + real planner. Fuzz: edits/modal/additional (350 seeds x 4 steps, half of the worlds with line gaps), delete (350 x 3), create (250 x 3); branch-counter guards so it cannot pass vacuously; auth first + no transaction when unauthenticated; first transaction op is `pg_advisory_xact_lock(hashtext(?))`/`budget-write`; `maxWait >= 10000` and `timeout >= 15000` passed to `$transaction`; locator rejection; 24-month limit incl. NY boundary (2026-11-01T03:30Z still October); failure injection after the carried set was saved (update / findUnique / createMany / deleteMany) leaves no rows and no audit row; two-tab races (identical edits; edit vs delete in both orders) plus a negative control showing the harness does expose the race when the fake lock is off; D1 probe.
- `lib/__tests__/budget-auto-carry-tester-page.test.tsx` (8 tests): real `/budgets` page + real client over own fixtures (auto-sum parent with child, recurring override with a stored additional buffer, annual line, variable line, ended line, two entities, Mezzo); no write verb reachable from the page (any call throws).

## Mutation checks (temporary copies via alias config; real files untouched, sha1 verified)

72 mutants over `actions/budgets.ts`, `lib/budget-materialize-build.ts`, `lib/budget-materialize.ts`, resolver, loader (+ identity mutant survived as it must). Results: 63 killed by the Coder's tests, 4 killed only by mine (end-line delete not entity scoped; end-line audit `deletedRows` wrong; `$transaction` options dropped; `applyToFuture` `gt`->`gte`, an artifact of my fake not modelling `gte`, equivalent on real Postgres), 5 survivors, all equivalent: copying `rolloverAmount` in the planner (source is already a carried row, null), planning months before the entity's first row (nothing to carry), and removing the three explicit `lineIsInView` checks (the later `findUnique` null gives the same message and rollback). Note: an early pass for `actions/budgets.ts` was contaminated (the guard test scans `lib/` and failed on my temporary mutant copy); I re-ran all 27 action mutants without the guard test. Guard mutants (real files edited then byte-restored): 17 of 17 detected (db.budget added to /budgets page, dashboard, monthly review, CSV; new file with alias `client.budget`; action without requireAuth; action taking `budgetId`; client importing the carry module; write module using upsert / deleteMany / `skipDuplicates:false`; planner reading the clock; lock removed from the action source; dialog sending a row id; action importing the resolver; dashboard importing the resolver; `revalidatePath("/")` removed).

## Judgement of the Coder's test changes

- `budget-carry-forward-guard`, `budget-carry-forward-tester-guard`, `dashboard-drill-guard`: allow-list changes are deliberate and justified (screens moved from "real rows" to the shared loader; write module added; carry modules still banned from every client component, the nesting/total libs and tax code; new pins: locator not id, requireAuth first, lock first in the action, skipDuplicates, create-only write module, planner pure). None weakened an assertion that still applies. The dashboard guard's exact-string exemption for the one loader import in `app/page.tsx` is narrow. Mutations above prove the guards still bite.
- The other changed tests (`budget-carry-forward-build`, `-tester-consumers`, five dashboard fixture files, `dashboard-drill.test`, `dashboard-accuracy-tester-page`): select-key pin gains `account` (and a new exact-shape pin on it), fixtures gain `entityId`/`period`/`tag`, the pinned loader `where` changes from `{entityId, period}` to `{entityId}` (the shared loader needs the later months for the frontier), `lineEdit` expectation becomes the locator. All legitimate contract updates; no assertion was loosened.

## Defects

### D1 (medium, in scope, blocking): re-adding an ended line brings it back in earlier months

- Repro (unit, runs today as `it.fails` in `budget-auto-carry-tester-oracle.test.ts`, "defect probe"): entity E rows: OLD@2026-10, A@2026-10, A@2026-11, B@2026-11, A@2026-12, B@2026-12 (OLD ended after October; 2026-11 and 2026-12 show A,B only). Call `createBudget({ tagId: OLD, entityId: E, accountId, period: "2027-01", budgeted: "40.00" })`.
- Expected: only 2027-01 (and later) gain OLD; 2026-11 and 2026-12 unchanged.
- Actual: success, and OLD now appears carried (budgeted 33.00, "Carried from October 2026") in 2026-11 and 2026-12 (resolver: OLD is now in the entity's latest month, and months with other rows but no OLD row carry it from its last row). Total Budgeted, the dashboard, the forecast and notifications of those past/current months change.
- Why: `createBudget` materializes the carried set and then inserts the row, but nothing protects the months between the tag's last old row and the new month. The planner's own gap-month protection exists only for Delete (`planEndLine`); the Coder's test for this case ("an ended line can be added again as a new line") only checks that the new row exists.
- Live impact (read-only, real resolver on real rows): Personal has 32 ended lines (79 line-months at risk), Sudden Valley 4 (12). E.g. re-adding "Food & Drink / Restaurants / Gas Stations" (last row 2026-09) in 2027-01 would show it in 2026-10, 2026-11 and 2026-12, including the current month October. EK Consulting has none.
- Pre-existing resolver semantics, but the plan's invariant I1 and the lead's key invariant promise no such side effects, and the tester oracle for Delete shows the Coder knew the class. Needs a decision (Planner/Coder): refuse or warn at create when the tag has earlier rows ending before the previous month, or change resolver semantics so a line does not carry across a month where its entity has rows but the line is absent (that is a pinned semantic; 0 live gap months today, and Delete no longer creates gaps).

### Observations (not blocking)

- O1 (low): an edit to a line at month M also changes the same line's carried figure in later months that are inside the saved range where other lines have rows but this one has none ("line-gap" months). 200 occurrences in the 1400 fuzz steps, only in worlds built with line gaps; 0 live (no gap months exist). Combined with D1 these gaps are what a re-added line creates.
- O2 (low): the `applyToFuture` read in `updateBudget` (`tx.budget.findMany({ where })`) has no explicit `select` (the plan says explicit selects; a write path inside a transaction, Budget has no secret columns, same as HEAD).
- O3 (info): `budget-carry-forward-tester-oracle.test.ts` still has a describe titled "the frontier hazard is real and documented"; true of the resolver, no longer reachable from the app (noted by the Coder).
- O4 (info): `react` "Each child in a list should have a unique key" warning in `BudgetPageClient` (pre-existing structure, unchanged lines).
- O5 (info): worst-case first edit is ~8 round trips; the 15 s transaction timeout is fine on Vercel-to-Supabase but this laptop's 480 ms RTT would make a 276-row edit slow (not an issue in production).

## Not tested

- Real browser / visual: carried-line label, notice, confirm and alert text wrapping, month picker UI, dashboard inline edit on a carried month (no agent has a browser or login). Hand/static checks only.
- The advisory lock and the interactive transaction against the real Supabase transaction pooler (writes forbidden; precedent `lockAssignPair` in `lib/review-queue-server.ts` has the identical statement and is deployed).
- Real server actions end to end against Postgres (unique-index behaviour is modelled in two fakes, not exercised on a real database).
- `pnpm build` / `next build`, migrations (none exist).
- Full suite not repeated after my last test-only edits (targeted runs only, see above).

## Files

- `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\budget-auto-carry-tester-oracle.test.ts`
- `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\budget-auto-carry-tester-page.test.tsx`
- Report: `D:\Repos\Personal\kinniburgh-finance\.claude\pipeline\budget-auto-carry-ui\03-test-report.md`

---

# Re-test (round 1)

**Final verdict: PASS**

D1 is fixed and I found no scenario in which an edit, end-line or add changes another entity, another line or an earlier month. HEAD still e9be236, nothing staged or committed, no live DB write (read-only SELECT scripts, deleted; `git status` has no `_tester*` or `zz-*` file). One correction to my round-0 report is in item 5 (observation O1).

## 1. New resolver rule (authoritative months), against MY oracle written from the owner's words and 01-plan

- Oracle (`budget-auto-carry-tester-oracle.test.ts` `view()`): a line shows in a month if it has an own row; else it carries only if the entity has NO row at all in that month, from the line's latest earlier own row, and only if the line is in the entity's latest month; no rollover or additional amount. Written from the rule, not from `lib/budget-carry-forward.ts`.
- Fuzz re-run with every entity's view checked over 2025-10..2029-12 after each step: 1400 edit steps (350 worlds x 4; own-at-M 391, carried-at-M 637, M after latest 603, before 365, gap fill 712, applyToFuture 153, stale refusals 372), 1050 delete steps (350 x 3), create fuzz enlarged to 2000 adds (400 x 5; 871 created). All pass.
- My D1 repro passes as a normal test: after `createBudget(OLD, 2027-01)`, 2026-11 and 2026-12 show only A and B, 2026-10 keeps its own OLD row, OLD shows from 2027-01 (checked through 2028-06).
- Resolver mutants killed by my tests alone: rule removed (old resolver), "any entity has rows" (needed a new page test, added, then killed), "more than one row".
- Live (own SQL, `git show HEAD` copy of the old resolver vs the new one on real rows, all entities, 2026-09..2027-03): 494 effective-line cells, 0 differing, Total Budgeted identical in every entity-month (Personal 17,192.14 / 16,266.33 / 15,214.58 from 2026-11; Sudden Valley 2,549.00 then 1,399.00; EK Consulting 100.00; Mezzo 0). My own SQL also finds 0 live months where an in-latest-month line is missing from a month that has rows, which is why nothing changes live.

## 2. Planner, refusals, re-add guard

- First-edit fill of empty months up to the edited month is kept and agrees with my expected row set (field-by-field row-set equality in the 1400-step fuzz). The round-0 "save the ended line's own gap months" block is gone and nothing needs it (delete fuzz: earlier months and other lines identical).
- Generalized end-line refusal: I derived feasibility independently (realise "view before minus this line from M on" the only way the app can, compare views). Over 1050 delete steps: 157 refusals; a delete that would change another month's view is never allowed (infeasible is always a subset of refused); 58 of the 157 refusals are stricter than strictly necessary (a month holding only this line where nothing else would carry, so ending would be harmless). That matches the stated product rule ("refuse if it would leave any month holding rows with none"); conservative, not a defect. Middle-month refusals occur and the message `This is the only line left in <Month>; ...` names an offending month every time; a refusal writes nothing (no rows, no bill change, no audit row).
- `addChangesEarlierMonth` (re-add guard) agrees exactly with my independent simulation. 400 crafted worlds (ended lines, entity-level empty months) x 5 adds: 341 refusals (all re-adds of old tags) and 916 accepted; every refusal message contains the earliest affected month and ends "Add it to that month first, or choose that month instead."; nothing written on refusal; every accepted add leaves all earlier months unchanged. The advice works: in 60 follow-ups, adding to the named month first, then to the wanted month (month by month if several), always ended in success.
- Broad search for any change to another month: 300 worlds x 14 random writes (inline edit, modal incl. applyToFuture, buffer, add, end) = 3025 successful writes and 1175 refusals. After every successful write nothing changed in another entity, in another line, or in any month before the edited one; every refusal left rows and views identical. None found.
- Mutants on the new logic (guard always null, one-way, names the latest month, ignores the saved set; end-line lost-month refusal removed or latest-only, target refusal removed, fill removed; action not calling the guard; later-count off by one; save-month list wrong): 14 of 14 killed by the Coder's tests and 14 of 14 by mine alone (identity mutant survives as it must).

## 3. Live read-only numbers

First-edit month counts through the real planner on real rows (no write): Personal 2027-01 = 1 month (46 rows), 2027-06 = 6 months (276); Sudden Valley 1 (8) and 6 (48); EK Consulting 4 (40) and 9 (90); in 2026-10 only EK Consulting has anything to save (1 month, 10 rows). Matches the Coder's 1/6, 1/6, 4/9.

## 4. S1 to S4

- S1 notice: `loadFirstEditContext` uses `planMaterialization(...).months`, the function the write uses. My fuzz (301 edits, 208 of them multi-month) proves the told month list equals the set of months the write actually creates. Wording variants checked: one month "the whole list is saved for this month."; several "saved for 3 months (January 2027 to March 2027): this month and every empty month before it. Those months then keep their own amounts and no longer follow later changes made to earlier months."; unknown "... If earlier months after the last saved one are also empty, they are saved too."; All view "(Personal: 3 months, Sudden Valley: 3 months)"; no notice and no "saved for" text on a month with its own rows.
- S2 dashboard note: real dialog + real drill builder rendered: one `carried-edit-note` with single, several (July 2026 to September 2026) and unknown wording; none on an own line.
- S3: the button reads "End line" (no "Delete" in the markup); `endLineConfirmText` for 0, 1, N and unknown has correct singular/plural, always includes the earlier-months and bill sentences, never "undefined/NaN/null"; per-line `laterSavedMonths` equals the rows after the viewed month and `removedMonths` equals that + 1 (166 ends in the fuzz). The confirm is exercised through the pure function and a source check, not by a real click.
- S4: describe renamed, assertions unchanged, passing.

## 5. The Coder's edits to my oracle

Legitimate: the `view()` change is exactly the owner's rule; the delete-refusal expectation was generalized to the stated product rule (I have since replaced it with my own feasibility derivation, which proves more); the `it.fails` D1 probe was flipped to a normal test with exactly my repro plus extra assertions. All coverage thresholds in the file were left intact; no assertion was weakened. Correction to my round-0 report: observation O1 ("an edit also changes the same line in later line-gap months, 200 times") was inflated because that counter also counted legitimate `applyToFuture` pushes; with those excluded and the new rule it is 0, and the file now asserts it is 0.

## 6. Full runs, files, docs

- `pnpm typecheck`: exit 0.
- `pnpm lint`: 52 warnings with an unused variable in my own oracle file; fixed, so 51 (the baseline), 0 errors.
- `npx vitest run` normal: `Test Files 505 passed (505)`, `Tests 13642 passed | 11 skipped (13653)`, exit 0.
- Same with `DATABASE_URL`/`DIRECT_URL=postgresql://x:y@127.0.0.1:1/z`: `Test Files 505 passed (505)`, `Tests 13642 passed | 11 skipped (13653)`, exit 0; 0 lines matching PrismaClientInit / Can't reach / ECONNREFUSED in either run. Both full runs predate one lint-only edit in my oracle file; afterwards I re-ran typecheck, eslint and my 3 tester files (32 tests pass).
- Temp files (`lib/zz-tester-mut`, `vitest.zz.config.ts`, `_tester_*.ts`) removed; the mutation runs left the real sources untouched.
- CLAUDE.md: still only lines 123 and 125 changed; the paragraph accurately describes the authoritative-month rule, the End line confirm counts, the generalized refusal, `addChangesEarlierMonth` and `loadFirstEditContext`; ASCII only; CRLF intact (CR=LF=131; every modified CRLF file still all-CRLF). Nit only: its first rule sentence ("A month with no row for an entity + tag uses the latest EARLIER row") is immediately qualified by the authoritative-month sentence.

## Tests added this round (tester-named)

- `lib/__tests__/budget-auto-carry-tester-oracle.test.ts` (17 tests): own feasibility oracle for delete, create/re-add simulation, crafted-world guard fuzz with advice follow-up, 3025-write mixed-sequence invariant, counts-told-vs-done fuzz, D1 probe as a normal test.
- `lib/__tests__/budget-auto-carry-tester-page.test.tsx` (14 tests): notice counts and clauses, End line, per-entity authoritative months, a middle month with one row hides lines it lacks, wording helpers.
- `lib/__tests__/budget-auto-carry-tester-dialog.test.tsx` (1 test): dashboard carried-line note.

## Not tested (unchanged)

Real browser and visual rendering (notice length and wrapping, End line confirm via a real click, dashboard dialog), the advisory lock and interactive transaction on the real pooler, real server actions against Postgres, `next build`.
