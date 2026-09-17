import { Decimal } from "@prisma/client/runtime/library";

// ── Tax computation engine (TY2025) ──────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/tax-compute.test.ts. No DB/
// Prisma-client query imports, no "use server". Money: Decimal everywhere,
// never floats, EXCEPT where a parameter is explicitly named `*Cents` — those
// mirror the integer-cents convention already used by structured document
// extraction (Document.extractionData, e.g. w2's `wagesCents`) and other Int
// cents columns (e.g. DebtDetail.originalBalanceCents), matching the shape
// the future DB-wiring layer will actually have on hand. Everywhere else
// (GL P&L totals from computePL, computed intermediate results) is a Decimal
// DOLLAR amount, matching lib/business-quarter-forecast.ts's convention.
//
// Scope: covers exactly the personal Form 1040 (MFJ, Eric + Eva), EK
// Consulting LLC's Schedule C, and CT-1040 for TY2025 — see
// .claude/pipeline/tax-compute-engine/01-plan.md. No PDF generation, no UI,
// no Sudden Valley/Mezzo logic, no e-filing, and — critically — NO credits:
// every "total tax" figure this module produces is *before credits*
// (`totalTaxBeforeCredits`, `balanceDueOrRefundBeforeCredits`), never a final
// filed number. Every hardcoded constant below cites its exact
// specs/09-tax-year-2025-constants.md table/bullet; nothing here is
// re-derived, approximated, or guessed from a secondary source.
//
// Known, deliberate stubs/simplifications (see the plan's Risks section for
// full detail — restated briefly here so a reader doesn't have to go hunting):
//   - computeItemizedDeduction requires `saltCapCents` as a caller-supplied
//     parameter (no default) — it's now backed by spec 09's SALT_CAP_MFJ_2025
//     constant, but the function still refuses to silently assume any figure.
//   - CT Table D (recapture) and Table E (personal credit decimal) are now
//     FULLY transcribed as literal lookup tables (CT_TABLE_D_MFJ_2025,
//     CT_TABLE_E_MFJ_2025) per spec 09's complete interior data — the
//     `requiresManualLookup: true` / `null`-amount stub path is kept only as
//     a defensive fallback and should not be reachable for any real CT AGI
//     given the tables' current $0–uncapped coverage.
//   - Federal AGI/taxable income here do NOT subtract retirement/HSA/SE-health
//     -insurance above-the-line deductions (no structured dollar data exists
//     for these yet) — every AGI/taxable-income/tax figure is an UPPER BOUND,
//     not a final number. This is unconditionally true today, so it's also
//     surfaced as a standing entry in computePersonalTaxReturn's `gaps` array,
//     not just this comment.
//   - QBI's phase-in band (394,600–494,600 MFJ) uses a documented LINEAR
//     INTERPOLATION simplification, not the true §199A W-2 wage/UBIA formula
//     (no wages-paid/qualified-property data exists for EK Consulting).
//   - computeFederalTax also always wires QBI's `qualifiedBusinessIncome` off
//     the RAW Schedule C net profit, not net of the deductible half of SE tax
//     (or SE health insurance, not modeled) — unconditionally true today, so
//     it's a standing entry in computePersonalTaxReturn's `gaps` array too.
//
// Ground rule 8 (CLAUDE.md): this engine's output is a draft estimate for CPA
// review, never a filed number nor financial/tax advice.

// ── Federal constants (specs/09-tax-year-2025-constants.md, "Federal" §) ────

/** Federal § bullet 1: "Standard deduction, MFJ: $31,500." (OBBBA-raised MFJ
 *  standard deduction; Rev. Proc. 2024-40 originally set $30,000.) */
export const STANDARD_DEDUCTION_MFJ_2025 = 31500;

interface FederalBracket {
  rate: number;
  min: number; // cumulative lower threshold; half-open [min, nextMin) — a
  // dollar AT a bracket's own `min` still belongs to the PRIOR (lower) band;
  // the next dollar above it starts this band. See computeFederalBracketTax.
  max: number | null;
}

/** Federal § "Tax brackets, MFJ" table (rates/thresholds confirmed unchanged
 *  by OBBBA; source cited in spec 09 as IRS newsroom IR-2024-273 / Rev. Proc.
 *  2024-40). */
export const FEDERAL_BRACKETS_MFJ_2025: FederalBracket[] = [
  { rate: 0.1, min: 0, max: 23850 },
  { rate: 0.12, min: 23850, max: 96950 },
  { rate: 0.22, min: 96950, max: 206700 },
  { rate: 0.24, min: 206700, max: 394600 },
  { rate: 0.32, min: 394600, max: 501050 },
  { rate: 0.35, min: 501050, max: 751600 },
  { rate: 0.37, min: 751600, max: null },
];

/** Federal § "Self-employment tax (Schedule SE)" bullet: "net SE earnings =
 *  92.35% of Schedule C net profit (IRC §1402, fixed by statute)." */
export const SE_NET_EARNINGS_FACTOR = 0.9235;
/** Same bullet: "12.4% OASDI portion." */
export const SE_OASDI_RATE = 0.124;
/** Same bullet: "2.9% Medicare portion is uncapped." */
export const SE_MEDICARE_RATE = 0.029;
/** Same bullet: "up to the $176,100 wage base for 2025." */
export const SE_WAGE_BASE_2025 = 176100;

/** Federal § "Additional Medicare Tax" bullet: "0.9% on combined wages + SE
 *  income above $250,000 for MFJ." */
export const ADDITIONAL_MEDICARE_TAX_RATE = 0.009;
/** Same bullet. */
export const ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ = 250000;

/** Federal § "QBI deduction (§199A)" bullet: "20% of qualified business
 *  income." */
export const QBI_RATE = 0.2;
/** Same bullet: "2025 MFJ phase-in range ... $394,600–$494,600" — start. */
export const QBI_PHASE_IN_START_MFJ = 394600;
/** Same bullet — end. */
export const QBI_PHASE_IN_END_MFJ = 494600;

/** Federal § "Standard mileage rate, 2025: 70¢/business mile" (IRS Notice
 *  2025-5, up from 67¢ in 2024). */
export const STANDARD_MILEAGE_RATE_2025 = 0.7;

/** Federal § "Home office simplified method: $5/sq ft, capped at 300 sq ft." */
export const HOME_OFFICE_SIMPLIFIED_RATE_PER_SQFT = 5;
/** Same bullet. */
export const HOME_OFFICE_SIMPLIFIED_MAX_SQFT = 300;

