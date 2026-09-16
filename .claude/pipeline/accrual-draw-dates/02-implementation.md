# Implementation: accrual-draw-dates

## Summary of changes

- `prisma/schema.prisma` — added `AccrualDraw` model (`id`, `accrualEnvelopeId`,
  `estimatedDate`, `estimatedAmount` (`Decimal(14,2)`), `notes?`, `createdAt`,
  `updatedAt`; `onDelete: Cascade` on the FK to `AccrualEnvelope`). Added
  `AccrualEnvelope.scheduledBillId String? @unique` + `scheduledBill
  ScheduledBill?` relation + `draws AccrualDraw[]`. Added a back-relation-only
  `accrualEnvelope AccrualEnvelope?` field to `ScheduledBill` (no new column
  on that side). Matches the plan exactly.

- `prisma/migrations/20260916120000_accrual_draws/migration.sql` — new,
  hand-written (no `prisma migrate`/`db push` run against the DB). Creates
  `AccrualDraw`, adds the nullable `scheduledBillId` column +
  unique index + FK on `AccrualEnvelope`, and backfills the 3 confirmed live
  matches by `accountId` + exact name (not by literal UUID). Exact SQL:

  ```sql
  -- Estimated draw dates/amounts per AccrualEnvelope (accrual-draw-dates task).
  -- Lets an accrued ScheduledBill's forecast use real lump-sum draw dates
  -- instead of a flat monthly spread, when the owner has entered any.

  CREATE TABLE "AccrualDraw" (
      "id"                TEXT NOT NULL,
      "accrualEnvelopeId" TEXT NOT NULL,
      "estimatedDate"     TIMESTAMP(3) NOT NULL,
      "estimatedAmount"   DECIMAL(14,2) NOT NULL,
      "notes"             TEXT,
      "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"         TIMESTAMP(3) NOT NULL,

      CONSTRAINT "AccrualDraw_pkey" PRIMARY KEY ("id")
  );

  ALTER TABLE "AccrualDraw" ADD CONSTRAINT "AccrualDraw_accrualEnvelopeId_fkey"
    FOREIGN KEY ("accrualEnvelopeId") REFERENCES "AccrualEnvelope"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

  -- Optional link from an AccrualEnvelope to the ScheduledBill it funds.
  -- Nullable: envelopes without a matching bill aren't forced to have one
  -- (e.g. Sudden Valley's "McCarthy Oil (Arbor Retreat)" bill has no envelope
  -- today and stays that way).
  ALTER TABLE "AccrualEnvelope" ADD COLUMN "scheduledBillId" TEXT;

  CREATE UNIQUE INDEX "AccrualEnvelope_scheduledBillId_key" ON "AccrualEnvelope"("scheduledBillId");

  ALTER TABLE "AccrualEnvelope" ADD CONSTRAINT "AccrualEnvelope_scheduledBillId_fkey"
    FOREIGN KEY ("scheduledBillId") REFERENCES "ScheduledBill"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

  -- Backfill: link the 3 existing AccrualEnvelope rows to their matching
  -- ScheduledBill, confirmed against live production data 2026-09-16 by
  -- reading both tables directly (not guessed/invented). Matched by
  -- accountId + real name — see .claude/pipeline/accrual-draw-dates/01-plan.md
  -- for the full worked match table, including the one bill (Sudden Valley's
  -- "McCarthy Oil (Arbor Retreat)") intentionally left unlinked.
  UPDATE "AccrualEnvelope" ae
  SET "scheduledBillId" = sb.id
  FROM "ScheduledBill" sb
  WHERE ae.name = 'McCarthy Oil'
    AND sb.payee = 'McCarthy Heating & Oil'
    AND ae."accountId" = sb."accountId"
    AND ae."scheduledBillId" IS NULL;

  UPDATE "AccrualEnvelope" ae
  SET "scheduledBillId" = sb.id
  FROM "ScheduledBill" sb
  WHERE ae.name = 'Firewood'
    AND sb.payee = 'Firewood'
    AND ae."accountId" = sb."accountId"
    AND ae."scheduledBillId" IS NULL;

  UPDATE "AccrualEnvelope" ae
  SET "scheduledBillId" = sb.id
  FROM "ScheduledBill" sb
  WHERE ae.name = 'Property taxes — 56 Arbor Rd'
    AND sb.payee = 'Property taxes — 56 Arbor Rd'
    AND ae."accountId" = sb."accountId"
    AND ae."scheduledBillId" IS NULL;
  ```

  Before writing this, re-verified the live match table via a read-only
  script (`db.accrualEnvelope.findMany`/`db.scheduledBill.findMany` against
  production, no writes) run through a temporary in-tree `scripts/`
  file (deleted immediately after, per the existing
  `data-remediation-script-pattern`). Confirmed 3-for-3 against the plan's
  table, exact IDs matched too (McCarthy Oil `9d45453c-…`, Firewood
  `7a14af85-…`, Property taxes `c7932b29-…`; bills `fc74d807-…`,
  `0b5a1037-…`, `6ebb6469-…`; Sudden Valley's unmatched "McCarthy Oil (Arbor
  Retreat)" bill `06658b38-…` confirmed still has no envelope). No drift
  since planning.

