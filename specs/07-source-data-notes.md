# 07 — Source Data Notes: Discrepancies, Decisions & Open Questions

Found while transcribing the owner's source document and CSVs. **Do not silently "correct" anything below.** Resolved items carry owner decisions from a June 2026 walkthrough; treat those decisions as authoritative.

## Resolved by owner (June 2026 walkthrough)

1. **Car payments.** `Car Payment` budget $1,500/mo = Eva's Lexus **$250/week** (avg $1,083.33/mo) + Eric's Toyota truck **$420/month** (= $1,503.33; budget rounds to $1,500). The Lexus is the only weekly-paid bill the owner recalls. **The Lexus is paid from x2566 (Primary), not x2558** — only the Toyota draws on x2558. This resolves the apparent x2558 funding shortfall: outflows ≈ $6,096.58/mo vs $6,433.33/mo inflows (~$337/mo cushion).
2. **Auto insurance.** Doc figures are current: Amica $206/mo + Progressive motorcycle $127/yr (~$10.58/mo) ≈ $217/mo combined. The v2 budget line ($120) was stale — **owner confirmed 2026-09-11; updated to $217/mo for the 2026-09 through 2026-12 `Budget` rows** (already-closed Jan–Aug periods left as historical record, not restated).
3. **Slush Funds (x3612).** $1,200/mo of budget, no existing funding transfer. The app proposed a recurring transfer at the spec-estimated ~$277/wk (≈$1,200/mo); **owner corrected and approved 2026-09-11: the real transfer is $190/wk**, not $277/wk — a `ScheduledTransfer` (x2566 → x3612, weekly, Monday) now exists at that amount. The lower figure means Slush Funds is not fully funded to its $1,200/mo budget by this transfer alone (~$823/mo vs. $1,200/mo) — worth flagging to the owner if the app ever surfaces an accrual-shortfall warning for this envelope; that's expected given the corrected amount, not a bug.
4. **Arbor Retreat budget lines → Sudden Valley PM LLC entity from day one** (mapped to JCSB x0626). `Business Ventures` $50/mo line stays personal, mapped to x2566.
5. **Budget file v2** (`budgets 2026 v2 (with accounts).csv`) supersedes v1. Owner cleaned the data and added account mapping; amounts are starting points and may be updated. v1 is retained only as historical reference (its Rollover column holds real opening balances; its Available column was unreliable — see "v1 anomalies" below).
6. **Solar lender naming:** "Regions Bank" (prose) and "Ener Bank" (table) are the same lender — EnerBank USA was acquired by Regions Bank (2021). Record as Regions/EnerBank.
7. **EKC LLC tax classification:** single-member LLC, disregarded entity → Schedule C on Eric's personal 1040. Extended 2025 deadline is the standard personal-extension date, **October 15, 2026** — confirm with CPA before relying on it.
8. **Mezzo:** not yet formed/registered. Expense-bucket only until a formation date/state is recorded.
9. **Savings (x3950):** app recommends the "pay ourselves first" amount after 2–3 months of linked data, from actual cash-flow surplus, for owner approval.
10. **$250/$15 minimum-balance rule: TD Bank accounts only.** JCSB x0626 has no such rule.
11. **JetBlue card is Barclays-issued** — same login as the other Barclays card.
12. **Property values (owner-supplied 2026-09-11, Zillow estimates):** 27 Old Barry Rd = **$529,500**; 56 Arbor Rd = **$337,400**. Recorded as `ManualAsset` rows (`real_estate` category) feeding net worth.
13. **Loan balances (PennyMac, solar):** PennyMac mortgage balance **is already pulled via Plaid Liabilities** — confirmed 2026-09-11, no manual entry needed. Solar loan balance still pending manual entry (owner to retrieve total due).
14. **GL chart of accounts:** to be IMPORTED from the CPA/QuickBooks (build a QuickBooks COA import); freeform receipt classification until then.

## Remaining arithmetic / consistency notes (informational)