/** Federal § "SALT (state and local tax) deduction cap, 2025: $40,000 (MFJ;
 *  $20,000 MFS)... " bullet (added to spec 09 after this engine's plan was
 *  written, resolving the plan's Risks item 1 missing-constant gap). Spec 09
 *  also states this cap "[p]hases down by 30% of the amount MAGI exceeds
 *  $500,000 (MFJ), with a floor of $10,000" — that phase-down is NOT modeled
 *  below (no bracket/percentage math is applied automatically); spec 09's own
 *  caveat is that this isn't expected to bind at this household's income
 *  level, but callers should still treat any SALT-cap output as unverified
 *  once MAGI is anywhere near $500,000. computeItemizedDeduction surfaces a
 *  `notes` entry when a caller-supplied MAGI figure exceeds that threshold,
 *  as a nice-to-have flag rather than computing the phase-down itself. */
export const SALT_CAP_MFJ_2025 = 40000;
/** Same bullet: the phase-down never drops the cap below the pre-OBBBA
 *  $10,000 figure — referenced only by the `notes` flag above, never
 *  auto-applied. */
export const SALT_CAP_PHASE_DOWN_FLOOR = 10000;
/** Same bullet: MAGI threshold above which the 30%-of-excess phase-down
 *  begins (MFJ). */
export const SALT_CAP_PHASE_DOWN_MAGI_THRESHOLD_MFJ = 500000;

/**
 * Sums marginal federal tax across FEDERAL_BRACKETS_MFJ_2025. Standard
 * marginal-bracket implementation: a dollar at exactly a bracket's own `min`
 * (e.g. $23,850) is still taxed in the PRIOR (lower) band; the next dollar
 * starts the higher band. Returns Decimal(0) for taxableIncome <= 0.
 */
export function computeFederalBracketTax(taxableIncome: Decimal): Decimal {
  if (taxableIncome.lessThanOrEqualTo(0)) return new Decimal(0);
  let tax = new Decimal(0);
  for (const bracket of FEDERAL_BRACKETS_MFJ_2025) {
    if (taxableIncome.lessThanOrEqualTo(bracket.min)) break;
    const upper = bracket.max === null ? taxableIncome : Decimal.min(taxableIncome, bracket.max);
    const portion = upper.minus(bracket.min);
    if (portion.lessThanOrEqualTo(0)) continue;
    tax = tax.plus(portion.times(bracket.rate));
  }
  return tax;
}

// ── Mileage / home office ────────────────────────────────────────────────────

/** Shape matches MileageEntry's real columns (see prisma/schema.prisma). */
export interface MileageEntryInput {
  miles: number;
  ratePerMile: Decimal; // IRS rate captured AT ENTRY TIME (schema comment) —
  // correct even for mixed-tax-year logs; never re-derive from
  // STANDARD_MILEAGE_RATE_2025.
  date: Date;
}

export interface MileageDeductionResult {
  deduction: Decimal; // sum of miles * that entry's own stored rate, across
  // every entry passed in (the caller decides which entries are in scope —
  // this function does not filter by taxYear for the deduction total itself)
  mismatchedRateEntries: MileageEntryInput[]; // entries dated WITHIN taxYear
  // whose ratePerMile !== STANDARD_MILEAGE_RATE_2025 — a data-quality flag,
  // never silently corrected.
}

export function computeMileageDeduction(input: {
  entries: MileageEntryInput[];
  taxYear: number;
}): MileageDeductionResult {
  const deduction = input.entries.reduce(
    (acc, e) => acc.plus(new Decimal(e.miles).times(e.ratePerMile)),
    new Decimal(0)
  );
  const mismatchedRateEntries = input.entries.filter(
    (e) =>
      e.date.getUTCFullYear() === input.taxYear &&
      !e.ratePerMile.equals(STANDARD_MILEAGE_RATE_2025)
  );
  return { deduction, mismatchedRateEntries };
}

/**
 * `min(sqft ?? 0, 300) * 5`. Returns Decimal(0) when sqft is null — today,
 * always (home office square footage isn't stored anywhere in the schema,
 * see plan Risks item 8). This function cannot distinguish "no home office"
 * from "sqft not yet captured" — that distinction belongs in the top-level
 * `gaps` array (computePersonalTaxReturn), not here.
 */
export function computeHomeOfficeSimplifiedDeduction(sqft: number | null): Decimal {
  const cappedSqft = Math.min(sqft ?? 0, HOME_OFFICE_SIMPLIFIED_MAX_SQFT);
  return new Decimal(cappedSqft).times(HOME_OFFICE_SIMPLIFIED_RATE_PER_SQFT);
}

/**
 * `glIncomeTotal - glExpenseTotal - mileageDeduction -
 * homeOfficeSimplifiedDeduction`, where glIncomeTotal/glExpenseTotal are the
 * caller-supplied UNSIGNED totals from computePL(ekConsultingEntityId, ...)
 * (lib/reports.ts).
 *
 * DOUBLE-COUNTING RISK: if the household also books home-office costs as
 * GL-coded expenses (EK Consulting's GL code "5030" = "Home Office," per
 * confirmed repo convention — see lib/tax-form-plan.ts's comment on the same
 * code meaning something different for Sudden Valley) AND the simplified
 * $5/sqft method is applied here, the deduction is counted twice. This pure
 * function has no way to detect that; the future DB-wiring layer must pick
 * one method and pass `homeOfficeSimplifiedDeduction: Decimal(0)` if
 * GL-coded actual-method costs are already present in glExpenseTotal.
 */
export function computeScheduleCNetProfit(input: {
  glIncomeTotal: Decimal;
  glExpenseTotal: Decimal;
  mileageDeduction: Decimal;
  homeOfficeSimplifiedDeduction: Decimal;
}): Decimal {
  return input.glIncomeTotal
    .minus(input.glExpenseTotal)
    .minus(input.mileageDeduction)
    .minus(input.homeOfficeSimplifiedDeduction);
}

// ── Self-employment tax / Additional Medicare Tax ────────────────────────────

export interface SelfEmploymentTaxResult {
  netSEEarnings: Decimal; // max(0, scheduleCNetProfit) * SE_NET_EARNINGS_FACTOR
  oasdiTax: Decimal;
  medicareTax: Decimal;
  totalSETax: Decimal;
  deductibleHalf: Decimal; // above-the-line SE tax deduction (totalSETax / 2)
}

