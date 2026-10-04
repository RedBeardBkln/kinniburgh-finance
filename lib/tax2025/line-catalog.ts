// Catalog of every printed money line the TY2025 return engine knows about.
// DATA ONLY (no imports): types.ts derives `LineKey` from it and re-exports.
//
// Line ids are the real 2025 form line ids, read from the field "speak" text of
// the actual 2025 IRS PDFs (Form 1040 pages 1-2, Schedules 1, 2, 3, A, B, C, SE,
// Forms 8995 and 8959). Notable 2025 facts that differ from older years:
//   - Form 1040: line 7 is "7a" (+ "7b"), the deduction is line "12e", 13b is
//     Schedule 1-A, 25c is "other forms" (Form 8959 line 24 goes there).
//   - Schedule A: 8d is "Reserved for future use"; points reported on a 1098 are
//     part of 8a; lines 8b / 8c are amounts NOT reported on a 1098.
//   - Schedule C: 27a is the energy efficient commercial buildings deduction,
//     other expenses are 27b (Part V line 48).
//   - Schedule 2: AMT is line 2.
//
// "none groups": lines that apply only to rare situations (other income types,
// other adjustments, other credits ...). When no rule or stated input fills such
// a line, the assembler marks it `not_yet_computed` (never 0) unless the owner or
// CPA has stated "none" for the whole group (facts.statedNone), which makes the
// lines `not_applicable` zeros carrying that statement as provenance.
// The six `ct_*` groups are different: they gate CT-1040 Schedule 1 detail lines (`ct1040.s1.*`) that the
// CT Schedule 1 rule (rules/ct-schedule1.ts) emits itself, so no catalog line names them as its `group`.

export const NONE_GROUP_TEXT = {
  other_earned_income:
    "No household employee wages, unreported tip income, Medicaid waiver payments, dependent care or adoption benefits, Form 8919 wages or other earned income (1040 lines 1b-1i).",
  retirement_ss_income: "No IRA distributions, pensions or annuities, or Social Security benefits (1040 lines 4a-6b).",
  other_income:
    "No Schedule 1 Part I income other than Schedule C business income: no state tax refunds, alimony, other gains, rental or partnership income, farm income, unemployment compensation, or any line 8 item.",
  other_adjustments:
    "No Schedule 1 Part II adjustments other than HSA, half of SE tax, SE retirement, SE health insurance and IRA: no educator expenses, penalty on early withdrawal, alimony paid, student loan interest or line 24 items.",
  other_taxes: "No Schedule 2 additional taxes beyond AMT, self-employment tax, Additional Medicare Tax and net investment income tax.",
  other_nonrefundable_credits:
    "No other nonrefundable credits: child and dependent care, education, Form 5695 line 32 energy improvements, general business, adoption and the other Schedule 3 line 6 credits.",
  solar_credit: "No 2025 residential clean energy credit (Form 5695 line 15).",
  other_refundable_credits:
    "No premium tax credit, fuel credit, earned income credit, additional child tax credit, American opportunity credit, refundable adoption credit or other refundable credit.",
  medical_expenses: "No medical or dental expenses to deduct (Schedule A lines 1-4).",
  sch_a_other:
    "No other Schedule A items: no other taxes, mortgage interest or points outside Form 1098, investment interest, charitable carryover, casualty or theft losses, or other itemized deductions.",
  savings_bond_exclusion: "No excludable interest on series EE or I savings bonds (Form 8815).",
  sch_c_other_lines: "No depletion and no energy efficient commercial buildings deduction on Schedule C.",
  se_other:
    "No farm income, church employee income, unreported tips (Form 4137), Form 8919 wages, railroad (RRTA) compensation or optional SE methods.",
  qbi_carryforwards: "No prior-year qualified business loss or REIT / PTP loss carryforwards (Form 8995).",
  capital_gain_other:
    "No installment sale (Form 6252), casualty or theft loss (Form 4684), Section 1256 contract (Form 6781), like-kind exchange (Form 8824), Form 2439 undistributed capital gain, or capital gain or loss on a Schedule K-1 (partnership, S corporation, estate or trust): Schedule D lines 4, 5, 11 and 12.",
  capital_special_rates:
    "No sale of collectibles (including gold or silver trust shares), qualified small business (QSB) stock, depreciated real estate or a partnership interest, and no qualified opportunity fund (QOF) investment: Schedule D lines 18 and 19 and the page 1 QOF box.",
  // Connecticut CT-1040 Schedule 1 groups. No catalog line carries these as a `group`: the CT Schedule 1 rule
  // (rules/ct-schedule1.ts) owns its lines and reads these statements itself.
  ct_muni_bonds:
    "No gain or loss in 2025 on selling or paying off a bond issued by the State of Connecticut or a Connecticut city, town or agency (CT-1040 Schedule 1 lines 35 and 47).",
  ct_us_gov_funds:
    "No shares of a mutual fund or ETF that holds mostly U.S. government (Treasury) obligations, so no exempt U.S.-government fund dividends (CT-1040 Schedule 1 line 40).",
  ct_chet_able:
    "No Connecticut Higher Education Trust (CHET) or ABLE account contributions or carried-over CHET deduction, and no CHET money received as the account's beneficiary (CT-1040 Schedule 1 lines 48, 48d and 49).",
  ct_prior_addbacks:
    "No bonus depreciation or Section 179 amount was added back on a Connecticut return in the four years before 2025 (CT-1040 Schedule 1 lines 48a and 49).",
  ct_other_additions: "No other Connecticut additions to federal income (CT-1040 Schedule 1 line 37).",
  ct_other_subtractions: "No other Connecticut subtractions from federal income (CT-1040 Schedule 1 lines 48c and 49).",
  // CT-1040 lines 7, 13 and 20a-20d (rules/ct-credits.ts reads these; no catalog line names them as its `group`).
  ct_other_state_tax:
    "No income earned in or connected with another state or qualifying jurisdiction that was taxed by it, so no credit for income taxes paid to another jurisdiction (CT-1040 line 7, Schedule 2).",
  ct_other_credits:
    "No Connecticut credit other than the property tax credit: none from Schedule CT-IT Credit (youth development, ABLE, stillborn child, employer CHET, angel investor, real estate conveyance, theater, UConn, workforce housing, CT-8801), no Connecticut earned income credit, claim of right credit, pass-through entity tax credit or historic home credit (CT-1040 lines 13, 20a, 20b, 20c, 20d).",
} as const;

export type NoneGroupId = keyof typeof NONE_GROUP_TEXT;
export const NONE_GROUP_IDS = Object.keys(NONE_GROUP_TEXT) as NoneGroupId[];

type Row = readonly [id: string, label: string, group?: NoneGroupId];

// ── Form 1040, pages 1-2 ──────────────────────────────────────────────────────

