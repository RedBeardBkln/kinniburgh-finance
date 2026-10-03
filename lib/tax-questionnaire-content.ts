// Content for the CPA-input questionnaires (data only - the engine is
// lib/tax-questionnaire.ts). Every definition is DATA: question id, text,
// options, "shows when" rules and an optional derived outcome. Branching is never
// hard-coded in a component.
//
// Ground rules for this copy (CLAUDE.md #1 and #8):
//   * Questions gather facts for the CPA. They never advise, never compute a tax
//     amount / eligibility / limit, and the derived outcome is always phrased
//     "Owner reports ...".
//   * Every factual sentence in a `help` field is a paraphrase of a passage read
//     on the primary source named in `sources` (registry below, fetched
//     2026-10-03). A claim with no traceable source is NOT in this file.
//   * The IRS instruction pages are the 2025 revisions; the runner page shows a
//     caution on any other tax year.
//   * Wording that mirrors a planning question's own pre-existing copy errors is
//     deliberately NOT repeated (saver's-credit filing-status exclusion, "plan to
//     before filing" for the EV credit, child-credit dollar figure, hard-coded
//     year). Those are tracked separately.

import {
  UNSURE_ID,
  UNSURE_LABEL,
  type ChoiceBinding,
  type ChoiceNode,
  type Cond,
  type ContextFlag,
  type NumberBinding,
  type NumberNode,
  type Outcome,
  type QOption,
  type QuestionnaireDef,
  type SourceId,
} from "@/lib/tax-questionnaire";

// ── Source registry ───────────────────────────────────────────────────────────

export interface QuestionnaireSource {
  title: string;
  url: string;
  /** Date the page was fetched and the cited passages read. */
  verifiedOn: string;
  /** Tax year of the instruction revision; null when the page is not year-specific. */
  basisTaxYear: number | null;
}

const VERIFIED = "2026-10-03";

export const SOURCES: Readonly<Record<SourceId, QuestionnaireSource>> = {
  "8889": { title: "Instructions for Form 8889 (2025)", url: "https://www.irs.gov/instructions/i8889", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8829": { title: "Instructions for Form 8829 (2025)", url: "https://www.irs.gov/instructions/i8829", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "4562": { title: "Instructions for Form 4562 (2025)", url: "https://www.irs.gov/instructions/i4562", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8582": { title: "Instructions for Form 8582 (2025)", url: "https://www.irs.gov/instructions/i8582", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  SAVER: {
    title: "Retirement savings contributions credit (saver's credit) - IRS",
    url: "https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-savings-contributions-credit-savers-credit",
    verifiedOn: VERIFIED,
    basisTaxYear: null,
  },
  "8880": { title: "About Form 8880 - IRS", url: "https://www.irs.gov/forms-pubs/about-form-8880", verifiedOn: VERIFIED, basisTaxYear: null },
  "2210": { title: "Instructions for Form 2210 (2025)", url: "https://www.irs.gov/instructions/i2210", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  EST: {
    title: "Estimated taxes - IRS",
    url: "https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes",
    verifiedOn: VERIFIED,
    basisTaxYear: null,
  },
  "1040GI": { title: "Instructions for Form 1040 (2025)", url: "https://www.irs.gov/instructions/i1040gi", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8812": { title: "Instructions for Schedule 8812 (2025)", url: "https://www.irs.gov/instructions/i1040s8", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8936": { title: "Instructions for Form 8936 (2025)", url: "https://www.irs.gov/instructions/i8936", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8959": { title: "Instructions for Form 8959 (2025)", url: "https://www.irs.gov/instructions/i8959", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8995": { title: "Instructions for Form 8995 (2025)", url: "https://www.irs.gov/instructions/i8995", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8995A": { title: "Instructions for Form 8995-A (2025)", url: "https://www.irs.gov/instructions/i8995a", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  SE: { title: "Instructions for Schedule SE (2025)", url: "https://www.irs.gov/instructions/i1040sse", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  LLC: {
    title: "Limited liability company (LLC) - IRS",
    url: "https://www.irs.gov/businesses/small-businesses-self-employed/limited-liability-company-llc",
    verifiedOn: VERIFIED,
    basisTaxYear: null,
  },
  SMLLC: {
    title: "Single member limited liability companies - IRS",
    url: "https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies",
    verifiedOn: VERIFIED,
    basisTaxYear: null,
  },
  "8832": { title: "About Form 8832 - IRS", url: "https://www.irs.gov/forms-pubs/about-form-8832", verifiedOn: VERIFIED, basisTaxYear: null },
  "2553": { title: "About Form 2553 - IRS", url: "https://www.irs.gov/forms-pubs/about-form-2553", verifiedOn: VERIFIED, basisTaxYear: null },
  "1065": { title: "About Form 1065 - IRS", url: "https://www.irs.gov/forms-pubs/about-form-1065", verifiedOn: VERIFIED, basisTaxYear: null },
  "1120S": {
    title: "About Schedule K-1 (Form 1120-S) - IRS",
    url: "https://www.irs.gov/forms-pubs/about-schedule-k-1-form-1120-s",
    verifiedOn: VERIFIED,
    basisTaxYear: null,
  },
  CTPET: {
    title: "Pass-through entity tax information - Connecticut DRS",
    url: "https://portal.ct.gov/drs/taxes/pass-through-entity/tax-information",
    verifiedOn: VERIFIED,
    basisTaxYear: null,
  },
};

export const SOURCE_IDS: ReadonlySet<string> = new Set(Object.keys(SOURCES));

// ── Small builders (keep the definitions readable) ────────────────────────────

const SOURCES_TAX_YEAR = 2025;
const UNSURE: QOption = { id: UNSURE_ID, label: UNSURE_LABEL, unsure: true };

function o(id: string, label: string, extra: Partial<Omit<QOption, "id" | "label">> = {}): QOption {
  return { id, label, ...extra };
}
const YES_NO: readonly QOption[] = [o("yes", "Yes"), o("no", "No"), UNSURE];

function inn(node: string, ...values: string[]): Cond {
  return { kind: "in", node, values };
}
function anyOf(...of: Cond[]): Cond {
  return { kind: "any", of };
}
function allOf(...of: Cond[]): Cond {
  return { kind: "all", of };
}
function hidden(node: string): Cond {
  return { kind: "hidden", node };
}

interface NodeExtra {
  help?: string;
  sources?: SourceId[];
  showWhen?: Cond;
  context?: ContextFlag;
}

function single(
  id: string,
  prompt: string,
  options: readonly QOption[],
  extra: NodeExtra & { binding?: ChoiceBinding } = {}
): ChoiceNode {
  const { showWhen, ...rest } = extra;
  return { id, kind: "single", prompt, options, showWhen: showWhen ?? null, ...rest };
}

function multi(id: string, prompt: string, options: readonly QOption[], extra: NodeExtra = {}): ChoiceNode {
  const { showWhen, ...rest } = extra;
  return { id, kind: "multi", prompt, options, showWhen: showWhen ?? null, ...rest };
}

function whole(
  id: string,
  prompt: string,
  min: number,
  max: number,
  extra: NodeExtra & { binding?: NumberBinding } = {}
): NumberNode {
  const { showWhen, ...rest } = extra;
  return { id, kind: "whole_number", prompt, min, max, showWhen: showWhen ?? null, ...rest };
}

/** A whole-dollar amount; the answered/stored value is integer CENTS. */
function dollars(
  id: string,
  prompt: string,
  extra: NodeExtra & { binding?: NumberBinding } = {}
): NumberNode {
  const { showWhen, ...rest } = extra;
  return { id, kind: "dollars", prompt, min: 0, max: 10_000_000, showWhen: showWhen ?? null, ...rest };
}

const OUTCOME_UNSURE_DEFAULT = "Owner is unsure - the CPA decides.";

function outcomes(applies: string, notApplies: string, unsure: string = OUTCOME_UNSURE_DEFAULT): Record<Outcome, string> {
  return { applies, not_applies: notApplies, unsure };
}

// ── 1. Form 8829 - home office ───────────────────────────────────────────────

const HO_YES = inn("ho1", "yes_exclusive", "yes_shared");

const FORM_8829: QuestionnaireDef = {
  id: "form-8829",
  version: 1,
  title: "Home office",
  formLabel: "Form 8829",
  scope: "household",
  intro: "Facts about any part of the home used for EK Consulting work in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "ho1",
      "Did you use part of your home for EK Consulting work in {year}?",
      [
        o("yes_exclusive", "Yes - a space used regularly and only for EK Consulting"),
        o("yes_shared", "Yes - but the space is also used personally", {
          warning:
            "Also marks the home-office deduction 'ruled out' on the Planning screen and Forms page, as that answer does today; the CPA can still review it.",
        }),
        o("no", "No home space used for the business"),
        UNSURE,
      ],
      {
        help: "The IRS instructions generally allow a deduction only for a part of the home used exclusively and on a regular basis as your principal place of business, to meet clients, or as a separate structure not attached to the home.",
        sources: ["8829"],
        binding: {
          mode: "shared_choice",
          questionKey: "home_office_ekc",
          bank: { yes_exclusive: "yes_exclusive", yes_shared: "yes_shared", no: "no", unsure: null },
        },
      }
    ),
    single(
      "ho2",
      "What kind of space is it?",
      [
        o("room", "A room or area inside the home"),
        o("separate", "A separate structure not attached to the home (for example a barn or detached garage)", {
          sources: ["8829"],
        }),
        o("both", "Both"),
        UNSURE,
      ],
      { showWhen: HO_YES }
    ),
    multi(
      "ho3",
      "What is the space used for?",
      [
        o("admin", "Administrative or management work (billing, scheduling, bookkeeping)"),
        o("clients", "Meeting clients or customers in person"),
        o("other_work", "Other work or services for clients"),
        o("storage", "Storing inventory or product samples"),
        UNSURE,
      ],
      {
        help: "The IRS instructions list billing customers or clients as an example of administrative or management work, and treat storage of inventory or product samples as an exception to the exclusive-use rule.",
        sources: ["8829"],
        showWhen: HO_YES,
      }
    ),
    single("ho4", "Is there another fixed place where you do substantial administrative or management work for this business?", YES_NO, {
      help: "The IRS instructions say the home office qualifies as the principal place of business only if you have no other fixed location where you do substantial administrative or management activities.",
      sources: ["8829"],
      showWhen: inn("ho3", "admin"),
    }),
    whole("ho5", "Approximate square footage of the space", 1, 99999, {
      showWhen: HO_YES,
      binding: { mode: "shared_number", questionKey: "home_office_sqft", format: "whole_number" },
    }),
    single(
      "ho6",
      "Was a home office deducted on a prior-year return?",
      [
        o("simplified", "Yes - the simplified method"),
        o("actual", "Yes - actual expenses (Form 8829)"),
        o("first_year", "No - this would be the first year"),
        UNSURE,
      ],
      {
        help: "The IRS instructions explain how switching between the simplified and actual-expense methods affects carryover amounts.",
        sources: ["8829"],
        showWhen: HO_YES,
      }
    ),
    single("ho7", "Do you own or rent the home?", [o("own", "Own"), o("rent", "Rent"), UNSURE], { showWhen: HO_YES }),
    single(
      "ho8",
      "Was the space used for the business for the whole year?",
      [o("whole", "Yes - the whole year"), o("part", "Started or stopped during {year}"), UNSURE],
      { showWhen: HO_YES }
    ),
  ],
  outcomeRules: [
    { when: inn("ho1", "yes_exclusive"), outcome: "applies" },
    { when: inn("ho1", "yes_shared"), outcome: "unsure" },
    { when: inn("ho1", "no"), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports a home space used for the business - the CPA decides whether and how to claim it.",
    "Owner reports no home space used for the business.",
    "Owner is unsure or reports mixed personal use - the CPA decides."
  ),
};

