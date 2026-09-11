# Test Report: Spend run-rate forecast (trend-based projection)

## Verdict: PASS

All acceptance criteria verified independently. The Coder's reported arithmetic
deviation was independently reproduced and confirmed both as a real bug in the
plan's literal form and as correctly fixed. Three coverage gaps were found and
closed by adding tests (no implementation changes were made). Full suite,
typecheck, and lint all pass.

---

## Acceptance criteria checklist

1. **Exports match plan signatures** (`MonthlySpendPoint`, `ForecastMethod`,
   `ForecastConfidence`, `SpendForecast`, `computeTrailingAverage`,
   `projectPeriodEndSpend`) — **PASS**. Verified by reading `lib/spend-forecast.ts`
   directly; all six exports present, types match the plan's interfaces exactly
   (field names, `Decimal | null`, optional `trailingMonths`).

2. **Never throws for valid `period`, incl. zero spend-to-date, empty history,
   `asOfDate` outside target period** — **PASS**. Confirmed via existing test 4
   (three sub-cases: single history point, `spendToDate = D(0)`, `asOfDate`
   before period start) plus my added tests 9–11 exercising partial/zero/empty
   history combinations. All pass, no throws.

3. **Throws descriptive `Error` for malformed `period`** — **PASS**. Existing
   test 7 covers `"2026-9"`, `"September 2026"`, `""`; all throw.

4. **All money values are `Decimal`, no float arithmetic on money** — **PASS**.
   Read the full module; the only plain-`number` arithmetic operates on
   `daysElapsed`/`daysInPeriod`/`monthsUsed` (day counts, not money). The
   deviation specifically *removed* the one place a float touched a money
   computation (the `paceWeight` intermediate). Grepped for stray `/`
   operators on Decimal-typed values — none found outside the fixed blend.

5. **No `any` in the module; `pnpm typecheck` passes with zero errors** —
   **PASS**. Grepped `lib/spend-forecast.ts` and the test file for `\bany\b` —
   only matches are the English word "any" inside comments/test names, no
   `: any` type usage. `pnpm typecheck` ran clean (zero output beyond the
   `tsc --noEmit` invocation line).

6. **`pnpm lint` passes with zero errors/warnings on the new files** —
   **PASS**. Full lint run: `✖ 45 problems (0 errors, 45 warnings)` — all 45
   warnings are in pre-existing unrelated files (React hooks, unused vars in
   components/seed script/other test files). Grepped the lint output for
   "spend-forecast" — zero matches, confirming neither new file produced any
   warning or error.

7. **`pnpm test` full suite passes, adds to (doesn't reduce) the 289 baseline**
   — **PASS**, and re-verified after I added tests. Before my additions: `28
   files passed (28)`, `304 tests passed (304)` = 289 baseline + 15 new. After
   my 3 added tests: `28 files passed (28)`, `307 tests passed (307)`. Zero
   failures, zero regressions in either run.

8. **Nothing outside `lib/spend-forecast.ts` /
   `lib/__tests__/spend-forecast.test.ts` (+ pipeline docs) modified** —
   **PASS**. `git status --porcelain -uall` after the task matches the
   session-start snapshot exactly for every file *other than* the two task
   files and the `.claude/pipeline/spend-run-rate-forecast/` docs — the six
   modified-tracked files (`CLAUDE.md`, `actions/reports.ts`,
   `app/business/[slug]/balance-sheet/page.tsx`, `app/business/page.tsx`,
   `components/app-sidebar.tsx`, `prisma/schema.prisma`) and the various
   untracked bank-statements/period-balance-sheet files were already present
   and unrelated to this task before the Coder started (confirmed against the
   git status snapshot provided at the start of this session, which is
   byte-for-byte identical to the current status modulo the spend-forecast
   files). `git diff --stat` on those six files shows no new hunks introduced
   during this task.

---

## Independent verification of the Coder's reported arithmetic deviation

**Claim:** the plan's literal `paceWeight = daysElapsed / daysInPeriod` (raw JS
float) followed by `paceProjection.times(paceWeight).plus(trailingAverage.times(1
- paceWeight))` produces `-699.99999999999996` instead of the plan's specified
exact `-700` for Test 5, and the Coder's rearranged single-`.div()`-at-the-end
form fixes this while remaining algebraically equivalent and matching every
other test case's expected values.

**Independently reproduced, not just trusted.** Ran both formulas directly
against `@prisma/client/runtime/library`'s `Decimal` outside the test file:

```
paceWeight 0.3333333333333333
literal plan result: -699.99999999999996
coder result: -700
```

Confirms the bug is real and the fix resolves it exactly as claimed.

Also re-ran both formulas against Tests 1, 2, and 5's exact inputs:

```
Test1 literal= -600      coder= -600      expected= -600
Test2 literal= -2850     coder= -2850     expected= -2850
Test5 literal= -699.99999999999996   coder= -700   expected= -700
```