const F1040 = [
  ["1a", "Wages from Form(s) W-2, box 1"],
  ["1b", "Household employee wages not reported on a W-2", "other_earned_income"],
  ["1c", "Tip income not reported on line 1a", "other_earned_income"],
  ["1d", "Medicaid waiver payments not reported on a W-2", "other_earned_income"],
  ["1e", "Taxable dependent care benefits (Form 2441)", "other_earned_income"],
  ["1f", "Employer-provided adoption benefits (Form 8839)", "other_earned_income"],
  ["1g", "Wages from Form 8919", "other_earned_income"],
  ["1h", "Other earned income", "other_earned_income"],
  ["1i", "Nontaxable combat pay election", "other_earned_income"],
  ["1z", "Total of lines 1a through 1h"],
  ["2a", "Tax-exempt interest"],
  ["2b", "Taxable interest"],
  ["3a", "Qualified dividends"],
  ["3b", "Ordinary dividends"],
  ["4a", "IRA distributions", "retirement_ss_income"],
  ["4b", "IRA distributions, taxable amount", "retirement_ss_income"],
  ["5a", "Pensions and annuities", "retirement_ss_income"],
  ["5b", "Pensions and annuities, taxable amount", "retirement_ss_income"],
  ["6a", "Social security benefits", "retirement_ss_income"],
  ["6b", "Social security benefits, taxable amount", "retirement_ss_income"],
  ["7a", "Capital gain or (loss)"],
  ["7b", "Line 7b (see the 2025 Form 1040 instructions)"],
  ["8", "Additional income from Schedule 1, line 10"],
  ["9", "Total income"],
  ["10", "Adjustments to income from Schedule 1, line 26"],
  ["11a", "Adjusted gross income"],
  ["11b", "Adjusted gross income (page 2)"],
  ["12e", "Standard deduction or itemized deductions"],
  ["13a", "Qualified business income deduction"],
  ["13b", "Additional deductions from Schedule 1-A"],
  ["14", "Total deductions (lines 12e, 13a, 13b)"],
  ["15", "Taxable income"],
  ["16", "Tax"],
  ["17", "Amount from Schedule 2, line 3"],
  ["18", "Tax plus Schedule 2 amount (lines 16 and 17)"],
  ["19", "Child tax credit or credit for other dependents"],
  ["20", "Amount from Schedule 3, line 8"],
  ["21", "Credits (lines 19 and 20)"],
  ["22", "Tax after credits"],
  ["23", "Other taxes, including self-employment tax (Schedule 2, line 21)"],
  ["24", "Total tax"],
  ["25a", "Federal income tax withheld from Form(s) W-2"],
  ["25b", "Federal income tax withheld from Form(s) 1099"],
  ["25c", "Federal income tax withheld, other forms (Form 8959 line 24)"],
  ["25d", "Total federal income tax withheld"],
  ["26", "2025 estimated tax payments and amount applied from 2024 return"],
  ["27a", "Earned income credit", "other_refundable_credits"],
  ["28", "Additional child tax credit", "other_refundable_credits"],
  ["29", "American opportunity credit", "other_refundable_credits"],
  ["30", "Refundable adoption credit", "other_refundable_credits"],
  ["31", "Amount from Schedule 3, line 15"],
  ["32", "Total other payments and refundable credits"],
  ["33", "Total payments"],
  ["34", "Amount overpaid"],
  ["35a", "Amount of overpayment to be refunded"],
  ["36", "Amount of overpayment applied to 2026 estimated tax"],
  ["37", "Amount you owe"],
  ["38", "Estimated tax penalty"],
] as const satisfies readonly Row[];

// ── Schedule 1 ────────────────────────────────────────────────────────────────

const SCH1 = [
  ["1", "Taxable refunds, credits or offsets of state and local income taxes", "other_income"],
  ["2a", "Alimony received", "other_income"],
  ["3", "Business income or (loss) (Schedule C)"],
  ["4", "Other gains or (losses) (Form 4797)", "other_income"],
  ["5", "Rental real estate, royalties, partnerships, S corporations, trusts (Schedule E)", "other_income"],
  ["6", "Farm income or (loss) (Schedule F)", "other_income"],
  ["7", "Unemployment compensation", "other_income"],
  ["8a", "Net operating loss", "other_income"],
  ["8b", "Gambling", "other_income"],
  ["8c", "Cancellation of debt", "other_income"],
  ["8d", "Foreign earned income exclusion (Form 2555)", "other_income"],
  ["8e", "Income from Form 8853", "other_income"],
  ["8f", "Income from Form 8889", "other_income"],
  ["8g", "Alaska Permanent Fund dividends", "other_income"],
  ["8h", "Jury duty pay", "other_income"],
  ["8i", "Prizes and awards", "other_income"],
  ["8j", "Activity not engaged in for profit income", "other_income"],
  ["8k", "Stock options", "other_income"],
  ["8l", "Income from the rental of personal property", "other_income"],
  ["8m", "Olympic and Paralympic medals and USOC prize money", "other_income"],
  ["8n", "Section 951(a) inclusion", "other_income"],
  ["8o", "Section 951A(a) inclusion", "other_income"],
  ["8p", "Section 461(l) excess business loss adjustment", "other_income"],
  ["8q", "Taxable distributions from an ABLE account", "other_income"],
  ["8r", "Scholarship and fellowship grants not reported on a W-2", "other_income"],
  ["8s", "Nontaxable amount of Medicaid waiver payments included on Form 1040 line 1a or 1d", "other_income"],
  ["8t", "Pension or annuity from a nonqualified deferred compensation plan", "other_income"],
  ["8u", "Wages earned while incarcerated", "other_income"],
  ["8v", "Digital assets received as ordinary income not reported elsewhere", "other_income"],
  ["8z", "Other income", "other_income"],
  ["9", "Total other income (lines 8a through 8z)"],
  ["10", "Additional income (to Form 1040 line 8)"],
  ["11", "Educator expenses", "other_adjustments"],
  ["12", "Certain business expenses of reservists, performing artists and fee-basis officials", "other_adjustments"],
  ["13", "Health savings account deduction"],
  ["14", "Moving expenses for members of the Armed Forces", "other_adjustments"],
  ["15", "Deductible part of self-employment tax"],
  ["16", "Self-employed SEP, SIMPLE and qualified plans"],
  ["17", "Self-employed health insurance deduction"],
  ["18", "Penalty on early withdrawal of savings", "other_adjustments"],
  ["19a", "Alimony paid", "other_adjustments"],
  ["20", "IRA deduction"],
  ["21", "Student loan interest deduction", "other_adjustments"],
  ["23", "Archer MSA deduction", "other_adjustments"],
  ["24a", "Jury duty pay", "other_adjustments"],
  ["24b", "Deductible expenses related to income on line 8l", "other_adjustments"],
  ["24c", "Nontaxable value of Olympic and Paralympic medals and USOC prize money", "other_adjustments"],
  ["24d", "Reforestation amortization and expenses", "other_adjustments"],
  ["24e", "Repayment of supplemental unemployment benefits (Trade Act of 1974)", "other_adjustments"],
  ["24f", "Contributions to section 501(c)(18)(D) pension plans", "other_adjustments"],
  ["24g", "Contributions by certain chaplains to section 403(b) plans", "other_adjustments"],
  ["24h", "Attorney fees and court costs for certain unlawful discrimination claims", "other_adjustments"],
  ["24i", "Attorney fees and court costs for an IRS whistleblower award", "other_adjustments"],
  ["24j", "Housing deduction from Form 2555", "other_adjustments"],
  ["24k", "Excess deductions of section 67(e) expenses from Schedule K-1 (Form 1041)", "other_adjustments"],
  ["24z", "Other adjustments", "other_adjustments"],
  ["25", "Total other adjustments (lines 24a through 24z)"],
  ["26", "Adjustments to income (to Form 1040 line 10)"],
] as const satisfies readonly Row[];

