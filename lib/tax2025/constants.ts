// TY2025 constants registry for the answers-driven return engine (lib/tax2025/).
//
// Every entry is { id, value, url, verifiedOn, note }. The values come ONLY from
// the verified-sources table in specs/09-tax-year-2025-constants.md
// ("Additional TY2025 constants (verified 2026-10-03)", which is section 5.1 of
// .claude/pipeline/filing-packet-compute-roadmap/01-plan.md) or from the
// 2026-09-17 sections of that same spec (federal brackets, CT tables) that the
// existing lib/tax-compute.ts already carries; those few are IMPORTED from
// lib/tax-compute.ts so there is exactly one copy of each number.
//
// Anything in the spec's "Not verified" list is deliberately ABSENT from this
// registry: a rule that would need it returns `needs_cpa_rule_unverified`
// instead. Rule files must reference these entries (`K.X.value`) rather than
// repeating a number; lib/__tests__/tax2025-constants.test.ts fails if an entry
// lacks a url / verifiedOn, and also fails if a rule file contains a literal
// equal to one of these values.
//
// Money values are plain dollars (numbers); rules wrap them in Decimal.

import {
  ADDITIONAL_MEDICARE_TAX_RATE,
  ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ,
  FEDERAL_BRACKETS_MFJ_2025,
  HOME_OFFICE_SIMPLIFIED_MAX_SQFT,
  HOME_OFFICE_SIMPLIFIED_RATE_PER_SQFT,
  QBI_PHASE_IN_END_MFJ,
  QBI_PHASE_IN_START_MFJ,
  QBI_RATE,
  SALT_CAP_MFJ_2025,
  SALT_CAP_PHASE_DOWN_FLOOR,
  SALT_CAP_PHASE_DOWN_MAGI_THRESHOLD_MFJ,
  SE_MEDICARE_RATE,
  SE_NET_EARNINGS_FACTOR,
  SE_OASDI_RATE,
  SE_WAGE_BASE_2025,
  STANDARD_DEDUCTION_MFJ_2025,
  STANDARD_MILEAGE_RATE_2025,
} from "@/lib/tax-compute";

export interface TaxConstant<T> {
  /** Same as the registry key. */
  id: string;
  value: T;
  /** Primary source (irs.gov or portal.ct.gov) the value was read from. */
  url: string;
  /** ISO date the value was read from that source. */
  verifiedOn: string;
  note: string;
}

/** Date the 5.1 table was verified. */
export const VERIFIED_ON = "2026-10-03";
/** Date of the earlier primary-source pass already recorded in specs/09 (brackets, CT tables). */
export const VERIFIED_ON_SPEC09_FIRST_PASS = "2026-09-17";
/** Date of the mortgage-insurance (Pub. 936) and CT-1040 Schedule 1 primary-source pass. */
export const VERIFIED_ON_2026_10_04 = "2026-10-04";

const IRS = "https://www.irs.gov";
const URL_1040_INSTR = `${IRS}/instructions/i1040gi`;
const URL_SCH_A_INSTR = `${IRS}/instructions/i1040sca`;
// Schedule 1-A has no standalone instructions: they are printed inside the 2025 Form 1040 instructions (pp. 101-110);
// the form itself is https://www.irs.gov/pub/irs-pdf/f1040s1a.pdf.
const URL_SCH_1A = `${IRS}/pub/irs-prior/i1040gi--2025.pdf`;
const URL_8960_INSTR_PDF = `${IRS}/pub/irs-pdf/i8960.pdf`;
const URL_SCH_SE_FORM = `${IRS}/pub/irs-pdf/f1040sse.pdf`;
const URL_8959_INSTR = `${IRS}/instructions/i8959`;
const URL_8960_INSTR = `${IRS}/instructions/i8960`;
const URL_SCH_B_INSTR = `${IRS}/instructions/i1040sb`;
const URL_8995_INSTR = `${IRS}/instructions/i8995`;
const URL_SCH_D_INSTR = `${IRS}/instructions/i1040sd`;
const URL_8889_INSTR = `${IRS}/instructions/i8889`;
const URL_PUB_590A = `${IRS}/publications/p590a`;
const URL_8880_FORM = `${IRS}/pub/irs-pdf/f8880.pdf`;
const URL_5695_INSTR = `${IRS}/instructions/i5695`;
const URL_SCH_3_FORM = `${IRS}/pub/irs-pdf/f1040s3.pdf`;
const URL_SCH_C_INSTR = `${IRS}/instructions/i1040sc`;
const URL_4562_INSTR = `${IRS}/instructions/i4562`;
const URL_PUB_946 = `${IRS}/pub/irs-pdf/p946.pdf`;
const URL_6251_INSTR = `${IRS}/instructions/i6251`;
const URL_2210_INSTR = `${IRS}/instructions/i2210`;
const URL_2210_FORM = `${IRS}/pub/irs-pdf/f2210.pdf`;
const URL_INTEREST_RATES = `${IRS}/payments/quarterly-interest-rates`;
const URL_CT_INSTR = "https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf";
const URL_CT_TCS = "https://portal.ct.gov/-/media/drs/forms/2025/income/ct-1040-tcs_1225.pdf";
const URL_CT_2210 = "https://portal.ct.gov/-/media/drs/forms/2025/income/ct-2210_1225.pdf";
const URL_PUB_936 = `${IRS}/publications/p936`;

function def<T>(
  id: string,
  value: T,
  url: string,
  note: string,
  verifiedOn: string = VERIFIED_ON
): TaxConstant<T> {
  return { id, value, url, verifiedOn, note };
}

/** One "this MAGI band -> that rate/decimal" row: applies when the amount is more than the previous row's `upTo` and at most this one's. */
export interface UpToBand {
  /** Inclusive upper bound; null = no upper bound. */
  upTo: number | null;
  value: number;
}

/**
 * The registry. Keys are the ids. Add new entries ONLY from the verified table
 * (specs/09 "Additional TY2025 constants"); never from memory.
 */
