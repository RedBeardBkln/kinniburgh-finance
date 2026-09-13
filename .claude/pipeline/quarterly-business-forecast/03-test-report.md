# Test Report: Quarterly Business Forecast

## Verdict: PASS

## Summary

Independently re-verified the fix described in the task instructions (the
one-line `"income"` → `"revenue"` gate change in
`app/business/[slug]/pl/page.tsx`, plus the corrected comment above it) and
the rest of this task's files. Confirmed no other `"income"`-vs-`"revenue"`
mistake remains anywhere in this task's touched files, confirmed the
projection math by hand against the plan's worked test cases, ran the full
test/typecheck/lint suite, and added 4 edge-case tests the Coder's original
20 didn't cover. Everything checks out.

## Acceptance criteria checklist

- [x] **`lib/business-quarter-forecast.ts` exports the exact specified
  API, no DB/Prisma-client import beyond `Decimal`, no `"use server"`.**
  Evidence: read the file end-to-end. Only import is
  `import { Decimal } from "@prisma/client/runtime/library";`. Exports
  `getQuarterForDate`, `getQuarterBounds`, `getPriorQuarters`,
  `projectQuarterEndPL`, `computeTrailingQuarterlyAverages`,
  `computeTaxReserveEstimate`, `DEFAULT_TAX_RESERVE_PCT`, plus the
  documented types — matches the plan's signatures exactly.

- [x] **`projectQuarterEndPL` floors `daysElapsed` at 1, caps at
  `daysInQuarter`, never divides by zero / NaN / Infinity.**
  Evidence: `daysElapsedInQuarter` (lines 91–98) clamps via
  `Math.min(Math.max(diffDays, 1), daysInQuarter)`. Hand-verified worked
  case 4's "day 1 of quarter" sub-case (`daysElapsed = 1`, all outputs
  zero/finite/non-NaN) and case 5's "already complete" sub-case
  (`daysElapsed` capped at 92, not overflowing). Both existing tests pass.

- [x] **`computeTaxReserveEstimate` never returns a positive reserve for
  `projectedNetIncome <= 0`, throws on negative `reservePct`.**
  Evidence: `reserveBasis = projectedNetIncome.greaterThan(0) ? ... : 0`
  correctly clamps at both negative and exactly-zero income (the original
  20 tests only covered strictly-negative; I added a boundary test for
  exactly `0` — see "Tests added" below, passes). Throws via explicit
  `if (reservePct.lessThan(0)) throw ...`, tested.

- [x] **`getPriorQuarters`/`getQuarterBounds` roll over year boundaries
  and compute leap vs. non-leap quarter lengths correctly.**
  Evidence: hand-traced `daysInMonth`'s `Date.UTC(year, month1Indexed, 0)`
  trick — correct for both leap (`2028-Q1` = 91 days: Jan 31 + Feb 29 +
  Mar 31) and non-leap (`2026-Q1` = 90 days) cases. `getPriorQuarters`
  correctly decrements `q`, wraps to `q=4`/`year -= 1` when `q < 1`. All
  8 worked test-case assertions (steady-state day counts, leap-year Q1–Q4,
  year rollover) pass.

- [x] **`getEntityTaxReservePct`/`setEntityTaxReservePct` reuse
  `AppSetting`, default `{pct: 30, isDefault: true}` when unset.**
  Evidence: read `lib/settings.ts` in full — thin wrapper over existing
  `getAppSetting`/`setAppSetting`, key `business_tax_reserve_pct:{entityId}`,
  falls back to `DEFAULT_TAX_RESERVE_PCT` (30) with `isDefault: true` on
  `null` or non-finite parse. No schema change (`git diff lib/settings.ts`
  shows only the new function block appended, nothing else touched).

- [x] **`actions/business-forecast.ts#setEntityTaxReservePct` calls
  `requireAuth()` first, rejects `pct` outside `[0,100]` via zod, persists
  via `lib/settings.ts`.** Evidence: read the file — `requireAuth()` is the
  first statement in the exported function body, matches the exact
  `actions/reports.ts` pattern byte-for-byte (`session?.user?.id` check,
  throw `"Unauthorized"`). Zod schema `pct: z.number().min(0).max(100)`.
  Persists via `saveTaxReservePct` → `lib/settings.ts`.

