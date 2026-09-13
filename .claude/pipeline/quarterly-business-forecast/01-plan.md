# Plan: Quarterly Business Forecast

## Restated goal

For each in-scope business entity (Eric Kinniburgh Consulting LLC, Sudden Valley
Property Management LLC), project where the *current, in-progress* calendar
quarter's net income will land by quarter-end, using real GL-coded transaction
history via the existing `computePL()`, and surface a simple percentage-based
cash-reserve suggestion ("set aside ~$X for taxes") on top of that projection —
never a computed tax liability.

## Scope

**In scope:**
- New pure projection module `lib/business-quarter-forecast.ts` (quarter
  calendar math + pace/trailing-average blend projection for income and
  expenses + a separate tax-reserve percentage calculator), unit tested.
- New settings helpers in `lib/settings.ts` (per-entity reserve percentage,
  stored via the existing `AppSetting` key/value table — no schema change).
- New mutation `actions/business-forecast.ts` (`setEntityTaxReservePct`) to
  save the reserve percentage.
- New "Quarter-End Forecast" section added to the existing
  `app/business/[slug]/pl/page.tsx`, with a small client-side percentage-edit
  form (`components/business/tax-reserve-pct-form.tsx`).
- Gating logic so the section only renders for entities that actually have
  income-type GL activity (see Design Question 4 / entity scope below).

**Out of scope (explicitly, do not build):**
- Any IRS bracket math, self-employment tax computation, Social Security wage
  base, or safe-harbor comparison. The reserve is `projectedNetIncome × pct`,
  full stop.
- Mezzo (no income side — see below).
- Personal-side forecasting (already covered by `lib/spend-forecast.ts`).
- Changes to `lib/spend-forecast.ts`, `lib/forecast-rollup.ts`, or
  `lib/reports.ts`'s public API/signatures.
- A new notification/cron check for reserve targets (this is a display
  feature only; a future task could wire a notification off of it).
- A dedicated household-wide "tax settings" page — the reserve % control
  lives inline on the P&L page next to where it's used.
- Seasonal (same-quarter-last-year) modeling for Sudden Valley's Airbnb income
  — trailing-quarter blending only, same philosophy as `spend-forecast.ts`.

## Affected files/modules

New files:
- `lib/business-quarter-forecast.ts` — pure module (quarter math, projection,
  reserve calculator).
- `lib/__tests__/business-quarter-forecast.test.ts` — unit tests.
- `actions/business-forecast.ts` — `"use server"` mutation for the reserve %.
- `components/business/tax-reserve-pct-form.tsx` — `"use client"` leaf (the
  only interactive piece).

Modified files:
- `lib/settings.ts` — add `getEntityTaxReservePct(entityId)` /
  `setEntityTaxReservePct(entityId, pct)` helpers (thin wrappers over
  `getAppSetting`/`setAppSetting`, following the existing
  `getLogoMeta`/`setLogoMeta` pairing style already in that file).
- `app/business/[slug]/pl/page.tsx` — add the forecast data-fetching
  (multiple `computePL` calls + the GL-code gate) and render the new section.

Not touched: `lib/reports.ts`, `lib/spend-forecast.ts`, `lib/forecast-rollup.ts`,
`prisma/schema.prisma` (no migration), `app/business/[slug]/cash-flow/page.tsx`,
`app/business/page.tsx` (see Risks — a future enhancement, not this task).

## Design decisions (resolving the four questions)

### 1. Function signatures — `lib/business-quarter-forecast.ts`

Pure, no DB/Prisma-client imports beyond the `Decimal` type, no `"use server"`
— mirrors the header convention of `spend-forecast.ts`/`forecast-rollup.ts`
exactly. It does **not** import from `spend-forecast.ts` (different period
grain — quarters vs. months — and the task says treat that file as a stable,
unmodified dependency; duplicating ~15 lines of blend math is cheaper than
coupling two independently-evolving modules). Money: `Decimal` from
`@prisma/client/runtime/library`, never floats, matching both prior forecast
modules.

