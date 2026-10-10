# Implementation: dashboard-accuracy-drilldown

Status: code complete, nothing staged, committed or pushed. No migration, no `prisma generate`, no DB writes, no tax code, no new server action.

## Owner decisions applied (all seven recommended defaults)
1. Spent counts the full mortgage cash payment and card charges; leaves out transfers between own accounts and card payments (both legs).
2. Refunds reduce Spent (shown as "Net of $936.17 refunds" and as Refund-tagged rows).
3. Income appears only inside the Spent drill-down ("Income this month", plus the income rows under "Not counted").
4. Overspent Lines = detailed lines, and parents with an amount of their own, whose spending is above budget (rollover included). A parent that only adds up its children is not counted again.
5. Account balances shown on the dashboard (balance or "owed" for cards, mortgage and loans, "as of" date in New York time).
6. Business expenses paid from a personal account stay counted where paid, with an "Of this, tagged Business Expenses" row.
7. One-day-early dates fixed on the Transactions page and the other places with the identical bug (list below).

## Summary of changes

### New pure modules (no DB, no clock)
- `lib/month-spend.ts` (server-only: Decimal value import). `classifyTx`, `buildMonthSpend`, `currentPeriodNY`, `periodBounds`, `isValidPeriod`. Classes: spending, refund, income, own_transfer, card_payment, loan_account. Spent = outflows of class spending minus refunds. Parts (top-level lines + "not in any budget line" per tag + untagged) minus a multi-tag correcting amount equal Spent; `reconciles` is computed from the parts. Nearest budgeted ancestor-or-self tag owns a transaction; a parent line = own + nested children. Overspent rule implemented here.
- `lib/month-spend-labels.ts` (client-safe) class names, chips and plain-language reasons; re-exported by `month-spend.ts`.
- `lib/budget-effective.ts` (server-only) one resolver for recurring override, stored amount, per-account auto-sum, roots-only total. The dashboard and `/budgets` both call it.
- `lib/dashboard-budget-tree.ts` (client-safe) account groups, `nestBudgetLines` with the `/budgets` comparator, parent ids, ancestors, `visibleRows` (collapse), `rowLabel`.
- `lib/dashboard-drill.ts` (client-safe) the `DrillData` payload types, `buildDrillView` for kinds spent, budgeted, overspent, line, account, transfer, transfers; `sumCountedRows` so the dialog re-adds the rows on screen. Integer cents only.
- `lib/dashboard-drill-build.ts` (server-only) builds the payload from the model (strings and integer cents; no Decimal reaches the client), `describeDayRules`.
- `lib/month-spend-build.ts` read-only loader: one `transaction.findMany`, explicit `select` (no description, notes, mask, tokens), `archivedAt: null`, month bounds, optional entity filter. No `db.budget` anywhere in the new files.

