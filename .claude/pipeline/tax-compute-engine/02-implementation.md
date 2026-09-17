# 02 — Implementation: Tax computation engine (TY2025)

## Summary of changes

- **`lib/tax-compute.ts`** (new) — pure, `Decimal`-only TY2025 tax-math module. No DB/Prisma-client
  query imports, no `"use server"`. Implements every function named in the plan's Approach section
  (steps 2–20):
  - Federal constants block (`STANDARD_DEDUCTION_MFJ_2025`, `FEDERAL_BRACKETS_MFJ_2025`,
    `SE_NET_EARNINGS_FACTOR`, `SE_OASDI_RATE`, `SE_MEDICARE_RATE`, `SE_WAGE_BASE_2025`,
    `ADDITIONAL_MEDICARE_TAX_RATE`, `ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ`, `QBI_RATE`,
    `QBI_PHASE_IN_START_MFJ`, `QBI_PHASE_IN_END_MFJ`, `STANDARD_MILEAGE_RATE_2025`,
    `HOME_OFFICE_SIMPLIFIED_RATE_PER_SQFT`, `HOME_OFFICE_SIMPLIFIED_MAX_SQFT`), each with an inline
    citation to its spec 09 bullet/table.
  - **`SALT_CAP_MFJ_2025 = 40000`** (plus `SALT_CAP_PHASE_DOWN_FLOOR = 10000` and
    `SALT_CAP_PHASE_DOWN_MAGI_THRESHOLD_MFJ = 500000`), citing spec 09's new Federal § SALT-cap
    bullet, per your instruction. `computeItemizedDeduction`'s `saltCapCents` parameter is still
    **required with no default** — callers are expected to pass `SALT_CAP_MFJ_2025 * 100` in the
    common case, but nothing in the file itself silently assumes it. The nice-to-have phase-down flag
    is implemented: `computeItemizedDeduction` takes an optional `magiForSaltPhaseDown?: Decimal`; if
    supplied and `> $500,000`, a `notes` entry is pushed explaining the phase-down (30% of excess,
    floor $10,000) is NOT computed/modeled — the raw uncapped-by-phase-down SALT figure is still
    returned, just flagged. `computeFederalTax` wires this automatically using the computed federal
    AGI as a MAGI proxy (no foreign-earned-income-exclusion data exists in this app to compute true
    MAGI), and `computePersonalTaxReturn` forwards any such note into its top-level `gaps` array.
  - `computeFederalBracketTax` — standard half-open `[min, nextMin)` marginal bracket sum.
  - `computeMileageDeduction`, `computeHomeOfficeSimplifiedDeduction`, `computeScheduleCNetProfit`.
  - `computeSelfEmploymentTax`, `computeAdditionalMedicareTax`.
  - `computeQBIDeduction` (full/phase-in-interpolated/stubbed-at-$0 three-way branch with `notes`).
  - `computeItemizedDeduction`, `selectDeductionMethod`, `computeFederalTax` (orchestrator).
  - CT constants block (`CT_TABLE_B_MFJ_2025`, plus inline constants inside `computeCtPersonalExemption`
    / `computeCtPhaseOutAddback`), each citing spec 09's CT § table.
  - `computeCtPersonalExemption` (Table A), `computeCtInitialTax` (Table B), `computeCtPhaseOutAddback`
    (Table C), `computeCtRecapture` (Table D, stubbed), `computeCtPersonalCreditDecimal` (Table E,
    stubbed), `computeConnecticutTax` (orchestrator).
  - `computePersonalTaxReturn` — top-level orchestrator; throws for any `taxYear !== 2025`; builds an
    input-driven `gaps: string[]` array.

