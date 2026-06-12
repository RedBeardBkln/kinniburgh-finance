# 02 — Personal Finances: Accounts, Envelope Rules, Budgets

## Envelope accounting method

The household uses envelope accounting: automatic transfers move money from the primary account into purpose-specific accounts, and bills autopay from those accounts. Large seasonal bills (e.g., heating oil) are accrued year-round so cold-month bills are absorbed.

**Hard rule:** all TD accounts must stay ≥ $250 at all times; dipping below at any point in a month triggers a $15 service fee. The app must forecast upcoming autopays/transfers per account and warn BEFORE a projected dip below $250 (see spec 05, Proactive Guidance).

## TD Bank checking accounts

### PRIMARY CHECKING (x2566)
- All spending not allocated to other accounts. Both debit cards connect here.
- Feeds all other accounts via scheduled transfers (below).
- Receives income: Eric's payroll (15th & 30th, 24/yr), Eva's paycheck (biweekly, 26/yr).

### CREDIT CARDS (x2631)
- All three credit cards (Capital One, Barclay, JetBlue) autopay from this account.
- Used less frequently; owner intends to step away from credit card use as much as possible. The app should support this goal (e.g., surface credit-card spend prominently; do not design flows that encourage card use).

### HEATING & ELECTRIC (x2540)
- Weekly transfer of **$256** from x2566. Budgeted components per source doc:

| Component | Autopay date | Monthly | Annual budget | Weekly transfer |
|---|---|---|---|---|
| McCarthy Heating & Oil (budget/accrued) | — | $333 | $4,000 | $76.92 |
| Eversource (budget) | 20th | $184 | $2,207 | $42.44 |
| Firewood (budget/accrued) | — | $83 | $1,000 | $19.23 |
| Solar loan — EnerBank/Regions | 20th | $506 | $6,069 | $116.71 |

  (Component weekly transfers sum to $255.30, not $256 — see spec 07. Implement the actual transfer as $256 and treat component lines as budget allocations.)

- **McCarthy Heating & Oil:** heating oil supplier. No oil bills in late spring/summer; funds accrue year-round for large cold-month bills.
- **Eversource + solar:** Eversource is the electric utility. A solar system (house + barn) eliminates the electric bill late spring → early fall; excess generation earns grid credits applied to future bills when generation drops. The forecast model must reflect this seasonality (low/zero Eversource bills in summer, credits drawn down in fall/winter).
- **Solar loan:** financed (not leased) through EnerBank, now part of Regions Bank; ~$500/month (budgeted at $506, autopay on the 20th).

### MORTGAGE & INSURANCE (x2558)
- One **$400 weekly** auto transfer from x2566 covering:

