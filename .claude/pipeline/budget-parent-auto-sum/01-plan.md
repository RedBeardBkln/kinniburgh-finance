# Plan: budget-parent-auto-sum

## Restated goal

Let a budget line be created/edited with a blank amount, and — when blank — have it
resolve to the recursive sum of its own nested children's amounts (arbitrary depth),
instead of requiring every line to carry an explicit dollar figure. Every place that
currently sums `Budget.budgeted` into a "total budgeted" figure (entity/period total,
per-account subtotal, business-forecast projected-expense total, the AI advisor's
narrative total) must switch to summing only root lines' *resolved* amounts, so a
parent and its children are never both counted.

## Scope

**In scope:**
- `prisma/schema.prisma`: `Budget.budgeted` becomes nullable (`Decimal? @db.Decimal(14,2)`),
  via a hand-written migration. No data change (every existing row is already non-null).
- `lib/budget-nesting.ts`: new pure `resolveBudgetedAmounts()` (bottom-up recursive
  resolution) and `getRootBudgetLineIds()` (root-membership set, for total-summing call
  sites), sharing `nestBudgetLines()`'s existing parent/child tree-building via a small
  internal refactor (extract the tree-building into a private helper both functions call
  — `nestBudgetLines`'s own external behavior/tests are unchanged).
- `actions/budgets.ts`: `CreateSchema`, `UpdateBudgetSchema` (used by `createBudget`/
  `updateBudget`, the full Edit modal), and `UpdateSchema` (used by `updateBudgetLine`,
  the inline quick-editor) all accept a blank `budgeted` value, writing `null` to the DB.
  `upsertBudgetBill`'s `expectedAmount` write becomes null-safe (the column is already
  nullable).
- Every real consumer of `Budget.budgeted` confirmed by reading the file (see Approach,
  organized by file): `app/budgets/page.tsx`, `components/budgets/budget-page-client.tsx`,
  `components/budgets/budget-line-editor.tsx`, `components/budgets/budget-edit-modal.tsx`,
  `app/page.tsx`, `components/dashboard/dashboard-client.tsx`,
  `components/dashboard/category-drilldown-modal.tsx`, `app/forecast/page.tsx`,
  `actions/reports.ts` (`exportBudgetCsv`), `lib/notifications.ts`
  (`checkBudgetOverspend`, `checkBudgetPace`), `lib/monthly-review-build.ts`,
  `lib/advisor-context.ts`.
- New Vitest coverage in `lib/__tests__/budget-nesting.test.ts` for both new functions.

**Out of scope (explicitly not doing):**
- No change to `lib/business-forecast.ts` — confirmed it only consumes a pre-aggregated
  `Decimal` total (`prorateExpensesAcrossHorizon(periodTotals, ...)`), computed entirely
  in `app/forecast/page.tsx`; nothing in that file reads `Budget.budgeted` directly.
- No change to `scripts/validate-imports.ts` / `scripts/import-budgets.ts` — confirmed
  both only ever write/read explicit non-null dollar amounts sourced from the owner's CSV
  (`data/budgets 2026 v2 (with accounts).csv`, which per CLAUDE.md is the authoritative
  seed and contains no blanks); `validate-imports.ts`'s `_sum.budgeted` Prisma aggregate
  already tolerates nulls at the SQL level (`?? 0` fallback already present) and none of
  its expected-total assertions involve a blank line, so it needs no code change.
- No component-level visual redesign of the Dashboard's flat budget table (`app/page.tsx`)
  to add parent/child indentation like `/budgets` has — out of scope; the Dashboard keeps
  its existing flat list, just fed correct (resolved, non-double-counted) numbers.
- Not adding a dedicated "reset to auto" button/affordance beyond what's naturally
  possible (clearing the field to blank and saving) — a nice-to-have the Coder may add
  cheaply on `budget-line-editor.tsx` but isn't required.
- No retroactive change to any existing `Budget.budgeted` value — every row keeps its
  current explicit amount; only future edits can opt a line into blank/auto-sum mode.
- Not reconciling the pre-existing, independent inconsistency where the recurring-expense
  override (`effectiveBudgetedDollars` in `app/budgets/page.tsx`) is applied on the
  `/budgets` page but nowhere else (`app/page.tsx`, `app/forecast/page.tsx`,
  `lib/notifications.ts`, etc. all read `Budget.budgeted` raw, ignoring linked recurring
  expenses today) — flagging this as a pre-existing gap, not fixing it as part of this
  task; this plan preserves that exact inconsistency rather than expanding scope to fix it
  everywhere.
- Running `prisma migrate dev/deploy` or `db push`, or pushing the migration-containing
  commit to `main` — Coder hand-writes the migration; nothing reaches the shared Supabase
  instance without the orchestrator's explicit go-ahead.

## Affected files/modules

