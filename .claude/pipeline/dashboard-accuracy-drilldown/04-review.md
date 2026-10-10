# Review: dashboard-accuracy-drilldown

## Verdict: APPROVED

No blocking finding. HEAD 2248489, work uncommitted in the tree (nothing staged). I read the real code (all new lib files, `app/page.tsx`, the `/budgets` diff, every `components/dashboard/*` file, the six date-display diffs, the deleted `actions/dashboard.ts` and `category-drilldown-modal.tsx`) and did not rely on the write-ups.

Independently verified by me:
- `pnpm typecheck` clean.
- ESLint on every changed or new dashboard file: no output (clean).
- 11 test files (Coder + tester dashboard tests, `recurring-followups-tester-pages`, `budget-carry-forward-guard`, `budget-nesting`): 227 passed, 0 failed.
- Live read-only checks (select only, scratch script outside the repo): no investment-type transactions in Sept/Oct (so no brokerage buy/sell can leak into Spent); credit-card, mortgage and loan balances are stored as positive-owed, matching the dashboard's "owed" label; Budget unique key is `(tagId, entityId, period)`.
- `git status`: no stray `_x*`/`_tester*` files; no migration, no `actions/**` change except the deletion.

## Ground-rule check
- Rule 1 (no fabricated numbers): every figure comes from one model (`buildMonthSpend`); `reconciles` is computed from the parts, the dialog re-adds the visible rows and shows a red warning on mismatch, and exclusions (own transfers, card payments, loan-account rows, income), refunds, pending, untagged and "not in any budget line" are all listed with count, sum and reason. PASS.
- Rule 3 (immutable transactions / no writes): the only writer reachable is the pre-existing `updateBudgetLine` inside the line dialog. PASS.
- Rule 5: `await auth()` is still the first line of `app/page.tsx` and `app/budgets/page.tsx`; no new `"use server"` file (one removed); loader selects exclude description, notes, mask and tokens; errors log `err.name` only; the client bundle imports only client-safe libs (Decimal stays server-side, payload is strings and integer cents). The Accounts widget still shows the pre-existing last-4 mask (`···1234`); that is not new and is not an account number, but see nit N2. PASS.
- Rule 8 (observational wording): "Money that left your accounts or was charged to a card, net of refunds", "Net of $X refunds", no advice language. PASS.
- Fail-soft: six independent `settle()` reads plus a try/catch around the model build; a failing read blanks one widget and the summary cards read "Unavailable", never 0. `DrillButton` renders plain content when data is null. The Upcoming `Suspense` block and its pinned strings are untouched (the pin test passes). PASS.

## Answers to the specific questions

