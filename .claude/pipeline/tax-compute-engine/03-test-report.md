# 03 — Test Report: Tax computation engine (TY2025)

## Verdict: PASS

**This supersedes the prior `03-test-report.md` PASS.** That earlier round was invalidated by
`04-review.md`'s CHANGES_REQUESTED verdict (CT Table D/E left stubbed despite spec 09 having been
enriched with full literal interior tables). The Coder has since applied a route-back fix
(documented in the "Route-back fix (2026-09-17)" section of `02-implementation.md`). This report
covers an independent re-verification of that fix — all claims below were personally checked, not
taken on the Coder's word.

## Acceptance criteria / route-back findings checklist

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm typecheck` clean | PASS | `tsc --noEmit` — zero output, zero errors |
| 2 | `pnpm lint` | PASS | 0 errors, 47 warnings — identical baseline to pre-fix state per implementation report; confirmed none of the 47 warnings are in `lib/tax-compute.ts` or its test file (full warning list inspected, all in unrelated components/lib files) |
| 3 | `pnpm vitest run lib/__tests__/tax-compute.test.ts` | PASS | **83/83 passed** (real output, not fabricated — see Tests run below) |
| 4 | `pnpm test` (full suite) | PASS | **681/681 passed across 50 files**, zero regressions |
| 5 | `CT_TABLE_D_MFJ_2025` matches spec 09 at multiple points, including both flat bands | PASS | Hand-checked every band transition in `lib/tax-compute.ts:632-683` against `specs/09-tax-year-2025-constants.md:79-94` — all 51 bands match exactly. Independently traced the lookup function (`computeCtRecapture`, first-match top-down against ascending `upperBound`) at: $210,000→$0, $210,001→$50, $280,000→$350, $300,000→$450 (last step before flat), $305,000/$350,000/$399,999→$500 (still flat, confirmed no mid-band step), $400,001→$680 (resumes), $690,000→$5,720 (last step before flat 2), $999,999→$5,900 (still flat), $1,000,001→$6,000 (resumes), $1,075,000→$6,700, $1,080,000→$6,700, $1,080,001/$2,000,000→$6,800 (cap). All correct, no interpolation anywhere — it's a literal array lookup, so the two flat bands cannot be accidentally stepped through by construction. |
| 6 | `CT_TABLE_E_MFJ_2025` matches spec 09 at multiple points | PASS | Hand-checked all 29 bands (`lib/tax-compute.ts:726-756`) against spec 09 lines 96-111 — exact match, including the documented `$0-$24,000` moot-placeholder inference. Traced lookup at $24,000→1.00 (moot), $24,001→0.75, $50,000→0.15, $100,000→0.02, $100,500→0.01, $100,501→0.00, $5,000,000→0.00. The $100,500-exactly boundary resolving to `.01` (not `.00`) is internally consistent with the same "more-than lower bound, less-than-or-equal-to this one" half-open convention used identically for Table B (`computeCtInitialTax`'s `greaterThan(band.min)` selection) and Table D — not a bug. |
| 7 | No interpolation across CT Table D's two flat bands | PASS | Confirmed by code inspection: both `computeCtRecapture` and `computeCtPersonalCreditDecimal` are pure literal-array first-match lookups (`for...of` + `lessThanOrEqualTo`), not formulas — structurally incapable of interpolating. Also confirmed by the three-point boundary tests the Coder added around each flat band (verified these pass, see Tests run). |
| 8 | `computeCtRecapture`/`computeCtPersonalCreditDecimal` return real values across the full realistic range; `requiresManualLookup: true` genuinely unreachable in normal use | PASS | Both tables' final band has `upperBound: null`, which the loop condition (`band.upperBound === null || ctAGI.lessThanOrEqualTo(band.upperBound)`) always matches — the post-loop `requiresManualLookup: true` fallback is provably dead code for any real Decimal input (positive, negative, zero, or arbitrarily large all hit a band). It could only become reachable if a future edit removed the catch-all `upperBound: null` row from one of the constant arrays — a defensive-only guard, exactly as claimed. |
| 9 | Stale "CT Table D/E interior values not yet transcribed into spec 09" gap message fixed | PASS | Read `lib/tax-compute.ts:961-971` directly — message now reads "...this should not happen given the current spec 09 tables and likely indicates a data or table-coverage bug, not a normal caveat" — no longer blames spec 09 for a gap that no longer exists there. |
| 10 | Two new standing `gaps` entries (AGI-upper-bound, QBI-raw-Schedule-C-profit) fire unconditionally | PASS | Read `lib/tax-compute.ts:973-983` — both `gaps.push(...)` calls are unconditional (outside any `if`), always executed. Confirmed by hand-tracing both end-to-end tests: golden-path test's `r.gaps` (2 entries, both standing) and gap-heavy test's `r.gaps.length === 6` (4 conditional + 2 standing) both independently recomputed by hand and match the code's actual branch conditions, not just the test's own assertions. |
| 11 | Golden-path test's expected `gaps` array updated correctly | PASS | Test file lines 558-561 assert the exact two standing-gap strings; independently diffed those literal strings character-for-character against the source's `gaps.push(...)` literals (`lib/tax-compute.ts:979,982`) — identical. |
| 12 | `FederalTaxResult.agi` renamed to `agiUpperBound` consistently, no stray `.agi` refs | PASS | `grep -rn "\.agi\b\|FederalTaxResult" **/*.ts` returns only `agiUpperBound`-qualified hits inside `lib/tax-compute.ts` itself (interface, doc comments, orchestrator wiring at line 926). No occurrence anywhere in the repo, including the test file, of a bare `.agi` property access. Module has zero importers repo-wide (confirmed via the same grep — only the module and its test file reference it), so there was no wiring-site fallout to check. |
| 13 | Scope: only `lib/tax-compute.ts`, its test file, and pipeline/memory docs changed | PASS | `git status --short` shows only `lib/tax-compute.ts` and `lib/__tests__/tax-compute.test.ts` as this task's file changes (both untracked/new, consistent with prior round); all other untracked entries (`CLAUDE.md` modified, `specs/09-*.md`, `pnpm-workspace.yaml`, other `.claude/pipeline/*` folders) were already present in the session-start git snapshot and belong to concurrent/prior sibling tasks in this multi-task working tree, not this fix. |

## Independent hand-verification of arithmetic (not just trusting the Coder's numbers)

Re-derived from scratch, not copied from the implementation report:

- **`computeConnecticutTax` at CT AGI $135,887.713675`** (golden-path scenario): personalExemption
  $0 (>$71,000) → initialTax = $4,000 + ($135,887.713675−$100,000)×5.5% = **$5,973.824252125** →
  phaseOutAddback: excess $35,387.713675 → `floor(excess/5000)+1` = 8 steps × $50 = **$400** →
  recapture (Table D, ≤$210,000) = **$0** → personalCredit (Table E, >$100,500, null-band) =
  **0.00** → ctTaxComputed = 5973.824252125 + 400 + 0 − 5973.824252125×0 = **$6,373.824252125** →
  balanceDueOrRefund = $7,000 − $6,373.824252125 = **$626.175747875**. Matches the test's asserted
  values exactly.
- **At CT AGI $300,000**: initialTax = $9,500 + $100,000×6% = **$15,500** → phaseOutAddback capped
  at **$500** → recapture (last step before the $300k–$400k flat band) = **$450** → personalCredit
  = **0.00** → ctTaxComputed = 15,500 + 500 + 450 = **$16,450**. Matches.
- **`computeFederalTax` golden-path**: SE netEarnings = $48,300×0.9235 = $44,605.05 → oasdiTax =
  $5,531.0262, medicareTax = $1,293.54645 → totalSETax = **$6,824.57265** (deductibleHalf =
  $3,412.286325) → agiUpperBound = $139,300 − $3,412.286325 = **$135,887.713675** → standard
  deduction wins (itemized $27,000 < $31,500) → taxableIncomeBeforeQBI = $104,387.713675 → QBI full
  20% = min($9,660, $20,877.54…) = **$9,660** → taxableIncome = **$94,727.713675** → bracket tax:
  $23,850×10% + ($94,727.713675−$23,850)×12% = $2,385 + $8,505.325641 = **$10,890.325641** →
  totalTaxBeforeCredits = 10,890.325641 + 6,824.57265 + 0 = **$17,714.898291** → balance =
  $17,000 − $17,714.898291 = **−$714.898291**. All match the test's asserted values exactly —
  independently re-derived, not copied.

## Tests run (exact commands, real output)

```
$ pnpm typecheck
> tsc --noEmit
(zero output, zero errors)

$ pnpm lint
✖ 47 problems (0 errors, 47 warnings)
(none of the 47 warnings are in lib/tax-compute.ts or lib/__tests__/tax-compute.test.ts — full
warning list inspected line by line)

$ pnpm vitest run lib/__tests__/tax-compute.test.ts
 ✓ lib/__tests__/tax-compute.test.ts (83 tests) 15ms
 Test Files  1 passed (1)
      Tests  83 passed (83)

$ pnpm test
 Test Files  50 passed (50)
      Tests  681 passed (681)
 Duration  2.25s
```

All output above is a faithful excerpt of what actually ran in this session (not fabricated,
not assumed).

## Tests added

None added this round — the Coder's route-back fix already added 11 new boundary/outer-edge tests
(72 → 83) covering exactly the areas the review flagged as needing verification (both Table D flat
bands' three-point pattern, Table D/E outer edges). I independently hand-verified the arithmetic
behind those new tests rather than re-implementing duplicate coverage (see hand-verification
section above). I judged this sufficient given the literal-array-lookup structure makes
interpolation errors structurally impossible (not just empirically untested), and every band
transition in both tables was individually traced against spec 09 by hand.

## Defects found

None. No regressions, no incorrect arithmetic, no unmet review finding.

## Not tested / caveats carried forward (not new, but worth restating)

- This module remains entirely unwired — no DB-wiring layer, no UI, no live Plaid/Document data
  flows through it. Nothing to test at an integration level yet; correctly out of scope.
- The two disclosed Coder deviations from the plan (CT Table C's fence-post step formula; QBI's
  raw-Schedule-C-profit simplification) still need CPA sanity-check before this module informs the
  actual Oct 15, 2026 filing — this was already flagged in the first-round test report and remains
  an open item in `02-implementation.md`'s "Open items" section, not something a Tester can resolve.
- CT Table E's credit-application mechanic (multiplying `initialTax` specifically) remains an
  unverified assumption against the actual CT-1040 instructions (plan Risks item 5) — disclosed in
  code comments, not a defect, but still needs eventual verification against the real form.

---

## Third pass (2026-09-17)

## Verdict: PASS

Narrow re-verification of the Reviewer's second-pass "should-fix" finding 4 (`04-review.md`
"Second pass" section) and the Coder's corresponding fix (`02-implementation.md` "Second-pass fix"
section). Did not re-derive the full engine's arithmetic — that was already independently verified
in this report's first pass above and is unchanged by this fix.

### Verification checklist

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `ctTaxComputed` now multiplies Table E's decimal against `line7` (`initialTax + phaseOutAddback + recapture`), not `initialTax` alone | PASS | Read `lib/tax-compute.ts:809-853` directly. Lines 835-836: `const line7 = initialTax.plus(phaseOutAddback).plus(recapture.amount!); ctTaxComputed = line7.minus(line7.times(personalCredit.decimal!));` — the decimal multiplies the full `line7` sum, matching the CT-1040 TCS Line 7/Line 9 mechanic the Reviewer specified (`Line9 = Line7 × decimal`, `finalTax = Line7 − Line9`). Confirmed this is not `initialTax.times(...)` anywhere in the function. |
| 2 | Stale "isn't stated in spec 09" doc comment is fixed | PASS | Read `lib/tax-compute.ts:758-771` (doc comment above `computeCtPersonalCreditDecimal`) directly. It now reads: *"WHICH CT tax-liability line this decimal multiplies is now resolved by spec 09's 'Tax Calculation Schedule mechanic' section (Form CT-1040 TCS, page 1, lines 1-10; primary-sourced): the decimal multiplies Line 7 (`initialTax + phaseOutAddback + recapture`), not `initialTax` alone. computeConnecticutTax implements that literal Line 7 - Line 9 formula (plan Risks item 5 resolved)."* No occurrence anywhere in the file of the old "isn't stated in spec 09" / "unverified" phrasing — grepped `Grep -n "isn't stated|unverified"` against `lib/tax-compute.ts`, zero matches. |
| 3 | `pnpm typecheck` clean | PASS | `tsc --noEmit` — zero output, zero errors (ran personally, not assumed) |
| 4 | `pnpm test` (full suite) — 681/681, zero regressions | PASS | Ran personally: `Test Files 50 passed (50)`, `Tests 681 passed (681)`, Duration 2.52s. Matches the Coder's claimed count exactly. `lib/__tests__/tax-compute.test.ts` shows `83 tests` passed within that run, unchanged from the second review pass (no test file changes were needed for this fix, and the mtime of the test file — 17:15:31 — predates the mtime of `lib/tax-compute.ts`'s second-pass edit — 17:25:22 — confirming the test file genuinely wasn't touched by this fix). |
| 5 | No unrelated changes crept in | PASS | `git status --short` at this point in the session shows the identical untracked-file set as the session-start snapshot (`lib/tax-compute.ts`, `lib/__tests__/tax-compute.test.ts`, the `.claude/pipeline/tax-compute-engine/` folder, plus sibling in-flight tasks' own untracked folders/files and the pre-existing `CLAUDE.md` modification) — nothing new appeared. Both `.ts` files remain untracked/new (this task was never partially committed), so there's no prior-commit baseline to `git diff` against; mtime comparison (above) is the available scoping signal, and it confirms only `lib/tax-compute.ts` was touched by this specific fix, not the test file or any other source file. |

### Independent arithmetic sanity check

Per the Reviewer's own second-pass analysis (which I re-verified by reading the three gating
functions myself, not just trusting the write-up): `phaseOutAddback` is $0 whenever `ctAGI <=
$100,500` (`computeCtPhaseOutAddback`, `lib/tax-compute.ts` — confirmed the `<= 100500 -> 0`
branch), Table D's first band covers `$0–$210,000 -> $0` (confirmed in `CT_TABLE_D_MFJ_2025`), and
Table E's decimal is `0.00` for any `ctAGI > $100,500` (confirmed in `CT_TABLE_E_MFJ_2025`). So the
old formula (`initialTax.times(decimal)`) and the new formula (`line7.times(decimal)`) are
structurally incapable of diverging for any real input the engine can receive today — confirmed
this reasoning holds by reading the actual table data, not just accepting the Reviewer's claim.
This is consistent with the full suite passing at the identical 681/681 count both before and
after the fix: the fix is a genuine formula correction that happens to be numerically inert against
every currently-reachable input, exactly as both the Reviewer and Coder described.

### Tests run

```
pnpm typecheck
> tsc --noEmit
(zero output, zero errors)

pnpm test
 Test Files  50 passed (50)
      Tests  681 passed (681)
   Start at  17:26:58
   Duration  2.52s
```

### Defects found

None.

### Not tested

- Did not re-run `pnpm lint` in this pass (already confirmed clean at the identical 0-error/47-warning
  baseline in the second pass above; this fix touches only a doc comment and one line of arithmetic
  inside an already-lint-clean function, low risk of introducing a new warning, and the task
  explicitly asked to keep this pass fast).
- Did not add a new isolated/internal unit test decoupled from the real Table C/D/E data to directly
  exercise the corrected `line7`-vs-`initialTax` distinction. The Reviewer explicitly flagged this
  formula as "permanently untestable through the public API" given real spec 09 data (Table
  C/D/E's thresholds make `phaseOutAddback`/`recapture` structurally always $0 whenever the decimal
  is nonzero), called it should-fix rather than blocking for that exact reason, and did not require
  such a test as a condition of approval — consistent with the Coder's second-pass fix, which also
  did not add one. Not adding this test is a plan/review-level scope call already made two rounds
  ago, not something I'm re-litigating in this narrow third pass; flagged here per the report format
  so it isn't silently assumed covered.

### Verdict rationale

All four items in the task prompt confirmed by direct code reading, not by trusting either
`02-implementation.md` or `04-review.md`'s prose. The formula fix, the doc-comment fix, the clean
typecheck, and the 681/681 zero-regression full suite are all independently verified. No new
findings. This third pass concurs with the Reviewer's own framing that the underlying fix is small,
mechanical, and now correctly landed — **PASS**, ready to proceed to Reviewer re-approval.