// ── Schedule 2 ────────────────────────────────────────────────────────────────

const SCH2 = [
  ["1a", "Excess advance premium tax credit repayment", "other_taxes"],
  ["1b", "Repayment of new clean vehicle credit(s) transferred to a dealer", "other_taxes"],
  ["1c", "Repayment of previously owned clean vehicle credit(s) transferred to a dealer", "other_taxes"],
  ["1d", "Recapture of net EPE from Form 4255", "other_taxes"],
  ["1e", "Line 1e (see the Schedule 2 instructions)", "other_taxes"],
  ["1f", "Line 1f (see the Schedule 2 instructions)", "other_taxes"],
  ["1y", "Other additions to tax", "other_taxes"],
  ["1z", "Total additions to tax (lines 1a through 1y)"],
  ["2", "Alternative minimum tax (Form 6251)"],
  ["3", "Part I total (to Form 1040 line 17)"],
  ["4", "Self-employment tax"],
  ["5", "Social security and Medicare tax on unreported tip income (Form 4137)", "other_taxes"],
  ["6", "Uncollected social security and Medicare tax on wages (Form 8919)", "other_taxes"],
  ["7", "Total additional social security and Medicare tax"],
  ["8", "Additional tax on IRAs or other tax-favored accounts (Form 5329)", "other_taxes"],
  ["9", "Household employment taxes (Schedule H)", "other_taxes"],
  ["11", "Additional Medicare Tax (Form 8959)"],
  ["12", "Net investment income tax (Form 8960)"],
  ["13", "Uncollected social security, Medicare or RRTA tax on tips or group-term life insurance", "other_taxes"],
  ["14", "Interest on tax due on installment income from the sale of certain residential lots", "other_taxes"],
  ["15", "Interest on the deferred tax on gain from certain installment sales", "other_taxes"],
  ["16", "Recapture of low-income housing credit (Form 8611)", "other_taxes"],
  ["17a", "Other additional tax, line 17a", "other_taxes"],
  ["17b", "Recapture of federal mortgage subsidy", "other_taxes"],
  ["17c", "Additional tax on HSA distributions (Form 8889)", "other_taxes"],
  ["17d", "Additional tax on an HSA because you did not remain an eligible individual", "other_taxes"],
  ["17e", "Additional tax on Archer MSA distributions", "other_taxes"],
  ["17f", "Additional tax on Medicare Advantage MSA distributions", "other_taxes"],
  ["17g", "Recapture of a charitable contribution deduction (fractional interest)", "other_taxes"],
  ["17h", "Income from a nonqualified deferred compensation plan that fails section 409A", "other_taxes"],
  ["17i", "Compensation from a nonqualified deferred compensation plan described in section 457A", "other_taxes"],
  ["17j", "Section 72(m)(5) excess benefits tax", "other_taxes"],
  ["17k", "Golden parachute payments", "other_taxes"],
  ["17l", "Tax on accumulation distribution of trusts", "other_taxes"],
  ["17m", "Excise tax on insider stock compensation from an expatriated corporation", "other_taxes"],
  ["17n", "Look-back interest under section 167(g) or 460(b)", "other_taxes"],
  ["17o", "Tax on non-effectively connected income of a nonresident alien", "other_taxes"],
  ["17p", "Interest from Form 8621, line 16f", "other_taxes"],
  ["17q", "Interest from Form 8621, line 24", "other_taxes"],
  ["17z", "Any other taxes", "other_taxes"],
  ["18", "Total additional taxes (lines 17a through 17z)"],
  ["19", "Recapture of net EPE from Form 4255, line 1d", "other_taxes"],
  ["20", "Section 965 net tax liability installment", "other_taxes"],
  ["21", "Total other taxes (to Form 1040 line 23)"],
] as const satisfies readonly Row[];

// ── Schedule 3 ────────────────────────────────────────────────────────────────

const SCH3 = [
  ["1", "Foreign tax credit"],
  ["2", "Credit for child and dependent care expenses (Form 2441)", "other_nonrefundable_credits"],
  ["3", "Education credits (Form 8863)", "other_nonrefundable_credits"],
  ["4", "Retirement savings contributions credit (Form 8880)"],
  ["5a", "Residential clean energy credit (Form 5695, line 15)", "solar_credit"],
  ["5b", "Energy efficient home improvement credit (Form 5695, line 32)", "other_nonrefundable_credits"],
  ["6a", "General business credit (Form 3800)", "other_nonrefundable_credits"],
  ["6b", "Credit for prior year minimum tax (Form 8801)", "other_nonrefundable_credits"],
  ["6c", "Adoption credit (Form 8839)", "other_nonrefundable_credits"],
  ["6d", "Credit for the elderly or disabled (Schedule R)", "other_nonrefundable_credits"],
  ["6f", "Clean vehicle credit (Form 8936)", "other_nonrefundable_credits"],
  ["6g", "Mortgage interest credit (Form 8396)", "other_nonrefundable_credits"],
  ["6h", "District of Columbia first-time homebuyer credit (Form 8859)", "other_nonrefundable_credits"],
  ["6i", "Qualified electric vehicle credit (Form 8834)", "other_nonrefundable_credits"],
  ["6j", "Alternative fuel vehicle refueling property credit (Form 8911)", "other_nonrefundable_credits"],
  ["6k", "Credit to holders of tax credit bonds (Form 8912)", "other_nonrefundable_credits"],
  ["6l", "Amount on Form 8978, line 14", "other_nonrefundable_credits"],
  ["6m", "Credit for previously owned clean vehicles (Form 8936)", "other_nonrefundable_credits"],
  ["6z", "Other nonrefundable credits", "other_nonrefundable_credits"],
  ["7", "Total other nonrefundable credits (lines 6a through 6z)"],
  ["8", "Total nonrefundable credits (to Form 1040 line 20)"],
  ["9", "Net premium tax credit (Form 8962)", "other_refundable_credits"],
  ["10", "Amount paid with request for extension to file"],
  ["11", "Excess social security and tier 1 RRTA tax withheld"],
  ["12", "Credit for federal tax on fuels (Form 4136)", "other_refundable_credits"],
  ["13a", "Form 2439", "other_refundable_credits"],
  ["13b", "Section 1341 credit for repayment of amounts included in income", "other_refundable_credits"],
  ["13c", "Net elective payment election amount from Form 3800", "other_refundable_credits"],
  ["13d", "Deferred amount of net 965 tax liability", "other_refundable_credits"],
  ["13z", "Other payments or refundable credits", "other_refundable_credits"],
  ["14", "Total other payments or refundable credits (lines 13a through 13z)"],
  ["15", "Total other payments and refundable credits (to Form 1040 line 31)"],
] as const satisfies readonly Row[];

