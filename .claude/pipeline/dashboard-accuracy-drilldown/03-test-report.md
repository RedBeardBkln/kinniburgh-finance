# Test report: dashboard-accuracy-drilldown

## Verdict: PASS

No blocking defect. Every acceptance criterion that can be checked without a logged-in browser on the real server page passed, with independent evidence. Low-severity observations and owner decisions are listed below; none changes a number the owner relies on.

HEAD 2248489, dashboard work still uncommitted in the working tree. Nothing staged or committed, no DB writes, all temporary scripts deleted (`git status` shows no `_tester*`, `zz-*`, harness or vitest.zz files).

## Tests run (real output)

| Command | Result |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` clean, exit 0 |
| `pnpm lint` | 0 errors, 51 warnings (none in any new or changed dashboard file) |
| `pnpm test` (normal env, final run) | 470 files passed, 12,918 passed, 11 skipped, 0 failed |
| `DATABASE_URL=DIRECT_URL=postgresql://x:y@127.0.0.1:1/z pnpm test` | 470 files passed, 12,918 passed, 11 skipped, 0 failed, no test touches a real DB |

Environment flakes seen and re-run (not code): one full run died with `Worker exited unexpectedly` (while I was running live scripts concurrently) and one with `Failed to load PostCSS config ... Cannot find module 'is-number'` (node_modules touched by another session; `is-number@7.0.0` is present again). Both re-ran clean with identical results as above.

## Tests added (tester-named, untracked)

- `lib/__tests__/dashboard-accuracy-tester-spend.test.ts` (13 tests)
  - Independent oracle, written from the brief in tag-NAME-PATH terms and integer cents (no shared code): 600 random worlds. Per world it asserts headline `spent`, refunds, refund count, income, signed total, pending count, business-tagged spend, multi-tag correction, untagged, every class's count and signed sum, per-transaction class, per-line own and rolled spend, parent line, `countsAsOverspent`, the "not in any budget line" buckets, and `parts - correction == spent` EXACTLY (and `reconciles === true`). Branch-coverage guard: every class, refund, multi-tag, non-root line, unknown tag, pending and overspent each exercised in more than 50 worlds. World generator includes the repo's real tag vocabulary and traps (`Taxes / Income Tax` is spending, `Credit Cards / Interest paid` is spending, business `... / Credit card payment` is a card payment, `Revenue / Interest earned` is income), mortgage and loan account rows, paired transfers, pending rows, huge amounts, same tag with lines in several accounts.
  - Named brief cases: card-payment suffix at any depth/case, precedence pair > loan > transfer > card > income, untagged inflow = refund, zero row = spending, PennyMac mirror rows classed `loan_account` with the Mortgage line showing the 4,335.69 cash payment, business spend counted where paid and only labelled, multi-tag counted once, pending disclosed.
  - Boundaries: `periodBounds` at UTC midnight (Dec/Jan, leap February), `currentPeriodNY` against an independent US-DST oracle on 4,000 random instants and every month edge +-1 s, plus explicit 03:59:59Z / 04:00:00Z cases.
  - Full pipeline fuzz (real `resolveEffectiveBudgets` -> `buildMonthSpend` -> `buildDrillData` -> `buildDrillView`), 300 worlds: Total Budgeted vs an independent own-recursion total (incl. a recurring override); every Spent / Budgeted / Overspent / line view re-adds to its headline; every transaction appears in the Spent dialog exactly once per target, or exactly once under "not counted", never both; excluded rows are context only; account views sum to net activity; per-line payload fidelity (budget incl. rollover, rolled, remaining, over-by, children); section subtotals; duplicate-correction row sign.
- `lib/__tests__/dashboard-accuracy-tester-page.test.tsx` (15 tests)
  - Renders the real `app/page.tsx` server component with mocked reads: numbers (Spent 130.00 = 120 + 30 - 20 refund, card payment excluded), `auth()` first (no session = redirect and zero DB reads), links keep bucket and period, invalid/future periods fall back, all-entities vs per-entity scoping of budgets, accounts, scheduled transfers and recurring, no 9+ digit number in the HTML, "and N more" for more than 10 transfers.
  - Fail-soft: forcing each of the six reads to reject (budget lines, month transactions, tags, recurring, accounts, transfers) blanks only that widget, the rest render, summary cards read "Unavailable" (never 0), and `console.error` carries only the error name (a connection string / message in the thrown error never appears).
  - `loadMonthTransactions`: read-only `findMany`, `archivedAt: null`, bounds `[first, next first)` UTC, optional entity filter, explicit select with no description / notes / mask / token columns, day from the stored UTC date, payee priority, exact Decimal amounts.