1. **x2540 weekly transfer:** doc says $256/wk; components sum to $255.30/wk. Implement $256; the ~$0.70/wk pads the envelope.
2. **x2540 budget vs accrual table:** v2 budget lines (Electric 172, Oil 308, Firewood 80) run below the doc's accrual figures (184, 333, 83); Solar 506 matches. Budget total $1,066/mo vs $1,109.33/mo funding (+$43.33 cushion). Reconcile against actual bills once accounts are linked.
3. **x2558 component conversion math** in the source table is internally inconsistent (Toyota ÷4, Amica ÷26, Progressive ÷12). Moot for implementation — the real transfer is $400/wk; component lines are budget allocations.
4. **Sudden Valley variances:** Property Taxes budget $275 vs accrual $281.67/mo; Electricity budget $100 vs ~$83 fluctuating. Reconcile from actuals.
5. **Missing annual budgets** for Toyota and NWM rows in the source x2558 table. Leave null.

## v1 budget CSV anomalies (historical, superseded)

In v1, 12 of 53 rows had `Available ≠ Budgeted − EXPENSE + Rollover` (e.g., Groceries calc 789.25 vs file 859.70; Eversource calc −975.09 vs file 86). Likely mid-period adjustments or rollover caps in the prior tool (Buxfer, per the subscription tag). No action needed — v2 supersedes; only v1's Rollover column may be imported (with confirmation) as opening balances.

## Tags CSV quirks (`data/tags 2026.csv`)

- `memberships / Apple` — lowercase parent reference (parent is `Memberships`)
- `Utility/Internet` — stray root-level tag (vs. `Utilities / Internet`, which also exists)
- `Misc. / ATM Withdrawl` — misspelling of "Withdrawal"
- Import verbatim; offer one-click cleanup with user approval.

## Remaining open items (collect from the user in-app or before the relevant phase)

1. ~~Approximate property values for 27 Old Barry Rd and 56 Arbor Rd~~ — **resolved 2026-09-11**, see item 12 above.
2. ~~CPA confirmation of the October 15, 2026 extended deadline~~ — **confirmed by owner 2026-09-11.**
3. ~~The QuickBooks/CPA chart-of-accounts export file~~ — **received 2026-09-12** (EK Consulting LLC only; `data/gl-accounts-ekc-2026.csv`). No account-number column in the export, so codes were assigned by the app using standard chart-of-accounts numbering (1000s assets, 2000s liabilities, 3000s equity, 4000s revenue, 5000s COGS, 6000s expenses, 7000s other income, 8000s other expense) per owner decision. Diffed against the `GlCode` rows already in the DB (seeded June 2026 from what turns out to be this same chart): 144/146 accounts already matched exactly; added the one missing account ("Tools, machinery, and equipment", code 1170 — silently dropped by the original import, likely a CSV-parsing edge case on its embedded comma). Left `Capital One 1909 - 3` (code 2010) as-is rather than overwriting it with this export's masked `XXXX1909 - 3` — same account, existing name more informative. Sudden Valley PM LLC and Mezzo still use the small placeholder GL charts in `prisma/seed.ts`, not a real CPA export — their own QuickBooks exports (if the CPA tracks them separately) are still pending.
4. ~~Confirm the Auto Insurance budget line update to ~$217/mo~~ — **confirmed and applied 2026-09-11**, see item 2 above. Whether Progressive gets its own line is still open (currently combined into the single Auto Insurance line).
5. ~~Approve the proposed Slush Funds transfer~~ — **resolved 2026-09-11: $190/wk, not the ~$277/wk estimate**, see item 3 above. The app-recommended savings transfer (x3950) is still unproposed — pending the "2–3 months of linked data" trigger from item 9 above (plenty of history now exists; worth revisiting whether that trigger has effectively already been met).
6. ~~Solar loan balance~~ — **resolved 2026-09-13.** Regions Bank (EnerBank) solar loan: outstanding balance $115,802.97, rate 1.490%, current statement $474.70 due 09/23/2026, enrolled in $505.70/mo auto-pay drafting on the 17th. Applied to the existing `DebtDetail` row for the Solar loan account (`accountId` b8ba146b-a43b-4f96-9b21-f17046c3fa70) — `manualBalanceCents`, `monthlyPaymentCents` (set to the actual $505.70 auto-pay draft, not the $474.70 statement minimum), and `paymentDay` (17, the draft day) updated; statement due-date/amount recorded in `notes` since there's no dedicated field for it on a non-credit-card debt. (PennyMac mortgage balance is confirmed already flowing via Plaid Liabilities, see item 13 above.)
