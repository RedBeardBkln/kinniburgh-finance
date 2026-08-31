// Pure tax-planning logic — client-safe. No SDK/DB imports.
//
// Design intent (owner directive): the tax preparer's objective is to maximize
// the federal and state refund and avoid owing additional tax at filing —
// through every DEDUCTION, CREDIT, and election the tax law legitimately allows.
// Opportunities are graded conservatively; anything aggressive is labeled with
// its honest legal risk rather than presented as safe. The system drafts and
// advises; it never fabricates facts. Outputs are prep material for the CPA.

// ── Question bank ─────────────────────────────────────────────────────────────

export interface QuestionOption {
  value: string;
  label: string;
  /** Honest note: financial + legal implications of this choice */
  note: string;
}

export interface TaxQuestionDef {
  key: string;
  category: "filing_status" | "income" | "deductions" | "credits" | "entity" | "other";
  question: string;
  /** Plain-language context so the user understands what is being asked and why */
  context: string;
  options?: QuestionOption[];
  placeholder?: string;
  /** Which opportunity keys this answer unlocks or informs */
  unlocks: string[];
}

export const TAX_QUESTION_BANK: TaxQuestionDef[] = [
  {
    key: "filing_status",
    category: "filing_status",
    question: "How will you file your 2025 federal return?",
    context:
      "Filing status sets your tax brackets, standard deduction, and eligibility for several credits. Married filing jointly is usually — but not always — the lowest-tax option for a two-earner household; filing separately can matter for income-driven student loans or large uncovered medical expenses, but it disqualifies several education credits and usually raises taxes overall.",
    options: [
      {
        value: "mfj",
        label: "Married filing jointly",
        note: "Generally the best outcome for most two-earner couples: larger standard deduction, full access to credits (child tax credit, education credits, earned income credit if eligible). Downside: both spouses are jointly liable for anything on the return.",
      },
      {
        value: "mfs",
        label: "Married filing separately",
        note: "Rarely lowers total tax. Consider only for specific situations (income-driven loan repayments, one spouse's large uninsured medical bills, or separation/liability concerns). Disqualifies education credits and the earned income credit, and halves some deduction phase-outs. The IRS treats this status more strictly on community items.",
      },
    ],
    unlocks: ["standard_vs_itemized", "child_credits"],
  },
  {
    key: "household_members",
    category: "other",
    question: "Do you have any dependents you claim (children or other relatives)?",
    context:
      "Dependents unlock the child tax credit (up to $2,000 per qualifying child), the credit for other dependents ($500), and can affect filing status (Head of Household). Claiming a dependent who doesn't qualify is one of the most common causes of IRS adjustments and penalties — the notes below describe who qualifies.",
    options: [
      {
        value: "none",
        label: "No dependents",
        note: "No dependent-related credits this year. If your situation changes (a child or an elderly parent you support), tell your CPA — a qualifying dependent can be worth $500–$2,000 in credits, and support records you keep now make the claim easy to substantiate later.",
      },
      {
        value: "children",
        label: "One or more qualifying children",
        note: "Each qualifying child under 17 at year-end may be worth up to $2,000 (child tax credit), partly refundable. The child must generally live with you over half the year and be your son, daughter, stepchild, foster child, sibling, or a descendant of one. If the other parent also qualifies, the tie-breaker rules (custody, income) decide — claiming a non-qualifying child risks repaying the credit plus penalties.",
      },
      {
        value: "other_dependents",
        label: "Other dependents (parent, relative, etc.)",
        note: "A qualifying relative dependent (e.g., a parent you support) is generally worth a $500 credit if their income is under the limit and you provide over half their support. Documentation is your burden — keep records of support you provided.",
      },
    ],
    unlocks: ["child_credits"],
  },
  {
    key: "itemized_vs_standard",
    category: "deductions",
    question: "Do you expect your itemized deductions to exceed your standard deduction?",
    context:
      "You get the standard deduction automatically (2025: ~$30,000 married-filing-jointly, ~$15,000 single — indexed figures; your CPA confirms exact numbers). Itemizing only pays when mortgage interest, state/local taxes (SALT, capped at $10,000), charitable gifts, and medical expenses over 7.5% of income add up to more. Itemizing is completely legitimate either way — you simply claim whichever is larger, never both.",
    options: [
      {
        value: "itemize",
        label: "We'll itemize (or want the platform to check)",
        note: "With your PennyMac mortgage interest (~$4,700/mo payments), property taxes on two properties, and charitable giving, itemizing is likely favorable. Keep Form 1098s and property tax receipts — the platform uses them to draft Schedule A.",
      },
      {
        value: "standard",
        label: "Take the standard deduction",
        note: "Simplest and audit-proof. You can still deduct business/rental expenses above-the-line regardless of this choice. Note: if you itemize, you cannot also take the standard deduction — but you CAN switch methods year to year as the law allows.",
      },
    ],
    unlocks: ["salt_cap", "mortgage_interest", "charitable"],
  },
  {
    key: "home_office_ekc",
    category: "deductions",
    question: "Did you use part of your home regularly and exclusively for EK Consulting business in 2025?",
    context:
      "The home office deduction (Schedule C / Form 8829 or the simplified method) is legitimate and valuable for a consulting LLC, but the space must be used regularly and EXCLUSIVELY for business — a guest room that doubles as an office does not qualify. The simplified method (~$5/sq ft up to 300 sq ft) is low-risk; actual-expense method yields more but requires allocation records.",
    options: [
      {
        value: "yes_exclusive",
        label: "Yes — I have a dedicated exclusive-use space",
        note: "You qualify. Measure the square footage; the simplified method is nearly audit-proof, while the actual method (allocating rent/mortgage interest, utilities, insurance by % of home) typically deducts more. Exclusive regular use is the requirement the IRS checks first — mixed personal use disqualifies the entire deduction, and overstating it invites penalties.",
      },
      {
        value: "yes_shared",
        label: "Yes, but the space is also used personally",
        note: "Honest answer: it does not qualify. Claiming it anyway is one of the more commonly audited Schedule C positions; if disallowed, the deduction is recaptured plus a 20% accuracy penalty. We will exclude it from your draft and look for other legitimate deductions instead.",
      },
      {
        value: "no",
        label: "No",
        note: "No home office deduction. Business expenses that don't require exclusive use (software, phone portion, supplies) remain fully deductible.",
      },
    ],
    unlocks: ["home_office"],
  },
  {
    key: "retirement_contributions",
    category: "deductions",
    question: "Did either of you contribute to a traditional IRA, 401(k), HSA, or similar pre-tax account for 2025?",
    context:
      "Pre-tax retirement contributions reduce taxable income dollar-for-dollar — the single most reliable way to lower your tax bill. Traditional IRA contributions may even be deductible even when you have a workplace plan, depending on income. HSA contributions are deductible, grow tax-free, and withdrawals for medical care are never taxed — the only triple-tax-advantaged account.",
    placeholder: "e.g. Eric 401(k) $12,000; Eva traditional IRA $3,000; HSA $4,150",
    options: undefined,
    unlocks: ["retirement_savings_credit", "ira_deduction", "hsa"],
  },
  {
    key: "solar_credit",
    category: "credits",
    question: "Was the solar system on your home placed in service during a year you haven't yet claimed the Residential Clean Energy Credit?",
    context:
      "The Residential Clean Energy Credit (25D) is 30% of solar system cost, claimed in the year the system is 'placed in service' (installed and producing). If your EnerBank-financed system qualified and you haven't claimed it, this may be the single largest credit available to you. It's a nonrefundable credit — it can zero out your federal bill but not below zero; unused credit carries forward to future years.",
    options: [
      {
        value: "yes_unclaimed",
        label: "Yes — installed and never claimed",
        note: "Strong opportunity: 30% of the system cost as a credit. If the credit exceeds your 2025 tax liability, the excess carries forward. Keep the contract, invoices, and the placed-in-service date — the IRS can ask for them.",
      },
      {
        value: "claimed_already",
        label: "Already claimed it on a prior return",
        note: "Correct to skip — the credit is one-time per system. If part of your credit was carried forward from that year, we should find the carryforward amount (look at prior year Schedule 3 / Form 5695).",
      },
      {
        value: "unsure",
        label: "Not sure",
        note: "Worth checking with your CPA — the prior return's Form 5695 shows whether a credit was claimed or carried forward. Claiming it twice is a common error with real penalties, so we verify first.",
      },
    ],
    unlocks: ["solar_credit_25d"],
  },
  {
    key: "ev_vehicle",
    category: "credits",
    question: "Did you buy a new or used plug-in EV or hybrid in 2025 (or plan to before filing)?",
    context:
      "The Clean Vehicle Credit (up to $7,500 new, up to $4,000 used) applies only to eligible models under the IRA income limits and price caps — the eligible-vehicle list changed repeatedly. It's claimed in the year of purchase and requires the vehicle to be for your own use (not resale).",
    options: [
      {
        value: "yes_new",
        label: "Yes — new EV/hybrid",
        note: "We'll verify the VIN against the IRS eligible list at purchase time and your modified AGI against the limits ($300k MFJ for new). Note the dealer may have transferred the credit at point of sale — if so it can't be claimed again.",
      },
      {
        value: "no",
        label: "No",
        note: "No vehicle credit. Your Lexus NX 350h is a hybrid without a plug — regular hybrids don't qualify.",
      },
    ],
    unlocks: ["ev_credit"],
  },
  {
    key: "estimated_taxes_2025",
    category: "other",
    question: "Did you pay federal and state estimated taxes for 2025, or increase W-2 withholding?",
    context:
      "Since your 2025 return is on extension, the balance due (if any) has been accruing interest since April 15, 2026 — the extension moves the FILING deadline, not the PAYMENT deadline. Safe-harbor: if you paid at least 100% of last year's tax (110% for high income), there's no underpayment penalty even if you owe more. Getting withholding right going forward avoids both penalties and lending the government money interest-free.",
    placeholder: "e.g. Paid Q1-Q4 estimates totaling $X; or 'none'",
    options: undefined,
    unlocks: ["safe_harbor"],
  },
  {
    key: "rental_property_use",
    category: "entity",
    question: "For the Sudden Valley rental (56 Arbor Rd): average days rented vs. personal use in 2025-2026?",
    context:
      "Rental property offers deductions for mortgage interest, property taxes, insurance, utilities, repairs, and depreciation — but only proportional to rental use. If personal use exceeded the greater of 14 days or 10% of rental days, the property is a 'residence' and deductions are limited to rental income (no loss). Honest day counts matter: overstating rental use inflates paper losses and is a known audit trigger.",
    placeholder: "e.g. ~90 rental nights, 0 personal days in 2025",
    options: undefined,
    unlocks: ["rental_depreciation", "short_term_rental_loophole"],
  },
  {
    key: "business_mileage",
    category: "deductions",
    question: "Did you drive business miles for EK Consulting or the rental business (e.g., driving to the Arbor Rd property)?",
    context:
      "Business mileage is deductible at the IRS standard rate (70¢/mile for 2025). The app's Mileage Log tracks this — commutes from home to a regular workplace are NOT deductible, but trips between work locations, to the rental property for maintenance, or for client meetings are. A contemporaneous log (like the app keeps) is exactly the documentation the IRS requires if asked.",
    options: [
      {
        value: "yes_logged",
        label: "Yes — I've been logging in the app",
        note: "We'll pull your logged entries into the workspace. The log's date/purpose/miles format matches IRS requirements.",
      },
      {
        value: "yes_not_logged",
        label: "Yes, but I haven't logged them",
        note: "Reconstruct what you honestly can (calendar entries help) and log going forward — the deduction requires your records, and reconstructed estimates are far weaker in an audit. Never round a guess into a deduction you can't support.",
      },
      {
        value: "no",
        label: "No business driving",
        note: "No mileage deduction for 2025. If that changes (a client visit, a trip to the rental property for repairs), log it in the app at the time — contemporaneous logs are exactly what the IRS accepts as substantiation.",
      },
    ],
    unlocks: ["mileage"],
  },
];

