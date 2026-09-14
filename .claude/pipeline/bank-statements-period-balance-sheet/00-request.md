# Request

This feature already exists as pre-written, uncommitted code in the working tree (built outside the Planner/Coder pipeline — no plan document exists). The user has asked to independently review it for correctness/completeness and, if solid, commit and push it (this is a review/finish task, not a from-scratch build).

## What the feature does

Bank-statement-driven period balance sheets for business entities: upload a bank/investment statement (PDF/image), extract its period + per-account balances via Claude, store it, and use those statement snapshots (with a live-balance fallback for accounts with no statement in the period) to render an accurate point-in-time balance sheet for a given month/quarter/year — as opposed to the existing `computeBalanceSheet` which only reflects *current* live balances. This directly supports the platform's business-close workflow (a balance sheet as of a specific period-end, reconciled to actual bank statements, is the natural precursor to a "quarterly/annual close").

## Files involved (all currently uncommitted; some pre-existed at session start, none touched by any pipeline task this session)

**New files:**
- `lib/period-balance-sheet.ts` — pure period-range math (`PeriodKind = "month" | "quarter" | "year"`, `parsePeriodSelector`, `monthRange`/`quarterRange`/`yearRange`, `buildPeriodBalanceSheet`) + `lib/__tests__/period-balance-sheet.test.ts`
- `lib/bank-statement-extract.ts` — Claude extraction of statement period + per-account balances (`ExtractedStatement`, `StatementAccountRow`) + `lib/__tests__/bank-statement-extract.test.ts`
- `actions/bank-statements.ts` (488 lines) — server actions: upload/extract statements, confirm extracted balances, `getPeriodBalanceSheet(entityId, start, end)`
- `components/bank-statements/` — upload/review UI
- `app/business/[slug]/statements/` — statements page
- `prisma/migrations/20260908120000_bank_statements/migration.sql` — creates the `BankStatement` table

**Modified files:**
- `actions/reports.ts` — adds `exportPeriodBalanceSheetCsv(entityId, selector)`, combining statement-derived balances with a live fallback
- `app/business/[slug]/balance-sheet/page.tsx` — UI additions (+258 lines) for period selection
- `app/business/page.tsx`, `components/app-sidebar.tsx` — nav wiring

**Already committed (verified, no diff needed):** `prisma/schema.prisma`'s `BankStatement` model was already committed in `dc1f72f` (an earlier pipeline commit this session, unintentionally — its commit message doesn't mention bank statements at all). Confirmed via `git diff HEAD -- prisma/schema.prisma` (empty) — no schema.prisma changes needed as part of this task, only committing the migration file that was never checked in.

## Important production-state finding (already verified by the orchestrator, don't re-derive)

- `npx prisma migrate status` against the `.env` production connection string reports "Database schema is up to date!" across all 31 local migration folders, including the untracked `20260908120000_bank_statements` one — meaning this migration was already manually applied directly to production (likely via `prisma migrate dev` run locally on/around Sep 8, before this session's later commits), independent of git.
- `git grep -ln "bankStatement" HEAD` (committed code only) returns nothing — no currently-deployed code path calls the Prisma `bankStatement` client, so there has been no live runtime error from this gap.
- The fix is simply committing the migration file as-is (do not modify its SQL) — checksums will match what's already recorded as applied in production's `_prisma_migrations` table, so `prisma migrate deploy` on the next Vercel build will see it as already-applied and skip it cleanly, not attempt to re-run it.

## Ground rules that apply (CLAUDE.md)

Money as integer cents or `NUMERIC(14,2)` Decimal, never floats — `period-balance-sheet.ts`'s comment claims "integer cents everywhere," verify this is actually true throughout, including in `actions/reports.ts`'s new `fmtDollars(cents: number)` helper (uses plain `number`, not Decimal — check whether this matches the existing `exportBalanceSheetCsv`/`exportPlCsv` precedent in the same file, since CSV export formatting from already-summed integer cents via plain JS numbers may be an accepted existing pattern there — verify against the file's own conventions, don't assume a violation). Tax/financial records archive-only, never hard-deleted — confirm `BankStatement.archivedAt` is respected everywhere (`archivedAt: null` guards on reads). All server actions must call `requireAuth()`/`auth()` first. No financial-advice claims — this feature presents reconciled balances, not advice, so should be fine, but verify no overreaching language was added to any UI copy.
