# 06 — Recommended Stack & Phased Build Plan

## Stack (cloud-hosted)

- **Frontend/app:** Next.js (App Router) + TypeScript, Tailwind + shadcn/ui, Recharts for dashboard charts. PWA (installable, offline cache, web push).
- **API:** Next.js route handlers / server actions; tRPC or REST — keep it simple.
- **DB:** PostgreSQL (Neon or Supabase) + Prisma (or Drizzle). Row-level household scoping.
- **Auth:** Auth.js (passkeys + TOTP MFA) or Clerk.
- **Aggregation:** Plaid (start in Sandbox; Production requires Plaid approval — plan for that lead time).
- **Files:** S3-compatible object storage (Supabase Storage / Cloudflare R2) with encryption.
- **Jobs/schedules:** Inngest or Vercel Cron — nightly syncs, webhook processing, forecast recompute, notification dispatch.
- **OCR/extraction:** Claude API (vision) or AWS Textract for receipts; human confirmation required.
- **Push:** Web Push (VAPID); email via Resend/Postmark as secondary channel.
- **Hosting:** Vercel (app) + managed Postgres. Single environment first, then staging.

Rationale: one TypeScript codebase covers web + mobile (PWA), Plaid is the de-facto US aggregation layer, and managed services keep a 2-user app cheap (~tens of dollars/month; Plaid pricing per connected Item — verify current pricing before committing).

## Phases

### Phase 0 — Foundation
Repo, CI, auth (Eric + Eva), DB schema from spec 01, seed entities/institutions/accounts, **import `data/tags 2026.csv` and `data/budgets 2026 v2 (with accounts).csv` verbatim** (53 lines, $16,489/mo total, account mapping per mask; `Business Ventures` blank account → x2566), write the import-validation script (verify row counts and column sums programmatically; surface the spec-07 items to the user rather than auto-fixing — including the stale $120 Auto Insurance line → ~$217 pending confirmation).

### Phase 1 — Manual core (works with zero integrations)
Transactions (manual + CSV import with mapping wizard + dedupe), hierarchical tags, monthly budgets with rollover, transfer pairing, entity buckets, basic dashboard with bucket toggle, budget vs. actual report.

### Phase 2 — Envelope automation model
Scheduled transfers + bills from spec 02/03 seeds, accrual envelopes with seasonality (McCarthy, firewood, property taxes), $250-minimum projection warnings, cash-flow forecast (income cadence 15th/30th + biweekly).

### Phase 3 — Plaid
Link flow, webhook sync, account mapping by mask, pending→posted reconciliation, per-institution coverage check with fallback to import mode. Start with TD Bank + Capital One; attempt JCSB, Barclays, PennyMac and record results.

### Phase 4 — Receipts & tag learning
Receipt capture (camera/PDF) → extraction → confirm → GL code + tags → transaction matching. Payee→tag rule engine with review queue.

### Phase 5 — Business books & taxes
GL chart per entity, Sudden Valley retroactive 2026 entry workflow (back to Feb 2026), Balance Sheet + P&L, document vault, tax-year workspaces (incl. EKC 2025 late-filing checklist with user-supplied extended deadline), CPA export bundle.

### Phase 6 — Proactive guidance & notifications
Push notifications (overspend, low-balance projection, accrual shortfall, bill reminders, anomalies), per-user targeting (one or both), thresholds configurable.

### Phase 7 — Planning & polish
Projects (Slush Funds envelopes), savings autopilot, retirement view (Betterment + NWM inputs), mortgage payoff simulator, solar ROI tracker, life insurance module, report exports, monthly household review.

## Definition of done per phase
Each phase ships deployed, with tests for money math (transfers, rollover, accrual pacing, fee warnings), and a short demo note for Eric & Eva. Never proceed past a phase with failing financial-math tests.
