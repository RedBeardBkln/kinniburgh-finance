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

## Browser-check fixes (production check of commit 512ea9a)

No staging, commit or push; no migration; line endings preserved (`app/page.tsx`, `app/budgets/page.tsx`, `dashboard-client.tsx`, `CLAUDE.md` stay CRLF; lib files LF). CLAUDE.md: the `own_transfer` clause of the Dashboard paragraph extended (latin-1 round trip, ASCII insert, only that region changed, no lone LF).

### BUG: pending/unpaired own-account transfers counted as spending
- **How own transfers were detected before** (read-only live script): only (a) `transferPairId` set, or (b) a Transfer In / Transfer Out tag. A pending leg has no pair until the other leg posts, and the outgoing legs were untagged (their incoming twins were tagged Transfer In by a rule, which is why `to SV` was "Own transfer" and the two `to CK` rows were not). The TD matcher (`lib/transfer-match-runner.ts`) only pairs POSTED rows (`pending: false`) of TD Bank accounts, so a pending leg stays unpaired for a day or more.
- **New rule** (`lib/month-spend.ts` `classifyTx`, option `ownAccountByMask`): after the pair, loan-account and Transfer-tag checks, a row is an own transfer when its payee is exactly the bank wording `Online Xfer Transfer (to|from) XX xNNNN` (reuses `parseTransferLeg`) AND NNNN is the mask of exactly one ACTIVE account of the household AND that account is not the row's own. Never payee text alone. Reason shown: "Transfer to your own account, not counted" / "Transfer from your own account, not counted". Pending and posted are treated the same; a paired row stays "Paired transfer between your own accounts" (one class per row, so no double exclusion when the pair forms later).
- **Mask map**: new `lib/own-account-masks-build.ts` (`loadOwnAccountByMask`, read-only, `archivedAt: null`, selects only `id` and `mask`); a mask shared by two active accounts is dropped as ambiguous; an unknown, archived-account or foreign mask is simply absent, so the row stays spending. Dashboard and `/budgets` pass the same map (Total Spent still agrees). If the mask read fails the money cards read "Unavailable" (fail closed, never an inflated total). Masks never leave the server: the drill payload replaces a known counterpart by the account name ("Transfer to Mortgage loan") and hides digits otherwise ("... x****"); a test pins no `xNNNN` in any payee label.
- **Live results** (independent SQL, written separately with the same mask rule, Sept and Oct, all four buckets): every cell matches to the cent and `reconciles=true`.
  | Period | Bucket | Before | After | Independent SQL |
  |---|---|---|---|---|
  | 2026-09 | Personal | 17,162.22 | 17,162.22 | 17,162.22 |
  | 2026-09 | Sudden Valley | 1,204.38 | 1,204.38 | 1,204.38 |
  | 2026-09 | EK Consulting | 82.68 | 82.68 | 82.68 |
  | 2026-09 | ALL | 18,449.28 | 18,449.28 | 18,449.28 |
  | 2026-10 | Personal | 12,631.34 | **12,081.34** | 12,081.34 |
  | 2026-10 | Sudden Valley | 252.42 | 252.42 | 252.42 |
  | 2026-10 | EK Consulting | 63.63 | 63.63 | 63.63 |
  | 2026-10 | ALL | 12,947.39 | 12,397.39 | 12,397.39 |
  October Personal falls by exactly 550.00 (the 400.00 and 150.00 pending transfers).
- **Every row the new rule changes, all months, all entities** (checked by comparing the model with and without the map over every month that has an "Online Xfer Transfer" row; 6 rows, all on Primary Checking, all outgoing, all unpaired and untagged): 2026-10-09 pending -400.00 and -150.00; 2026-04-20 posted -190.00, -105.00, -117.00; 2026-04-16 posted -2,350.00. The four April rows are historical (April is not Sept/Oct; they were being counted as spending there). Rows of the same kind that were already tagged or paired are unchanged. Not touched (not bank-labelled with a mask, no guessing): `CORFCU CK WEBXFR TRANSFER` (-330 monthly on The Cottage, tagged Home & Property / Home Improvements) and `COREPLUS FCU ACH XFER` (+690 Aug 4); `to SV x8815` rows stay classed by their Transfer Out tag (that mask is not an account of this household).