/**
 * `priorSocialSecurityWages` defaults to 0 — Eric has no separate W-2 job
 * reducing his SE wage base per source data, but the parameter exists for
 * correctness/future-proofing (this is an assumption baked into every call
 * site that omits it, not a fact this function can verify).
 * SE tax is $0 on a Schedule C loss — never negative.
 */
export function computeSelfEmploymentTax(input: {
  scheduleCNetProfit: Decimal;
  priorSocialSecurityWages?: Decimal;
}): SelfEmploymentTaxResult {
  const priorWages = input.priorSocialSecurityWages ?? new Decimal(0);
  const netSEEarnings = Decimal.max(0, input.scheduleCNetProfit).times(SE_NET_EARNINGS_FACTOR);
  const oasdiTaxableBase = Decimal.min(netSEEarnings, Decimal.max(0, new Decimal(SE_WAGE_BASE_2025).minus(priorWages)));
  const oasdiTax = oasdiTaxableBase.times(SE_OASDI_RATE);
  const medicareTax = netSEEarnings.times(SE_MEDICARE_RATE);
  const totalSETax = oasdiTax.plus(medicareTax);
  return {
    netSEEarnings,
    oasdiTax,
    medicareTax,
    totalSETax,
    deductibleHalf: totalSETax.div(2),
  };
}

/**
 * Computes the correct TOTAL Additional Medicare Tax liability. Does NOT
 * model Form 8959's wages-first-then-SE-income ordering (irrelevant to the
 * total, only to which line the amount lands on — out of scope without PDF
 * generation). Threshold is EXCLUSIVE per spec 09's "above $250,000."
 */
export function computeAdditionalMedicareTax(input: {
  medicareWages: Decimal;
  netSEEarnings: Decimal;
}): Decimal {
  const excess = input.medicareWages
    .plus(input.netSEEarnings)
    .minus(ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ);
  return Decimal.max(0, excess).times(ADDITIONAL_MEDICARE_TAX_RATE);
}

// ── QBI deduction (§199A) ─────────────────────────────────────────────────────

export interface QBIDeductionResult {
  deduction: Decimal;
  phaseInFraction: Decimal | null; // set only when the linear-interpolation
  // simplification was used (inside the phase-in band)
  notes: string[];
}

/**
 * Below QBI_PHASE_IN_START_MFJ (inclusive): full 20%, capped at 20% of
 * taxableIncomeBeforeQBI. The net-capital-gain reduction of that second cap
 * is NOT modeled — no investment-income input exists anywhere in this app;
 * this is an assumption of $0 net capital gain.
 *
 * At/above QBI_PHASE_IN_END_MFJ (inclusive): stubbed at $0 — per the
 * request's own instruction to stub rather than guess, since no wages-paid or
 * qualified-property data exists for EK Consulting to run the true §199A
 * W-2 wage/UBIA limitation.
 *
 * Strictly inside the band: a documented LINEAR INTERPOLATION between the
 * full-deduction value (computed at the caller's actual figures, not at the
 * threshold) and $0 — a simplification, since the true §199A wage/UBIA
 * phase-in formula isn't computable without data this app doesn't capture.
 */
export function computeQBIDeduction(input: {
  qualifiedBusinessIncome: Decimal;
  taxableIncomeBeforeQBI: Decimal;
}): QBIDeductionResult {
  const { qualifiedBusinessIncome, taxableIncomeBeforeQBI } = input;

  if (taxableIncomeBeforeQBI.lessThanOrEqualTo(QBI_PHASE_IN_START_MFJ)) {
    const deduction = Decimal.min(
      qualifiedBusinessIncome.times(QBI_RATE),
      taxableIncomeBeforeQBI.times(QBI_RATE)
    );
    return { deduction, phaseInFraction: null, notes: [] };
  }

  if (taxableIncomeBeforeQBI.greaterThanOrEqualTo(QBI_PHASE_IN_END_MFJ)) {
    return {
      deduction: new Decimal(0),
      phaseInFraction: null,
      notes: [
        "above $494,600 MFJ taxable income: W-2 wage/UBIA limitation not modeled — no wages-paid or qualified-property data exists for EK Consulting; deduction stubbed at $0, needs CPA review before relying on it",
      ],
    };
  }

  const fullDeduction = Decimal.min(
    qualifiedBusinessIncome.times(QBI_RATE),
    taxableIncomeBeforeQBI.times(QBI_RATE)
  );
  const phaseInFraction = new Decimal(QBI_PHASE_IN_END_MFJ)
    .minus(taxableIncomeBeforeQBI)
    .div(QBI_PHASE_IN_END_MFJ - QBI_PHASE_IN_START_MFJ);
  const deduction = fullDeduction.times(phaseInFraction);
  return {
    deduction,
    phaseInFraction,
    notes: [
      `taxable income is inside the $394,600–$494,600 MFJ QBI phase-in band — deduction uses a documented LINEAR INTERPOLATION simplification (fraction ${phaseInFraction.toString()}), not the true §199A W-2 wage/UBIA formula (no wages-paid/qualified-property data exists for EK Consulting); needs CPA review before relying on it`,
    ],
  };
}

// ── Itemized deduction / standard-vs-itemized ────────────────────────────────

export interface ItemizedDeductionInput {
  mortgageInterestCents: number;
  propertyTaxCents: number; // PRIMARY RESIDENCE ONLY — Sudden Valley's Arbor
  // Rd property tax is a Schedule E rental expense already inside
  // suddenValleyPL's GL totals and must NEVER be passed here (this pure
  // function cannot enforce that; it's a future wiring-layer responsibility).
  ctIncomeTaxWithheldCents: number;
  charitableCents: number | null; // null/0 in practice today — no
  // donation-log data source (matches lib/tax-form-plan.ts's own "Gifts to
  // charity (line 11)": false comment).
  saltCapCents: number; // REQUIRED, no default — see SALT_CAP_MFJ_2025 above.
  // Not hardcoded here so nothing silently assumes a possibly-wrong figure;
  // callers should pass SALT_CAP_MFJ_2025 * 100 in the common case.
  magiForSaltPhaseDown?: Decimal; // dollars; optional. When supplied and above
  // SALT_CAP_PHASE_DOWN_MAGI_THRESHOLD_MFJ, only flags a `notes` entry — the
  // 30%-of-excess phase-down itself is NOT computed (nice-to-have flag, not a
  // requirement; see SALT_CAP_MFJ_2025's doc comment above).
}

