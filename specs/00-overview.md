# 00 — Overview

## Purpose

A platform to manage the household's personal and business finances. It must:

- Proactively budget (envelope method)
- Analyze spend
- Forecast spending vs. income
- Plan and budget for projects
- Plan for retirement
- Organize ongoing financial information for tax filing
- Prepare tax filing documents (drafts for CPA review)
- House previous tax filing documents
- Store, review, analyze, and advise on life insurance policy paperwork

## Users

- **Eric Kinniburgh (Eric)** — primary user; email eric.kinniburgh@alpbio.com
- **Eva-Laura Ramirez-Wisiackas (Eva)** — second user, full household visibility

Note: tags reference a third person, "Pat Wisiackas" (tag `Pat Wisiackas`, `Medical & Health / Medical - Pat`). Pat is tracked in spending categories but is not described as a platform user. Do not create a login for Pat unless asked.

## Organizational buckets

Every transaction, budget, report, and document belongs to one of:

1. **Personal Finances** — bank accounts, credit cards, debt/equity/net worth, projects & budgets, forecasting
2. **Business Finances**
   - Sudden Valley Property Management, LLC — revenue, vendors, expenses
   - Eric Kinniburgh Consulting, LLC (dba LaunchTime Solutions) — revenue, customers, expenses
   - Mezzo — revenue (none expected this year), expenses
3. **Taxes** — personal and business (organized per entity per tax year)

The dashboard must toggle between these buckets.

## Properties

1. **27 Old Barry Rd, Quaker Hill, CT 06375** — primary residence. Mortgaged (PennyMac); the owners overpay monthly aiming to pay it off within ~12 years. Has a solar system on house and barn (loan detail in spec 02).
2. **56 Arbor Rd, Jewett City, CT 06351** — Airbnb rental property, a.k.a. "The Cottage," "Arbor Retreat," "The Camp." Owned free and clear, no mortgage. Operated under Sudden Valley Property Management, LLC.

## Income streams

- **Eric's payroll** — direct deposit on the 15th and 30th of each month (24 deposits/year)
- **Eva's paycheck** — direct deposit every other week (26 deposits/year)
- **Airbnb revenue** — Sudden Valley Property Management, LLC (deposited to Jewett City Savings Bank x0626)

## Success criteria

- Both users can see real-time account balances and categorized transactions without manual statement uploads (where integrations allow).
- Budget overspend triggers a push notification to one or both users.
- A balance-sheet and P&L can be produced for Sudden Valley Property Management LLC at any time, covering the period from its February 2026 founding forward (retroactive data entry supported).
- All tax-relevant documents for each entity and tax year are stored, searchable, and exportable as a package for a CPA.
- No account dips below its $250 minimum without a prior warning (see spec 02).
