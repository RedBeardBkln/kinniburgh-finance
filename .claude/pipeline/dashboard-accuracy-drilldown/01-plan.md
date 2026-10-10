# Plan: dashboard-accuracy-drilldown

## Restated goal
Make every dashboard number mean what its label says (starting with "Spent"), make every card, bar and row clickable down to the exact transactions behind it (rows sum to the number clicked, exclusions shown), and make the Budget Lines table a parent/child tree like `/budgets` and the Tags page.

## Evidence (Part A, read-only live audit, Personal bucket; temp script already deleted, no writes; payees/amounts only)

### The $4,562.94 explained exactly (September 2026)
`totalSpend` is a SIGNED `SUM(amount)` over every non-archived, unpaired transaction in the month, then `.abs()` and labelled "Spent". The signed sum is **+4,562.94, i.e. a net INFLOW** (188 unpaired rows): inflows 23,537.91 minus outflows 18,974.97. It is income minus spending with the sign dropped. By class:

| Class (all rows with `transferPairId` NULL) | Sum |
|---|---|
| Real spending outflows (cash, card charges, mortgage cash leg) | -18,098.39 |
| Refunds / credits on spending (Chewy 440.78, LNER 269.07, Etsy 226.32) | +936.17 |
| Income-tagged inflows (4 paychecks, interest) + Venmo EKC revenue 914.74 | +17,349.23 |
| PennyMac loan-account rows (Payment 3,255.80 + Principal Reduction 1,079.89 = 4,335.69 mirror of the cash payment, minus Mortgage Insurance Disbursement 101.83) | +4,233.86 |
| Rows tagged Transfer In (+350 P2P) / Transfer Out (4 x -10 to SV) | +310.00 |
| Card payments, both legs unpaired (Barclays 520.56 / 46.26 cancel against the card-side inflows; Capital One CRCARDPMT 167.93 has no Personal-side inflow because that card is in EK Consulting) | -167.93 |
| **Total** | **+4,562.94** |