```ts
// ── Quarter calendar helpers ────────────────────────────────────────────────

/** "YYYY-Q1".."YYYY-Q4" — validated with /^\d{4}-Q[1-4]$/, string-sortable
 *  lexicographically as-is (same trick spend-forecast.ts uses for "YYYY-MM"). */
export function getQuarterForDate(date: Date): string;

export interface QuarterBounds {
  start: Date; // UTC midnight, first day of the quarter
  end: Date;   // UTC 23:59:59, last calendar day of the quarter (inclusive,
               // matching computePL's inclusive `lte` toDate convention as
               // used in app/business/[slug]/pl/page.tsx's yearEnd)
}
export function getQuarterBounds(quarter: string): QuarterBounds;

/** Most-recent-first list of `count` quarter keys strictly before `quarter`,
 *  correctly rolling over year boundaries (prior of "2026-Q1" is "2025-Q4"). */
export function getPriorQuarters(quarter: string, count: number): string[];

// ── Types ────────────────────────────────────────────────────────────────────

export const DEFAULT_TAX_RESERVE_PCT = 30; // percent; single source of truth,
  // referenced by lib/settings.ts's fallback and the UI's "(default)" label.

/** One prior, ALREADY-CONCLUDED quarter's totals for one entity, as returned
 *  by computePL() for that quarter's full date range.
 *  IMPORTANT CONTRACT (deviates from spend-forecast's MonthlySpendPoint on
 *  purpose — see doc comment in the file): omit a quarter entirely if
 *  computePL returned no GL-coded lines at all for it (grouped.length === 0,
 *  i.e. pl.incomeLines.length === 0 && pl.expenseLines.length === 0) — that
 *  signals the entity had no coded activity that quarter (most likely it
 *  didn't exist yet), not that it broke even. A quarter where the entity was
 *  operating but genuinely had $0 income and some coded expenses IS included
 *  (that's real signal, not missing data) — computePL only returns empty
 *  arrays for the "nothing at all" case, so this distinction falls out for
 *  free from its existing return shape.
 */
export interface QuarterlyPLPoint {
  quarter: string; // "YYYY-Q1".."YYYY-Q4"
  totalIncome: Decimal;   // unsigned, matches PLReport.totalIncome
  totalExpenses: Decimal; // unsigned, matches PLReport.totalExpenses
}

export type QuarterForecastMethod = "blended" | "pace_only";
export type QuarterForecastConfidence = "low" | "medium" | "high";

export interface LineForecast {
  actualToDate: Decimal;           // unsigned
  paceProjection: Decimal;         // unsigned; actualToDate * daysInQuarter / daysElapsed
  trailingAverage: Decimal | null; // unsigned baseline; null if no qualifying history
  projectedTotal: Decimal;         // unsigned — headline per-line number
}

export interface QuarterlyBusinessForecast {
  quarter: string;
  daysElapsed: number;   // clamped to [1, daysInQuarter]
  daysInQuarter: number;
  income: LineForecast;
  expenses: LineForecast;
  actualNetIncomeToDate: Decimal; // signed = income.actualToDate - expenses.actualToDate
  projectedNetIncome: Decimal;    // signed = income.projectedTotal - expenses.projectedTotal
  trailingQuartersUsed: number;   // 0..trailingQuarters — SHARED by both lines
                                   // (computed once from the same history set,
                                   // so income/expenses never disagree on
                                   // confidence — simpler than spend-forecast's
                                   // single-series case because this module
                                   // always evaluates two series from ONE
                                   // synchronized set of history points)
  method: QuarterForecastMethod;
  confidence: QuarterForecastConfidence;
}

/**
 * Projects where the CURRENT, in-progress quarter's income and expenses will
 * land by quarter-end, blending linear day-count pace extrapolation against a
 * trailing-average baseline — same algorithm as
 * spend-forecast.ts#projectPeriodEndSpend, applied independently to the
 * income and expense lines of a P&L instead of a single tag's spend.
 * Observational only — see ground rule 8 caveat in the doc comment (callers
 * must render "on pace for ~$X", never "you will net $X").
 */
export function projectQuarterEndPL(opts: {
  quarter: string;                 // "YYYY-Q1".."YYYY-Q4" being forecast
  actualToDate: { totalIncome: Decimal; totalExpenses: Decimal }; // unsigned, from computePL(entityId, quarterStart, asOfDate)
  asOfDate: Date;
  history: QuarterlyPLPoint[];     // any order/length; duplicate quarters
                                    // (last wins) and current/future quarters
                                    // are filtered internally
  trailingQuarters?: number;       // default 4
}): QuarterlyBusinessForecast;

/** Exported for direct unit testing, mirrors spend-forecast's
 *  computeTrailingAverage but averages BOTH totalIncome and totalExpenses
 *  over the same selected set of quarters (so both lines share one
 *  quartersUsed count). */
export function computeTrailingQuarterlyAverages(
  history: QuarterlyPLPoint[],
  quarter: string,
  trailingQuarters: number
): { incomeAverage: Decimal | null; expenseAverage: Decimal | null; quartersUsed: number };

// ── Tax reserve estimate (percentage-based; NO bracket/SE-tax math) ─────────

export interface TaxReserveEstimate {
  reservePct: Decimal;   // e.g. 30 meaning 30% — echoes the rate used
  reserveBasis: Decimal; // projectedNetIncome clamped at 0 (never reserve
                          // against a projected loss)
  reserveAmount: Decimal; // reserveBasis * reservePct / 100
}

/** Pure percentage multiply. Throws on a negative reservePct. Does NOT
 *  compute tax brackets, self-employment tax, or any IRS-specific figure —
 *  this is a flat "reserveBasis × pct" cash-planning heuristic only. */
export function computeTaxReserveEstimate(
  projectedNetIncome: Decimal,
  reservePct: Decimal
): TaxReserveEstimate;
```

