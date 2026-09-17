# Implementation: budget-parent-auto-sum

## Summary of changes

### Schema + migration
- `prisma/schema.prisma` — `Budget.budgeted` changed from `Decimal @db.Decimal(14, 2)` to
  `Decimal? @db.Decimal(14, 2)`. Pure type relaxation, no data change.
- `prisma/migrations/20260916140000_budget_nullable_budgeted/migration.sql` — new,
  hand-written (not applied to the DB, not pushed — see Migration section below):
  ```sql
  -- Budget.budgeted becomes nullable: a blank budgeted amount now means
  -- "auto-sum from this line's nested children in the same account, recursively"
  -- (budget-parent-auto-sum task). Pure type relaxation — every existing row
  -- already has a non-null value, so no data migration is needed.
  ALTER TABLE "Budget" ALTER COLUMN "budgeted" DROP NOT NULL;
  ```

### `lib/budget-nesting.ts` (core resolution logic)
- Extracted `nestBudgetLines`'s parent/child tree-building into a private `buildBudgetTree()`
  helper; `nestBudgetLines`'s own signature/behavior/ordering is unchanged (verified via its
  full existing test suite, still green).
- New `resolveBudgetedAmounts(lines, tagParentId, zero)` — bottom-up recursive resolution:
  non-null `budgeted` used as-is; null `budgeted` resolves to the sum of direct children's
  own resolved amounts (arbitrary depth); a null line with no children resolves to `zero`.
  Cycle-safe (malformed self-referencing parent data returns `zero` instead of recursing
  forever, mirroring `nestBudgetLines`'s existing cycle-safety contract).
- New `getRootBudgetLineIds(lines, tagParentId)` — the set of line ids not nested under
  another line in the same list (mirrors `nestBudgetLines`'s root/child determination);
  callers sum only these ids' resolved amounts to get a non-double-counted total.
- **Deviation from the plan's sketched code**: `resolveBudgetedAmounts` takes a third
  parameter, `zero: Decimal`, supplied by the caller, and the file's `Decimal` import is
  `import type` (not a value import). See "Deviations" below — this was necessary to avoid
  breaking the production client-side webpack build.

### `lib/__tests__/budget-nesting.test.ts`
- Added a full `resolveBudgetedAmounts` suite: leaf with explicit value; blank leaf with no
  children → $0; blank parent summing two explicit children ("Food & Drink = Groceries +
  Restaurants", using the request's own example names); three-level bottom-up
  (blank grandparent → blank parent summed from two explicit children, plus one other
  explicit direct child of the grandparent); explicit value on a line with children (not
  overwritten); cycle guard (no hang/throw).
- Added a `getRootBudgetLineIds` suite mirroring `nestBudgetLines`'s existing root/non-root
  fixtures.
- Confirmed `nestBudgetLines`'s pre-existing 7 tests still pass unchanged after the
  `buildBudgetTree` refactor.
- All 15 tests in this file pass (`pnpm vitest run lib/__tests__/budget-nesting.test.ts`).

### `actions/budgets.ts`
- `UpdateSchema` (used by `updateBudgetLine`, the inline quick-editor), `CreateSchema`
  (`createBudget`), and `UpdateBudgetSchema` (`updateBudget`) all now accept a blank
  `budgeted` string (regex `^(\d+(\.\d{1,2})?)?$`, `.optional()`), meaning "auto-sum".
- `updateBudgetLine` writes `null` when blank, a `Prisma.Decimal` otherwise.
- `createBudget` writes `budgeted: budgetedDecimal` (`null` when blank); passes the raw
  string (or `null`) through to `upsertBudgetBill`, not a resolved auto-sum value (see Risks
  in the plan — a blank line + `payDay` combo is a deliberately out-of-scope edge case).
- `updateBudget` now distinguishes three states for `budgeted`: omitted (`undefined` — no
  change), explicit blank (`""` — clear to auto-sum, writes `null`), explicit value. Fixed a
  latent crash: `current.budgeted.toString()` (assumed non-null) is now guarded with
  `current.budgeted !== null`.
- `upsertBudgetBill`'s `budgeted` parameter is now `string | null`; `expectedAmount` writes
  `null` when blank (the `ScheduledBill.expectedAmount` column was already nullable).

### `app/budgets/page.tsx`
- Builds `explicitAmountByBudgetId` implementing the stated precedence: recurring-linked
  effective amount (if the tag has linked recurring expenses) wins as a resolved leaf value;
  else the raw `budgeted` column (may be null).
- Groups budgets by `accountId`, resolves via `resolveBudgetedAmounts`, and computes
  `rootBudgetIds` via `getRootBudgetLineIds`, per account group.
- `effectiveBudgetedDollars` (feeding `computeBudgetSummary`) now reads from the resolved
  map instead of re-deriving inline.
- Added `budgetedRaw: number | null` to each serialized line (the raw stored value, for
  edit-UI prefill).
- `totalBudgeted` now sums only root-id lines' resolved amounts.

### `components/budgets/budget-page-client.tsx`
- `SerializedBudgetLine` gains `budgetedRaw: number | null`.
- `onEdit` now prefills `budgeted: b.budgetedRaw !== null ? b.budgetedRaw.toFixed(2) : ""`
  (was the resolved value — would have silently frozen an auto-sum into an override).
- Per-account subtotal (`accountTotal`) now reuses the already-nested `orderedByAccount` and
  sums only `depth === 0` rows, instead of a separate flat `lines.reduce(...)` that
  double-counted parent + children.
- `<BudgetLineEditor>` now also receives `rawBudgeted={b.budgetedRaw}`.

### `components/budgets/budget-line-editor.tsx`
- New `rawBudgeted: number | null` prop.
- Non-editing display: when `rawBudgeted === null`, shows an italic
  `Auto · {formatUSD(currentBudgeted)}` button (still clickable to override) instead of the
  plain amount, with a title tooltip explaining it's auto-calculated.
- `startEditing()`/initial state now prefill from `rawBudgeted` (blank when null), not
  `currentBudgeted` — so an unmodified Save round-trips as blank/auto, never freezing the
  resolved number in as an accidental override.

### `components/budgets/budget-edit-modal.tsx`
- Added a hint line under "Monthly Budget": "Leave blank to auto-sum nested budget lines".
  No structural change needed — `budgeted` already flows through as a plain string.

### `app/page.tsx` (Dashboard)
- Same resolve/root-id pattern as `/budgets`, without the recurring-expense override (this
  page never applied that override — confirmed, preserved as a pre-existing, separate
  inconsistency, not expanded here).
- Fixed all **four** independent computations that read `Budget.budgeted` in this file:
  `totalBudgeted` (now root-only sum of resolved amounts), `overspentCount`, `chartData`,
  `serializedBudgets` (+ added `budgetedRaw`), and the budget-lines table's own inline
  `computeBudgetSummary` call.

### `components/dashboard/dashboard-client.tsx` / `category-drilldown-modal.tsx`
- `SerializedBudget` gains `budgetedRaw: number | null`, threaded through `topCards` pass
  and into `CategoryDrilldownModal`.
- `CategoryDrilldownModal` gains a `budgetedRaw` prop; prefill now uses
  `budgetedRaw !== null ? budgetedRaw.toFixed(2) : ""` (was a `budgeted > 0` heuristic on the
  *resolved* value — not null-aware). Static display shows `Auto ($X)` (italic,
  "click to override" tooltip) when `budgetedRaw === null`, same accidental-override
  protection as `budget-line-editor.tsx`.

### `app/forecast/page.tsx`
- **Business-bucket section**: groups `budgetRows` by `${period}::${accountId}` (periods
  must not merge), resolves + root-filters per group. `aggregatePeriodTotals` and
  `periodTotalsByTag` now sum/report only root lines' resolved amounts (a root's resolved
  amount already recursively includes its descendants).
- **Personal-bucket pace section**: groups `paceBudgets` by `accountId`, resolves (no
  root-filtering — per-tag pace display, every row independently correct).

### `actions/reports.ts` (`exportBudgetCsv`)
- Groups by `accountId`, resolves, and the "Budgeted" CSV column now shows the resolved
  amount for every row (including auto-sum parent lines) rather than crashing on
  `b.budgeted.toNumber()` against a possibly-null value.

### `lib/notifications.ts` (`checkBudgetOverspend`, `checkBudgetPace`)
- Added a shared `resolveBudgetsByAccount()` helper (groups by `accountId`, resolves, no
  root-filtering — both checks are independent per-tag checks). Both functions now pass the
  resolved amount into `computeBudgetSummary` instead of the raw (possibly-null) column.

### `lib/monthly-review-build.ts`
- Same group/resolve pattern; `budgetedCents` now reads from the resolved map. This also
  fixes a real crash risk — `new Prisma.Decimal(b.budgeted)` would throw once `b.budgeted`
  can be `null`. No root-filtering needed (`budgetHealth`'s consumers only count
  over/warning rows, never sum dollars — confirmed by reading both call sites).

### `lib/advisor-context.ts`
- Same group/resolve pattern. Per-line narrative lines still show every row's own resolved
  amount (parent and child both individually visible, useful context for the AI). The
  running `totalBudgeted` accumulator now adds only root-id lines' resolved amounts.

## Deviations from the plan

**`resolveBudgetedAmounts` takes a `zero: Decimal` parameter; the file's `Decimal` import is
`import type`, not a value import.** The plan's sketched code had `lib/budget-nesting.ts`
import `Decimal` as a runtime value from `@prisma/client/runtime/library` and construct
`new Decimal(0)` internally. I implemented that first, and it passed `pnpm typecheck`/
`pnpm test`, but **`npx next build` failed** with `UnhandledSchemeError` (`node:fs`,
`node:events`, `node:fs/promises`) — because `lib/budget-nesting.ts` is imported by
`components/budgets/budget-page-client.tsx`, a `"use client"` component (via
`nestBudgetLines`), and any runtime-level import from `@prisma/client/runtime/library`
(which itself imports Node built-ins) gets pulled into the browser bundle the moment it's
statically imported anywhere in that file, breaking the client build. `lib/budget.ts` (which
does import `Decimal` as a value) never hit this because it's only ever imported from server
page files, never a client component — confirmed via grep before concluding this was a real,
new problem rather than an existing pattern I could copy blindly.

Fix: made the `Decimal` import type-only (erased at compile time, no runtime import emitted)
and changed `resolveBudgetedAmounts`'s signature to accept a `zero: Decimal` argument from
the caller (who already has a live `Decimal`/`Prisma.Decimal` import in scope in every one of
the eight call sites) instead of constructing one internally. Updated all eight call sites
(`app/budgets/page.tsx`, `app/page.tsx`, `app/forecast/page.tsx` ×2, `actions/reports.ts`,
`lib/notifications.ts`, `lib/monthly-review-build.ts`, `lib/advisor-context.ts`) and the test
file to pass `new Decimal(0)` / `new Prisma.Decimal(0)`. Re-verified: `pnpm typecheck` clean,
`pnpm test` 596/596 green, and **`npx next build` now succeeds cleanly (63/63 routes, zero
errors)**. `getRootBudgetLineIds` needed no such change — it never touches `Decimal` at all.

This is the only deviation from the plan's approach; the external behavior (resolution
semantics, precedence rules, root-filtering) is unchanged from what the plan specified.

## Commands run and their results

- `pnpm vitest run lib/__tests__/budget-nesting.test.ts` — 15/15 passed (both before and
  after the `zero`-parameter fix).
- `pnpm lint` — 0 errors, 47 warnings, all pre-existing and unrelated to this change
  (confirmed via `git diff` — none of the warned files/lines are ones I touched).
- `pnpm test` (full suite) — **596/596 tests passed across 49 files**, both before and after
  the fix.
- `pnpm typecheck` — clean, zero errors, after `pnpm db:generate` succeeded (see note below).
- `npx next build` — **succeeded cleanly, 63/63 routes, zero errors** (only the same
  pre-existing lint warnings noted above; no new ones).
- `pnpm db:generate` — initially failed ~20 times in a row with the known Windows
  `EPERM ... query_engine-windows.dll.node.tmpNNNN` lock (two standing `next dev` processes
  from other concurrent sessions in this shared repo/machine, confirmed via
  `Get-CimInstance Win32_Process`; did not kill them, per standing guidance not to touch
  other sessions' processes). Per this repo's own documented precedent
  (`.claude/agent-memory/coder/build-flaky-shared-db-pool.md`), checked whether the
  TS-facing part of codegen (`index.d.ts`) had been rewritten anyway despite the binary
  rename failing — it had (`Budget.budgeted: Decimal | null` present, fresh timestamp).
  `pnpm typecheck` then passed cleanly against those regenerated types, and the orphaned
  `.tmpNNNN` files were deleted (safe cleanup, confirmed by that same memory entry's
  precedent). Never ran `prisma migrate dev`/`db push`/`migrate deploy` — per the
  migration-push-gate, the hand-written SQL file was not applied to the database.

## Open items

- **Not applied to the database.** The migration file exists at
  `prisma/migrations/20260916140000_budget_nullable_budgeted/migration.sql` but has not been
  run against the shared Supabase instance. Nothing in this task's scope needed it applied
  locally (all verification was via `pnpm typecheck`/`pnpm test`/`npx next build`, per the
  plan's stated test-expectations — no DB-backed tests in this repo). Needs the orchestrator's
  explicit go-ahead before push/apply.
- **Recurring-expense-override precedence** (`app/budgets/page.tsx` only: a linked recurring
  bill's amount wins over auto-sum-from-children, even for a line that also has children) is
  a judgment call the plan flagged as not literally specified by the owner — worth
  double-checking against a real example once this is live (e.g. a parent tag with both
  linked recurring expenses AND child budget lines).
- **A blank (auto-sum) line combined with a `payDay`** produces a `ScheduledBill` with a
  `null expectedAmount`, not a resolved sum — `upsertBudgetBill` intentionally receives the
  raw (possibly-null) value, not a resolved one, per the plan's stated scope boundary. Flagged
  again here since it's easy to lose track of.
- **CSV export shows resolved amounts, not blank cells**, for auto-sum lines — deliberate
  (plan's stated decision), flagging again in case the owner wants a visual "explicit vs.
  auto" distinction in the export later.
- **No live click-through was performed** (no browser-control tool / app credentials
  available to this agent) — all verification is `pnpm typecheck`/`pnpm lint`/`pnpm test`/
  `npx next build` plus manual code tracing. The acceptance criteria that require picking a
  real nested tag hierarchy from the live tag tree (e.g. actual Food & Drink / Groceries /
  Restaurants lines) and confirming totals match between an auto-summed and an
  explicitly-entered-equal-amount parent still need the orchestrator's manual
  click-through pass, as the plan itself anticipated.
- **Pre-existing gap preserved, not fixed**: `app/page.tsx`, `app/forecast/page.tsx`,
  `lib/notifications.ts`, etc. still don't apply the recurring-expense override that
  `/budgets` alone applies — this plan explicitly kept that scope boundary rather than
  expanding it.

## Files touched

- `prisma/schema.prisma`
- `prisma/migrations/20260916140000_budget_nullable_budgeted/migration.sql` (new)
- `lib/budget-nesting.ts`
- `lib/__tests__/budget-nesting.test.ts`
- `actions/budgets.ts`
- `app/budgets/page.tsx`
- `components/budgets/budget-page-client.tsx`
- `components/budgets/budget-line-editor.tsx`
- `components/budgets/budget-edit-modal.tsx`
- `app/page.tsx`
- `components/dashboard/dashboard-client.tsx`
- `components/dashboard/category-drilldown-modal.tsx`
- `app/forecast/page.tsx`
- `actions/reports.ts`
- `lib/notifications.ts`
- `lib/monthly-review-build.ts`
- `lib/advisor-context.ts`
