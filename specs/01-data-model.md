# 01 — Data Model

PostgreSQL. Money as `NUMERIC(14,2)` (or integer cents). All tables get `id` (uuid), `created_at`, `updated_at`. Soft-delete (`archived_at`) on anything tax-relevant.

## Core entities

### users
Eric and Eva. Fields: name, email, role (`owner`), notification preferences (push/email, per-category).

### entities (buckets)
Seed exactly four:

| name | type | notes |
|---|---|---|
| Personal | personal | household |
| Sudden Valley Property Management, LLC | business | founded Feb 2026; revenue-generating (Airbnb) |
| Eric Kinniburgh Consulting, LLC | business | dba LaunchTime Solutions; in business since 2021; no revenue yet in 2026 |
| Mezzo | business | new entity being built; expense tracking only; revenue unlikely this year |

Fields: name, dba_name, type, founded_date (only Feb 2026 for Sudden Valley is documented — leave others null until user supplies), tax_status_notes.

### institutions
Seed: TD Bank, Jewett City Savings Bank (JCSB), Capital One, Barclays, PennyMac, QuickBooks Checking (Green Dot Bank underlies QuickBooks Checking — verify in Plaid at build time), Betterment, Northwestern Mutual, Regions Bank/EnerBank (solar loan; EnerBank USA was acquired by Regions Bank in 2021 — source doc uses both names for the same lender).

### accounts
Fields: institution_id, entity_id, nickname, mask (last 4), account_type (checking | savings | credit_card | mortgage | loan | investment | insurance), minimum_balance, minimum_balance_fee, integration_mode (plaid | manual_import | manual_entry), currency (USD).

Seed list (see spec 02 and 03 for full behavioral detail):

| nickname | institution | mask | type | entity | min balance |
|---|---|---|---|---|---|
| Primary Checking | TD Bank | 2566 | checking | Personal | $250 |
| Credit Cards | TD Bank | 2631 | checking | Personal | $250 |
| Heating & Electric | TD Bank | 2540 | checking | Personal | $250 |
| Mortgage & Insurance | TD Bank | 2558 | checking | Personal | $250 |
| Slush Funds | TD Bank | 3612 | checking | Personal | $250 |
| The Cottage | TD Bank | 8460 | checking | Personal | $250 |
| Savings | TD Bank | 3950 | savings | Personal | $250 |
| Capital One card | Capital One | — | credit_card | Personal | — |
| Barclay card | Barclays | — | credit_card | Personal | — |
| JetBlue card | Barclays (owner-confirmed) | — | credit_card | Personal | — |
| PennyMac mortgage | PennyMac | — | mortgage | Personal | — |
| Solar loan | Regions/EnerBank | — | loan | Personal | — |
| Betterment IRA | Betterment | — | investment | Personal | — |
| NWM life insurance | Northwestern Mutual | — | insurance | Personal | — |
| JCSB operating | Jewett City Savings Bank | 0626 | checking | Sudden Valley PM LLC | — |
| QuickBooks Checking | QuickBooks/Green Dot | 2043 | checking | Eric Kinniburgh Consulting LLC | — |

The $250 minimum / $15 fee rule applies to the **TD Bank accounts only** (owner-confirmed June 2026 — JCSB has no such rule): "All accounts must have a minimum of $250 balance at all times, otherwise a $15 service fee will be applied if the account balance dips below that threshold at any point during the month." Users must be able to add new accounts at any time.

### transactions
Fields: account_id, entity_id, posted_at, amount (signed; negative = outflow), payee_raw, payee_normalized, description, source (plaid | import | manual | receipt), plaid_transaction_id (nullable, unique), pending (bool), transfer_pair_id (nullable — links the two legs of an internal transfer), receipt_id (nullable).

### tags
Hierarchical (self-referencing parent_id), per the real seed file `data/tags 2026.csv` (path-style names like `Food & Drink / Groceries`). Personal tags only exist today; business tag sets must be creatable later. Many-to-many with transactions (`transaction_tags`). Tag auto-assignment rules live in `tag_rules` (matcher on payee/amount/account → tag ids), learned from user behavior (see spec 05).

### budgets
Per tag, per period (monthly), per entity, with an account mapping. Fields: tag_id, entity_id, account_id (which account the spend draws from), period (YYYY-MM), budgeted, rollover_enabled, rollover_amount. Seed from `data/budgets 2026 v2 (with accounts).csv` (columns: NAME, Budgeted, Account = last-4 mask; blank Account on the `Business Ventures` row → map to x2566 per owner decision). Owner has stated budgeted amounts are starting points and may need updating. Lines mapped to x0626 belong to the Sudden Valley PM LLC entity from day one; all others are Personal. The v1 file (`budgets 2026.csv`) is historical reference only — its Rollover column holds real prior balances (e.g., Oil +495.45, Eversource −1147.09) that may be imported as opening rollover balances with user confirmation, but its other computed columns are unreliable (spec 07).

### scheduled_transfers
Models the envelope automation. Fields: from_account_id, to_account_id, amount, cadence (weekly | semi_monthly | monthly), day rules, purpose, active. Seeds in spec 02.

### scheduled_bills
Fields: account_id (paying account), payee, amount_type (static | fluctuating | accrued), expected_amount, autopay_day, annual_budget, entity_id. Seeds in specs 02–03.

### accrual_envelopes
For bills accrued over the year (McCarthy oil, firewood, property taxes, etc.): target annual amount, funding transfer link, current accrued balance, expected draw months.

### receipts
Fields: uploaded_by, file (object storage key), captured_at, ocr_status, vendor, receipt_date, total, description, gl_code, entity_id, linked transaction_id (nullable). See spec 05.

### gl_codes
Simple chart of accounts per business entity for GAAP-style classification (source doc says "GAP" — read as GAAP). Fields: entity_id, code, name, type (asset | liability | equity | income | expense). **Owner decision (June 2026): the chart will be IMPORTED from the CPA/QuickBooks** — build a QuickBooks chart-of-accounts import flow (CSV/IIF export). Until the import is supplied, receipts hold a freeform classification that maps onto the chart after import.

### documents
Tax filings (current + historical), life insurance policies, statements, extension confirmations. Fields: entity_id, tax_year (nullable), doc_type, file, metadata (jsonb), notes. Full-text searchable.

### projects
Personal project budgets funded from Slush Funds (x3612): name, target_amount, saved_amount, target_date, status, linked transactions.

### goals / forecasts
Retirement planning inputs (balances from Betterment IRA + NWM), savings goals (user wants "a payment amount to ourselves" into Savings x3950 — amount TBD, see spec 07), cash-flow forecast outputs (computed, cacheable).

### notifications
Fields: user_id(s), type (overspend | low_balance | accrual_shortfall | bill_due | anomaly), payload, sent_at, read_at, channel (push | email | in_app).

## Integrity rules

- A transfer between two internal accounts creates two linked transaction rows; reports must not double-count them (tag legs `Transfer In` / `Transfer Out` — these tags exist in the seed file).
- Reimbursement flow: JCSB x0626 → The Cottage x8460 (personal) is a cross-entity transfer; record it as reimbursement, not income.
- Changing a transaction's entity or tags writes an audit row.