export interface ItemizedDeductionResult {
  mortgageInterest: Decimal;
  saltBeforeCap: Decimal; // propertyTax + ctIncomeTaxWithheld, before saltCapCents
  saltAfterCap: Decimal; // min(saltBeforeCap, saltCapCents)
  charitable: Decimal;
  itemizedTotal: Decimal;
  notes: string[];
}

export function computeItemizedDeduction(input: ItemizedDeductionInput): ItemizedDeductionResult {
  const centsToDollars = (cents: number) => new Decimal(cents).div(100);

  const mortgageInterest = centsToDollars(input.mortgageInterestCents);
  const propertyTax = centsToDollars(input.propertyTaxCents);
  const ctIncomeTaxWithheld = centsToDollars(input.ctIncomeTaxWithheldCents);
  const charitable = centsToDollars(input.charitableCents ?? 0);
  const saltCap = centsToDollars(input.saltCapCents);

  const saltBeforeCap = propertyTax.plus(ctIncomeTaxWithheld);
  const saltAfterCap = Decimal.min(saltBeforeCap, saltCap);
  const itemizedTotal = mortgageInterest.plus(saltAfterCap).plus(charitable);

  const notes: string[] = [];
  if (input.magiForSaltPhaseDown && input.magiForSaltPhaseDown.greaterThan(SALT_CAP_PHASE_DOWN_MAGI_THRESHOLD_MFJ)) {
    notes.push(
      `MAGI ($${input.magiForSaltPhaseDown.toString()}) exceeds the $500,000 SALT-cap phase-down threshold — the 30%-of-excess phase-down (floor $10,000) is NOT modeled here; saltAfterCap may be overstated and needs manual review before relying on this figure`
    );
  }

  return { mortgageInterest, saltBeforeCap, saltAfterCap, charitable, itemizedTotal, notes };
}

/** Itemized wins only if itemizedTotal > standardDeduction (STRICT) — an
 *  exact tie takes the standard deduction. */
export function selectDeductionMethod(
  itemizedTotal: Decimal,
  standardDeduction: Decimal = new Decimal(STANDARD_DEDUCTION_MFJ_2025)
): "standard" | "itemized" {
  return itemizedTotal.greaterThan(standardDeduction) ? "itemized" : "standard";
}

// ── Federal tax orchestrator ─────────────────────────────────────────────────

export interface ComputeFederalTaxInput {
  wages: Decimal;
  interestIncome: Decimal;
  scheduleCNetProfit: Decimal;
  priorSocialSecurityWages?: Decimal;
  medicareWages: Decimal; // W-2 box 5, for Additional Medicare Tax
  itemizedDeductionInput: ItemizedDeductionInput;
  federalWithholdingCents: number;
  estimatedPaymentsCents: number | null; // null = unknown (see plan Risks
  // item 10) — treated as $0 in the arithmetic below (a documented,
  // explicitly-flagged assumption, never a fabricated positive figure); the
  // top-level `gaps` array (computePersonalTaxReturn) names this whenever it
  // fires so it's never a SILENT $0.
  standardDeduction?: Decimal;
}

export interface FederalTaxResult {
  totalIncome: Decimal;
  // Named agiUpperBound (not `agi`) deliberately — this is NOT final AGI. No
  // retirement/HSA/SE-health-insurance above-the-line deductions are
  // subtracted (plan Risks item 6; dollar amounts for these aren't captured
  // anywhere yet), so this is always >= true AGI. The field name is meant to
  // stop a future UI/PDF consumer from rendering it as "Your AGI" without
  // reading this comment — see review finding 3 (2026-09-17 route-back).
  agiUpperBound: Decimal;
  selfEmploymentTax: SelfEmploymentTaxResult;
  additionalMedicareTax: Decimal;
  itemizedDeduction: ItemizedDeductionResult;
  deductionMethod: "standard" | "itemized";
  deductionUsed: Decimal;
  qbi: QBIDeductionResult;
  taxableIncome: Decimal;
  bracketTax: Decimal;
  totalTaxBeforeCredits: Decimal;
  totalPayments: Decimal;
  balanceDueOrRefundBeforeCredits: Decimal;
}

export function computeFederalTax(input: ComputeFederalTaxInput): FederalTaxResult {
  const standardDeduction = input.standardDeduction ?? new Decimal(STANDARD_DEDUCTION_MFJ_2025);

  const totalIncome = input.wages.plus(input.interestIncome).plus(input.scheduleCNetProfit);

  const selfEmploymentTax = computeSelfEmploymentTax({
    scheduleCNetProfit: input.scheduleCNetProfit,
    priorSocialSecurityWages: input.priorSocialSecurityWages,
  });

  // AGI upper bound — see FederalTaxResult.agiUpperBound doc comment / plan
  // Risks item 6.
  const agiUpperBound = totalIncome.minus(selfEmploymentTax.deductibleHalf);

  const additionalMedicareTax = computeAdditionalMedicareTax({
    medicareWages: input.medicareWages,
    netSEEarnings: selfEmploymentTax.netSEEarnings,
  });

  // MAGI isn't separately modeled anywhere in this app (no foreign-earned
  // -income-exclusion or similar addback data exists) — AGI is used as a
  // reasonable proxy for the SALT-cap phase-down MAGI check, consistent with
  // this file's other documented simplifications.
  const itemizedDeduction = computeItemizedDeduction({
    ...input.itemizedDeductionInput,
    magiForSaltPhaseDown: input.itemizedDeductionInput.magiForSaltPhaseDown ?? agiUpperBound,
  });

  const deductionMethod = selectDeductionMethod(itemizedDeduction.itemizedTotal, standardDeduction);
  const deductionUsed = deductionMethod === "itemized" ? itemizedDeduction.itemizedTotal : standardDeduction;

  const taxableIncomeBeforeQBI = Decimal.max(0, agiUpperBound.minus(deductionUsed));

  const qbi = computeQBIDeduction({
    // Real §199A QBI technically nets out the deductible half of SE tax
    // attributable to the business (and SE health insurance, not modeled) —
    // simplified here to the raw Schedule C net profit, floored at 0; not
    // called out in the plan's own constant/formula list, flagged here as an
    // additional documented simplification rather than silently assumed.
    qualifiedBusinessIncome: Decimal.max(0, input.scheduleCNetProfit),
    taxableIncomeBeforeQBI,
  });

  const taxableIncome = Decimal.max(0, taxableIncomeBeforeQBI.minus(qbi.deduction));
  const bracketTax = computeFederalBracketTax(taxableIncome);
  const totalTaxBeforeCredits = bracketTax.plus(selfEmploymentTax.totalSETax).plus(additionalMedicareTax);

  const federalWithholding = new Decimal(input.federalWithholdingCents).div(100);
  const estimatedPayments =
    input.estimatedPaymentsCents !== null ? new Decimal(input.estimatedPaymentsCents).div(100) : new Decimal(0);
  const totalPayments = federalWithholding.plus(estimatedPayments);
  const balanceDueOrRefundBeforeCredits = totalPayments.minus(totalTaxBeforeCredits);

  return {
    totalIncome,
    agiUpperBound,
    selfEmploymentTax,
    additionalMedicareTax,
    itemizedDeduction,
    deductionMethod,
    deductionUsed,
    qbi,
    taxableIncome,
    bracketTax,
    totalTaxBeforeCredits,
    totalPayments,
    balanceDueOrRefundBeforeCredits,
  };
}

