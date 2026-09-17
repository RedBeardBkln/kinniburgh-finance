# 04 — Review: Tax computation engine (TY2025)

## Verdict: CHANGES_REQUESTED

## Route-back target: coder

The finding below is implementation-level, not architectural — the plan's function shapes
(`{ amount | decimal: X | null, requiresManualLookup: boolean }`, the `gaps: string[]` mechanism,
the orchestration order) remain correct and don't need to change. What's missing is that
`specs/09-tax-year-2025-constants.md` has since been filled in with data the Coder's stub logic
was written to wait for, and the code/tests/gap-message weren't updated to use it.

## Findings

### Blocking

**1. CT Table D (recapture) and Table E (personal credit decimal) now have full, literal,
primary-sourced interior tables in `specs/09-tax-year-2025-constants.md` (lines 79–113), but
`lib/tax-compute.ts`'s `computeCtRecapture`/`computeCtPersonalCreditDecimal` still stub to
`null`/`requiresManualLookup: true` for any CT AGI outside the old boundary-only facts
($210,000 / $100,500).**

I independently re-read the current `specs/09-*.md` (not just the plan's quoted excerpts) and
confirmed both tables are now complete, per-$10,000/per-$500-step literal tables, explicitly
marked *"NOT a clean formula, do not interpolate... use this literal table"* — i.e. exactly the
kind of primary-sourced, citable data this engine's own ground rule requires it to use rather than
stub. This is not a case of "genuinely unknown, so stub" anymore (Risks items 2/3 in the plan were
true when the plan was written; they no longer describe the current spec 09).

Concrete effects:
- `lib/tax-compute.ts:816-818` — `computePersonalTaxReturn`'s gap message, *"CT Table D/E interior
  values not yet transcribed into spec 09 — CT balance due/refund not computable at this CT AGI,"*
  is now factually false. It blames the spec file for a gap that no longer exists there; the gap
  is now purely that the code hasn't been updated to read it.
- For any real return with CT AGI over $210,000 (plausible for this household — Eric + Eva's
  combined wages plus EK Consulting's Schedule C profit, MFJ), `ctTaxComputed` and
  `balanceDueOrRefund` come back `null` even though the exact dollar recapture and credit-decimal
  figures are now fully computable from cited primary-source data. That defeats a meaningful slice
  of the point of building this engine for the actual Oct 15, 2026 filing.
- `lib/__tests__/tax-compute.test.ts:390-394` and the gap-heavy end-to-end test
  (`:505-536`, CT AGI = $280,000) both assert the *old* stubbed behavior as correct. Fixing the
  implementation will require updating these test expectations too — this isn't cosmetic, the
  gap-heavy scenario's expected `gaps.length` and `connecticut.ctTaxComputed`/`balanceDueOrRefund`
  will change once Table D actually resolves a dollar figure at CT AGI $280,000 (which falls in the
  $270k–$280k → $350 step of the newly-available Table D).

**Fix, concretely:** add `CT_TABLE_D_MFJ_2025` and `CT_TABLE_E_MFJ_2025` as literal, ordered
lookup arrays (not a derived formula — spec 09 explicitly warns against interpolating, including
the two flat/no-step bands in Table D), rewrite both functions to look up the matching row and
return a real `amount`/`decimal` with `requiresManualLookup: false` for any input the table
actually covers (which, per the now-complete table, should be effectively all inputs — the type
can keep the `requiresManualLookup` escape hatch for defense-in-depth, but it should no longer be
reachable for any CT AGI ≥ $0 given the table now runs from $0 to the $6,800/$0.00 caps), correct
the stale gap message, and update the affected tests (including adding boundary tests for the two
flat bands in Table D — those are exactly where a careless formula reconstruction would go wrong,
which is why spec 09 calls them out).

### Should-fix

**2. The `gaps` array is not symmetric with the module's own "always-true-today" simplifications.**
Two permanent, currently-always-active assumptions are disclosed only in doc comments, never
surfaced through the runtime `gaps` mechanism that every other "permanently true today" condition
uses (e.g. `mileageEntries.length === 0` and `estimatedPaymentsCents === null` both fire on every
call today given current data availability, and both correctly push into `gaps`):
- `FederalTaxResult.agi` is always an **upper bound** — retirement/HSA/SE-health-insurance
  above-the-line deductions are never subtracted (plan Risks item 6), because no structured dollar
  data for them exists anywhere in the schema, today, for every call. This is disclosed in a doc
  comment on `agi` and the file header, but never in `gaps`.
- `computeFederalTax`'s QBI wiring uses raw Schedule C net profit rather than net of the deductible
  SE-tax half (Coder's disclosed deviation #2) — also a permanent, always-active simplification,
  disclosed only in an inline comment at the call site, never in `gaps` or `notes`.

The golden-path end-to-end test (`lib/__tests__/tax-compute.test.ts:472-503`) asserts
`r.gaps` is `[]` — i.e., a fully "confirmed, no caveats" result — even though the AGI it computed
is, right now, always an upper bound, and the QBI figure always uses the simplified derivation.
That's the exact risk pattern the task asked me to scrutinize: a number reaching a caller looking
confirmed (zero gaps) when it's actually resting on an assumption. Since these conditions are
unconditionally true today (no input can currently make them false), the fix is cheap: push a
standing `gaps` entry for each whenever the underlying data is unavailable — which, given current
schema, is always — mirroring the existing mileage/estimated-payments pattern exactly.

**3. `FederalTaxResult.agi`'s field name doesn't self-signal "upper bound" the way
`totalTaxBeforeCredits`/`balanceDueOrRefundBeforeCredits` self-signal "before credits."** A future
UI/PDF layer pulling `result.federal.agi` has no naming cue to avoid rendering it as a final "Your
AGI" figure — the caveat lives only in a comment a caller has no obligation to read. Nothing
consumes this field yet (the module is fully unwired, per plan), so this isn't a shipping blocker
today, but it's cheap to fix now before a DB-wiring/UI layer is built on top: either rename to
something like `agiUpperBound`, or make the gaps-array fix in finding 2 the enforced contract so
"0 gaps" reliably means "no known caveats," not "caveats exist but only in comments."

### Verified correct (not issues — confirmed by my own independent re-derivation, not just trusting the Tester)

- **CT Table C fence-post formula** (`computeCtPhaseOutAddback`) — re-derived by hand at $100,501,
  $105,000, $110,500, $145,500, $145,501. `floor(excess/5000)+1` lands the cap exactly at $145,500
  as claimed, and is internally consistent with the $0-at-≤$100,500 anchor. Disclosed clearly in
  both the code comment and the implementation report; a reasonable, non-fabricated resolution of
  spec 09's own internally-imprecise wording. Agree with the Coder's and Tester's conclusion.
- **QBI `qualifiedBusinessIncome` derivation deviation** — confirmed the simplification (raw
  Schedule C profit floored at 0, not net of deductible SE tax) is disclosed via an inline comment
  directly at the `computeQBIDeduction` call site inside `computeFederalTax`. Correctly flagged as
  a disclosed simplification, not a silent one — see finding 2 above for the one real gap (it's not
  surfaced through the `gaps` mechanism).
- **Stub-vs-guess discipline is type-enforced, not just commented**, for the parts of the module
  that were actually stubbed correctly at plan-freeze time: `saltCapCents` has no `?` and no
  default in `ItemizedDeductionInput` (confirmed by reading the interface — compiles to required);
  `CtRecaptureResult`/`CtPersonalCreditResult`'s `amount`/`decimal: Decimal | null` typing forces
  every caller to handle the null case; `computeConnecticutTax`'s `netTaxBeforeCreditsUnknown` OR
  of both `requiresManualLookup` flags correctly gates the only two `!`-assertions in the file
  behind a real narrowing check I traced by hand. This part of the design is sound — it's finding 1
  above (the stub boundary itself being stale relative to current spec 09) that needs fixing, not
  the discipline mechanism.
- **Scope discipline** — every exported function matches the plan's Approach section 1:1, no extra
  exported surface beyond what's justified (the SALT-cap constants were anticipated by the plan's
  own Risks item 1 as "add once the constant exists," not scope creep). Confirmed via `grep -rn
  "tax-compute"` equivalent: only `lib/tax-compute.ts` and its test file reference the new module;
  nothing wired into `actions/`, `components/`, or any page. No DB/Prisma-client query imports, no
  `"use server"`, no `any` — confirmed by reading the file directly.
- **Federal bracket half-open convention, SE tax wage-base cap, Additional Medicare Tax exclusive
  threshold** — spot-checked several boundary values by hand against spec 09's literal table
  (e.g. $96,950 → $11,157: $23,850×10% + $73,100×12% = $2,385 + $8,772 = $11,157 ✓); all correct.

## What's good

- Every hardcoded constant carries an inline citation to its exact spec 09 bullet/table, and I
  didn't find a single uncited or invented number anywhere in the file.
- The two disclosed plan deviations (CT Table C fence-post, QBI raw-profit simplification) are
  genuinely well-reasoned, not just asserted — I re-derived both by hand and they hold up.
- Extremely thorough completion report restating the disposition of every one of the plan's 15
  Risks items — made this review much easier to cross-check quickly.
- 72 focused unit tests covering real boundary/fence-post cases (not just happy-path), including
  two full hand-computable end-to-end scenarios; I re-verified the golden-path arithmetic myself
  and it's correct.
- Scope discipline is excellent — this is a genuinely pure, fully unwired module exactly as scoped;
  nothing snuck in beyond the plan.

---

## Second pass (2026-09-17)

## Verdict: CHANGES_REQUESTED

## Route-back target: coder

One more small, mechanical fix needed — see finding 4 below. Everything from the first pass is
now genuinely resolved (verified by re-reading the code directly, not just the Tester's/Coder's
write-ups).

### First-pass findings — verified resolved

- **Finding 1 (CT Table D/E stubs, blocking).** Read `lib/tax-compute.ts:618–780` directly:
  `CT_TABLE_D_MFJ_2025` (51 bands) and `CT_TABLE_E_MFJ_2025` (29 bands) are now literal, ordered
  arrays with a first-match top-down lookup (`computeCtRecapture`/`computeCtPersonalCreditDecimal`,
  lines 693–703 / 771–780), both terminating in an `upperBound: null` catch-all row, so
  `requiresManualLookup: true` is genuinely unreachable for any real input — confirmed by reading
  the loop condition myself, not just trusting the Tester's boundary trace. The stale gap message is
  gone (`lib/tax-compute.ts:968–970` now correctly frames an unreachable-in-practice defensive
  fallback rather than blaming spec 09). Re-ran `pnpm vitest run lib/__tests__/tax-compute.test.ts`
  myself: 83/83 pass. Resolved.
- **Finding 2 (asymmetric `gaps` array, should-fix).** Read `lib/tax-compute.ts:973–983` directly —
  two unconditional `gaps.push(...)` calls (AGI-upper-bound, QBI-raw-Schedule-C-profit) sit outside
  any `if`, always fire. Resolved.
- **Finding 3 (`agi` naming, should-fix).** `grep -n "agiUpperBound|\.agi\b"` across
  `lib/tax-compute.ts` and its test file shows every reference renamed consistently
  (`FederalTaxResult.agiUpperBound`, the orchestrator wiring at line 926, both test assertions);
  zero stray `.agi` accesses anywhere in the repo. Resolved.

### New finding — CT Table E credit-application mechanic (Risks item 5)

**4. `computeConnecticutTax` implements the wrong formula for how Table E's decimal applies,
relative to spec 09's now-resolved primary-source mechanic — numerically moot today, but the code
and its doc comment are stale against a spec fact that's since been nailed down. (should-fix,
route to coder for a small mechanical correction)**

I re-read the newly-added "Tax Calculation Schedule mechanic" section in
`specs/09-tax-year-2025-constants.md` (added since the last review round) myself, not just the
task prompt's summary of it. The primary source's literal CT-1040 TCS Line 1–10 sequence is:
`Line 7 = initialTax + phaseOutAddback + recapture`, then `finalTax = Line 7 − Line 9` where
`Line 9 = Line 7 × decimal`. I.e. `ctTax = (initialTax + phaseOutAddback + recapture) × (1 − decimal)`.

`lib/tax-compute.ts:824–827`'s actual code:
```
ctTaxComputed = initialTax
  .plus(phaseOutAddback)
  .plus(recapture.amount!)
  .minus(initialTax.times(personalCredit.decimal!));
```
This multiplies the decimal against `initialTax` alone, not against `Line 7`
(`initialTax + phaseOutAddback + recapture`) — the formula spec 09 explicitly says NOT to use.

I independently confirmed spec 09's own mootness claim by reading the three gating functions
directly (not just trusting the spec's assertion): `computeCtPhaseOutAddback` (`lib/tax-compute.ts:593–602`)
returns `$0` whenever `ctAGI <= 100500`; `computeCtRecapture`'s first Table D band covers
`$0–$210,000 -> $0`; and `CT_TABLE_E_MFJ_2025`'s decimal is `0.00` for any `ctAGI > 100500` (spec
09 lines 116+, confirmed by the Tester's boundary trace at `$100,501 -> 0.00`). So whenever the
decimal is nonzero (`ctAGI <= 100,500`), `phaseOutAddback` and `recapture` are structurally always
`$0` by the same threshold, making `initialTax` and `Line 7` identical at every input where the
decimal matters — the two formulas can never diverge for any real `Decimal` input, moot by
construction, not just "moot for realistic filers." No test in the suite can distinguish the two
formulas for this reason, which is itself worth noting: the green test suite gives zero signal on
this correctness question either way.

The doc comment at `lib/tax-compute.ts:765–769` is also now stale — it says "WHICH CT
tax-liability line this decimal multiplies isn't stated in spec 09," which was true when written
but is no longer true; spec 09 now states it explicitly and unambiguously (with the primary-source
line-by-line citation).

**My call: fix it, route to coder, do not approve as-is.** Reasoning:
- Spec 09 itself explicitly instructs implementing the literal formula "anyway rather than relying
  on that coincidence" specifically *because* a CPA reviewing this code for the actual Oct 15, 2026
  filing shouldn't find an avoidable inaccuracy — that's precisely the standard this review holds
  the module to elsewhere (ground rule 8: tax outputs are drafts for a CPA/filer to review). A CPA
  or future maintainer reading `computeConnecticutTax` next to the now-fully-resolved spec 09 would
  immediately flag the mismatch, and the stale "unverified" doc comment compounds it by actively
  asserting a already-superseded state of the world — the same defect pattern (code/comments lagging
  a spec update) that drove the first CHANGES_REQUESTED verdict on Table D/E.
- The fix is small and mechanical (change the `.minus(initialTax.times(...))` line to multiply the
  `Line 7` sum instead, update the doc comment, and it would be good practice to add one boundary
  test at a CT AGI where `phaseOutAddback`/`recapture` are momentarily forced nonzero alongside a
  nonzero decimal — impossible with real Table C/D/E data today, so a literal unit test of
  `computeConnecticutTax`'s formula in isolation, decoupled from the real tables, is the only way to
  actually exercise the corrected line; otherwise this fix is permanently untestable through the
  public API) — this is not an architectural question, it's a one-function correction.
- This is not blocking in the sense of "produces a wrong number today" — it doesn't, for any input
  the engine can currently receive. I'm treating it as should-fix, not blocking, but still worth one
  more small route-back rather than shipping a doc comment that misstates its own spec and a formula
  that only coincidentally matches the authoritative mechanic.

Concretely, for the coder: replace the `.minus(initialTax.times(personalCredit.decimal!))` line
with `.minus(initialTax.plus(phaseOutAddback).plus(recapture.amount!).times(personalCredit.decimal!))`
(i.e. multiply the full `Line 7` sum, not `initialTax` alone), update the doc comment at
`lib/tax-compute.ts:765–769` to cite spec 09's now-resolved mechanic instead of calling it
unverified, and add a note on `computeConnecticutTax` itself (or its `ConnecticutTaxResult` doc
comment) explaining why this formula choice is currently untestable via the public API given
Table C/D/E's gating thresholds.

### What's good (second pass)

- Genuinely thorough, independently-verified route-back fix — every first-pass finding was
  substantively resolved, not just reworded, and I confirmed each one by reading the actual code
  rather than trusting the write-ups.
- The Coder's/Tester's own disclosure of the Table E mechanic as an open item (rather than silently
  closing it) is exactly the right instinct — it's what made this second-pass finding cheap to spot
  rather than requiring a third round of archaeology.

## Natural next pipeline task (once this one is re-approved)

The DB-wiring layer that resolves real `Document`/`Paystub`/`MileageEntry`/`TaxQuestion` rows into
this module's plain-number/`Decimal` inputs (a future `lib/tax-compute-build.ts` or an
`actions/tax.ts` addition, per the plan's own "Explicitly NOT in scope" section). When that task is
planned, it should also address the plan's still-genuinely-blocked gaps (1098/property-tax
extraction ambiguity, home office sqft capture, structured estimated-payments/retirement-
contribution capture, `Paystub.taxBreakdown` label-matching fragility) — none of those are this
review's concern, they're correctly out of scope for a pure-function task, but they're the logical
next increment once the arithmetic core here is re-approved.

---

## Third pass — final verdict (2026-09-17)

## Verdict: APPROVED

Confirmed the second-pass fix (finding 4, CT Table E's credit-application mechanic) myself by
reading `lib/tax-compute.ts:755-853` directly, not by trusting the Coder's or Tester's write-ups.

- `computeConnecticutTax` (lines 823-837) now computes `line7 =
  initialTax.plus(phaseOutAddback).plus(recapture.amount!)` once, then `ctTaxComputed =
  line7.minus(line7.times(personalCredit.decimal!))` — the decimal multiplies the full Line 7 sum,
  exactly as I specified, not `initialTax` alone. An inline comment at the call site (lines 825-834)
  correctly cites the CT-1040 TCS Line 7/Line 9 mechanic and honestly notes the formula choice is
  currently unexercisable via the public API given Table C/D/E's real thresholds.
- The doc comment above `computeCtPersonalCreditDecimal` (lines 758-771) no longer says "isn't
  stated in spec 09" — it now cites the resolved "Tax Calculation Schedule mechanic" section and
  states the Line 7/Line 9 formula explicitly.
- Independently re-ran `pnpm typecheck` (clean, zero errors) and `pnpm vitest run
  lib/__tests__/tax-compute.test.ts` (83/83 passed) myself in this pass rather than trusting the
  Tester's third-pass numbers — both match exactly what the Tester reported.

Both prior review rounds' findings (CT Table D/E stub boundary, asymmetric `gaps` array, `agi`
naming, and now the Table E credit-application mechanic) are genuinely resolved. Nothing new to
flag. Findings 2/3 from the first pass (should-fix) and finding 4 from the second pass (should-fix)
were all substantively fixed, not just addressed cosmetically — this module is a well-scoped, fully
cited, thoroughly tested pure-function tax engine with no DB/UI wiring, exactly matching the plan's
boundaries.

**This task is done.** The natural next pipeline task is the DB-wiring layer described above — a
`lib/tax-compute-build.ts`-style module (or an `actions/tax.ts` addition) that resolves real
`Document`/`Paystub`/`MileageEntry`/`TaxQuestion` Prisma rows into this module's plain-number/
`Decimal` inputs, and which should also pick up the plan's still-genuinely-blocked gaps (1098/
property-tax extraction ambiguity, home office sqft capture, structured estimated-payments/
retirement-contribution capture, `Paystub.taxBreakdown` label-matching fragility) as its own scope.