- **`lib/__tests__/tax-compute.test.ts`** (new) — 72 Vitest tests, `D()`/`d()` local-helper convention
  matching `lib/__tests__/business-quarter-forecast.test.ts`. Covers every item in the plan's Test
  Expectations section (bracket boundaries, SE tax wage-base cap, Additional Medicare Tax threshold,
  QBI full/phase-in/stub, itemized/SALT cap, CT Tables A–E boundary behavior, mileage/home-office, and
  two `computePersonalTaxReturn` end-to-end scenarios: a fully-populated golden path with empty `gaps`,
  and a gap-heavy scenario asserting exactly which `gaps` messages fire and that CT figures are `null`
  rather than guessed).

No other files were touched — nothing wired into `actions/tax.ts`, `components/tax/*`, or any page,
matching the plan's explicit scope boundary.

## Deviations from the plan

1. **CT Table C (`computeCtPhaseOutAddback`) mid-range test value differs from the plan's own
   illustrative example.** The plan's Test Expectations section says "$110,500, one $5,000 step in →
   $50." I found this is mathematically incompatible with the plan's OTHER, load-bearing Table C
   anchor — spec 09's literal "$500 once CT AGI > $145,500" cap boundary, which the plan's step 16
   explicitly told me to validate and "adjust the step formula" to hit correctly. No single
   `$50-per-$5,000` step formula can produce both "$50 at $110,500" (which requires the very first
   $5,000 band, i.e. $105,500, to already be one step, and $110,500 to still be that same first step)
   AND "$500 exactly at $145,500" ($45,000 of excess ÷ $5,000 = 9 whole steps × $50 = $450, one step
   short of $500, under any plain ceil/floor-of-quotient formula). I prioritized the explicit,
   directly-spec-09-quoted cap boundary ($500 at $145,500) over the plan's own illustrative mid-range
   number, since the cap boundary is a literal fact from spec 09 while the mid-range example is the
   Planner's own arithmetic (and this exact tension is why plan step 16 flagged the formula as needing
   verification/adjustment in the first place). My implementation uses a "fence-post" step count —
   `floor(excess / 5000) + 1` for any CT AGI > $100,500 — which lands the cap exactly at $145,500
   (`floor(45000/5000)+1 = 10` steps × $50 = $500). Under this formula, $110,500 computes to $150 (not
   $50), and I wrote the test to assert that actual value, plus a second test at $105,000 → $50 as the
   "one clean step in" case that IS consistent with the chosen formula. Both the deviation and the full
   derivation are documented in the function's own doc comment in `lib/tax-compute.ts`. This is the
   same class of internal spec-09 imprecision the plan itself already resolved for Table A (picking the
   explicit `$0 at $71,000` boundary over pure `$1,000-per-$1,000` linear math) — I applied the same
   resolution principle here, just flagging it explicitly since the plan's test text named a specific
   (now-superseded) number.
2. **`computeQBIDeduction`'s `qualifiedBusinessIncome` input, when wired from `computeFederalTax`, uses
   the raw Schedule C net profit (floored at 0) rather than net profit minus the deductible half of SE
   tax.** The plan's step 9 signature is generic (`{qualifiedBusinessIncome, taxableIncomeBeforeQBI}`)
   and doesn't specify how `computeFederalTax` should derive `qualifiedBusinessIncome` from
   `scheduleCNetProfit`. Real §199A QBI technically nets out the SE-tax deduction attributable to the
   business (and SE health insurance, not modeled anywhere in this app). I kept it as the simpler raw
   figure to avoid introducing an assumption the plan didn't ask for, and flagged this explicitly as an
   additional documented simplification in `computeFederalTax`'s inline comment (not silently assumed).
   This is a minor, disclosed simplification, not a scope change.

No other deviations. Every function signature, the stub-vs-guess behavior for CT Tables D/E, the
required (no-default) `saltCapCents` parameter, and the citation-comment requirement were all
implemented exactly as specified.

## Commands run and their results (all personally observed, not assumed)