export const CONSTANTS = {
  // ── Standard deduction / Tax Table / QDCG ─────────────────────────────────
  STANDARD_DEDUCTION_MFJ: def(
    "STANDARD_DEDUCTION_MFJ",
    STANDARD_DEDUCTION_MFJ_2025,
    URL_1040_INSTR,
    "Standard deduction, married filing jointly, TY2025 (1040 instructions, What's New)."
  ),
  STANDARD_DEDUCTION_ADDITIONAL_MFJ: def(
    "STANDARD_DEDUCTION_ADDITIONAL_MFJ",
    1600,
    URL_1040_INSTR,
    "Additional standard deduction per box checked on Form 1040 line 12d (born before January 2, 1961, or blind; each spouse separately), MFJ. The 2025 Standard Deduction Chart reads 33,100 / 34,700 / 36,300 / 37,900 for 1 / 2 / 3 / 4 boxes, i.e. the base plus this amount per box; the dependents worksheet line 4b also multiplies the box count by 1,600. Separate from the Schedule 1-A senior deduction."
  ),
  TAX_TABLE_MAX_TAXABLE_INCOME: def(
    "TAX_TABLE_MAX_TAXABLE_INCOME",
    100000,
    URL_1040_INSTR,
    "Taxable income under this amount MUST use the Tax Table; at or above it, the Tax Computation Worksheet."
  ),
  TAX_TABLE_ROW_BANDS: def(
    "TAX_TABLE_ROW_BANDS",
    [
      { from: 0, width: 5 },
      { from: 5, width: 10 },
      { from: 25, width: 25 },
      { from: 3000, width: 50 },
    ] as { from: number; width: number }[],
    URL_1040_INSTR,
    "Printed Tax Table row structure (read from the full 2,062-row MFJ table, contiguous 0 to 100,000): rows are 5 wide below 5, 10 wide from 5 to 25, 25 wide from 25 to 3,000, 50 wide from 3,000. A row's tax is the tax at the row midpoint, rounded (every printed MFJ row is checked in tax2025-tax-calc.test.ts)."
  ),
  QDCG_ZERO_RATE_LIMIT_MFJ: def(
    "QDCG_ZERO_RATE_LIMIT_MFJ",
    96700,
    URL_1040_INSTR,
    "Qualified Dividends and Capital Gain Tax Worksheet: top of the 0% capital-gain band, MFJ."
  ),
  QDCG_FIFTEEN_RATE_LIMIT_MFJ: def(
    "QDCG_FIFTEEN_RATE_LIMIT_MFJ",
    600050,
    URL_1040_INSTR,
    "Qualified Dividends and Capital Gain Tax Worksheet: top of the 15% capital-gain band, MFJ."
  ),
  QDCG_FIFTEEN_RATE: def(
    "QDCG_FIFTEEN_RATE",
    0.15,
    URL_1040_INSTR,
    "Qualified Dividends and Capital Gain Tax Worksheet line 18 multiplier (15%)."
  ),
  QDCG_TWENTY_RATE: def(
    "QDCG_TWENTY_RATE",
    0.2,
    URL_1040_INSTR,
    "Qualified Dividends and Capital Gain Tax Worksheet line 21 multiplier (20%)."
  ),
  FEDERAL_BRACKETS_MFJ: def(
    "FEDERAL_BRACKETS_MFJ",
    FEDERAL_BRACKETS_MFJ_2025,
    URL_1040_INSTR,
    "MFJ ordinary-income brackets (Tax Computation Worksheet equivalent). Cited sources: the 2025 Form 1040 instructions (Tax Computation Worksheet, confirmed again against the printed Tax Table) and, in specs/09, IR-2024-273 / Rev. Proc. 2024-40 (unchanged by OBBBA).",
    VERIFIED_ON_SPEC09_FIRST_PASS
  ),

  SCH_B_THRESHOLD: def(
    "SCH_B_THRESHOLD",
    1500,
    URL_1040_INSTR,
    "Schedule B is required if taxable interest or ordinary dividends exceed $1,500 (plan section 4.2, 1040 instructions)."
  ),

  // ── Schedule D (capital gains and losses), read from the 2025 form and its instructions on 2026-10-04 ──
  CAPITAL_LOSS_LIMIT_MFJ: def(
    "CAPITAL_LOSS_LIMIT_MFJ",
    3000,
    URL_SCH_D_INSTR,
    "Schedule D line 21: a net capital loss is deductible up to the smaller of the loss on line 16 or $3,000 (treat both as positive numbers); the excess carries to 2026 (Capital Losses, and the line 21 instructions).",
    "2026-10-04"
  ),
  CAPITAL_LOSS_LIMIT_MFS: def(
    "CAPITAL_LOSS_LIMIT_MFS",
    1500,
    URL_SCH_D_INSTR,
    "Schedule D line 21: $1,500 if married filing separately. Recorded for the citation only; the engine is MFJ-only and never uses it.",
    "2026-10-04"
  ),

  // ── Self-employment tax / Medicare ────────────────────────────────────────
  SE_NET_EARNINGS_FACTOR: def(
    "SE_NET_EARNINGS_FACTOR",
    SE_NET_EARNINGS_FACTOR,
    URL_SCH_SE_FORM,
    "Schedule SE line 4a: 92.35% of net profit."
  ),
  SE_FLOOR: def(
    "SE_FLOOR",
    400,
    URL_SCH_SE_FORM,
    "Schedule SE line 4c: if net earnings are less than $400 there is no SE tax."
  ),
  SE_WAGE_BASE: def(
    "SE_WAGE_BASE",
    SE_WAGE_BASE_2025,
    URL_SCH_SE_FORM,
    "Schedule SE line 7: 2025 Social Security wage base."
  ),
  SE_OASDI_RATE: def(
    "SE_OASDI_RATE",
    SE_OASDI_RATE,
    URL_SCH_SE_FORM,
    "Schedule SE line 10: 12.4% on the smaller of line 6 or line 9."
  ),
  SE_MEDICARE_RATE: def(
    "SE_MEDICARE_RATE",
    SE_MEDICARE_RATE,
    URL_SCH_SE_FORM,
    "Schedule SE line 11: 2.9% on line 6."
  ),
  ADDL_MEDICARE_RATE: def(
    "ADDL_MEDICARE_RATE",
    ADDITIONAL_MEDICARE_TAX_RATE,
    URL_8959_INSTR,
    "Additional Medicare Tax rate (0.9%)."
  ),
  ADDL_MEDICARE_THRESHOLD_MFJ: def(
    "ADDL_MEDICARE_THRESHOLD_MFJ",
    ADDITIONAL_MEDICARE_TAX_THRESHOLD_MFJ,
    URL_8959_INSTR,
    "Not indexed: MFJ $250,000 (MFS $125,000, others $200,000)."
  ),
  ADDL_MEDICARE_W2_TRIGGER: def(
    "ADDL_MEDICARE_W2_TRIGGER",
    200000,
    URL_8959_INSTR,
    "Form 8959 is required if any single W-2 box 5 is over $200,000, or combined wages + SE exceed the filing-status threshold."
  ),
  MEDICARE_EMPLOYEE_RATE: def(
    "MEDICARE_EMPLOYEE_RATE",
    0.0145,
    URL_8959_INSTR,
    "Form 8959 Part V: regular employee Medicare rate (1.45%) subtracted from W-2 box 6 to find Additional Medicare Tax withheld."
  ),
  NIIT_RATE: def("NIIT_RATE", 0.038, URL_8960_INSTR, "Net investment income tax rate (3.8%)."),
  NIIT_THRESHOLD_MFJ: def(
    "NIIT_THRESHOLD_MFJ",
    250000,
    URL_8960_INSTR,
    "NIIT applies to the lesser of net investment income or MAGI over this amount, MFJ."
  ),
  NIIT_ALLOCATION_METHOD: def(
    "NIIT_ALLOCATION_METHOD",
    "line8_over_agi",
    URL_8960_INSTR_PDF,
    "Form 8960 line 9b (Part II, 'Reasonable method allocations'): state and local income tax deducted on Schedule A may be allocated to net investment income by any reasonable method; the instructions' own example method is the ratio of gross investment income (Form 8960 line 8) to AGI. The CPA may use another method.",
    VERIFIED_ON_2026_10_04
  ),
  NIIT_MISC_INVESTMENT_EXPENSES_DEDUCTIBLE: def(
    "NIIT_MISC_INVESTMENT_EXPENSES_DEDUCTIBLE",
    false,
    URL_8960_INSTR_PDF,
    "Form 8960 line 9c: miscellaneous investment expenses are generally no longer deductible (P.L. 119-21 section 70110 makes the disallowance of miscellaneous itemized deductions permanent); the 'Lines 9 and 10' limitation worksheet is 'Not for use in 2025'.",
    VERIFIED_ON_2026_10_04
  ),

  // ── QBI ───────────────────────────────────────────────────────────────────
  QBI_RATE: def("QBI_RATE", QBI_RATE, URL_8995_INSTR, "Section 199A deduction: 20%."),
  QBI_8995_THRESHOLD_MFJ: def(
    "QBI_8995_THRESHOLD_MFJ",
    QBI_PHASE_IN_START_MFJ,
    URL_8995_INSTR,
    "Form 8995 may be used if taxable income before the QBI deduction is at most this amount (MFJ); otherwise Form 8995-A."
  ),
  QBI_PHASE_IN_END_MFJ: def(
    "QBI_PHASE_IN_END_MFJ",
    QBI_PHASE_IN_END_MFJ,
    URL_8995_INSTR,
    "Top of the MFJ phase-in band above the 8995 threshold (8995-A territory; not computed by this engine)."
  ),
  QBI_LOSS_CARRYFORWARD_RULE: def(
    "QBI_LOSS_CARRYFORWARD_RULE",
    "lines 4 and 8 floor at 0; lines 16 and 17 cap at 0 (the carryforward)",
    URL_8995_INSTR,
    "Form 8995 (2025): line 4 \"Combine lines 2 and 3. If zero or less, enter -0-\"; line 8 \"Combine lines 6 and 7. If zero or less, enter -0-\"; line 16 \"Total qualified business (loss) carryforward. Combine lines 2 and 3. If greater than zero, enter -0-\" and line 17 \"Combine lines 6 and 7. If greater than zero, enter -0-\" (both printed inside parentheses). Instructions, line 4: with a qualified business net loss \"you don't qualify for the QBI deduction unless you have qualified REIT dividends or qualified PTP income. The loss will be carried forward to next year\"; line 16 \"is the amount to be carried forward to the next year\"; line 17 \"must be carried forward to next year\"; line 3 takes the prior-year carryforward. Regulation basis: 26 CFR 1.199A-1(c)(2) and (d)(2)(iii)(B) (a negative total QBI is treated as negative QBI from a separate trade or business in the following year).",
    VERIFIED_ON_2026_10_04
  ),

  // ── Schedule A ────────────────────────────────────────────────────────────
  SALT_CAP_MFJ: def(
    "SALT_CAP_MFJ",
    SALT_CAP_MFJ_2025,
    URL_SCH_A_INSTR,
    "SALT deduction cap ($40,000; $20,000 MFS), Schedule A worksheet line 1."
  ),
  SALT_PHASE_DOWN_THRESHOLD_MFJ: def(
    "SALT_PHASE_DOWN_THRESHOLD_MFJ",
    SALT_CAP_PHASE_DOWN_MAGI_THRESHOLD_MFJ,
    URL_SCH_A_INSTR,
    "SALT cap is reduced by 30% of MAGI over this amount (worksheet line 6)."
  ),
  SALT_PHASE_DOWN_RATE: def(
    "SALT_PHASE_DOWN_RATE",
    0.3,
    URL_SCH_A_INSTR,
    "SALT worksheet line 7: 30% of the MAGI excess."
  ),
  SALT_FLOOR: def(
    "SALT_FLOOR",
    SALT_CAP_PHASE_DOWN_FLOOR,
    URL_SCH_A_INSTR,
    "SALT worksheet line 9: the cap is the larger of the reduced cap or $10,000."
  ),
  MORTGAGE_DEBT_LIMIT: def(
    "MORTGAGE_DEBT_LIMIT",
    750000,
    URL_SCH_A_INSTR,
    "Home acquisition debt limit for loans after Dec 15, 2017."
  ),
  MORTGAGE_INSURANCE_PREMIUM_DEDUCTION_TY2025: def(
    "MORTGAGE_INSURANCE_PREMIUM_DEDUCTION_TY2025",
    "not deductible",
    URL_PUB_936,
    "Pub. 936 (2025), Reminders: \"The itemized deduction for mortgage insurance premiums has expired. You can no longer claim the deduction.\" Also the \"Points\" section: mortgage insurance premiums are not points (\"You can't deduct these amounts as points either in the year paid or over the life of the mortgage\").",
    VERIFIED_ON_2026_10_04
  ),
  SCHEDULE_A_LINE_8D: def(
    "SCHEDULE_A_LINE_8D",
    "reserved for future use",
    URL_SCH_A_INSTR,
    "2025 Schedule A instructions, Line 8d: \"Reserved for future use\" (the 2025 Schedule A has no line for Form 1098 box 5 mortgage insurance premiums).",
    VERIFIED_ON_2026_10_04
  ),
  FORM_8283_NONCASH_THRESHOLD: def(
    "FORM_8283_NONCASH_THRESHOLD",
    500,
    URL_SCH_A_INSTR,
    "Form 8283 is required if the noncash deduction is over $500."
  ),
  CHARITY_LOWEST_AGI_LIMIT: def(
    "CHARITY_LOWEST_AGI_LIMIT",
    0.2,
    URL_SCH_A_INSTR,
    "The Schedule A instructions mention 30% and 20% AGI limits; 20% is the lowest limit that can apply, so gifts up to 20% of AGI need no limit analysis. The 60% cash limit is NOT verified and is not used."
  ),

  // ── Schedule 1-A (new for 2025; rules arrive in Phase 1b) ─────────────────
  SCH1A_TIPS_MAX: def("SCH1A_TIPS_MAX", 25000, URL_SCH_1A, "Qualified tips deduction maximum (total, not per spouse)."),
  SCH1A_TIPS_MAGI_START_MFJ: def("SCH1A_TIPS_MAGI_START_MFJ", 300000, URL_SCH_1A, "Tips/overtime MAGI reduction starts (MFJ)."),
  SCH1A_TIPS_REDUCTION_PER_1000: def("SCH1A_TIPS_REDUCTION_PER_1000", 100, URL_SCH_1A, "Tips/overtime: reduce by $100 per $1,000 over (rounded down)."),
  SCH1A_OVERTIME_MAX_MFJ: def("SCH1A_OVERTIME_MAX_MFJ", 25000, URL_SCH_1A, "Qualified overtime deduction maximum, MFJ."),
  SCH1A_OVERTIME_MAGI_START_MFJ: def(
    "SCH1A_OVERTIME_MAGI_START_MFJ",
    300000,
    URL_SCH_1A,
    "Schedule 1-A line 17 (overtime): enter $300,000 if married filing jointly; the reduction starts above it (same value as the tips line 9).",
    VERIFIED_ON_2026_10_04
  ),
  SCH1A_OVERTIME_REDUCTION_PER_1000: def(
    "SCH1A_OVERTIME_REDUCTION_PER_1000",
    100,
    URL_SCH_1A,
    "Schedule 1-A line 20 (overtime): multiply line 19 by $100 (line 19 is the MAGI excess over $1,000 steps, rounded DOWN).",
    VERIFIED_ON_2026_10_04
  ),
  SCH1A_CAR_LOAN_MAX: def("SCH1A_CAR_LOAN_MAX", 10000, URL_SCH_1A, "Car-loan interest deduction maximum."),
  SCH1A_CAR_LOAN_MAGI_START_MFJ: def("SCH1A_CAR_LOAN_MAGI_START_MFJ", 200000, URL_SCH_1A, "Car-loan interest MAGI reduction starts (MFJ)."),
  SCH1A_CAR_LOAN_REDUCTION_PER_1000: def("SCH1A_CAR_LOAN_REDUCTION_PER_1000", 200, URL_SCH_1A, "Car-loan interest: reduce by $200 per $1,000 over (rounded UP)."),
  SCH1A_SENIOR_AMOUNT: def("SCH1A_SENIOR_AMOUNT", 6000, URL_SCH_1A, "Senior deduction per person born before Jan 2, 1961."),
  SCH1A_SENIOR_MAGI_START_MFJ: def("SCH1A_SENIOR_MAGI_START_MFJ", 150000, URL_SCH_1A, "Senior deduction MAGI reduction starts (MFJ)."),
  SCH1A_SENIOR_REDUCTION_RATE: def("SCH1A_SENIOR_REDUCTION_RATE", 0.06, URL_SCH_1A, "Senior deduction reduced by 6% of the MAGI excess."),
  SCH1A_REDUCTION_STEP: def(
    "SCH1A_REDUCTION_STEP",
    1000,
    URL_SCH_1A,
    "Schedule 1-A lines 11, 19 and 28: the MAGI excess is divided by $1,000 (rounded DOWN for tips and overtime, rounded UP for car-loan interest)."
  ),
  SCH1A_SENIOR_BORN_BEFORE: def(
    "SCH1A_SENIOR_BORN_BEFORE",
    "1961-01-02",
    URL_SCH_1A,
    "Enhanced deduction for seniors: the person was born before January 2, 1961 (Schedule 1-A lines 36a / 36b)."
  ),

  // ── HSA / IRA / saver's credit (Phase 1b rules) ───────────────────────────
  HSA_LIMIT_SELF_ONLY: def("HSA_LIMIT_SELF_ONLY", 4300, URL_8889_INSTR, "HSA contribution limit, self-only coverage."),
  HSA_LIMIT_FAMILY: def("HSA_LIMIT_FAMILY", 8550, URL_8889_INSTR, "HSA contribution limit, family coverage."),
  HSA_CATCH_UP_55: def("HSA_CATCH_UP_55", 1000, URL_8889_INSTR, "HSA catch-up contribution, age 55 or older."),
  IRA_LIMIT: def("IRA_LIMIT", 7000, URL_PUB_590A, "IRA contribution limit."),
  IRA_LIMIT_AGE_50: def("IRA_LIMIT_AGE_50", 8000, URL_PUB_590A, "IRA contribution limit, age 50 or older."),
  IRA_PHASEOUT_COVERED_MFJ: def(
    "IRA_PHASEOUT_COVERED_MFJ",
    { start: 126000, end: 146000 },
    URL_PUB_590A,
    "Deduction phase-out when covered by a workplace plan, MFJ MAGI."
  ),
  IRA_PHASEOUT_SPOUSE_COVERED_MFJ: def(
    "IRA_PHASEOUT_SPOUSE_COVERED_MFJ",
    { start: 236000, end: 246000 },
    URL_PUB_590A,
    "Deduction phase-out when not covered but the spouse is, MFJ MAGI."
  ),
  IRA_WORKSHEET_REDUCTION_COVERED_MFJ: def(
    "IRA_WORKSHEET_REDUCTION_COVERED_MFJ",
    { under50: 0.35, age50: 0.4 },
    URL_PUB_590A,
    "Pub 590-A Worksheet 1-2 line 4 (also the 1040 instructions IRA Deduction Worksheet line 7): MFJ and the person is covered by a workplace plan: line 3 x 35% (40% if age 50 or older at the end of 2025)."
  ),
  IRA_WORKSHEET_REDUCTION_OTHER: def(
    "IRA_WORKSHEET_REDUCTION_OTHER",
    { under50: 0.7, age50: 0.8 },
    URL_PUB_590A,
    "Pub 590-A Worksheet 1-2 line 4: all others, including MFJ when the person is NOT covered but the spouse is: line 3 x 70% (80% if age 50 or older)."
  ),
  IRA_FULL_DEDUCTION_RANGE_COVERED_MFJ: def(
    "IRA_FULL_DEDUCTION_RANGE_COVERED_MFJ",
    20000,
    URL_PUB_590A,
    "Worksheet 1-2 line 3: when line 1 minus MAGI is $20,000 or more (MFJ and covered), the deduction is not reduced."
  ),
  IRA_FULL_DEDUCTION_RANGE_OTHER: def(
    "IRA_FULL_DEDUCTION_RANGE_OTHER",
    10000,
    URL_PUB_590A,
    "Worksheet 1-2 line 3: when line 1 minus MAGI is $10,000 or more (all others), the deduction is not reduced."
  ),
  IRA_REDUCED_MINIMUM: def("IRA_REDUCED_MINIMUM", 200, URL_PUB_590A, "Worksheet 1-2 line 4: a reduced deduction under $200 is entered as $200."),
  IRA_ROUND_UP_TO: def("IRA_ROUND_UP_TO", 10, URL_PUB_590A, "Worksheet 1-2 line 4: a result that is not a multiple of $10 is rounded up to the next multiple of $10 (the Pub's own Example 1 prints $6,825; the written rule, repeated in the 1040 instructions, is followed)."),
  SAVERS_CONTRIBUTION_CAP: def("SAVERS_CONTRIBUTION_CAP", 2000, URL_8880_FORM, "Saver's credit: contributions counted up to $2,000 per person."),
  SAVERS_RATE_BANDS_MFJ: def(
    "SAVERS_RATE_BANDS_MFJ",
    [
      { upTo: 47500, value: 0.5 },
      { upTo: 51000, value: 0.2 },
      { upTo: 79000, value: 0.1 },
      { upTo: null, value: 0 },
    ] as UpToBand[],
    URL_8880_FORM,
    "Saver's credit MFJ rates by AGI (1040 line 11a): 50% to $47,500, 20% to $51,000, 10% to $79,000, 0% above (no credit if line 11a is more than $79,000)."
  ),

  // ── Form 5695 ─────────────────────────────────────────────────────────────
  SOLAR_CREDIT_RATE: def("SOLAR_CREDIT_RATE", 0.3, URL_5695_INSTR, "Residential clean energy credit: 30% for property placed in service 2022-2025."),
  SOLAR_NONBUSINESS_USE_MIN: def("SOLAR_NONBUSINESS_USE_MIN", 0.8, URL_5695_INSTR, "If less than 80% of use is nonbusiness, only the nonbusiness-allocable cost counts."),
  SOLAR_LAST_CREDIT_YEAR: def("SOLAR_LAST_CREDIT_YEAR", 2025, URL_5695_INSTR, "No residential clean energy credit for expenditures after Dec 31, 2025."),

  // ── Schedule 3 ────────────────────────────────────────────────────────────
  FOREIGN_TAX_DIRECT_LIMIT_MFJ: def(
    "FOREIGN_TAX_DIRECT_LIMIT_MFJ",
    600,
    URL_1040_INSTR,
    "Foreign tax credit without Form 1116: passive 1099 income only and total foreign tax at most $300 ($600 MFJ)."
  ),
  SCH3_LINE_MAP: def(
    "SCH3_LINE_MAP",
    { foreignTax: "1", savers: "4", form5695: "5a", total8: "8", extensionPayment: "10", excessSocialSecurity: "11", total15: "15" },
    URL_SCH_3_FORM,
    "Schedule 3 line map: 8 total to 1040 line 20; 15 total to 1040 line 31."
  ),

  // ── Schedule C / depreciation ─────────────────────────────────────────────
  MILEAGE_RATE: def("MILEAGE_RATE", STANDARD_MILEAGE_RATE_2025, URL_SCH_C_INSTR, "Standard mileage rate, 70 cents per business mile."),
  MEALS_DEDUCTIBLE_FRACTION: def("MEALS_DEDUCTIBLE_FRACTION", 0.5, URL_SCH_C_INSTR, "Business meals are generally 50% deductible."),
  HOME_OFFICE_RATE_PER_SQFT: def("HOME_OFFICE_RATE_PER_SQFT", HOME_OFFICE_SIMPLIFIED_RATE_PER_SQFT, URL_SCH_C_INSTR, "Simplified home-office method: $5 per square foot."),
  HOME_OFFICE_MAX_SQFT: def("HOME_OFFICE_MAX_SQFT", HOME_OFFICE_SIMPLIFIED_MAX_SQFT, URL_SCH_C_INSTR, "Simplified home-office method: at most 300 square feet. The election is irrevocable for the year."),
  HOME_OFFICE_GROSS_INCOME_LIMIT: def(
    "HOME_OFFICE_GROSS_INCOME_LIMIT",
    "Schedule C line 29 (floored at 0)",
    URL_SCH_C_INSTR,
    "Simplified Method Worksheet line 1 (Schedule C instructions; Pub 587 for 2025 returns, https://www.irs.gov/pub/irs-pdf/p587.pdf, worksheet line 5 'smaller of line 1 or line 4, if zero or less enter -0-'): the simplified deduction cannot exceed the gross income limitation, which is Schedule C line 29 (plus Form 8949 / 4797 gains and minus losses not allocable to the home, not modeled). Wording re-read 2026-10-03."
  ),
  BUSINESS_BANK_INTEREST_ROUTING: def(
    "BUSINESS_BANK_INTEREST_ROUTING",
    "Taxable interest on a business bank account is reported on Schedule B / Form 1040 line 2b, not on Schedule C",
    URL_SCH_B_INSTR,
    "Schedule B instructions (2025), Part I line 1: 'Report on line 1 all of your taxable interest ... List each payer's name and the amount'; Form 1040 instructions (2025), line 2b: 'Enter your total taxable interest income on line 2b' (https://www.irs.gov/instructions/i1040gi); Schedule C instructions (2025), line 6 lists only 'Interest (such as on notes and accounts receivable)' as business income not reported elsewhere (https://www.irs.gov/instructions/i1040sc). Wording re-read 2026-10-04.",
    "2026-10-04"
  ),
  SECTION_179_MAX: def("SECTION_179_MAX", 2500000, URL_4562_INSTR, "Section 179 maximum deduction."),
  SECTION_179_PHASEOUT_START: def("SECTION_179_PHASEOUT_START", 4000000, URL_4562_INSTR, "Section 179 reduced dollar-for-dollar above this amount of 179 property."),
  SECTION_179_SUV_CAP: def("SECTION_179_SUV_CAP", 31300, URL_4562_INSTR, "Section 179 cap for certain SUVs."),
  BONUS_ACQUIRED_AFTER: def("BONUS_ACQUIRED_AFTER", "2025-01-19", URL_4562_INSTR, "100% bonus depreciation for property acquired after this date (Form 4562 / Schedule C instructions)."),
  MACRS_39_YEAR_JULY_FIRST_YEAR_PCT: def("MACRS_39_YEAR_JULY_FIRST_YEAR_PCT", 1.177, URL_PUB_946, "Pub 946 Table A-7a: 39-year nonresidential real property, mid-month, placed in service in July: year 1 percent."),
  MACRS_39_YEAR_LATER_YEAR_PCT: def("MACRS_39_YEAR_LATER_YEAR_PCT", 2.564, URL_PUB_946, "Pub 946 Table A-7a: years 2-39 percent."),

  // ── AMT ───────────────────────────────────────────────────────────────────
  AMT_EXEMPTION_MFJ: def("AMT_EXEMPTION_MFJ", 137000, URL_6251_INSTR, "2025 AMT exemption, MFJ."),
  AMT_PHASEOUT_START_MFJ: def("AMT_PHASEOUT_START_MFJ", 1252700, URL_6251_INSTR, "AMT exemption begins to phase out here (the reduction rate is not verified; above this the engine returns needs_cpa_rule_unverified)."),
  AMT_28_PERCENT_THRESHOLD: def("AMT_28_PERCENT_THRESHOLD", 239100, URL_6251_INSTR, "26% applies to the first $239,100 of the excess, 28% above."),
  AMT_RATE_LOW: def("AMT_RATE_LOW", 0.26, URL_6251_INSTR, "AMT 26% rate."),
  AMT_RATE_HIGH: def("AMT_RATE_HIGH", 0.28, URL_6251_INSTR, "AMT 28% rate."),
  AMT_SENIOR_DEDUCTION_ADDBACK: def(
    "AMT_SENIOR_DEDUCTION_ADDBACK",
    "line 1a = Form 1040 line 14 minus Schedule 1-A line 37; line 1b = Form 1040 line 11b minus line 1a (may be negative)",
    URL_6251_INSTR,
    "Form 6251 (2025): line 1a \"Subtract Schedule 1-A (Form 1040), line 37, from Form 1040 line 14\"; line 1b \"Subtract line 1a from Form 1040 line 11b (if less than zero, enter as a negative amount)\"; line 4 \"Combine lines 1b through 3\". Instructions, What's New: the Schedule 1-A senior deduction \"is treated as a personal exemption that is added back to alternative minimum taxable income as an adjustment under section 56(b)(5)(D)\".",
    VERIFIED_ON_2026_10_04
  ),
  AMT_LINE_2A_TAXES: def(
    "AMT_LINE_2A_TAXES",
    "line 2a = Schedule A line 7 when itemizing, else Form 1040 line 12e",
    URL_6251_INSTR,
    "Form 6251 (2025) line 2a: \"If filing Schedule A (Form 1040), enter the taxes from Schedule A, line 7; otherwise, enter the amount from Form 1040 or 1040-SR, line 12e\". Schedule A line 7 is line 5e plus line 6 (other taxes).",
    VERIFIED_ON_2026_10_04
  ),

  // ── Form 2210 / interest (informational; rules arrive in 1b) ──────────────
  SAFE_HARBOR_CURRENT_YEAR_FRACTION: def("SAFE_HARBOR_CURRENT_YEAR_FRACTION", 0.9, URL_2210_INSTR, "Safe harbor: 90% of the current-year tax."),
  SAFE_HARBOR_PRIOR_YEAR_FRACTION: def("SAFE_HARBOR_PRIOR_YEAR_FRACTION", 1.0, URL_2210_INSTR, "Safe harbor: 100% of the prior-year tax."),
  SAFE_HARBOR_PRIOR_YEAR_HIGH_AGI_FRACTION: def("SAFE_HARBOR_PRIOR_YEAR_HIGH_AGI_FRACTION", 1.1, URL_2210_INSTR, "Safe harbor: 110% of the prior-year tax if prior-year AGI is over $150,000."),
  SAFE_HARBOR_HIGH_AGI_THRESHOLD: def("SAFE_HARBOR_HIGH_AGI_THRESHOLD", 150000, URL_2210_INSTR, "Prior-year AGI above this uses the 110% safe harbor."),
  UNDERPAYMENT_NO_PENALTY_BELOW: def("UNDERPAYMENT_NO_PENALTY_BELOW", 1000, URL_2210_INSTR, "No penalty if tax minus withholding is under $1,000."),
  FORM_2210_DUE_DATES: def(
    "FORM_2210_DUE_DATES",
    ["2025-04-15", "2025-06-15", "2025-09-15", "2026-01-15"] as string[],
    URL_2210_FORM,
    "Form 2210 Part III payment due dates (columns a-d). A payment made on the next business day counts as made on the due date (instructions, line 11)."
  ),
  FORM_2210_PENALTY_END: def(
    "FORM_2210_PENALTY_END",
    "2026-04-15",
    URL_2210_INSTR,
    "The Form 2210 penalty worksheet figures the penalty for each underpayment through April 15, 2026 (rate period 4); later interest is billed by the IRS."
  ),
  FORM_2210_RATE_PERIODS: def(
    "FORM_2210_RATE_PERIODS",
    [
      { start: "2025-04-16", end: "2025-06-30", ratePercent: 7 },
      { start: "2025-07-01", end: "2025-09-30", ratePercent: 7 },
      { start: "2025-10-01", end: "2025-12-31", ratePercent: 7 },
      { start: "2026-01-01", end: "2026-04-15", ratePercent: 7 },
    ] as { start: string; end: string; ratePercent: number }[],
    URL_2210_INSTR,
    "Form 2210 penalty worksheet: underpayment x days / 365 x 0.07 in each of the four rate periods (the 2025 worksheet prints 0.07 for every period). Rate period 4 follows the PRINTED form on purpose; the IRS quarterly table shows 6% for Q2 2026 (April 1-15), a difference of about $0.04 per $1,000 underpaid in an informational estimate."
  ),
  FORM_2210_DAYS_IN_YEAR: def("FORM_2210_DAYS_IN_YEAR", 365, URL_2210_INSTR, "Form 2210 penalty worksheet: days divided by 365."),
  FORM_2210_INSTALLMENT_FRACTION: def("FORM_2210_INSTALLMENT_FRACTION", 0.25, URL_2210_INSTR, "Form 2210 line 10: each required installment is 25% of the required annual payment (regular method)."),
  FORM_2210_LINE2_SCH2_LINES: def(
    "FORM_2210_LINE2_SCH2_LINES",
    ["4", "8", "9", "11", "12", "14", "15", "16", "17a", "17c", "17d", "17e", "17f", "17g", "17h", "17i", "17j", "17l", "17z", "19"] as string[],
    URL_2210_INSTR,
    "Form 2210 line 2 (Form 1040 filers): the Schedule 2 lines to add (line 8 = additional tax on distributions only)."
  ),
  FORM_2210_LINE3_LINES: def(
    "FORM_2210_LINE3_LINES",
    ["f1040.27a", "f1040.28", "f1040.29", "f1040.30", "sch3.9", "sch3.12", "sch3.13b"] as string[],
    URL_2210_INSTR,
    "Form 2210 line 3: refundable credits (earned income, additional child tax, refundable American opportunity, refundable adoption, premium tax credit, fuel credit, section 1341 credit)."
  ),
  FORM_2210_PRIOR_YEAR_TAX_NOTE: def(
    "FORM_2210_PRIOR_YEAR_TAX_NOTE",
    "2024 tax for line 8 = Form 1040 line 22 + Schedule 2 lines 4, 8 (distributions only), 9, 10, 11, 12, 14, 15, 16, 17a, 17c-17j, 17l, 17z, 19, minus refundable credits; Additional Medicare Tax (line 11) and net investment income tax (line 12) ARE included",
    URL_2210_INSTR,
    "Form 2210 line 8 instructions (re-read by the Tester 2026-10-04). The extracted prior-year total tax (Form 1040 line 24) differs from this figure only by the Schedule 2 lines not in the chart (5-7, 13, 17b, 17k, 17m and later) and by the refundable credits, which are subtracted."
  ),
  UNDERPAYMENT_INTEREST_RATES: def(
    "UNDERPAYMENT_INTEREST_RATES",
    { "2025": [7, 7, 7, 7], "2026": [7, 6, 7, 7] } as Record<string, number[]>,
    URL_INTEREST_RATES,
    "IRS underpayment interest rate (percent) by quarter."
  ),

  // ── Connecticut ───────────────────────────────────────────────────────────
  CT_TAX_TABLE_AGI_LIMIT: def(
    "CT_TAX_TABLE_AGI_LIMIT",
    102000,
    URL_CT_INSTR,
    "CT-1040 line 6: CT AGI at most this amount uses the printed CT tax table (NOT transcribed here; see specs/09 not-verified list); above it the Tax Calculation Schedule applies."
  ),
  CT_ZERO_TAX_AGI_MFJ: def("CT_ZERO_TAX_AGI_MFJ", 24000, URL_CT_INSTR, "CT-1040 line 6: CT AGI of $24,000 or less (MFJ) has no CT income tax."),
  CT_TABLE_C: def(
    "CT_TABLE_C",
    { threshold: 100500, stepSize: 5000, stepAmount: 50, maxSteps: 10 },
    URL_CT_TCS,
    "Table C (MFJ), re-read 2026-10-03: $50 per $5,000 band of CT AGI above $100,500, step count = ceil((AGI - 100,500) / 5,000), capped at 10 ($500)."
  ),
  CT_PROPERTY_TAX_CREDIT_MAX: def("CT_PROPERTY_TAX_CREDIT_MAX", 300, URL_CT_INSTR, "CT property tax credit maximum per return."),
  CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ: def("CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ", 2, URL_CT_INSTR, "Primary residence plus up to 2 motor vehicles (MFJ)."),
  CT_PROPERTY_TAX_CREDIT_FULL_AGI_MFJ: def("CT_PROPERTY_TAX_CREDIT_FULL_AGI_MFJ", 70500, URL_CT_INSTR, "Full credit at CT AGI at most this amount (MFJ)."),
  CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ: def(
    "CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ",
    [
      { upTo: 70500, value: 0 },
      { upTo: 80500, value: 0.15 },
      { upTo: 90500, value: 0.3 },
      { upTo: 100500, value: 0.45 },
      { upTo: 110500, value: 0.6 },
      { upTo: 120500, value: 0.75 },
      { upTo: 130500, value: 0.9 },
      { upTo: null, value: 1 },
    ] as UpToBand[],
    URL_CT_INSTR,
    "Phase-out decimal by CT AGI (MFJ); credit = tentative credit x (1 - decimal). 1.00 above $130,500 = $0."
  ),
  STATE_REFUND_2024_STANDARD_DEDUCTION_MFJ: def(
    "STATE_REFUND_2024_STANDARD_DEDUCTION_MFJ",
    29200,
    URL_1040_INSTR,
    "State and Local Income Tax Refund Worksheet (Schedule 1 line 1, 2025 instructions) line 5: the 2024 standard deduction for married filing jointly or qualifying surviving spouse. (Single / MFS 14,600 and head of household 21,900 are printed there too but only the joint return is computed.)"
  ),
  STATE_REFUND_2024_BOX_AMOUNT: def(
    "STATE_REFUND_2024_BOX_AMOUNT",
    1550,
    URL_1040_INSTR,
    "State and Local Income Tax Refund Worksheet line 6: 1,550 per box checked (born before January 2, 1960 or blind, you and your spouse), 1,950 if the 2024 status was single or head of household."
  ),
  // ── CT-1040 Schedule 1 (verified 2026-10-04 against the 2025 CT-1040 instructions, Rev. 12/25, pp. 6-10) ──
  CT_SCH1_STATUTORY_MODIFICATIONS_ONLY: def(
    "CT_SCH1_STATUTORY_MODIFICATIONS_ONLY",
    "Conn. Gen. Stat. 12-701(a)(20)",
    URL_CT_INSTR,
    "CT-1040 instructions p. 6: federal adjusted gross income may not be further modified in determining Connecticut adjusted gross income except as expressly provided by Conn. Gen. Stat. 12-701(a)(20).",
    VERIFIED_ON_2026_10_04
  ),
  CT_SCH1_LINE_RULES: def(
    "CT_SCH1_LINE_RULES",
    {
      "31": "Line 31: interest on state and municipal obligations other than Connecticut that is not taxed for federal income tax purposes (not Puerto Rico, Guam, American Samoa or U.S. Virgin Islands).",
      "32": "Line 32: exempt-interest dividends from a mutual fund derived from non-Connecticut state and municipal obligations; only the non-Connecticut percentage when the fund holds both (a fund with 20% Connecticut obligations: add back 80%).",
      "33": "Line 33: the part of a qualified plan lump-sum distribution on which federal Form 4972 was filed that is not reported on federal Form 1040 line 5a or Schedule D.",
      "34": "Line 34: beneficiary's share of the Connecticut fiduciary adjustment from an estate or trust, when greater than zero (Schedule CT-1041 K-1); when less than zero it goes on line 46.",
      "35": "Line 35: losses from the sale or exchange of notes, bonds or other obligations of the State of Connecticut or its municipalities used to determine federal gain (loss), whether or not the entire loss is used in federal AGI.",
      "36": "Line 36: 100% of the Section 168(k) bonus depreciation reported for federal income tax purposes this year, provided it is deducted in federal AGI.",
      "36a": "Line 36a: 80% of the Section 179 amount deducted in determining federal AGI.",
      "37": "Line 37: other additions (treaty income, enrolled Mashantucket Pequot / Mohegan Tribe member losses, Connecticut income tax deducted other than on Schedule A, expenses and bond premium related to Connecticut-exempt income, interest on debt carried to hold such obligations, Manufacturing Reinvestment Account distributions, Section 457A compensation, U.S. agency interest exempt federally but not by Connecticut, and any other required addition); each must be described on the form.",
      "39": "Line 39: interest on U.S. government obligations that federal law prohibits states from taxing (savings bonds, Treasury bills and notes), to the extent included in federal AGI; for Series EE bonds only the interest left after the Form 8815 exclusion; not Fannie Mae, Ginnie Mae or Freddie Mac interest and not interest on a federal tax refund.",
      "40": "Line 40: exempt dividends from a qualifying mutual fund (at least 50% of its assets in U.S. government obligations at the close of each quarter) derived from U.S. government obligations; the exempt percentage is reported by the fund (a $100 dividend that is 55% T-bills gives $55).",
      "41": "Line 41: Social Security benefit adjustment from the Social Security Benefit Adjustment Worksheet (instructions p. 24); fully exempt below the CT-1040 line 1 threshold, partly exempt above it.",
      "42": "Line 42: the taxable refunds of state and local income taxes reported on federal Form 1040 Schedule 1 line 1 (enter 0 if that line is blank).",
      "43": "Line 43: Tier 1 and Tier 2 railroad retirement benefits and supplemental annuities (federal Form 1040 line 5b) not already subtracted on line 41.",
      "44": "Line 44: military retirement pay to the extent included in federal AGI.",
      "45": "Line 45: 50% of Connecticut Teachers' Retirement System pay included in federal AGI (Form 1099-R from the Connecticut Teachers' Retirement Board).",
      "46": "Line 46: beneficiary's share of the Connecticut fiduciary adjustment from an estate or trust, when less than zero.",
      "47": "Line 47: gains from the sale or exchange of notes, bonds or other obligations of the State of Connecticut or its municipalities used to determine federal gain (loss).",
      "48": "Line 48: Connecticut Higher Education Trust (CHET) contributions, limited to the maximum contribution (joint return: $10,000), with the excess carried forward five years.",
      "48a": "Line 48a: 25% of the Section 168(k) deduction added back on the Connecticut return in the four preceding taxable years.",
      "48b": "Line 48b: pension and annuity income (Pension and Annuity Worksheet, instructions pp. 24-25) when federal AGI is under the joint threshold, from federal Form 1040 lines 4b and 5b.",
      "48c": "Line 48c: ordinary and necessary business expenses of a taxpayer licensed under Connecticut General Statutes Chapter 420f or 420h that are not claimed for federal income tax purposes.",
      "48d": "Line 48d: contributions to an ABLE (Achieving a Better Life Experience) account, limited to the maximum contribution (joint return: $10,000).",
      "49": "Line 49: other subtractions (enrolled Mashantucket Pequot / Mohegan Tribe member income, Connecticut individual development account interest, interest on debt carried for investments taxable only by Connecticut, related expenses, CHET distributions received as designated beneficiary, bond premium, interest on Connecticut obligations included in federal income, Connecticut Homecare Option earnings, Manufacturing Reinvestment Account contributions, crumbling-foundation assistance, organ and bone marrow donation costs, Bioscience Venture Capital, Fallen Hero Fund, Connecticut Student Loan Reimbursement Program, Connecticut share-plan stock, 25% of prior Section 179 add-backs); each must be described on the form.",
    } as Record<string, string>,
    URL_CT_INSTR,
    "CT-1040 instructions (Rev. 12/25) pp. 6-10, Schedule 1 line by line: one summary sentence per printed line, used in the engine's reasons. The exact thresholds and worksheets (Social Security p. 24, Pension and Annuity pp. 24-25) are in the instructions and are NOT built here.",
    VERIFIED_ON_2026_10_04
  ),
  CT_SCH1_BONUS_168K_ADDBACK_PERCENT: def(
    "CT_SCH1_BONUS_168K_ADDBACK_PERCENT",
    100,
    URL_CT_INSTR,
    "CT-1040 Schedule 1 line 36: add back 100% of the Section 168(k) bonus depreciation deducted in federal AGI. Only named in reasons; no amount is computed from it yet.",
    VERIFIED_ON_2026_10_04
  ),
  CT_SCH1_SECTION_179_ADDBACK_PERCENT: def(
    "CT_SCH1_SECTION_179_ADDBACK_PERCENT",
    80,
    URL_CT_INSTR,
    "CT-1040 Schedule 1 line 36a: add back 80% of the Section 179 amount deducted in federal AGI. Only named in reasons; no amount is computed from it yet.",
    VERIFIED_ON_2026_10_04
  ),
  CT_SCH1_PRIOR_ADDBACK_SUBTRACTION_PERCENT: def(
    "CT_SCH1_PRIOR_ADDBACK_SUBTRACTION_PERCENT",
    25,
    URL_CT_INSTR,
    "CT-1040 Schedule 1 lines 48a and 49 (item 10): subtract 25% of the Section 168(k) / Section 179 amounts added back in the four preceding years. Only named in reasons; no amount is computed from it yet.",
    VERIFIED_ON_2026_10_04
  ),
  CT_USE_TAX_RATE_GENERAL: def(
    "CT_USE_TAX_RATE_GENERAL",
    0.0635,
    URL_CT_INSTR,
    "Connecticut individual use tax worksheet, Section B: the general rate is 6.35% of the purchase price, minus tax paid to another state (column 6). The 7.75% (luxury), 1% (computer services) and 2.99% (vessels) sections are not computed here."
  ),
  CT_LATE_PAYMENT_PENALTY_RATE: def("CT_LATE_PAYMENT_PENALTY_RATE", 0.1, URL_CT_INSTR, "CT-1040 line 27 late payment penalty rate (10%); the minimum-penalty and month-counting rules are not verified."),
  CT_INTEREST_RATE_PER_MONTH: def("CT_INTEREST_RATE_PER_MONTH", 0.01, URL_CT_INSTR, "CT-1040 line 28 interest, 1% per month."),
  CT_ESTIMATED_TAX_INTEREST_MIN: def(
    "CT_ESTIMATED_TAX_INTEREST_MIN",
    1000,
    URL_CT_2210,
    "CT-2210 (Rev. 12/25) page 1 and Part 2 line 4: if the 2025 CT income tax (CT-1040 line 14) less CT withholding and the pass-through entity tax credit (line 20c) is less than $1,000, there is no interest on underpayment of estimated tax and the form is not filed. The 2025 CT-1040 instructions (line 29, https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf) repeat the $1,000 test and let the filer leave line 29 blank for DRS to bill.",
    VERIFIED_ON_2026_10_04
  ),
} as const;