- `prisma/schema.prisma` — `Budget.budgeted` → `Decimal?`.
- `prisma/migrations/<timestamp>_budget_nullable_budgeted/migration.sql` — new, hand-written.
- `lib/budget-nesting.ts` — refactor + two new exports.
- `lib/__tests__/budget-nesting.test.ts` — new test blocks.
- `actions/budgets.ts` — three zod schemas + `upsertBudgetBill` + `createBudget`/`updateBudget`
  null-handling.
- `app/budgets/page.tsx` — resolution wiring, root-only total, `budgetedRaw` added to
  `SerializedBudgetLine`.
- `components/budgets/budget-page-client.tsx` — `SerializedBudgetLine`/`BudgetRowForEdit`
  gain `budgetedRaw`; per-account subtotal fixed via existing `orderedByAccount` depth data;
  `onEdit` prefill fixed; `BudgetLineEditor` gets a new prop.
- `components/budgets/budget-line-editor.tsx` — new `rawBudgeted` prop; "Auto" display +
  blank-safe prefill.
- `components/budgets/budget-edit-modal.tsx` — hint copy near the amount field (no
  structural change needed — it already renders `budgeted` as a plain string).
- `app/page.tsx` — resolution wiring (three separate inline `computeBudgetSummary` call
  sites all need the fix, not just one — see Approach), root-only `totalBudgeted`,
  `budgetedRaw` added to `SerializedBudget`.
- `components/dashboard/dashboard-client.tsx` — `SerializedBudget` gains `budgetedRaw`,
  passed through to the drilldown modal.
- `components/dashboard/category-drilldown-modal.tsx` — `budgetedRaw` prop; blank-safe
  prefill + "Auto" display, same fix shape as `budget-line-editor.tsx`.
- `app/forecast/page.tsx` — two independent sections need the fix (business-bucket
  `aggregatePeriodTotals`/`periodTotalsByTag`; Personal-bucket `paceBudgets`).
- `actions/reports.ts` — `exportBudgetCsv` resolution + null-safety.
- `lib/notifications.ts` — `checkBudgetOverspend`, `checkBudgetPace`.
- `lib/monthly-review-build.ts` — `budgetHealth` build.
- `lib/advisor-context.ts` — narrative budget list + `totalBudgeted` accumulation.

## Approach

### Shared design (read this once — every consumer below reuses the same recipe)

`Budget.budgeted` becomes `Decimal | null`. The rule everywhere: **nesting/auto-sum only
ever happens within one account** (matching `nestBudgetLines`'s existing same-account
requirement — `Account.entityId` is a single non-null FK, so grouping by `accountId` alone
is already entity-safe, no need to also group by `entityId`). Every call site that reads
multiple `Budget` rows must:

1. Group the rows by `accountId` (and, for cross-period queries like the forecast page's
   business-bucket section, also by `period` — two different periods' "Groceries" lines
   are unrelated).
2. For each group, call the new `resolveBudgetedAmounts(group, tagParentId)` →
   `Map<budgetId, Decimal>` giving every line's effective amount.
3. Where a **total** is being summed (not a per-line display), also call
   `getRootBudgetLineIds(group, tagParentId)` and sum only those ids' resolved amounts —
   a root's resolved amount already recursively includes every descendant.
4. Where NO total is being summed (per-tag notification/pace/narrative-line display),
   just substitute the resolved amount for the raw one — no root-filtering needed, every
   row (parent and child) still gets its own correct effective amount and its own
   independent per-tag check.

**One exception:** `app/budgets/page.tsx` is the only place that already applies a
recurring-expense override (`effectiveBudgetedDollars`) on top of `Budget.budgeted`. For
that page only, the value fed into `resolveBudgetedAmounts` per line is **not** the raw
`budgeted` column but "the recurring-linked effective amount if this tag has linked
recurring expenses, else the raw `budgeted` column (which may be null)". This makes the
precedence explicit and correct: a linked recurring bill's real derived amount always
wins as a resolved leaf value (even for a line that also has children — recurring data is
actual linked-bill data, not a category aggregate, so it should never be silently replaced
by a children-sum); an explicit non-null `budgeted` wins next; auto-sum from children is
the fallback only when neither applies. Every other consumer in this codebase does **not**
know about recurring-expense overrides today (confirmed by reading each file — only
`app/budgets/page.tsx` has this logic) — this plan does not add that override anywhere
else, preserving the existing (separate, pre-existing) inconsistency rather than expanding
scope.

### 1. Schema + migration

```prisma
model Budget {
  ...
  budgeted              Decimal? @db.Decimal(14, 2)   // CHANGED: nullable = "auto-sum from children"
  ...
}
```

Hand-write `prisma/migrations/20260916140000_budget_nullable_budgeted/migration.sql`
(next available timestamp after today's existing `20260916120000_accrual_draws`, same
day), matching the plain-SQL/no-generated-header style of existing migrations:

```sql
-- Budget.budgeted becomes nullable: a blank budgeted amount now means
-- "auto-sum from this line's nested children in the same account, recursively"
-- (budget-parent-auto-sum task). Pure type relaxation — every existing row
-- already has a non-null value, so no data migration is needed.
ALTER TABLE "Budget" ALTER COLUMN "budgeted" DROP NOT NULL;
```