Internal (unexported) helpers, mirroring `spend-forecast.ts`'s
`daysInPeriodMonth`/`daysElapsedInPeriod`: `daysInQuarterCalendar(quarter)` and
`daysElapsedInQuarter(quarter, asOfDate)` (same floor-at-1 / cap-at-max
behavior, computed from `getQuarterBounds`).

`Decimal.max` is not relied on for the reserve clamp — use an explicit
`projectedNetIncome.greaterThan(0) ? projectedNetIncome : new Decimal(0)`
ternary so there's no dependency on a decimal.js static helper that may or
may not be re-exported identically from `@prisma/client/runtime/library`.

Note on the task's phrasing: the task description says
`computePL(entityId, dateRange)`. The actual, already-merged signature (read
directly from `lib/reports.ts`) is `computePL(entityId: string, fromDate: Date,
toDate: Date): Promise<PLReport>` — two separate `Date` args, not a
`dateRange` object. The Coder should call it that way; this is a
documentation-phrasing mismatch in the task prompt, not a real ambiguity.

### 2. Reserve percentage storage — per-entity, via the existing `AppSetting` table

`prisma/schema.prisma` already has:
```prisma
model AppSetting {
  key   String @id
  value String
}
```
with `lib/settings.ts` as the thin typed-wrapper layer over it (confirmed
pattern: `getLogoMeta`/`setLogoMeta`, `getFaviconMeta`/`setFaviconMeta`, each
just a `getAppSetting`/`setAppSetting` pair under a fixed key). **No schema
change, no migration.** Add to `lib/settings.ts`:

```ts
import { DEFAULT_TAX_RESERVE_PCT } from "@/lib/business-quarter-forecast";

function taxReservePctKey(entityId: string): string {
  return `business_tax_reserve_pct:${entityId}`;
}

export async function getEntityTaxReservePct(
  entityId: string
): Promise<{ pct: number; isDefault: boolean }> {
  const raw = await getAppSetting(taxReservePctKey(entityId));
  if (raw === null) return { pct: DEFAULT_TAX_RESERVE_PCT, isDefault: true };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { pct: DEFAULT_TAX_RESERVE_PCT, isDefault: true };
  return { pct: parsed, isDefault: false };
}

export async function setEntityTaxReservePct(entityId: string, pct: number): Promise<void> {
  await setAppSetting(taxReservePctKey(entityId), String(pct));
}
```

**Reasoning for per-entity (not household-wide):** EK Consulting (Schedule C,
subject to self-employment tax) and Sudden Valley (Schedule E rental, not
subject to SE tax) have structurally different effective tax pictures — a
single household-wide flat percentage would be a worse approximation than one
knob per entity, and per-entity costs nothing extra given `AppSetting` is
already a flat key/value store (the key just needs a stable, collision-free
prefix, which `business_tax_reserve_pct:{entityId}` provides). This keeps
`setEntityTaxReservePct` a plain wrapper, not a new mutation surface in
`lib/settings.ts` — the actual `"use server"` boundary is
`actions/business-forecast.ts`, per the confirmed convention that only
`actions/*.ts` performs auth-gated mutations.

