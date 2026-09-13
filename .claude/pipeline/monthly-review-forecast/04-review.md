# Review: monthly-review-forecast

## Verdict: APPROVED

## Summary for the owner

Before this change, the monthly review your household actually receives (the
one the cron job generates automatically, every month, unattended) was being
computed by a second, silently-drifted copy of the review logic that nobody
was maintaining in step with the "Generate/Regenerate" button's version. Three
concrete things were wrong in the cron-generated review specifically:

1. **Internal transfers were being counted as spending.** Moving money between
   your own accounts (e.g. a reimbursement through THE COTTAGE) was inflating
   the "actual spend" numbers in the automated review, even though the
   button-triggered version already excluded these correctly.
2. **Accrual envelope pacing (e.g. property tax, insurance reserves) was
   checked against the wrong month.** The cron job always reviews *last*
   month, but it was pro-rating the annual target using *this* month's
   calendar position instead — so the "on track / behind" signal for accruals
   was consistently off by one month's worth of target every time it ran.
3. **Business entity names were being truncated** in cron-generated reviews
   (e.g. "Sudden Valley Property Management" instead of the full legal name)
   while the button-triggered version showed the full name — cosmetic, but
   inconsistent.

All three are now fixed by consolidating both paths (the button and the cron
job) onto one shared piece of code (`lib/monthly-review-build.ts`), so there's
only one implementation to keep correct going forward, and it's the one that
already had the right behavior for these three things.

On top of that fix, the review now also shows two new things:
- **A forward projection** next to each budget line ("on pace to land at $X"),
  not just "spent so far."