- [x] **`pl/page.tsx` renders the section for `ek-consulting`/
  `sudden-valley`, not for `mezzo`.** Evidence: gate is
  `db.glCode.count({ where: { entityId: entity.id, type: "revenue" } }) > 0`
  (line 65, now correct after the fix). Confirmed in `prisma/seed.ts`:
  Sudden Valley and EK Consulting each seed a `type: "revenue"` code
  (`4000`/"Rental Revenue" and `4000`/"Consulting Revenue" respectively);
  Mezzo's `mezzoCodes` (lines 609–613) are all `type: "expense"`, zero
  `"revenue"` rows — `hasIncomeGl` evaluates `false` for Mezzo, the
  `{hasIncomeGl && forecast && reserve && (...)}` JSX guard means nothing
  renders and no forecast queries even run for it. No error path possible
  since the whole block is skipped when `hasIncomeGl` is false.

- [x] **Rendered section shows quarter label, days elapsed/total,
  actual/projected income/expenses/net, confidence badge, editable tax
  reserve %, required caveat copy, plus the Sudden-Valley-specific
  caveat.** Evidence: read the full JSX block (lines 254–340). All present:
  `quarterLabel(forecastQuarter)`, `{forecast.daysElapsed} of
  {forecast.daysInQuarter} days elapsed`, three-row table (income/expenses/
  net, actual + projected columns), `ConfidenceBadge`, `TaxReservePctForm`
  inline, verbatim required caveat paragraph (matches the plan's required
  wording exactly), and the `slug === "sudden-valley"` conditional
  additional caveat sentence (exact wording match).

- [x] **No schema/migration changes.** Evidence:
  `prisma/schema.prisma` does not appear in `git status --porcelain` output
  for this task at all (not even as pre-existing-modified).

- [x] **`lib/reports.ts`, `lib/spend-forecast.ts`, `lib/forecast-rollup.ts`
  public APIs untouched.** Evidence: none of these three files appear in
  `git status --porcelain`. `business-quarter-forecast.ts` has zero imports
  from any of them (only imports `Decimal`).