`actions/business-forecast.ts`:
```ts
"use server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { setEntityTaxReservePct as saveTaxReservePct } from "@/lib/settings";
import { revalidatePath } from "next/cache";

async function requireAuth() { /* same pattern as actions/reports.ts */ }

const schema = z.object({
  entityId: z.string().uuid(),
  pct: z.number().min(0).max(100),
});

export async function setEntityTaxReservePct(
  input: z.input<typeof schema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  await saveTaxReservePct(parsed.data.entityId, parsed.data.pct);
  revalidatePath("/business/[slug]/pl", "page");
  return { success: true };
}
```

### 3. Page placement — extend the existing P&L page

Add a new "Quarter-End Forecast" `Card` section to
`app/business/[slug]/pl/page.tsx`, placed after the existing "Net Income"
card and before its closing caveat paragraph. Rationale: this feature is
directly about projecting *net income*, which is exactly what the P&L page
already displays (unlike cash-flow, which is inflow/outflow, not GL-coded
net income) — extending it keeps one canonical place for "how is this
entity's income doing," consistent with the confirmed RSC convention that
math is done server-side in the page and client components only hold
toggle/form state (`spend-pace-section.tsx` is the exact precedent: server
page computes plain-number rows, hands them to a presentational component,
one small client leaf for interactivity).

**Gating (resolves entity scope without hardcoding slugs):** compute
`const hasIncomeGl = await db.glCode.count({ where: { entityId: entity.id, type: "income" } }) > 0;`
and only run the forecast queries / render the section when `hasIncomeGl` is
true. This is data-driven rather than a slug allowlist — it naturally
includes `ek-consulting` and `sudden-valley` (both seeded with `type:
"income"` GL codes — verified in `prisma/seed.ts`) and naturally excludes
`mezzo` (seeded with expense-only codes, no income code — verified in the
same file), without ever hardcoding "mezzo" as a special case. If a future
entity is added with real income GL codes, it picks up the forecast
automatically with zero code changes — this is the concrete resolution to
the "Mezzo — use your judgment" instruction: **no forecast section renders
for Mezzo, and nothing else changes for it.**

Note on `GlCode.type` values: the schema's inline comment
(`type String // asset | liability | equity | revenue | expense`) is stale —
the actual seeded/used values (confirmed in `prisma/seed.ts` and
`lib/reports.ts#computePL`, which checks `gl.type === "income"`) are
`"income"` and `"expense"`, not `"revenue"`. Use `"income"` in the gate
query. Not fixing the stale comment — out of scope.

Page-level orchestration (inline in the RSC, no new data-fetching action per
the confirmed "actions are for mutations only" convention):

```ts
if (hasIncomeGl) {
  const asOfDate = new Date();
  const quarter = getQuarterForDate(asOfDate);
  const currentBounds = getQuarterBounds(quarter);

  const [currentPl, ...priorPls] = await Promise.all([
    computePL(entity.id, currentBounds.start, asOfDate),
    ...getPriorQuarters(quarter, 4).map((q) => {
      const b = getQuarterBounds(q);
      return computePL(entity.id, b.start, b.end).then((pl) => ({ quarter: q, pl }));
    }),
  ]);

  const history: QuarterlyPLPoint[] = priorPls
    .filter(({ pl }) => pl.incomeLines.length > 0 || pl.expenseLines.length > 0)
    .map(({ quarter, pl }) => ({ quarter, totalIncome: pl.totalIncome, totalExpenses: pl.totalExpenses }));

  const forecast = projectQuarterEndPL({
    quarter,
    actualToDate: { totalIncome: currentPl.totalIncome, totalExpenses: currentPl.totalExpenses },
    asOfDate,
    history,
  });

  const { pct, isDefault } = await getEntityTaxReservePct(entity.id);
  const reserve = computeTaxReserveEstimate(forecast.projectedNetIncome, new Decimal(pct));
  // ... pass forecast + reserve + isDefault, all converted to plain numbers, to the Card JSX
}
```

This resolves the `priorPls` typing awkwardness (`Promise.all` with mixed
return shapes) — the Coder should type this carefully or restructure into two
separate `Promise.all` calls (one for `currentPl`, one for the prior-quarter
array) if the inline destructuring above proves awkward in practice; either
is fine, this is an implementation detail, not a contract.