### Cosmetics
1. Scheduled transfers: new `cadenceText()` (`lib/dashboard-drill.ts`): "Semi-monthly", "Weekly", "Monthly", "Every two weeks"; used for the badge on the page and the detail rows.
2. Exclusion signs: each excluded group now says "Money in +$X, money out -$Y, net +/-$Z (+ in, - out, as the bank records it)". Credit card payments: in +$566.82, out -$734.75, net -$167.93 (Sept Personal).
3. All Entities: every account group (Spent dialog headings, Total Budgeted dialog, Budget Lines table headers, account dialog subtitle) is labelled "<account> · <entity>"; single-entity views stay unlabelled.
4. Line subtitle: decided to name the account the LINE is budgeted on and, when spending sits elsewhere, those accounts: "Budgeted on the Primary Checking account · spending also on Barclay". Per-row account names are unchanged.
5. Row account: verified by test that every row shows the nickname of the account its own transaction is on (spent, account and line views). Transfer-label rows also carry their reason as the third part of the row line.
6. Layout: the title and month navigation are passed to `DashboardClient` as `header` and render first, above the category cards and the chart (the summary cards and the Upcoming Suspense block are unchanged, in the same place after the chart).
7. The Spent dialog title is "Spent This Month" for the current month and "Spent in <Month Year>" for a past month, matching the card (new `isCurrentPeriod` in the payload).
Not changed: the inline tag-chip remove controls.

### Tests changed and why
- `dashboard-drill.test.ts`: two expectations encoded the old cadence text ("semi monthly") and the old account payload keys; updated to "Semi-monthly" and the added `entity` key.
- `dashboard-accuracy-tester-page.test.tsx`: its mocked account and budget rows now carry `entity: { name }` (the page reads it for the new labels); the "accounts read fails" case uses a one-time rejection because the mask loader shares that mock; new case "own account masks read fails" expects Unavailable, not a wrong total.

### New tests (all pass)
`month-spend.test.ts` +10 (pending, posted both directions, mask rule opt-in, unknown mask, archived/foreign mask, own-account mask, near-miss wordings, pair formed later, tag + mask, 200 random worlds with transfers: parts equal Spent, bridge, each row counted once); `own-account-masks.test.ts` +3 (active only, id and mask only, ambiguous masks dropped); `dashboard-drill.test.ts` +12 (reasons on rows, mask never shown, title, in/out split, cadence, entity labels, line subtitle, row accounts); `dashboard-drilldown-render.test.tsx` +4 (header above cards and chart, in/out text, entity-labelled table, current-month title); `dashboard-drill-guard.test.ts` +6 (loader shape, shared map on both pages, mask only through the validated map, redaction, header prop, cadence badge); plus one added page case.

### Commands and exact results
- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors, 51 warnings (unchanged).
- `pnpm test` (full): 472 files passed (472); 12,960 passed, 11 skipped, 0 failed (12,971 total).
- `DATABASE_URL=postgresql://x:y@127.0.0.1:1/z pnpm test` (full): identical, 472 files, 12,960 passed, 11 skipped, 0 failed.

## Final pass (tester re-test PASS, reviewer APPROVED browser-check fixes)

No staging, commit or push; no migration; CRLF/LF preserved (`CLAUDE.md` and `app/page.tsx` still CRLF with no lone LF; lib files LF; CLAUDE.md edited as a latin-1 buffer, ASCII insert, only the two clauses changed).

### 1. Whitespace-tolerant wording, and a sweep of every transfer wording (read-only)
All rows whose payee contains "xfer", all months (538 rows), grouped by shape (digits -> NNNN):

| Rows | Sum | Paired | Pending | Months | Wording |
|---|---|---|---|---|---|
| 166 | -78,959.00 | 0 | 0 | 2025-05..2026-04 | `Online  Xfer Transfer to CK xNNNN` (double space) |
| 132 | -64,636.00 | 126 | 2 | 2026-04..2026-10 | `Online Xfer Transfer to CK xNNNN` |
| 127 | +58,928.00 | 122 | 2 | 2026-04..2026-10 | `Online Xfer Transfer from CK xNNNN` |
| 58 | -2,740.00 | 0 | 0 | 2025-05..2026-04 | `Online  Xfer Transfer to SV xNNNN` (double space) |
| 26 | -260.00 | 0 | 1 | 2026-04..2026-10 | `Online Xfer Transfer to SV xNNNN` |
| 21 | -1,853.95 | 0 | 0 | 2025-05..2026-03 | `PAYPAL INST XFER` (no mask) |
| 4 | +3,226.00 | 4 | 0 | 2026-04..2026-07 | `Online Xfer Transfer from SV xNNNN` |
| 4 | +10,690.00 | 0 | 0 | 2026-07..2026-08 | `COREPLUS FCU ACH XFER` (no mask) |