## Mutation checks (temporary alias-swap copies only, deleted afterwards)

81 real mutants + 2 identity sanity mutants over `month-spend`, `dashboard-drill-build`, `dashboard-drill`, `budget-effective`, `dashboard-budget-tree` (classification, precedence, bounds, NY time zone, rollup, nesting, overspent rule, rollover, dedupe of targets, refund netting, double counting of children, links dropping bucket or period, sign errors ...). Both identity mutants survived (runner sane); all 81 real mutants were killed. 71 by the Coder's tests alone, 10 only by my tests (zero-amount class, precedence swaps, pending counting, unknown tag, last-line-wins, rollover and subtotal display fields). Three mutants first survived (payload rollover, duplicate-row sign, spent-view parent subtotal); I added the missing payload-fidelity assertions and all three are now killed.

## Acceptance criteria

1. **Spent figures. PASS.** Live, read-only (select-only repo-root script, deleted). Independent raw SQL (name-pattern classification in SQL, `DISTINCT` per transaction, not the helper) vs the app pipeline (`loadMonthTransactions` + `buildMonthSpend`):

   | Period | Bucket | SQL Spent | App Spent | Pending |
   |---|---|---|---|---|
   | 2026-09 | Personal | 17,162.22 | 17,162.22 | 0 |
   | 2026-09 | Sudden Valley | 1,204.38 | 1,204.38 | 0 |
   | 2026-09 | EK Consulting | 82.68 | 82.68 | 0 |
   | 2026-09 | All Entities | 18,449.28 | 18,449.28 | 0 |
   | 2026-10 | Personal | 11,344.16 | 11,344.16 | 10 |
   | 2026-10 | Sudden Valley | 252.42 | 252.42 | 0 |
   | 2026-10 | EK Consulting | 63.63 | 63.63 | 0 |
   | 2026-10 | All Entities | 11,660.21 | 11,660.21 | 10 |

   Row counts match too (220/220, 17/17, 9/9, 246/246, 80/80, 3/3, 4/4, 87/87). `reconciles=true` and multi-tag correction 0.00 everywhere. The old bridge reproduces: Sept Personal signed unpaired sum +4,562.94 = -17,162.22 Spent + income 17,349.23 + own transfers 310.00 + loan-account rows 4,233.86 + card payments -167.93 (the four excluded classes: own_transfer 37 rows, card_payment 5, loan_account 3, income 6; refunds 936.17 in 3 rows; untagged 4 rows 88.12; business-tagged 1,034.57). Oct Personal: signed -5,303.00 (the old "5,303.00"), untagged 8 rows 2,350.15, 10 pending disclosed (the 10th is a 0.00 pending Etsy row).
