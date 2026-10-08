# Task Request: upcoming-ledger (forecast enhancement, step 1)

## Owner priorities (confirmed)
Bill surprises first, then cash-balance shortfalls, then budget overruns. This task is step 1 of a staged forecasting upgrade and targets "bill surprises".

## Goal
One unified, dated, forward-looking list of every expected outflow and inflow for the next 90 days ("Upcoming ledger"), merged from sources that today are scattered and mostly invisible outside `/forecast`. Surface it as (a) a "Next 30 days" widget on the dashboard (`app/page.tsx` / `components/dashboard/*`) and (b) an agenda view on the Forecast page (`app/forecast/page.tsx`). Optional stretch (Planner decides if cheap): a read-only advisor tool reading the same builder.

## Current state (from the review done this session, verify against code)
- `lib/forecast.ts` has per-source generators: `generateTransferOccurrences`, `generateIncomeOccurrences`, `generateBillOccurrences` (handles monthly/weekly/biweekly/annual/semiannual + accrued draws), `generateCardStatementPayment`. Reuse these; do NOT re-implement date math.
- `app/forecast/page.tsx` builds Personal events only for checking accounts with `minimumBalance`, only `ScheduledBill` rows with `budgetTagId != null`, only 14-day/90-day views. Business buckets use `lib/business-forecast.ts` (revenue = `RentalBooking` payouts + `ProjectedRevenue`; expenses prorated from `Budget`).
- `Budget` rows carry `payDay`, `frequency`, `payDayOfWeek`, `biweeklyAnchorDate`, `payMonth`, `annualAmountDue` (budgeted is always a MONTHLY total; per-occurrence via `perOccurrenceAmount`, annual lump via `lib/annual-bill.ts`).
- `RecurringExpense` (amountCents, frequency monthly|weekly|biweekly|quarterly|annually, dueDay, nextDueDate, optional tagId) is display-only on `/forecast` and used as an override on `/budgets`; it feeds no projection.
- `TaxDeadline` exists (per entity); document expiry is checked in `lib/notifications.ts` `checkDocumentExpiry`; `AccrualDraw` gives dated heating-oil-style draws; credit-card accounts have `ccDueDate` / `ccStatementBalance`.
- Bill reminders (`checkBillReminders`) look only 3 days ahead and only at `ScheduledBill`.
- Earlier work (see `.claude/pipeline/forecast-redesign-and-fixes/`) found many `ScheduledBill` rows had no `budgetTagId` and some were duplicates of tagged rows. Re-verify current live state read-only (do not assume it is fixed or unfixed).

## Required behavior
1. New PURE module (e.g. `lib/upcoming-ledger.ts`, no DB/Prisma client imports, no "use server"; style reference `lib/spend-forecast.ts`, `lib/forecast-rollup.ts`) that merges sources into `UpcomingItem[]`: `{ date, amount (Decimal, negative = outflow), label, source, confidence tier, entityId, accountId?, link target }`. Sources for v1: Budget lines with a pay day / frequency / annual due, `ScheduledBill`, `RecurringExpense`, `AccrualDraw`, credit-card statement due dates, outgoing `ScheduledTransfer`s, `IncomeSource` paychecks, `RentalBooking` payouts, unrealized `ProjectedRevenue`, `TaxDeadline`s, document/insurance expiry. The Planner may drop a source if the data is not trustworthy, but must say so and why.
2. **De-duplication is the central design risk.** The same real-world bill can exist as a Budget line, an auto-created `ScheduledBill` (via `budgetTagId`/`budgetEntityId`), and a `RecurringExpense`. The ledger must never double-count. Specify an explicit precedence rule and test it (including the untagged-duplicate pairs found earlier). Where two sources disagree on amount or date, keep one and surface the discrepancy rather than silently choosing.
3. Each item carries a confidence tier: `scheduled` (a dated rule or statement), `estimated` (derived, e.g. accrued bill spread, annual set-aside), so the UI can label it. (A `learned` tier is reserved for step 2; define the type but do not populate.)
4. Respect bucket separation (CLAUDE.md ground rule 6): items keep their `entityId`; the dashboard widget and Forecast agenda respect the active bucket. No cross-bucket netting.
5. Dashboard widget "Next 30 days": grouped by date (or week), shows what is due, amount, source and tier, total outflow and a "biggest upcoming" callout; links to the underlying budget/bill/forecast page. Empty and error states must not break the dashboard (fail soft).
6. Forecast page agenda: the same list over 90 days with a horizon toggle, placed so it does not disturb the existing balance charts.
7. Observational wording only (ground rule 8): "due", "expected", "~$X". Estimated items are labelled estimates. Never fabricate an amount: an item with an unknown amount is shown as "amount not set" (and listed), not as $0 and not dropped silently.
8. No schema change / no migration expected. If the Planner finds one is genuinely needed, flag it and stop; do not include it without the owner's OK.

## Constraints
- TypeScript strict, no `any`; money via Decimal; dates UTC stored, displayed America/New_York.
- Server components / actions that read the DB call `requireAuth()` / `auth()` first like their neighbors; read-only.
- Unit tests in `lib/__tests__/` for the builder: each source, dedupe precedence, annual/semiannual, weekly/biweekly per-occurrence amounts, horizon boundaries, unknown-amount items, bucket scoping.
- Do not change the existing Personal cash-flow engine output, `lib/business-forecast.ts`, or notification behavior in this task (reminder consolidation is a later step).
- Agents: no DB writes, no migrations, no `prisma generate`, read-only live checks only. Token-frugal: grep/read directly; do not spawn sub-research.

## Data facts learned this session (for the Planner)
- Transaction history: Primary Checking back to 2025-05 (~17 months); every other account only from ~2026-03/04 (~6 months). Tagged share ~40-50% before 2026-04, ~95% since 2026-08. Step 1 must not depend on history depth (history-learned items are step 2).
- Owner wants plain-language explanation of decisions he must make, with a recommendation.

## Out of scope
Recurring-payee detection from transactions, seasonal/variable-bill modelling, cash-flow v2 with variable spend, forecast snapshots/accuracy tracking, reminder consolidation, tax-estimate projections.