So the only variant in live data is the double space after "Online" (all TD Bank accounts). New `lib/own-transfer-label.ts` (pure, client-safe): `parseOwnTransferLabel` collapses whitespace runs (spaces, tabs, nbsp) and trims, then uses the unchanged strict anchored parse (case-sensitive, nothing before or after, two-letter code, four digits); `hideTransferMask` hides `xNNNN` (any case) in any text that mentions transfer/xfer, whatever its shape. `lib/month-spend.ts` classifies through the tolerant parse (still requires the validated active TD mask, another account, and the opt-in map); `displayPayee` names a known counterpart ("Transfer to Mortgage loan") and otherwise hides the digits in every near-miss form. `lib/transfer-match.ts` and the TD matcher are untouched (they do not start pairing the historical rows). Wordings without a mask (`PAYPAL INST XFER`, `COREPLUS FCU ACH XFER`) are not classified. The tester's `it.fails` pin is now a plain `it` (the only edit asked for); to keep two of the tester's tests consistent with the new behaviour I also changed, in the same file, the oracle's wording parse (collapse whitespace first) and moved the double-space example from the "stays spending" list to the "recognised" assertions.

Independent SQL recomputation (own SQL: whitespace collapsed with `[[:space:]]+`, anchored wording, TD Bank accounts whose mask is unique and not the row's own, plus the pair/tag/loan/card/income rules) for Personal, May 2025 to Oct 2026 (months with data): every month matches the app to the cent and `reconciles=true`; Sudden Valley and EK Consulting are unchanged and match; All Entities matches. Personal Spent change versus the previous rule (single-space only), by month: 2025-05 -5,610.00 (12,507.90 -> 6,897.90); 2025-06 -7,960.00 (19,200.96 -> 11,240.96); 2025-07 -7,015.00 (17,346.95 -> 10,331.95); 2025-08 -5,950.00 (20,083.31 -> 14,133.31); 2025-09 -6,015.00 (26,262.22 -> 20,247.22); 2025-10 -6,470.00 (17,656.24 -> 11,186.24); 2025-11 -7,320.00 (19,106.53 -> 11,786.53); 2025-12 -7,625.00 (18,876.34 -> 11,251.34); 2026-01 -7,520.00 (16,806.66 -> 9,286.66); 2026-02 -7,961.00 (18,355.76 -> 10,394.76); 2026-03 -8,159.00 (15,577.85 -> 7,418.85); 2026-04 -3,604.00 (16,425.53 -> 12,821.53). Total -81,209.00 over the 12 months (the 175 rows you named). 2026-09 Personal 17,162.22 and 2026-10 Personal 12,081.34 are unchanged from the earlier fix (the -550 was already in; no further change). The 2026-03 dialog payload now has 0 transfer-shaped payees with digits (32 own transfers listed under "Not counted"); the remaining `xNNNN` in other March payees are store terminal numbers in card-purchase text, not account masks.

### 2. CLAUDE.md contradiction (S1)
The sentence "Classes come from the tag tree and account type, never from payee text" is replaced: classification is tag-tree and account-type based with ONE narrow exception, the TD Bank transfer label (whitespace runs collapsed, case and anchoring exact, `lib/own-transfer-label.ts`), which makes a row an `own_transfer` only when its mask is validated against the household's active TD accounts; no other payee text is read. The `own_transfer` clause now says "active TD Bank account".

### 3. Mask map scoped to TD Bank (S2)
`lib/own-account-masks-build.ts`: `where: { archivedAt: null, institution: { name: TD_BANK_INSTITUTION_NAME } }` (select still only `id` and `mask`); the constant is "TD Bank", the same institution `lib/transfer-match-runner.ts` filters on (a test reads the runner source and checks the same name). Live: 7 unique TD masks (was 10 across all institutions). A TD transfer to a non-household account whose last four digits equal the mask of a non-TD household account (credit union, QuickBooks) is no longer excluded; tested with a db fake that honours the institution filter (the foreign 5555 and 6666 transfers stay spending, the real TD one is excluded).

### 4. Cross-entity pin (N1)
`month-spend.test.ts` and `dashboard-drill.test.ts` pin that a Personal row "to" an account of another entity is `own_transfer`, stays out of Spent and is listed under "Transfers between your own accounts" with "Transfer to your own account, not counted" and its signed sum.

### N2 skipped
CK/SV code vs account type: skipped, it would risk false negatives (the two-letter code is not a reliable account-type signal in the live data: `to SV` rows go to Sudden Valley's bank, `to CK` to several checking accounts; only the mask is validated, as in the TD matcher).

### Tests and commands (exact)
- New/changed tests: `month-spend.test.ts` +12 (whitespace variants that are transfers: 5; near-misses that stay spending: 6; cross-entity: 1), `dashboard-drill.test.ts` +5, `own-account-masks.test.ts` +2 (and its `where` expectation), `dashboard-drill-guard.test.ts` (2 expectations follow the new helper), `dashboard-accuracy-tester-masks.test.ts` (flip + the two consistency edits above).
- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors, 51 warnings (unchanged).
- `pnpm test` (full): 474 files passed (474); 13,001 passed, 11 skipped, 0 failed (13,012 total).
- `DATABASE_URL=postgresql://x:y@127.0.0.1:1/z pnpm test` (full): identical, 474 files, 13,001 passed, 11 skipped, 0 failed.