// ── 2. Form 4562 - depreciation (card exists only when Sudden Valley is active) ──

const DA_SOME = anyOf(inn("da1", "some"), inn("da2", "some"));

const FORM_4562: QuestionnaireDef = {
  id: "form-4562",
  version: 1,
  title: "Depreciation and amortization",
  formLabel: "Form 4562",
  scope: "household",
  intro: "Facts about business equipment and property for the CPA. The app records inputs only; it never computes depreciation.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "da1",
      "Did EK Consulting place any equipment or other depreciable assets in service in {year}, or still hold any the CPA should review?",
      [
        o("none", "None"),
        o("some", "Yes - I will record them in the fixed-asset register"),
        UNSURE,
      ],
      {
        help: "The IRS says Form 4562 is filed to claim depreciation for property placed in service during the tax year, a section 179 deduction, or depreciation on any vehicle or other listed property. The app only records inputs; it never computes depreciation.",
        sources: ["4562"],
        context: "ekcActive",
        binding: { mode: "shared_choice", questionKey: "fixed_assets_ekc", bank: { none: "none", some: "some", unsure: null } },
      }
    ),
    single("da2", "Did Sudden Valley own a building or other depreciable property in {year}?", [o("none", "None"), o("some", "Yes - I will record it in the fixed-asset register"), UNSURE], {
      context: "svActive",
      binding: { mode: "shared_choice", questionKey: "fixed_assets_sv", bank: { none: "none", some: "some", unsure: null } },
    }),
    multi(
      "da3",
      "What kinds of assets?",
      [
        o("computers", "Computers or office equipment"),
        o("furniture", "Furniture or appliances"),
        o("vehicle", "A vehicle"),
        o("building", "A building (real property)"),
        o("improvements", "Renovation or improvements to a building"),
        o("software", "Software or other intangibles"),
        o("other", "Something else"),
        UNSURE,
      ],
      { showWhen: DA_SOME }
    ),
    single("da4", "How is the vehicle used?", [o("business_only", "Only for business"), o("mixed", "Business and personal"), UNSURE], {
      help: "The IRS lists depreciation on any vehicle or other listed property as a reason to file Form 4562, regardless of when it was placed in service.",
      sources: ["4562"],
      showWhen: inn("da3", "vehicle"),
    }),
    single(
      "da5",
      "When did the building first become available for rent or business use?",
      [o("before", "Before {year}"), o("during", "During {year}"), o("not_yet", "Not yet"), UNSURE],
      { showWhen: inn("da3", "building", "improvements") }
    ),
    single("da6", "Were renovation costs paid before the property was first rented?", YES_NO, { showWhen: inn("da3", "improvements") }),
    single(
      "da7",
      "Do you have the purchase invoices or closing statement for these assets?",
      [o("all", "Yes - for all of them"), o("some", "For some of them"), o("none", "No"), UNSURE],
      { showWhen: DA_SOME }
    ),
    single(
      "da8",
      "Was depreciation claimed on any of these assets on an earlier return?",
      [o("yes", "Yes - a prior Form 4562 exists"), o("no", "No"), UNSURE],
      { showWhen: DA_SOME }
    ),
  ],
  outcomeRules: [
    { when: DA_SOME, outcome: "applies" },
    {
      when: allOf(anyOf(hidden("da1"), inn("da1", "none")), anyOf(hidden("da2"), inn("da2", "none"))),
      outcome: "not_applies",
    },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports depreciable assets - the CPA decides treatment (the app records inputs only).",
    "Owner reports no depreciable business assets.",
    "Owner is unsure about depreciable assets - the CPA decides."
  ),
};