// ── Schedule A ────────────────────────────────────────────────────────────────

const SCHA = [
  ["1", "Medical and dental expenses", "medical_expenses"],
  ["2", "Amount from Form 1040 line 11b"],
  ["3", "Medical floor (percentage of line 2)", "medical_expenses"],
  ["4", "Medical and dental expenses after the floor", "medical_expenses"],
  ["5a", "State and local income taxes (or general sales taxes)"],
  ["5b", "State and local real estate taxes"],
  ["5c", "State and local personal property taxes"],
  ["5d", "Total state and local taxes (lines 5a through 5c)"],
  ["5e", "State and local tax deduction after the cap"],
  ["6", "Other taxes", "sch_a_other"],
  ["7", "Total taxes you paid (lines 5e and 6)"],
  ["8a", "Home mortgage interest and points reported on Form 1098"],
  ["8b", "Home mortgage interest not reported on Form 1098", "sch_a_other"],
  ["8c", "Points not reported on Form 1098", "sch_a_other"],
  ["8e", "Total home mortgage interest (lines 8a through 8c)"],
  ["9", "Investment interest", "sch_a_other"],
  ["10", "Total interest you paid (lines 8e and 9)"],
  ["11", "Gifts by cash or check"],
  ["12", "Gifts other than by cash or check"],
  ["13", "Carryover from prior year", "sch_a_other"],
  ["14", "Total gifts to charity (lines 11 through 13)"],
  ["15", "Casualty and theft losses", "sch_a_other"],
  ["16", "Other itemized deductions", "sch_a_other"],
  ["17", "Total itemized deductions"],
] as const satisfies readonly Row[];

// ── Schedule B (the payer rows are a table, not LineKeys) ────────────────────

const SCHB = [
  ["2", "Total interest (sum of the Part I payer rows)"],
  ["3", "Excludable interest on series EE and I savings bonds (Form 8815)", "savings_bond_exclusion"],
  ["4", "Taxable interest (to Form 1040 line 2b)"],
  ["6", "Total ordinary dividends (to Form 1040 line 3b)"],
] as const satisfies readonly Row[];

// ── Schedule C ────────────────────────────────────────────────────────────────

const SCHC = [
  ["1", "Gross receipts or sales"],
  ["2", "Returns and allowances"],
  ["3", "Gross receipts minus returns and allowances"],
  ["4", "Cost of goods sold (from line 42)"],
  ["5", "Gross profit"],
  ["6", "Other income"],
  ["7", "Gross income"],
  ["8", "Advertising"],
  ["9", "Car and truck expenses"],
  ["10", "Commissions and fees"],
  ["11", "Contract labor"],
  ["12", "Depletion", "sch_c_other_lines"],
  ["13", "Depreciation and section 179 expense deduction"],
  ["14", "Employee benefit programs"],
  ["15", "Insurance (other than health)"],
  ["16a", "Interest: mortgage"],
  ["16b", "Interest: other"],
  ["17", "Legal and professional services"],
  ["18", "Office expense"],
  ["19", "Pension and profit-sharing plans"],
  ["20a", "Rent or lease: vehicles, machinery and equipment"],
  ["20b", "Rent or lease: other business property"],
  ["21", "Repairs and maintenance"],
  ["22", "Supplies"],
  ["23", "Taxes and licenses"],
  ["24a", "Travel"],
  ["24b", "Deductible meals"],
  ["25", "Utilities"],
  ["26", "Wages"],
  ["27a", "Energy efficient commercial buildings deduction", "sch_c_other_lines"],
  ["27b", "Other expenses (from line 48)"],
  ["28", "Total expenses before business use of home"],
  ["29", "Tentative profit or (loss)"],
  ["30", "Expenses for business use of your home"],
  ["31", "Net profit or (loss)"],
  ["35", "Inventory at beginning of year"],
  ["36", "Purchases less cost of items withdrawn for personal use"],
  ["37", "Cost of labor"],
  ["38", "Materials and supplies"],
  ["39", "Other costs"],
  ["40", "Total of lines 35 through 39"],
  ["41", "Inventory at end of year"],
  ["42", "Cost of goods sold"],
  ["48", "Total other expenses"],
] as const satisfies readonly Row[];

// ── Schedule SE ───────────────────────────────────────────────────────────────

const SE = [
  ["1a", "Net farm profit or (loss)", "se_other"],
  ["1b", "Social security retirement or disability benefits exclusion", "se_other"],
  ["2", "Net profit or (loss) from Schedule C"],
  ["3", "Combined net profit (lines 1a, 1b and 2)"],
  ["4a", "Net earnings (92.35% of line 3)"],
  ["4b", "Optional methods", "se_other"],
  ["4c", "Net earnings from self-employment"],
  ["5a", "Church employee income", "se_other"],
  ["5b", "Church employee income x 92.35%", "se_other"],
  ["6", "Net earnings subject to SE tax"],
  ["7", "Maximum earnings subject to social security tax"],
  ["8a", "Social security wages and tips (W-2 boxes 3 and 7)"],
  ["8b", "Unreported tips subject to social security tax (Form 4137)", "se_other"],
  ["8c", "Wages subject to social security tax (Form 8919)", "se_other"],
  ["8d", "Total social security wages and tips"],
  ["9", "Remaining social security wage base"],
  ["10", "Social security part (12.4%)"],
  ["11", "Medicare part (2.9%)"],
  ["12", "Self-employment tax"],
  ["13", "Deduction for one-half of self-employment tax"],
  ["14", "Maximum income for optional methods", "se_other"],
  ["15", "Farm optional method amount", "se_other"],
  ["16", "Nonfarm optional method base", "se_other"],
  ["17", "Nonfarm optional method amount", "se_other"],
] as const satisfies readonly Row[];

// ── Form 8995 ─────────────────────────────────────────────────────────────────