Mortgage: the cash payment (-4,335.69 from Mortgage & Insurance) is NOT a paired transfer (the owner's guess was wrong). It is unpaired, but the PennyMac account mirror rows (+3,255.80 +1,079.89, all tagged `Utilities / Mortgage`) cancel it to exactly 0 in the headline AND in the per-tag sum. So the budget line `Utilities / Mortgage` shows **$0 of $4,700** in Sept and Oct today. The owner's "Mortgage $4,336 of $4,700" was NOT reproducible live (unexplained; maybe seen before the PennyMac rows were synced). The Coder must re-check and report, not assume.

### Audit table
| Metric | Current formula | Correct definition | Today vs recomputed | Root cause |
|---|---|---|---|---|
| Spent (card) | `abs(SUM(all unpaired tx))` | Cash/credit outflows on spending, net of refunds; excludes own transfers, card payments, liability-account (mortgage/loan) rows, income | Sept 4,562.94 vs **17,162.22** (18,098.39 - 936.17); Oct (to 10/8, 10 pending rows) 5,303.00 vs **11,344.16** | net signed sum incl. income and mirror legs |
| Total Budgeted | root-only sum of resolved amounts, no recurring override | same as `/budgets` (recurring-linked override applies) | Sept 17,164.14 vs `/budgets` 17,192.14; Oct 14,150.00 vs 14,178.00 (+28 = Eversource recurring line) | dashboard skips the recurring override |
| `/budgets` "Total Spent" (for agreement) | sum of each line's direct-tag signed sum | same helper as the dashboard | Sept 9,332.74 (includes +566.82 card-side inflow) vs 17,162.22 | per-tag sums only, unbudgeted tags and untagged missing, signs mixed |
| Line "Spent" | `SUM(amount)` of txs tagged exactly that tag, any account | spend of that tag AND its un-budgeted descendants (nearest budgeted ancestor owns a tx), parents add children | e.g. Sept `Food & Drink` shows 0 of 2,050 although children spent 1,395.36; Groceries misses Farmers Market (-102) | no rollup |
| Overspent Lines | count of flat lines where direct spend > budget | see Fix 5 | Sept 11, Oct 2 (flat) | parents can never be over because they have no spend |
| Not in any line | not shown | explicit rows | Sept: unbudgeted tags excluding income/transfers: Taxes/Excise 636.86, Travel 929.65, Bank Fees 49.00, business-tagged 1,054.57, Farmers Market 102, others; untagged 4 rows -88.12 (Oct: 8 untagged rows, -2,350.15, mostly oil/HVAC repairs) | never reconciled to the headline |
| Chart / category cards | top 10 / top 6 flat lines by abs(direct signed sum) | top root categories by rolled spend | the Credit Cards line shows 566.82 "spent" (the card-side inflow) | same sums |
| Accounts widget | nickname, last-4 mask, institution; NO balance | (see Q5) | n/a | owner expects balances; none are displayed |
| Scheduled Transfers | `findMany` active, `take: 10`, no order, no entity filter | filter by the active bucket via `fromAccount.entityId`; order by fromAccount nickname | shows household-wide transfers in every bucket | missing scope (ground rule 6) |
| Statements | not rendered on the dashboard | n/a | the brief listed them; none exist | note only |
| Period | `now` UTC month; UTC month bounds | bounds correct (dates are date-only at UTC midnight; one Plaid row at 08:29Z); "current month" should use America/New_York | within 4-5 h of month end (evening NY) the dashboard flips to next month early | UTC `now` |
| Date display | modal and `/transactions` format `postedAt` in America/New_York | UTC-midnight date-only values must be formatted in UTC (`formatCalendarDate`, lib/card-due.ts, precedent commit 7761918) | every drilled date shows one day early | same bug already fixed for card due dates |

Facts checked live: 0 multi-tag transactions in Sept/Oct (so no duplicate counting today; keep a guard row anyway); no paired transfers are counted; ALL view Sept headline 7,323.51 blends three entities (existing behaviour, see Risks). Credit cards: charges are counted when charged; the checking-side payment (`Credit Cards / Credit Card - Eric`, `Credit Cards`) and the card-side "Payment Received" inflow (`Credit Cards / Credit card payment`) are the same money and must both be excluded from Spent.

## Scope
IN: Part A fixes, Part B drill-down on every dashboard widget, Part C tree table, tiny related fixes listed below.
OUT: no migration, no DB writes, no tax code, no new tags/budget data changes (e.g. the mis-tagged Credit Cards budget line stays; see Risks), no change to `lib/bill-dates*` / `lib/budget-carry-forward*` / `lib/advisor/**` / `lib/advisor-context.ts` / `lib/notifications.ts` / `lib/upcoming-ledger*` (another Coder has them modified in the working tree), no change to the Upcoming widget or its Suspense wiring.

## Hard constraints discovered in tests (must not break)
- `lib/__tests__/budget-carry-forward-guard.test.ts`: only allow-listed files may call `db.budget.*`. `app/page.tsx` and `app/budgets/page.tsx` are allowed; **any new file or server action must not touch `db.budget`**. Therefore the budget rows stay read in `app/page.tsx`, and the drill-down needs no new server action (Design B).
- `lib/__tests__/recurring-followups-tester-pages.test.ts` pins literal strings of `app/page.tsx`: `await auth()` first, `{isCurrentPeriod && (` immediately before the `<Suspense key={bucket} fallback={<UpcomingWidgetSkeleton days={30} />}>`, the comment marker `{/* Next 30 days (current month only) */}`, `UpcomingWidgetSection` and its error-logging lines. Edit around them; run that test after every change.
- Do not import carry-forward modules in the dashboard (the guard says "a follow-up may carry forward there"; leave a single seam: the budget rows array is produced in one place in the page).

## Definitions (decisions; owner questions are in the last section)
1. Spent = for each unpaired tx, class in {spending, refund}. Outflow = spending, inflow on a non-income, non-transfer, non-card-payment row = refund (reduces spend). Presented as a positive dollar figure with the label "Spent" and a visible "net of $936.17 refunds" note.
2. Excluded classes, always shown as explicit rows in the drill-down with count and sum: `own_transfer` (paired OR tagged `Transfer In` / `Transfer Out`), `card_payment` (any tag in the `Credit Cards` subtree, either leg), `liability_account` (account type mortgage/loan: the cash leg on the funding account is the spend), `income` (tag under `Income`, `Misc. / Income`, or ending `/ Revenue`). Income is shown as its own "Income this month" figure in the drill-down only (no new card).
3. Credit card spending counts when charged (card account outflows). Pending rows are included, with the count disclosed ("10 pending").
4. Mortgage counts as spending at the cash payment (principal + interest + escrow): it is a real monthly cost and the budget line is $4,700.
5. Business-tagged outflows paid from Personal accounts are counted (they left the household); a breakdown row "of which tagged Business Expenses: $X" is shown (no reclassification).
6. A transaction belongs to the NEAREST budgeted ancestor-or-self tag line (tag tree, any account); a parent line's spent = own + children's rolled spend along the nested (same-account) tree; transactions with no budgeted ancestor go to "Not in any budget line" (per tag, listed) and untagged go to "Untagged". Headline = sum of root lines + not-in-any-line + untagged (exactly), plus a "counted under more than one tag" correcting row only when nonzero.

## Approach (ordered; each step independently verifiable)

### Step 1. Shared pure helper `lib/month-spend.ts` (no DB, no `@prisma/client` runtime value except Decimal as lib/budget does)
- Types: `SpendTx {id, postedAt (ISO day), amount (Decimal), payee, accountId, accountNickname, accountType, pending, transferPairId, tagIds[]}`, `SpendTag {id,name,parentId}`, `BudgetLineInput {id, tagId, accountId, budgeted: Decimal|null, rolloverAmount}`.
- `classifyTx(tx, tagById): {class, reason}` per Definition 2. Tag-subtree tests use the tag tree (ancestor name equals `Credit Cards`/`Income`), never string prefixes on payees.
- `buildMonthSpend(txs, tags, lines, opts) -> MonthSpendModel` with: `spent`, `refunds`, `income`, `excluded[]`, `pendingCount`, per-line `{ownSpend, rolledSpend, txIds}`, `notInAnyLine[]` (by tag), `untagged`, `duplicateAdjustment`, `reconciles` (boolean computed by code; the model is built so that sum of parts equals `spent` exactly, tested).
- `currentPeriodNY(now)` and `periodBounds(period)` (UTC bounds, same as today).
- One Decimal arithmetic path; amounts serialized to strings of dollars.

### Step 2. Shared effective-budget resolver `lib/budget-effective.ts` (pure)
Extract from `app/budgets/page.tsx` (recurring-linked override then `resolveBudgetedAmounts` per account, `getRootBudgetLineIds`) so the dashboard and `/budgets` call the same function. `/budgets` page keeps its `db.budget` read (allow-listed). No change to advisor files (they currently resolve like the old dashboard; list as follow-up after carry-forward merges).

### Step 3. DB loader `lib/month-spend-build.ts`
One read-only `db.transaction.findMany` with explicit `select` (no amounts of other months, no `description`, `mask`, tokens): `entityId` filter or all, `archivedAt: null`, month bounds, include `account.nickname/accountType`, `tags.tagId`. No `db.budget` here. Replaces the two raw SQL queries and the aggregate in `app/page.tsx` (and, in step 6, `/budgets`). `transferPairId` is selected (paired rows are classified, not silently filtered).

### Step 4. `app/page.tsx` data wiring (keep the pinned strings)
- Use `currentPeriodNY`; keep `?period=` validation.
- Wrap the month-spend build in its own try/catch so a failure renders the summary cards in an "unavailable" state, never blanks the page (fail-soft); the Upcoming Suspense block is untouched.
- Summary cards: Total Budgeted from Step 2; Spent from the model; Overspent from Fix 5 below; each card passes a drill kind.
- Scheduled transfers: add `where: bucket entity ? { fromAccount: { entityId } } : {}`, `orderBy`, no `take` cut that hides rows without saying so (show "and N more").
- Accounts widget: keep nickname/institution; add posted balance and "as of" only if Q5 is answered yes (default yes); no new account-number display (keep the existing last-4 mask as is).

### Step 5. Overspent definition (default, see Q4)
Count only lines that are LEAVES (no budgeted children in the same account) or that have an explicit (non-null raw) amount, where `rolled spent > effectiveBudget` (rollover included, as `computeBudgetSummary` does). Auto-sum parents are not counted (they only restate their children). The drill-down lists exactly those lines.

### Step 6. Make `/budgets` agree (small)
`app/budgets/page.tsx`: replace its raw-SQL `tagSpend` with the same model's `rolledSpend`, and its `totalActual` with `model.spent` plus the "not in any line / untagged" note so its "Total Spent" equals the dashboard's. Rendering code in `components/budgets/*` unchanged (it already nests). Monthly review (`lib/monthly-review-build.ts`) has its own SQL for current and prior windows: switch only the current-month per-tag spend to the model if its tests allow; otherwise leave and record as follow-up (it also reads budgets and is in the carry-forward allow-list).

### Step 7. Drill-down (Design B: client-side, no new server action)
Rationale: guard test forbids new `db.budget` readers; all rows for one month are small (Sept Personal 220 rows, ALL about 400). The server page passes the already-built model (rows as plain strings: id, `YYYY-MM-DD`, payee, account nickname, tag paths, signed dollars, class, line id) to the client. Everything reconciles by construction and there is no extra auth surface. Payload is only data the page already may show; no account numbers, no emails.
- `components/dashboard/dashboard-client.tsx`: replace `selectedTagId` with a `DrillTarget` state exposed through a small React context (`useDrill()`), so server-rendered children (summary cards, budget table, accounts, transfers) can include tiny client `DrillButton`s.
- `components/dashboard/drill-button.tsx` (new, client): renders a real `<button>` (keyboard focusable, visible focus ring) wrapping card/row content.
- `components/dashboard/category-drilldown-modal.tsx`: generalize into `DrilldownDialog` with kinds `spent`, `budgeted`, `overspent`, `line`, `account`, `transfers`. Layout: header (title, headline amount), body = sections each with rows (date, payee, account nickname, tag path, amount) and a subtotal, an "Excluded and why" section (class label, count, sum), and a footer "Rows add up to $X = the number you clicked" computed from the rows on the client (shows a warning, never hides, if it fails). `role="dialog"`, `aria-modal`, Escape and backdrop close, focus returns to the trigger, `max-h` scroll, bottom sheet on mobile (already). Keep the existing editable budget amount and `InlineTagCell` for kind `line` only. Dates through `formatCalendarDate` (UTC).
  - `spent`: sections = each root line (with nested children indented), Not in any budget line (per tag), Untagged; excluded = transfers, card payments, loan/mortgage account rows, income, plus pending note.
  - `budgeted`: per account, root lines with resolved amounts, children shown, recurring-override lines flagged.
  - `overspent`: the counted lines with budget, spent, over by, link to line.
  - `line`: the line's own transactions, then each child line's transactions grouped under the child (parent shows children).
  - `account`: that account's recent transactions for the month (the model rows with that account id, all classes, with class chip) and a link `Open in Transactions` (`/transactions?bucket=&accountId=&tab=all`). `tab=all` is required: the default tab is untagged-only.
  - `transfers` (Scheduled Transfers row): link to `/envelope?bucket=` (confirm the page lists them; if not, show cadence/dayRules/purpose in the dialog from data already on the page).
- Next-30-days widget: keep as is (already links every item and the header to `/forecast#upcoming`); the Coder only verifies each row has an `href` and does not edit the component.
- Preserve bucket and period: links built from one helper; period selector links unchanged.

### Step 8. Part C: tree table `components/dashboard/budget-lines-table.tsx`
- Pure view-model `lib/dashboard-budget-tree.ts`: groups lines by account (account nickname asc, same as `/budgets` `byAccount`), `nestBudgetLines(lines, tagParent, compareAlphaByTagName)` for order and depth, per row: label (depth 0 with a tag parent shows full tag path e.g. `Food & Drink / Groceries`, nested rows show the short name with the `└` connector exactly as `/budgets`), budget, rolled spent, remaining, progress, `hasChildren`.
- Parent row shows rolled totals (auto-sum parents: budget = sum of children, spent = own + children). Account header row shows root-only budgeted sum (same rule as `/budgets` `accountTotal`). Page totals use roots only (already the rule).
- Expand/collapse per parent (client state, default expanded; toggle is a `<button aria-expanded>`), row body click opens `line` drill-down.
- Category cards and chart: use top 6 / top 10 ROOT lines by rolled spend (so a parent and its child never both appear); chart bar click opens the same `line` dialog. Cards on a line with zero budget show spend only.

### Step 9. Small related fixes
- `components/transactions/transactions-table.tsx` `formatDate`: UTC formatting for date-only values (same fix as commit 7761918) so drill-down and Transactions page dates match. One line; recommended, flagged as owner-visible.
- `app/transactions/page.tsx`: `dateFrom` and `dateTo` each assign `postedAt`, the second overwrites the first (bug). Merge into one `postedAt: {gte, lte}`. Needed only if Open-in-Transactions links carry both dates; the account link above does not. Include only if used; otherwise note as follow-up.

## Files
New: `lib/month-spend.ts`, `lib/month-spend-build.ts`, `lib/budget-effective.ts`, `lib/dashboard-budget-tree.ts`, `components/dashboard/drill-button.tsx`, `components/dashboard/budget-lines-table.tsx`, `components/dashboard/drilldown-dialog.tsx` (replaces the modal body), tests below.
Edit: `app/page.tsx`, `components/dashboard/dashboard-client.tsx`, `components/dashboard/category-drilldown-modal.tsx` (reduced to line-kind pieces or removed), `components/dashboard/spend-category-cards.tsx`, `components/dashboard/spending-chart.tsx`, `actions/dashboard.ts` (`getTagTransactions` becomes unused; remove it only if grep shows no other user: today only the modal uses it), `app/budgets/page.tsx` (Step 6), `components/transactions/transactions-table.tsx` (Step 9), possibly `lib/monthly-review-build.ts`.
Do NOT edit: files listed under Scope/OUT, and `lib/__tests__/budget-carry-forward-guard.test.ts`.
Preserve each file's existing line endings (LF/CRLF) with binary-safe edits.

## Tests (Vitest, pure functions in `lib/__tests__/`; no live DB)
- `month-spend.test.ts` golden: a compact synthetic fixture (about 14 rows, same shape and exact classes/amounts as Sept 2026) must give: signed sum +4,562.94 (documenting the old bug), Spent 17,162.22, refunds 936.17, income 17,349.23, excluded own transfers 310.00, card payments -167.93, loan-account rows 4,233.86; and the bridge sums back to 4,562.94. Oct fixture: spending 11,344.16, 10 pending counted, untagged row shown in its own row. Do not commit the owner's full transaction list.
- Mortgage case: cash -4,335.69 + mirror +3,255.80 +1,079.89 -101.83 gives Spent contribution 4,335.69 and `Utilities / Mortgage` line spent 4,335.69 (not 0).
- Card double count: charge -100 on a card + payment -100 (checking) + payment +100 (card) counts 100 once.
- Multi-tag: one tx with two tags counts once in the headline; reconciling row appears with the right adjustment; zero case shows no row.
- Rollup: tx on an unbudgeted child goes to the nearest budgeted ancestor; parent = own + children; roots-only totals unaffected; headline = roots + not-in-any-line + untagged exactly (property test over random trees using Decimal).
- Overspent rule: leaf over, auto-sum parent not counted, explicit parent counted, rollover respected.
- `budget-effective.test.ts`: recurring override gives Sept 17,192.14 style delta on a fixture (+28) and equals the `/budgets` result.
- `currentPeriodNY`: 2026-09-30T23:30 NY (= 03:30Z Oct 1) stays September; `periodBounds` UTC.
- `dashboard-budget-tree.test.ts`: order and depth equal `nestBudgetLines` with the `/budgets` comparator; account totals root-only; collapsed state hides descendants only.
- Drill reconciliation test: for every kind, sum of rows (+ shown exclusions) equals the headline, computed from the same model.
- Source/structure tests: new lib files contain no `db.budget`; the dashboard files do not import `lib/budget-carry-forward*` or `lib/advisor*`; `app/page.tsx` still passes `recurring-followups-tester-pages.test.ts`; DrillButton renders a `<button>`; no `any`.
- Existing tests that encode old numbers: none found pinning dashboard sums (searched app/page and DashboardClient references); update only if the Coder's full-suite run proves otherwise and state why.
- Coder must run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and a throwaway read-only live script (deleted after) comparing the model to an independent SQL for Sept and Oct for personal, sudden-valley, ek-consulting and ALL.

## Acceptance criteria
1. Sept 2026 Personal "Spent" = 17,162.22 and Oct (to date) = 11,344.16 as of today's data (re-verify live; they move as rows change), and the drill-down rows plus shown exclusions sum to the figure.
2. Clicking "Spent" lists every excluded class (own transfers, card payments, loan-account rows, income) with count and sum; no old-number bridge is needed in the UI.
3. The Mortgage line shows the cash payment (4,335.69 in Sept) not 0.
4. Total Budgeted equals `/budgets` Total Budgeted for the same bucket and month (Sept 17,192.14, Oct 14,178.00 live today).
5. `/budgets` Total Spent equals the dashboard Spent for the same bucket and month.
6. Every card, chart bar, category card, budget row, account row and scheduled transfer row is a keyboard-focusable button or link; Escape closes the dialog; it works at 375 px width; `bucket` and `period` survive.
7. Budget Lines table is grouped by account, parents above indented children (`└`), parent totals = children, expand/collapse works, page totals count roots only, no double counting.
8. A failing widget does not blank the dashboard; Upcoming Suspense unchanged; `auth()` first.
9. No account numbers, no migration, no writes, no tax code, no `any`, Decimal everywhere, dates shown as the calendar day (not one day early).

## Risks / unknowns
- The "$4,336 of $4,700" mortgage figure was not reproduced live (it is $0 today). Needs a re-check before declaring the mortgage cause fully explained.
- The Credit Cards budget line (`Credit Cards / Credit card payment`, 300) is tagged on the card-side inflow while the checking outflows are tagged `Credit Card - Eric`. After the fix it will show $0 spent (today it shows the card-side +566.82). Not changed here; recommend the owner retag or move the line to the parent. Shown with a note in the dialog.
- ALL view blends Personal + Sudden Valley + EK Consulting money (existing behaviour, not tax). Plan keeps it (per-entity breakdown rows inside the drill-down). If ground rule 6 should forbid blending here, say so.
- Classification relies on tag names (`Credit Cards`, `Income`, `Transfer In/Out`, `/ Revenue`) and account type; a differently tagged card payment would be counted as spending. Mitigation: excluded classes are always listed; a card-payment-looking payee with no tag is not auto-excluded (no guessing).
- Line spend semantic change (nearest-budgeted-ancestor rollup) changes some leaf numbers (Groceries gains Farmers Market 102). It is the point of the tree; flagged.
- Pending rows are counted (Oct has 10). If Plaid replaces pending with posted rows both could appear; not investigated.
- Advisor tools (`get_budget_status`) and monthly review keep the old spend until the carry-forward work lands; follow-up task.
- Payload of all month rows to the client: fine at about 400 rows; revisit if ALL grows past a few thousand.

## Owner questions (plain language, recommended default first)
1. Should "Spent" count the full mortgage payment, credit card purchases when you swipe (not when the card is paid), and leave out transfers between your own accounts and credit card payments? Recommended: yes to all (this is the plan).
2. Should refunds reduce Spent? Recommended: yes, and show them on their own line.
3. Should income appear on the dashboard? Recommended: only inside the Spent drill-down as "Income this month", no new card.
4. "Overspent Lines": count only the detailed lines and manually budgeted parents, not parents that are just the sum of their children? Recommended: yes.
5. Show each account's balance (posted balance with "as of" date) on the dashboard? None is shown today. Recommended: yes.
6. Business expenses paid from your personal accounts (about $1,055 in September): keep counted in Spent with a "of which business" row? Recommended: yes.
7. Fix the one-day-early dates on the Transactions page too (same cause as the card due-date fix)? Recommended: yes.