// ── 3. Form 8582 - passive activity losses (Sudden Valley years only) ─────────

const PA_HOURS: readonly QOption[] = [
  o("under100", "Under 100 hours"),
  o("h100_500", "100 to 500 hours"),
  o("over500", "More than 500 hours"),
  UNSURE,
];
const PA_HOURS_HELP =
  "The IRS material-participation tests include more than 100 hours and more than 500 hours, and say participation may be shown by any reasonable means such as calendars or narrative summaries. Whether a test is met is for the CPA.";

const FORM_8582: QuestionnaireDef = {
  id: "form-8582",
  version: 1,
  title: "Passive activity loss limitations",
  formLabel: "Form 8582",
  scope: "household",
  intro: "Facts about the Sudden Valley rental and any other passive activities, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "pa1",
      "On average, how long are guests' stays at the Sudden Valley rental?",
      [o("avg7", "7 days or less"), o("avg30", "8 to 30 days"), o("over30", "More than 30 days"), UNSURE],
      {
        help: "The IRS instructions say a rental is not treated as a 'rental activity' for these rules when the average period of customer use is 7 days or less, or 30 days or less with significant personal services. How the average is figured is for the CPA.",
        sources: ["8582"],
      }
    ),
    single("pa2", "Are significant personal services provided to guests?", YES_NO, {
      help: "The IRS says significant personal services include only services performed by individuals and depend on the facts and circumstances.",
      sources: ["8582"],
      showWhen: inn("pa1", "avg30"),
    }),
    single(
      "pa3",
      "For {year}, did the rental have a net loss, a net profit, or neither (including no rental yet)?",
      [o("loss", "A net loss"), o("profit", "A net profit"), o("neither", "Neither, or no rental yet"), UNSURE],
      {
        help: "The IRS instructions say Form 8582 is used to figure any passive activity loss, which occurs when losses from passive activities exceed income from them.",
        sources: ["8582"],
      }
    ),
    single(
      "pa4",
      "Who does the day-to-day work (guest messaging, cleaning, repairs)?",
      [o("us", "Mostly us"), o("shared", "Shared with a manager or cleaners"), o("others", "Mostly others"), UNSURE]
    ),
    single("pa5", "About how many hours did Eric personally work on the rental in {year}?", PA_HOURS, {
      help: PA_HOURS_HELP,
      sources: ["8582"],
      showWhen: inn("pa1", "avg7", "avg30", "unsure"),
    }),
    single("pa6", "About how many hours did Eva personally work on the rental in {year}?", PA_HOURS, {
      help: PA_HOURS_HELP,
      sources: ["8582"],
      showWhen: inn("pa1", "avg7", "avg30", "unsure"),
    }),
    single("pa7", "Did you make management decisions for the rental (approving guests or tenants, setting rates, approving repairs)?", YES_NO, {
      help: "The IRS says active participation is a less stringent requirement than material participation.",
      sources: ["8582"],
      showWhen: inn("pa1", "avg30", "over30", "unsure"),
    }),
    single("pa8", "Does either of you work in real estate as a main occupation?", YES_NO, {
      help: "The IRS instructions treat rental real estate in which you materially participated as an exception only if you were a 'real estate professional'.",
      sources: ["8582"],
    }),
    single("pa9", "Are there unused (suspended) passive losses from earlier years?", YES_NO, {
      help: "The IRS instructions say Form 8582 also reports the use of prior-year unallowed passive losses.",
      sources: ["8582"],
    }),
    single("pa10", "Does the household have other passive activities (for example a business or partnership you do not work in)?", YES_NO),
  ],
  outcomeRules: [
    { when: anyOf(inn("pa3", "loss"), inn("pa9", "yes"), inn("pa10", "yes")), outcome: "applies" },
    { when: allOf(inn("pa3", "profit", "neither"), inn("pa9", "no"), inn("pa10", "no")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports a rental loss or other passive items - the CPA decides whether Form 8582 is needed.",
    "Owner reports no rental loss, no suspended losses and no other passive activities."
  ),
};

// ── 4. Form 8880 - saver's credit ────────────────────────────────────────────

const SV_POSITIVE = inn("sv1", "eric", "eva", "both");

const FORM_8880: QuestionnaireDef = {
  id: "form-8880",
  version: 1,
  title: "Saver's credit",
  formLabel: "Form 8880",
  scope: "household",
  intro:
    "Facts about retirement-account contributions for {year}, for the CPA to review. The IRS describes Form 8880 as the form that figures the retirement savings contributions credit.",
  introSources: ["8880"],
  sourcesTaxYear: SOURCES_TAX_YEAR,
  planningLinks: [
    { key: "retirement_contributions", label: "Retirement contributions (Planning answer)" },
    { key: "retirement_contribution_amount", label: "Total retirement/HSA contributions (Planning answer)" },
  ],
  nodes: [
    single(
      "sv1",
      "Who made retirement-account contributions for {year}?",
      [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), o("neither", "Neither of us"), UNSURE],
      {
        help: "The IRS says the saver's credit is based on contributions to a traditional or Roth IRA, elective deferrals to a 401(k), 403(b), governmental 457(b), SARSEP or SIMPLE plan, voluntary after-tax employee contributions to a qualified plan or 403(b), a 501(c)(18)(D) plan, or an ABLE account you are the designated beneficiary of. HSA contributions are not on that list (see the Form 8889 questionnaire).",
        sources: ["SAVER"],
      }
    ),
    multi(
      "sv2",
      "What kinds of accounts?",
      [
        o("ira_trad", "Traditional IRA"),
        o("ira_roth", "Roth IRA"),
        o("deferral", "Salary deferral at work (401(k), 403(b), governmental 457(b), SIMPLE, SARSEP)"),
        o("after_tax", "Voluntary after-tax contributions to a workplace plan"),
        o("able", "ABLE account"),
        o("other", "Something else"),
        UNSURE,
      ],
      { showWhen: SV_POSITIVE }
    ),
    single("sv3", "Did either of you receive a distribution (withdrawal) from a retirement plan, IRA or ABLE account recently?", YES_NO, {
      help: "The IRS says eligible contributions may be reduced by recent distributions, and rollover contributions do not qualify.",
      sources: ["SAVER"],
      showWhen: SV_POSITIVE,
    }),
    single("sv4", "In {year}, was either of you a full-time student for part of 5 calendar months, or claimed as someone else's dependent?", YES_NO, {
      help: "The IRS says you must be 18 or older, not claimed as a dependent on another person's return, and not a student; a student is someone enrolled full time during any part of 5 calendar months of the year.",
      sources: ["SAVER"],
      showWhen: SV_POSITIVE,
    }),
    dollars("sv5", "About how much was contributed in total to these accounts, not counting an HSA?", { showWhen: SV_POSITIVE }),
    single(
      "sv6",
      "Do you have statements showing each contribution?",
      [o("all", "Yes - for all of them"), o("some", "For some of them"), o("none", "No"), UNSURE],
      { showWhen: SV_POSITIVE }
    ),
  ],
  outcomeRules: [
    { when: inn("sv1", "neither"), outcome: "not_applies" },
    { when: allOf(SV_POSITIVE, inn("sv4", "no")), outcome: "applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports retirement contributions and no student/dependent status - the CPA checks eligibility and income.",
    "Owner reports no retirement-account contributions.",
    "Owner is unsure or reports a possible eligibility issue - the CPA decides."
  ),
};

// ── 5. Form 8889 - HSA ───────────────────────────────────────────────────────

const HS_POSITIVE = inn("hs1", "eric", "eva", "both");

const FORM_8889: QuestionnaireDef = {
  id: "form-8889",
  version: 1,
  title: "Health Savings Accounts",
  formLabel: "Form 8889",
  scope: "household",
  intro: "Facts about health-plan coverage and HSA activity in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  planningLinks: [{ key: "retirement_contributions", label: "Retirement contributions (Planning answer)" }],
  nodes: [
    single(
      "hs1",
      "Was either of you covered by a high-deductible health plan (HDHP) that qualifies for an HSA for any part of {year}?",
      [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), o("neither", "Neither of us"), UNSURE],
      {
        help: "The IRS says to be eligible to have contributions made to an HSA you must be covered under a high deductible health plan and have no other health coverage except certain disregarded coverage.",
        sources: ["8889"],
      }
    ),
    single(
      "hs2",
      "What kind of HDHP coverage?",
      [o("self_only", "Self-only"), o("family", "Family"), o("changed", "It changed during the year"), UNSURE],
      {
        help: "The IRS contribution limit depends on self-only versus family coverage; if both spouses are eligible and either has family coverage, both are treated as having family coverage.",
        sources: ["8889"],
        showWhen: HS_POSITIVE,
      }
    ),
    single("hs3", "Were any contributions made to an HSA for {year}?", YES_NO, { showWhen: HS_POSITIVE }),
    multi(
      "hs4",
      "How were they made?",
      [
        o("payroll", "Through payroll deduction at work"),
        o("employer", "The employer contributed on our behalf"),
        o("direct", "We deposited it ourselves, not through payroll"),
        UNSURE,
      ],
      {
        help: "The IRS says payroll contributions through a cafeteria plan are treated as employer contributions and are shown on the W-2 in box 12 with code W.",
        sources: ["8889"],
        showWhen: inn("hs3", "yes"),
      }
    ),
    dollars("hs5", "About how much did you deposit yourselves (not through payroll)?", { showWhen: inn("hs4", "direct") }),
    single("hs6", "Do you have the {year} W-2 showing box 12 code W?", YES_NO, { showWhen: inn("hs4", "payroll", "employer") }),
    single("hs7", "Did anyone take money out of an HSA in {year}?", YES_NO, {
      help: "The IRS says anyone who received HSA distributions must file Form 8889 even with no taxable income; distributions are shown on Form 1099-SA, box 1.",
      sources: ["8889"],
      showWhen: HS_POSITIVE,
    }),
    single("hs8", "Was all of it spent on medical costs?", [o("all", "Yes - all of it"), o("part", "Only part of it"), o("none", "None of it"), UNSURE], {
      showWhen: inn("hs7", "yes"),
    }),
    single("hs9", "For any month of {year}, was either of you enrolled in Medicare or claimed as someone else's dependent?", YES_NO, {
      help: "The IRS says you cannot deduct HSA contributions for any month you were enrolled in Medicare, or if you are someone else's dependent.",
      sources: ["8889"],
      showWhen: HS_POSITIVE,
    }),
  ],
  outcomeRules: [
    { when: inn("hs1", "neither"), outcome: "not_applies" },
    { when: anyOf(inn("hs3", "yes"), inn("hs7", "yes")), outcome: "applies" },
    { when: allOf(inn("hs3", "no"), inn("hs7", "no")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports HSA contributions or withdrawals, so Form 8889 likely applies - the CPA decides whether and how to prepare it.",
    "Owner reports no HSA-eligible plan, or no contributions or withdrawals."
  ),
};

// ── 6. Form 2210 - underpayment of estimated tax ─────────────────────────────

const FORM_2210: QuestionnaireDef = {
  id: "form-2210",
  version: 1,
  title: "Underpayment of estimated tax",
  formLabel: "Form 2210",
  scope: "household",
  intro: "Facts about withholding and estimated payments for {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  planningLinks: [{ key: "estimated_taxes_2025", label: "Estimated taxes paid (Planning answer)" }],
  nodes: [
    single("ut1", "Was federal income tax withheld from pay in {year}?", YES_NO),
    single(
      "ut2",
      "Did you make federal estimated tax payments for {year}?",
      [o("regular", "Yes - on a regular schedule"), o("some", "Yes - some payments"), o("none", "No"), UNSURE],
      {
        help: "The IRS says Form 2210 is used to see if you owe a penalty for underpaying estimated tax. The IRS says it will generally figure the penalty for you, and that the form is only filed when a situation requires it, such as requesting a waiver.",
        sources: ["2210"],
      }
    ),
    dollars("ut3", "Total estimated tax payments for {year}, federal and state combined (whole dollars)", {
      showWhen: inn("ut2", "regular", "some"),
      binding: { mode: "shared_number", questionKey: "estimated_tax_payments_amount", format: "whole_dollars" },
    }),
    dollars("ut4", "Of that, about how much was federal?", { showWhen: inn("ut2", "regular", "some") }),
    single("ut5", "Were all payments made on time?", YES_NO, { showWhen: inn("ut2", "regular", "some") }),
    single("ut6", "Did most of the income arrive unevenly (for example mostly late in the year)?", YES_NO, {
      help: "The IRS describes an annualized income installment method that may reduce the penalty when income is uneven.",
      sources: ["2210"],
    }),
    single("ut7", "Did the {prevYear} return show no tax liability?", YES_NO, {
      help: "The IRS says no penalty applies if you had no tax liability for the prior year, were a U.S. citizen or resident for the entire year, and the prior-year return covered a full 12 months.",
      sources: ["2210"],
    }),
    single("ut8", "Was a retirement after age 62, a disability, a casualty, a disaster or another unusual circumstance behind a missed or short payment?", YES_NO, {
      help: "The IRS may waive the penalty in those situations; a waiver is requested on Form 2210 with an explanation.",
      sources: ["2210"],
      showWhen: anyOf(inn("ut2", "some", "none"), inn("ut5", "no")),
    }),
    single("ut9", "Did the IRS send a notice or bill about an estimated-tax penalty?", YES_NO, {
      help: "The IRS says it will generally figure any penalty and send a bill.",
      sources: ["2210"],
    }),
  ],
  outcomeRules: [
    { when: inn("ut7", "yes"), outcome: "not_applies" },
    {
      when: anyOf(inn("ut2", "some", "none"), inn("ut5", "no"), inn("ut8", "yes"), inn("ut9", "yes")),
      outcome: "applies",
    },
    { when: allOf(inn("ut2", "regular"), inn("ut5", "yes"), inn("ut9", "no")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports facts that may mean an underpayment - the CPA decides whether the form is needed.",
    "Owner reports regular on-time payments and no IRS notice, or no tax last year."
  ),
};

// ── 7. Form 1040-ES - estimated tax for next year ────────────────────────────

const FORM_1040_ES: QuestionnaireDef = {
  id: "form-1040-es",
  version: 1,
  title: "Estimated tax for {nextYear}",
  formLabel: "Form 1040-ES",
  scope: "household",
  intro: "Facts about how {nextYear} income tax is being covered so far, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "es1",
      "How is income tax being covered for {nextYear} so far?",
      [
        o("withholding", "Only through withholding from pay"),
        o("estimates", "Through estimated tax payments"),
        o("both", "Both"),
        o("nothing", "Nothing set up yet"),
        UNSURE,
      ],
      {
        help: "The IRS says taxes must be paid as you earn income, through withholding or estimated tax payments, and that people in business for themselves generally need to make estimated payments.",
        sources: ["EST"],
      }
    ),
    single("es2", "Have {nextYear} estimated payments been made so far?", [o("none", "None yet"), o("some", "Some"), o("all_due", "All that have come due"), UNSURE], {
      showWhen: inn("es1", "estimates", "both"),
    }),
    dollars("es3", "About how much has been paid so far (federal)?", { showWhen: inn("es2", "some", "all_due") }),
    single("es4", "Was W-4 withholding changed for {nextYear}?", YES_NO, {
      help: "The IRS says an employee can ask the employer to withhold more tax by filing a new Form W-4.",
      sources: ["EST"],
      showWhen: inn("es1", "withholding", "both"),
    }),
    single("es5", "Do you expect {nextYear} income to differ from {year}?", [o("higher", "Higher"), o("lower", "Lower"), o("same", "About the same"), UNSURE], {
      help: "The IRS suggests using the prior year's return as a starting point when estimating.",
      sources: ["EST"],
    }),
    single("es6", "Will there be new income sources in {nextYear} (for example rental income starting or ending)?", YES_NO),
  ],
  outcomeRules: [
    { when: inn("es1", "estimates", "both", "nothing"), outcome: "applies" },
    { when: inn("es1", "withholding"), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports estimated payments are in place or still to be set up - the CPA decides whether, how much and when.",
    "Owner reports covering {nextYear} tax through withholding only."
  ),
};

// ── 8. Schedule 3 ────────────────────────────────────────────────────────────

const FORM_SCHEDULE_3: QuestionnaireDef = {
  id: "schedule-3-federal",
  version: 1,
  title: "Additional credits and payments",
  formLabel: "Schedule 3",
  scope: "household",
  intro: "Facts about extension payments and possible credits for {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single("s31", "Was a payment sent with an extension request (Form 4868) for {year}?", YES_NO, {
      help: "The IRS 1040 instructions list an amount paid with a request for an extension to file among the other payments reported in Schedule 3, Part II.",
      sources: ["1040GI"],
    }),
    dollars("s32", "Amount paid with the extension request", { showWhen: inn("s31", "yes") }),
    single("s33", "Did either of you have more than one employer in {year}?", YES_NO, {
      help: "The IRS says that with more than one employer, too much social security tax may have been withheld, which can be taken as a credit; it is figured separately for each spouse.",
      sources: ["1040GI"],
    }),
    multi(
      "s34",
      "Which of these might apply to your {year} return?",
      [
        o("foreign_tax", "Foreign income tax paid"),
        o("education", "Education costs (tuition or similar)"),
        o("dependent_care", "Child or dependent care costs"),
        o("home_energy", "Home solar or other home energy improvements"),
        o("retirement", "Retirement account contributions"),
        o("vehicle", "An electric vehicle purchase"),
        o("none", "None of these", { exclusive: true }),
        UNSURE,
      ],
      {
        help: "The IRS 1040 instructions point to Schedule 3, Part I for nonrefundable credits such as the foreign tax credit and education credits.",
        sources: ["1040GI"],
      }
    ),
    single(
      "s35",
      "Was a home solar system placed in service in a year when the residential clean energy credit has not been claimed?",
      [
        o("yes_unclaimed", "Yes - installed and never claimed", {
          warning: "Also marks Form 5695 as required on the Forms page, as that answer does today.",
        }),
        o("claimed", "Already claimed on a prior return", {
          warning: "Also marks Form 5695 'not applicable' on the Forms page, as that answer does today.",
        }),
        UNSURE,
      ],
      {
        binding: {
          mode: "shared_choice",
          questionKey: "solar_credit",
          bank: { yes_unclaimed: "yes_unclaimed", claimed: "claimed_already", unsure: "unsure" },
        },
      }
    ),
    single("s36", "Do you have last year's Schedule 3 and Form 5695?", YES_NO, { showWhen: inn("s35", "claimed", "unsure") }),
    single("s37", "Do you have the solar contract and the placed-in-service date?", YES_NO, { showWhen: inn("s35", "yes_unclaimed") }),
  ],
  outcomeRules: [
    {
      when: anyOf(
        inn("s31", "yes"),
        inn("s33", "yes"),
        inn("s35", "yes_unclaimed"),
        inn("s34", "foreign_tax", "education", "dependent_care", "home_energy", "retirement", "vehicle")
      ),
      outcome: "applies",
    },
    { when: allOf(inn("s31", "no"), inn("s33", "no"), inn("s34", "none")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports possible additional credits or payments - the CPA decides which apply.",
    "Owner reports no extension payment, single employer and no listed credits."
  ),
};

// ── 9. QBI deduction ─────────────────────────────────────────────────────────

const QB_BUSINESS = inn("qb1", "ekc", "sv", "k1", "other");

const FORM_QBI: QuestionnaireDef = {
  id: "qbi-deduction",
  version: 1,
  title: "Qualified business income deduction",
  formLabel: "QBI deduction",
  scope: "household",
  intro: "Facts about business income or loss in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    multi(
      "qb1",
      "Which of these had business income or loss in {year}?",
      [
        o("ekc", "EK Consulting (Schedule C)", { context: "ekcActive" }),
        o("sv", "Sudden Valley rental (Schedule E)", { context: "svActive" }),
        o("k1", "Partnership or S-corporation income on a K-1"),
        o("other", "Another business or self-employment"),
        o("none", "None", { exclusive: true }),
        UNSURE,
      ],
      {
        help: "The IRS 1040 instructions say the QBI deduction is figured on Form 8995 or Form 8995-A. Performing services as an employee is never a qualified trade or business.",
        sources: ["1040GI", "8995A"],
      }
    ),
    single(
      "qb2",
      "Is EK Consulting's income from giving advice or counsel to clients?",
      [o("all", "Essentially all of it"), o("some", "Some of it"), o("no", "No (products, software or other services)"), UNSURE],
      {
        help: "The Form 8995-A instructions list consulting - giving clients professional advice and counsel - among 'specified service trades or businesses'. Which category applies is for the CPA.",
        sources: ["8995A"],
        showWhen: inn("qb1", "ekc"),
      }
    ),
    single("qb3", "Does EK Consulting pay W-2 wages to employees?", YES_NO, {
      help: "The Form 8995-A instructions use W-2 wages paid by the business as one input to limit the deduction.",
      sources: ["8995A"],
      showWhen: inn("qb1", "ekc"),
    }),
    single("qb4", "Is the rental run as a regular, ongoing activity (for example guests booked throughout the season, with active management)?", YES_NO, {
      help: "The IRS says renting real property may be a trade or business for the QBI deduction if it meets the section 162 standard, and Rev. Proc. 2019-38 provides a safe harbor for a rental real estate enterprise.",
      sources: ["8995"],
      showWhen: inn("qb1", "sv"),
    }),
    single("qb5", "Was there a net business loss from an earlier year carried into {year}?", YES_NO, {
      help: "The IRS says a qualified business net loss is carried forward to the next year.",
      sources: ["8995"],
      showWhen: QB_BUSINESS,
    }),
  ],
  outcomeRules: [
    { when: QB_BUSINESS, outcome: "applies" },
    { when: inn("qb1", "none"), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports business income or loss, so Form 8995 or 8995-A likely applies - the CPA decides whether and how to prepare it.",
    "Owner reports no business income or loss."
  ),
};

// ── 10. Additional Medicare Tax ──────────────────────────────────────────────

const WHO_NONE: readonly QOption[] = [
  o("neither", "Neither of us"),
  o("eric", "Eric"),
  o("eva", "Eva"),
  o("both", "Both of us"),
  UNSURE,
];

const FORM_ADDL_MEDICARE: QuestionnaireDef = {
  id: "additional-medicare-tax",
  version: 1,
  title: "Additional Medicare Tax",
  formLabel: "Form 8959",
  scope: "household",
  intro: "Facts about wages and self-employment income in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single("mt1", "Did either of you have a single W-2 with Medicare wages above $200,000?", WHO_NONE, {
      help: "The Form 8959 instructions say to file it if Medicare wages on any single W-2 (box 5) are greater than $200,000.",
      sources: ["8959"],
    }),
    single("mt2", "Did combined wages plus self-employment income for {year} exceed the Form 8959 threshold for your filing status?", YES_NO, {
      help: "The IRS 1040 instructions give $250,000 if married filing jointly, $200,000 if single, head of household or qualifying surviving spouse, and $125,000 if married filing separately.",
      sources: ["1040GI"],
    }),
    single("mt3", "Did an employer withhold Additional Medicare Tax from pay?", YES_NO, {
      help: "The IRS says an employer may have withheld Additional Medicare Tax even if none is owed; withheld amounts are reported using Form 8959.",
      sources: ["1040GI"],
    }),
    single("mt4", "Did either of you have self-employment income in {year}?", WHO_NONE, {
      help: "The IRS says self-employment income from Schedule SE counts toward the Form 8959 threshold; negative amounts are not considered.",
      sources: ["8959"],
    }),
  ],
  outcomeRules: [
    { when: anyOf(inn("mt1", "eric", "eva", "both"), inn("mt2", "yes"), inn("mt3", "yes")), outcome: "applies" },
    { when: allOf(inn("mt1", "neither"), inn("mt2", "no"), inn("mt3", "no")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports facts that may require Form 8959 - the CPA decides.",
    "Owner reports no wages or income over the thresholds and no Additional Medicare Tax withheld."
  ),
};

// ── 11. Child and dependent credits ──────────────────────────────────────────

const CD_ANY = inn("cd1", "children", "other");
const ALL_SOME_NONE: readonly QOption[] = [o("all", "Yes - all of them"), o("some", "Some of them"), o("none", "None of them"), UNSURE];

const FORM_CHILD_CREDITS: QuestionnaireDef = {
  id: "child-dependent-credits",
  version: 1,
  title: "Child and dependent credits",
  formLabel: "Child / dependent credits",
  scope: "household",
  intro: "Facts about dependents for {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "cd1",
      "Do you claim any dependents?",
      [
        o("none", "No dependents", {
          warning:
            "Also marks the child/dependent credits 'ruled out' on the Planning screen and Forms page, as that answer does today.",
        }),
        o("children", "One or more qualifying children"),
        o("other", "Other dependents (parent, relative, etc.)"),
        UNSURE,
      ],
      {
        binding: {
          mode: "shared_choice",
          questionKey: "household_members",
          bank: { none: "none", children: "children", other: "other_dependents", unsure: null },
        },
      }
    ),
    whole("cd2", "How many dependents?", 1, 20, { showWhen: CD_ANY }),
    single("cd3", "Were all the children under 17 at the end of {year}?", ALL_SOME_NONE, {
      help: "The IRS 1040 instructions use age under 17 at the end of the year as one test for the child tax credit.",
      sources: ["1040GI"],
      showWhen: inn("cd1", "children"),
    }),
    single(
      "cd4",
      "Did each dependent have an SSN, ITIN or ATIN issued on or before the return's due date, including extensions (or an application filed by then)?",
      ALL_SOME_NONE,
      {
        help: "The IRS instructions apply this taxpayer-identification test to the child tax credit and the credit for other dependents.",
        sources: ["1040GI"],
        showWhen: CD_ANY,
      }
    ),
    single("cd5", "Does each child have a valid Social Security number?", ALL_SOME_NONE, {
      help: "The IRS says a qualifying child without a valid SSN cannot be used to claim the child tax credit; another taxpayer ID may still support the credit for other dependents.",
      sources: ["8812"],
      showWhen: inn("cd1", "children"),
    }),
    single("cd6", "Did each dependent live with you for more than half of {year}?", ALL_SOME_NONE, {
      help: "The IRS qualifying-child tests use whether the child lived with you for more than half the year, with exceptions.",
      sources: ["1040GI"],
      showWhen: CD_ANY,
    }),
    single("cd7", "Could anyone else (such as the other parent or a grandparent) also claim any of them?", YES_NO, { showWhen: CD_ANY }),
    single("cd8", "Were child or dependent care costs paid in {year}?", YES_NO, {
      help: "The IRS says dependent care benefits are shown in box 10 of the W-2 and to complete Form 2441 to see how much can be excluded.",
      sources: ["1040GI"],
      showWhen: CD_ANY,
    }),
    single(
      "cd9",
      "Who is the dependent?",
      [o("parent", "A parent"), o("other_relative", "Another relative"), o("other_person", "Someone else"), UNSURE],
      { showWhen: inn("cd1", "other") }
    ),
  ],
  outcomeRules: [
    { when: inn("cd1", "none"), outcome: "not_applies" },
    { when: CD_ANY, outcome: "applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports dependents - the CPA determines the credits and forms.",
    "Owner reports no dependents."
  ),
};