const F8995 = [
  ["1i", "Qualified business income or (loss), trade or business i (column c)"],
  ["2", "Total qualified business income or (loss)"],
  ["3", "Prior-year qualified business net (loss) carryforward", "qbi_carryforwards"],
  ["4", "Total qualified business income"],
  ["5", "Qualified business income component (20%)"],
  ["6", "Qualified REIT dividends and PTP income"],
  ["7", "Prior-year qualified REIT / PTP (loss) carryforward", "qbi_carryforwards"],
  ["8", "Total qualified REIT dividends and PTP income"],
  ["9", "REIT and PTP component (20%)"],
  ["10", "Qualified business income deduction before the income limitation"],
  ["11", "Taxable income before the qualified business income deduction"],
  ["12", "Net capital gain plus qualified dividends"],
  ["13", "Taxable income minus net capital gain"],
  ["14", "Income limitation (20% of line 13)"],
  ["15", "Qualified business income deduction"],
  ["16", "Total qualified business (loss) carryforward", "qbi_carryforwards"],
  ["17", "Total qualified REIT / PTP (loss) carryforward", "qbi_carryforwards"],
] as const satisfies readonly Row[];

// ── Form 8959 ─────────────────────────────────────────────────────────────────

const F8959 = [
  ["1", "Medicare wages and tips (W-2 box 5)"],
  ["2", "Unreported tips (Form 4137)", "se_other"],
  ["3", "Wages from Form 8919", "se_other"],
  ["4", "Total Medicare wages and tips"],
  ["5", "Filing status threshold"],
  ["6", "Excess over the threshold"],
  ["7", "Additional Medicare Tax on Medicare wages"],
  ["8", "Self-employment income"],
  ["9", "Filing status threshold"],
  ["10", "Amount from line 4"],
  ["11", "Threshold remaining after wages"],
  ["12", "Self-employment income over the remaining threshold"],
  ["13", "Additional Medicare Tax on self-employment income"],
  ["14", "Railroad retirement (RRTA) compensation", "se_other"],
  ["15", "Filing status threshold", "se_other"],
  ["16", "RRTA compensation over the threshold", "se_other"],
  ["17", "Additional Medicare Tax on RRTA compensation", "se_other"],
  ["18", "Total Additional Medicare Tax"],
  ["19", "Medicare tax withheld (W-2 box 6)"],
  ["20", "Medicare wages and tips (from line 1)"],
  ["21", "Regular Medicare tax withholding (1.45% of line 20)"],
  ["22", "Additional Medicare Tax withheld"],
  ["23", "Additional Medicare Tax withheld on RRTA compensation", "se_other"],
  ["24", "Total Additional Medicare Tax withholding"],
] as const satisfies readonly Row[];

// ── Schedule D (2025) ─────────────────────────────────────────────────────────
//
// Keys for the cells of the eight transaction lines are `<line>.<column>`: d = proceeds, e = cost or other basis, g = adjustments
// (Form 8949 column (g) total), h = gain or (loss). Lines 1a and 8a have no (g) key: the form's own text sends adjustments to Form 8949, so
// the direct-entry rows never carry one. The printed `formLine` is the line number alone (the column is in the label).
// Lines 6, 14 and 21 are stored as the MAGNITUDE the form prints between its pre-printed parentheses (the engine math uses negatives);
// lines 7, 15 and 16 and every cell are signed. Lines 17, 20 and 22 are yes / no boxes, not money lines (see ScheduleDDetail).
// Source: the 2025 Schedule D (Form 1040), Created 10/6/25.

const SCHD = [
  ["1a.d", "Short-term, basis reported to the IRS and no adjustments: proceeds (column d)"],
  ["1a.e", "Short-term, basis reported to the IRS and no adjustments: cost or other basis (column e)"],
  ["1a.h", "Short-term, basis reported to the IRS and no adjustments: gain or (loss) (column h)"],
  ["1b.d", "Short-term, Form 8949 box A or G: proceeds (column d)"],
  ["1b.e", "Short-term, Form 8949 box A or G: cost or other basis (column e)"],
  ["1b.g", "Short-term, Form 8949 box A or G: adjustments (column g)"],
  ["1b.h", "Short-term, Form 8949 box A or G: gain or (loss) (column h)"],
  ["2.d", "Short-term, Form 8949 box B or H: proceeds (column d)"],
  ["2.e", "Short-term, Form 8949 box B or H: cost or other basis (column e)"],
  ["2.g", "Short-term, Form 8949 box B or H: adjustments (column g)"],
  ["2.h", "Short-term, Form 8949 box B or H: gain or (loss) (column h)"],
  ["3.d", "Short-term, Form 8949 box C or I: proceeds (column d)"],
  ["3.e", "Short-term, Form 8949 box C or I: cost or other basis (column e)"],
  ["3.g", "Short-term, Form 8949 box C or I: adjustments (column g)"],
  ["3.h", "Short-term, Form 8949 box C or I: gain or (loss) (column h)"],
  ["4", "Short-term gain from Form 6252 and short-term gain or (loss) from Forms 4684, 6781 and 8824", "capital_gain_other"],
  ["5", "Net short-term gain or (loss) from partnerships, S corporations, estates and trusts (Schedule K-1)", "capital_gain_other"],
  ["6", "Short-term capital loss carryover (the positive amount; the form prints it in parentheses)"],
  ["7", "Net short-term capital gain or (loss)"],
  ["8a.d", "Long-term, basis reported to the IRS and no adjustments: proceeds (column d)"],
  ["8a.e", "Long-term, basis reported to the IRS and no adjustments: cost or other basis (column e)"],
  ["8a.h", "Long-term, basis reported to the IRS and no adjustments: gain or (loss) (column h)"],
  ["8b.d", "Long-term, Form 8949 box D or J: proceeds (column d)"],
  ["8b.e", "Long-term, Form 8949 box D or J: cost or other basis (column e)"],
  ["8b.g", "Long-term, Form 8949 box D or J: adjustments (column g)"],
  ["8b.h", "Long-term, Form 8949 box D or J: gain or (loss) (column h)"],
  ["9.d", "Long-term, Form 8949 box E or K: proceeds (column d)"],
  ["9.e", "Long-term, Form 8949 box E or K: cost or other basis (column e)"],
  ["9.g", "Long-term, Form 8949 box E or K: adjustments (column g)"],
  ["9.h", "Long-term, Form 8949 box E or K: gain or (loss) (column h)"],
  ["10.d", "Long-term, Form 8949 box F or L: proceeds (column d)"],
  ["10.e", "Long-term, Form 8949 box F or L: cost or other basis (column e)"],
  ["10.g", "Long-term, Form 8949 box F or L: adjustments (column g)"],
  ["10.h", "Long-term, Form 8949 box F or L: gain or (loss) (column h)"],
  ["11", "Gain from Form 4797 Part I; long-term gain from Forms 2439 and 6252; long-term gain or (loss) from Forms 4684, 6781 and 8824", "capital_gain_other"],
  ["12", "Net long-term gain or (loss) from partnerships, S corporations, estates and trusts (Schedule K-1)", "capital_gain_other"],
  ["13", "Capital gain distributions (Form 1099-DIV box 2a)"],
  ["14", "Long-term capital loss carryover (the positive amount; the form prints it in parentheses)"],
  ["15", "Net long-term capital gain or (loss)"],
  ["16", "Combine lines 7 and 15"],
  ["18", "28% Rate Gain Worksheet, line 7", "capital_special_rates"],
  ["19", "Unrecaptured Section 1250 Gain Worksheet, line 18", "capital_special_rates"],
  ["21", "Capital loss deduction: the smaller of the loss on line 16 or $3,000 (the positive amount; the form prints it in parentheses)"],
] as const satisfies readonly Row[];