### Edited
- `app/page.tsx`: uses the New York month (`currentPeriodNY`), `?period=` validated with `isValidPeriod`. Every read goes through `settle()` (own failure -> that widget says "unavailable", logs `err.name` only). Replaced the two raw SQL queries and the aggregate by the shared model. Summary cards are `DrillButton`s; Total Budgeted now includes the recurring override; Overspent from the new rule. Accounts show balance + "as of"; account rows are drill buttons. Scheduled transfers are scoped to the active bucket (`fromAccount.entityId`), ordered, no silent cut (10 shown + "and N more" drill button). `db.budget.findMany` stays in this file (allow-listed), now with an explicit `select`. Pinned strings untouched (`await auth()` first, `{isCurrentPeriod && (` + `<Suspense key={bucket} fallback={<UpcomingWidgetSkeleton days={30} />}>`, the comment marker, `UpcomingWidgetSection`, its two `console.error`s).
- `components/dashboard/dashboard-client.tsx`: now a drill provider (context) that owns the dialog; top 6 cards and top 10 bars come from top-level lines only (parent and child never both).
- `components/dashboard/spend-category-cards.tsx`, `spending-chart.tsx`: ids are budget line ids; chart bars also have a real button list underneath (recharts bars are not keyboard reachable).
- New components: `drill-context.tsx`, `drill-button.tsx` (real `<button>`, aria-label, focus ring; plain content when data is unavailable), `drilldown-dialog.tsx` (role=dialog, aria-modal, Escape, backdrop, focus trap and return, bottom sheet on mobile, rows as wrapped list items not a wide table, excluded classes in `<details>`, footer "Rows add up to $X = the number you clicked" computed from the rows with a visible warning on mismatch, keeps the editable budget amount and `InlineTagCell` for line views), `budget-lines-table.tsx` (grouped by account, parent rows with rolled totals, `└` children, `aria-expanded` toggles, Expand/Collapse all, row opens line drill-down).
- `app/budgets/page.tsx`: uses `resolveEffectiveBudgets` and the same spend model instead of raw SQL; `Total Spent` = dashboard Spent for the same bucket and month; a note under it ("Includes $X not in any budget line (… untagged)"). Default period is the New York month. `db.budget.findMany` unchanged.
- `components/budgets/budget-page-client.tsx`: optional `spentNote` prop only.
- Date fix (UTC, calendar day): `components/transactions/transactions-table.tsx` (owner asked), plus the identical New-York-formatting bug in `app/transactions/[id]/page.tsx`, `components/business/excluded-from-pl-section.tsx`, `components/business/gl-page-client.tsx`, `components/review-queue/queue-client.tsx`, and `app/projects/[id]/page.tsx` (no tz given). Pages already using `timeZone: "UTC"` were left.
- Removed: `components/dashboard/category-drilldown-modal.tsx` and `actions/dashboard.ts` (`getTagTransactions` had one user, the modal).

Line endings preserved: CRLF files rewritten whole were converted back to CRLF; small edits used the Edit tool; `git ls-files --eol` confirms no file changed ending (LF files stay LF, CRLF stay CRLF). New files are LF.

## Deviations from the plan
- Drill payload also includes `tagIds` and class per transaction so line views keep the tag editor (as the old modal did).
- Credit-card classification: `Credit Cards / Interest paid` is a real cost and stays Spending; any tag whose last segment is "Credit card payment" (including the business-tagged variant) is a card payment, in addition to the whole `Credit Cards` subtree. Income = `Income`, `Misc. / Income`, anything with a `Revenue` path segment.
- `Open in Transactions` link for an account is `/transactions?bucket=&accountId=&tab=all` (all dates; I did not link a month filter because `app/transactions/page.tsx` has the `dateFrom`/`dateTo` overwrite bug and I did not touch it, see Open items).
- Monthly review (`lib/monthly-review-build.ts`) NOT switched: it computes several windows (current, midpoint, prior) by raw SQL keyed by entity, and is in the carry-forward allow-list; switching it is larger than "small" and not covered by this task's tests. Follow-up.
- Statements: the dashboard renders none (as the plan noted); nothing added.
- The Next-30-days widget was not edited. Read-only check: every item label is a `<Link href={item.href}>` (`components/upcoming/upcoming-parts.tsx`, `ItemLabel`) and the header links to `/forecast#upcoming`-style agenda; its Suspense wiring is unchanged (pinned tests pass).
- Not run: `pnpm build` / `next build` (writes `.next` shared with other sessions and the DB pool). Substitute: esbuild browser bundle of the three client entry points showed 0 Prisma/Decimal inputs and no `node:` imports.

## Live read-only results (temporary `_x.ts`, deleted; select-only; independent SQL by tag path)

Model Spent vs independent SQL (excluding paired transfers, mortgage/loan accounts, Transfer/Credit Cards/Income tag paths):

| Period | Bucket | Model Spent | Independent SQL | Rows | Pending | Total Budgeted (new = /budgets) | old dashboard | Overspent |
|---|---|---|---|---|---|---|---|---|
| 2026-09 | Personal | 17,162.22 | 17,162.22 | 220 | 0 | 17,192.14 | 17,164.14 | 12 |
| 2026-09 | Sudden Valley | 1,204.38 | 1,204.38 | 17 | 0 | 2,549.00 | 2,549.00 | 1 |
| 2026-09 | EK Consulting | 82.68 | 82.68 | 9 | 0 | 100.00 | 100.00 | 1 |
| 2026-09 | ALL | 18,449.28 | 18,449.28 | 246 | 0 | 19,841.14 | 19,813.14 | 15 |
| 2026-10 | Personal | 11,344.16 | 11,344.16 | 80 | 10 | 14,178.00 | 14,150.00 | 3 |
| 2026-10 | Sudden Valley | 252.42 | 252.42 | 3 | 0 | 1,399.00 | 1,399.00 | 0 |
| 2026-10 | EK Consulting | 63.63 | 63.63 | 4 | 0 | 0.00 | 0.00 | 0 |
| 2026-10 | ALL | 11,660.21 | 11,660.21 | 87 | 10 | 15,577.00 | 15,549.00 | 3 |