Presentational pieces:
- The forecast card's static rendering (income/expenses/net rows, confidence
  badge, caveat copy) is inlined directly in `pl/page.tsx` alongside the
  existing Income/Expenses/Net cards — no new file needed purely for display,
  matching how those existing cards are already inlined in that file (adding
  a whole new component file for ~40 lines of JSX that's used in exactly one
  place would be over-engineering relative to this codebase's existing
  style in this specific file).
- **The one genuinely interactive piece** — editing the reserve percentage —
  is its own `"use client"` component, `components/business/tax-reserve-pct-form.tsx`,
  holding only `useState`/`useTransition` for the input and calling
  `setEntityTaxReservePct`, then `router.refresh()` — directly mirroring
  `components/settings/entities-client.tsx`'s existing pattern.
- Confidence badge: reuse the exact visual pattern from
  `components/forecast/spend-pace-section.tsx`'s `StatusBadge` (low →
  "Not enough history yet" muted badge) — either factor a tiny shared badge
  or duplicate the ~10 lines locally in `pl/page.tsx`; duplication is
  acceptable here per the "don't modify existing forecast files" constraint
  (that badge lives in a component file scoped to `app/forecast/page.tsx`,
  not a shared UI primitive).

Required UI copy (verbatim intent, wording may be adjusted for tone but must
preserve every substantive point):
> "Rough cash-reserve estimate based on a flat percentage of projected net
> income — not a computed tax liability. Doesn't account for tax brackets,
> self-employment tax, deductions, or your household's full return. Confirm
> the right rate and any required estimated payments with your CPA."

For Sudden Valley specifically, an additional line (data-driven — the same
`hasIncomeGl`/entity-scoped check the Coder already has can key off
`entity.slug === "sudden-valley"`, or better, off whether the entity's GL
chart came from a placeholder — simplest concrete signal: hardcode the one
sentence for `sudden-valley` since that entity's placeholder-GL status is a
known, stated fact from the spec, not something to derive generically):
> "Sudden Valley's chart of accounts is still a placeholder, not yet
> reconciled against a CPA/QuickBooks export — treat these figures as rough."

### 4. Low-history entities — don't overstate, don't suppress

Same principle as `spend-forecast.ts`: **always compute and show a number**,
never hide the card outright just because history is thin — but flag it
honestly. Concretely:
- `history` naturally ends up empty (or short) for a first-quarter entity or
  one with sparse GL coding, because of the omission contract in
  `QuarterlyPLPoint`'s doc comment (only quarters with real computePL
  activity are included).
- `projectQuarterEndPL` then falls back to `method: "pace_only"` and
  `confidence: "low"` (0 qualifying prior quarters) or `"medium"` (some but
  fewer than `trailingQuarters`) — exactly the same three-tier logic as
  `spend-forecast.ts`.
- The UI's confidence badge on "low" reads "Not enough history yet" (same
  copy as the existing spend-pace card) and the headline projected numbers
  get a leading `~` (same visual convention as `SpendPaceSection` row 91:
  `{row.confidence === "low" ? "~" : ""}`).
- The reserve estimate is still computed and shown even at low confidence
  (a rough number is still useful for cash planning), but inherits the same
  `~` treatment and sits directly under the same caveat paragraph.

## Risks / unknowns

1. **Real trailing-quarter data volume is unverified.** I have not queried
   the live database for how many quarters of real GL-coded transactions
   exist for EK Consulting or Sudden Valley as of 2026-09-12 (today, mid
   Q3 2026) — it's plausible Sudden Valley (formed ~Feb 2026 per spec 07 item
   8's implication and the seed's "first tax year" notes) has only 1–2
   qualifying prior quarters, which the module handles gracefully
   (low/medium confidence) but the Coder/Tester should sanity-check the
   *rendered* numbers against reality during manual verification, not just
   trust that the pure function's unit tests pass.
2. **No bracket/SE-tax math — confirmed, by design, not a gap.** The reserve
   estimate is `max(projectedNetIncome, 0) × userPct / 100`. Nothing more.
   This is explicitly called out as the ground-rule-driven scope boundary
   from the task; a future task could add Form 1040-ES safe-harbor
   comparisons once there's a verified source of truth for the relevant
   IRS figures, but that is NOT part of this task and should not be
   silently added.
3. **`GlCode.type` schema comment is stale** (says `revenue`, actual value
   used everywhere is `income`) — noted for the Coder so they don't
   accidentally gate on the wrong string; not fixed as part of this task
   (out of scope, unrelated pre-existing inconsistency).
