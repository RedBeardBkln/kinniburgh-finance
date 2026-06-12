# 07 — Source Data Notes: Discrepancies, Decisions & Open Questions

Found while transcribing the owner's source document and CSVs. **Do not silently "correct" anything below.** Resolved items carry owner decisions from a June 2026 walkthrough; treat those decisions as authoritative.

## Resolved by owner (June 2026 walkthrough)

1. **Car payments.** `Car Payment` budget $1,500/mo = Eva's Lexus **$250/week** (avg $1,083.33/mo) + Eric's Toyota truck **$420/month** (= $1,503.33; budget rounds to $1,500). The Lexus is the only weekly-paid bill the owner recalls. **The Lexus is paid from x2566 (Primary), not x2558** — only the Toyota draws on x2558. This resolves the apparent x2558 funding shortfall: outflows ≈ $6,096.58/mo vs $6,433.33/mo inflows (~$337/mo cushion).
2. **Auto insurance.** Doc figures are current: Amica $206/mo + Progressive motorcycle $127/yr (~$10.58/mo) ≈ $217/mo combined. The v2 budget line ($120) is stale — update to ~$217 at seed time with owner confirmation.
3. **Slush Funds (x3612).** $1,200/mo of budget, no existing funding transfer. App should PROPOSE a recurring transfer (~$277/wk) for approval at setup; do not auto-create.
4. **Arbor Retreat budget lines → Sudden Valley PM LLC entity from day one** (mapped to JCSB x0626). `Business Ventures` $50/mo line stays personal, mapped to x2566.
5. **Budget file v2** (`budgets 2026 v2 (with accounts).csv`) supersedes v1. Owner cleaned the data and added account mapping; amounts are starting points and may be updated. v1 is retained only as historical reference (its Rollover column holds real opening balances; its Available column was unreliable — see "v1 anomalies" below).
6. **Solar lender naming:** "Regions Bank" (prose) and "Ener Bank" (table) are the same lender — EnerBank USA was acquired by Regions Bank (2021). Record as Regions/EnerBank.
7. **EKC LLC tax classification:** single-member LLC, disregarded entity → Schedule C on Eric's personal 1040. Extended 2025 deadline is the standard personal-extension date, **October 15, 2026** — confirm with CPA before relying on it.
8. **Mezzo:** not yet formed/registered. Expense-bucket only until a formation date/state is recorded.
9. **Savings (x3950):** app recommends the "pay ourselves first" amount after 2–3 months of linked data, from actual cash-flow surplus, for owner approval.
10. **$250/$15 minimum-balance rule: TD Bank accounts only.** JCSB x0626 has no such rule.
11. **JetBlue card is Barclays-issued** — same login as the other Barclays card.
12. **Property values:** owner will supply approximate values for 27 Old Barry Rd and 56 Arbor Rd (editable fields; numbers still pending).
13. **Loan balances (PennyMac, solar):** pull via Plaid Liabilities where supported; otherwise prompt for manual entry at setup.
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

1. Approximate property values for 27 Old Barry Rd and 56 Arbor Rd (owner agreed to supply; numbers not yet given).
2. CPA confirmation of the October 15, 2026 extended deadline for the 2025 Schedule C filing.
3. The QuickBooks/CPA chart-of-accounts export file (needed before Phase 5 GL mapping).
4. Confirm the Auto Insurance budget line update to ~$217/mo, and whether Progressive gets its own line.
5. Approve (or adjust) the proposed Slush Funds transfer (~$277/wk default) and the app-recommended savings transfer when proposed.
6. Loan balances for PennyMac and the solar loan IF Plaid Liabilities doesn't cover them at link time.