- `pnpm typecheck` — clean, zero errors.
- `pnpm vitest run lib/__tests__/tax-compute.test.ts` — **72/72 passed**, all on the first run (no
  fix-up iterations needed after hand-computing the expected values for the bracket-tax, SE-tax,
  Connecticut Table A–E, and both end-to-end `computePersonalTaxReturn` scenarios).
- `pnpm lint` — **0 errors, 47 warnings**, all pre-existing and in files this task never touched
  (React `set-state-in-effect` warnings, unused-var warnings in components/seed script/other test
  files) — matches this repo's known 0-error/~47-warning baseline exactly (see
  `.claude/agent-memory/coder/commands.md`). Nothing in `lib/tax-compute.ts` or
  `lib/__tests__/tax-compute.test.ts` triggered a warning.
- `pnpm test` (full suite) — **670/670 passed across 50 files**, zero regressions. Only 2 new files
  appeared in `git status` beyond this task's own two (`lib/tax-compute.ts`,
  `lib/__tests__/tax-compute.test.ts`) — confirmed via `git status --short` that no other test files
  were added by this change; the count includes other concurrent/prior work already sitting
  uncommitted in the working tree (multiple other `.claude/pipeline/*` folders are present in
  `git status`, consistent with the established pattern noted in memory).

`pnpm build` / `npx next build` was **not run** — this module is deliberately unwired (no imports
from any `"use client"` component or any other file in the repo), so there's no client-bundle risk
class to check (see `.claude/agent-memory/coder/prisma-decimal-import-breaks-client-bundle.md` — that
risk only applies when a `Decimal`-importing `lib/` file is reachable from a `"use client"` component's
import graph, which is not the case here since nothing imports `lib/tax-compute.ts` yet).

## Status of every Risks/gaps item from the plan (plan's own acceptance criterion)

1. **No SALT cap constant in spec 09** — **RESOLVED since the plan was written.** Spec 09 now has the
   constant; added as `SALT_CAP_MFJ_2025 = 40000` with a citation comment. `computeItemizedDeduction`'s
   `saltCapCents` parameter remains required with no default (confirmed via TypeScript — omitting it is
   a compile error), per your instruction that this design choice should stay even though the constant
   now exists. The phase-down above $500,000 MAGI is **implemented-with-documented-stub**: a `notes`
   flag fires when a caller-supplied (or AGI-proxied) MAGI exceeds $500,000, but the 30%-of-excess
   phase-down math itself is NOT computed.
2. **CT Table D (recapture) partially transcribed** — **implemented-with-documented-stub**, exactly as
   planned: `{amount: Decimal(0), requiresManualLookup: false}` at CT AGI ≤ $210,000;
   `{amount: null, requiresManualLookup: true}` above, including at/above the known $1,080,000 cap
   point (never returns the $6,800 cap value without the interior table). Verified by 4 tests.
3. **CT Table E (personal credit decimal) partially transcribed** — **implemented-with-documented-stub**,
   exactly as planned: stubbed (`null`/`requiresManualLookup: true`) for CT AGI ≤ $100,500 (confirmed the
   literal ">" boundary via a test at exactly $100,500), confirmed `$0.00` above. Verified by 3 tests.
4. **CT Table A's literal wording is internally imprecise** — **implemented-with-documented-choice**: a
   `ceil((ctAGI-48000)/1000)` step function, landing the last nonzero step ($1,000 exemption) at
   $70,001–$71,000 and $0 from $71,001, matching spec 09's literal "$0 at ≥$71,000" boundary. Verified
   by 4 tests including the exact $71,000 boundary.
