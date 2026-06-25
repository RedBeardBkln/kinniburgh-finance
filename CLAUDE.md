# Kinniburgh Financial Platform

Interactive personal + business financial management platform for Eric Kinniburgh and Eva-Laura Ramirez-Wisiackas. Covers envelope budgeting, spend analysis, forecasting, project budgets, retirement planning, business bookkeeping for three LLC/entities, tax document organization and prep, and life insurance policy storage/analysis.

## How to use this repo

Read the specs in order before writing any code:

| File | Contents |
|---|---|
| `KICKOFF.md` | How the owner runs this build (setup, initial prompt, per-phase inputs) |
| `specs/00-overview.md` | Goals, users, organizational buckets, success criteria |
| `specs/01-data-model.md` | Entities, schema, money handling rules |
| `specs/02-personal-finances.md` | Accounts, envelope/transfer rules, budgets, tags |
| `specs/03-business-finances.md` | The three business entities, properties, tax workflows |
| `specs/04-integrations.md` | Bank integrations (Plaid), import fallbacks, security |
| `specs/05-features.md` | Receipts, dashboard, reporting, tagging, proactive guidance, mobile |
| `specs/06-build-plan.md` | Recommended stack and phased implementation plan |
| `specs/07-source-data-notes.md` | **Read this.** Known discrepancies and open questions in the source data — do NOT silently "fix" these |
| `data/tags 2026.csv` | Real personal tag hierarchy (seed data) |
| `data/budgets 2026 v2 (with accounts).csv` | **Authoritative budget seed** — 2026 monthly budgets with account mapping (owner-cleaned, June 2026). Amounts are starting points and may be updated. |
| `data/budgets 2026.csv` | v1 export — historical reference only (contains rollover/actuals figures from the prior tool); do NOT seed budgets from this |

## Ground rules (non-negotiable)

1. **Never fabricate financial data.** Every account number, dollar amount, date, and rule in these specs comes from the owner's source documents. If something is missing or ambiguous, check `specs/07-source-data-notes.md`; if still unresolved, ask the user — do not invent a value.
2. **Money is stored as integer cents** (or `NUMERIC(14,2)` in Postgres). Never floats.
3. **Transactions are immutable facts.** Tags, categories, and budget assignments are mutable metadata layered on top. Support audit history.
4. **Two-person household.** Eric and Eva are separate users with shared visibility; notifications can target either or both.
5. **Security first.** This app holds real bank data. Encrypt secrets at rest, never log account numbers or tokens, use OAuth/Plaid tokens (never store bank passwords), enforce auth on every route, support MFA.
6. **Personal vs. business separation is a core invariant.** Every transaction belongs to exactly one bucket (Personal, Sudden Valley Property Management LLC, Eric Kinniburgh Consulting LLC, or Mezzo). Cross-bucket flows (e.g., reimbursements via THE COTTAGE account) are modeled as explicit transfers, not edits.
7. **Tax data retention.** Nothing tax-related is ever hard-deleted; archive only.
8. **No financial advice claims.** Guidance features present data-driven observations ("you've spent 80% of the Groceries budget"), not investment/tax advice. Tax prep outputs are drafts for a CPA/filer to review.

## Conventions

- TypeScript strict mode everywhere; no `any`.
- All dates stored UTC, displayed in America/New_York.
- Write tests for: transfer/accrual math, budget rollover logic, minimum-balance fee warnings, tag auto-assignment.
- Seed the database from `data/*.csv` exactly as-is (including known quirks listed in spec 07) unless the user approves cleanup.

## Dev Commands

```bash
pnpm dev          # Next.js dev server
pnpm build        # prisma generate && next build
pnpm typecheck    # tsc --noEmit
pnpm lint         # ESLint
pnpm test         # vitest run (all tests)
pnpm test:watch   # vitest watch

# Run a single test file:
pnpm vitest run lib/__tests__/tags.test.ts

# Prisma
pnpm db:generate  # prisma generate (after schema change)
pnpm db:migrate   # prisma migrate dev (local dev migration)
pnpm db:push      # prisma db push (schema push without migration)
pnpm db:studio    # Prisma Studio GUI
pnpm db:seed      # seed from data/*.csv
```

## Architecture

**Stack:** Next.js 15 App Router · TypeScript · Prisma/PostgreSQL (Supabase) · NextAuth v5 · Plaid · Tailwind · shadcn/ui · Vitest

**Server actions** (`actions/*.ts`) — all use `"use server"` and call `requireAuth()` as the first line; never skip it. `requireAuth()` throws if no session.

**Auth** — NextAuth v5 credentials provider (email + password + optional TOTP). Session cookie: `authjs.session-token` (HTTP) / `__Secure-authjs.session-token` (HTTPS). Middleware in `middleware.ts` gates all routes except `/login`.

**Entities** — the core multi-tenancy unit. Personal + three LLCs (Sudden Valley, EK Consulting, Mezzo). Entity slug drives the URL (`/business/[slug]/...`). `getNavBuckets()` in `lib/entity.ts` builds the header tabs.

**Money** — `NUMERIC(14,2)` in Postgres; `Decimal.js` at runtime. **Negative = outflow, positive = inflow.** Never use floats for amounts.

**Encryption** — `lib/encrypt.ts`: AES-256-GCM, format `iv:authTag:ciphertext` (hex). Used for Plaid access tokens, cursors, vault credentials. Key from `ENCRYPTION_KEY` env var (64-char hex → 32 bytes).

**Plaid sync** — `lib/plaid-sync.ts`: use `normalizePlaidTransaction()` for all Plaid tx conversion (flips sign, handles payee priority). Use `normalizePayee()` from `lib/tags.ts` (not `.toLowerCase()`) for `payeeNormalized` field.

**Soft deletes** — `archivedAt: null` guards required on all `findUnique`/`findFirst` queries for Transaction, Account, PlaidItem, VaultOtp. Tax records are never hard-deleted.

**Vault** — separate OTP + session mechanism (`VaultOtp`, `VaultSession`); `lib/vault-session.ts` validates the `vault-session` cookie (4h expiry). OTP has `attempts` column; burns after 5 failures (429).

**Tags** — `lib/tags.ts`: hierarchical (parent/children paths like "Food & Drink / Groceries"); `matchTagRule()` for auto-assignment; always use `normalizePayee()` for `payeeNormalized`.

**Testing pattern** — pure function unit tests in `lib/__tests__/`. Use `Decimal` (never floats). Test factory `makeTx(overrides)` for mock Plaid transactions. No integrated DB tests; mock at the function boundary.

**Key env vars:** `DATABASE_URL`, `ENCRYPTION_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `NEXTAUTH_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, VAPID vars.
