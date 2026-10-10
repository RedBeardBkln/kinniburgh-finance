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

---

# Browser-check fixes review (2026-10-10, HEAD 512ea9a plus uncommitted working tree)

## Verdict: APPROVED

No blocking finding. I read the real diffs (`lib/month-spend.ts`, `lib/own-account-masks-build.ts`, `lib/dashboard-drill.ts`, `lib/dashboard-drill-build.ts`, `app/page.tsx`, `app/budgets/page.tsx`, `components/dashboard/*`, the CLAUDE.md edit, and the new and changed tests) and did not rely on the write-up.

Independently verified by me:
- `pnpm typecheck`: clean.
- Vitest, 9 files (month-spend, own-account-masks, dashboard-drill, dashboard-drill-guard, dashboard-drilldown-render, the two tester files, budget-carry-forward-guard, advisor-spend-notes): 219 passed, 0 failed.
- Live read-only checks (select only, scratch script outside the repo): all 17 accounts listed; every account mask is unique today (no shared mask, none archived); the six rows the rule newly excludes are real, and every counterpart is an ACTIVE TD Bank account of the Personal entity, the same institution as the sending account (answer 4).

## Answers

1. **Narrow payee-wording exception: acceptable.** The earlier rule ("tag tree, never payee text") existed to stop guessing from free text. This is not a guess: the wording must match the strict anchored bank pattern `^Online Xfer Transfer (to|from) [A-Z]{2} x\d{4}$` (case-sensitive, nothing before or after; "... extra" and lower-case are tested to stay spending), AND the mask must resolve to exactly one active household account, AND that account must not be the row's own. A pending leg has no pair and may have no tag, so without this the owner's rule ("own-account transfers are never spending") cannot hold for pending rows. `classifyTx` only reads the wording when the map is supplied (opt-in, tested). Edge cases:
   - Third-party wire or transfer containing a household mask: cannot match, because the anchored wording is the bank's own-account "Online Xfer" form (a wire or Zelle line has different text). Residual risk: S2 (the mask map is not scoped to the sending institution).
   - Same mask on a closed/archived account: the loader filters `archivedAt: null`, so the row stays spending (conservative, visible, tested). It will overcount a genuine transfer to a closed own account; acceptable.
   - Two accounts sharing a mask: dropped as ambiguous in the loader (a third sharer is also dropped, tested). Today there are none.
   - Own-to-own double exclusion when the pair forms later: one class per row (the `transferPairId` check comes first and returns), so a later pair changes only the reason text, never the totals. Tested with the same rows paired and unpaired.
   - Transfer to an own account of a DIFFERENT entity: the mask map is household-wide, so a Personal account paying an LLC account is an own transfer in both entity views and in All Entities. I recommend keeping that. It matches how the existing pair and Transfer In/Out paths already treat cross-bucket flows (ground rule 6: a cross-bucket flow is an explicit transfer, not spending on either side; the business side records the expense when it is actually paid), and it stays visible in the "Not counted" list with its reason. It is not pinned by a test (N1). Live today there are no such rows (every household `Online Xfer` counterpart is a Personal TD account).
   - Mutation-style gaps (minor): no test for a counterpart in another entity (N1); the independent oracle fuzz in `dashboard-accuracy-tester-spend.test.ts` does not exercise the mask map (the 200-world fuzz in `month-spend.test.ts` does); direction is not checked against the amount sign (a positive "to" row, such as a returned transfer, is now excluded instead of counted as a refund, which is the right outcome); the two-letter code (CK/SV) is not checked against the counterpart's account type (N2).
