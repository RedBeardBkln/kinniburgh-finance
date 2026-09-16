# Review: accrual-draw-dates

## Verdict: APPROVED

## Findings

### should-fix

1. **Audit-log precedent claim is factually backwards** (`actions/envelope.ts`,
   new `createAccrualDraw`/`updateAccrualDraw`/`deleteAccrualDraw`). Both
   `02-implementation.md` and `03-test-report.md` state the new draw CRUD
   actions skip `AuditLog` because that "matches `updateAccrualBalance`'s
   existing precedent in this same file for `AccrualEnvelope`-adjacent
   mutations." That's wrong — `updateAccrualBalance` (lines ~262-289 of the
   same file) *does* write an `AuditLog` entry (`changeType:
   "accrual_balance_update"`, before/after balance). So the new draw
   mutations are actually the first `AccrualEnvelope`-adjacent write in this
   file with no audit trail, not a continuation of an existing pattern.
   Not blocking — draws are estimates, not booked transactions, and ground
   rule 3's audit-history requirement is explicitly about `Transaction`
   immutability, not every adjacent estimate table — but it's a real
   correctness gap in the stated reasoning that the Coder/Tester should be
   aware got the precedent backwards. Worth a follow-up: either add
   `AuditLog` entries to the three new actions for consistency with their
   sibling in the same file, or explicitly document why draws are
   intentionally excluded (rather than citing a precedent that says the
   opposite).

2. **No positive-amount enforcement at the schema/zod boundary for
   estimated draws.** `createDrawSchema`/`updateDrawSchema`'s
   `estimatedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/)` accepts `"0.00"`
   (and any non-negative value) — the `amount > 0` guard only exists
   client-side in `accrual-draws-list.tsx`'s `handleAdd`/`handleUpdate`. A
   zero-amount draw could be persisted directly via the server action (not
   reachable through the shipped UI, but the UI isn't the only caller
   surface for a `"use server"` export). `generateBillOccurrences` correctly
   skips zero/negative draws when projecting, so this can't corrupt the
   forecast — worst case is a dead row that silently does nothing, which is
   low-risk, but a `.positive()`/regex tweak (e.g. requiring at least one
   nonzero digit before the decimal, or a Zod refine) would close the gap
   cleanly. Nit-adjacent; flagging as should-fix only because it's a one-line
   fix and this is a financial-data app.

### nit

3. `fmtUSD` in `accrual-draws-list.tsx` silently falls back to returning the
   raw string if `parseFloat` yields `NaN` — fine defensively, but since
   `estimatedAmount` is always a server-serialized `Decimal.toString()`, this
   branch is realistically unreachable. No action needed, just noting it's
   dead-code-shaped, not a request to remove it.

## What I verified myself (not just summaries)

- **Migration SQL** (`prisma/migrations/20260916120000_accrual_draws/migration.sql`)
  read in full. `CREATE TABLE "AccrualDraw"` + FK with `ON DELETE CASCADE`
  (correct — child estimate rows should disappear if their envelope is ever
  deleted; no delete UI exists for `AccrualEnvelope` today so this is inert
  but safe). `AccrualEnvelope.scheduledBillId` added as nullable `TEXT`,
  unique index, FK with `ON DELETE SET NULL` (correct — if a `ScheduledBill`
  is ever deleted, the envelope survives unlinked rather than being
  cascaded away, which is the right direction for a financial-estimate
  parent record). The three backfill `UPDATE` statements are idempotent
  (each guarded by `ae."scheduledBillId" IS NULL`), scoped by exact
  `name`/`payee` string match **and** `accountId` equality (not a bare name
  match), so there's no risk of a wrong cross-account link even if two
  differently-scoped rows happened to share a name. No `DROP`, no column
  narrowing, no `NOT NULL` added to any existing column — this migration
  can only add rows/columns, it cannot destroy or truncate any existing
  `AccrualEnvelope`/`ScheduledBill` data. I see no reason this would fail to
  apply cleanly via `prisma migrate deploy`, and no data-loss/corruption risk
  to the 3 backfilled rows or any other row in either table.
  Migration-push-gate note in `02-implementation.md`/`03-test-report.md` is
  accurate: confirmed via `git log` (no commit containing this migration
  exists yet) and via `03-test-report.md`'s own `pnpm prisma migrate status`
  output showing the migration listed as not-yet-applied — consistent with
  what's actually on disk right now.

- **`generateBillOccurrences` fallback** — read the diff directly
  (`git diff lib/forecast.ts`). The new accrued+draws branch is a
  self-contained `if` block prepended above the existing flat-spread logic,
  which returns early; every line of the pre-existing flat-spread body below
  it is untouched (same `bill.autopayDay ?? 1`, same `annualBudget/12`
  division, same `allMonthDays` call). The draws branch's boundary check
  (`date < from || date >= to`) is the exact same exclusive-upper-bound
  convention already used by the untouched, pre-existing
  `generateCardStatementPayment` in the same file — so it's consistent with
  this file's established `[from, to)` semantics, not a new/differently-scoped
  boundary. Confirmed all 3 real call sites were updated
  (`app/forecast/page.tsx` both the 90-day and 14-day sites via a shared
  `billDraws()` helper; `actions/envelope.ts#getEnvelopeForecastData`, the
  third site the request didn't name but the plan correctly flagged and the
  Coder implemented) — grepped for `generateBillOccurrences(` repo-wide and
  found exactly these 3 call sites plus the function definition, no site
  missed.