- [x] **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass clean; suite
  grows with zero regressions.** See "Tests run" below —
  typecheck clean, lint 0 errors (44 pre-existing warnings, none in this
  task's files), full suite 358/358 baseline confirmed, then 362/362 after
  my 4 added tests.

- [ ] **Human visual verification of both entities' P&L pages in a running
  dev server** — NOT performed by me (no browser access in this role; see
  "Not tested" below). This is explicitly flagged as outstanding, same as
  the plan and implementation write-up both already flag it. Does not
  block PASS on its own since it was never claimed as done and the plan
  treats it as a separate, explicitly-tracked follow-up, but it is a real
  gap a human must still close before considering this fully done end to
  end.

## The "income" vs "revenue" fix — independently re-verified

Grepped `"income"` across every file this task touches
(`lib/business-quarter-forecast.ts`, `actions/business-forecast.ts`,
`components/business/tax-reserve-pct-form.tsx`, `lib/settings.ts`,
`app/business/[slug]/pl/page.tsx`): the only hit is the corrected comment
in `pl/page.tsx` line 61 explaining *why* `"revenue"` is used — no residual
bug string. Confirmed the chain end-to-end:
- `lib/reports.ts#computePL` (line 64): `if (gl.type === "revenue")`.
- `prisma/seed.ts` (lines 582, 597): both Sudden Valley's and EK
  Consulting's revenue GL codes are seeded as `type: "revenue"`.
- `prisma/schema.prisma` (line 373): `type String // asset | liability |
  equity | revenue | expense` — accurate, not stale.
- `CLAUDE.md`'s new note (added by the human, not an agent) states this was
  confirmed against live production data and explicitly calls out that this
  mix-up "recurred across three separate tasks" — consistent with what I
  found here.
- The Coder's `02-implementation.md` write-up argues at length that
  `"income"` was correct and declines to change it — that write-up is
  **stale relative to the current file state** (it predates the
  gl-code-tag-mapping fix / the human's one-line correction described in my
  task instructions). The code itself is now consistently `"revenue"`
  everywhere in this task's scope. This is worth flagging back to the
  pipeline: `02-implementation.md` should not be trusted as the source of
  truth for this specific claim going forward, though it doesn't affect the
  correctness of the current code.

## Design/scope confirmations

- **No shared coupling with `spend-forecast.ts`/`forecast-rollup.ts`/
  `reports.ts`'s internals** — `lib/business-quarter-forecast.ts` imports
  only `Decimal`. Confirmed via `grep -n "^import"`.
- **No tax-bracket/SE-tax math anywhere** — grepped
  `bracket|self-employ|se[-_ ]?tax|social security|1040|withholding|safe.harbor`
  (case-insensitive) across all 5 task files. Every hit is a comment or UI
  caveat sentence explicitly disclaiming that math is *not* done — no
  actual computation matches those terms.
- **`getEntityTaxReservePct`/`setEntityTaxReservePct` reuse `AppSetting`,
  no schema change** — confirmed above.
- **Mezzo correctly excluded, no error path** — confirmed above; the
  entire forecast block (including all `computePL` calls) is skipped when
  `hasIncomeGl` is false, so there's no code path where Mezzo could throw
  or render a nonsensical number.
- **Git scope** — `git status --porcelain` shows exactly: this task's 4 new
  files, `lib/settings.ts` and `app/business/[slug]/pl/page.tsx` modified
  (both diffs reviewed line-by-line, contain only the described additions),
  `CLAUDE.md` modified (the income/revenue convention note, confirmed not
  an agent edit per the task framing), and `actions/reports.ts`,
  `app/business/[slug]/balance-sheet/page.tsx`, `app/business/page.tsx`,
  `components/app-sidebar.tsx` modified plus several untracked files/dirs —
  all pre-existing from the sibling `bank-statements`/`period-balance-sheet`
  work per the session-start git snapshot, not touched by this task.

## Hand-verified worked test cases (independent re-derivation, not just "tests pass")

1. **Steady state** (`2026-Q3`, `asOfDate=2026-08-15`, daysElapsed=46/92):
   pace = 45000×92/46 = 90000 ✓. Trailing average of four `90000` values =
   90000 ✓. Blend = (90000×46 + 90000×46)/92 = 90000 (pace and average
   agree, so blend is a no-op) ✓. Matches code output and plan expectation.

2. **Front-loaded income lump** (`asOfDate=2026-07-10`, daysElapsed=10,
   daysRemaining=82): pace = 9200×92/10 = 84640 ✓. Blend =
   (84640×10 + 9200×82)/92 = (846400 + 754400)/92 = 1,600,800/92 = 17400 ✓.
   Matches both the code's division order
   (`incomePace.times(daysElapsed).plus(incomeAverage.times(daysRemaining)).div(daysInQuarter)`)
   and the plan's expected value exactly.

3. **Back-loaded expenses + zero revenue** (daysElapsed=46,
   daysRemaining=46): income pace/average/projected all 0, no
   divide-by-zero, `isNaN() === false` ✓. Expense pace = 100×92/46 = 200 ✓.
   Blend = (200×46 + 27600×46)/92 = 46×(200+27600)/92 = 46×27800/92 = 13900
   ✓. Fed into `computeTaxReserveEstimate(-13900, 30)`: basis clamps to 0,
   amount 0 ✓ — confirms the reserve never goes negative-basis even chained
   from a real projection output, not just a synthetic direct call.

5. **Already-complete quarter** (`2025-Q4`, `asOfDate` well past quarter
   end): `daysElapsed` capped at 92 = `daysInQuarter`, so `daysRemaining=0`.
   Blend formula collapses to
   `(pace×92 + average×0)/92 = pace = actualToDate×92/92 = actualToDate`
   — i.e. the code is structurally guaranteed to reproduce the actual
   value regardless of `history` content once `daysRemaining` hits 0, which
   is exactly the property the plan requires ("must not inflate or deflate
   ... regardless of history content"). Confirmed algebraically, not just
   by trusting the passing assertion.

7. **Leap year day counts**: traced `daysInMonth`'s
   `Date.UTC(year, month1Indexed, 0).getUTCDate()` trick by hand for
   Jan/Feb/Mar 2028 (31+29+31=91, correct leap Feb) vs. 2026 (31+28+31=90,
   correct non-leap Feb). Matches.

## Tests run

```
pnpm typecheck        # tsc --noEmit — clean, exit 0, no output
pnpm lint              # ESLint — 0 errors, 44 warnings (all pre-existing,
                       # none in this task's 5 files — grepped output for
                       # business-quarter-forecast / business-forecast /
                       # tax-reserve-pct-form / pl/page.tsx: zero hits)
pnpm test              # vitest run — BEFORE my additions: 358/358 across
                       # 32 files (exact match to the stated baseline).
                       # AFTER my 4 added tests: 362/362 across 32 files,
                       # zero regressions, zero failures.
```

Full-suite output (after additions):
```
Test Files  32 passed (32)
     Tests  362 passed (362)
```

## Tests added

Added 4 tests to `lib/__tests__/business-quarter-forecast.test.ts`
(edit only, no implementation files touched):

1. **`computeTaxReserveEstimate` exactly-zero boundary** — the plan's own
   acceptance criterion says "never returns a positive reserve amount when
   `projectedNetIncome` is negative **or zero**," but the Coder's original
   4 `computeTaxReserveEstimate` tests only covered strictly-negative
   (`-5000`), 0%-rate, and throw cases — never `projectedNetIncome = 0`
   itself. Added `computeTaxReserveEstimate(D("0"), D("30"))` →
   asserts `reserveBasis`/`reserveAmount` both `"0"`. Passes (confirms the
   `.greaterThan(0)` clamp, not `.greaterThanOrEqualTo`, correctly excludes
   the zero case too).
2. **Fractional reserve percentage** — the UI form allows `step="0.1"`
   (non-integer percentages), but no existing test fed a non-integer `pct`
   through `computeTaxReserveEstimate`. Added
   `computeTaxReserveEstimate(D("10000"), D("27.5"))` → `reserveAmount =
   "2750"`. Passes, confirms no Decimal precision loss on a realistic UI
   input.
3. **Medium confidence tier, exercised end-to-end** — `confidence:
   "medium"` is documented in the type union and in
   `computeTrailingQuarterlyAverages`'s `quartersUsed` semantics, but the
   original 20 tests only ever drove `projectQuarterEndPL` itself to
   `"high"` (4/4 quarters) or `"low"` (0 quarters) — never `"medium"`
   (some but not all). Added a case with exactly 2 of 4 possible trailing
   quarters present → asserts `trailingQuartersUsed === 2`,
   `method === "blended"`, `confidence === "medium"`. Passes.
4. **`trailingQuarters` override parameter, end-to-end** — the optional
   `trailingQuarters` param on `projectQuarterEndPL` itself (as opposed to
   the directly-tested `computeTrailingQuarterlyAverages` helper) was never
   exercised with a non-default value in the original suite. Added a case
   with 4 available history quarters but `trailingQuarters: 2` passed
   explicitly → asserts only 2 are used and confidence is `"high"` (since
   `quartersUsed === trailingQuarters` at the override value, not the
   default). Passes, confirms the override actually flows through to both
   the averaging window and the confidence-tier boundary condition.

All 4 pass; no regressions in the other 20 pre-existing tests in that file
or the other 31 test files.

## Defects found

None. No implementation bugs found in this task's scope beyond the one
already fixed (the `"income"`/`"revenue"` gate, described in my task
instructions as already corrected by the human, and independently
re-confirmed here as correct in the current code).

One **documentation-only** issue worth flagging (not a code defect, not
blocking): `02-implementation.md`'s "SPECIAL ITEM" section (lines 85–156)
argues at length, with specific line-number citations, that `"income"` was
the correct value and that changing it to `"revenue"` would introduce a
bug. That reasoning is now stale/incorrect relative to the current
codebase state (confirmed `"revenue"` is correct everywhere, per
`CLAUDE.md`'s new note and the live-DB-confirmed fix already applied). Not
a functional defect since the actual code is correct, but a future reader
of `02-implementation.md` alone (without the fix history) would be misled.

## Not tested

- **Human visual verification of `/business/ek-consulting/pl` and
  `/business/sudden-valley/pl` in a running dev server** (plan Risk 6 /
  final acceptance criterion). I have no browser access in this role.
  Could not confirm: the section visually renders without layout breakage,
  real production numbers look sane, the confidence badge state matches
  the real data volume, or that the percentage-edit form actually persists
  across a page refresh end-to-end through the live `AppSetting` table.
  This remains an explicit open item — flagged in both the plan and the
  implementation write-up, not silently assumed covered by the automated
  checks above.
- **Live database query to confirm real GlCode rows for `ek-consulting`
  and `sudden-valley`** — I did not run a live DB query myself this round;
  I relied on the human's task-instruction statement (corroborated by the
  CLAUDE.md note, the seed.ts/reports.ts code, and the already-applied fix)
  that this was already confirmed via live-DB query in the
  `gl-code-tag-mapping` task. Static code review across `computePL`,
  `seed.ts`, and `pl/page.tsx` all agree with each other and with that
  claim, so I did not consider a second live query necessary to reach a
  verdict, but I did not independently re-run one.
- **Concurrency/race conditions on `setEntityTaxReservePct`** (e.g. two
  rapid saves) — not tested; `AppSetting.upsert` is a standard
  Prisma upsert, no new concurrency surface introduced by this task beyond
  the existing `getAppSetting`/`setAppSetting` primitives which are already
  used elsewhere in the codebase.

## Memory updates

No new reusable testing pattern worth persisting beyond what's already
recorded — the "income vs revenue" issue is already well-documented in my
existing `cross-task-enum-string-consistency.md` memory and the new
CLAUDE.md convention note; no update needed there. No new flaky-test or
environment issue encountered this round.
