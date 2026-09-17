# 01 — Plan: Tax computation engine (TY2025)

## Restated goal

Build `lib/tax-compute.ts`, a pure, unit-tested TY2025 tax-math module covering exactly three real
filings — Eric + Eva's personal Form 1040 (MFJ), Eric Kinniburgh Consulting LLC's Schedule C, and
CT-1040 — computing real dollar figures (wages, Schedule C net profit, SE tax, QBI deduction,
standard-vs-itemized, federal bracket tax, CT AGI/taxable income/tax via DRS Tables A–E, Additional
Medicare Tax check) from data this app can actually supply today. No PDF generation, no UI, no
Sudden Valley/Mezzo logic, no e-filing.

## Scope

**In scope**
- New file `lib/tax-compute.ts` — pure functions only (no DB/Prisma-client queries, no `"use server"`,
  `Decimal` from `@prisma/client/runtime/library` for all money math, matching
  `lib/business-quarter-forecast.ts`'s pattern).
- New file `lib/__tests__/tax-compute.test.ts` — Vitest, following this repo's `D()`/`d()` local
  helper convention (see `lib/__tests__/business-quarter-forecast.test.ts`).
- Computations: federal bracket tax (MFJ, TY2025), standard deduction, itemized-deduction totals +
  standard-vs-itemized selection, Schedule C net profit (GL P&L + mileage + simplified home-office),
  self-employment tax (with the $176,100 wage-base cap), Additional Medicare Tax, QBI deduction
  (with a documented phase-in simplification — see Risks), federal taxable income / total tax
  *before credits* / payments-vs-tax balance, CT Table A (personal exemption), Table B (initial tax),
  Table C (2% phase-out add-back), Table D (recapture, stubbed beyond a known-safe boundary), Table E
  (personal tax credit decimal, stubbed below a known-safe boundary), and CT balance due/refund where
  computable. A `gaps: string[]` field on the top-level result that names which known data gaps
  affected that specific computation (never a silent `$0`).

**Explicitly NOT in scope (do not build, do not guess constants for)**
- PDF form generation/filling, UI/intake screens, e-filing (per request doc).
- Sudden Valley PM LLC / Mezzo tax logic (no 2025 filing obligation — spec 07 item 7/"Resolved by
  owner" list; spec 09 header).
- **Dollar computation of any credit** (Child Tax Credit, Residential Clean Energy/solar 25D, EV
  Clean Vehicle Credit, Saver's Credit, CT property tax credit Schedule 3). The request's own
  enumeration of what this engine computes stops at "the federal Additional Medicare Tax check" —
  it does not list credits. More importantly, **none of these credits' constants (CTC $2,000/child
  phase-out, 30% solar rate application mechanics, Saver's Credit income bands, EV $300k MFJ MAGI
  cap) are present in `specs/09-tax-year-2025-constants.md`**, and the CT property tax credit is
  explicitly flagged there as "not yet cross-checked against the actual 2025 Schedule 3 form." Per
  the request's own ground rule, this engine computes federal/CT tax **before credits** only, clearly
  labeled as such (`totalTaxBeforeCredits`, `balanceDueOrRefundBeforeCredits`). Adding a credits
  engine is real follow-on work once those constants are added to spec 09.
- Any DB-aware wiring layer that queries Prisma, aggregates multiple `Document`/`Paystub` rows, or
  decides which extraction field to trust — `tax-compute.ts` takes **pre-resolved plain
  numbers/Decimals** as input (mirrors `lib/tax-form-plan.ts`'s `PersonalFormPlanInput` precedent: the
  pure module never imports `db`). Building that wiring layer (a future `lib/tax-compute-build.ts` or
  an `actions/tax.ts` addition) is a separate follow-on task — flagged in Risks, not built here.
- Rounding to IRS's whole-dollar form convention — the engine keeps full `Decimal` (cent) precision;
  rounding-for-display is a future PDF/UI concern.
- Editing `specs/09-tax-year-2025-constants.md` itself — if a needed constant is missing (it is, see
  Risks item 1), that's the owner/researcher's job to add after primary-source verification, not the
  Coder's.

## Affected files/modules

- `lib/tax-compute.ts` — new.
- `lib/__tests__/tax-compute.test.ts` — new.
- No other files change. Nothing is wired into `actions/tax.ts`, `components/tax/*`, or any page this
  task — this is intentionally an unwired, fully pure module (matches the request's own framing:
  "no UI in this task, that's separate follow-on work").

## Constants and their spec 09 citations

All hardcoded in `lib/tax-compute.ts`, each with an inline comment citing the exact spec 09
table/bullet. No other constant may be introduced.

| Constant | Value | Spec 09 citation |
|---|---|---|
| `STANDARD_DEDUCTION_MFJ_2025` | `31500` | Federal § bullet 1 (OBBBA-raised MFJ standard deduction) |
| `FEDERAL_BRACKETS_MFJ_2025` | 7-row table, rates 10–37%, thresholds $0/$23,850/$96,950/$206,700/$394,600/$501,050/$751,600 | Federal § "Tax brackets, MFJ" table |
| `SE_NET_EARNINGS_FACTOR` | `0.9235` | Federal § "Self-employment tax (Schedule SE)" bullet |
| `SE_OASDI_RATE` | `0.124` | same bullet |
| `SE_MEDICARE_RATE` | `0.029` | same bullet |
| `SE_WAGE_BASE_2025` | `176100` | same bullet |
| `ADDITIONAL_MEDICARE_TAX_RATE` | `0.009` | Federal § "Additional Medicare Tax" bullet |
| `ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ` | `250000` | same bullet |
| `QBI_RATE` | `0.20` | Federal § "QBI deduction (§199A)" bullet |
| `QBI_PHASE_IN_START_MFJ` | `394600` | same bullet |
| `QBI_PHASE_IN_END_MFJ` | `494600` | same bullet |
| `STANDARD_MILEAGE_RATE_2025` | `0.70` | Federal § "Standard mileage rate, 2025" bullet |
| `HOME_OFFICE_SIMPLIFIED_RATE_PER_SQFT` | `5` | Federal § "Home office simplified method" bullet |
| `HOME_OFFICE_SIMPLIFIED_MAX_SQFT` | `300` | same bullet |
| `CT_TABLE_A_MFJ_2025` (exemption) | full-exemption AGI ≤ $48,000, $1,000-per-$1,000 step-down, $0 by $71,000 | CT § "Table A — Personal exemption" |
| `CT_TABLE_B_MFJ_2025` (initial tax) | 7-row bracket table exactly as printed | CT § "Table B — Initial tax" |
| `CT_TABLE_C` (2% phase-out add-back) | $0 ≤ $100,500; +$50/$5,000 above; capped $500 at $145,500+ | CT § "Table C" |
| `CT_TABLE_D` (recapture) | ONLY the two boundary facts are usable (see Risks item 2) | CT § "Table D" |
| `CT_TABLE_E` (personal tax credit decimal) | ONLY the $100,500→$0.00 boundary is usable (see Risks item 3) | CT § "Table E" |

**No SALT cap constant exists in spec 09** — see Risks item 1. `computeItemizedDeduction` therefore
takes `saltCapCents` as a **required parameter with no default**, not a hardcoded constant.

## Approach (ordered steps)

1. **Scaffold `lib/tax-compute.ts`** with a file-level doc comment matching
   `lib/business-quarter-forecast.ts`'s style: states this is pure/`Decimal`-only/TY2025-only, no DB
   imports, and restates the "tax before credits only" scope boundary and the SALT-cap/Table-D/Table-E
   stub caveats up front so nobody has to re-derive them from this plan later.
2. **Federal constants block** — add every Federal-section constant from the table above, each with an
   inline citation comment. `FEDERAL_BRACKETS_MFJ_2025` as an array of `{ rate: Decimal; min: Decimal;
   max: Decimal | null }`, using each bracket's **lower** threshold as the cumulative cutoff (standard
   marginal-bracket implementation: a dollar at exactly $23,850 is taxed in the 10% band, the next
   dollar starts the 12% band — i.e. half-open `[min, nextMin)` intervals).
3. **`computeFederalBracketTax(taxableIncome: Decimal): Decimal`** — sums marginal tax across
   `FEDERAL_BRACKETS_MFJ_2025`; returns `Decimal(0)` for `taxableIncome <= 0`.
4. **`computeMileageDeduction(entries, taxYear)`** —
   `{ entries: { miles: number; ratePerMile: Decimal; date: Date }[] }` (shape matches
   `MileageEntry`'s real columns). Sums `miles * ratePerMile` using **each entry's own stored rate**
   (correct even for mixed-tax-year logs, since `MileageEntry.ratePerMile` is captured at entry time
   per the schema comment). Separately returns `mismatchedRateEntries` — any entry dated within
   `taxYear` whose `ratePerMile !== STANDARD_MILEAGE_RATE_2025` — as a data-quality flag, not silently
   corrected.
5. **`computeHomeOfficeSimplifiedDeduction(sqft: number | null): Decimal`** —
   `min(sqft ?? 0, 300) * 5`. Returns `Decimal(0)` when `sqft` is `null` (today, always — see Risks
   item 5) — the function itself cannot distinguish "no home office" from "sqft not yet captured";
   that distinction belongs in the `gaps` array built in step 14, not here.
6. **`computeScheduleCNetProfit(input): Decimal`** — `glIncomeTotal - glExpenseTotal -
   mileageDeduction - homeOfficeSimplifiedDeduction`, where `glIncomeTotal`/`glExpenseTotal` are the
   caller-supplied unsigned totals from `computePL(ekConsultingEntityId, ...)` (see
   `lib/reports.ts`). Doc comment must flag the **double-counting risk**: if the household also books
   home-office costs as GL-coded expenses (EK Consulting's GL code `"5030"` = "Home Office," per
   confirmed repo convention) *and* the simplified $5/sqft method is applied here, the deduction is
   counted twice — this pure function has no way to detect that; the future DB-wiring layer must pick
   one method and pass `homeOfficeSimplifiedDeduction: Decimal(0)` if GL-coded actual-method costs are
   already present in `glExpenseTotal`.
7. **`computeSelfEmploymentTax(input): SelfEmploymentTaxResult`** —
   `input: { scheduleCNetProfit: Decimal; priorSocialSecurityWages?: Decimal }` (defaults to 0;
   doc-comment flags this as an assumption — Eric has no separate W-2 job reducing his SE wage base
   per source data, but the parameter exists for correctness/future-proofing). `netSEEarnings =
   max(0, scheduleCNetProfit) * SE_NET_EARNINGS_FACTOR` (SE tax is $0 on a loss — do not produce a
   negative tax). OASDI applies to `min(netSEEarnings, max(0, SE_WAGE_BASE_2025 -
   priorSocialSecurityWages))`; Medicare applies to the full `netSEEarnings`, uncapped.
   `deductibleHalf = totalSETax / 2` (the above-the-line SE tax deduction).
8. **`computeAdditionalMedicareTax(input: { medicareWages: Decimal; netSEEarnings: Decimal }):
   Decimal`** — `max(0, medicareWages + netSEEarnings - ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ) *
   ADDITIONAL_MEDICARE_TAX_RATE`. Doc comment: this computes the correct **total** liability; it does
   not model Form 8959's wages-first-then-SE-income ordering (irrelevant to the total, only to which
   line the amount lands on — out of scope without PDF generation).
9. **`computeQBIDeduction(input): QBIDeductionResult`** —
   `{ qualifiedBusinessIncome: Decimal; taxableIncomeBeforeQBI: Decimal }`. Below
   `QBI_PHASE_IN_START_MFJ`: `deduction = min(qbi * 0.20, taxableIncomeBeforeQBI * 0.20)` (net-capital-gain
   reduction of the second cap is **not modeled** — no investment-income input exists; doc comment
   flags this as an assumption of $0 net capital gain). At/above `QBI_PHASE_IN_END_MFJ`: **stub at
   $0** with `notes: ["above $494,600 MFJ taxable income: W-2 wage/UBIA limitation not modeled — no
   wages-paid or qualified-property data exists for EK Consulting; deduction stubbed at $0, needs CPA
   review before relying on it"]` — per the request's own instruction to stub rather than guess. Inside
   the band: **linear interpolation** between the full-deduction value (at the start threshold) and $0
   (at the end threshold) as a **documented simplification** (the true §199A wage/UBIA phase-in formula
   isn't computable without wages-paid/qualified-property data this app doesn't capture) — `notes` must
   say so explicitly whenever `phaseInFraction` is used.
10. **`computeItemizedDeduction(input): ItemizedDeductionResult`** —
    `{ mortgageInterestCents, propertyTaxCents, ctIncomeTaxWithheldCents, charitableCents, saltCapCents
    }`. `saltCapCents` is **required, no default** (see Risks item 1) — the function should not silently
    assume $10,000. `saltAfterCap = min(propertyTax + ctIncomeTaxWithheld, saltCapCents)`.
    `charitableCents` will be `null`/0 in practice today (no donation-log data source — matches
    `lib/tax-form-plan.ts`'s own `"Gifts to charity (line 11)": false` comment). **Only the primary
    residence's property tax belongs here** — Sudden Valley's Arbor Rd property tax is a Schedule E
    rental expense, already inside `suddenValleyPL`, and must never be passed into this function (flag
    in the doc comment; this is a future-wiring-layer responsibility, not something this pure function
    can enforce).
11. **`selectDeductionMethod(itemizedTotal, standardDeduction = STANDARD_DEDUCTION_MFJ_2025)`** —
    itemized wins only if `itemizedTotal > standardDeduction` (strict); an exact tie takes the
    standard deduction.
12. **`computeFederalTax(input): FederalTaxResult`** — orchestrates steps 3/7–11: `totalIncome = wages
    + interestIncome + scheduleCNetProfit`; `agi = totalIncome - selfEmploymentTax.deductibleHalf`
    (doc comment: retirement/HSA/SE-health-insurance above-the-line deductions are **not** subtracted
    — dollar amounts aren't captured anywhere yet, so this AGI is an upper bound; see Risks item 6);
    `taxableIncome = max(0, agi - deductionUsed - qbi.deduction)`; `bracketTax =
    computeFederalBracketTax(taxableIncome)`; `totalTaxBeforeCredits = bracketTax +
    selfEmploymentTax.totalSETax + additionalMedicareTax`; `totalPayments = federalWithholding +
    (estimatedPayments ?? 0)`; `balanceDueOrRefundBeforeCredits = totalPayments -
    totalTaxBeforeCredits`.
13. **CT constants block** — `CT_TABLE_A_MFJ_2025`, `CT_TABLE_B_MFJ_2025`, `CT_TABLE_C`, plus the
    partial `CT_TABLE_D`/`CT_TABLE_E` boundary constants, each citing the spec 09 CT § table. Table A's
    comment must document the chosen boundary interpretation explicitly (see Risks item 4) so a future
    reader isn't confused why the step size isn't a clean $1,000/$1,000.
14. **`computeCtPersonalExemption(ctAGI): Decimal`** (Table A) — `24000` at `ctAGI <= 48000`; steps
    down; `0` at `ctAGI >= 71000` per spec 09's literal stated boundary (documented interpretation:
    treat "$1,000 per $1,000 of CT AGI above $48,000" as a step function using `ceil((ctAGI-48000)/1000)`
    steps of $1,000 each, floored at 0, with the last nonzero step at $70,001–$71,000 and $0 from
    $71,001 — matches spec 09's literal "$0 at CT AGI ≥ $71,000" without contradicting its
    "$1,000-per-$1,000" description; flagged as a low-materiality (≤$1,000 exemption, i.e. ≤$45 CT tax
    at the 4.5% band) interpretation choice, not a fabricated number).
15. **`computeCtInitialTax(ctTaxableIncome): Decimal`** (Table B) — straightforward marginal
    bracket-base-plus-rate lookup over `CT_TABLE_B_MFJ_2025`'s 7 rows, fully specified by spec 09 — no
    ambiguity here.
16. **`computeCtPhaseOutAddback(ctAGI): Decimal`** (Table C) — `0` at `ctAGI <= 100500`; else
    `min(500, ceil((ctAGI - 100500) / 5000) * 50)` — fully computable from spec 09's literal "$50 per
    $5,000... capping at $500 once CT AGI > $145,500" (10 steps of $50 land exactly on $145,500 −
    $100,500 = $45,000 = 9 steps... verify the exact step count against the cap during implementation
    and adjust the step formula if `ceil` vs `floor` produces a premature/late cap — test at both
    $100,500 and $145,500 exactly, see Test Expectations).
17. **`computeCtRecapture(ctAGI): { amount: Decimal | null; requiresManualLookup: boolean }`** (Table
    D) — `ctAGI <= 210000` → `{ amount: Decimal(0), requiresManualLookup: false }` (confirmed by spec
    09's literal "$0 until CT AGI > $210,000"). `ctAGI > 210000` → `{ amount: null,
    requiresManualLookup: true }` with a code comment: spec 09 only describes the *shape* of the
    interior table ("$50–$180 increments per $10,000 bracket, capping at $6,800 once CT AGI >
    $1,080,000"), not the exact per-bracket values — **do not guess**; this must stay a stub until the
    real DRS Table D is transcribed into spec 09.
18. **`computeCtPersonalCreditDecimal(ctAGI): { decimal: Decimal | null; requiresManualLookup: boolean
    }`** (Table E) — `ctAGI > 100500` → `{ decimal: Decimal(0), requiresManualLookup: false }`
    (confirmed boundary). `ctAGI <= 100500` → `{ decimal: null, requiresManualLookup: true }` — spec 09
    gives only one interior anchor point (`0.75` at $24,000–$30,000) and the $0 boundary, not the full
    granular schedule; stub rather than guess. Code comment must also flag that spec 09 doesn't specify
    **which CT tax line the decimal multiplies** — that mechanic needs verifying against the real
    CT-1040 instructions before this stub is ever filled in, even once the table is transcribed.
19. **`computeConnecticutTax(input): ConnecticutTaxResult`** — `input: { ctAGI: Decimal;
    ctWithholdingCents: number }`, doc comment: assumes `ctAGI === federal AGI` because CT-specific
    AGI modifications aren't modeled anywhere in this app (matches `lib/tax-form-plan.ts`'s own "CT
    adjusted gross income: From federal AGI plus CT modifications" field description — today this app
    only tracks *whether* that's answered, never the modification amount). Wires steps 14–18:
    `ctTaxableIncome = max(0, ctAGI - personalExemption)`; `initialTax =
    computeCtInitialTax(ctTaxableIncome)`; if either `recapture.requiresManualLookup` or
    `personalCredit.requiresManualLookup` is true, set `netTaxBeforeCreditsUnknown: true` and
    `ctTaxComputed: null` / `balanceDueOrRefund: null` (never silently substitute $0 for an unknown
    table lookup); otherwise `ctTaxComputed = initialTax + phaseOutAddback + recapture.amount! -
    (initialTax * personalCredit.decimal!)` and `balanceDueOrRefund = ctWithholding - ctTaxComputed`.
20. **`computePersonalTaxReturn(input): TaxComputeResult`** — top-level orchestrator wiring steps
    6→12→19. First line: `if (input.taxYear !== 2025) throw new Error(...)` (these constants are
    TY2025-only; guards against silent misuse in a future tax year before this file is updated).
    Builds `gaps: string[]` by inspecting which known-gap conditions were actually triggered by this
    specific input (e.g. push `"home office square footage not captured — $0 deduction assumed"` only
    when `sqft` was null; push `"CT Table D/E interior values not yet transcribed into spec 09 —
    CT balance due/refund not computable at this CT AGI"` only when `netTaxBeforeCreditsUnknown` is
    true) — never a static list, always reflecting what actually happened in this call.
