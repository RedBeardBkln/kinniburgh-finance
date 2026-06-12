# 03 — Business Finances & Taxes

## Entity 1: Sudden Valley Property Management, LLC

- Founded **February 2026**. Generating revenue now.
- a.k.a. Arbor Retreat / The Cottage / The Camp (property: 56 Arbor Rd, Jewett City, CT 06351 — owned free and clear).
- **Revenue:** entirely Airbnb at this time.
- **Bank:** Jewett City Savings Bank (JCSB) x0626. Connected to personal TD "The Cottage" (x8460) for reimbursement transfers.
- **Autopay bills from JCSB x0626:**

| Payee | Behavior | Amount |
|---|---|---|
| Comcast | Static, monthly | $65.95 |
| Eversource | Fluctuates monthly | ~$83 |
| Property taxes | Accrued | $281.67/mo |
| Amica home insurance | Static, monthly | $167.90 |
| McCarthy Oil | Accrued | $239/mo |

- **Tax requirement:** first filing due **Q1 2027**. All documentation must be tracked retroactively to the Feb 2026 founding AND forward. Build a retroactive-entry workflow: import JCSB and Airbnb history, categorize, attach receipts, and produce a complete 2026 books package (P&L, balance sheet, expense detail with receipts) exportable for a CPA.
- **Budget lines (owner-confirmed, June 2026):** the eight `Arbor Retreat / *` budget lines in `data/budgets 2026 v2 (with accounts).csv` map to JCSB x0626 and belong to THIS entity from day one ($1,399/mo total). The `Arbor Retreat / *` tags remain available for personal-bucket history; support reclassifying historical personal transactions into this entity with an audit trail.
- Budget-vs-autopay variances to reconcile against actual bills (budget values are owner's starting points): Property Taxes budget $275 vs accrual $281.67/mo; Electricity budget $100 vs ~$83 fluctuating. Insurance ($168 vs $167.90), Internet ($66 vs $65.95), and Oil ($240 vs $239) match within rounding.

## Entity 2: Eric Kinniburgh Consulting, LLC (dba LaunchTime Solutions)

- In business since **2021**.
- **Bank:** QuickBooks Checking (x2043).
- **No revenue yet in 2026.** Tracks revenue, customers, expenses when active.
- **Tax classification (owner-confirmed, June 2026): single-member LLC, disregarded entity — reported on Schedule C of Eric's personal Form 1040.**
- **Tax status:** 2025 tax year NOT yet filed — former CPA went AWOL. An extension has been **filed and accepted by the IRS**. Because this is a Schedule C business, the extension is the personal-return extension; the standard extended deadline for tax year 2025 is **October 15, 2026** (have the user confirm this date with their CPA before relying on it). The app must:
  - Track the extension and the extended filing deadline as a first-class tax task with escalating reminders.
  - Provide a checklist + document collection workspace for assembling the late 2025 filing.

## Entity 3: Mezzo

- **Owner-confirmed (June 2026): not yet formed/registered** — no legal entity exists yet.
- Track expenses now (receipts + manual entry) for later filing or reimbursement once formed. Revenue unlikely this year.
- Minimal setup: expense capture only; no revenue tooling, no tax workspace until formation. When the user records a formation date/state, upgrade it to a full entity.

## Other ventures referenced in tags

The tag tree contains `Business Ventures / Eric / GingerBreadMan`, `Business Ventures / Eric / MowTown Records`, `Business Ventures / Eva / Great Dame`, and `Business Ventures / Legal / Frank Kwok`. These are tags only — they are NOT documented as legal entities. Keep them as personal-bucket tags unless the user says otherwise.

## Taxes module (personal + business)

Per entity, per tax year:

1. **Ongoing organization** — every transaction/receipt carries entity + tag + (for business) GL code, so a tax package can be generated at any time.
2. **Document vault** — prior filings, W-2s/1099s, K-1s, extension confirmations, property tax bills, mortgage interest (1098), solar loan statements, Airbnb annual earnings summaries. Upload, OCR-index, search, never hard-delete.
3. **Prep workspace** — per-year checklist (user/CPA-defined items), draft summaries (income by source, deductible expense rollups, mileage if tracked), export bundle (PDF + CSV) for the CPA. The app drafts and organizes; it does not give tax advice or e-file.
4. **Calendar** — quarterly estimated-tax reminders (user-configured amounts), entity filing deadlines, the 2025 EKC extension deadline, Sudden Valley's Q1 2027 first filing.

## Reporting requirements (business)

- Real-time and historical: **Balance Sheet** and **P&L** per entity, plus cash flow, A/R-style customer tracking for the consulting LLC, vendor spend report for Sudden Valley.
- Period comparison (MoM, YoY once data exists), accrual envelope status (property taxes, McCarthy oil), and occupancy-agnostic Airbnb revenue tracking (revenue data from JCSB deposits and/or Airbnb statements — do not estimate occupancy).