// ── Connecticut constants (specs/09-tax-year-2025-constants.md, "Connecticut" §) ─

/**
 * CT § "Table A — Personal exemption": "$24,000 at CT AGI ≤ $48,000, stepping
 * down $1,000 per $1,000 of CT AGI above that, reaching $0 at CT AGI ≥
 * $71,000." That literal wording is internally imprecise — pure linear
 * subtraction ($1,000 per $1,000 above $48,000) would reach $0 at $72,000,
 * not $71,000 (plan Risks item 4). DOCUMENTED INTERPRETATION chosen here:
 * treat it as a step function using `ceil((ctAGI - 48000) / 1000)` steps of
 * $1,000 each (floored at $0) — this lands the LAST NONZERO step at
 * $70,001–$71,000 (inclusive of $71,000 itself) and $0 from $71,001 on,
 * matching spec 09's literal "$0 at CT AGI ≥ $71,000" ... $71,001 statement
 * without contradicting its "$1,000-per-$1,000" description. Low-materiality
 * (~$1,000 exemption, i.e. ~$45 CT tax at the 4.5% band) — sanity-check
 * against the real Table A PDF before filing.
 */
export function computeCtPersonalExemption(ctAGI: Decimal): Decimal {
  const FULL_EXEMPTION = 24000;
  const FULL_EXEMPTION_CEILING_AGI = 48000;
  const STEP = 1000;
  if (ctAGI.lessThanOrEqualTo(FULL_EXEMPTION_CEILING_AGI)) return new Decimal(FULL_EXEMPTION);
  const excess = ctAGI.minus(FULL_EXEMPTION_CEILING_AGI);
  const steps = excess.div(STEP).ceil();
  return Decimal.max(0, new Decimal(FULL_EXEMPTION).minus(steps.times(STEP)));
}

interface CtInitialTaxBand {
  min: number;
  base: number;
  rate: number;
}

/** CT § "Table B — Initial tax" — 7-row bracket table exactly as printed
 *  (applied to CT taxable income = CT AGI − Table A exemption). Same
 *  half-open-at-`min` convention as FEDERAL_BRACKETS_MFJ_2025: a dollar AT a
 *  band's own `min` is still taxed at the prior band's flat-base rate. */
export const CT_TABLE_B_MFJ_2025: CtInitialTaxBand[] = [
  { min: 0, base: 0, rate: 0.02 },
  { min: 20000, base: 400, rate: 0.045 },
  { min: 100000, base: 4000, rate: 0.055 },
  { min: 200000, base: 9500, rate: 0.06 },
  { min: 400000, base: 21500, rate: 0.065 },
  { min: 500000, base: 28000, rate: 0.069 },
  { min: 1000000, base: 62500, rate: 0.0699 },
];

export function computeCtInitialTax(ctTaxableIncome: Decimal): Decimal {
  if (ctTaxableIncome.lessThanOrEqualTo(0)) return new Decimal(0);
  // CT_TABLE_B_MFJ_2025 is a non-empty compile-time-constant literal, so
  // index 0 always exists — non-null assertion is safe under
  // noUncheckedIndexedAccess.
  let selected: CtInitialTaxBand = CT_TABLE_B_MFJ_2025[0]!;
  for (const band of CT_TABLE_B_MFJ_2025) {
    if (ctTaxableIncome.greaterThan(band.min)) selected = band;
  }
  return new Decimal(selected.base).plus(ctTaxableIncome.minus(selected.min).times(selected.rate));
}

/**
 * CT § "Table C — 2% rate phase-out add-back": "$0 until CT AGI > $100,500,
 * then adds $50 per $5,000 of CT AGI above that, capping at $500 once CT AGI
 * > $145,500." Like Table A, this is internally imprecise: a plain
 * `ceil((ctAGI - 100500) / 5000) * 50` formula only reaches 9 steps ($450) at
 * exactly $145,500, one step short of spec 09's own stated $500 cap anchor —
 * the literal "$50 per $5,000" rate and the literal "$500 at $145,500" cap
 * boundary don't reconcile under pure ceil-division, same class of issue as
 * Table A (plan step 16's own "verify/adjust ceil vs floor" caveat).
 * DOCUMENTED INTERPRETATION chosen here (prioritizing the explicit, directly
 * spec-09-quoted cap boundary over the naive per-step arithmetic, same
 * resolution principle as Table A): a "fence-post" step count —
 * `floor(excess / 5000) + 1` for any ctAGI > $100,500 — which lands the cap
 * EXACTLY at $145,500 (`floor(45000/5000)+1 = 10` steps × $50 = $500). This
 * means even $1 of excess above $100,500 completes a full $50 step (more
 * generous per-dollar than Table A's convention) — a genuine, low-materiality
 * (≤$500) interpretation choice, not a fabricated number; sanity-check
 * against the real Table C PDF before filing.
 */
export function computeCtPhaseOutAddback(ctAGI: Decimal): Decimal {
  const THRESHOLD = 100500;
  const STEP_SIZE = 5000;
  const STEP_AMOUNT = 50;
  const CAP = 500;
  if (ctAGI.lessThanOrEqualTo(THRESHOLD)) return new Decimal(0);
  const excess = ctAGI.minus(THRESHOLD);
  const steps = excess.div(STEP_SIZE).floor().plus(1);
  return Decimal.min(CAP, steps.times(STEP_AMOUNT));
}

