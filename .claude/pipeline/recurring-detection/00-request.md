# Task Request: recurring-detection (forecast enhancement, step 2: history-learned recurring bills)

## Owner priorities (confirmed)
Bill surprises first, then cash-balance shortfalls, then budget overruns. Step 1 (Upcoming ledger, commits 45db899 + bd1338d, live) merged everything that is already SCHEDULED. Step 2 learns from transaction HISTORY what is recurring but not yet modelled, so surprises are caught even when nobody entered the bill.

## Goal
A pure detector that reads past transactions and (a) proposes recurring payees that are not yet a ScheduledBill / Budget schedule / RecurringExpense, (b) flags an expected bill that has not posted when it should have ("late"), (c) flags amount changes on a known recurring payee (price creep, e.g. insurance, utilities), and (d) feeds the Upcoming ledger's already-defined-but-never-populated `learned` confidence tier with clearly labelled, never-guessed items. Surface it on the dashboard/Forecast agenda (the ledger UI) and in a review list the owner can act on.

## Read first (do not re-derive)
- `.claude/pipeline/upcoming-ledger/01-plan.md` and `02-implementation.md` (UpcomingItem type, precedence/dedupe rule, `learned` tier reserved, never-fabricate rules, totals rules, per-entity scoping, builder/view/loader split).
- `lib/upcoming-ledger.ts`, `lib/upcoming-ledger-view.ts`, `lib/upcoming-ledger-build.ts`, `components/upcoming/*`.
- `lib/tags.ts` (`normalizePayee`, tag auto-assignment), `lib/forecast.ts` (generators; allMonthDays now clamps day 29-31), `lib/spend-forecast.ts`, `lib/recurring-expenses.ts`, `actions/recurring-expenses.ts` (RecurringExpense CRUD exists), `prisma/schema.prisma` (Transaction, TransactionTag, Account, RecurringExpense, ScheduledBill, Budget).
- Memory facts: `project_tag_rule_retroactive_match_bug_2026_09_18` (bank-import payees can be un-normalized; case-sensitivity bugs) and `project_import_sign_repair_2026_10_02` (sign handling on Primary Checking import) - check live data for these before trusting payee grouping and amount signs.

## Data facts (verified this session, read-only, 2026-10-08)
- Primary Checking has transactions from 2025-05 (~17 months, 2,729 rows); every other account only from ~2026-03/04 (~6 months). Credit cards: Barclay from 2026-03-30; EK Consulting Capital One from 2025-01 (223 rows); Sudden Valley JCSB from 2026-04 (132).
- Tagged share of Personal transactions: ~40-50% before 2026-04, ~95% since 2026-08. Do NOT depend on tags for detection; group by normalized payee and use tags only as a hint.
- Transaction amount convention: negative = outflow. Transfers carry `transferPairId` (exclude). `archivedAt` must be null.
- Step 1 plan found: the same real bill can exist as ScheduledBill + Budget + RecurringExpense; the new detector must not re-suggest anything already modelled (use the ledger's per-entity+tag key and its name/amount/day heuristic for untagged records).

## Required behavior
1. New PURE module (e.g. `lib/recurring-detect.ts`; no DB/Prisma client imports, no clock, no "use server"; style reference `lib/spend-forecast.ts`). Input: plain transaction rows (entityId, accountId, payeeNormalized, signed amount, postedAt) + the already-modelled items (to suppress). Output: candidate series `{ payee, entityId, accountId, cadence (weekly|biweekly|monthly|quarterly|annual), typicalDay/dayRule, typicalAmount (median) + range, occurrences, firstSeen, lastSeen, nextExpected, confidence (low|medium|high) and WHY, kind: outflow|inflow }`.
2. Detection rules must be conservative and explainable: minimum occurrences per cadence (e.g. 3 for monthly, with spacing tolerance), amount stability test (median + tolerance band; variable bills like utilities allowed with a wider band and flagged "amount varies"), day-of-month stability. Short history (6 months) must still work for monthly cadence; annual cadence can only be proposed where 12+ months of history exist (Primary Checking, EK Capital One) - otherwise never claim annual. Exclude transfers, refunds/credits, one-offs, and payees seen only once.
3. Late / missing: for a modelled OR high-confidence learned series, if the expected posting date passed by more than a tolerance with no matching transaction, flag "expected, has not posted" (observational wording: "usually posts around the 14th; none seen yet this month").
4. Amount change: if the latest occurrence differs from the series median by more than a threshold (percent AND dollars), flag "was ~$X, now ~$Y" (cover insurance/utility creep). Only for series with enough history.
5. Ledger integration: the `learned` tier items appear in the Upcoming ledger ONLY for series not already modelled, are visibly labelled (e.g. "learned from history"), carry their confidence and why, and are counted in totals only if the Planner can justify it; otherwise shown in a separate "Looks recurring - not in your budget" block outside totals (default recommendation: outside totals until the owner confirms). Never fabricate an amount or date: a candidate with low confidence is listed as a suggestion only, not placed on the calendar.
6. Owner action: a way to turn a suggestion into a real record (e.g. "Add as recurring expense" using the existing RecurringExpense create action; tag link when a tag can be inferred) and to dismiss a suggestion so it does not nag. The Planner must decide how "dismissed" persists; if that needs a new table or column, FLAG it clearly with the migration implication and offer a no-migration fallback (e.g. dismissals stored via existing models or omitted in v1). A migration must not be included without the owner's OK.
7. Respect ground rules: personal/business separation (series are per entity/account, never cross-entity), observational language only ("looks recurring", "usually", "~$X"), no financial advice, no account numbers in UI text or logs, money as Decimal, dates UTC stored / America/New_York displayed. Server code calls `auth()`/`requireAuth()` like its neighbours; the loader is read-only.
8. Fail-soft everywhere (dashboard/forecast pages must not break if detection throws or data is thin).

## Constraints
- TypeScript strict, no `any`. Unit tests in `lib/__tests__/` for the detector (each cadence, short history, tolerance edges, variable-amount bills, refunds/transfers excluded, same payee on two accounts/entities, already-modelled suppression, late flag boundaries, amount-change thresholds, annual only with 12+ months, DST/UTC dates) and for the ledger integration.
- Do not change the Personal cash-flow engine output, `lib/business-forecast.ts`, or notifications in this task (reminder consolidation is a later step) unless the Planner justifies a tiny change.
- Agents: no DB writes, no migrations, no `prisma generate`; read-only live checks only (temporary repo-root script via `node_modules/.bin/tsx --env-file=.env ./_x.ts`, delete afterwards; print payee names/counts/amounts only, never account numbers). Token-frugal.

## Out of scope
Seasonal/variable-bill modelling by month-of-year, cash-flow v2 with variable spend, forecast snapshots/accuracy tracking, reminder consolidation, tax-estimate projections.

## Owner communication
Explain any decision the owner must make in plain language with a recommendation. The owner has asked for step 2 to be built; propose defaults so nothing blocks.