Then `pnpm db:generate` only (codegen, safe, no DB connection). **Do not** run
`pnpm db:migrate`/`db:push`/`prisma migrate deploy` locally, and do not push this commit
to `main` without the orchestrator's explicit go-ahead — same migration-push-gate rule as
`accrual-draw-dates` (no shadow DB; `DATABASE_URL`/`DIRECT_URL` point at the one real
Supabase instance).

### 2. `lib/budget-nesting.ts`

Refactor the existing tree-building out of `nestBudgetLines` into a private helper so both
functions share one source of truth for "what is this line's parent/children within this
account's line list":

```ts
import { Decimal } from "@prisma/client/runtime/library";

interface BudgetTree<T extends NestableBudgetLine> {
  childrenByParentTagId: Map<string, T[]>;
  roots: T[];
}

function buildBudgetTree<T extends NestableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined
): BudgetTree<T> {
  const byTagId = new Map(lines.map((l) => [l.tagId, l]));
  const childrenByParentTagId = new Map<string, T[]>();
  const roots: T[] = [];
  for (const line of lines) {
    const parentTagId = tagParentId(line.tagId) ?? null;
    if (parentTagId && byTagId.has(parentTagId)) {
      if (!childrenByParentTagId.has(parentTagId)) childrenByParentTagId.set(parentTagId, []);
      childrenByParentTagId.get(parentTagId)!.push(line);
    } else {
      roots.push(line);
    }
  }
  return { childrenByParentTagId, roots };
}
```

`nestBudgetLines` calls `buildBudgetTree` internally instead of duplicating the loop above
— its external signature, ordering, and every existing test in
`lib/__tests__/budget-nesting.test.ts` must remain unchanged (pure internal refactor).

New exports:

```ts
export interface ResolvableBudgetLine extends NestableBudgetLine {
  budgeted: Decimal | null;
}

/**
 * Resolves every line's effective budgeted amount within one account, bottom-up:
 * a non-null `budgeted` is used as-is; a null `budgeted` resolves to the sum of its
 * direct children's own resolved amounts (recursing arbitrarily deep); a null line
 * with no matching children resolves to $0. Guards against malformed cyclic
 * parent data (matches nestBudgetLines's existing "doesn't hang or crash" contract)
 * by treating an in-progress cycle as $0 rather than recursing forever.
 */
export function resolveBudgetedAmounts<T extends ResolvableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined
): Map<string, Decimal> {
  const { childrenByParentTagId } = buildBudgetTree(lines, tagParentId);
  const resolved = new Map<string, Decimal>();
  const inProgress = new Set<string>();

  function resolve(line: T): Decimal {
    const cached = resolved.get(line.id);
    if (cached) return cached;
    if (line.budgeted !== null) {
      resolved.set(line.id, line.budgeted);
      return line.budgeted;
    }
    if (inProgress.has(line.id)) return new Decimal(0); // cycle guard
    inProgress.add(line.id);
    const kids = childrenByParentTagId.get(line.tagId) ?? [];
    const sum = kids.reduce((acc, kid) => acc.plus(resolve(kid)), new Decimal(0));
    inProgress.delete(line.id);
    resolved.set(line.id, sum);
    return sum;
  }

  for (const line of lines) resolve(line);
  return resolved;
}

/** The set of line ids that are NOT nested under another line in this same
 * account (i.e. `nestBudgetLines`'s depth-0 rows) — sum only these ids' resolved
 * amounts to get a non-double-counted total for this account. */
export function getRootBudgetLineIds<T extends NestableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined
): Set<string> {
  const { roots } = buildBudgetTree(lines, tagParentId);
  return new Set(roots.map((l) => l.id));
}
```

