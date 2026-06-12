# 05 — Features

## 1. Expense receipts

- Photo (mobile camera) or PDF upload → OCR/AI extraction → tracker fields: **date, vendor, expense description, classification tied to a GL code** (for GAAP-style accounting; source doc wrote "GAP" — interpret as GAAP), plus entity bucket.
- Extraction results are always shown for human confirmation before saving — never silently trust OCR.
- Receipt can auto-match to an existing bank transaction (same amount ± small window, nearby date, same entity) and attach to it; unmatched receipts stand alone (cash expenses).
- Receipts feed tag suggestions (one or multiple tags per expense, situation-dependent).

## 2. Mobile parity

- Web + mobile with seamless interaction. Build as a responsive **PWA** first (installable, camera access for receipts, web push), with the option of an Expo/React Native wrapper later if push reliability on iOS demands it.
- "Zero latency" is interpreted as: optimistic UI updates, local caching, sub-second perceived response. Literal zero latency is not technically achievable — be honest about this in the README.

## 3. Reporting

- **Personal:** spending by tag/period, budget vs. actual with rollover, income vs. spend forecast, net worth over time, project savings progress, savings goal progress.
- **Business (real-time + historical):** Balance Sheet, P&L, cash flow, vendor spend (Sudden Valley), customer revenue (consulting LLC), accrual envelope status.
- All reports exportable (CSV + PDF), filterable by entity, date range, tag, account.

## 4. Dashboard

- Interactive: trends, top spending habits, budget health, upcoming bills/transfers, account balances with minimum-balance margin.
- **Bucket toggle** across Personal / Sudden Valley / EK Consulting / Mezzo / Taxes — this is the doc's explicit top-level navigation model.
- Per-user views with shared household data.

## 5. Tag assignment (learning)

- Assign tags to transactions as they arrive. Rules are **remembered**: once a payee→tag mapping is confirmed, apply it automatically thereafter without re-prompting.
- Rule engine: match on normalized payee, amount patterns, account; user can edit/delete rules.
- Receipt parsing can apply one or multiple tags.
- New incoming transactions without a confident rule go to a review queue.

## 6. Proactive guidance

As data arrives, the app: tags → categorizes → applies spend against the predetermined budget → and pushes alerts to one or both users for:

- **Overspend** (or approaching threshold, e.g., 80%/100% of a tag budget — thresholds configurable)
- **Projected sub-$250 balance** on any TD account (avoids the $15 fee — this is explicitly to be avoided)
- **Accrual shortfall** (e.g., Heating & Electric envelope pacing below winter McCarthy needs)
- Bill reminders and unusual-transaction anomalies

Guidance is observational and data-driven ("Groceries is at $1,150 of $1,200 with 9 days left"), never investment/tax advice.

## 7. Life insurance module

- Store NWM policy paperwork; extract and track: policy type, face amount, premium ($755/mo documented), cash value over time (manual entry from statements).
- "Review/analyze/advise" = summarize policy terms, premium-vs-cash-value trends, and flag items to discuss with the advisor. No recommendations to buy/sell/replace coverage.

## 8. Suggested additional features (doc invites these — implement as judged useful, clearly marked optional)

1. **Mortgage payoff simulator** — overpayment scenarios vs. the ~12-year goal (PennyMac data).
2. **Solar ROI tracker** — loan cost vs. Eversource savings + grid credits, using actual bills.
3. **Savings autopilot** — the requested "pay ourselves first" recurring transfer to x3950 with goal tracking.
4. **Debt-free countdown** — supports the stated goal of stepping away from credit cards.
5. **Airbnb seasonality view** — revenue by month for Sudden Valley once history accumulates.
6. **CPA portal/export** — read-only share link or bundle export per entity/tax year.
7. **Mileage log** (business deduction support) — manual or phone-based entry.
8. **Document expiry reminders** — insurance renewals (Amica $167.90/mo home, $206/mo auto; Progressive $127/yr motorcycle).
9. **Shared approval flow** — large/unusual spend pings the other partner (opt-in).
10. **Monthly household financial review** — auto-generated summary email/page for Eric + Eva.