export type ConstantId = keyof typeof CONSTANTS;

/** Shorthand used by rule files: `K.SE_WAGE_BASE.value`. */
export const K = CONSTANTS;

/** Every registry entry, for the citation test. */
export function allConstants(): TaxConstant<unknown>[] {
  return Object.values(CONSTANTS) as TaxConstant<unknown>[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns a list of problems (empty = OK). A constant needs: id equal to its
 * key, an https url on irs.gov or portal.ct.gov, an ISO verifiedOn date, and a
 * non-empty note.
 */
export function constantCitationProblems(registry: Readonly<Record<string, TaxConstant<unknown>>>): string[] {
  const problems: string[] = [];
  for (const [key, c] of Object.entries(registry)) {
    if (c.id !== key) problems.push(`${key}: id "${c.id}" does not match its registry key`);
    if (typeof c.url !== "string" || c.url.trim() === "") {
      problems.push(`${key}: missing url`);
    } else if (!/^https:\/\/(www\.irs\.gov|portal\.ct\.gov)\//.test(c.url)) {
      problems.push(`${key}: url is not an irs.gov / portal.ct.gov https link (${c.url})`);
    }
    if (typeof c.verifiedOn !== "string" || !ISO_DATE.test(c.verifiedOn)) {
      problems.push(`${key}: missing or malformed verifiedOn`);
    }
    if (typeof c.note !== "string" || c.note.trim() === "") problems.push(`${key}: missing note`);
  }
  return problems;
}

/**
 * Numbers a rule file must not repeat as a literal. Money-sized values (>= 1,000)
 * plus the distinctive rates; trivially common numbers (0.1, 0.2, 50, 100...) are
 * not in this list because they cannot be told apart from ordinary arithmetic.
 */
export function protectedNumericValues(): Set<number> {
  const out = new Set<number>();
  const distinctiveRates = new Set([0.9235, 0.124, 0.029, 0.009, 0.038, 0.0145, 0.26, 0.28, 1.177, 2.564]);
  const visit = (v: unknown): void => {
    if (typeof v === "number") {
      // calendar years (2025 ...) are not rule constants: the engine legitimately names the tax year
      const isYear = Number.isInteger(v) && v >= 1990 && v <= 2100;
      if (!isYear && (Math.abs(v) >= 1000 || distinctiveRates.has(v))) out.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (typeof v === "object" && v !== null) {
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  for (const c of allConstants()) visit(c.value);
  return out;
}