21. **Tests** — write `lib/__tests__/tax-compute.test.ts` per Test Expectations below, using this
    repo's `const D = (s: string) => new Decimal(s)` / `const d = (iso: string) => new Date(iso +
    "T00:00:00Z")` local-helper convention (see `lib/__tests__/business-quarter-forecast.test.ts`).
22. **Verify** — run `pnpm typecheck`, `pnpm lint`, `pnpm vitest run lib/__tests__/tax-compute.test.ts`,
    then full `pnpm test` to confirm no regressions elsewhere.
23. **Completion report** — the Coder's handback must restate, verbatim, the status of every item in
    Risks/Real Data Gaps below (implemented-with-documented-stub vs. genuinely blocked) so the owner
    and Reviewer see it without re-reading this plan.

## Risks/unknowns (real data gaps — required section)

1. **No SALT cap constant in spec 09 — a genuinely missing constant, not just a missing data value.**
   `specs/09-tax-year-2025-constants.md`'s Federal section covers standard deduction, brackets, SE tax,
   Additional Medicare Tax, QBI, mileage, and home office — it never states the Schedule A SALT cap.
   `lib/tax-guidance.ts`'s existing UI copy says "$10,000," but that predates spec 09's
   primary-source-verification effort and OBBBA (the same mid-2025 law that raised the standard
   deduction) is known to have also touched SALT-cap treatment for 2025 in the wider tax landscape —
   trusting the old $10,000 figure without spec 09 confirmation would repeat exactly the kind of
   secondary-source error spec 09 was written to avoid. **Recommendation: the owner/researcher adds a
   verified SALT-cap figure to spec 09 before this constant is trusted anywhere.** Until then,
   `computeItemizedDeduction` requires `saltCapCents` as a caller-supplied parameter with no default,
   so nothing in this file itself hardcodes a possibly-wrong number.
2. **CT Table D (recapture) is only partially transcribed into spec 09** — only the $0-below-$210,000
   and $6,800-cap-above-$1,080,000 boundaries are given; the interior "$50–$180 increments per $10,000
   bracket" is a description, not exact values. Stubbed (`requiresManualLookup: true`, `amount: null`)
   for any CT AGI above $210,000 until the real DRS Table D is transcribed.
3. **CT Table E (personal tax credit decimal) is only partially transcribed** — one interior anchor
   ($0.75 at $24,000–$30,000 CT AGI) plus the $0-at-$100,500+ boundary. Stubbed for CT AGI ≤ $100,500.
   Given this household's combined dual-income + consulting-income profile, CT AGI is plausibly above
   $100,500 in most years (making this stub moot in practice) — but the engine must not assume that;
   it checks the actual figure and stubs honestly when it lands below the known-safe boundary.
4. **CT Table A's literal wording is internally imprecise** — "$1,000 per $1,000 of CT AGI above
   $48,000" and "reaching $0 at CT AGI ≥ $71,000" don't reconcile under pure linear subtraction (which
   would reach $0 at $72,000, not $71,000). The plan documents one specific, reasonable step-function
   interpretation (§14 above) rather than guessing a new number — but this is a genuine ~$1,000
   exemption / ~$45 CT-tax edge case the owner or CPA should sanity-check against the real Table A PDF
   before filing.
5. **Table E's credit-application mechanics are unstated in spec 09** — which CT tax-liability line the
   personal-credit decimal multiplies isn't specified. Implemented as multiplying `initialTax`
   (the most common real-world CT-1040 mechanic), but flagged in-code as unverified against the actual
   form instructions.
6. **Federal AGI/taxable income here don't subtract retirement/HSA/SE-health-insurance above-the-line
   deductions** — dollar amounts for these aren't captured anywhere (`retirement_contributions` is a
   free-text `TaxQuestion.answer`, not a structured number — see request's own known-gaps list item 4).
   This makes every AGI/taxable-income/tax figure this engine produces an **upper bound**, not a final
   number, until that data is captured structurally.
7. **No 2025 1098/property-tax-bill numeric extraction exists** — `property_tax` docType classifies to
   `doc-extract.ts`'s `"other"` shape, whose `data` is always `{}` (confirmed by reading
   `lib/doc-extract.ts` and `lib/tax-form-plan.ts`'s own comment on this). `mortgage_interest` docType
   does extract a numeric `interestCents`, but that field's prompt is written for a **monthly mortgage
   statement**, not a 1098 — whether that figure represents one month's interest or the full-year 1098
   total is genuinely ambiguous from the extraction shape alone; the future DB-wiring layer must sum
   multiple monthly documents or special-case a real 1098 upload, not assume one statement = the annual
   figure.
8. **Home office square footage is not stored anywhere in the schema** (confirmed — no `sqft`/similar
   field on `TaxQuestion`, `Document`, or any other model) — `computeHomeOfficeSimplifiedDeduction`
   always receives `null` today and returns `$0`, indistinguishable at the function level from "no home
   office." The top-level `gaps` array must name this explicitly whenever it fires.
9. **`MileageEntry` has zero rows for any entity today** despite the tax-readiness checklist claiming
   mileage is "compiled" (per the request's own known-gaps list) — `computeMileageDeduction` is correct
   math against whatever rows exist, but will silently compute `$0` today. Confirmed via schema read;
   not independently re-verified against live row counts in this planning pass (the request doc already
   states this as a known fact from a prior investigation — treat as current unless re-checked).
10. **Estimated tax payments are captured only as a free-text answer** (`estimated_taxes_2025`
    `TaxQuestion`, placeholder "Paid Q1-Q4 estimates totaling $X; or 'none'") — not a structured dollar
    figure anywhere. `computeFederalTax`'s `estimatedPaymentsCents` input must be `null` until a
    structured capture mechanism exists; the engine correctly treats `null` as "unknown," not "$0" —
    the DB-wiring layer must not silently coerce `null` to `0` when summing payments.
11. **`Paystub.taxBreakdown` is a freeform `{ label, amountCents }[]` array**, not structured
    federal/state fields (confirmed via `lib/paystub-extract.ts`'s extraction prompt) — a future
    DB-wiring layer summing "federal withholding across all paystubs" must pattern-match labels like
    "Federal Income Tax" case-insensitively, which is inherently fragile (a stub labeled differently
    would be silently missed). Flagged for whoever builds that layer; `tax-compute.ts` itself just
    takes the already-summed cents value as input.
12. **The request doc/prompt refers to a `TaxQuestionAnswer` model; the actual schema model is
    `TaxQuestion`** (with `answer: Json?` inline on the same row, no separate answer table) — noted here
    so the Coder doesn't go looking for a model that doesn't exist.
13. **Double-counting risk between GL-coded home-office expenses (EK Consulting's GL code `"5030"`) and
    the simplified $5/sqft method** — flagged in step 6 above; this pure function cannot detect or
    prevent it, only the future wiring layer can.
14. **Arbor Rd (Sudden Valley) property tax must never flow into the personal Schedule A SALT input** —
    it's a Schedule E rental expense already inside `suddenValleyPL`'s GL totals. A wiring-layer bug
    that includes it in `computeItemizedDeduction`'s `propertyTaxCents` would double-count it (once on
    Schedule E via GL codes, once on Schedule A). Flagged for the future wiring layer, not enforceable
    by this pure function.
15. This engine's output is a **draft estimate for CPA review**, never a filed number nor financial/tax
    advice, per CLAUDE.md ground rule 8 and the request's own framing — this isn't a new risk, but
    should be restated in the file's top doc comment so nobody downstream forgets it.

## Acceptance criteria

- `lib/tax-compute.ts` exists: pure (no `db`/Prisma-client query imports, no `"use server"`), strict
  TypeScript with no `any`, every exported function typed per this plan's signatures.
- Every hardcoded numeric constant has an inline comment citing its exact spec 09 table/bullet (per
  the citation table above); no constant appears that isn't in that table.
- `computeItemizedDeduction` has no default for `saltCapCents` (compiles to a required parameter) —
  confirms the missing-constant gap isn't silently papered over with an invented number.
- `computeCtRecapture`/`computeCtPersonalCreditDecimal` return `requiresManualLookup: true` and
  `null` (not a guessed number) outside their spec-09-confirmed boundaries.
- `computePersonalTaxReturn` throws for any `taxYear !== 2025`.
- `computePersonalTaxReturn`'s `gaps` array reflects the actual input (empty/near-empty for a
  fully-populated golden-path input; populated correctly when fed nulls matching the known gaps).
- `pnpm typecheck`, `pnpm lint`, and `pnpm vitest run lib/__tests__/tax-compute.test.ts` all pass with
  zero new errors/warnings; a full `pnpm test` run shows no regressions in other files.
- The Coder's completion report explicitly restates the status of every Risks/gaps item (implemented
  with documented stub vs. genuinely blocked) rather than leaving it to be re-derived from a diff.

## Test expectations

Unit tests only, in `lib/__tests__/tax-compute.test.ts` (Vitest `describe`/`it`/`expect`, `D()`/`d()`
helpers, no DB/mocking needed since everything is pure). No integration/e2e tests — matches this
repo's established "no DB in unit tests" convention and this task's explicit no-UI/no-DB scope.

**`computeFederalBracketTax`**
- Exactly at each bracket boundary ($23,850 → still 10%; $23,851 → first dollar at 12%; repeat for
  $96,950/$206,700/$394,600/$501,050/$751,600) — verify the marginal calc, not just a total.
- `$0` and negative taxable income → `Decimal(0)`.
- A income figure spanning all 7 brackets (e.g. $900,000) — verify cumulative sum matches hand-calc.

**`selectDeductionMethod`**
- Itemized total $1 below standard → `"standard"`.
- Itemized total exactly equal to standard → `"standard"` (tie-break rule).
- Itemized total $1 above standard → `"itemized"`.

**`computeSelfEmploymentTax`**
- Net SE earnings well under $176,100 → OASDI applies to full amount.
- Net SE earnings exactly at $176,100 (Schedule C profit chosen so `profit * 0.9235 === 176100`
  exactly, or nearest cent) → OASDI caps there, Medicare still applies to the full net SE earnings.
- Net SE earnings above $176,100 → OASDI capped, Medicare uncapped portion continues to grow.
- Schedule C net loss (negative profit) → `netSEEarnings`, both tax components, and `deductibleHalf`
  all `$0` (never negative).
- Nonzero `priorSocialSecurityWages` reduces the OASDI-taxable amount correctly, including the case
  where it already meets/exceeds the wage base (OASDI-taxable → $0, Medicare still applies).

**`computeAdditionalMedicareTax`**
- Combined wages + SE earnings at $249,999 → `$0`.
- Exactly $250,000 → `$0` (threshold is exclusive per "above $250,000").
- $250,001 → tax on the $1 excess only.
- A combined figure well above threshold → correct 0.9% on the full excess.

**`computeQBIDeduction`**
- Taxable income well below $394,600 → full 20% of QBI (assuming it's under the taxable-income cap
  too).
- Exactly at $394,600 → still full 20% (spec 09: "below $394,600... in full" — verify inclusive/exclusive
  boundary choice matches the implementation's documented interpretation).
- Midpoint of the phase-in band (e.g. $444,600) → the documented linear-interpolation value, with
  `notes` populated.
- Exactly at $494,600 and above → `$0` with the documented stub `notes` message present.
- Taxable-income cap binds (QBI × 20% > taxable income × 20%) → the lower of the two applies.

**Itemized deduction / SALT cap**
- `propertyTaxCents + ctIncomeTaxWithheldCents` under `saltCapCents` → uncapped sum used.
- Sum over `saltCapCents` → capped exactly at `saltCapCents`.
- `charitableCents: null` → treated as `$0`, not an error.

**CT Table A (`computeCtPersonalExemption`)**
- CT AGI ≤ $48,000 → exactly $24,000.
- CT AGI at $49,000 (one step in) → $23,000 per the documented step interpretation.
- CT AGI exactly $71,000 → the documented interpretation's value (per §14 of the plan, this should be
  the last nonzero step, not necessarily $0 — assert whichever the implementation's documented choice
  actually produces, since spec 09's own wording is ambiguous here; the test's job is to pin the
  chosen behavior, not silently accept drift).
- CT AGI at $71,001+ → $0.

**CT Table B (`computeCtInitialTax`)**
- One value inside each of the 7 bands, plus exactly at each of the 6 internal boundaries
  ($20,000/$100,000/$200,000/$400,000/$500,000/$1,000,000) verifying the higher bracket's base amount
  kicks in correctly (e.g. exactly $20,000 → still $400 flat, i.e. 2% × $20,000; $20,001 → $400 + 4.5%
  of $1).

**CT Table C (`computeCtPhaseOutAddback`)**
- CT AGI ≤ $100,500 → $0.
- CT AGI at $145,500 exactly → $500 (verify the step formula lands the cap at the right point, per the
  plan's step-16 caveat — this is exactly the boundary the implementation's chosen `ceil`/`floor` needs
  validating against).
- CT AGI at $145,501+ → still capped at $500.
- A mid-range value (e.g. $110,500, one $5,000 step in) → $50.

**CT Table D (`computeCtRecapture`)**
- CT AGI ≤ $210,000 → `{ amount: Decimal(0), requiresManualLookup: false }`.
- CT AGI at $210,001 → `{ amount: null, requiresManualLookup: true }`.
- CT AGI at $1,080,000+ → still `requiresManualLookup: true` (the cap value $6,800 is known but not
  safe to return without the interior table, per the plan's conservative stub decision — confirm this
  matches whatever the Coder actually implements, and flag in the Coder's report if it deviates).

**CT Table E (`computeCtPersonalCreditDecimal`)**
- CT AGI at $100,500 exactly → per the spec's literal ">" wording, verify whether this is the
  stub side or the confirmed-$0 side and pin that choice with a test (ambiguous boundary, same caveat
  class as Table A).
- CT AGI at $100,501+ → `{ decimal: Decimal(0), requiresManualLookup: false }`.
- CT AGI at $50,000 (inside the un-transcribed interior) → `{ decimal: null, requiresManualLookup:
  true }`.

**Mileage / home office**
- Entries with a mix of 2024-dated (67¢) and 2025-dated (70¢) rates → deduction sums each entry's own
  stored rate correctly; only the 2025-dated, off-70¢ entries appear in `mismatchedRateEntries`.
- `sqft: null` → `$0`.
- `sqft: 400` (over the 300 cap) → deduction capped at `300 * 5 = 1500`.

**`computePersonalTaxReturn` (end-to-end)**
- One golden-path scenario with fully-populated realistic inputs (all documents/answers present,
  `saltCapCents` supplied) — assert the full chain (Schedule C → AGI → taxable income → bracket tax →
  SE tax → Additional Medicare Tax → balance before credits) matches a hand-computed expected value,
  and `gaps` is empty or near-empty.
- One gap-heavy scenario (null sqft, null estimated payments, empty mileage, CT AGI inside an
  un-transcribed table band) — assert `gaps` contains the expected messages and that
  `connecticut.balanceDueOrRefund`/`ctTaxComputed` are `null`, never a guessed number.
- `taxYear: 2024` (or any non-2025 value) → throws.