// ── 12. Clean vehicle credit ─────────────────────────────────────────────────

const EV_YES = inn("ev1", "yes_new", "yes_used");

const FORM_CLEAN_VEHICLE: QuestionnaireDef = {
  id: "clean-vehicle-credit",
  version: 1,
  title: "Clean vehicle credit",
  formLabel: "Clean vehicle credit",
  scope: "household",
  intro: "Facts about any plug-in electric or fuel-cell vehicle acquired in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "ev1",
      "Did you acquire a plug-in electric or fuel-cell vehicle in {year}?",
      [
        o("yes_new", "Yes - a new vehicle"),
        o("yes_used", "Yes - a previously owned vehicle"),
        o("no", "No", {
          warning:
            "Also marks the clean vehicle credit 'ruled out' on the Planning screen and Forms page, as that answer does today.",
        }),
        UNSURE,
      ],
      {
        help: "IRS Form 8936 covers the new clean vehicle credit, the previously owned clean vehicle credit and the qualified commercial clean vehicle credit.",
        sources: ["8936"],
        binding: {
          mode: "shared_choice",
          questionKey: "ev_vehicle",
          bank: { yes_new: "yes_new", yes_used: null, no: "no", unsure: null },
        },
      }
    ),
    single("ev2", "When was it acquired?", [o("before", "On or before September 30, 2025"), o("after", "After September 30, 2025"), UNSURE], {
      help: "The IRS says clean vehicle credits cannot be claimed for vehicles acquired after September 30, 2025, and a vehicle is 'acquired' when a written binding contract is entered into and a payment (including a nominal down payment or a trade-in) has been made.",
      sources: ["8936"],
      showWhen: EV_YES,
    }),
    single("ev3", "How is the vehicle used?", [o("personal", "Personal use"), o("business", "Used in a business"), o("both", "Both"), UNSURE], {
      help: "The IRS says the vehicle must be acquired for use, not for resale, and a separate credit exists for qualified commercial clean vehicles.",
      sources: ["8936"],
      showWhen: EV_YES,
    }),
    single("ev4", "Was the credit transferred to the dealer at the sale (a lower price at purchase)?", YES_NO, {
      help: "The IRS says a credit transferred to a registered dealer at the time of sale is reported using Form 8936 and Schedule A (Form 8936).",
      sources: ["1040GI"],
      showWhen: EV_YES,
    }),
    single("ev5", "Was the vehicle placed in service (first used) in {year}?", YES_NO, {
      help: "The IRS says the credits are for clean vehicles placed in service during your tax year.",
      sources: ["8936"],
      showWhen: EV_YES,
    }),
    single("ev6", "Do you have the purchase contract and dealer paperwork?", YES_NO, { showWhen: EV_YES }),
  ],
  outcomeRules: [
    { when: inn("ev1", "no"), outcome: "not_applies" },
    { when: allOf(EV_YES, inn("ev2", "before")), outcome: "applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports a vehicle acquired on or before September 30, 2025 - the CPA determines eligibility.",
    "Owner reports no vehicle purchase.",
    "Owner is unsure or reports facts the CPA must assess (such as an acquisition date after September 30, 2025)."
  ),
};