// ── Extra lines (worksheets, screens, Connecticut) ───────────────────────────

type ExtraRow = readonly [key: string, form: string, formLine: string, label: string];

const EXTRA = [
  ["qdcg.25", "Form 1040 worksheet", "25", "Qualified Dividends and Capital Gain Tax Worksheet, line 25"],
  // The worksheet's line 3 is NOT 1040 line 7a: with Schedule D it is the smaller of Schedule D line 15 or 16 (0 if either is a loss or blank)
  ["qdcg.3", "Form 1040 worksheet", "3", "Qualified Dividends and Capital Gain Tax Worksheet, line 3 (smaller of Schedule D line 15 or 16, not below 0)"],
  ["f6251.amti", "Form 6251", "4", "Alternative minimum taxable income"],
  ["f6251.tmt", "Form 6251", "10", "Tentative minimum tax"],
  ["f6251.amt", "Form 6251", "11", "Alternative minimum tax"],
  // Phase 1b: the standard deduction with the age 65 / blind boxes (Form 1040 line 12d); the total is the standard amount for line 12e
  ["std.additional", "Standard deduction chart", "12d", "Additional standard deduction (born before January 2, 1961 or blind, per box)"],
  ["std.total", "Standard deduction chart", "12e", "Standard deduction (base plus the line 12d additions)"],
  // Phase 1b: Schedule 1-A (line 38 goes to Form 1040 line 13b)
  // Every printed money line of the 2025 Schedule 1-A has a key except 2a-2e (excluded income, owner-stated "none") and line 22 (VINs and
  // per-loan interest: never stored by this app). Parts that are not used emit not_applicable for all their lines.
  ["sch1a.1", "Schedule 1-A", "1", "Amount from Form 1040 line 11b"],
  ["sch1a.3", "Schedule 1-A", "3", "Modified adjusted gross income (Part I)"],
  ["sch1a.4a", "Schedule 1-A", "4a", "Qualified tips included on Form W-2, box 7"],
  ["sch1a.4b", "Schedule 1-A", "4b", "Qualified tips included on Form 4137, line 1, row A, column (c)"],
  ["sch1a.4c", "Schedule 1-A", "4c", "Qualified tips received as an employee"],
  ["sch1a.5", "Schedule 1-A", "5", "Qualified tips received in the course of a trade or business"],
  ["sch1a.6", "Schedule 1-A", "6", "Qualified tips (lines 4c and 5)"],
  ["sch1a.7", "Schedule 1-A", "7", "Qualified tips, smaller of line 6 or the maximum"],
  ["sch1a.8", "Schedule 1-A", "8", "Amount from line 3 (tips)"],
  ["sch1a.9", "Schedule 1-A", "9", "MAGI threshold for the tips deduction"],
  ["sch1a.10", "Schedule 1-A", "10", "Line 8 minus line 9 (tips)"],
  ["sch1a.11", "Schedule 1-A", "11", "Line 10 divided by $1,000, rounded down (tips)"],
  ["sch1a.12", "Schedule 1-A", "12", "Line 11 times $100 (tips)"],
  ["sch1a.13", "Schedule 1-A", "13", "Qualified tips deduction"],
  ["sch1a.14a", "Schedule 1-A", "14a", "Qualified overtime compensation included in Form W-2, box 1"],
  ["sch1a.14b", "Schedule 1-A", "14b", "Qualified overtime compensation included in Form 1099-NEC or 1099-MISC"],
  ["sch1a.14c", "Schedule 1-A", "14c", "Qualified overtime compensation (lines 14a and 14b)"],
  ["sch1a.15", "Schedule 1-A", "15", "Qualified overtime, smaller of line 14c or the maximum"],
  ["sch1a.16", "Schedule 1-A", "16", "Amount from line 3 (overtime)"],
  ["sch1a.17", "Schedule 1-A", "17", "MAGI threshold for the overtime deduction"],
  ["sch1a.18", "Schedule 1-A", "18", "Line 16 minus line 17 (overtime)"],
  ["sch1a.19", "Schedule 1-A", "19", "Line 18 divided by $1,000, rounded down (overtime)"],
  ["sch1a.20", "Schedule 1-A", "20", "Line 19 times $100 (overtime)"],
  ["sch1a.21", "Schedule 1-A", "21", "Qualified overtime compensation deduction"],
  ["sch1a.23", "Schedule 1-A", "23", "Qualified passenger vehicle loan interest (column iii total)"],
  ["sch1a.24", "Schedule 1-A", "24", "Car-loan interest, smaller of line 23 or the maximum"],
  ["sch1a.25", "Schedule 1-A", "25", "Amount from line 3 (car-loan interest)"],
  ["sch1a.26", "Schedule 1-A", "26", "MAGI threshold for the car-loan interest deduction"],
  ["sch1a.27", "Schedule 1-A", "27", "Line 25 minus line 26 (car-loan interest)"],
  ["sch1a.28", "Schedule 1-A", "28", "Line 27 divided by $1,000, rounded up (car-loan interest)"],
  ["sch1a.29", "Schedule 1-A", "29", "Line 28 times $200 (car-loan interest)"],
  ["sch1a.30", "Schedule 1-A", "30", "Qualified passenger vehicle loan interest deduction"],
  ["sch1a.31", "Schedule 1-A", "31", "Amount from line 3 (seniors)"],
  ["sch1a.32", "Schedule 1-A", "32", "MAGI threshold for the enhanced deduction for seniors"],
  ["sch1a.33", "Schedule 1-A", "33", "Line 31 minus line 32 (seniors)"],
  ["sch1a.34", "Schedule 1-A", "34", "Line 33 times 6% (seniors)"],
  ["sch1a.35", "Schedule 1-A", "35", "Seniors amount per person ($6,000 minus line 34)"],
  ["sch1a.36a", "Schedule 1-A", "36a", "Enhanced deduction for seniors, taxpayer A"],
  ["sch1a.36b", "Schedule 1-A", "36b", "Enhanced deduction for seniors, taxpayer B"],
  ["sch1a.37", "Schedule 1-A", "37", "Enhanced deduction for seniors"],
  ["sch1a.38", "Schedule 1-A", "38", "Total additional deductions (to Form 1040 line 13b)"],
  // Phase 1b: Form 8889, one form per spouse (a = first person in the Return completeness questionnaire, b = second)
  ["f8889a.2", "Form 8889 (spouse A)", "2", "HSA contributions made by or for spouse A"],
  ["f8889a.3", "Form 8889 (spouse A)", "3", "Contribution limit before reductions (spouse A)"],
  ["f8889a.8", "Form 8889 (spouse A)", "8", "Limit including the additional contribution amount (spouse A)"],
  ["f8889a.9", "Form 8889 (spouse A)", "9", "Employer contributions (spouse A)"],
  ["f8889a.12", "Form 8889 (spouse A)", "12", "Limit after employer contributions (spouse A)"],
  ["f8889a.13", "Form 8889 (spouse A)", "13", "HSA deduction (spouse A)"],
  ["f8889b.2", "Form 8889 (spouse B)", "2", "HSA contributions made by or for spouse B"],
  ["f8889b.3", "Form 8889 (spouse B)", "3", "Contribution limit before reductions (spouse B)"],
  ["f8889b.8", "Form 8889 (spouse B)", "8", "Limit including the additional contribution amount (spouse B)"],
  ["f8889b.9", "Form 8889 (spouse B)", "9", "Employer contributions (spouse B)"],
  ["f8889b.12", "Form 8889 (spouse B)", "12", "Limit after employer contributions (spouse B)"],
  ["f8889b.13", "Form 8889 (spouse B)", "13", "HSA deduction (spouse B)"],
  // Phase 1b: IRA deduction (Pub. 590-A Worksheets 1-1 and 1-2; the total goes to Schedule 1 line 20)
  ["ira.magi", "IRA worksheet", "1-1 line 7", "Modified AGI for the traditional IRA deduction"],
  ["ira.a.7", "IRA worksheet", "1-2 line 7 (A)", "IRA deduction, taxpayer A"],
  ["ira.b.7", "IRA worksheet", "1-2 line 7 (B)", "IRA deduction, taxpayer B"],
  // Phase 1b: Form 8880 (saver's credit; line 12 goes to Schedule 3 line 4)
  ["f8880.7", "Form 8880", "7", "Qualified contributions after the $2,000 cap per person"],
  ["f8880.8", "Form 8880", "8", "Adjusted gross income (Form 1040 line 11a)"],
  ["f8880.10", "Form 8880", "10", "Contributions times the applicable decimal"],
  ["f8880.11", "Form 8880", "11", "Limitation based on tax liability"],
  ["f8880.12", "Form 8880", "12", "Credit for qualified retirement savings contributions"],
  // Phase 1b: Form 2210 regular-method ESTIMATE (informational; the IRS figures the penalty itself)
  ["f2210.4", "Form 2210", "4", "Current year tax"],
  ["f2210.5", "Form 2210", "5", "90% of the current year tax"],
  ["f2210.6", "Form 2210", "6", "Withholding taxes"],
  ["f2210.7", "Form 2210", "7", "Current year tax minus withholding"],
  ["f2210.8", "Form 2210", "8", "Maximum required annual payment based on the prior year's tax"],
  ["f2210.9", "Form 2210", "9", "Required annual payment"],
  ["f2210.19", "Form 2210", "19", "Estimated penalty (regular method estimate)"],
  ["f8960.nii", "Form 8960", "12", "Net investment income"],
  ["f8960.niit", "Form 8960", "17", "Net investment income tax"],
  ["ct1040.1", "CT-1040", "1", "Federal adjusted gross income (1040 line 11a)"],
  // CT-1040 Schedule 1 detail lines (rules/ct-schedule1.ts owns them; none carries a `group`). The totals below are line 38 / line 50.
  ["ct1040.s1.31", "CT-1040", "Sch 1 line 31", "Interest on state and local government obligations other than Connecticut"],
  ["ct1040.s1.32", "CT-1040", "Sch 1 line 32", "Mutual fund exempt-interest dividends from non-Connecticut state or municipal obligations"],
  ["ct1040.s1.33", "CT-1040", "Sch 1 line 33", "Taxable amount of lump-sum distributions from qualified plans not included in federal AGI"],
  ["ct1040.s1.34", "CT-1040", "Sch 1 line 34", "Beneficiary's share of Connecticut fiduciary adjustment (greater than zero)"],
  ["ct1040.s1.35", "CT-1040", "Sch 1 line 35", "Loss on sale of Connecticut state and local government bonds"],
  ["ct1040.s1.36", "CT-1040", "Sch 1 line 36", "Section 168(k) federal bonus depreciation deduction"],
  ["ct1040.s1.36a", "CT-1040", "Sch 1 line 36a", "80% of Section 179 federal deduction"],
  ["ct1040.s1.37", "CT-1040", "Sch 1 line 37", "Other additions"],
  ["ct1040.additions", "CT-1040", "Sch 1", "CT Schedule 1 additions"],
  ["ct1040.3", "CT-1040", "3", "Federal AGI plus Schedule 1 additions (lines 1 and 2)"],
  ["ct1040.s1.39", "CT-1040", "Sch 1 line 39", "Interest on U.S. government obligations"],
  ["ct1040.s1.40", "CT-1040", "Sch 1 line 40", "Exempt dividends from qualifying mutual funds derived from U.S. government obligations"],
  ["ct1040.s1.41", "CT-1040", "Sch 1 line 41", "Social Security benefit adjustment"],
  ["ct1040.s1.42", "CT-1040", "Sch 1 line 42", "Refunds of state and local income taxes"],
  ["ct1040.s1.43", "CT-1040", "Sch 1 line 43", "Tier 1 and Tier 2 railroad retirement benefits and supplemental annuities"],
  ["ct1040.s1.44", "CT-1040", "Sch 1 line 44", "Military retirement pay"],
  ["ct1040.s1.45", "CT-1040", "Sch 1 line 45", "50% of income received from the Connecticut Teachers' Retirement System"],
  ["ct1040.s1.46", "CT-1040", "Sch 1 line 46", "Beneficiary's share of Connecticut fiduciary adjustment (less than zero)"],
  ["ct1040.s1.47", "CT-1040", "Sch 1 line 47", "Gain on sale of Connecticut state and local government bonds"],
  ["ct1040.s1.48", "CT-1040", "Sch 1 line 48", "Connecticut Higher Education Trust (CHET) contributions"],
  ["ct1040.s1.48a", "CT-1040", "Sch 1 line 48a", "25% of Section 168(k) bonus depreciation added back in preceding four years"],
  ["ct1040.s1.48b", "CT-1040", "Sch 1 line 48b", "Pension or annuity income"],
  ["ct1040.s1.48c", "CT-1040", "Sch 1 line 48c", "Business expenses of a Chapter 420f or 420h licensee"],
  ["ct1040.s1.48d", "CT-1040", "Sch 1 line 48d", "Achieving a Better Life Experience (ABLE) contributions"],
  ["ct1040.s1.49", "CT-1040", "Sch 1 line 49", "Other subtractions"],
  ["ct1040.subtractions", "CT-1040", "Sch 1", "CT Schedule 1 subtractions"],
  ["ct1040.ctAgi", "CT-1040", "CT AGI", "Connecticut adjusted gross income"],
  ["ct1040.6", "CT-1040", "6", "Connecticut income tax"],
  ["ct1040.7", "CT-1040", "7", "Credit for income taxes paid to qualifying jurisdictions (Schedule 2 line 59)"],
  ["ct1040.8", "CT-1040", "8", "Connecticut income tax after the credit for taxes paid to other jurisdictions (line 6 less line 7)"],
  ["ct1040.9", "CT-1040", "9", "Connecticut alternative minimum tax"],
  ["ct1040.10", "CT-1040", "10", "Connecticut income tax before credits"],
  ["ct1040.11", "CT-1040", "11", "Property tax credit"],
  ["ct1040.12", "CT-1040", "12", "Connecticut income tax after the property tax credit (line 10 less line 11)"],
  ["ct1040.13", "CT-1040", "13", "Allowable credits (Schedule CT-IT Credit, Part 1 line 10)"],
  ["ct1040.14", "CT-1040", "14", "Connecticut income tax (line 12 less line 13)"],
  ["ct1040.15", "CT-1040", "15", "Use tax (out-of-state purchases)"],
  ["ct1040.16", "CT-1040", "16", "Connecticut income tax and use tax (lines 14 and 15)"],
  ["ct1040.17", "CT-1040", "17", "Total tax (amount from line 16)"],
  ["ct1040.18", "CT-1040", "18", "Connecticut income tax withheld"],
  ["ct1040.19", "CT-1040", "19", "2025 estimated payments and 2024 overpayment applied"],
  ["ct1040.20", "CT-1040", "20", "Payment made with Form CT-1040 EXT"],
  ["ct1040.20a", "CT-1040", "20a", "Connecticut earned income tax credit (Schedule CT-EITC line 16)"],
  ["ct1040.20b", "CT-1040", "20b", "Claim of right credit (Form CT-1040 CRC line 6)"],
  ["ct1040.20c", "CT-1040", "20c", "Pass-through entity tax credit (Schedule CT-PE line 1)"],
  ["ct1040.20d", "CT-1040", "20d", "Historic home credit"],
  ["ct1040.21", "CT-1040", "21", "Total payments and refundable credits (lines 18 through 20d)"],
  ["ct1040.22", "CT-1040", "22", "Overpayment (line 21 more than line 17)"],
  ["ct1040.25", "CT-1040", "25", "Refund (line 22 less lines 23, 24 and 24a)"],
  ["ct1040.26", "CT-1040", "26", "Tax due (line 17 more than line 21)"],
  ["ct1040.27", "CT-1040", "27", "Late payment penalty"],
  ["ct1040.28", "CT-1040", "28", "Interest"],
  ["ct1040.29", "CT-1040", "29", "Interest on underpayment of estimated tax (Form CT-2210)"],
  ["ct1040.30", "CT-1040", "30", "Total amount due (lines 26 through 29)"],
  ["ct1040.s3.63", "CT-1040", "Sch 3 line 63", "Property tax credit: total property tax paid (lines 60 through 62)"],
  ["ct1040.s3.65", "CT-1040", "Sch 3 line 65", "Property tax credit: lesser of line 63 or line 64"],
  ["ct1040.s3.67", "CT-1040", "Sch 3 line 67", "Property tax credit: line 65 times the line 66 decimal"],
  ["ct1040.s4.69b", "CT-1040", "Sch 4 line 69b", "Use tax at the 6.35% general rate"],
  ["ct1040.balance", "CT-1040", "balance", "Connecticut balance due or overpayment"],
] as const satisfies readonly ExtraRow[];