| Component | Monthly | Annual budget | Weekly transfer |
|---|---|---|---|
| Toyota payment (Eric's truck) | $420 | — | $105.00 |
| Northwestern Mutual | $755 | — | $190.00 |
| Amica car insurance | $206 | $2,474 | $95.15 |
| Progressive motorcycle insurance | — | $127 | $10.58 |

  (Component weekly amounts sum to $400.73 and use inconsistent conversion methods — see spec 07. Implement the actual transfer as $400.)

- **Owner-confirmed (June 2026):** Eva's Lexus payment ($250/week) is paid from x2566, NOT x2558 — only the Toyota ($420/mo) draws here. With that, x2558 outflows ≈ $6,096.58/mo (Toyota 420 + NWM 760 + Amica 206 + Progressive 10.58 + mortgage 4,700) vs. funding $6,433.33/mo ($400/wk + 2×$2,350) → ~$337/mo cushion. The `Car Payment` budget line of $1,500/mo = Lexus $250/wk ($1,083.33/mo avg) + Toyota $420/mo = $1,503.33; budget rounds to $1,500.
- **Auto insurance actuals are Amica $206/mo + Progressive $127/yr (~$10.58/mo) ≈ $217/mo combined** — owner confirmed these doc figures are current. The v2 budget line `Insurance / Auto Insurance` ($120) is stale and should be updated to ~$217 at seed time with user confirmation.

- **Semi-monthly automatic transfers of $2,350** pay the PennyMac mortgage (= $4,700/month, matching the `Utilities / Mortgage` budget line of $4,700). The household intentionally overpays to retire the mortgage in ~12 years; the app should track principal progress and payoff projection.

### SLUSH FUNDS (x3612)
- Dedicated to project savings. Drive the `projects` feature from this account (named project envelopes within the account balance).
- Carries $1,200/mo of budget in v2 (Home Improvements $400 + Home Repair $800) with no existing funding transfer. **Owner decision (June 2026):** at setup, the app should PROPOSE a recurring transfer (~$277/wk ≈ $1,200/mo) from x2566 for the owner's approval — do not create it automatically.

### THE COTTAGE (x8460)
- Receives transfers from JCSB (business) back to personal for reimbursement purposes. Model as cross-entity reimbursement transfers (never personal income).

## TD Bank savings

### SAVINGS (x3950)
- Household savings. Owner wants a recurring "pay ourselves first" amount to rebuild savings. **Owner decision (June 2026): the app should RECOMMEND the amount** — after 2–3 months of linked transaction data, propose an affordable recurring transfer derived from actual cash-flow surplus, for owner approval. Build: configurable recurring transfer + savings growth tracking + the recommendation engine.

## Retirement accounts

- **Betterment IRA** — track balance/contributions (Plaid investment support if available; else manual).
- **Northwestern Mutual life insurance** — premium $755/month (from x2558 table). Policy paperwork stored and analyzed under the documents/insurance feature (spec 05). Whole-life policies can carry cash value relevant to retirement planning — surface policy data, but present analysis as informational, not advice.

## Credit cards

Capital One, Barclay, JetBlue — all autopay from TD x2631. **Owner-confirmed (June 2026): the JetBlue card is Barclays-issued** — both Barclays cards link through the same Barclays US login.

## Tags (seed: `data/tags 2026.csv`)

- Hierarchical, path-named (e.g., `Transportation / Auto Expenses / Gas`), up to 4 levels deep.
- Personal only today. Business tag sets are a build requirement but their content must come from the user — do not invent business tags beyond a starter GL chart (spec 01).
- Import the file verbatim, including quirks (lowercase `memberships / Apple`, stray `Utility/Internet` root tag, `ATM Withdrawl` spelling) — list them for one-click cleanup with user approval (spec 07).
- Vehicle-level tags exist for: Kawasaki Vulcan Drifter 2001, Lexus NX 350h 2022, MG Midget 1974, Toyota Tacoma 1999.

## Budgets (seed: `data/budgets 2026 v2 (with accounts).csv`)

- Monthly, per tag, per account. Total budget: **$16,489/mo across 53 line items** — verify programmatically at import; do not hardcode. Owner says amounts are starting points subject to update.
- Account mapping (owner-confirmed): x2566 $5,694 · x2558 $7,080 · x2540 $1,066 · x3612 $1,200 · x0626 $1,399 (business) · `Business Ventures` $50 → x2566.
- **Arbor Retreat lines (x0626) belong to the Sudden Valley PM LLC entity from day one** (owner decision, June 2026) — not personal.
- Rollover support remains a feature requirement; opening rollover balances may be imported from the v1 file's Rollover column (e.g., Oil +495.45, Eversource −1147.09; negative = overspend carried forward, show clearly) with user confirmation.
- Known funding-vs-budget variances to surface (not errors): x2540 budget $1,066 vs $1,109.33 funding (+$43.33 cushion); x2540 line amounts run slightly below the doc's accrual table (Electric 172 vs 184, Oil 308 vs 333, Firewood 80 vs 83) — reconcile against actual bills once linked.

## Forecasting requirements

- Project per-account cash flow using: scheduled transfers, scheduled bills (with seasonality for Eversource/solar and McCarthy oil), income cadence (15th/30th + biweekly), and historical actuals.
- Flag any projected sub-$250 day on any TD account.
- Net worth view: assets (accounts, properties, solar system, vehicles if user adds) minus liabilities (PennyMac mortgage, solar loan, card balances). Property values must be user-entered or user-approved estimates — never invented. **Owner will supply approximate values for both properties** (editable fields; values pending — see spec 07). Loan balances: **pull via Plaid Liabilities where supported; prompt for manual entry at setup where not** (owner decision, June 2026).