// ── 13. Schedule K-1 handling (card only when K-1 documents are on file) ─────

const FORM_K1: QuestionnaireDef = {
  id: "k1-handling",
  version: 1,
  title: "Schedule K-1 handling",
  formLabel: "Schedule K-1",
  scope: "household",
  intro: "Facts about the K-1 documents on file for {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "kh1",
      "What kind of entity issued the K-1?",
      [
        o("partnership", "A partnership or multi-member LLC"),
        o("s_corp", "An S corporation"),
        o("trust", "An estate or trust"),
        UNSURE,
      ],
      {
        help: "The IRS describes Schedule K-1 as reporting your share of income, deductions and credits from a partnership (Form 1065) or an S corporation (Form 1120-S).",
        sources: ["1065", "1120S"],
      }
    ),
    single("kh2", "Whose K-1 is it?", [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), UNSURE]),
    single("kh3", "Do you work in the business, or only hold an investment?", [o("works", "I work in the business"), o("invests", "Only an investment"), UNSURE]),
    single("kh4", "Does the K-1 show income, a loss, or both?", [o("income", "Income"), o("loss", "A loss"), o("both", "Both"), UNSURE]),
    single("kh5", "Did you receive cash from the entity in {year}?", YES_NO),
    single("kh6", "Does the K-1 show guaranteed payments?", YES_NO, {
      help: "The IRS says you must also pay self-employment tax on your share of certain partnership income and on guaranteed payments.",
      sources: ["SE"],
      showWhen: inn("kh1", "partnership"),
    }),
    single("kh7", "Was Connecticut pass-through entity tax paid by the entity on your behalf?", YES_NO, {
      help: "Connecticut says the pass-through entity tax is optional and is elected by the entity.",
      sources: ["CTPET"],
      showWhen: inn("kh1", "partnership", "s_corp"),
    }),
    single("kh8", "Is this K-1 final, or are corrections expected?", [o("final", "Final"), o("correction", "Corrections are expected"), UNSURE]),
  ],
  outcomeRules: [{ when: inn("kh1", "partnership", "s_corp", "trust"), outcome: "applies" }],
  outcomeDefault: "unsure",
  // "not_applies" is never produced (a K-1 on file means there is something to handle); the text exists so the table is complete.
  outcomeText: outcomes(
    "Owner reports a K-1 was received - the CPA decides how it is handled.",
    "Owner reports no K-1 was received.",
    "Owner is unsure what issued the K-1 - the CPA decides."
  ),
};