1. **All Entities blended Spent: acceptable, keep it, but make it consistent.** Rule 6 says every transaction belongs to exactly one bucket and cross-bucket flows are explicit transfers; this view does not reassign or edit anything, own transfers (paired or tagged) and card payments are excluded so no cross-bucket money is counted twice, and the old dashboard already blended all three entities (Sept ALL headline was 7,323.51). The stricter "never a blended total" rule in CLAUDE.md applies to the Upcoming ledger, not here. The Spent card says "all entities combined" and the dialog adds a per-entity split (verified in `buildDrillData`: it sums to Spent exactly). Required for consistency, not for approval: the Total Budgeted card in the All Entities view (19,841.14 Sept) also blends three entities but carries no such label (S4).
2. **Month-spend definition vs the approved defaults: correct.** Mortgage cash leg counts and the PennyMac mirror rows (`loan_account` by account type) are excluded, so the Mortgage line reads 4,335.69; card charges count when charged (card `Interest paid` stays a cost); both card-payment legs and own transfers are excluded; refunds reduce Spent and are listed; income only appears as an information row and under "Not counted"; pending rows are counted and disclosed; business-tagged spend is counted where paid with an "Of this" row. Classification precedence (pair, loan account, Transfer tags, card payment, income, then sign) is sensible and uses the tag tree, never payee text. The transfer auto-matcher is TD-Bank-only, so it will not start pairing the PennyMac legs and silently drop the mortgage from Spent.
3. **+28 recurring override: equalised.** `/budgets` and the dashboard now both call `resolveEffectiveBudgets`; I compared its arithmetic with the removed `/budgets` code (`(sum monthly equivalents + additional) / 100`, per-account resolve, roots only): identical. Sept 17,164.14 to 17,192.14.
4. **Overspent Lines with auto-sum parents: acceptable (it is the owner's approved default Q4), with one disclosed hole.** A parent that only adds up its children can be red in the table without being in the count, and the Overspent dialog subtitle says so. The hole: spend tagged directly to an auto-sum parent (e.g. Memberships and Subscriptions, 38.78) can push the parent over its summed budget while no child is over, so the count reads lower than the red rows. Follow-up only (F2); do not change the rule in this review.
5. **Same tag in two accounts: not reachable.** The DB key is `(tagId, entityId, period)`, so within one bucket a tag has at most one line; only the All Entities view could see the same tag in two entities, and `/budgets` already blocks that household-wide. "First line owns the spend" is fine.
6. **375 px chart title/legend overlap: cheap to fix now, do it (S3).** In `components/dashboard/spending-chart.tsx` the title and the new "(click a bar...)" hint share a non-wrapping flex row with the legend. Make the header row `flex flex-wrap items-center justify-between gap-2` and put the hint in its own `<p className="text-xs text-muted-foreground">` below the title.
7. **Date fixes: only where the bug exists.** Six sites changed (`timeZone` only), all of them formatting `Transaction.postedAt`, and the only call sites of the two shared helpers (`transactions-table` `formatDate`, `queue-client` `formatDate`) take `postedAt`. I confirmed live that no stored non-midnight `postedAt` falls in the 00:00-04:00Z window, so UTC is correct for every existing row. The dashboard balance "as of" stamp correctly stays in New York time. PASS.
8. **Other readers still on the old spend: telling the advisor is the minimum, a bare follow-up is not enough (S1).** They now silently disagree with the dashboard: `get_budget_status` (note says Spent "can differ from the Budgets page for lines linked to recurring expenses", which was true before and is now misleadingly narrow), `lib/advisor-context.ts` ("Total spent: ..."), the `lib/advisor/queries/spend.ts` header comment ("as on the Budgets page" is now false), `lib/monthly-review-build.ts` (raw SQL per tag, signed) and the budget CSV export. Moving their logic is correctly a separate task, but the advisor will now explain a mismatch (Mortgage 0 vs 4,335.69) with the wrong reason.

## Findings

### Blocking
None.

### Should-fix
- **S1. Advisor and other readers contradict the dashboard with an out-of-date explanation.** Smallest acceptable change, note text only, no logic: in `lib/advisor/tools/get-budget-status.ts` (the `notes` string and the tool `description`), `lib/advisor-context.ts` line ~184 (rename "Total spent" to something like "Net outflow on budget tags") and the stale comment in `lib/advisor/queries/spend.ts`, say that this figure is the net signed amount on the exact tag, that it is NOT the dashboard's Spent (which excludes card payments, loan-account entries and income, includes nested sub-tags and refunds), and that the two can differ. Check the advisor tests that pin description or note strings after editing. Record the full migration of monthly review, advisor and CSV to `buildMonthSpend` as a named follow-up task.
- **S2. CLAUDE.md has no entry for this feature.** Every comparable change (Upcoming ledger, Recurring detection, Budget carry-forward, net-income) added an Architecture paragraph. Add one: the Spent definition and classes, `lib/month-spend*`, `budget-effective`, `dashboard-drill*`, the "no second reader of the Budget table" and `/budgets` agreement rules, that the dashboard reads real Budget rows only (not carry-forward), the NY-month rule, and the list of readers not yet on the model (S1).
- **S3. Chart header wraps badly at 375 px** (see answer 6). Cosmetic, one-line class change.
- **S4. All Entities labelling.** Add the same " · all entities combined" note to the Total Budgeted card sub-line when `drill.isAllEntities` (page line ~241), so the two blended cards read the same.

### Nits and follow-ups (none required)
- N1. `percentUsed` in `buildDrillData` uses `Math.abs(rolled)`, so a line whose refunds exceed its spend shows a positive percentage; clamp the numerator at 0.
- N2. Accounts rows still print `···{mask}`; the brief said "no account numbers". It is pre-existing and last-4 only, so I did not block, but dropping it would remove the question.
- N3. `DrillButton` wraps a `<Card>` (div) inside a `<button>`; works, technically invalid HTML nesting.
- N4. Untagged inflows are classed as refunds (no guessing from the payee), so a large untagged deposit would reduce Spent. It is always visible ("Net of $X refunds", Refund chip rows) so I accept it; consider a size threshold later.
- N5. Part C in the current month: Oct Personal now has 63 lines, 17 nested, 41 whose parent tag has no Budget line (Sept: 45 nested, 7 with no parent line, 8 with the parent line in another account). Those render as top-level rows with the full tag path, exactly as `/budgets` does, so the tree fills in as the owner enters parent lines; a synthetic category header for tags with no parent line would be a separate enhancement.
- N6. `app/transactions/page.tsx` `dateFrom`/`dateTo` overwrite bug remains (not used by any new link).
- N7. `lib/month-spend.ts` first-line-wins tag ownership could misattribute in the All view if the same tag ever has lines in two entities (blocked by the UI today).
- F2. Auto-sum parent with direct spend exceeding its summed budget is not counted as overspent (answer 4).

## Test quality
Strong. The Sept golden fixture reproduces the 4,562.94 bridge exactly; a 600-world independent oracle (integer cents, tag-name paths, no shared code), 300-world pipeline fuzz (`resolveEffectiveBudgets` to `buildMonthSpend` to `buildDrillView`, every view re-adds to its headline), a DST oracle for `currentPeriodNY`, real client components driven in headless Chrome at 375 and 1280 px, and 81 killed mutants. Source-guard tests pin no `db.budget` in new files, no `"use server"`, no `any`, and the page's pinned strings. The remaining gap is the one both agents named: nobody has seen the real logged-in pages, so the visual checklist in 02-implementation.md ("Needs human visual verification") still needs one human pass.

## What's good
- One pure model behind the cards, table, chart, dialogs and `/budgets` Total Spent; `reconciles` is computed, not assumed, and the dialog visibly re-adds the rows.
- The root cause of the owner's $4,562.94 was found and explained to the cent (a signed net of income minus spending with the sign dropped, plus the mortgage mirror rows cancelling the cash payment), and the fix reproduces independent SQL for all four buckets and both months.
- Exclusions are shown, not hidden; pending and refunds are disclosed; no fabricated or silently-zeroed values ("Unavailable" instead of 0).
- Scope discipline: no migration, no new server action, carry-forward and advisor files untouched, existing nesting helpers reused, date fix limited to real `postedAt` displays.
- Accessibility done properly (real buttons, focus trap and return, Escape, keyboard-reachable chart bars via a button list).