- `prisma/seed.ts` — captured the three relevant `upsertBill(...)` calls
  into `mccarthyOilBill`, `firewoodBill`, `propertyTaxBill` consts, and
  passed `scheduledBillId: <bill>.id` into the three matching
  `upsertAccrual(...)` calls, so a from-scratch seed of a fresh environment
  produces the same linked state the migration backfill produces in
  production.

- `lib/forecast.ts` — added `AccrualDrawLike` interface (`estimatedDate`,
  `estimatedAmount`). `generateBillOccurrences` gained a 4th optional
  `draws: AccrualDrawLike[] = []` parameter. When `bill.amountType ===
  "accrued"` and `draws.length > 0`, emits one outflow event per draw whose
  `estimatedDate` falls in `[from, to)` (skipping zero/negative amounts),
  sorted ascending, and returns early — no flat-spread event is also
  emitted. Every other case (static/fluctuating bills, accrued bills with no
  draws or an empty draws array) falls through unchanged to the existing
  flat monthly-spread logic, verified byte-for-byte unchanged by the new
  "no draws" test case.

- `actions/envelope.ts`:
  - Added `createAccrualDraw`, `updateAccrualDraw`, `deleteAccrualDraw` —
    each `requireAuth()`-first, zod-validated (`estimatedDate`:
    `YYYY-MM-DD` regex; `estimatedAmount`: money regex, matching
    `createTransferSchema`/`projected-revenue.ts#createSchema` conventions),
    `revalidatePath("/envelope")` + `revalidatePath("/forecast")`, no
    `AuditLog` entry (matches `updateAccrualBalance`'s existing precedent in
    this same file for `AccrualEnvelope`-adjacent mutations). `update`/
    `delete` throw `Error("Accrual draw not found")` on a missing id,
    matching this file's own `{success:true}`/throw convention (not the
    `{error}`-returning style of `actions/projected-revenue.ts`).
  - `getEnvelopeSummary`'s `accruals` query: added
    `draws: { orderBy: { estimatedDate: "asc" } }` to the `include`.
  - `getEnvelopeForecastData`'s `scheduledBills` include: added
    `accrualEnvelope: { include: { draws: true } }`; its
    `generateBillOccurrences` call now maps and passes those draws as the
    4th argument. This was the third call site the plan flagged (not named
    in the original request) — updated so `/envelope`'s own 30-day solvency
    forecast for Heating & Electric stays consistent with `/forecast`.

- `app/forecast/page.tsx` — the personal-bucket `scheduledBill.findMany`
  query gained `include: { accrualEnvelope: { include: { draws: true } } }`.
  Added a small `billDraws(b)` helper (maps a bill's linked envelope draws
  into the plain shape `generateBillOccurrences` expects) and used it at
  both existing call sites (90-day account forecast, ~line 367-ish, and the
  14-day Primary Checking schedule, ~line 459-ish).

- `app/envelope/page.tsx` — imported the new `AccrualDrawsList` client
  component and mounted it inside each Accrual Envelope `<Card>`, below the
  existing "Update balance" form, passing that envelope's `draws` (now
  available via the updated `getEnvelopeSummary` query) serialized to plain
  `{id, estimatedDateIso, estimatedAmount, notes}` values (no `Decimal`/
  `Date` instances crossing the RSC boundary, per this repo's existing
  convention).

- New file `components/envelope/accrual-draws-list.tsx` (`"use client"`) —
  modeled on `components/business/projected-revenue-card.tsx` per the
  plan's justification (variable-length collection needing per-row
  edit/delete; the existing inline-server-action pattern on this page only
  handles single fixed-field forms). Renders: a sorted list of existing
  draws with inline edit-in-place (date/amount/notes + Save/Cancel) and
  Delete per row; an add-draw mini-form below; the empty-state copy
  specified in the plan verbatim.

- `lib/__tests__/forecast.test.ts` — added `describe("generateBillOccurrences")`
  with 8 tests (the function had zero prior coverage): static/fluctuating
  baseline; accrued+no-draws-arg flat-spread fallback; accrued+empty-draws-array
  fallback; draws-in-window (asserts no flat-spread events also appear);
  draws-partially-outside-window; non-accrued bill ignoring a stray `draws`
  arg; zero-amount draw skipped; negative-amount draw skipped. Added local
  `makeAccrualBill()`/`makeStaticBill()`/`makeDraw()` factories matching the
  file's existing `makeTransfer()`/`makeIncome()` style.

## Deviations from the plan

None of substance. One minor addition beyond the plan's literal text: I
added a `billDraws()` helper function in `app/forecast/page.tsx` rather than
inlining the `.map(...)` at both call sites, to avoid duplicating the same
mapping expression twice in one file — purely a DRY refactor of what the
plan already specified, no behavior difference.

## Commands run and their results