// ── 14. Schedule SE (card only when the draft cannot decide) ─────────────────

const FORM_SCHEDULE_SE: QuestionnaireDef = {
  id: "schedule-se",
  version: 1,
  title: "Self-employment tax",
  formLabel: "Schedule SE",
  scope: "household",
  intro: "Facts about self-employment income in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "se1",
      "For {year}, did EK Consulting have a net profit, a net loss, or neither?",
      [o("profit", "A net profit"), o("loss", "A net loss"), o("neither", "Neither"), UNSURE],
      {
        help: "The IRS says Schedule SE is required when line 4c of the schedule is $400 or more, and that even with a loss or small amount it may be to your benefit to file and use an optional method. The CPA works this out.",
        sources: ["SE"],
      }
    ),
    single("se2", "Any other self-employment income in {year} (side work, 1099 income, partnership guaranteed payments)?", YES_NO, {
      help: "The IRS says you must also pay self-employment tax on certain partnership income and guaranteed payments.",
      sources: ["SE"],
    }),
    single("se3", "Whose other self-employment income?", [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), UNSURE], {
      showWhen: inn("se2", "yes"),
    }),
    single("se4", "Were estimated payments made toward self-employment tax?", YES_NO),
  ],
  outcomeRules: [
    { when: anyOf(inn("se1", "profit"), inn("se2", "yes")), outcome: "applies" },
    { when: allOf(inn("se1", "neither"), inn("se2", "no")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports self-employment profit or other self-employment income - the CPA decides on Schedule SE.",
    "Owner reports no self-employment profit or income.",
    "Owner is unsure or reports a loss - the CPA decides."
  ),
};

// ── 15. Separate federal entity return (per entity) ──────────────────────────

const FORM_ENTITY_FEDERAL: QuestionnaireDef = {
  id: "entity-federal-return",
  version: 1,
  title: "Separate federal entity return",
  formLabel: "Entity return",
  scope: "entity",
  intro: "Facts about how {entity} is owned and classified, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single("ef1", "How many owners does {entity} have?", [o("one", "One"), o("multiple", "Two or more"), UNSURE], {
      help: "The IRS says an LLC with only one member is treated as disregarded as separate from its owner for income tax unless it files Form 8832 to be treated as a corporation, and a domestic LLC with at least two members is classified as a partnership unless it elects otherwise.",
      sources: ["LLC"],
    }),
    single("ef2", "Who are the owners?", [o("us_only", "Eric and Eva only"), o("others", "Includes someone else"), UNSURE], {
      showWhen: inn("ef1", "multiple"),
    }),
    single(
      "ef3",
      "Has {entity} filed an election to be taxed as a corporation (Form 8832) or as an S corporation (Form 2553)?",
      [
        o("none", "No election"),
        o("corp", "Corporation election (Form 8832)"),
        o("s_corp", "S corporation election (Form 2553)"),
        UNSURE,
      ],
      { sources: ["8832", "2553"] }
    ),
    single(
      "ef4",
      "Did {entity} file a separate federal return for a prior year?",
      [
        o("no", "No"),
        o("partnership", "Yes - Form 1065"),
        o("s_corp", "Yes - Form 1120-S"),
        o("other", "Yes - another form"),
        UNSURE,
      ],
      { sources: ["1065", "1120S"] }
    ),
    single(
      "ef5",
      "Does {entity} have employees or its own EIN?",
      [o("employees", "It has employees"), o("ein_only", "It has an EIN but no employees"), o("neither", "Neither"), UNSURE],
      {
        help: "The IRS says a single-member LLC that is disregarded for income tax is still a separate entity for employment tax and certain excise taxes, and needs an EIN if it has employees.",
        sources: ["SMLLC"],
      }
    ),
    single(
      "ef6",
      "When did {entity} begin operating?",
      [o("before", "Before {year}"), o("during", "During {year}"), o("not_yet", "Not yet"), UNSURE]
    ),
    single(
      "ef7",
      "Where has the entity's income been reported so far?",
      [
        o("personal", "On our personal return (Schedule C or E)"),
        o("separate", "On a separate entity return"),
        o("not_yet", "Not yet reported"),
        UNSURE,
      ]
    ),
  ],
  outcomeRules: [
    { when: anyOf(inn("ef1", "multiple"), inn("ef3", "corp", "s_corp")), outcome: "applies" },
    { when: allOf(inn("ef1", "one"), inn("ef3", "none")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports more than one owner or a corporate election - the CPA decides whether a separate federal return is needed.",
    "Owner reports one owner and no election; the IRS describes that as a disregarded entity - the CPA confirms."
  ),
};

// ── 16. Connecticut business-entity filing (per entity) ──────────────────────

const FORM_ENTITY_CT: QuestionnaireDef = {
  id: "entity-ct-filing",
  version: 1,
  title: "Connecticut business-entity filing",
  formLabel: "CT entity filing",
  scope: "entity",
  intro: "Facts about how {entity} reports and does business in Connecticut, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  nodes: [
    single(
      "cf1",
      "How does {entity} report to the IRS?",
      [
        o("household", "On our personal return (disregarded)"),
        o("partnership", "As a partnership (Form 1065)"),
        o("s_corp", "As an S corporation (Form 1120-S)"),
        o("corp", "As a corporation"),
        UNSURE,
      ]
    ),
    single("cf2", "Is the entity considering the optional Connecticut pass-through entity tax?", YES_NO, {
      help: "Connecticut says the pass-through entity tax is optional; the election is made each year by checking a box on a timely filed Form CT-1065/CT-1120SI, and the entity must first complete the federal Form 1065 or 1120-S.",
      sources: ["CTPET"],
      showWhen: inn("cf1", "partnership", "s_corp"),
    }),
    single("cf3", "Did {entity} do business or have income connected to Connecticut in {year}?", YES_NO, {
      help: "Connecticut says an entity that does business in Connecticut or has income from Connecticut sources may elect to file the pass-through entity tax return.",
      sources: ["CTPET"],
    }),
    single("cf4", "Did {entity} pay wages to employees in {year}?", YES_NO),
    single("cf5", "Did {entity} collect or pay any other Connecticut state taxes itself (not income tax)?", YES_NO),
    single(
      "cf6",
      "Do you have copies of Connecticut filings the entity made last year?",
      [o("have", "Yes"), o("none_filed", "None were filed"), o("dont_have", "Filed but I do not have copies"), UNSURE]
    ),
  ],
  outcomeRules: [
    { when: inn("cf1", "partnership", "s_corp", "corp"), outcome: "applies" },
    { when: allOf(inn("cf1", "household"), inn("cf4", "no"), inn("cf5", "no")), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports a partnership, S corporation or corporation - the CPA decides which Connecticut filings apply.",
    "Owner reports a disregarded entity with no employees and no other Connecticut state taxes - the CPA confirms."
  ),
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const QUESTIONNAIRES: readonly QuestionnaireDef[] = [
  FORM_8829,
  FORM_4562,
  FORM_8582,
  FORM_8880,
  FORM_8889,
  FORM_2210,
  FORM_1040_ES,
  FORM_SCHEDULE_3,
  FORM_QBI,
  FORM_ADDL_MEDICARE,
  FORM_CHILD_CREDITS,
  FORM_CLEAN_VEHICLE,
  FORM_K1,
  FORM_SCHEDULE_SE,
  FORM_ENTITY_FEDERAL,
  FORM_ENTITY_CT,
];

export function questionnaireById(id: string): QuestionnaireDef | null {
  return QUESTIONNAIRES.find((q) => q.id === id) ?? null;
}

/** Entity-scoped questionnaire ids (the Forms catalog maps an entity entry to one of these). */
export const ENTITY_FEDERAL_QUESTIONNAIRE_ID = "entity-federal-return";
export const ENTITY_CT_QUESTIONNAIRE_ID = "entity-ct-filing";