4. **Business overview page (`app/business/page.tsx`) is intentionally left
   untouched.** It already shows a month-to-date P&L tile per entity; adding
   a quarter-forecast summary there too would be a reasonable follow-on but
   duplicates/competes with the P&L page's new section for the "where do I
   look" question. Recommend as a future enhancement, not building it now to
   keep this task's footprint minimal per the repo's established pattern of
   avoiding scope creep.
5. **Seasonality is not modeled.** Sudden Valley is an Airbnb rental —
   summer quarters plausibly run far hotter than winter quarters. A
   trailing-average blend (this task) will systematically over-project a
   slow quarter that follows a hot one and vice versa. This mirrors
   `spend-forecast.ts`'s own accepted, documented limitation (front/back
   -loaded spend) rather than being a new problem — not fixing it now, but
   flagging that a same-quarter-last-year seasonal model would be a
   meaningfully better fit for Sudden Valley specifically, as a future
   enhancement.
6. **UI requires human visual verification.** No pipeline agent has browser
   access. A human must load `/business/ek-consulting/pl` and
   `/business/sudden-valley/pl` in a running dev server and visually confirm
   the new section renders sensibly (numbers, badge states, the percentage
   edit form actually persists across a refresh) before this is considered
   truly done — `pnpm typecheck`/`lint`/`test` passing does not substitute
   for this.
7. **`AppSetting` has no per-key validation/typing at the schema level** —
   the `business_tax_reserve_pct:{entityId}` key is a convention enforced
   only in `lib/settings.ts`, not a foreign key or constraint. This matches
   the existing precedent (`logo_key`/`favicon_key` are equally untyped) so
   it's consistent with the codebase, not a new weakness introduced here.

## Acceptance criteria

- [ ] `lib/business-quarter-forecast.ts` exports `getQuarterForDate`,
      `getQuarterBounds`, `getPriorQuarters`, `projectQuarterEndPL`,
      `computeTrailingQuarterlyAverages`, `computeTaxReserveEstimate`, and
      `DEFAULT_TAX_RESERVE_PCT`, with the exact shapes specified above. No
      DB/Prisma-client import, no `"use server"`, `Decimal` used for all
      money fields.
- [ ] `projectQuarterEndPL` correctly floors `daysElapsed` at 1 and caps at
      `daysInQuarter`, never divides by zero, never produces `NaN`/`Infinity`.
- [ ] `computeTaxReserveEstimate` never returns a positive reserve amount
      when `projectedNetIncome` is negative or zero (clamped basis), and
      throws on a negative `reservePct`.
- [ ] `getPriorQuarters`/`getQuarterBounds` correctly roll over year
      boundaries (prior of `"2026-Q1"` is `"2025-Q4"`) and correctly compute
      quarter length across a leap-year Q1 (91 days) vs. non-leap Q1
      (90 days).
- [ ] `lib/settings.ts`'s `getEntityTaxReservePct` returns
      `{ pct: 30, isDefault: true }` when no `AppSetting` row exists for that
      entity, and returns the stored value with `isDefault: false` after
      `setEntityTaxReservePct` has been called.
- [ ] `actions/business-forecast.ts#setEntityTaxReservePct` calls
      `requireAuth()` first, rejects `pct` outside `[0, 100]` via zod, and
      persists via `lib/settings.ts`.
- [ ] `app/business/[slug]/pl/page.tsx` renders a "Quarter-End Forecast"
      section for `ek-consulting` and `sudden-valley` (entities with at least
      one `type: "income"` `GlCode` row) and does NOT render it for `mezzo`.