Note: `resolved.get(line.id)` returning falsy is fine to treat as "not cached yet" even
though `new Decimal(0)` is a legitimate resolved value, because `Map.get` returning
`undefined` (not in map) is what actually gates re-entry here — `cached` being a real
`Decimal(0)` object is always truthy in JS (it's an object, not the number `0`), so this
is safe; call this out to the Coder explicitly since it's an easy thing to get wrong with
a naive `if (!cached)` check on a primitive-looking value.

### 3. `actions/budgets.ts`

All three schemas: replace the required-amount regex with one that also accepts blank,
keep `.optional()` so a key can still be omitted entirely (distinct from "sent as blank"):

```ts
budgeted: z
  .string()
  .trim()
  .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
  .optional(),
```

(`UpdateSchema`, used by `updateBudgetLine`, currently has no `.optional()` at all —
add it along with the blank-tolerant regex, matching the same shape.)

Write path — for every place currently doing `new Prisma.Decimal(budgeted)`, guard on
blank:

```ts
const budgetedDecimal = budgeted ? new Prisma.Decimal(budgeted) : null;
```

`createBudget`: `data: { ..., budgeted: budgetedDecimal, payDay: payDay ?? null }`. The
`upsertBudgetBill(tagId, entityId, accountId, budgeted, payDay)` call (only made when
`payDay !== undefined`) needs its `budgeted` parameter to accept `string | null` and write
`expectedAmount: budgeted ? new Prisma.Decimal(budgeted) : null` (the column is already
nullable — confirmed via `ScheduledBill.expectedAmount Decimal?`). Pass the *raw* value
here, not a resolved auto-sum (see Risks — a blank parent line combined with a `payDay` is
an edge case this plan deliberately doesn't resolve against siblings).

`updateBudget`: needs to distinguish three states for `budgeted`: omitted (`undefined` —
no change), explicit blank (`""` — clear to auto), explicit value. Something like:

```ts
const newBudgetedRaw = budgeted !== undefined ? (budgeted === "" ? null : budgeted) : undefined;
if (newBudgetedRaw !== undefined) {
  updateData.budgeted = newBudgetedRaw ? new Prisma.Decimal(newBudgetedRaw) : null;
}
...
const effectiveBudgetedForBill =
  newBudgetedRaw !== undefined ? newBudgetedRaw : (current.budgeted !== null ? current.budgeted.toString() : null);
```

...then pass `effectiveBudgetedForBill` (now `string | null`) into `upsertBudgetBill`
wherever it's currently called with `effectiveBudgeted`. Fix the existing
`current.budgeted.toString()` call too — it currently assumes non-null and will throw
once `current.budgeted` can be `null`.

`updateBudgetLine` (powers both `BudgetLineEditor` and `CategoryDrilldownModal`'s inline
quick-edit): `db.budget.update({ data: { budgeted: budgetedDecimal } })` — no
`ScheduledBill` sync in this function today (confirmed), so no further change needed there.

### 4. `app/budgets/page.tsx`

After fetching `budgets`/`tags` (unchanged queries — both already return everything
needed: `budgets` has `accountId`/`tagId`/`budgeted` as plain columns, `tags` has
`parentId`), build:

```ts
const tagParentById = new Map(tags.map((t) => [t.id, t.parentId]));

// Precedence: recurring-linked effective amount, else raw budgeted (may be null).
const explicitAmountByBudgetId = new Map<string, Prisma.Decimal | null>();
for (const b of budgets) {
  const tagExpenses = recurringByTagId.get(b.tagId) ?? [];
  if (tagExpenses.length > 0) {
    const recurringMonthlySumCents = tagExpenses.reduce((s, e) => s + e.monthlyEquivCents, 0);
    const additionalAmountCents = decimalToNumber(new Prisma.Decimal(b.additionalAmountCents ?? 0));
    explicitAmountByBudgetId.set(b.id, new Prisma.Decimal((recurringMonthlySumCents + additionalAmountCents) / 100));
  } else {
    explicitAmountByBudgetId.set(b.id, b.budgeted);
  }
}

const byAccountId = new Map<string, typeof budgets>();
for (const b of budgets) {
  if (!byAccountId.has(b.accountId)) byAccountId.set(b.accountId, []);
  byAccountId.get(b.accountId)!.push(b);
}
const resolvedByBudgetId = new Map<string, Prisma.Decimal>();
const rootBudgetIds = new Set<string>();
for (const group of byAccountId.values()) {
  const resolverInput = group.map((b) => ({ id: b.id, tagId: b.tagId, budgeted: explicitAmountByBudgetId.get(b.id) ?? null }));
  for (const [id, amt] of resolveBudgetedAmounts(resolverInput, (tagId) => tagParentById.get(tagId))) {
    resolvedByBudgetId.set(id, amt);
  }
  for (const id of getRootBudgetLineIds(group, (tagId) => tagParentById.get(tagId))) rootBudgetIds.add(id);
}
```

In the `serializedBudgets` map, replace the existing `effectiveBudgetedDollars`
computation entirely with:

```ts
const effectiveBudgetedDollars = decimalToNumber(resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0));
```

Add `budgetedRaw: b.budgeted !== null ? decimalToNumber(new Prisma.Decimal(b.budgeted)) : null`
to each serialized line (needed by the edit UI, not the summary math).

Fix the total:

```ts
const totalBudgeted = serializedBudgets
  .filter((b) => rootBudgetIds.has(b.id))
  .reduce((s, b) => s + b.budgeted, 0);
```

(`totalActual`/`totalRemaining` stay unchanged — actual spend is already exact-tag-only,
never double-counted by the new nesting semantics.)

### 5. `components/budgets/budget-page-client.tsx`

- `SerializedBudgetLine` gains `budgetedRaw: number | null`.
- `BudgetRowForEdit` gains `budgetedRaw: number | null` (or just reuse it directly).
- `onEdit`: `budgeted: b.budgetedRaw !== null ? b.budgetedRaw.toFixed(2) : ""` (was
  `b.budgeted.toFixed(2)` — that was the resolved/effective value, wrong for prefilling
  the edit form, which must show the *raw* stored value so blank lines show blank).
- Per-account subtotal: this component already computes `orderedByAccount` via
  `nestBudgetLines` (with real `depth` per row) for rendering — reuse it instead of the
  separate flat `byAccount` sum:

  ```ts
  const orderedLines = orderedByAccount.get(accountName) ?? lines.map((line) => ({ line, depth: 0 }));
  const accountTotal = orderedLines
    .filter((r) => r.depth === 0)
    .reduce((s, r) => s + r.line.budgeted, 0);
  ```

  (Move the `accountTotal` computation to after `orderedLines` is computed, or compute
  `orderedLines` first — currently `accountTotal` is computed before `orderedLines` in the
  per-account `.map()`; reorder as needed.)
- `<BudgetLineEditor budgetId={b.id} currentBudgeted={b.budgeted} rawBudgeted={b.budgetedRaw} />`
  — new prop, see below.

### 6. `components/budgets/budget-line-editor.tsx`

**Why this needs a real fix, not just a type change:** the non-editing display currently
shows `formatUSD(currentBudgeted)` as a plain clickable button, and clicking "edit" prefills
the input with `currentBudgeted.toFixed(2)`. Once `currentBudgeted` is the *resolved*
auto-summed value for a blank parent line, clicking this button and immediately hitting
Save (without changing anything) would silently write that resolved number back as an
explicit override, permanently exiting auto-sum mode with no indication that happened. Fix:

- New prop `rawBudgeted: number | null`.
- Non-editing display: when `rawBudgeted === null`, render something like
  `<span className="italic text-muted-foreground" title="Auto-calculated from nested budget lines — click to override">Auto · {formatUSD(currentBudgeted)}</span>`
  instead of the plain button (still clickable to enter edit mode — an explicit override
  is a legitimate action, just not an *accidental* one).
- `startEditing()`: `setValue(rawBudgeted !== null ? rawBudgeted.toFixed(2) : "")` (was
  `currentBudgeted.toFixed(2)`) — so an unmodified Save round-trips as blank, not a frozen
  number.
- `save()`: no change needed — `updateBudgetLine(budgetId, value)` already accepts blank
  once `UpdateSchema` is fixed (step 3).
- The `<input>` itself: no structural change, empty string is already a valid controlled
  value for `type="number"`.

### 7. `components/budgets/budget-edit-modal.tsx`

Add a hint line under the "Monthly Budget" label, matching the existing hint-copy style
used for the Due Date field:

```tsx
<p className="text-xs text-muted-foreground">Leave blank to auto-sum nested budget lines</p>
```

No other change needed — `budgeted` is already a plain string state that flows straight
through to `createBudget`/`updateBudget` regardless of blank/non-blank, and (once step 4's
`onEdit` fix lands) already gets pre-filled correctly blank for a null raw value.

### 8. `app/page.tsx` (Dashboard)

The `budgets` query already includes `account` (has `accountId`) and `tag` (has
`parentId`). Build the same `tagParentById` + per-account resolution as step 4, **without**
the recurring-override step (this page doesn't apply that override today — confirmed, and
out of scope to add):

```ts
const tagParentById = new Map(tags.map((t) => [t.id, t.parentId])); // reuse allTagsResult, or fetch parentId
const byAccountId = new Map<string, typeof budgets>();
for (const b of budgets) { ... } // group by b.accountId
const resolvedByBudgetId = new Map<string, Prisma.Decimal>();
const rootBudgetIds = new Set<string>();
// same per-group resolve/getRootBudgetLineIds loop as step 4, using b.budgeted directly
// (no explicitAmountByBudgetId indirection needed here)
```

Note `allTagsResult` (passed as `allTags` prop today) may currently be `select`-narrowed —
verify it includes `parentId`; if not, add it to the existing tag query rather than adding
a second one.

**Three separate places** need the resolved amount substituted for raw `b.budgeted` (this
file recomputes the same summary three times independently — confirmed by reading the
whole file, not assumed):
1. `totalBudgeted` (~line 89-92): sum only `rootBudgetIds` members' resolved amounts.
2. `overspentCount` (~line 94-101): `computeBudgetSummary({ budgeted: resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0), ... })`.
3. `chartData` (~line 103-117): `budget: decimalToNumber(resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0))`.
4. `serializedBudgets` (~line 119-137): same substitution for `budgetedDec`; also add
   `budgetedRaw: b.budgeted !== null ? decimalToNumber(new Prisma.Decimal(b.budgeted)) : null`.
5. The budget-lines table's own inline `summary` computation (~line 234-239, a **fourth**,
   separately-duplicated `computeBudgetSummary` call in the same file) needs the identical
   substitution.

None of these five need root-filtering except #1 (`totalBudgeted`) — the others are
per-line displays/checks, correct to include every row (parent and child) independently.

### 9. `components/dashboard/dashboard-client.tsx` / `category-drilldown-modal.tsx`

- `SerializedBudget` (dashboard-client.tsx) gains `budgetedRaw: number | null`; `topCards`
  mapping and the `selectedBudget`/`CategoryDrilldownModal` prop pass-through both need
  the new field threaded through.
- `CategoryDrilldownModal`: add `budgetedRaw: number | null` prop. Replace the existing
  `useState(budgeted > 0 ? budgeted.toFixed(2) : "")` prefill (a pre-existing `>0`
  heuristic, not raw-null-aware) with `useState(budgetedRaw !== null ? budgetedRaw.toFixed(2) : "")`.
  Static display: when `budgetedRaw === null`, prefix with "Auto" (e.g.
  `` `Auto (${fmt(budgeted)})` ``) instead of just `fmt(budgeted)`, same reasoning as
  `budget-line-editor.tsx` in step 6 (this modal calls the exact same `updateBudgetLine`
  action and has the identical accidental-override risk).

### 10. `app/forecast/page.tsx`

**Business-bucket section (~lines 160-178):** the `budgetRows` query already has
`include: { tag: true }` (gives `parentId` for free) and `accountId` as a plain column.
Build `tagParentById` from `allTags` (already fetched at ~line 119 for the income-source
form — reuse it). Group `budgetRows` by a compound `${period}::${accountId}` key (periods
must not merge). Resolve + root-filter per group exactly as in step 4/8. Then:

```ts
for (const b of budgetRows) {
  if (!rootBudgetIds.has(b.id)) continue; // skip non-root lines entirely for the total
  const amt = resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0);
  aggregatePeriodTotals.set(b.period, (aggregatePeriodTotals.get(b.period) ?? new Prisma.Decimal(0)).plus(amt));
  const tagEntry = periodTotalsByTag.get(b.tagId) ?? { tagName: b.tag.shortName, periods: new Map() };
  tagEntry.periods.set(b.period, amt);
  periodTotalsByTag.set(b.tagId, tagEntry);
}
```

(`periodTotalsByTag` — the itemized expense breakdown shown per horizon — is also
root-only here, so its per-tag line items sum to the same total shown alongside them;
each root's item amount already includes its descendants via the recursive resolve.)

**Personal-bucket pace section (~lines 511-585):** `paceBudgets` query
(`db.budget.findMany({ where: { entityId, period }, include: { tag: true } })`) spans
every account for one entity/period. Group by `accountId`, resolve (no root-filtering
needed — this is a per-tag pace display, not a total). Replace `budgeted: b.budgeted` at
~line 552 with `budgeted: resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0)`.

### 11. `actions/reports.ts` (`exportBudgetCsv`)

Add `account: true` to the existing `include: { tag: true, entity: true }` (need
`accountId`, or it's already a plain column — verify; `include` doesn't remove default
scalar fields, so `accountId` is likely already present without adding `account: true` at
all — confirm before adding an unnecessary include). Build `tagParentById` from the
already-included `tag` relation. Group by `accountId`, resolve. Replace `const budgeted = b.budgeted.toNumber();`
with `const budgeted = (resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0)).toNumber();`.
**Decision:** the CSV shows the *resolved* amount for a blank parent line, not a blank
cell — a CPA/spreadsheet consumer of this export wants a real number, consistent with how
every other numeric CSV column in this app already resolves to a concrete figure.

### 12. `lib/notifications.ts` (`checkBudgetOverspend`, `checkBudgetPace`)

Both functions' `budgets` query already `include: { tag: true, entity: true }` — `tag`
gives `parentId` for free, no extra query needed. In both functions: group `budgets` by
`accountId`, call `resolveBudgetedAmounts` (raw `budgeted`, no recurring override — this
file doesn't apply one today), then replace
`computeBudgetSummary({ budgeted: budget.budgeted, ... })` with
`computeBudgetSummary({ budgeted: resolvedByBudgetId.get(budget.id) ?? new Decimal(0), ... })`
in both places. No root-filtering — both are independent per-tag checks (a resolved parent
line with $0 actual spend, since spend is exact-tag-only, will simply rarely trigger
overspend/pace on its own — expected, not a bug, matches how per-tag actual-spend already
works everywhere else in this codebase).

### 13. `lib/monthly-review-build.ts`

`budgets` query already `include: { tag: true, entity: true }`. Same group-by-`accountId` +
resolve pattern; replace `const budgetedCents = Math.round(new Prisma.Decimal(b.budgeted).toNumber() * 100);`
(~line 165) with `Math.round((resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0)).toNumber() * 100)`
(also fixes a real crash risk — `new Prisma.Decimal(null)` throws at runtime once
`b.budgeted` can be `null`). No root-filtering needed — `budgetHealth`'s only downstream
consumers (`app/api/cron/monthly-review/route.ts`, `app/review/[year]/[month]/page.tsx`)
only ever *count* `status === "over"/"warning"` rows, never sum dollar amounts, confirmed
by reading both call sites. Both already delegate to this single function (confirmed via
`buildMonthlyReviewData` import in both `actions/monthly-review.ts` and the cron route —
the earlier cron/action duplication this repo had elsewhere does not apply here, already
consolidated by the `monthly-review-forecast` task).

### 14. `lib/advisor-context.ts`

`currentBudgets` query already `include: { tag: true, entity: {...} }`. Same group-by-
`accountId` + resolve pattern. In the per-line loop (~lines 150-158): keep printing every
row's own `li(...)` narrative line using its *resolved* amount (parent and child rows both
stay individually visible — more useful context for the AI, not a bug to hide), but fix
the running total to skip non-root rows:

```ts
for (const b of currentBudgets) {
  const resolvedAmt = Number(resolvedByBudgetId.get(b.id) ?? new Decimal(0));
  const actual = actualByTag.get(b.tag.name) ?? 0;
  const variance = resolvedAmt - actual;
  if (rootBudgetIds.has(b.id)) totalBudgeted += resolvedAmt; // root-only: avoid double-counting
  totalActual += actual; // unchanged — actual spend is already exact-tag-only, never double-counted
  ...
  li(`${b.tag.shortName} (${b.entity.name}): budgeted ${fmtDollars(resolvedAmt)}, spent ${fmtDollars(actual)} — ${status}`);
}
```

## Risks/unknowns

- **A blank (auto-sum) budget line combined with a `payDay` produces a `ScheduledBill`
  with a `null expectedAmount`, not the resolved sum.** `upsertBudgetBill` writes the raw
  (possibly-null) `budgeted` string, not a resolved value — resolving would require an
  extra sibling-lines fetch inside a write action that otherwise doesn't need one. This
  combination (a parent/aggregate category also carrying its own specific due-date bill)
  seems unlikely in practice — `payDay` models a concrete recurring bill, not an aggregate
  category — but it's technically reachable through the UI. `ScheduledBill.expectedAmount`
  is already nullable so this doesn't crash anything downstream; flagging as a deliberate
  scope boundary rather than silently guessing the "right" resolved value to backfill
  there.
- **Recurring-expense-override precedence is a judgment call, not literally specified by
  the owner.** The request only describes children-of-blank-parent summing; it doesn't
  mention recurring expenses at all. This plan decides linked recurring data wins over
  auto-sum (see Shared design above) because it's real linked-bill data, not a category
  estimate — flagging this explicitly in case the owner disagrees once he sees it in
  practice (e.g. a "Streaming" parent with recurring subscriptions linked directly to it
  AND child tags with their own budget lines — recurring wins, children are ignored for
  that line's own amount, but the children's own lines are unaffected and still nest under
  it for display).
- **Every "total budgeted" call site required independent verification** — this repo has
  at least four separate, independently-written `computeBudgetSummary`/sum-reduction call
  sites just within `app/page.tsx`, plus one each in `app/budgets/page.tsx`,
  `components/budgets/budget-page-client.tsx`, `app/forecast/page.tsx` (×2),
  `actions/reports.ts`, `lib/notifications.ts` (×2), `lib/monthly-review-build.ts`,
  `lib/advisor-context.ts` — twelve distinct places touching `Budget.budgeted`, no shared
  aggregation helper. This plan fixes all twelve individually rather than introducing a
  new shared "get resolved budgets for this query" data-access helper, to avoid expanding
  scope into a larger refactor the owner didn't ask for — but it does mean any *future*
  consumer of `Budget.budgeted` also needs to remember this same recipe; there's no single
  chokepoint that would catch a missed thirteenth site automatically (TypeScript will at
  least force a compile error at any site still passing a bare `Decimal | null` where a
  `Decimal` is expected, which is how most of these twelve were found in the first place).
- **`app/budgets/page.tsx`'s `allTagsResult`/tag query in `app/page.tsx`** — need to verify
  live whether the existing tag query already selects `parentId` or needs widening; this
  plan assumes it can be added cheaply (a single extra scalar field) but the Coder should
  confirm rather than assume.
- **CSV export shows resolved amounts, not blank cells, for auto-sum lines** — a
  deliberate choice (see step 11) since a blank CSV cell would be more confusing to a CPA
  than a computed total; flagging in case the owner would prefer the CSV to visibly
  distinguish "explicit" vs "auto" amounts (e.g. a suffix or separate column) — not
  implemented here, plain resolved number only, matching every other numeric column's
  existing format.
- **Migration-push-gate**: per this repo's standing rule (no shadow DB — `DATABASE_URL`/
  `DIRECT_URL` point at the one real Supabase instance), the Coder hand-writes the
  migration file but must not run it against the DB and must not push the commit to `main`
  without the orchestrator's explicit go-ahead.

## Acceptance criteria

1. `pnpm db:generate` succeeds after the schema change; `pnpm typecheck` and `pnpm lint`
   pass with zero new errors (this alone should catch any of the twelve `Budget.budgeted`
   consumer sites that got missed, since they'll fail to compile against `Decimal | null`).
2. New migration file exists at
   `prisma/migrations/20260916140000_budget_nullable_budgeted/migration.sql` (or the next
   correct timestamp if the Coder finds a later migration already landed), hand-written,
   matching existing migration file style — not applied to the DB, not pushed to `main`
   without explicit go-ahead.
3. `Budget.budgeted` is `Decimal? @db.Decimal(14,2)`.
4. On `/budgets`, adding a new budget line with the amount field left blank succeeds (no
   client or server validation error) and creates a `Budget` row with `budgeted: null`.
5. A blank parent line's displayed "Budgeted" amount equals the recursive sum of its
   nested children's own resolved amounts (children may themselves be blank and further
   nested — multi-level, matching `nestBudgetLines`'s existing 3-level precedent). A blank
   line with no children in that account displays $0.
6. An explicit non-null `budgeted` on a line that also has children is displayed and used
   exactly as entered — never silently overwritten by the children's sum.
7. The per-account subtotal on `/budgets`, the whole-entity "Total Budgeted" on `/budgets`,
   the Dashboard's "Total Budgeted" card, and the business-bucket forecast's projected-
   expenses figure on `/forecast` each equal the sum of only root-level resolved amounts
   for their scope — verified by picking one real nested example (e.g. Food & Drink /
   Groceries / Restaurants, if such a hierarchy exists in the live tag tree) and confirming
   the total does not change whether the parent is blank (auto-summed) or has the same
   explicit number manually entered.
8. Editing an existing blank (auto-sum) line via the full Edit modal shows the amount
   field empty, not "0.00".
9. Clicking the inline quick-editor (`BudgetLineEditor` on `/budgets`, or the budget-amount
   editor inside the Dashboard's category drilldown modal) on a blank auto-sum line and
   immediately clicking Save without changing the value does **not** convert the line to
   an explicit override — it must remain blank/auto afterward.
10. `checkBudgetOverspend`/`checkBudgetPace` (`lib/notifications.ts`), the monthly review's
    budget-health section, and the AI advisor's context (`lib/advisor-context.ts`) all
    run without throwing against a period containing at least one blank budget line, and
    reflect that line's resolved (not raw-null-as-zero, not crashing) amount.
11. `exportBudgetCsv` produces a numeric (not blank/NaN) "Budgeted" value for every row,
    including auto-sum parent lines.
12. No `any` types introduced.
13. `pnpm test` passes, including new coverage described below.

## Test expectations

- **Unit (required), `lib/__tests__/budget-nesting.test.ts`:**
  - `resolveBudgetedAmounts`:
    - A line with non-null `budgeted` and no children resolves to its own value.
    - A blank line with no matching children resolves to `Decimal(0)`.
    - A blank parent with two non-null children resolves to their sum (the
      "Food & Drink = Groceries + Restaurants" case from the request, using the repo's
      actual example names for readability).
    - Multi-level, bottom-up: a blank grandparent, a blank parent (one level down) with
      two non-null children, and one other non-null direct child of the grandparent — the
      grandparent's resolved amount must equal (resolved parent) + (other child), and the
      parent's own resolved amount must independently equal the sum of its two children —
      exercises true bottom-up recursion, not just one level.
    - An explicit non-null `budgeted` on a line that also has children resolves to its own
      value, not the children's sum (the "explicit wins" case named in the constraints).
    - Cycle safety: malformed self-referencing parent data doesn't hang or throw (mirrors
      `nestBudgetLines`'s existing cycle test).
  - `getRootBudgetLineIds`: returns exactly the ids of lines with no budgeted parent
    present in the same list (mirror of `nestBudgetLines`'s existing root/non-root test
    cases, adapted to return ids).
  - Confirm `nestBudgetLines`'s existing test suite still passes unchanged after the
    internal `buildBudgetTree` refactor (regression guard, not new coverage).
- **No integration/DB tests** — this repo has no DB-backed test infrastructure; every
  `app/*.tsx`/`actions/*.ts`/`lib/notifications.ts`/`lib/monthly-review-build.ts`/
  `lib/advisor-context.ts` change is verified via `pnpm typecheck` plus the manual
  click-through the orchestrator will do post-review, consistent with this repo's
  established precedent (no `actions/__tests__` directory anywhere, DB-touching check
  functions in `lib/notifications.ts` are not unit-tested directly — only the pure logic
  they call is).
- **No component/DOM tests** — repo has zero jsdom/RTL infrastructure; `budget-line-editor.tsx`,
  `budget-edit-modal.tsx`, `category-drilldown-modal.tsx`, `budget-page-client.tsx`,
  `dashboard-client.tsx` changes are verified via `pnpm typecheck` + manual click-through
  only.
- **Edge cases the unit tests must cover** (restated as a standalone checklist): leaf with
  explicit value, blank leaf with no children (→ $0), blank parent with two explicit
  children, three-level bottom-up blank-parent/blank-child/explicit-grandchildren case,
  explicit-value-on-a-line-with-children (not overwritten), cyclic parent data (no hang),
  root-id-set correctness matching `nestBudgetLines`'s existing root/non-root fixtures.