export interface CtRecaptureResult {
  amount: Decimal | null;
  requiresManualLookup: boolean;
}

interface CtTableBand {
  upperBound: number | null; // CT AGI <= upperBound -> this band's value.
  // null = no upper bound (the final, uncapped-above band). Bands are ordered
  // ascending by upperBound and read top-down; the first match wins — i.e.
  // "more than the previous band's upperBound, less-than-or-equal-to this
  // one," matching spec 09's own "more-than -> less-than-or-equal-to" framing
  // for both Table D and Table E.
}

interface CtTableDBand extends CtTableBand {
  amount: number;
}

/**
 * CT § "Table D — Tax recapture, MFJ/QSS" — full literal interior table,
 * transcribed directly from specs/09-tax-year-2025-constants.md's Table D
 * section (source: ct-1040-tcs_1225.pdf, pages 4–5). Spec 09 explicitly
 * states this is NOT a clean formula and must not be interpolated — it
 * contains two genuine FLAT bands ($300,000–$400,000 stays at $500;
 * $690,000–$1,000,000 stays at $5,900) where the amount does NOT increase
 * across a $100,000 span, which is why this is a literal array, not a
 * step-size/rate formula like Tables A/C above.
 */
export const CT_TABLE_D_MFJ_2025: CtTableDBand[] = [
  { upperBound: 210000, amount: 0 },
  { upperBound: 220000, amount: 50 },
  { upperBound: 230000, amount: 100 },
  { upperBound: 240000, amount: 150 },
  { upperBound: 250000, amount: 200 },
  { upperBound: 260000, amount: 250 },
  { upperBound: 270000, amount: 300 },
  { upperBound: 280000, amount: 350 },
  { upperBound: 290000, amount: 400 },
  { upperBound: 300000, amount: 450 },
  { upperBound: 400000, amount: 500 }, // FLAT band: $300k–$400k, no step
  { upperBound: 410000, amount: 680 },
  { upperBound: 420000, amount: 860 },
  { upperBound: 430000, amount: 1040 },
  { upperBound: 440000, amount: 1220 },
  { upperBound: 450000, amount: 1400 },
  { upperBound: 460000, amount: 1580 },
  { upperBound: 470000, amount: 1760 },
  { upperBound: 480000, amount: 1940 },
  { upperBound: 490000, amount: 2120 },
  { upperBound: 500000, amount: 2300 },
  { upperBound: 510000, amount: 2480 },
  { upperBound: 520000, amount: 2660 },
  { upperBound: 530000, amount: 2840 },
  { upperBound: 540000, amount: 3020 },
  { upperBound: 550000, amount: 3200 },
  { upperBound: 560000, amount: 3380 },
  { upperBound: 570000, amount: 3560 },
  { upperBound: 580000, amount: 3740 },
  { upperBound: 590000, amount: 3920 },
  { upperBound: 600000, amount: 4100 },
  { upperBound: 610000, amount: 4280 },
  { upperBound: 620000, amount: 4460 },
  { upperBound: 630000, amount: 4640 },
  { upperBound: 640000, amount: 4820 },
  { upperBound: 650000, amount: 5000 },
  { upperBound: 660000, amount: 5180 },
  { upperBound: 670000, amount: 5360 },
  { upperBound: 680000, amount: 5540 },
  { upperBound: 690000, amount: 5720 },
  { upperBound: 1000000, amount: 5900 }, // FLAT band: $690k–$1,000,000, no step
  { upperBound: 1010000, amount: 6000 },
  { upperBound: 1020000, amount: 6100 },
  { upperBound: 1030000, amount: 6200 },
  { upperBound: 1040000, amount: 6300 },
  { upperBound: 1050000, amount: 6400 },
  { upperBound: 1060000, amount: 6500 },
  { upperBound: 1070000, amount: 6600 },
  { upperBound: 1080000, amount: 6700 },
  { upperBound: null, amount: 6800 }, // $1.08M and up — cap
];

/**
 * CT § "Table D — Tax recapture": now a literal lookup against
 * CT_TABLE_D_MFJ_2025 (spec 09's full interior table, no longer a boundary
 * -only stub — plan Risks item 2 is resolved). `CT_TABLE_D_MFJ_2025`'s last
 * band has `upperBound: null`, so it covers every ctAGI up to +Infinity;
 * `requiresManualLookup: true` is kept only as a defensive fallback for the
 * (currently unreachable) case where the table doesn't cover a given input.
 */
export function computeCtRecapture(ctAGI: Decimal): CtRecaptureResult {
  for (const band of CT_TABLE_D_MFJ_2025) {
    if (band.upperBound === null || ctAGI.lessThanOrEqualTo(band.upperBound)) {
      return { amount: new Decimal(band.amount), requiresManualLookup: false };
    }
  }
  // Defensive fallback — unreachable today given CT_TABLE_D_MFJ_2025's final
  // band has upperBound: null (covers everything up to +Infinity). Kept in
  // case the table is ever edited to remove that catch-all row.
  return { amount: null, requiresManualLookup: true };
}

export interface CtPersonalCreditResult {
  decimal: Decimal | null;
  requiresManualLookup: boolean;
}

interface CtTableEBand extends CtTableBand {
  decimal: number;
}

/**
 * CT § "Table E — Personal tax credit decimal, MFJ/QSS" — full literal
 * interior table, transcribed directly from specs/09-tax-year-2025
 * -constants.md's Table E section (same source PDF as Table D). The first row
 * covers CT AGI <= $24,000: per spec 09's own note, the source PDF doesn't
 * state a decimal below $24,000, but this is moot rather than a real gap —
 * Table A's $24,000 exemption already zeroes CT taxable income at that AGI
 * level (see computeCtPersonalExemption), so `initialTax` is $0 and
 * `initialTax.times(decimal)` is $0 regardless of which decimal is used here.
 * 1.00 is used as a documentation-only placeholder for that band (no effect
 * on any real computation).
 */
