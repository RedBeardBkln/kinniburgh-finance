# Plan: upcoming-ledger (forecast enhancement, step 1: "bill surprises")

Planner output. Nothing here is implemented. Every live-data statement below comes from read-only queries run 2026-10-08 (temporary script, deleted afterward, no writes); every code statement comes from files I read this session.

## 1. Restated goal

Build one pure, tested function that merges every dated expected outflow/inflow (bills, budget schedules, recurring expenses, accrual draws, card statement due dates, envelope transfers, paychecks, Airbnb payouts, projected revenue, tax deadlines, policy expiries) into a single de-duplicated, bucket-scoped list, then show it as a "Next 30 days" card on the dashboard and a 30/60/90-day agenda on `/forecast`. No schema change, no change to the existing cash-flow engine, `lib/business-forecast.ts`, or notifications.

## 2. Verified current state (code and live data)

### 2.1 Code facts (read this session)

- `lib/forecast.ts` exports `generateTransferOccurrences`, `generateIncomeOccurrences`, `generateBillOccurrences(bill, from, to, draws)`, `generateCardStatementPayment`, `perOccurrenceAmount`. All use `[from, to)` and UTC-midnight dates; `allMonthDays`/`allWeekdays`/`allBiweekly` are private. Reuse only; do not re-implement date math.
- **Silent-drop behavior of `generateBillOccurrences` (must be handled, the request forbids silent drops):** returns `[]` when `expectedAmount` is null/0 (non-accrued), when `annualBudget` is null/0 (accrued without draws, lump-sum), or when a lump-sum bill lacks `payMonth`/`autopayDay`. It **defaults a missing `autopayDay` to the 1st**, a missing weekly `payDayOfWeek` to Monday, and a missing biweekly anchor to `from`. When an accrued bill has draws it returns only draw dates (no monthly spread), even if none fall in the window.
- `generateCardStatementPayment` returns `[]` for null/zero/negative `ccStatementBalance` (silent drop for null).
- `lib/annual-bill.ts`: `isLumpSumFrequency`, `dueMonthsFor`, `cycleMonthsFor` (annual = 12, semiannual = 6; **no quarterly**), `annualDueDate` clamps the day to the month length.
- `lib/recurring-expenses.ts` already has `monthlyEquivalentCents(amountCents, frequency)` (monthly/weekly/biweekly/quarterly/annually) and the `/budgets` page uses it as an override (`app/budgets/page.tsx` lines 63-115: a tagged RecurringExpense replaces the Budget amount with its monthly sum plus `additionalAmountCents`). `/forecast` only lists recurring expenses; `/` (dashboard) ignores them. Nothing projects from them.
- `Budget` is **per period** (`@@unique([tagId, entityId, period])`); `ScheduledBill` is **one row per (budgetTagId, budgetEntityId)** and `actions/budgets.ts#upsertBudgetBill` overwrites it from whichever period was saved last (no period in the key). That mismatch is the source of live discrepancies (2.2).
- `Document` has **no expiry field**. The only expiry date in the schema is `InsurancePolicy.expiryDate` (`checkDocumentExpiry` reads only that).
- `checkBillReminders` looks 3 days (per-user `daysAhead`) at `ScheduledBill` only via `generateBillOccurrences`; it is not touched.
- `app/page.tsx` is `auth()`-gated, reads `searchParams.bucket` and `period`, `entity = getEntityBySlug(bucket)` (null for `taxes`, `projects`, and any unknown slug), and renders inside `DashboardClient` (children are server-rendered). A past `?period=` view exists.
- `app/forecast/page.tsx` takes only `?bucket=`, computes `forecastStart` as the **UTC** calendar date, and its Personal engine only uses checking accounts with `minimumBalance`, only `ScheduledBill` rows with `budgetTagId != null`. The 14-day card and per-account charts are untouched by this task.
- Dates: `ccDueDate`, `RentalBooking.payoutDate`, `AccrualDraw.estimatedDate` are stored at `00:00Z`; `TaxDeadline.dueDate` at 04:00Z/05:00Z (ET midnight). Formatting any of them with `timeZone: "UTC"` shows the right calendar date. **Pre-existing bug, not to be fixed here:** the Credit Card Funding table on `/forecast` formats `ccDueDate` with `America/New_York`, which shows Oct 12 as Oct 11.
- Repo precedent for what I plan: pure module + `renderToStaticMarkup` render tests exist (`lib/__tests__/advisor-ui-render.test.tsx` sets `globalThis.React`); presentational server components with server-computed plain data (`components/forecast/spend-pace-section.tsx`); DB-aware but auth-free "build" modules (`lib/monthly-review-build.ts`, `lib/tax2025-build.ts`) whose callers do `auth()` first. `vitest.config.ts` is `environment: "node"`, so no DOM tests.

### 2.2 Live data, 2026-10-08 (read-only)

**ScheduledBill: 20 rows, 17 active, 3 inactive.**
- The three untagged duplicate pairs found earlier are **already resolved**: `Eversource` (untagged), `PennyMac - Mortgage`, `Regions/EnerBank - Solar loan` are `active: false`; their tagged twins (`Electric (Eversource)` $172 day 20, `Mortgage` $4,700 day 1, `Solar` $505.70 day 17) are active. Personal has 11 active bills, all tagged.
- **Remaining untagged active bills: 5, all Sudden Valley** (`Amica - Home insurance (Arbor Retreat)` $167.90, `Comcast` $65.95, `Eversource (Arbor Retreat)` $83 fluctuating, `McCarthy Oil (Arbor Retreat)` accrued $2,868/yr no envelope, `Property taxes - 56 Arbor Rd` accrued $3,380.04/yr, envelope with 0 draws). **All five have `autopayDay = null`.** None duplicates anything today (SV Budget lines have no pay day, so they produce no ledger items). SV's only tagged bill is `Reimbursement` $350 day 24.
- Personal `Lexus Financial` ($250 monthly) is tagged but **has `autopayDay = null`**; today's cash-flow charts silently assume the 1st for it.
- Accrued bills with draws: Firewood (4 draws: 2026-12-14 $315, 2027-01-25, 2027-03-08, 2027-04-19), McCarthy Oil (2026-10-02 $2,000 already past, 2026-12-16, 2027-02-08, 2027-03-25). All 3 `AccrualEnvelope` rows are linked to a bill; no orphan envelopes.
- Doggy Daycare is weekly (Wednesday, `payDayOfWeek = 3`), monthly figure $310.56 (= $71.67 per week).
- Lump-sum: Amica semiannual (June + December, day 4, $1,182 each), Progressive annual (Feb 26, $127).