2. **Excluded classes listed with count, sum and reason. PASS.** Fuzz asserts exclusion rows are context only (never added) and each carries count and signed sum; real-browser harness showed the "Not counted in Spent, and why" groups.
3. **Mortgage line shows the cash payment. PASS.** Live `Utilities / Mortgage` rolled 4,335.69 (Sept and Oct) vs 4,700 budget; PennyMac mirror rows are `loan_account`.
4. **Total Budgeted equals /budgets. PASS.** Both pages call `resolveEffectiveBudgets`. Independent own-recursion recomputation on the same Budget rows matches the app for all 8 bucket/period pairs (Sept Personal 17,192.14, Sudden Valley 2,549.00, EK 100.00, All 19,841.14; Oct Sudden Valley 1,399.00, EK 0.00). The old dashboard figure 17,164.14 + 28 recurring (Eversource) = 17,192.14 confirmed. **Oct Personal: the brief's 14,178.00 no longer holds live, and that is data drift, not a defect.** The owner added Oct Budget lines during this session (createdAt 2026-10-09T23:57Z to 2026-10-10T00:03Z and later). Budget rows created before 23:00Z give exactly 14,178.00 (48 rows); at my last read there were 63 rows = 15,433.00, and the app and the independent total agreed at every moment I compared.
5. **/budgets Total Spent equals dashboard Spent. PASS.** Same `spendModel.spent`; evaluated live with the two display formulas: dashboard card "$17,162.22", /budgets "$17,162.22" (Sept); "$11,344.16" both (Oct). Source pinned in the Coder's guard test.
6. **Every widget opens a dialog or is a link; accessibility; 375 px. PASS (component level, real browser).** I bundled the real client components (esbuild, Tailwind CSS, fixture payload with 96 rows) and drove them in headless Chrome over CDP at 375x812 and 1280x900: 59 checks, 0 failed. Highlights: every button has an accessible name; no horizontal page overflow; Enter and Space on a card open the dialog; focus moves into it; 120 Tab/Shift+Tab presses never leave it; Escape closes and focus returns to the trigger (card, bar chip, table row); backdrop click closes, click inside does not; the dialog fits 375 px and its long list scrolls; each chart bar has a real keyboard-reachable button; category cards are buttons; the table collapse toggle (aria-expanded) hides nested rows and does not open a dialog, Expand all restores; clicking a non-button cell opens the line dialog; the Mortgage dialog shows $4,335.69; account dialog link is `/transactions?bucket=personal&accountId=...&tab=all`; budgeted link `/budgets?bucket=personal&period=2026-09`; no 9+ digit number in any dialog; zero runtime or console errors. The bundle contains 0 `@prisma` and 0 `node:` references (esbuild metafile; `decimal.js-light` is recharts' own dependency, not Prisma's Decimal). Next-30-days widget untouched; every item label is a `<Link href>` (`upcoming-parts.tsx`).
7. **Budget tree. PASS.** Same `nestBudgetLines` and comparator as /budgets (parents above `└` children, grouped by account); page totals and group headers count top-level lines only (fuzz: group budget sums equal Total Budgeted, group spent plus outside-lines plus untagged minus correction equals Spent, no double counting); parent totals = own + children; collapse/expand verified in the browser harness. Mutation-killed.
8. **Fail-soft, auth, Suspense. PASS.** See page test above; `app/page.tsx` still starts with `await auth()`, the `{isCurrentPeriod && (` + `<Suspense key={bucket} fallback={<UpcomingWidgetSkeleton days={30} />}>` block and `{/* Next 30 days (current month only) */}` marker intact (existing pin test passes in the full run).
9. **No account numbers, migration, writes, tax code, `any`; dates. PASS.** No change under `prisma/`, `actions/` (only the deletion below), tax or advisor/bill-dates/carry-forward/upcoming/notifications files. Loaders are read-only with explicit selects. Lint/typecheck clean.

## Drill list from the brief