// ── Derived key type ──────────────────────────────────────────────────────────

type KeysOf<P extends string, R extends readonly Row[]> = `${P}.${R[number][0]}`;

export type LineKey =
  | KeysOf<"f1040", typeof F1040>
  | KeysOf<"sch1", typeof SCH1>
  | KeysOf<"sch2", typeof SCH2>
  | KeysOf<"sch3", typeof SCH3>
  | KeysOf<"scha", typeof SCHA>
  | KeysOf<"schb", typeof SCHB>
  | KeysOf<"schc", typeof SCHC>
  | KeysOf<"se", typeof SE>
  | KeysOf<"f8995", typeof F8995>
  | KeysOf<"f8959", typeof F8959>
  | KeysOf<"schd", typeof SCHD>
  | (typeof EXTRA)[number][0];

export interface LineMeta {
  key: LineKey;
  form: string;
  formLine: string;
  label: string;
  /** When no rule fills this line, a stated "none" for this group makes it not_applicable 0. */
  group?: NoneGroupId;
}

function expand(prefix: string, form: string, rows: readonly Row[]): LineMeta[] {
  return rows.map((r) => {
    const meta: LineMeta = { key: `${prefix}.${r[0]}` as LineKey, form, formLine: r[0], label: r[1] };
    if (r[2] !== undefined) meta.group = r[2];
    return meta;
  });
}