**Budget rows.** Personal has rows for 2026-01 to 2026-12; Sudden Valley 2026-01 to 2026-12; EK Consulting **only 2026-09**. **No row exists for any period in 2027**, so the 90-day window (to 2027-01-06) crosses into a month with no Budget data. In 2026-10: 56 rows; **8 have a schedule** (pay day or non-monthly frequency); **all 8 have an active tagged bill with the same key**, so the number of "Budget schedule with no bill" orphans today is **0**. The other 48 rows have amounts but no date (groceries and similar categories) and cannot be dated.

**RecurringExpense: 1 row.** `Eversource`, monthly, $200.00, dueDay 20, `nextDueDate = 2026-07-20` (stale, in the past), tagged `Utilities / Electric (Eversource)`. The same real bill therefore exists three times: bill $172 day 20, Budget $172 day 20, recurring $200 day 20. This is the live proof of the three-way overlap and of a three-way amount disagreement.

**Budget-vs-bill disagreements that exist right now (inside the 90-day window):**

| Item | ScheduledBill | Budget (month) | Note |
|---|---|---|---|
| Toyota (Tacoma) | $420 day 30 | Oct $420, **Nov $1,500, Dec $1,500** | amount differs in Nov/Dec only |
| Doggy Daycare | $310.56/mo weekly | **Oct-Dec $268** (Sep was $310.56) | amount differs |
| Solar | $505.70 day **17** | $506 day **14** | day differs, amount within $1 |
| Eversource | $172 day 20 | $172 day 20, recurring **$200** | recurring differs |
| Motorcycle ins. | $11 (stored), Feb 26 | Oct $11, Nov/Dec $10.58 | outside window, not visible |

**Other sources:**
- IncomeSource: Eric semi-monthly `[15, 31]` $9,000; Eva biweekly anchor 2026-08-28 $2,555 (both into Primary Checking).
- ScheduledTransfer: 4 active, all Personal Primary Checking to Personal envelope accounts: $256 weekly Mon, $400 weekly Mon, $2,350 on the 1st and 15th, $150 weekly Fri. That is about 40 rows in 90 days, all internal.
- Credit cards: jetBlue due 2026-10-12 $51.26; Barclay due 2026-10-05 $623.19 (**3 days past due date, stale or unpaid unknown**); Capital One (EK Consulting) due 2026-10-12 $792.68.
- TaxDeadline: five rows; Q2 (2026-06-16) and Q3 (2026-09-15) estimated-tax rows are **still `upcoming` although past** (stale status); EKC "2025 Schedule C - extended filing" 2026-10-15 (in window); Q4 est 2027-01-15 and SV Schedule E 2027-04-15 are beyond 90 days.
- InsurancePolicy: two Northwestern Mutual rows, **both `expiryDate = null`**, `monthlyPremiumCents = null` (the $760 NWM outflow lives only on a ScheduledBill, so the premium column must NOT be used as an outflow source).
- RentalBooking (Sudden Valley only): 19 total, 2 future payouts (2026-10-19 $1,075; 2027-06-10). `grossEarnings` is used as the payout amount by `business-forecast.ts` too.
- ProjectedRevenue unrealized: 0 rows.

## 3. Scope

**In scope**
- `lib/upcoming-ledger.ts` (pure builder), `lib/upcoming-ledger-view.ts` (pure grouping/format/link helpers), `lib/upcoming-ledger-build.ts` (read-only loader), two presentational components, wiring in `app/page.tsx` and `app/forecast/page.tsx`, tests, one paragraph in `CLAUDE.md`.
- Read-only. No `requireAuth` needed inside the loader (it is a build module like `lib/monthly-review-build.ts`); both pages already `auth()` and redirect before they call it.

**Out of scope (do not touch)**
- `lib/forecast.ts`, `lib/annual-bill.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/recurring-expenses.ts`, `prisma/schema.prisma`, any migration, any server action, `/budgets`.
- Fixing the pre-existing issues listed in section 9 (day-31 skipping, `ccDueDate` timezone on the funding table, Budget-vs-bill drift, tagging Sudden Valley bills, stale TaxDeadline statuses). They are surfaced, not fixed.
- Learned/history-based items (tier type exists, never populated), reminder consolidation, variable-spend modelling.
- Advisor tool (decision in section 11: defer).

## 4. Source decisions