export const CT_TABLE_E_MFJ_2025: CtTableEBand[] = [
  { upperBound: 24000, decimal: 1.0 }, // moot — see doc comment above
  { upperBound: 30000, decimal: 0.75 },
  { upperBound: 30500, decimal: 0.7 },
  { upperBound: 31000, decimal: 0.65 },
  { upperBound: 31500, decimal: 0.6 },
  { upperBound: 32000, decimal: 0.55 },
  { upperBound: 32500, decimal: 0.5 },
  { upperBound: 33000, decimal: 0.45 },
  { upperBound: 33500, decimal: 0.4 },
  { upperBound: 40000, decimal: 0.35 },
  { upperBound: 40500, decimal: 0.3 },
  { upperBound: 41000, decimal: 0.25 },
  { upperBound: 41500, decimal: 0.2 },
  { upperBound: 50000, decimal: 0.15 },
  { upperBound: 50500, decimal: 0.14 },
  { upperBound: 51000, decimal: 0.13 },
  { upperBound: 51500, decimal: 0.12 },
  { upperBound: 52000, decimal: 0.11 },
  { upperBound: 96000, decimal: 0.1 },
  { upperBound: 96500, decimal: 0.09 },
  { upperBound: 97000, decimal: 0.08 },
  { upperBound: 97500, decimal: 0.07 },
  { upperBound: 98000, decimal: 0.06 },
  { upperBound: 98500, decimal: 0.05 },
  { upperBound: 99000, decimal: 0.04 },
  { upperBound: 99500, decimal: 0.03 },
  { upperBound: 100000, decimal: 0.02 },
  { upperBound: 100500, decimal: 0.01 },
  { upperBound: null, decimal: 0.0 }, // "$100,500 and up: .00"
];

/**
 * CT § "Table E — Personal tax credit decimal": now a literal lookup against
 * CT_TABLE_E_MFJ_2025 (spec 09's full interior table — plan Risks item 3 is
 * resolved). Like Table D, the table's last band has `upperBound: null`, so
 * `requiresManualLookup: true` is a defensive-only fallback, currently
 * unreachable.
 *
 * WHICH CT tax-liability line this decimal multiplies is now resolved by
 * spec 09's "Tax Calculation Schedule mechanic" section (Form CT-1040 TCS,
 * page 1, lines 1-10; primary-sourced): the decimal multiplies Line 7
 * (`initialTax + phaseOutAddback + recapture`), not `initialTax` alone.
 * computeConnecticutTax implements that literal Line 7 - Line 9 formula
 * (plan Risks item 5 resolved).
 */
export function computeCtPersonalCreditDecimal(ctAGI: Decimal): CtPersonalCreditResult {
  for (const band of CT_TABLE_E_MFJ_2025) {
    if (band.upperBound === null || ctAGI.lessThanOrEqualTo(band.upperBound)) {
      return { decimal: new Decimal(band.decimal), requiresManualLookup: false };
    }
  }
  // Defensive fallback — unreachable today, same reasoning as
  // computeCtRecapture's fallback above.
  return { decimal: null, requiresManualLookup: true };
}

export interface ConnecticutTaxResult {
  ctAGI: Decimal;
  personalExemption: Decimal;
  ctTaxableIncome: Decimal;
  initialTax: Decimal;
  phaseOutAddback: Decimal;
  recapture: CtRecaptureResult;
  personalCredit: CtPersonalCreditResult;
  netTaxBeforeCreditsUnknown: boolean;
  ctTaxComputed: Decimal | null;
  ctWithholding: Decimal;
  balanceDueOrRefund: Decimal | null;
}

/**
 * Assumes ctAGI === federal AGI, because CT-specific AGI modifications aren't
 * modeled anywhere in this app (matches lib/tax-form-plan.ts's own "CT
 * adjusted gross income: From federal AGI plus CT modifications" field
 * description — today this app only tracks WHETHER that's answered, never
 * the modification amount).
 *
 * If either Table D or Table E lands outside its confirmed boundary,
 * `netTaxBeforeCreditsUnknown` is true and both `ctTaxComputed` and
 * `balanceDueOrRefund` are null — NEVER a silently-substituted $0 for an
 * unknown table lookup.
 */
export function computeConnecticutTax(input: { ctAGI: Decimal; ctWithholdingCents: number }): ConnecticutTaxResult {
  const { ctAGI } = input;
  const personalExemption = computeCtPersonalExemption(ctAGI);
  const ctTaxableIncome = Decimal.max(0, ctAGI.minus(personalExemption));
  const initialTax = computeCtInitialTax(ctTaxableIncome);
  const phaseOutAddback = computeCtPhaseOutAddback(ctAGI);
  const recapture = computeCtRecapture(ctAGI);
  const personalCredit = computeCtPersonalCreditDecimal(ctAGI);
  const ctWithholding = new Decimal(input.ctWithholdingCents).div(100);

  const netTaxBeforeCreditsUnknown = recapture.requiresManualLookup || personalCredit.requiresManualLookup;

  let ctTaxComputed: Decimal | null = null;
  let balanceDueOrRefund: Decimal | null = null;
  if (!netTaxBeforeCreditsUnknown) {
    // Both are non-null here since neither branch requires manual lookup.
    // Form CT-1040 TCS: Line 7 = initialTax + phaseOutAddback + recapture;
    // Line 9 = Line 7 x Table E decimal; final tax = Line 7 - Line 9. The
    // decimal multiplies the full Line 7 sum, not `initialTax` alone (spec
    // 09's "Tax Calculation Schedule mechanic" section). Note: this specific
    // formula choice is currently unexercisable via the public API — Table
    // C/D/E's real thresholds mean phaseOutAddback/recapture are always $0
    // whenever the decimal is nonzero, so this line and the old
    // `initialTax.times(decimal)` version produce identical output for every
    // reachable test input. Only a direct/internal test of this arithmetic,
    // decoupled from the real tables, could distinguish them.
    const line7 = initialTax.plus(phaseOutAddback).plus(recapture.amount!);
    ctTaxComputed = line7.minus(line7.times(personalCredit.decimal!));
    balanceDueOrRefund = ctWithholding.minus(ctTaxComputed);
  }

  return {
    ctAGI,
    personalExemption,
    ctTaxableIncome,
    initialTax,
    phaseOutAddback,
    recapture,
    personalCredit,
    netTaxBeforeCreditsUnknown,
    ctTaxComputed,
    ctWithholding,
    balanceDueOrRefund,
  };
}

// ── Top-level orchestrator ────────────────────────────────────────────────────