- `npx tsx <in-tree temp script>` — read-only live-data re-verification of
  the migration's match table before writing the migration SQL (per the
  plan's own instruction to re-verify, not trust the planning-time
  snapshot blindly). Confirmed exact match, 3-for-3, IDs identical to the
  plan's table. Script deleted immediately after (not committed).
- `pnpm db:generate` — `prisma generate` errored on the native binary
  rename step (`EPERM: operation not permitted, rename
  ...query_engine-windows.dll.node.tmpNNNN -> query_engine-windows.dll.node`),
  the known Windows DLL-lock issue from concurrent sessions (see agent
  memory `build-flaky-shared-db-pool`). Confirmed via `grep` that
  `index.d.ts` was rewritten with `AccrualDraw`/`scheduledBillId` (547
  matches) and had a fresh timestamp — the part `tsc`/`vitest` actually
  need succeeded despite the binary-rename failure. Cleaned up the orphaned
  `.tmp*` file afterward. Did NOT run `pnpm db:migrate`/`db:push`/`prisma
  migrate deploy` against the live database, per the migration-push-gate
  constraint.
- `pnpm typecheck` — clean, 0 errors.
- `pnpm lint` — 0 errors, 47 warnings (repo's existing pre-existing
  baseline; confirmed via grep that none of the warnings are in any file
  this task touched — the only match in a touched file, `prisma/seed.ts`,
  is the pre-existing `creditCards`/`slushFunds` unused-var warnings at
  lines 146/176, unrelated to and far from this task's edits at
  ~364/490).
- `pnpm test` — 581/581 passed across 48 files (up from the prior session's
  baseline of 573/573 across 48 files — +8 tests, 0 new test files, matching
  the plan's "add to the existing forecast.test.ts" instruction exactly).
- `npx next build` — ran this instead of `pnpm build` (which would re-hit
  the same `prisma generate` DLL lock) since the schema change's types were
  already confirmed regenerated correctly; this is a documented fallback in
  agent memory for exactly this situation. Succeeded cleanly: all ~90
  routes compiled and rendered, including `/envelope` and `/forecast`
  (both touched by this task), 0 errors.

## Open items

- **Migration not applied.** Per the task's explicit migration-push-gate
  instruction, I did not commit or push anything, and the migration has
  not been applied to the shared Supabase database. The `AccrualDraw` table
  and `AccrualEnvelope.scheduledBillId` column do not exist in production
  yet. Acceptance criterion 10 (backfill verified by a read-only query
  post-migration) can't be checked until the orchestrator approves pushing
  this to `main` and `prisma migrate deploy` runs on Vercel.
- **No live click-through possible from this role.** Per this repo's
  established `no-browser-tool-for-manual-verification` pattern, I have no
  browser-control tool or login credentials to manually exercise the new
  draws list/add-form UI in a running app. Verified instead via
  `pnpm typecheck` + `npx next build` (both clean, confirming the new
  component compiles and the page renders in the build's static analysis)
  and by tracing the data flow by hand (schema → actions → page → client
  component props). The real click-through (add/edit/delete a draw,
  confirm it reappears; confirm `/forecast` shows the real date instead of
  a flat spread once draws exist) is the orchestrator's post-review manual
  verification step, as the plan anticipated.
- **Pre-existing, out-of-scope items flagged by the plan itself, unchanged
  by this task** (repeating for visibility, not new findings of mine):
  `checkAccrualShortfall`/`monthly-review-build.ts`'s accrual-pace section
  still ignore draws entirely; no reconciliation between entered draws and
  `annualBudget`/`targetAnnualAmount`. Both explicitly out of scope per the
  plan.

## Orchestrator follow-up round (post-review, pre-push)

Applied both of the Reviewer's non-blocking should-fix items from `04-review.md` directly (small, precisely-scoped, verified by typecheck/lint/test):

1. **Audit-log miscitation fixed for real, not just in docs.** `createAccrualDraw`/`updateAccrualDraw`/`deleteAccrualDraw` in `actions/envelope.ts` now each write an `AuditLog` row (`accrual_draw_create` / `accrual_draw_update` / `accrual_draw_delete`), matching `updateAccrualBalance`'s actual pattern rather than the incorrect "matches existing precedent" claim that turned out to describe the opposite of what that function does.
2. **Server-side amount validation tightened.** `createDrawSchema`/`updateDrawSchema`'s `estimatedAmount` now goes through a shared `drawAmountSchema` with a `.refine((v) => parseFloat(v) > 0, ...)` check, matching the UI's existing client-side `> 0` guard instead of relying on it alone.

Re-ran `pnpm typecheck` (clean), `pnpm lint` (0 errors, 47 pre-existing warnings), `pnpm test` (581/581, unchanged — no new test cases needed for this pure validation/audit-logging tightening). No migration SQL changes — `AuditLog` already existed with `before`/`after` as nullable `Json`; used `Prisma.JsonNull` for the explicit-null cases (typecheck caught that plain `null` doesn't satisfy Prisma's `Json` input type). Still nothing committed.