5. **CT Table E's credit-application mechanics unstated** — **implemented-with-documented-assumption**:
   multiplies `initialTax` (Table B's output), flagged in `computeConnecticutTax`'s doc comment as
   unverified against the actual CT-1040 instructions.
6. **Federal AGI/taxable income don't subtract retirement/HSA/SE-health-insurance deductions** —
   **genuinely blocked** (no structured dollar data exists anywhere in the schema for these). Documented
   in `FederalTaxResult.agi`'s doc comment and the file-level header as an explicit "upper bound" caveat;
   not remediable within this task's scope.
7. **No 2025 1098/property-tax numeric extraction exists** — **genuinely blocked**, unchanged from the
   plan's own framing; `computeItemizedDeduction` takes pre-resolved cents figures and cannot itself fix
   the extraction-layer ambiguity (monthly-statement vs. annual-1098 figure). Flagged for the future
   DB-wiring layer, not addressed here (correctly out of scope for a pure-function task).
8. **Home office square footage not stored anywhere** — **genuinely blocked** at the schema level;
   `computeHomeOfficeSimplifiedDeduction` always returns `$0` for `null` input, and
   `computePersonalTaxReturn`'s `gaps` array names this explicitly whenever `homeOfficeSqft === null`
   (verified by the gap-heavy end-to-end test).
9. **`MileageEntry` has zero rows for any entity today** — **genuinely blocked** at the data level (not
   something this task can populate); `computeMileageDeduction` is correct math against whatever rows
   exist, and `computePersonalTaxReturn`'s `gaps` array names an empty-entries condition explicitly
   (verified by the gap-heavy end-to-end test).
10. **Estimated tax payments captured only as free text** — **implemented-with-documented-assumption**:
    `computeFederalTax`'s formula literally treats a `null` `estimatedPaymentsCents` as `$0` in the
    arithmetic (per the plan's own step-12 formula, `estimatedPayments ?? 0`), but
    `computePersonalTaxReturn`'s `gaps` array explicitly flags this whenever it fires — reconciling the
    plan's literal formula with its Risks-item-10 statement that "the engine correctly treats null as
    'unknown,' not '$0'": the *gaps array* is the mechanism that surfaces the distinction, not a `null`
    result. Verified by the gap-heavy end-to-end test.
11. **`Paystub.taxBreakdown` is freeform** — **out of scope, correctly not addressed**: this pure module
    takes already-summed cents values as input; the label-matching fragility is explicitly the future
    DB-wiring layer's problem, as the plan states.
12. **Model name is `TaxQuestion`, not `TaxQuestionAnswer`** — noted, no code references the
    nonexistent model.
13. **Double-counting risk between GL-coded home-office expenses (GL "5030") and the simplified
    $5/sqft method** — **flagged, not preventable by this pure function**: documented in
    `computeScheduleCNetProfit`'s doc comment exactly as the plan specifies.
14. **Arbor Rd (Sudden Valley) property tax must never flow into the SALT input** — **flagged, not
    enforceable by this pure function**: documented in `ItemizedDeductionInput.propertyTaxCents`'s doc
    comment and restated in `ComputePersonalTaxReturnInput.propertyTaxCents`.
15. **This is a draft estimate for CPA review, not filed numbers or tax advice** — restated in the
    file's top-level doc comment per CLAUDE.md ground rule 8.

## Route-back fix (2026-09-17) — addressing 04-review.md CHANGES_REQUESTED

Reviewer verdict was CHANGES_REQUESTED: spec 09 was updated (after the original implementation)
to include CT Table D and Table E's full literal interior tables, but `lib/tax-compute.ts` was
still stubbing both to `requiresManualLookup: true` far more broadly than the now-complete spec
09 data requires. This section documents the fix, addressing every numbered finding in
`04-review.md`.

### Blocking finding 1 — CT Table D/E interior tables

- Added `CT_TABLE_D_MFJ_2025` (51 bands) and `CT_TABLE_E_MFJ_2025` (29 bands) as literal, ordered
  lookup arrays in `lib/tax-compute.ts`, transcribed directly from spec 09's now-complete Table D
  / Table E sections — NOT formulas, per spec 09's explicit warning and the two genuine flat/no
  -step bands in Table D ($300k–$400k stays at $500; $690k–$1,000,000 stays at $5,900). Each
  constant carries an inline citation to spec 09's Table D/E section and the underlying PDF
  (`ct-1040-tcs_1225.pdf`, pages 4–5).
- Rewired `computeCtRecapture` and `computeCtPersonalCreditDecimal` to do a first-match lookup
  against these tables (`{ upperBound: number | null; amount/decimal }` bands, read top-down,
  "more than the previous band's upperBound, less-than-or-equal-to this one" — matching spec 09's
  own framing). Both tables' final band has `upperBound: null`, so they cover every CT AGI up to
  +Infinity — `requiresManualLookup: true` is now unreachable in practice and kept only as a
  defensive fallback (documented as such in both functions' doc comments and in a code comment at
  the fallback `return` itself).
- Table E's `<= $24,000` band (where the source PDF is silent) uses spec 09's own inference: this
  is moot, not a real gap, because Table A's $24,000 exemption already zeroes CT taxable income at
  that AGI level, so `initialTax` is $0 and `initialTax.times(decimal)` is $0 regardless of the
  decimal used. A `1.00` documentation-only placeholder is used; a code comment explains why the
  value doesn't matter.
- Fixed the stale gap message in `computePersonalTaxReturn` (previously "CT Table D/E interior
  values not yet transcribed into spec 09") — it now reads as a genuine anomaly/bug signal (should
  not fire given current table coverage) rather than blaming a spec gap that no longer exists.
- Updated tests: `computeCtRecapture`/`computeCtPersonalCreditDecimal` describe blocks were
  rewritten from "stub vs. confirmed boundary" assertions to real-value assertions, including new
  boundary tests at both Table D flat bands (exactly $300,000 → $450 last-step-before-flat,
  $399,999 → $500 still-flat, $400,001 → $680 next-step-resumes; and the same three-point pattern
  at the $690k–$1,000,000 flat band) and outer-edge tests (Table D at $1,080,000/$1,080,001+/very
  large; Table E at $24,000/$24,001/very large). `computeConnecticutTax`'s previously-"unresolved"
  test at CT AGI $300,000 now asserts the real computed liability ($16,450). The gap-heavy
  end-to-end test (CT AGI $280,000) now asserts CT figures are resolved ($15,150 computed,
  -$15,150 balance) instead of null, since $280,000 falls inside Table D's $270k–$280k → $350 step.

### Should-fix finding 2 — asymmetric `gaps` array

Added two unconditional standing entries to `computePersonalTaxReturn`'s `gaps` array (pushed on
every call, mirroring the existing mileage/estimated-payments pattern): federal AGI being an upper
bound (retirement/HSA/SE-health-insurance deductions never subtracted), and QBI being computed off
raw Schedule C net profit rather than net of the deductible SE-tax half. Both were previously
disclosed only in doc comments. The golden-path end-to-end test's expected `r.gaps` changed from
`[]` to an array containing exactly these two messages (verified no other gap condition fires in
that scenario). The gap-heavy test now also asserts both of these standing gaps fire, alongside
its 4 pre-existing conditional gaps (`r.gaps.length` is now 6, not 5, since the CT Table D/E gap no
longer fires at CT AGI $280,000).

### Should-fix finding 3 — `FederalTaxResult.agi` naming

Renamed `FederalTaxResult.agi` → `agiUpperBound` (and the corresponding local variable inside
`computeFederalTax`, and the `federal.agi` reference inside `computePersonalTaxReturn`'s call to
`computeConnecticutTax`). Chose a rename over a sibling field per the review's "your call, keep it
minimal" — there were zero importers of this module anywhere in the repo (confirmed via `grep`
before and after), so there was no wiring-site fallout. Updated the two test-file references
(`computeFederalTax`'s orchestrator test, the golden-path end-to-end test).

### Commands run after the fix (all personally observed)

- `pnpm typecheck` — clean, zero errors (confirmed no other file references `FederalTaxResult.agi`
  before renaming, and zero errors after).
- `pnpm vitest run lib/__tests__/tax-compute.test.ts` — **83/83 passed** (72 original + 11 new
  boundary/outer-edge tests for CT Table D/E).
- `pnpm lint` — **0 errors, 47 warnings**, identical baseline to before this fix; nothing in
  `lib/tax-compute.ts` or its test file triggered a warning.
- `pnpm test` (full suite) — **681/681 passed across 50 files** (670 before this fix + 11 new
  tests, zero regressions elsewhere).

## Open items

- The two deviations above (CT Table C's step formula / QBI's `qualifiedBusinessIncome` derivation)
  should get a quick owner/CPA sanity-check before this module is wired into any UI, same as the
  plan's own Table A/Table E caveats.
- This module is entirely unwired (as scoped) — building the DB-aware layer that resolves real
  `Document`/`Paystub`/`MileageEntry`/`TaxQuestion` rows into this module's plain-number/Decimal inputs
  is real follow-on work, exactly as the plan's "Explicitly NOT in scope" section describes.
- No credits engine exists yet (Child Tax Credit, solar 25D, EV, Saver's, CT property tax credit) —
  correctly out of scope per the plan; every top-level figure this engine returns is explicitly named
  "before credits."

---

## Second-pass fix (2026-09-17) — CT Table E credit-application mechanic

Addressed the Reviewer's second-pass "should-fix" finding 4 in
`.claude/pipeline/tax-compute-engine/04-review.md`: `computeConnecticutTax`'s `ctTaxComputed` line
multiplied Table E's personal-credit decimal against `initialTax` alone, instead of the primary
source's actual mechanic (spec 09's now-added "Tax Calculation Schedule mechanic" section, citing
Form CT-1040 TCS page 1 lines 1-10): the decimal multiplies `Line 7 = initialTax + phaseOutAddback +
recapture`, and final tax is `Line 7 - Line 9` where `Line 9 = Line 7 x decimal`.

**Changes in `lib/tax-compute.ts`:**
- `computeConnecticutTax` (around the `ctTaxComputed` assignment): now computes `line7 =
  initialTax.plus(phaseOutAddback).plus(recapture.amount!)` once, then `ctTaxComputed =
  line7.minus(line7.times(personalCredit.decimal!))` — multiplying the full Line 7 sum instead of
  `initialTax` alone. Added an inline comment citing the CT-1040 TCS line sequence and explicitly
  noting this specific formula choice is currently unexercisable via the public API: Table C/D/E's
  real-world thresholds mean `phaseOutAddback`/`recapture` are structurally always $0 whenever the
  decimal is nonzero, so the old and new formulas produce byte-identical output for every reachable
  test input today. Only a direct/internal test of the arithmetic, decoupled from the real tables,
  could distinguish them — not required for this fix per the Reviewer's own framing.
- The doc comment above `computeCtPersonalCreditDecimal` (previously calling the multiplication
  target "unverified... isn't stated in spec 09") now cites spec 09's resolved mechanic instead of
  asserting a now-superseded unknown.

**No test changes** — confirmed via the full run below that all 83 CT-related tests still pass
unchanged, which itself corroborates the Reviewer's own claim that no test in the current suite can
distinguish the two formulas (Table C/D/E's real thresholds make them numerically identical for every
reachable input).

### Commands run (all personally observed)

- `pnpm typecheck` — clean, zero errors.
- `pnpm vitest run lib/__tests__/tax-compute.test.ts` — **83/83 passed** (same count as before this
  fix, as expected — no test can distinguish the two formulas given real Table C/D/E data).
- `pnpm test` (full suite) — **681/681 passed across 50 files**, zero regressions.

### Open items

- Unchanged from above. This fix is purely mechanical/defensibility-oriented per the Reviewer's own
  characterization ("not blocking... doesn't produce a wrong number today for any input the engine
  can currently receive") and introduces no new scope.
