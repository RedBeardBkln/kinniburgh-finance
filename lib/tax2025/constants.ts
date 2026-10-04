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

const IRS = "https://www.irs.gov";
const URL_1040_INSTR = `${IRS}/instructions/i1040gi`;
const URL_SCH_A_INSTR = `${IRS}/instructions/i1040sca`;
const URL_SCH_1A = `${IRS}/pub/irs-pdf/f1040s1a.pdf`;
const URL_SCH_SE_FORM = `${IRS}/pub/irs-pdf/f1040sse.pdf`;
const URL_8959_INSTR = `${IRS}/instructions/i8959`;
const URL_8960_INSTR = `${IRS}/instructions/i8960`;
const URL_8995_INSTR = `${IRS}/instructions/i8995`;
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
const URL_INTEREST_RATES = `${IRS}/payments/quarterly-interest-rates`;
const URL_CT_INSTR = "https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf";
const URL_CT_TCS = "https://portal.ct.gov/-/media/drs/forms/2025/income/ct-1040-tcs_1225.pdf";

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
    "MFJ ordinary-income brackets (Tax Computation Worksheet equivalent); recorded in specs/09 from IR-2024-273 / Rev. Proc. 2024-40, unchanged by OBBBA.",
    VERIFIED_ON_SPEC09_FIRST_PASS
  ),

  SCH_B_THRESHOLD: def(
    "SCH_B_THRESHOLD",
    1500,
    URL_1040_INSTR,
    "Schedule B is required if taxable interest or ordinary dividends exceed $1,500 (plan section 4.2, 1040 instructions)."
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
  SCH1A_CAR_LOAN_MAX: def("SCH1A_CAR_LOAN_MAX", 10000, URL_SCH_1A, "Car-loan interest deduction maximum."),
  SCH1A_CAR_LOAN_MAGI_START_MFJ: def("SCH1A_CAR_LOAN_MAGI_START_MFJ", 200000, URL_SCH_1A, "Car-loan interest MAGI reduction starts (MFJ)."),
  SCH1A_CAR_LOAN_REDUCTION_PER_1000: def("SCH1A_CAR_LOAN_REDUCTION_PER_1000", 200, URL_SCH_1A, "Car-loan interest: reduce by $200 per $1,000 over (rounded UP)."),
  SCH1A_SENIOR_AMOUNT: def("SCH1A_SENIOR_AMOUNT", 6000, URL_SCH_1A, "Senior deduction per person born before Jan 2, 1961."),
  SCH1A_SENIOR_MAGI_START_MFJ: def("SCH1A_SENIOR_MAGI_START_MFJ", 150000, URL_SCH_1A, "Senior deduction MAGI reduction starts (MFJ)."),
  SCH1A_SENIOR_REDUCTION_RATE: def("SCH1A_SENIOR_REDUCTION_RATE", 0.06, URL_SCH_1A, "Senior deduction reduced by 6% of the MAGI excess."),

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

  // ── Form 2210 / interest (informational; rules arrive in 1b) ──────────────
  SAFE_HARBOR_CURRENT_YEAR_FRACTION: def("SAFE_HARBOR_CURRENT_YEAR_FRACTION", 0.9, URL_2210_INSTR, "Safe harbor: 90% of the current-year tax."),
  SAFE_HARBOR_PRIOR_YEAR_FRACTION: def("SAFE_HARBOR_PRIOR_YEAR_FRACTION", 1.0, URL_2210_INSTR, "Safe harbor: 100% of the prior-year tax."),
  SAFE_HARBOR_PRIOR_YEAR_HIGH_AGI_FRACTION: def("SAFE_HARBOR_PRIOR_YEAR_HIGH_AGI_FRACTION", 1.1, URL_2210_INSTR, "Safe harbor: 110% of the prior-year tax if prior-year AGI is over $150,000."),
  SAFE_HARBOR_HIGH_AGI_THRESHOLD: def("SAFE_HARBOR_HIGH_AGI_THRESHOLD", 150000, URL_2210_INSTR, "Prior-year AGI above this uses the 110% safe harbor."),
  UNDERPAYMENT_NO_PENALTY_BELOW: def("UNDERPAYMENT_NO_PENALTY_BELOW", 1000, URL_2210_INSTR, "No penalty if tax minus withholding is under $1,000."),
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
  CT_LATE_PAYMENT_PENALTY_RATE: def("CT_LATE_PAYMENT_PENALTY_RATE", 0.1, URL_CT_INSTR, "CT-1040 line 27 late payment penalty rate (10%); the minimum-penalty and month-counting rules are not verified."),
  CT_INTEREST_RATE_PER_MONTH: def("CT_INTEREST_RATE_PER_MONTH", 0.01, URL_CT_INSTR, "CT-1040 line 28 interest, 1% per month."),
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