- **A retrospective accuracy check**: for last month, it shows what the
  projection model would have estimated partway through the month, next to
  what actually happened, for the handful of categories where the difference
  was large enough to matter (small differences are filtered out so this
  doesn't turn into a wall of numbers every month).

I independently re-ran `pnpm typecheck`, `pnpm lint`, and the full test suite
(381/381 tests, 33 files) and confirmed the Coder's and Tester's numbers are
accurate — not just trusting the write-ups. I also read every changed file
and the two new lib modules line by line, rather than reviewing off the
summaries.

## Findings

### Blocking
None.

### Should-fix
None — nothing here needs to hold up shipping.

### Nit
- **The plan's own disclosure list of "bundled fixes" (Risks/unknowns #3) is
  incomplete, and this should be noted for the record even though it doesn't
  block shipping.** The consolidation also silently carries over two more
  behavior changes to cron-generated reviews beyond the three the plan named:
  - Accrual status thresholds moved from `pct < 70 ⇒ behind / < 90 ⇒ watch`
    (old cron logic) to `pct >= 90 ⇒ on_track / pct >= 60 ⇒ watch` (kept
    `actions/monthly-review.ts` logic) — a `pct` in `[60, 70)` now shows
    "watch" instead of "behind" in cron-generated reviews.
  - `budgetHealth.status` boundary logic moved from `>= 100 ⇒ over, >= 80 ⇒
    warning` (old cron) to `> 100 ⇒ over, > 80 ⇒ warning` (kept version) — a
    tag at exactly 100% or exactly 80% used now falls one tier lower in
    cron-generated reviews than it did before.
  Both are squarely covered by the plan's Step 3 instruction to move the
  account-snapshot/upcoming-bills/accrual-status block "unchanged" from
  `actions/monthly-review.ts` (the version explicitly chosen to keep), so this
  is a sanctioned, deliberate part of the plan's own resolution — not an
  accidental side effect introduced by the Coder. It is not architecturally
  wrong: keeping one canonical threshold set instead of two drifted ones is
  the entire point of this consolidation, and the numbers involved are minor
  boundary shifts, not a correctness bug. It's a documentation gap in the
  plan's own risk disclosure, not a code defect — worth naming explicitly here
  since neither of the two threshold deltas were called out by name in
  `01-plan.md`, only the transferPairId/accrual-month/entity-name trio were.
  No action needed; this is a record-keeping note, not a request for changes.
- `selectNotableAccuracyRows`'s test 2 ("drops a row at/below
  MIN_NOTABLE_MISS_AMOUNT") only exercises a value strictly below the $10
  floor (`missAbs: "5"`), not the exact boundary (`missAbs: "10"`). The
  behavior is correct (`greaterThan`, confirmed by reading the source), but
  the boundary itself isn't asserted. Not blocking.

## What I verified directly (not just trusted from the write-ups)

1. **Consolidation correctness.** Read the full diffs of `actions/monthly-review.ts`
   and `app/api/cron/monthly-review/route.ts` against `main`. Both now contain
   zero inline query/computation logic for budgetHealth/accountSnapshot/
   upcomingBills/accrualStatus — both call `await buildMonthlyReviewData(period)`
   and differ only in their own auth mechanism and upsert/notification
   side effects, exactly as planned. No lingering duplicate logic in either file.

2. **Retrospective accuracy is not retroactively omniscient.** Read
   `lib/review-forecast.ts` and the retrospective block in
   `lib/monthly-review-build.ts` directly. `reconstructForecastAccuracy` calls
   `projectPeriodEndSpend` with `asOfDate: periodMidpointDate(period)` and only
   the caller-supplied `spendAtMidpoint` (a Decimal computed by the caller from
   a `priorStart..midpointExclusive`-bounded query) and `history` (bounded
   `historyStart..priorStart`, i.e. strictly before the evaluated period).
   `actualFinal` — the real, now-known outcome — is passed in separately and
   is used only *after* the projection is computed, purely for comparison
   (`missAbs`, `percentOff`, `direction`). It never feeds into
   `projectPeriodEndSpend`'s inputs. This property holds on direct code
   inspection, independent of the Tester's own confirmation.

3. **The 70/90 → 60/90 accrual threshold change is sanctioned by the plan**
   (Step 3: "move unchanged from `actions/monthly-review.ts`'s current logic
   — this is the version to keep"), confirmed by reading both the plan and
   the actual before/after threshold code in the diff. It's a real, disclosed
   (if imprecisely itemized) consequence of the consolidation, not an
   accidental regression — see the nit above for the itemization gap.

4. **Ground rule 8.** Read the actual shipped copy in
   `app/review/[year]/[month]/page.tsx`: the projected-column values are bare
   numbers/percentages with an optional confidence label; the Forecast
   accuracy card's intro text explicitly hedges ("what the current projection
   model would have estimated... not necessarily what was shown to you at the
   time"); per-row notes (`"Projected higher than actual"` / `"Projected lower
   than actual"` / `"Close match"`) are purely descriptive. No imperative or
   advice-flavored language anywhere in the diff.

5. **Old-row backward compatibility.** Read the actual guard code, not just
   the Tester's description: `b.projectedCents != null && b.projectedPercentUsed != null`
   (loose `!=` against `null` correctly treats `undefined` as falsy, so a
   pre-existing stored row missing these fields renders `—` rather than
   `$0`/`NaN`), and `data.forecastAccuracy && data.forecastAccuracy.length > 0`
   (an `undefined` field on an old row short-circuits to the muted empty-state
   note, not a crash). Both confirmed correct on direct read.

6. **Independent command re-run** (per this repo's established review
   practice): `pnpm typecheck` — clean; `pnpm lint` — 44 warnings/0 errors,
   all in files untouched by this task (cross-checked by grep against the
   file list); `pnpm test` — 381/381 passed across 33 files. Matches the
   Coder's and Tester's reported numbers exactly.

7. **Scope discipline.** Ran `git status --porcelain -uall` and
   `git diff --stat` against unrelated modified files
   (`actions/reports.ts`, `app/business/...`, `components/app-sidebar.tsx`,
   the bank-statements feature). Confirmed these are pre-existing, unrelated
   in-flight work from other tasks and none of this diff bled into them.
   `lib/spend-forecast.ts` and `lib/budget-pace.ts` are byte-identical to
   `main` (empty `git diff --stat`), matching the plan's explicit "do not
   modify" requirement. `prisma/schema.prisma` unmodified, and the only
   migration in the working tree is the unrelated pre-existing
   `20260908120000_bank_statements` one.

## Code quality

Clean and consistent with the rest of the codebase: Decimal used throughout
`lib/review-forecast.ts` and the retrospective/forward math in
`lib/monthly-review-build.ts`, with cents conversion (`Math.round(x.toNumber() * 100)`)
happening only at the JSON-storage boundary, matching CLAUDE.md's money
convention. The new `queryTagSpend`/`queryTagHistory`/`monthBounds` helpers
correctly factor out the repeated query shapes without over-abstracting (the
forward-projection block's decision to keep its own inline `tagSpendRows`
query rather than force-fit `queryTagSpend`'s Decimal-only return shape is a
reasonable, explicitly justified call, not sloppiness). No dead code, no
leftover debug statements, no `any`.

## Test quality

The 19 new tests in `lib/__tests__/review-forecast.test.ts` are substantive,
not superficial: exact worked Decimal values for every
`reconstructForecastAccuracy` branch (exact/under/over/low-confidence/
div-by-zero-guard), and `selectNotableAccuracyRows` is tested for its
confidence filter, magnitude floor, cap-and-sort ordering, empty input, and
custom-options override — matching the plan's Step 2 enumeration exactly. I
independently re-derived the algebra for the under/over cases by hand and it
matches. `buildMonthlyReviewData` itself is correctly left untested per this
repo's established DB-touching-code convention (pure logic is tested; the
thin DB call site is not) — consistent with how `checkBudgetPace` is treated
elsewhere in this codebase.

## Documentation

No user-facing docs exist for this feature outside the page itself and this
task doesn't introduce a new public API or schema change, so no README/
changelog update is missing.

## UI verification caveat

This task touches a rendered page (`app/review/[year]/[month]/page.tsx`). No
pipeline agent — including this review — has browser access. I traced the
render logic by hand (guard conditions, confidence-label logic, empty-state
branching, table structure) and it's internally consistent and matches the
plan, but a human should do a quick visual pass on the "Projected" column and
the "Forecast accuracy" card (populated and empty states) before considering
this fully done, per this repo's established practice for UI-touching tasks.
This does not block approval; it's the same accepted gap as every prior
UI-touching task in this repo.

## What's good

- The Coder correctly identified and flagged the cron/action duplication as a
  structural problem rather than quietly patching around it, and the Planner
  had already surfaced it prominently in the plan before any code was
  written — good escalation discipline at both stages.
- The retrospective accuracy reconstruction is genuinely careful about not
  leaking future information into a "what would this have predicted" check —
  exactly the property that would make the whole feature meaningless if
  gotten wrong, and it's correct on direct inspection.
- Forecast confidence is never hidden or suppressed in the review, per the
  task's explicit instruction that a deliberately-read report should behave
  differently from a noise-averse notification — correctly distinguished from
  `lib/budget-pace.ts`'s suppression behavior, which was left untouched as
  required.
- Both the Coder and Tester proactively surfaced the accrual-threshold delta
  themselves rather than leaving it for the Reviewer to find — good the
  process here reflects that up front.