Requested numbers: September Spent 17,162.22 and October-to-date 11,344.16 come out of `buildMonthSpend` on live data, and a live check of the drill payload found, for every bucket and both months: Spent view, every line view, Total Budgeted view, Overspent view and every account view re-add to their headline with no mismatch (`drill-bad=[]`). `reconciles=true` everywhere; duplicate (multi-tag) correction 0.00 everywhere.

September Personal bridge: signed sum 4,562.94 = -17,162.22 Spent + income 17,349.23 + own transfers 310.00 + loan-account entries 4,233.86 + card payments -167.93. Excluded counts: own_transfer 37 (sum 310.00), card_payment 5 (-167.93), loan_account 3 (4,233.86), income 6 (17,349.23); refunds 936.17 (3); untagged 4 rows 88.12; business-tagged 1,034.57 (plan said 1,054.57/1,055: 20.00 lower live today); "not in any budget line" 5 tags. October Personal: untagged 8 rows 2,350.15, own_transfer 11 (-10.00), card_payment 2 (0.00), loan_account 3 (4,233.86), income 1 (1,817.30), 10 pending counted.

Mortgage: the `Utilities / Mortgage` line now shows 4,335.69 (Sept and Oct) instead of 0. Cause confirmed live: the cash payment is unpaired and the PennyMac mirror rows (+3,255.80, +1,079.89, -101.83) carried the same tag and cancelled it; those are now classed `loan_account` and left out. The owner's "$4,336 of $4,700" is therefore what the line shows after this fix; I could not reproduce it before the fix (it was 0), matching the plan's note.

`Credit Cards / Credit card payment` line (300 budget) now shows 0 (it used to show the +566.82 card-side inflow); the line dialog explains why. Recommendation unchanged: owner may retag or move that line.

Layout facts: Sept Personal has 71 lines (26 top-level) across Credit Cards(1), Heating & Electric(4), Mortgage & Insurance(5), Primary Checking(59), Slush Funds(2); payload 149 KB for Sept Personal, 177 KB ALL (fine). October Personal has 48 lines (47 top-level): the dashboard still reads the real Budget rows for the month (carry-forward is intentionally not used here, per the guard), so October shows fewer nested pairs than September.

## Commands run and results
- `pnpm typecheck`: clean (no output after `tsc --noEmit`).
- `pnpm lint`: 0 errors, 51 warnings (baseline was 52; none in files I added or changed except pre-existing ones in `budget-page-client.tsx` and `gl-page-client.tsx`).
- `pnpm test` (full): 468 files, 12,901 tests: 12,888 passed, 11 skipped, 2 failed.
- `DATABASE_URL`/`DIRECT_URL` pointed at an unreachable host (`127.0.0.1:1`), full `pnpm test`: identical (468 files, 12,888 passed, 2 failed, 11 skipped), so no test touches a real DB.
- The 2 failures are pre-existing at HEAD 49b1de8 and unrelated: `account-scheduled-flows-failsoft.test.ts` and `recurring-followups-tester-budget.test.ts` expect exactly one `console.error` but `lib/budget-carry-forward-build.ts` now also logs "Seasonal budget lines setting unreadable" because their `@/lib/db` mocks lack `appSetting`. Proven by running both in a clean `git worktree` of HEAD (same 2 failures), worktree removed. No file I changed is in either test's import graph. I did not edit them.
- Targeted: `recurring-followups-tester-pages`, `budget-carry-forward-guard`, `budget-carry-forward-tester-guard`, `recurring-detect-page-isolation`, `upcoming-ledger-tester-ui`, `budget-nesting` all pass (100 tests).
- New tests (all pass): `month-spend.test.ts` (38: Sept golden fixture incl. the 4,562.94 bridge, Oct-style month, classification, mortgage, card double count, multi-tag, rollup, overspent rule, periods incl. 03:30Z Oct 1 = still September, 300 seeded random worlds), `budget-effective.test.ts` (7, incl. the +28 recurring delta and 100 random inputs vs the old inline algorithm), `dashboard-budget-tree.test.ts` (6), `dashboard-drill.test.ts` (25, incl. 250 random worlds: every view re-adds to its headline and rows+exclusions cover every transaction), `dashboard-drilldown-render.test.tsx` (17: dialog a11y attributes and footer/warning text, DrillButton button vs plain, table nesting/toggles, cards, chart buttons, calendar-day dates), `dashboard-drill-guard.test.ts` (54: no `db.budget` in new files, pure libs, client-safe files, no carry-forward/advisor/tax imports, no new `"use server"`, no `any`/`parseFloat`, page contract, /budgets uses the shared model, UTC date sites), plus `month-spend-fixtures.ts` (synthetic, invented payees/ids; no real transaction list). No existing test was changed (none encoded the old numbers).
- No HTTP smoke test: the dashboard is behind login and I have no credentials or browser, so nothing renders unauthenticated. `next build` not run (see Deviations).