export interface ComputePersonalTaxReturnInput {
  taxYear: number; // MUST be 2025 — every constant above is TY2025-only.
  wages: Decimal;
  medicareWages: Decimal;
  interestIncome: Decimal;
  glIncomeTotal: Decimal; // EK Consulting computePL, unsigned
  glExpenseTotal: Decimal; // EK Consulting computePL, unsigned
  mileageEntries: MileageEntryInput[];
  homeOfficeSqft: number | null;
  priorSocialSecurityWages?: Decimal;
  mortgageInterestCents: number;
  propertyTaxCents: number; // PRIMARY RESIDENCE ONLY — see
  // ItemizedDeductionInput.propertyTaxCents doc comment.
  ctIncomeTaxWithheldCents: number;
  charitableCents: number | null;
  saltCapCents: number; // required — pass SALT_CAP_MFJ_2025 * 100 in the
  // common case (see SALT_CAP_MFJ_2025's doc comment for the un-modeled
  // phase-down caveat).
  federalWithholdingCents: number;
  estimatedPaymentsCents: number | null;
  ctWithholdingCents: number;
  standardDeduction?: Decimal;
}

export interface TaxComputeResult {
  taxYear: number;
  scheduleC: {
    mileage: MileageDeductionResult;
    homeOfficeSimplifiedDeduction: Decimal;
    netProfit: Decimal;
  };
  federal: FederalTaxResult;
  connecticut: ConnecticutTaxResult;
  gaps: string[];
}

/**
 * Top-level orchestrator wiring computeScheduleCNetProfit -> computeFederalTax
 * -> computeConnecticutTax. Throws for any taxYear !== 2025 (these constants
 * are TY2025-only; guards against silent misuse in a future tax year before
 * this file is updated).
 *
 * `gaps` reflects ONLY the known-gap conditions actually triggered by this
 * specific input — never a static list.
 */
export function computePersonalTaxReturn(input: ComputePersonalTaxReturnInput): TaxComputeResult {
  if (input.taxYear !== 2025) {
    throw new Error(`computePersonalTaxReturn: taxYear must be 2025 (got ${input.taxYear}) — TY2025-only constants`);
  }

  const mileage = computeMileageDeduction({ entries: input.mileageEntries, taxYear: input.taxYear });
  const homeOfficeSimplifiedDeduction = computeHomeOfficeSimplifiedDeduction(input.homeOfficeSqft);
  const netProfit = computeScheduleCNetProfit({
    glIncomeTotal: input.glIncomeTotal,
    glExpenseTotal: input.glExpenseTotal,
    mileageDeduction: mileage.deduction,
    homeOfficeSimplifiedDeduction,
  });

  const federal = computeFederalTax({
    wages: input.wages,
    interestIncome: input.interestIncome,
    scheduleCNetProfit: netProfit,
    priorSocialSecurityWages: input.priorSocialSecurityWages,
    medicareWages: input.medicareWages,
    itemizedDeductionInput: {
      mortgageInterestCents: input.mortgageInterestCents,
      propertyTaxCents: input.propertyTaxCents,
      ctIncomeTaxWithheldCents: input.ctIncomeTaxWithheldCents,
      charitableCents: input.charitableCents,
      saltCapCents: input.saltCapCents,
    },
    federalWithholdingCents: input.federalWithholdingCents,
    estimatedPaymentsCents: input.estimatedPaymentsCents,
    standardDeduction: input.standardDeduction,
  });

  const connecticut = computeConnecticutTax({
    ctAGI: federal.agiUpperBound, // CT AGI === federal AGI assumption — see
    // computeConnecticutTax's doc comment. (Also inherits the "upper bound"
    // caveat — see FederalTaxResult.agiUpperBound.)
    ctWithholdingCents: input.ctWithholdingCents,
  });

  const gaps: string[] = [];

  if (input.homeOfficeSqft === null) {
    gaps.push("home office square footage not captured — $0 deduction assumed");
  }
  if (input.mileageEntries.length === 0) {
    gaps.push(
      "no mileage entries found for this entity — car & truck expense deduction assumed $0, though the tax-readiness checklist claims mileage is compiled"
    );
  }
  if (mileage.mismatchedRateEntries.length > 0) {
    gaps.push(
      `${mileage.mismatchedRateEntries.length} mileage entr${mileage.mismatchedRateEntries.length === 1 ? "y" : "ies"} dated in tax year ${input.taxYear} use a rate other than the ${input.taxYear} standard mileage rate — verify these are intentional before relying on the mileage deduction total`
    );
  }
  if (input.estimatedPaymentsCents === null) {
    gaps.push(
      "estimated tax payments not captured beyond a free-text answer — totalPayments/balance due assumes $0 in estimated payments actually paid"
    );
  }
  if (input.charitableCents === null) {
    gaps.push("no charitable-donation data source exists — itemized deduction excludes Schedule A line 11");
  }
  if (federal.qbi.notes.length > 0) {
    gaps.push(...federal.qbi.notes);
  }
  if (federal.itemizedDeduction.notes.length > 0) {
    gaps.push(...federal.itemizedDeduction.notes);
  }
  if (connecticut.netTaxBeforeCreditsUnknown) {
    // CT_TABLE_D_MFJ_2025 / CT_TABLE_E_MFJ_2025 are now fully transcribed and
    // cover every ctAGI up to +Infinity, so this should not be reachable in
    // practice (see computeCtRecapture/computeCtPersonalCreditDecimal's
    // defensive-fallback comments) — kept as a real gap message rather than
    // silently swallowed in case the table is ever edited to remove its
    // catch-all row, or a future tax year's constants aren't fully populated.
    gaps.push(
      "CT Table D and/or Table E lookup fell outside the transcribed table's covered range at this CT AGI — this should not happen given the current spec 09 tables and likely indicates a data or table-coverage bug, not a normal caveat; CT balance due/refund not computable"
    );
  }

  // Standing gaps: unconditionally true today given current schema/data
  // availability (no input can currently make either condition false) — see
  // this file's header comment for the underlying simplifications. Surfaced
  // here (not just in doc comments) so `gaps.length === 0` reliably means "no
  // known caveats," per review finding 2/3 (2026-09-17 route-back).
  gaps.push(
    "federal AGI is an upper bound — retirement/HSA/self-employed health insurance above-the-line deductions are not subtracted (no structured dollar data exists anywhere in the schema for these yet)"
  );
  gaps.push(
    "QBI deduction is computed off raw Schedule C net profit, not net of the deductible half of self-employment tax (and not net of SE health insurance, which isn't modeled) — a simplification of the true §199A qualified business income base"
  );

  return {
    taxYear: input.taxYear,
    scheduleC: { mileage, homeOfficeSimplifiedDeduction, netProfit },
    federal,
    connecticut,
    gaps,
  };
}