- **Tests** (`lib/__tests__/forecast.test.ts`) — read all 8 new test cases,
  not just the pass count. They genuinely cover the required matrix:
  previously-untested static baseline, accrued-no-draws-arg fallback,
  accrued-empty-array fallback, draws-in-window (with an explicit assertion
  that flat-spread dates do NOT also appear — the mutual-exclusivity
  guarantee), draws-partially-outside-window (3 draws, asserts exactly 1
  survives), non-accrued-bill-ignores-stray-draws, zero-amount-skipped,
  negative-amount-skipped. These are real edge-case assertions, not
  superficial happy-path checks.

- **Auth gating** — `createAccrualDraw`/`updateAccrualDraw`/
  `deleteAccrualDraw` all call `requireAuth()` as their first statement,
  matching every other action in the file. `requireAuth()` itself (unchanged
  by this diff) correctly throws on a missing session. No ownership/ID
  scoping beyond `requireAuth()` — consistent with this file's existing
  two-person-household model (Eric/Eva share visibility per ground rule 4;
  `updateAccrualBalance`/`deleteScheduledTransfer` etc. all work the same
  way, by bare ID with no owner check), not a new gap introduced here.

- **Ground rule 1 (no fabricated data)** — grepped `prisma/seed.ts` for
  `AccrualDraw`/`accrualDraw`: zero matches. The feature ships with zero
  seeded draw rows; only the schema-level `scheduledBillId` backfill (linking
  existing envelope/bill rows by real matched IDs, not amounts/dates) is
  added to seed.ts, exactly as scoped.

- **Ground rule 8 (observational language)** — no new UI copy makes a
  guarantee; the empty-state text ("...so the forecast can use it instead of
  a flat monthly spread") and the rest of the page's existing "~$X projected"
  conventions are unchanged/consistent.

- **Ground rule 6 (entity separation)** — the `scheduledBillId` FK and draws
  mechanism are entity-agnostic (no hardcoded "Personal" anywhere in
  `lib/forecast.ts`'s new branch or the CRUD actions); only the seed-time
  backfill happens to link 2 Personal + 1 Sudden Valley row, matching what
  actually exists live. No cross-bucket leakage introduced.

- **UI component quality** — `components/envelope/accrual-draws-list.tsx`
  is a faithful, idiomatic adaptation of `projected-revenue-card.tsx`'s
  pattern (per-row inline edit/delete, `useTransition` + `router.refresh()`,
  local `saving`/`error` state, try/catch-with-generic-message on each
  action). Consistent input styling with the rest of the Envelopes page.
  Client-side validation (amount > 0, required date) is a reasonable UX
  layer even though it doesn't replace server-side validation (see
  should-fix #2).

## On shipping without a live click-through

Accepted as a known, explicit gap for this pipeline — neither Coder nor
Tester has browser-control access, and this repo has zero
DOM/component-test infrastructure (confirmed pre-existing constraint, not
new to this task). Both agents traced the data flow by hand (schema →
actions → page → client component props) and verified everything mechanically
checkable (`pnpm typecheck`, `pnpm test`, `npx next build` compiling both
`/envelope` and `/forecast`). I reviewed the same diff independently and
agree there's nothing here that reading the code can't catch — the actual
render/interaction verification is correctly deferred to the orchestrator's
post-approval, post-migration manual click-through, as the plan anticipated.
This is not a reason to withhold approval; it's a reason the orchestrator's
own manual pass after migration + deploy remains a required step, not
optional follow-through.

## Do I see any reason NOT to apply the migration?

No. This is a factual safety read of the SQL, not authorization to push —
that decision stays with the owner. The migration only adds a table, adds a
nullable column, adds a unique index, adds two FKs (one `CASCADE`, one
`SET NULL`, both appropriate for their direction), and backfills exactly 3
rows via idempotent, precisely-scoped (`accountId` + exact name) `UPDATE`
statements guarded by `IS NULL`. It touches no existing column type, drops
nothing, and cannot orphan or corrupt any existing `AccrualEnvelope` or
`ScheduledBill` row. Re-running it (if it were somehow applied twice) is a
no-op on the backfill due to the `IS NULL` guards, and Prisma's migration
table prevents literal re-application anyway. I found no reason to block it
on safety grounds.

## What's good

- The Coder correctly identified and fixed a third `generateBillOccurrences`
  call site (`actions/envelope.ts#getEnvelopeForecastData`) that the
  original request didn't name — the Planner flagged it as a risk and the
  Coder followed through, avoiding a half-wired feature where `/envelope`
  and `/forecast` would have silently disagreed on the same account's
  projected balance.
- Genuinely good test coverage added to a function (`generateBillOccurrences`)
  that had zero prior coverage despite 3 real call sites — this is a net
  improvement to the codebase's test posture, not just coverage for the new
  branch.
- The migration is hand-written, idempotent, narrowly scoped, and backed by
  a live read-only re-verification done twice independently (once by the
  Coder, once by the Tester) rather than trusting the planning-time
  snapshot — good discipline given this repo's shared-DB, no-shadow-DB
  constraint.
- Clean adherence to ground rule 1: zero fabricated draw data anywhere in
  the diff, confirmed by grep, not just by trusting the write-up.
- The new UI component is a faithful, consistent extension of an existing
  in-repo pattern (`projected-revenue-card.tsx`) with a clearly justified
  reason for deviating from the page's existing inline-server-action-form
  convention, exactly as the request asked the Coder to justify.

## Route-back target

N/A — approved.