| Source | Kept? | Item date from | Amount | Tier | Entity | Notes |
|---|---|---|---|---|---|---|
| ScheduledBill (active) | yes | `generateBillOccurrences` (draws passed for accrued) | per occurrence; lump = full amount due | `scheduled`; `estimated` if `amountType` is `fluctuating`, or accrued (draw dates are estimates, or monthly spread) | `bill.entityId` | highest precedence for dedupe |
| Budget line | yes, **orphans only** | build a bill-shaped object from the row, call `generateBillOccurrences`, keep only dates inside the row's own `period` month | `budgeted` (monthly) per frequency; lump = `annualAmountDue` | `scheduled` | `budget.entityId` | live orphan count = 0 today; kept as the safety net for a line whose bill was deactivated. Rows without `payDay`/non-monthly frequency never produce items. |
| RecurringExpense | yes | monthly: `dueDay`; weekly/biweekly: weekday and anchor from `nextDueDate`; annually: month/day of `nextDueDate`; quarterly: two semiannual bill-shapes offset by 3 months. All dates come from `generateBillOccurrences`. | `amountCents/100` per occurrence (convert to the generator's monthly-total convention, round each event to cents) | `scheduled`; `nextDueDate` in the past adds a note, never a past-dated item | `entityId` | lowest precedence |
| AccrualDraw | yes, via bill; **orphan-envelope draws as standalone** | `estimatedDate` | `estimatedAmount` | `estimated` | account entity | live: all envelopes linked, orphan path only unit-tested |
| Card statement due | yes | `ccDueDate` | `ccStatementBalance`; null balance = amount unknown; zero/negative = no item | `scheduled` | card account entity | also feeds `pastDue` (section 5.5) |
| ScheduledTransfer (outgoing) | yes, `kind: "transfer"` | `generateTransferOccurrences` (keep the `transfer_out` leg only) | negative | `scheduled` | `fromAccount.entityId` | **not counted in totals** (internal funding of the envelope accounts that then pay the bills; counting both double-counts household outflow). Hidden by default in UI. |
| IncomeSource | yes | `generateIncomeOccurrences` | positive | `scheduled` | `entityId` | inherits the day-31 gap (section 9) |
| RentalBooking | yes | `payoutDate` in window | `grossEarnings`, label says "gross" | `scheduled` | `entityId` | Airbnb host fees not modelled; matches `business-forecast.ts` |
| ProjectedRevenue (unrealized, unarchived) | yes | `expectedDate` in window; earlier ones go to `pastDue` | `amountCents/100` | `estimated` | `entityId` | live: 0 rows |
| TaxDeadline | yes | `dueDate` in window, `status = upcoming`, `archivedAt = null` | none (`amountStatus: "not_applicable"`) | `scheduled` | `entityId` | past-dated rows are ignored, **not** shown as overdue (stale statuses live) |
| Policy expiry | yes (cheap, trustworthy, currently empty) | `InsurancePolicy.expiryDate` in window, unarchived | none | `scheduled` | `entityId` | `monthlyPremiumCents` deliberately NOT used |
| Document expiry | **dropped** | n/a | n/a | n/a | n/a | `Document` has no expiry field; nothing trustworthy to read |

Dropped/limited sources are stated above; none of the request's other sources is dropped.

## 5. Design

### 5.1 `UpcomingItem` and result types (all in `lib/upcoming-ledger.ts`, Decimal from `@prisma/client/runtime/library`)

```ts
export type UpcomingSource =
  | "scheduled_bill" | "budget_line" | "recurring_expense" | "accrual_draw"
  | "card_statement" | "scheduled_transfer" | "income_source" | "rental_payout"
  | "projected_revenue" | "tax_deadline" | "policy_expiry";

export type ConfidenceTier = "scheduled" | "estimated" | "learned"; // "learned" reserved for step 2; defined, NEVER populated
export type ItemKind = "bill" | "card" | "transfer" | "income" | "deadline";
export type AmountStatus = "known" | "unknown" | "not_applicable";

export interface LinkTarget {
  page: "budgets" | "forecast" | "envelope" | "accounts" | "revenue" | "tax" | "vault";
  period?: string;   // "YYYY-MM" for /budgets
  anchor?: string;   // e.g. "rental-bookings"
}

export interface AlternateRecord {     // a lower-precedence record of the SAME obligation
  source: UpcomingSource;
  sourceId: string;
  monthlyAmount: Decimal | null;       // monthly-equivalent, for comparison only
  day: number | null;                  // day of month if it has one
}

export type Discrepancy =
  | { kind: "monthly_amount"; otherSource: UpcomingSource; thisAmount: Decimal; otherAmount: Decimal }
  | { kind: "day"; otherSource: UpcomingSource; thisDay: number; otherDay: number };

export interface UpcomingItem {
  id: string;                   // `${source}:${sourceId}:${yyyy-mm-dd | "undated"}` , unique within a result
  date: Date | null;            // UTC midnight; null ONLY for items in `undated`
  amount: Decimal | null;       // signed, negative = outflow; null when amountStatus !== "known"
  amountStatus: AmountStatus;
  label: string;
  source: UpcomingSource;
  kind: ItemKind;
  tier: ConfidenceTier;
  tierNote?: string;            // plain reason shown next to "estimate" ("monthly set-aside, no due date on file")
  entityId: string;
  accountId?: string;
  sourceId: string;
  link: LinkTarget;
  alsoRecordedAs: AlternateRecord[];
  discrepancies: Discrepancy[];
  notes: string[];              // e.g. "Next due date on file is in the past"
}

export interface UpcomingLedger {
  from: Date; to: Date;                 // [from, to), UTC midnight
  items: UpcomingItem[];                // dated, inside the window, sorted (date, kind, label, id)
  undated: UpcomingItem[];              // real obligations whose day is not recorded
  pastDue: UpcomingItem[];              // card statements past due date within lookback + overdue unrealized ProjectedRevenue
  heldBack: UpcomingItem[];             // suspected untagged duplicates, NOT counted (reason in notes)
  totals: LedgerTotals;                 // overall
  totalsByEntity: Record<string, LedgerTotals>;
  biggest: UpcomingItem | null;         // largest counted outflow, ties go to the earlier date
}
export interface LedgerTotals {
  outflow: Decimal;            // positive magnitude, counted kinds only: bill, card
  outflowEstimated: Decimal;   // the part of outflow that came from tier "estimated"
  inflow: Decimal;             // income kind
  inflowEstimated: Decimal;
  unknownAmountCount: number;  // items in `items` whose amountStatus is "unknown"
  transferCount: number; transferTotal: Decimal; // shown separately, never in outflow
}
```

Function signature (options object, same style as the repo): `buildUpcomingLedger(input: UpcomingLedgerInput): UpcomingLedger` where `UpcomingLedgerInput = { from: Date; days: number; entityId?: string | null; cardPastDueLookbackDays?: number; bills; budgets; recurring; orphanEnvelopes; cards; transfers; incomeSources; rentalBookings; projectedRevenue; taxDeadlines; policies }` (structural row types, not Prisma types, like `ScheduledBillLike`). Also export `todayForNewYork(now: Date): Date` (America/New_York calendar date as UTC midnight, via `Intl.DateTimeFormat`; so a 9 pm ET bill still shows as "today") and `CARD_PAST_DUE_LOOKBACK_DAYS = 14`.

### 5.2 Never fabricate amount or date

- **Unknown amount:** if the generator would drop the bill for a missing/zero amount, call it with a placeholder amount (`1`) purely to obtain the dates, then emit each event with `amount: null, amountStatus: "unknown"`. The item appears in the list and in `unknownAmountCount`; it is excluded from totals. Zero is treated as unknown (the generator already treats zero as "no bill"). Same trick for a card with `ccStatementBalance = null`.
- **Unknown date:** do NOT call the generator when the schedule is incomplete (monthly or accrued-spread with `autopayDay = null`; weekly with `payDayOfWeek = null`; biweekly with no anchor; annual/semiannual missing `payMonth` or `autopayDay`; recurring monthly with no `dueDay`; recurring non-monthly with no `nextDueDate`). Emit **one** item with `date: null` into `undated`, carrying the monthly amount (or lump amount) and `tierNote: "day not set"`. Today this affects Personal Lexus ($250) and all five Sudden Valley bills. This intentionally differs from the cash-flow charts, which silently use the 1st; the plan does not change them.

### 5.3 Source precedence and de-duplication (the central rule)

Applied per entity (never across entities; two entities can reuse a tag id and must not merge).

**Stage A, same budget category (exact key `entityId + tagId`).** Candidates: active `ScheduledBill` with `budgetTagId` (key uses `budgetEntityId ?? entityId`), `Budget` rows that carry a schedule, `RecurringExpense` with `tagId`. Rank: **1 ScheduledBill, 2 Budget schedule, 3 RecurringExpense.** Only the winner generates items. Losers become `alsoRecordedAs` on the winner. Why the bill wins: it is what the cash-flow charts and reminders already use, and `upsertBudgetBill` mirrors every Budget schedule into it, so the live Budget-only case is empty. Inactive bills are ignored entirely (then the Budget schedule, if any, becomes the winner for its own month).

**Stage B, discrepancy check (surface, never silently choose).** Compare winner vs each loser on **monthly-equivalent amount** (tolerance $1.00, so Solar $505.70 vs $506 is not flagged) and on **day of month** (when both have one). For a bill winner also compare against the Budget row for the **same month as the item's date** (Budget is per period; this is what flags Toyota in Nov/Dec but not Oct) and note when no row exists for that month (2027-01). Output one `Discrepancy` per mismatch on the winning item; UI shows "records disagree" with the other figure. Winner's amount is always the one shown. Monthly-equivalent for lump bills = payment x payments-per-year / 12; for recurring use `monthlyEquivalentCents`.

**Stage C, untagged records (no tag key to match on).** Candidates: untagged active `ScheduledBill`, untagged `RecurringExpense`, orphan-envelope draws. Compare each against every already-kept item of the **same entity**; a pair is "likely the same obligation" when either
1. the two names share at least one distinctive word (length >= 4, after lower-casing, stripping punctuation, and removing a stop-word list: `insurance, payment, financial, loan, auto, home, bill, service, services, company, monthly, annual, utilities, the, and, for`) AND the accounts match (or one side has no account), OR
2. monthly amounts are within the greater of $1 or 5%, the day of month is equal, AND accounts match (or one side has none).

On a match, the **untagged record loses**: it is moved to `heldBack` (not in `items`, not in totals), with a note naming the winner. Rationale for erring toward "held back, but visible": the failure it prevents is the double count the request calls the central risk, and nothing is lost because the record is shown in a "possible duplicates" disclosure. The untagged-vs-untagged case keeps the higher-ranked record (bill over recurring).

**Evidence the Stage C rule works on real pairs** (unit-test fixtures, using the three historical pairs even though they are now inactive): `Eversource` (untagged, acct Heating & Electric, $184 day 20) vs `Electric (Eversource)` ($172 day 20): word "eversource" shared, same account -> held back. `Regions/EnerBank - Solar loan` ($506 day 20) vs `Solar` ($505.70): word "solar" shared, same account -> held back. `PennyMac - Mortgage` ($4,700) vs `Mortgage` ($4,700 day 1): word "mortgage" shared, same account -> held back. **Negative controls that must NOT merge:** Amica auto vs Progressive motorcycle (same account; only shared word is the stop word "insurance"), Toyota Financial vs Lexus Financial (shared word "financial" is a stop word), Sudden Valley "Amica - Home insurance" vs Personal "Amica - Auto insurance" (different entity), and every one of today's 5 untagged Sudden Valley bills vs `Reimbursement`.

**Stage D, other sources have no overlap rules.** Income, rental, projected revenue, deadlines, expiries, transfers and card statements cannot duplicate a bill by construction (different tables, different meaning). A card statement and a hand-entered bill for the same card could in principle overlap; there is no live case, so it is listed under risks, not coded.

### 5.4 Totals

- `outflow` = sum of |amount| for counted `bill` and `card` items with known amounts. `inflow` = `income` kind. `transfer` and `deadline` kinds are never in either. `heldBack`, `undated`, `pastDue` are never in totals. `outflowEstimated`/`inflowEstimated` give the estimated part so the UI can say "~$X (of which ~$Y estimated)".
- `biggest` = largest counted known outflow in `items`.
- `totalsByEntity` for the aggregate view; **no blended total across entities is ever shown** (Taxes/Projects/unknown slug = `entity === null`).

### 5.5 Past due

Card statements with `ccDueDate` in `[from - 14 days, from)` and a positive balance go to `pastDue` ("past its due date; it may already be paid"). Reason: today (Oct 8) Barclay's $623.19 statement is 3 days past due, and a window that starts at "today" would silently drop exactly the kind of surprise this feature targets. Unrealized ProjectedRevenue dated before `from` goes to `pastDue` as an inflow. Stale `TaxDeadline` rows are NOT put here (live data shows Q2/Q3 still `upcoming`).

### 5.6 UI

**Dashboard widget `components/upcoming/upcoming-widget.tsx`** (presentational, no hooks). Placement: in `app/page.tsx`, directly under the 3 summary cards and above the Budget Lines card. Renders only when `isCurrentPeriod` (it is about today, not the browsed month).
- Header "Next 30 days" with the end date, and a "Full agenda" link to `/forecast?bucket=<slug>#upcoming`.
- Summary strip: "~$X due" (counted outflow), "~$Y expected in", "Biggest: <label> ~$Z on <date>". If estimated part > 0: "includes ~$E of estimates". If `unknownAmountCount > 0`: "N items have no amount set".
- Rows grouped by date (weekday + date heading), first 12 rows, then "+N more in the agenda". Each row: label (a link to the underlying `/budgets?bucket=&period=<month>`, `/forecast`, `/envelope`, `/accounts`, `/business/<slug>/revenue`, `/tax`, `/vault`), source label, an "estimate" badge for tier `estimated` with its `tierNote`, amount as "~$1,234.56" or "amount not set" in muted text, an inline "records disagree: budget says $X" note when `discrepancies` is non-empty.
- Collapsed disclosures (native `<details>`, no JS): "Day not set (N)" listing `undated` with monthly amounts; "Past due date, may already be paid (N)"; "Possible duplicates held back (N)". Transfers are summarized in one muted line ("N envelope transfers, $X, not counted") and are not listed in the widget.
- Aggregate view (entity null): rows carry an entity name chip and the strip shows one line per entity from `totalsByEntity`.
- Empty state: "Nothing due in the next 30 days." Error state (loader threw): a small muted "Upcoming items are unavailable right now." and nothing else; the rest of the dashboard is unaffected. The loader call is wrapped in `try/catch` and is NOT added to the page's existing `Promise.all`.
- Footer: "From your scheduled bills, budgets and statements. Estimates are marked. Not financial advice."
- Wording: "due", "expected", "~$". No "will", no "should", no investment language. Dates are formatted with `timeZone: "UTC"` on the stored calendar date (see 2.1); that is the America/New_York calendar date by construction.

**Forecast agenda `components/upcoming/upcoming-agenda.tsx`**, placed in `app/forecast/page.tsx` after the "Next 14 Days" card and before the spend-pace section (balance panel, breach warnings, charts and card-funding analysis are untouched), wrapped in `<div id="upcoming" className="scroll-mt-20">`.
- Horizon tabs 30 / 60 / 90 (default 90) as plain `Link`s with `?bucket=<slug>&horizon=N#upcoming` (server-rendered, no client component; keeps totals exact in Decimal; `Route` cast like the dashboard). A "Show envelope transfers" link toggles `&transfers=1`. Invalid values fall back to the defaults.
- Table grouped by week (Monday start): week heading with that week's counted outflow/inflow, then rows `Date | Item | Source | Confidence | Amount | Notes`. Same row semantics as the widget. Totals strip identical to the widget, plus `heldBack`, `undated`, `pastDue` disclosures expanded by default in the agenda.
- Business buckets show the same agenda (Sudden Valley / EK Consulting items only), which is new visibility, not a change to their charts.

### 5.7 Loader `lib/upcoming-ledger-build.ts`

`loadUpcomingLedger({ entityId: string | null, days, now })`: computes `from = todayForNewYork(now)`, runs one `Promise.all` of read-only Prisma queries with **explicit `select`s**, scoped by entity in the `where` when `entityId` is set, then calls `buildUpcomingLedger` and returns the ledger plus lookup maps (account nickname by id, entity name and slug by id) for the view layer. Queries: active `scheduledBill` (+ `accrualEnvelope.draws`); `budget` for the month periods touched by the window (all rows, needed for the per-month discrepancy check; ~50 rows per period); `recurringExpense`; `accrualEnvelope` with `scheduledBillId = null` (+ draws); credit-card `account` with `ccDueDate` not null and `archivedAt = null`; active `scheduledTransfer` (by `fromAccount.entityId`); active `incomeSource`; `rentalBooking` in window; `projectedRevenue` (`archivedAt` null, `realizedAt` null); `taxDeadline` (`archivedAt` null, `status = upcoming`); `insurancePolicy` (`archivedAt` null, `expiryDate` not null). No raw SQL. No writes. No `"use server"`.

## 6. Files

**New**
- `lib/upcoming-ledger.ts` (pure; imports only `Decimal`, `@/lib/forecast`, `@/lib/annual-bill`, `@/lib/recurring-expenses`; no `@/lib/db`, no Prisma client, no `"use server"`)
- `lib/upcoming-ledger-view.ts` (pure: group by date/week, week totals, `hrefFor(item, bucketSlug)`, date and money display strings, source and tier labels, truncation)
- `lib/upcoming-ledger-build.ts` (DB-aware, read-only, auth-free)
- `components/upcoming/upcoming-widget.tsx`
- `components/upcoming/upcoming-agenda.tsx`
- `lib/__tests__/upcoming-ledger.test.ts`
- `lib/__tests__/upcoming-ledger-view.test.ts`
- `lib/__tests__/upcoming-ledger-render.test.tsx` (`renderToStaticMarkup`, same precedent and `globalThis.React` line as `advisor-ui-render.test.tsx`)

**Modified**
- `app/page.tsx` (add widget under the summary cards; fail-soft)
- `app/forecast/page.tsx` (extend `searchParams` with `horizon`, `transfers`; add the section)
- `CLAUDE.md` (one short Architecture paragraph: what the ledger is, precedence rule, read-only, pure/build split)

**Must stay byte-identical:** `lib/forecast.ts`, `lib/annual-bill.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/recurring-expenses.ts`, `prisma/**`, `actions/**`.

## 7. Approach (ordered; each step has a "done" test)

1. **Types and helpers** in `lib/upcoming-ledger.ts`: the types above, `startOfDayUTC`, `todayForNewYork`, `monthlyEquivalent` helpers, `nameWords()` with stop words. Done: unit tests for `todayForNewYork` (2026-10-09T02:00Z gives 2026-10-08; 2026-10-08T14:00Z gives 2026-10-08) and `nameWords`.
2. **Bill expander** (`scheduled_bill`, incl. draws, lump sums, unknown-amount placeholder trick, undated gating, tier assignment). Done: tests for static monthly, fluctuating (estimated), accrued with draws (estimated, draw dates only, past draw excluded), accrued with no draws (spread, estimated), annual and semiannual, weekly and biweekly per-occurrence, null/zero amount, null day.
3. **Budget-orphan, recurring, orphan-envelope, card, transfer, income, rental, projected-revenue, tax-deadline, policy expanders.** Recurring quarterly via two semiannual shapes; weekly/biweekly recurring amount converted to the generator's monthly convention and rounded to cents (a $100 weekly recurring must emit exactly $100.00). Done: one positive test per source plus its exclusion cases.
4. **Dedupe stages A, B, C** and `alsoRecordedAs`/`discrepancies`/`heldBack`. Done: tests in section 8.2.
5. **Totals, `biggest`, sort, `totalsByEntity`, entity filter, `pastDue`.** Done: totals and scoping tests.
6. **`lib/upcoming-ledger-view.ts`** and its tests.
7. **Loader** `lib/upcoming-ledger-build.ts` (typecheck is the check; not unit tested, same as other build modules).
8. **Components**, then wire **dashboard**, then **forecast page**. Done: render tests plus manual smoke (section 10).
9. `CLAUDE.md` paragraph; `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `git diff --stat` shows none of the must-stay-identical files.

## 8. Tests

All in Vitest, node environment, `Decimal` money, local helpers `D()` and `d(iso)` like the other forecast tests. Fixtures mirror the live shapes (names, days, frequencies) so the dedupe tests are regression tests for the real data.

### 8.1 `upcoming-ledger.test.ts`, per source and mechanics
- Each source produces correctly signed, entity-scoped items: bill (monthly), budget orphan, recurring (monthly, weekly, biweekly, quarterly, annually), accrual draw (via bill and orphan envelope), card statement, transfer (only the outflow leg, `kind: "transfer"`), income (semi-monthly and biweekly anchor 2026-08-28), rental payout, projected revenue, tax deadline, policy expiry.
- Annual/semiannual: Amica-shaped (semiannual, payMonth 6, day 4, $1,182) yields Dec 4 only in a window of Oct 8 + 90 days; yields both Jun 4 and Dec 4 in a 12-month test window; Progressive-shaped annual (Feb 26) is absent from a 90-day window and present when the window includes it; a window crossing Dec to Jan yields a January annual item in the correct year; Feb 29/30 day clamps.
- Weekly/biweekly per-occurrence: Doggy-shaped weekly Wednesday monthly $310.56 yields $71.67 per Wednesday and the right count; biweekly bill honors its anchor; recurring weekly $100 yields exactly $100.00 per occurrence.
- Horizon boundaries: event on `from` included; event on `from + days` excluded; the same data at 30, 60, 90 days gives nested results; a draw dated before `from` (2026-10-02) excluded; TaxDeadline 2027-01-15 excluded at 90 days from 2026-10-08.
- Unknown amount: bill with null amount, zero amount, accrued with no `annualBudget`, card with null balance, Budget with null `budgeted`: each yields a dated item with `amount: null, amountStatus: "unknown"`, listed, counted in `unknownAmountCount`, excluded from totals, never 0. Card with zero balance yields no item.
- Undated: monthly with null day (Lexus-shaped and a Sudden Valley accrued spread), weekly with null weekday, biweekly with no anchor, annual with no `payMonth`, recurring monthly with no `dueDay`, recurring weekly with no `nextDueDate`: each appears once in `undated`, never in `items`, never on the 1st.
- Tax deadline: `filed`/`waived`/archived excluded; amountStatus `not_applicable`; past-dated `upcoming` row excluded and not in `pastDue`.
- Policy expiry with null `expiryDate` skipped; in-window expiry becomes a `deadline`-kind item with no amount.
- Tier: static bill `scheduled`; fluctuating, accrued draws, accrued spread, projected revenue `estimated`; no item ever has tier `learned`.
- Past due: Barclay-shaped card 3 days past due appears in `pastDue` and not in `items` or totals; 15 days past due is dropped; overdue unrealized ProjectedRevenue goes to `pastDue`.
- Ordering and ids: sorted by date then kind then label; ids unique; deterministic across two runs.
- Source scan: `lib/upcoming-ledger.ts` has no import of `@/lib/db`, `@prisma/client` (other than `@prisma/client/runtime/library`), `next/*`, and no `"use server"` (read the file as text, as other pinning tests do).

### 8.2 Dedupe and discrepancy
- Three-way Eversource fixture (bill $172 day 20 + Budget $172 day 20 + recurring $200 dueDay 20 with stale `nextDueDate` 2026-07-20): exactly one item per month, amount $172, `alsoRecordedAs` has both losers, one `monthly_amount` discrepancy ($200 vs $172), no `day` discrepancy, no past-dated item from the stale `nextDueDate`.
- Bill + Budget only, schedule identical: one item, `alsoRecordedAs` has the budget, `discrepancies` empty.
- Budget orphan: Budget schedule with no bill emits items only inside its own period month (a Nov row yields no Dec dates); a period with no row (2027-01) yields nothing; Budget plus an **inactive** bill with the same key emits from the Budget.
- Per-month discrepancy: Toyota-shaped (bill $420 day 30, Budget Oct $420, Nov $1,500, Dec $1,500): Oct item clean, Nov and Dec items flagged; Solar-shaped (bill day 17 $505.70, Budget day 14 $506): `day` discrepancy only (amount within $1); Doggy-shaped ($310.56 vs $268): `monthly_amount` discrepancy.
- Stage C positives (the three historical pairs, using the real payee strings and accounts): each untagged record lands in `heldBack`, the tagged record is the only one in `items`, totals count it once.
- Stage C negatives: Amica auto vs Progressive; Toyota vs Lexus; SV Amica home vs Personal Amica auto (different entity); SV untagged bills vs `Reimbursement`; none merge and all stay in `items`/`undated`.
- Same tag id in two entities does not merge.
- Untagged recurring expense duplicating a tagged bill by name goes to `heldBack`; one that matches nothing stays in `items`.
- Totals count the winner once: a fixture where all three sources exist sums to exactly one payment.

### 8.3 Scoping, totals
- `entityId` filter returns only that entity's items from every source; items keep `entityId`; aggregate (`undefined`/null) result has `totalsByEntity` per entity and `totals` equal to the sum without any netting of inflow against outflow.
- Transfers: excluded from `outflow`, counted in `transferCount/transferTotal`; envelope funding plus a bill paid from the envelope account are not double counted in `outflow`.
- `outflowEstimated` only includes estimated-tier items; `biggest` ignores transfers, unknown amounts, inflows and held-back items.

### 8.4 `upcoming-ledger-view.test.ts`
Grouping by date and by Monday-start week; week subtotals; truncation "+N more"; `hrefFor` builds `/budgets?bucket=personal&period=2026-11`, `/forecast?bucket=sudden-valley#rental-bookings`, `/business/sudden-valley/revenue`, etc.; money shown as `~$1,234.56`, unknown as `amount not set`, never `$0.00`; a Jan 1 UTC-midnight date displays as Jan 1 (no off-by-one); no banned phrasing ("guarantee", "will be charged") in any generated label.

### 8.5 `upcoming-ledger-render.test.tsx`
Widget: empty state text; error state text; an estimated item shows the estimate badge and note; unknown amount shows "amount not set"; a discrepancy row shows both figures; transfers are not listed; the aggregate variant shows per-entity lines and no single blended total. Agenda: tabs mark the active horizon and keep `bucket`.

Pre-existing tests (`forecast`, `card-statement-forecast`, `annual-bill`, `business-forecast`, `notifications`) must pass unmodified, which is the machine check that the generators and notifications are unchanged.

## 9. Risks and unknowns

1. **Day-31 payroll gap, inherited and visible.** Eric's semi-monthly `[15, 31]` goes through `allMonthDays`, which skips months without a 31st, so **Nov 30 ($9,000) will be missing from the ledger** (and Sep 30, Feb, Apr, Jun). The same engine omits it from the balance charts today. Fixing it means changing `lib/forecast.ts` output, which this task forbids. Do not write a test that pins the gap as correct; put a code comment and flag it for the owner (question 5).
2. **Budget is per period, the bill is one row and last-write-wins.** The ledger trusts the bill and flags the disagreement. Which side is "right" for Toyota in Nov/Dec ($420 vs $1,500) and Doggy Daycare ($310.56 vs $268) is a question only the owner can answer (question 1).
3. **Existing charts and the ledger will disagree on missing days.** Charts treat a null `autopayDay` as the 1st (Lexus, and `Reimbursement` is fine because it has day 24); the ledger says "day not set". Intended, but expect the owner to notice.
4. **Sudden Valley bills are untagged and undated, so SV shows little.** If the owner later sets a pay day on an SV Budget line (for example Internet), `upsertBudgetBill` will create a **new tagged bill** next to the untagged `Comcast`; Stage C then only catches it if the amounts, day and account line up (Comcast $65.95 vs Internet $66 with day null on one side would match by amount only when days are equal, so it may not). The robust fix is a data change (link the SV bills to their tags), which is outside this task (question 2).
5. **Stale statuses.** TaxDeadline Q2/Q3 rows are still `upcoming`; card `ccDueDate`/`ccStatementBalance` come from the last sync, so Barclay's $623.19 may already be paid. The ledger labels past-due cards "may already be paid" and ignores past-dated deadlines rather than guess.
6. **Gross rental payouts.** `grossEarnings` ignores Airbnb host fees (same as `business-forecast.ts`); label says "gross".
7. **`Reimbursement` $350 on the 24th is a Sudden Valley ScheduledBill that is really a cross-bucket reimbursement to Personal** (ground rule 6 says such flows are explicit transfers). The ledger shows it as an SV outflow and creates no mirror inflow in Personal. Not changed here; flagged.
8. **Heuristic dedupe can be wrong in both directions** (stop-word list, 5% tolerance). Mitigations: it only runs on untagged records, it never deletes (held-back items stay visible), and the three real historical pairs plus negative controls are regression tests. Revisit the stop words if a new payee pattern shows up.
9. **The "Next 14 Days" card, and the Personal charts, only include tagged bills on minimum-balance checking accounts; the ledger covers more** (all entities' accounts). The two views will therefore not match item for item. Intended.
10. **Pre-existing, not fixed:** the card-funding table formats `ccDueDate` with `America/New_York` (shows the day before). The new code formats with `UTC` on purpose.
11. **Dashboard and forecast pages are dynamic** (`auth()` + DB), so no caching or `revalidatePath` change is needed; the widget reads fresh data each load. The extra queries (about 11, small, parallel) add load to the dashboard; if it proves slow the widget could be streamed in a `Suspense` boundary later.
12. **Quarterly recurring via two semiannual shapes** is deliberately indirect to avoid new date math; the code needs a comment and a test, and live data has no quarterly row.
13. **Typed routes:** hrefs must be cast with `as Route` like `app/page.tsx` does.
14. No schema change was found to be necessary. If the Coder believes one is, stop and report instead of adding it.

## 10. Acceptance criteria (Tester checklist)

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; the new test files exist and pre-existing tests are unmodified and green.
2. `git diff` shows no change to `lib/forecast.ts`, `lib/annual-bill.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/recurring-expenses.ts`, `prisma/**`, `actions/**`; no new migration; no new dependency.
3. `lib/upcoming-ledger.ts` is pure (source-scan test passes) and `UpcomingItem` matches section 5.1, with `learned` defined and never produced.
4. Dedupe: for the Eversource three-way fixture the ledger has exactly one payment per month and records the other two as `alsoRecordedAs` with an amount discrepancy; for the three historical untagged pairs only the tagged record counts; negative controls do not merge; no cross-entity merge.
5. Every item has an `entityId` and the active bucket's widget/agenda shows only that entity's items; the aggregate view shows per-entity totals and never one blended number.
6. No amount is ever shown as `$0.00` because it is unknown ("amount not set" instead); no bill is silently dropped for a missing amount or day (appears in items with unknown amount, or in `undated`).
7. Tier labels: estimated items carry an "estimate" badge with a plain reason; wording uses "due/expected/~$"; no advice phrasing.
8. Dashboard: widget appears under the summary cards on the current month only; empty state, error state (force the loader to throw) and a loaded state all render without breaking the rest of the page; links reach the right pages.
9. Forecast page: agenda appears after the 14-day card with 30/60/90 tabs preserving `bucket`; existing sections render exactly as before.
10. Smoke check against live data (Tester, read-only, snapshot on 2026-10-08, expect drift): Personal 30-day list includes jetBlue statement Oct 12 $51.26, Eva pay Oct 9/Oct 23 $2,555, Eric pay Oct 15 and Oct 31 $9,000, Solar Oct 17 $505.70 with a "budget says day 14" note, Eversource Oct 20 $172 with a "recurring expense says $200" note, Toyota Oct 30 $420, Mortgage Nov 1 $4,700, NWM Nov 2 $760, Doggy Daycare each Wednesday $71.67, Lexus in "Day not set", Barclay $623.19 under past due, envelope transfers not counted. EK Consulting shows Capital One Oct 12 $792.68 and the Schedule C filing Oct 15. Sudden Valley shows the Oct 19 payout $1,075 (gross), Reimbursement Oct 24 $350, and five bills under "Day not set". 90-day Personal view also shows Firewood Dec 14 $315 and McCarthy Oil Dec 16 $2,000 as estimates and Amica Dec 4 $1,182.
11. Dates in the UI match the stored calendar dates (Oct 12 shows as Oct 12).

## 11. Advisor-tool stretch: recommend NOT including it

It is not cheap. A new tool means: a new `lib/advisor/tools/*.ts` file, a new query adapter in `lib/advisor/queries/` (explicit-`select` rule is test-enforced), registration in `all-tools.ts`, a chip label in `tool-labels.ts`, and edits to tests that pin "exactly 25 tools" (`advisor-tools-phase2.test.ts` lines 57-59 and 103, `advisor-phase2-tester.test.ts` line 307), the cached-prefix size test, scrub/links tests, and the 25-tool count in `CLAUDE.md` and `lib/advisor/config.ts` comments. The advisor already has `get_forecast` and `list_recurring_and_scheduled`, so a fourth overlapping tool needs careful description wording to avoid tool-choice confusion. Because the builder is pure and takes plain rows, a follow-up can add the tool with no change to this module. Defer to its own task.

## 12. Open questions for the owner (none block the build; the Coder uses the recommended default)

1. **When your bill record and your monthly budget disagree, which should the list believe?** Right now they disagree on Toyota (bill $420, budget says $1,500 for Nov and Dec), Doggy Daycare ($310.56 vs $268 a month), Solar (paid on the 17th vs budget says the 14th) and Eversource (a recurring expense says $200, the bill and budget say $172). *Recommendation:* the list shows the bill record (it is what your balance charts and reminders already use) and adds a small "records disagree" note with the other figure, so nothing is hidden. You then fix whichever side is stale.
2. **Bills with no payment day.** Lexus ($250/month) and all five Sudden Valley bills (Comcast, Amica home, Eversource, oil, property taxes) have no day recorded. Your balance charts quietly assume the 1st. *Recommendation:* the list does not guess; it shows them under "Day not set". Separately, consider a small cleanup task to enter the days and tag the Sudden Valley bills to their budget lines, which also removes a future double-count risk.
3. **Envelope transfers** (the four recurring moves from Primary Checking into the envelope accounts, about 40 rows in 90 days). They move your own money, and the bills they fund are listed separately. *Recommendation:* hide them by default and leave them out of the totals; one link shows them.
4. **A card statement already past its due date** (Barclay, $623.19, due Oct 5). The sync cannot tell us whether you paid. *Recommendation:* show it for 14 days in a "past due date, may already be paid" box, outside the totals.
5. **Eric's 31st-of-the-month paycheck.** The existing forecast skips any month without a 31st, so the Nov 30 paycheck ($9,000) is missing from the charts and will be missing from this list too. *Recommendation:* approve a separate small fix that treats day 31 as "last day of the month" (it changes the existing charts slightly, which is why it is not slipped into this task).
6. **The "All entities" views (Taxes and Projects tabs).** *Recommendation:* show items with an entity label and one total line per entity, never a single combined total, to keep the personal/business separation.
7. **Sudden Valley "Reimbursement" $350 on the 24th** is listed as a Sudden Valley outflow with no matching Personal inflow. *Recommendation:* leave as is for now; model it as an explicit transfer in a later cleanup if you want both sides visible.
8. **Advisor tool:** skip for now (section 11). *Recommendation:* revisit once you have used the dashboard widget for a few weeks.

## 13. Implementation notes for the Coder

- Reuse, do not copy: import the four generators and `perOccurrenceAmount`; derive recurring monthly equivalents with `monthlyEquivalentCents`; use `isLumpSumFrequency`.
- All money in `Decimal` from `@prisma/client/runtime/library`; the repo's stored `Decimal(14,2)` values are dollars, `RecurringExpense.amountCents` and `ProjectedRevenue.amountCents` are cents (divide by 100 at the boundary).
- Dedupe happens before generation where possible (decide the winner per key first, then expand only the winner) so loser rows never create items that must be removed later.
- Keep every UI-bound value plain (strings, numbers, ISO dates); components receive no `Decimal` or `Date` instances (repo convention).
- Delete nothing else; add no dependency; do not run `prisma migrate`, `db push`, or any write.