## Open items
1. Needs a human visual pass (list below): I have not seen any of this in a browser.
2. `lib/monthly-review-build.ts`, the advisor budget tools and `lib/advisor-context.ts` still use the old per-tag signed spend and the old no-recurring-override budgets; follow-up after the carry-forward work lands.
3. Pre-existing bug left alone: `app/transactions/page.tsx` `dateFrom` and `dateTo` both assign `postedAt` (second overwrites the first). Needed only if a month-filtered link is wanted.
4. The `Credit Cards / Credit card payment` budget line (300) will always show 0; consider retagging or moving it to the parent.
5. ALL view still combines Personal + Sudden Valley + EK Consulting money (existing behaviour). The Spent card says "all entities combined" and the dialog adds a per-entity split as information. If ground rule 6 should forbid a combined number there, say so.
6. Pending rows are counted and disclosed; if Plaid later replaces a pending row with a posted one both could appear briefly (not investigated, as in the plan).
7. Classification relies on tag names (`Transfer In/Out`, `Credit Cards` subtree, any "Credit card payment" tag, Income/Revenue paths) and account type; a card payment tagged differently would count as spending. Untagged inflows are treated as refunds (no guessing from the payee); every excluded and refund row is listed.
8. Untracked files seen in `git status` that are not mine and were not touched: `pnpm-workspace.yaml`, `scripts/setup-eva-account.ts`.
9. Not committed or staged. Files changed: see `git status`.

## Needs human visual verification
- Dashboard at 375 px and desktop: the three summary cards (now buttons with a hover/focus ring), their sub-lines, nothing overflowing.
- Click each of: Total Budgeted, Spent, Overspent Lines, a category card, a chart bar and a bar chip, a budget row, an account row, a scheduled transfer row (and "and N more" if > 10): dialog opens, scrolls, footer line is green/grey "Rows add up to ... = the number you clicked", Escape and backdrop close it, focus returns to the clicked element, Tab stays inside.
- Spent dialog (Sept 2026, Personal): shows $17,162.22, "Net of $936.17 refunds", the sections by account line then "Not in any budget line" then "Untagged", the four collapsible "Not counted" groups with counts and sums, Income as an info row.
- Budget Lines table: parents above indented children with `└`, parent totals include children, collapse/expand and Collapse all/Expand all work, account header shows top-level totals, a row click opens that line's dialog (budget edit, tag editor on rows still work and the page refreshes).
- Mortgage line shows $4,335.69; Food & Drink parent rolled total includes Groceries, Restaurants and Farmers Market.
- Accounts card: balances and "owed" wording for cards, mortgage and loans; "balance not set" for accounts without one.
- Month switcher (`?period=2026-09`) and each bucket tab keep `bucket` and `period` in the dialog links ("Open Budgets", Envelope, Transactions).
- Transactions page dates (and review queue, GL page, transaction detail) match the dates in the dashboard dialog (no longer one day early).
- `/budgets` Total Spent equals the dashboard Spent for the same month and shows the "Includes ... not in any budget line" note.
- Evening check near month end (after 8 PM New York on the last day) still shows the old month.
- Disable a read (simulate DB error) is not testable by me: confirm the page would show "Unavailable"/"unavailable right now" in just the affected widget.