Tests 1 and 2 happen to produce identical results either way (their
`daysElapsed/daysInPeriod` ratios are exact binary/decimal fractions — 15/30 =
0.5, 3/30 = 0.1 — so float imprecision doesn't surface); only Test 5's ⅓ ratio
exposes the bug. This matches the Coder's narrower claim ("Test 5 specifically
requires the fix") rather than overstating it.

**Algebraic derivation, done independently** (not just "ran it and it matched"):
substituting `paceProjection = spendToDate × daysInPeriod / daysElapsed` into
both forms:

- Plan's form: `paceProjection·w + avg·(1−w)` where `w = daysElapsed/daysInPeriod`
  → simplifies to `spendToDate + avg·daysRemaining/daysInPeriod` (exactly, in
  real-number arithmetic).
- Coder's form: `(paceProjection·daysElapsed + avg·daysRemaining) / daysInPeriod`
  → the `paceProjection·daysElapsed` term reduces to `spendToDate·daysInPeriod`
  exactly (the `/daysElapsed` and `×daysElapsed` cancel), giving the identical
  `spendToDate + avg·daysRemaining/daysInPeriod`.

Both forms are the same real number; the Coder's form just defers the single
lossy division to the very end instead of materializing an intermediate JS
float ratio, which is why it comes out exact for every test case in the plan
where `daysInPeriod` divides the combined numerator evenly to a terminating
decimal, and exact-enough elsewhere per `toBeCloseTo`.

**Verdict on the deviation: legitimate, correctly justified, correctly scoped.**
It changes internal arithmetic order only — no public signature, output type,
or method/confidence logic changed, consistent with the write-up's claim. This
is exactly the kind of "algebraically equivalent, more numerically stable"
fix that's appropriate for a Coder to make unilaterally without violating "no
design decisions left open," since the plan's own test expectations (exact
`"-700"`) could not otherwise be satisfied — the plan's literal arithmetic and
the plan's own literal exact-match assertion are mutually inconsistent, and the
Coder picked the resolution that preserves the exact-match guarantee rather
than loosening the test.

---

## Tests run

```
pnpm typecheck
$ tsc --noEmit
(zero output, zero errors)

pnpm lint
✖ 45 problems (0 errors, 45 warnings)
(0 errors and 1 warning potentially fixable with --fix; all 45 warnings in
pre-existing unrelated files; zero in lib/spend-forecast.ts or
lib/__tests__/spend-forecast.test.ts)

pnpm test   (before my additions)
 Test Files  28 passed (28)
      Tests  304 passed (304)

pnpm test   (after my 3 additional tests)
 Test Files  28 passed (28)
      Tests  307 passed (307)

pnpm vitest run lib/__tests__/spend-forecast.test.ts   (after additions)
 ✓ lib/__tests__/spend-forecast.test.ts (18 tests) 13ms
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

## Tests added

Added 3 test cases to `lib/__tests__/spend-forecast.test.ts` (test-file-only
change, no implementation touched), closing gaps the plan's own test list left
unexercised:

1. **"9. partial trailing history (2 of default 3 months) yields medium
   confidence"** — the plan's 9 documented test cases only ever produce
   `confidence: "high"` (3-of-3 months) or `"low"` (0 months); the `"medium"`
   branch (`0 < monthsUsed < trailingMonths`) was never hit by any existing
   test, including Test 6 which has 2 prior months but never asserts on
   `confidence` at all. Verified `trailingMonthsUsed === 2`, `confidence ===
   "medium"`, `method === "blended"`.

2. **"10. custom trailingMonths threads through to blend weighting and
   confidence"** — the plan's `trailingMonths` option on `projectPeriodEndSpend`
   itself (as opposed to the direct `computeTrailingAverage` unit tests, which
   only call the helper directly) was never exercised end-to-end. Verified
   `trailingMonths: 1` correctly excludes older history entries from the
   average, and that the blend/confidence outputs reflect the 1-month window
   (exact: pace `-600` × 0.5 + avg `-620` × 0.5 = `-610`).

3. **"11. trailingMonths: 0 disables the trailing baseline entirely"** —
   verified that even with 3 months of ample history available, explicitly
   passing `trailingMonths: 0` falls back to `pace_only`/`low` confidence
   rather than silently defaulting to 3 or throwing.

All 3 pass without any implementation change, confirming the existing code
already correctly handles these paths — the gap was in test coverage, not
correctness.

## Defects found

None. No implementation bugs found. The one deviation from the plan's literal
arithmetic was investigated in depth (see above) and found to be a correct,
narrowly-scoped, necessary fix — not a defect.

## Not tested

- **Wiring into `lib/notifications.ts` / UI / server actions** — explicitly out
  of scope per the plan (deliberate follow-up task); nothing to test since no
  code exists yet.
- **Decimal precision behavior for non-terminating blend results at high
  external precision settings** — the module relies on the default
  `@prisma/client/runtime/library` `Decimal` precision (no `Decimal.set()`
  override anywhere in the repo, confirmed via grep). All plan test cases and
  my added cases either divide evenly or are asserted with `toBeCloseTo`, so
  this wasn't a practical concern for this task's exact test values, but a
  future caller feeding day-counts/history that produce a long non-terminating
  fraction through the final `.div(daysInPeriod)` isn't specifically
  stress-tested beyond Test 3's `toBeCloseTo` case.
- **Timezone/DST edge behavior** — plan explicitly scopes this out (UTC-only,
  matching `forecast.ts` convention); not independently re-verified beyond
  confirming the module uses only `getUTC*` accessors (no local-time calls).