2. **Mask handling: correct.** Masks are Map keys only. The payload goes through `displayPayee`: a known counterpart in the view is replaced by the account nickname, anything else keeps the wording with `x****`; unit and guard tests pin no `xNNNN` in any payee label. `settle()` logs `err.name` only, the loader has no `console` (pinned), and the reasons never contain a mask. The loader is read-only, `where: { archivedAt: null }`, `select: { id: true, mask: true }`, with no auth of its own (callers run `auth()` first; the dashboard and `/budgets` pages still start with it). A mask-read failure makes `drill` null, so the money cards read "Unavailable" rather than an inflated total: the right behavior. On `/budgets` the loader is awaited inline, like the already-unguarded `loadMonthTransactions` beside it, so a failure errors the page instead of showing a wrong Total Spent; consistent with that page's existing behavior. The only remaining place a mask appears is the pre-existing Accounts widget `···NNNN`, unchanged (earlier N2).
3. **`/budgets` equals the dashboard: yes.** Both feed the same loader result into `buildMonthSpend`; a guard test pins both call sites. Same model, same map, same Total Spent.
4. **The six newly excluded rows are correct.** Live: 2026-10-09 pending -400.00 (to x2558, Mortgage & Insurance) and -150.00 (to x3612, Slush Funds); posted 2026-04-16 -2,350.00 and 2026-04-20 -190.00 and -105.00 (all to Mortgage & Insurance), and 2026-04-20 -117.00 (to Heating & Electric). All are on Primary Checking, unpaired and untagged, going to an active TD account of the same household and entity. The April incoming legs are absent from the data (I looked for +2,350, +190, +105, +117 around those dates: none), so excluding only the outgoing side leaves nothing half-counted. October Personal falls by exactly 550.00 as reported. The 33 `to SV x8815` rows stay classed by their Transfer Out tag (that mask belongs to no household account).
5. **Cosmetics: fine.** `cadenceText` (Weekly, Every two weeks, Semi-monthly, Monthly, sane default) is used for the page badge and the detail rows. Exclusion groups show "Money in +$X, money out -$Y, net ..." with a "+ in, - out" key, from the signed per-transaction amounts. All Entities labels every account group "<account> · <entity>" through the single `groupLabel` helper (Spent dialog, Total Budgeted, Budget Lines table headers, account subtitle); single-entity views are unlabelled. The line subtitle "Budgeted on the X account · spending also on Y" is accurate and deterministic (sorted). The header (title plus month navigation) is passed as a prop and renders first, above the category cards and chart, while the summary cards and the Upcoming `<Suspense>` block are in the same place (guard test passes). The Spent dialog title is "Spent This Month" for the current month and "Spent in <Month Year>" otherwise.
6. **Ground rules.** Rule 1: no fabricated numbers; every excluded row is listed with its reason and the dialog still re-adds to the headline (`reconciles` is computed). Rule 5: `auth()` first in both pages, no new server action, no mask in payload or log, explicit selects. Rule 6: no transaction is reclassified or edited; cross-bucket flows remain explicit transfers (answer 1). Rule 8: wording stays observational ("Transfer to your own account, not counted"). No migration, no writes.

## Findings

### Blocking
None.

### Should-fix
- **S1. CLAUDE.md now contradicts itself.** The Dashboard paragraph's `own_transfer` clause was extended to mention the bank wording plus mask, but the next sentence still says "Classes come from the tag tree and account type, never from payee text". Reword it to say classes come from the tag tree, the account type and, for `own_transfer` only, the bank's exact transfer wording validated against the household's active account masks. Otherwise the next reader will "fix" the code to match the sentence.
- **S2. Scope the mask match to the sending account's institution.** The existing TD matcher (`lib/transfer-match-runner.ts`) limits both sides to `institution.name = "TD Bank"` because "Online Xfer" is TD wording. `loadOwnAccountByMask` maps masks across every institution, so a TD transfer to a non-household TD account whose last 4 digits equal the mask of a non-TD household account (QuickBooks, JCSB, CorePlus Loan, future cards) would be silently excluded from Spent. Probability is tiny and it is always visible in "Not counted", so I did not block, but the fix is cheap: also select `institutionId` and key the map by institution plus mask, comparing with the row's account institution.

### Nits and follow-ups
- N1. Add one test pinning the cross-entity decision (a Personal row "to" an LLC account's mask is an `own_transfer`), so a later change does not flip it silently.
- N2. Optionally require CK to map to a checking account and SV to a savings account; today only the mask matters (same as the TD matcher).
- N3. The advisor, monthly review and budget CSV are still on the old spend (named follow-up from round 1); pending or unpaired own transfers now also differ between them and the dashboard (the dashboard is the correct one).

## Test quality
Good for this round: 10 new model tests cover pending, both directions, opt-in, unknown and archived/foreign mask, own-account mask, near-miss wordings, pair-formed-later, tag plus mask, and 200 random worlds that keep the bridge (parts equal Spent, each row counted once). Loader tests pin active-only, id and mask select, and ambiguous-mask drop. Payload tests pin no `xNNNN`; guard tests pin the shared map on both pages and the header order. Gaps are the minor ones above (cross-entity, oracle fuzz without masks).

## What's good
- Smallest possible rule that closes the real hole (pending legs) and fails closed: an unknown, archived, ambiguous or own-account mask stays spending and visible.
- Live numbers re-derived independently and the changed rows enumerated across all months, including the historical April ones.
- Masks stay server-side; the dialog shows an account name instead.
- Dashboard and `/budgets` stay in agreement through one shared loader.