## Review round 1 fixes (reviewer verdict APPROVED, four should-fix items)

HEAD is now 2248489 (it includes "Fix two tests broken by the seasonal-setting error log", so the 2 failures I reported earlier no longer occur). Nothing staged or committed; no migration.

- **S1 (advisor and other readers, text only, no logic change):** `lib/advisor/tools/get-budget-status.ts` (the `notes` string and the tool `description`) now say Spent is the net signed amount on the exact tag, is NOT the dashboard's Spent (which leaves out card payments, loan-account entries and income, rolls nested sub-tags into the nearest budget line and nets refunds), that the two can differ (the Mortgage line reads differently), and that it can still differ from the Budgets page for recurring-linked lines. `lib/advisor-context.ts` line 184: "Total spent" is now "Net outflow on budget tags (not the dashboard's Spent figure; can differ)"; "Total budgeted:" is unchanged (pinned by `budget-carry-forward-tester-consumers.test.ts`). `lib/advisor/queries/spend.ts`: the false "as on the Budgets page" header and the "same rules as the Budgets page" doc comment replaced by a note naming `lib/month-spend.ts` and the follow-up. No test pinned the old strings; new `lib/__tests__/dashboard-advisor-spend-notes.test.ts` (3 tests) pins the new wording. Named follow-up (not done): move the advisor, the monthly review (`lib/monthly-review-build.ts`) and the budget CSV export (`actions/reports.ts`) onto `buildMonthSpend`.
- **S2 (CLAUDE.md):** one Architecture paragraph "Dashboard Spent and drill-down" inserted before "Testing pattern". Edited as a latin-1 buffer round trip with an ASCII-only insert and CRLF line breaks: bytes before and after the insert are byte-identical to the previous file (verified), no lone LF in the insert, `git ls-files --eol` still `w/crlf`. It covers the six classes, Spent = outflows - refunds, pending, ownership by nearest budgeted ancestor and reconciliation, Overspent rule, `resolveEffectiveBudgets` shared with `/budgets`, the libs and components, the one-payload client-side drill-down, the Budget-table allow-list (`budget-carry-forward-guard`; the dashboard reads real rows, never the carry-forward loader), the New York month rule and UTC calendar-day display (`formatCalendarDate`), the All Entities decision ("all entities combined" plus a per-entity split), fail-soft `settle()`, and the readers still on the old per-tag spend.
- **S3 (chart header at 375 px):** `components/dashboard/spending-chart.tsx` header row is `flex flex-wrap items-center justify-between gap-2` with the title alone; the "(click a bar or a name below to drill in)" hint is its own `<p className="text-xs text-muted-foreground">` below it. New render test pins the wrapping classes, that the hint is outside the title element, and its own paragraph.
- **S4 (All Entities label):** new `budgetedSubline(isAllEntities)` in `lib/dashboard-drill.ts`; `app/page.tsx` uses it, so the Total Budgeted card reads "Top-level lines · click for the lines · all entities combined" in the All Entities view and is unchanged elsewhere. Tests: helper unit test (both cases) and a page source pin.

CRLF/LF preserved: `app/page.tsx`, `spending-chart.tsx`, `lib/advisor-context.ts` stay CRLF; `get-budget-status.ts`, `queries/spend.ts` stay LF; `lib/dashboard-drill.ts` is an untracked new LF file.

### Commands and exact results
- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors, 51 warnings (same as before, none in files touched this round).
- `pnpm test` (full): 471 files passed (471); 12,924 tests passed, 11 skipped, 0 failed (12,935 total).
- `DATABASE_URL=postgresql://x:y@127.0.0.1:1/z pnpm test` (full): identical, 471 files, 12,924 passed, 11 skipped, 0 failed.
- New/changed tests this round: +1 in `dashboard-drill.test.ts`, +1 in `dashboard-drilldown-render.test.tsx`, +1 in `dashboard-drill-guard.test.ts`, +3 in new `dashboard-advisor-spend-notes.test.ts`; the existing render, page-pin, carry-forward and advisor tests stayed green unchanged.