- **Overspent Lines = 12 (Sept Personal), why not 11. PASS, explained.** Live: 12 counted, old flat rule 11, old-only lines none, new-only line `Business Expenses / Eric @ Primary Checking` (1,034.57 vs 150): under the nearest-budgeted-ancestor rollup the 1,034.57 of business-tagged spend now lands on that line, where before only transactions tagged exactly that tag counted (0). October Personal gains the same Business Expenses line (the Oct counts moved while the owner was editing Budget lines, so I do not quote them).
- **Recurring override +28 applied. PASS** (Sept 17,164.14 -> 17,192.14).
- **All-entities (item 5 of the brief).** Per-entity split rows in the Spent dialog and the "all entities combined" label are present (tested). CLAUDE.md ground rule 6 says every transaction belongs to exactly one bucket and cross-bucket flows are explicit transfers; it does not forbid an aggregate view, and no spec forbids one. The combined All Entities Spent (18,449.28 Sept) still blends Personal, Sudden Valley and EK money. **Owner decision, not a failure.**
- **Dates (item 6). PASS, not over-applied.** Only `timeZone` was changed, in six places, all of them `Transaction.postedAt` display: Transactions table, transaction detail, excluded-from-P&L, GL page, review queue, projects page. Each other `postedAt` display in the repo (gl-backfill-modal, receipt-confirm-form, retroactive-rule-modal, business revenue page) already used `timeZone: "UTC"`, so the change aligns them. Live check: of 242 non-midnight `postedAt` rows, all sit at 08:xxZ or 12:00Z (same calendar day in UTC and New York), so UTC is right for every existing row; the dashboard balance "as of" stamp keeps New York time (a real instant). `formatCalendarDate` precedent in `lib/card-due.ts` is the same pattern.
- **Guards (item 7). PASS.** Only the pre-existing allow-listed files (`app/page.tsx`, `app/budgets/page.tsx`, plus `actions/budgets.ts`, `actions/recurring-suggestions.ts`, `actions/reports.ts`, `lib/monthly-review-build.ts`, `lib/budget-carry-forward-build.ts`) reference `.budget.*`; no new file does, and the guard tests pass. No new `"use server"` file. `getTagTransactions` (deleted `actions/dashboard.ts`) and `CategoryDrilldownModal` have no remaining user (grep: only a comment in `transfer-history-panel.tsx` and the guard test asserting the files are gone). Line endings: git index is LF for every touched file; new files are LF with 0 CR; the working copies follow the repo's mixed autocrlf state (three touched files are LF in the working tree like their siblings). I cannot prove the pre-edit working-tree endings, but no diff shows a whole-file change.
- **/budgets still works (item 8). PASS.** Empty months: the model with zero lines puts all spend under "not in any line" and the page note says so; per-account totals still sum only top-level budgeted amounts (checked `budget-page-client.tsx`: no per-account spent sum, so no double count from the new parent rollup). Monthly review, advisor tools and the budget CSV export are unchanged and still on the old spend (documented follow-up); the full suite passes with them.

## Defects found

None blocking.

## Observations (low severity or owner decisions, none blocking)

1. Owner decision: All Entities Spent still blends the three entities' money (see above).
2. Cosmetic: at 375 px the new "(click a bar or a name below to drill in)" hint makes the chart title wrap and visually overlap the Budget/Actual legend (seen in the harness screenshot). Not functional.
3. By design but surprising: an auto-sum parent line can show red (over its summed budget) without being in "Overspent Lines" (Sept live: Business Expenses, Personal Wellbeing, Memberships and Subscriptions are red but only their over-budget children are counted). Memberships and Subscriptions is over partly from 38.78 tagged directly to the parent; if that were the only overage, Overspent Lines would read 0 while the row is red.
4. Rule consequence: when the same tag has Budget lines in two accounts, the first line (account nickname order) owns all that tag's spend and the second shows 0. None exists in Sept/Oct today (live query empty).
5. Theoretical: a transaction stamped with a real instant between 00:00Z and 04:00Z on the 1st (New York evening of the previous month) would be counted in the new month; none exist live (all non-midnight rows are 08:xx or 12:00 UTC). The page's current-month switch itself uses New York time (verified by the DST oracle).
6. The Credit Cards budget line (300) now always reads 0 and the dialog explains why; owner may retag it (Coder's open item).
7. Pending rows are counted and disclosed (10 in Oct, including a 0.00 row); a pending row later replaced by a posted one could briefly appear twice (not investigated, as in the plan).
8. Monthly review, advisor `get_budget_status`/context and the budget CSV export still use the old per-tag signed spend (documented follow-up).
9. `app/transactions/page.tsx` `dateFrom`/`dateTo` overwrite bug left untouched (pre-existing, not used by any new link).

## Not tested

- The real `/` and `/budgets` pages in a logged-in browser (no credentials; behind auth). Substitutes: server page render with mocked reads (fail-soft, links, scoping), real client components in headless Chrome with fixture data (focus, keyboard, Escape, backdrop, 375 px), live read-only recomputation of every number. Still worth a human glance (per Coder's list): visual polish of the dashboard at 375 px, the budget editor and tag editor inside the line dialog (stubbed in my harness), and that the page refreshes after an edit.
- `pnpm build` / `next build` (shares `.next` and the DB pool with other sessions; client bundle checked with esbuild instead).
- Edge: tag-parent cycles (impossible in the data; the helper has a cycle guard but an all-cycle tree would drop the cyclic lines from the roots and `reconciles` would be false).

## Memory

Recipe saved to `.claude/agent-memory/tester/dashboard-drilldown-verification-recipe.md` and indexed in `MEMORY.md`.