- [ ] The rendered section shows: current quarter label + days elapsed/total,
      actual-to-date and projected income/expenses/net income, a confidence
      badge, the tax-reserve estimate with its editable percentage, and the
      required caveat copy (plus the Sudden Valley placeholder-GL caveat on
      that entity's page specifically).
- [ ] No schema/migration changes (`prisma/schema.prisma` untouched).
- [ ] `lib/reports.ts`, `lib/spend-forecast.ts`, `lib/forecast-rollup.ts`
      public APIs are untouched (diff should show zero changes to their
      exported signatures).
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass clean; full
      suite grows from the 331/331 baseline with zero regressions.
- [ ] A human has visually verified both entities' P&L pages in a running
      dev server (see Risk 6) — record this explicitly in the test report
      rather than silently assuming it from automated tests passing.

## Test expectations

All new logic is pure and unit-tested in
`lib/__tests__/business-quarter-forecast.test.ts` (Vitest, no DB, `Decimal`
assertions, `D = (s) => new Decimal(s)` / `d = (iso) => new Date(iso +
"T00:00:00Z")` local helpers — same style as
`lib/__tests__/spend-forecast.test.ts`). No DB-touching wrapper exists in the
new lib file (all orchestration lives inline in the page per Design Decision
3), so — consistent with the repo's "pure-decision-module pattern" — there is
nothing DB-touching in this file left untested by design; the page itself is
covered only by human visual verification (Risk 6), not an automated test,
matching how `app/forecast/page.tsx` is not itself unit tested.

Worked test cases (exact expected values the Coder should reproduce and the
Tester should re-derive independently, not just trust):

1. **Steady state — pace and trailing average agree exactly (mirrors
   spend-forecast Test 1).** Quarter `"2026-Q3"` (Jul 1–Sep 30 = 92 days).
   `asOfDate = 2026-08-15` → `daysElapsed = 46` (day 46 of 92), 4 history
   quarters each with `totalIncome: 90000, totalExpenses: 54000`.
   `actualToDate = { totalIncome: 45000, totalExpenses: 27000 }` (exactly
   half the quarterly average, matching the elapsed fraction).
   Expect: `income.paceProjection = 90000`, `income.trailingAverage = 90000`,
   `income.projectedTotal = 90000`; `expenses.paceProjection = 54000`,
   `expenses.trailingAverage = 54000`, `expenses.projectedTotal = 54000`;
   `projectedNetIncome = 36000`; `actualNetIncomeToDate = 18000`;
   `method = "blended"`; `confidence = "high"`; `trailingQuartersUsed = 4`.

2. **Front-loaded income lump early in the quarter — blend damps the wild
   pace signal (mirrors spend-forecast Test 2, applied to the income line).**
   Same quarter, `asOfDate = 2026-07-10` → `daysElapsed = 10`,
   `daysRemaining = 82`. 4 history quarters each with `totalIncome: 9200,
   totalExpenses: 27600`. `actualToDate = { totalIncome: 9200, totalExpenses:
   3000 }` (a large early lump — e.g. an Airbnb prepaid summer booking).
   Expect: `income.paceProjection = 84640` (`9200 × 92 / 10`),
   `income.trailingAverage = 9200`,
   `income.projectedTotal = 17400` (`(84640×10 + 9200×82) / 92`) — i.e. the
   blend pulls the naive $84,640 pace projection down to $17,400, and
   `income.projectedTotal < income.paceProjection` must hold.
   `expenses.paceProjection = 27600` (`3000 × 92 / 10`),
   `expenses.trailingAverage = 27600`, `expenses.projectedTotal = 27600`
   (pace and average coincide here by construction).
   `projectedNetIncome = -10200` (`17400 - 27600`); `actualNetIncomeToDate =
   6200` (`9200 - 3000`) — note the sign flips between actual-to-date
   (positive) and projected (negative), which is the whole point of the test:
   an early lump looks great in isolation but the projection correctly
   discounts it once blended against normal expense timing.

3. **Back-loaded expenses + zero-revenue entity in one case (mirrors
   spend-forecast Test 3, plus the required "entity with zero revenue" edge
   case).** Same quarter, `asOfDate = 2026-08-15` → `daysElapsed = 46`,
   `daysRemaining = 46`. 4 history quarters each with `totalIncome: 0,
   totalExpenses: 27600`. `actualToDate = { totalIncome: 0, totalExpenses:
   100 }` (a large annual bill — e.g. insurance — hasn't posted yet).
   Expect: `income.paceProjection = 0`, `income.trailingAverage = 0`,
   `income.projectedTotal = 0` (entity has no revenue this quarter or
   historically — this is the zero-revenue edge case, and it must not throw
   or divide by zero). `expenses.paceProjection = 200` (`100 × 92 / 46`),
   `expenses.trailingAverage = 27600`, `expenses.projectedTotal = 13900`
   (`(200×46 + 27600×46) / 92`) — the pace signal (200) is far too low
   because the big bill hasn't posted; the blend pulls it up toward the
   historical norm but still under-projects relative to the known $27,600
   pattern — same accepted, documented limitation as spend-forecast Test 3.
   `projectedNetIncome = -13900`; `confidence = "high"`.
   Then feed `projectedNetIncome = -13900` into `computeTaxReserveEstimate`
   with `reservePct = 30`: expect `reserveBasis = 0` (clamped, never reserve
   against a projected loss) and `reserveAmount = 0`.

4. **No history at all — first quarter of operation (mirrors spend-forecast
   Test 4).** Quarter `"2026-Q1"` (Jan 1–Mar 31 = 90 days, 2026 is not a leap
   year). `asOfDate = 2026-01-30` → `daysElapsed = 30`, `history = []`.
   `actualToDate = { totalIncome: 15000, totalExpenses: 9000 }`.
   Expect: `income.trailingAverage = null`, `income.paceProjection = 45000`
   (`15000 × 90 / 30`), `income.projectedTotal = 45000`;
   `expenses.paceProjection = 27000` (`9000 × 3`), `expenses.projectedTotal =
   27000`; `projectedNetIncome = 18000`; `method = "pace_only"`;
   `confidence = "low"`; `trailingQuartersUsed = 0`.
   Also assert: `actualToDate = { totalIncome: 0, totalExpenses: 0 }` at
   `asOfDate = 2026-01-01` (quarter's first day) produces `daysElapsed = 1`
   (floored, not 0) and every `Decimal` output `.isZero()`, none `.isNaN()`
   or non-`.isFinite()`.

5. **Already-complete quarter — projected total equals the known actual
   (mirrors spend-forecast Test 6).** Quarter `"2025-Q4"` (Oct 1–Dec 31 = 92
   days). `asOfDate = 2026-02-01` (well after quarter end).
   `actualToDate = { totalIncome: 50000, totalExpenses: 30000 }`.
   Expect: `daysElapsed = 92` (capped, not overflowing past `daysInQuarter`),
   `income.projectedTotal = 50000`, `expenses.projectedTotal = 30000`,
   `projectedNetIncome = 20000` — the projection must not inflate or deflate
   a period that's already fully realized, regardless of `history` content.

6. **Invalid quarter format throws.** `"2026-Q5"`, `"2026-05"`, `""`,
   `"Q1 2026"` all throw from `projectQuarterEndPL` and from
   `getQuarterBounds`.

7. **Leap-year quarter length.** `getQuarterBounds("2028-Q1")` spans Jan 1–Mar
   31, 2028 inclusive (2028 is a leap year) → 91 days total (`daysInQuarter`
   as surfaced via `projectQuarterEndPL` with any `asOfDate` inside it), vs.
   `getQuarterBounds("2026-Q1")` → 90 days (non-leap). Also assert Q2 = 91
   days, Q3 = 92 days, Q4 = 92 days for a normal (non-leap) year, as a
   direct sanity check of the internal day-counting helper.

8. **`getPriorQuarters` year-boundary rollover.**
   `getPriorQuarters("2026-Q1", 4)` → `["2025-Q4", "2025-Q3", "2025-Q2",
   "2025-Q1"]`. `getPriorQuarters("2026-Q3", 2)` → `["2026-Q2", "2026-Q1"]`.

9. **`getQuarterForDate` boundaries.** `2026-09-12` → `"2026-Q3"`;
   `2026-01-01` → `"2026-Q1"`; `2026-12-31` → `"2026-Q4"`; `2026-03-31` →
   `"2026-Q1"`; `2026-04-01` → `"2026-Q2"`.

10. **`computeTrailingQuarterlyAverages` directly** (mirrors
    `computeTrailingAverage`'s own describe block in
    `spend-forecast.test.ts`): dedupes a repeated quarter entry (last one
    wins); excludes the current/target quarter and any future quarters;
    caps at `trailingQuarters`, keeping the most recent qualifying entries;
    returns `{ incomeAverage: null, expenseAverage: null, quartersUsed: 0 }`
    for empty input and for `trailingQuarters <= 0`.

11. **`computeTaxReserveEstimate` directly.**
    `(D("40000"), D("30"))` → `reserveBasis = 40000, reserveAmount = 12000`.
    `(D("-5000"), D("30"))` → `reserveBasis = 0, reserveAmount = 0`.
    `(D("40000"), D("0"))` → `reserveAmount = 0`.
    `(D("40000"), D("-5"))` → throws.

No integration/DB tests are added (consistent with this repo's established
"no integrated DB tests — mock at the function boundary" convention); the
page-level wiring is verified only by the human visual check in Risk 6 /
Acceptance criteria's last item.