// ── Opportunity engine ───────────────────────────────────────────────────────

export type OpportunityRisk = "conservative" | "moderate" | "aggressive";

export interface TaxOpportunity {
  key: string;
  title: string;
  /** What it is and why it may apply to this household */
  explanation: string;
  /** Honest financial estimate basis */
  value: string;
  risk: OpportunityRisk;
  /** For aggressive/moderate items: the honest legal implication */
  caveat: string;
  /** Forms/schedules this flows into */
  forms: string[];
}

/**
 * The household's known facts (from specs/documents) power suggestions before
 * the user answers anything. Never fabricates amounts — only names what to check.
 */
export function baseOpportunitiesForHousehold(): TaxOpportunity[] {
  return [
    {
      key: "mortgage_interest",
      title: "Itemize mortgage interest (Form 1098 — PennyMac)",
      explanation:
        "You pay ~$4,700/month on the PennyMac mortgage with intentionally accelerated principal payments. The interest portion is deductible on Schedule A. Request the 1098 from PennyMac for each tax year — the platform will parse it if you upload it.",
      value: "Likely $30k+/yr in deductible interest early in the loan",
      risk: "conservative",
      caveat: "",
      forms: ["Schedule A", "Form 1098"],
    },
    {
      key: "salt_cap",
      title: "State & local taxes (SALT) up to the $10,000 cap",
      explanation:
        "Property taxes on both properties (Arbor Rd ~$3,400/yr, primary residence per your bills) plus CT state income tax withholding count toward SALT — deductible up to $10,000 total. Above the cap there's no federal benefit, so we track it to make sure you reach but don't oversell it.",
      value: "Up to $10,000 of deductions",
      risk: "conservative",
      caveat: "",
      forms: ["Schedule A"],
    },
    {
      key: "rental_depreciation",
      title: "Depreciate the Arbor Rd rental property (Sudden Valley)",
      explanation:
        "The 56 Arbor Rd property is owned free and clear — its building basis (purchase price less land, plus capital improvements) depreciates over 27.5 years and offsets rental income. Depreciation is not optional: the IRS recaptures it at sale whether or not you claimed it, so skipping it now only costs money later.",
      value: "Often the largest rental deduction — potentially shelters most Airbnb income",
      risk: "conservative",
      caveat:
        "Requires the original purchase price and land allocation — if unavailable, your CPA can use the county assessed land/building split. First-year (2026) Schedule E will include this.",
      forms: ["Schedule E", "Form 4562"],
    },
    {
      key: "home_office",
      title: "Home office deduction for EK Consulting (if exclusive-use)",
      explanation:
        "If any room is used regularly and exclusively for consulting work, a home office deduction allocates a share of housing costs to Schedule C. The simplified method ($5/sq ft up to 300 sq ft) is low-effort and low-risk.",
      value: "$0–$1,500 (simplified) or more (actual method)",
      risk: "moderate",
      caveat:
        "Exclusive use is the make-or-break requirement. A shared-use room does not qualify, and claiming one that doesn't qualify is an audit magnet with a 20% accuracy penalty if disallowed.",
      forms: ["Form 8829", "Schedule C"],
    },
    {
      key: "short_term_rental_loophole",
      title: "Short-term rental loss treatment (average stay ≤ 7 days)",
      explanation:
        "Airbnb stays averaging 7 days or less generally don't count as 'passive activity' in the usual sense — material participation can let net rental losses offset ordinary income rather than being suspended. With substantial depreciation and expenses on a free-and-clear property, this could shelter income aggressively.",
      value: "Potentially $10k–$25k+ of income sheltered per year",
      risk: "aggressive",
      caveat:
        "This is a real but actively scrutinized strategy. It requires documented material participation (hours matter, 500+ typically) and an honest average-stay figure. The IRS has challenged these positions; a CPA must bless it before filing, and the recordkeeping burden is real. If participation can't be documented, the loss simply suspends and carries forward — still no harm, just no immediate benefit.",
      forms: ["Schedule E", "Form 8582 (or its absence)"],
    },
    {
      key: "retirement_savings_credit",
      title: "Saver's Credit (Form 8880) — check eligibility",
      explanation:
        "Retirement plan contributions may earn a credit of up to $1,000 per spouse on top of the deduction itself. Income limits are strict (roughly under $79k for a married couple in 2025), so this phases out at higher incomes — we check rather than assume either way.",
      value: "Up to $2,000 total (MFJ) — phases out with income",
      risk: "conservative",
      caveat: "",
      forms: ["Form 8880"],
    },
    {
      key: "safe_harbor",
      title: "2025 safe-harbor / underpayment review",
      explanation:
        "Because 2025 is on extension, we compute whether you've met a safe harbor (100%/110% of prior-year tax) so no underpayment penalty applies, and quantify any balance-due interest accruing since April 15, 2026. Going forward we can set withholding/estimates so you owe ~$0 without giving the government an interest-free loan — the precise balance this platform's owner wants.",
      value: "Avoids ~8% annualized penalty + interest on shortfalls",
      risk: "conservative",
      caveat: "",
      forms: ["Form 2210", "Form 1040-ES"],
    },
    {
      key: "mileage",
      title: "Business mileage from the app's log",
      explanation:
        "The platform already tracks business mileage at the IRS standard rate. Entries for client meetings, the rental property, and between-work travel flow into Schedule C or E.",
      value: "70¢/mile for 2025",
      risk: "conservative",
      caveat: "Only logged, business-purpose trips — commuting never counts.",
      forms: ["Schedule C", "Schedule E"],
    },
    {
      key: "hsa",
      title: "HSA contributions (triple tax advantage)",
      explanation:
        "If either of you has an HSA-eligible health plan, contributions are deductible, growth is tax-free, and medical withdrawals are never taxed — the only account with all three. 2025 limits ~$8,550 family. Contributions made before the filing deadline still count for 2025.",
      value: "Up to ~$8,550 deducted + potential state benefits",
      risk: "conservative",
      caveat: "Requires an HSA-eligible (high-deductible) health plan — verify before contributing.",
      forms: ["Form 8889"],
    },
  ];
}