export const LINE_CATALOG: readonly LineMeta[] = [
  ...expand("f1040", "Form 1040", F1040),
  ...expand("sch1", "Schedule 1", SCH1),
  ...expand("sch2", "Schedule 2", SCH2),
  ...expand("sch3", "Schedule 3", SCH3),
  ...expand("scha", "Schedule A", SCHA),
  ...expand("schb", "Schedule B", SCHB),
  ...expand("schc", "Schedule C", SCHC),
  ...expand("se", "Schedule SE", SE),
  ...expand("f8995", "Form 8995", F8995),
  ...expand("f8959", "Form 8959", F8959),
  // Schedule D: a cell key is "<line>.<column>"; the printed line id is the part before the dot
  ...expand("schd", "Schedule D", SCHD).map((m): LineMeta => ({ ...m, formLine: m.formLine.split(".")[0] ?? m.formLine })),
  ...EXTRA.map((e): LineMeta => ({ key: e[0] as LineKey, form: e[1], formLine: e[2], label: e[3] })),
];

export const LINE_KEYS: readonly LineKey[] = LINE_CATALOG.map((m) => m.key);

const META_BY_KEY: ReadonlyMap<string, LineMeta> = new Map(LINE_CATALOG.map((m) => [m.key, m]));

export function lineMeta(key: LineKey): LineMeta {
  const meta = META_BY_KEY.get(key);
  if (!meta) throw new Error(`Unknown line key ${key}`);
  return meta;
}

/** Schedule C line ids that carry an amount (the GL map targets the 8-27b expense lines and the income lines). */
export const SCHEDULE_C_LINE_IDS = SCHC.map((r) => r[0]);
export type ScheduleCLineId = (typeof SCHC)[number][0];
export type ScheduleCLineKey = `schc.${ScheduleCLineId}`;

export function scheduleCLineKey(id: ScheduleCLineId): ScheduleCLineKey {
  return `schc.${id}`;
}