/**
 * Grades an opportunity's risk for display. Aggressive items always surface
 * their caveat; nothing is hidden, but nothing is dressed up as safe either.
 */
export function formatOpportunityForDisplay(op: TaxOpportunity): {
  title: string;
  riskLabel: string;
  riskClass: string;
} {
  const riskMap: Record<OpportunityRisk, { label: string; cls: string }> = {
    conservative: { label: "Well-established", cls: "bg-green-50 text-green-700 border-green-200" },
    moderate: { label: "Verify requirements", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    aggressive: { label: "CPA review required", cls: "bg-red-50 text-red-700 border-red-200" },
  };
  const r = riskMap[op.risk];
  return { title: op.title, riskLabel: r.label, riskClass: r.cls };
}

/**
 * Computes what the answers so far imply. Pure — used by both UI and tests.
 * Returns opportunities that the user's answers EXCLUDE (so we show them
 * crossed off with the reason, which keeps the guidance honest).
 */
export function evaluateAnswers(
  answers: Record<string, unknown>
): { excluded: string[]; actOn: string[] } {
  const excluded: string[] = [];
  const actOn: string[] = [];

  const homeOffice = answers["home_office_ekc"];
  if (homeOffice === "yes_shared") excluded.push("home_office");
  if (homeOffice === "yes_exclusive") actOn.push("home_office");

  if (answers["filing_status"] === "mfs") {
    excluded.push("retirement_savings_credit"); // Saver's credit disallowed for MFS
  }

  const solar = answers["solar_credit"];
  if (solar === "claimed_already") excluded.push("solar_credit_25d");
  if (solar === "yes_unclaimed") actOn.push("solar_credit_25d");

  const ev = answers["ev_vehicle"];
  if (ev === "no") excluded.push("ev_credit");
  if (ev === "yes_new") actOn.push("ev_credit");

  const dependents = answers["household_members"];
  if (dependents === "children") actOn.push("child_credits");
  if (dependents === "none") excluded.push("child_credits");

  return { excluded, actOn };
}

// ── Form autofill plan ───────────────────────────────────────────────────────

export interface FormPlanField {
  /** IRS official form/line label */
  line: string;
  /** What value goes here, or what we need to compute it */
  source: string;
  /** true if we already have the data; false = needs user input */
  haveData: boolean;
}

export interface FormPlan {
  formName: string;
  purpose: string;
  whereToGet: string;
  fields: FormPlanField[];
}

export const PERSONAL_FORM_PLAN: FormPlan[] = [
  {
    formName: "Form 1040 (U.S. Individual Income Tax Return)",
    purpose: "The core federal return — income, deductions, credits, and refund/amount owed.",
    whereToGet: "IRS.gov/forms — free e-file via Free File or your CPA's software; DO NOT pay for the form itself.",
    fields: [
      { line: "Wages (line 1a)", source: "Sum of W-2 box 1 from uploaded W-2s", haveData: false },
      { line: "Interest income (line 2b)", source: "1099-INT forms (bank/Betterment)", haveData: false },
      { line: "Business income (Schedule 1)", source: "EK Consulting Schedule C net profit (drafted from the app's books)", haveData: false },
      { line: "Rental income (Schedule 1)", source: "Sudden Valley Airbnb income from JCSB deposits (2026 forward)", haveData: false },
      { line: "Adjustments (Schedule 1, Part II)", source: "HSA, IRA, self-employed retirement from your answers", haveData: false },
      { line: "Standard or itemized (line 12)", source: "Compare standard deduction vs. Schedule A totals parsed from your 1098s and property tax bills", haveData: false },
      { line: "Credits (lines 19-21)", source: "Solar 25D, EV, Saver's, child credits per your answers", haveData: false },
      { line: "Payments/withholding (line 25)", source: "W-2 box 2 federal + estimated payments you log", haveData: false },
    ],
  },
  {
    formName: "Schedule A (Itemized Deductions)",
    purpose: "Claims mortgage interest, SALT, charity, and medical deductions when they beat the standard deduction.",
    whereToGet: "Attaches to Form 1040; prepared here from your uploaded documents.",
    fields: [
      { line: "Home mortgage interest (line 8a)", source: "PennyMac Form 1098 (upload it and the platform parses it)", haveData: false },
      { line: "State/local taxes (line 5e)", source: "Property tax bills + CT income tax withholding (capped at $10,000)", haveData: false },
      { line: "Gifts to charity (line 11)", source: "Your logged donations (cash needs bank records; $250+ needs receipts)", haveData: false },
    ],
  },
  {
    formName: "Schedule C (EK Consulting — LaunchTime Solutions)",
    purpose: "Reports consulting income and expenses; net profit flows to your 1040 (single-member LLC, disregarded entity).",
    whereToGet: "Attaches to Form 1040; the app pre-drafts it from QuickBooks Checking transactions and receipts.",
    fields: [
      { line: "Gross receipts (line 1)", source: "EK Consulting revenue from QuickBooks deposits", haveData: false },
      { line: "Car and truck expenses (line 9)", source: "App mileage log entries at 70¢/mile", haveData: false },
      { line: "Home office (line 30)", source: "Simplified or actual method per your exclusive-use answer", haveData: false },
      { line: "Depreciation (line 13)", source: "Form 4562 assets you've entered", haveData: false },
    ],
  },
  {
    formName: "Schedule E (Rental Real Estate — 56 Arbor Rd)",
    purpose: "Reports Airbnb rental income, expenses, and depreciation for Sudden Valley.",
    whereToGet: "Attaches to Form 1040; drafted from JCSB transactions, rental bookings, and your answers.",
    fields: [
      { line: "Rents received (line 3)", source: "Airbnb payouts deposited to JCSB x0626", haveData: false },
      { line: "Taxes (line 16)", source: "Arbor Rd property tax bills ($281.67/mo accrual)", haveData: false },
      { line: "Insurance (line 15)", source: "Amica home policy ($167.90/mo)", haveData: false },
      { line: "Depreciation (line 18)", source: "Building basis over 27.5 years — needs purchase price/land split", haveData: false },
    ],
  },
  {
    formName: "Form 5695 (Residential Clean Energy Credits)",
    purpose: "Claims the 30% solar credit — carries forward if it exceeds this year's tax.",
    whereToGet: "IRS.gov/forms; prepared here from your solar contract and placed-in-service date.",
    fields: [
      { line: "Qualified solar electric property cost (line 1)", source: "Solar contract/invoice total (EnerBank loan docs)", haveData: false },
      { line: "Credit (30%)", source: "Computed from line 1", haveData: false },
    ],
  },
  {
    formName: "CT State Income Tax Return (Form CT-1040)",
    purpose: "Connecticut resident return — CT taxes income but offers pension/IRA subtraction and property tax credits.",
    whereToGet: "portal.ct.gov/TSC or through your CPA — free to e-file.",
    fields: [
      { line: "CT adjusted gross income", source: "From federal AGI plus CT modifications", haveData: false },
      { line: "Property tax credit", source: "Primary residence property tax bills — upload them and the platform parses them", haveData: false },
      { line: "CT withholding (W-2 box 17)", source: "Parsed from your W-2 upload", haveData: false },
    ],
  },
];

// ── Refund objective ──────────────────────────────────────────────────────────

export const REFUND_OBJECTIVE_STATEMENT =
  "Strategy: claim every deduction and credit the law allows, choose the larger of standard vs. itemized, " +
  "verify each position honestly, and calibrate withholding/estimates so you neither owe a balance nor " +
  "give the government an interest-free loan. Aggressive positions are surfaced — never applied silently — " +
  "with their true legal weight, because a disallowed position costs the original tax plus 20-75% penalties " +
  "and interest, which defeats the entire objective.";