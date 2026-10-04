// Content for the CPA-input questionnaires (data only - the engine is
// lib/tax-questionnaire.ts). Every definition is DATA: question id, text,
// options, "shows when" rules and an optional derived outcome. Branching is never
// hard-coded in a component.
//
// Ground rules for this copy (CLAUDE.md #1 and #8):
//   * Questions gather facts for the CPA. They never advise, and the derived outcome
//     shown on a card is always phrased "Owner reports ..." (it never states a tax
//     amount or an eligibility conclusion). Since Phase 1b the owner's answers ALSO
//     feed the computed draft return (lib/tax2025, through lib/tax2025/answers.ts),
//     which computes amounts, credits and eligibility from them with cited rules;
//     the questionnaire itself still computes nothing.
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
  type QNode,
  type QOption,
  type QuestionnaireDef,
  type SourceId,
} from "@/lib/tax-questionnaire";
import { NONE_GROUP_IDS, type NoneGroupId } from "@/lib/tax2025/line-catalog";

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
  SCH1A: { title: "Schedule 1-A (Form 1040) 2025", url: "https://www.irs.gov/pub/irs-pdf/f1040s1a.pdf", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "8880F": { title: "Form 8880 (2025)", url: "https://www.irs.gov/pub/irs-pdf/f8880.pdf", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "590A": { title: "Publication 590-A (2025), Contributions to Individual Retirement Arrangements", url: "https://www.irs.gov/publications/p590a", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  "2210F": { title: "Form 2210 (2025)", url: "https://www.irs.gov/pub/irs-pdf/f2210.pdf", verifiedOn: VERIFIED, basisTaxYear: 2025 },
  CT1040I: {
    title: "Form CT-1040 instructions (Rev. 12/25)",
    url: "https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf",
    verifiedOn: VERIFIED,
    basisTaxYear: 2025,
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
      "Did Eric use part of your home (a room, or a separate building on the property) for EK Consulting work in {year}?",
      [
        o("yes_exclusive", "Yes - a space used regularly and only for EK Consulting"),
        o("yes_shared", "Yes - but the space is also used personally", {
          warning:
            "Also marks the home-office deduction 'ruled out' on the Planning screen and Forms page, as that answer does today; the CPA can still review it.",
        }),
        o("no", "No - no part of the home was used for the business"),
        UNSURE,
      ],
      {
        help: "The IRS instructions generally allow a deduction only for a part of the home used exclusively (only for business) and on a regular basis as your principal (main) place of business, to meet clients, or as a separate structure not attached to the home.",
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
      "What kind of space did Eric use for EK Consulting?",
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
      "What is the space used for in the EK Consulting business (pick all that apply)?",
      [
        o("admin", "Administrative or management work (billing, scheduling, bookkeeping)"),
        o("clients", "Meeting clients or customers in person"),
        o("other_work", "Other work or services for clients"),
        o("storage", "Storing inventory or product samples"),
        UNSURE,
      ],
      {
        help: "The IRS instructions list billing customers or clients as an example of administrative or management work, and treat storage of inventory or product samples as an exception to the rule that the space be used only for the business.",
        sources: ["8829"],
        showWhen: HO_YES,
      }
    ),
    single("ho4", "Is there any other fixed location, such as an outside office, where Eric does substantial administrative or management work (billing, scheduling, bookkeeping) for EK Consulting?", YES_NO, {
      help: "The IRS instructions say the home office qualifies as the principal place of business only if you have no other fixed location where you do substantial administrative or management activities.",
      sources: ["8829"],
      showWhen: inn("ho3", "admin"),
    }),
    whole("ho5", "About how many square feet is the space used for EK Consulting (whole number)?", 1, 99999, {
      showWhen: HO_YES,
      binding: { mode: "shared_number", questionKey: "home_office_sqft", format: "whole_number" },
    }),
    single(
      "ho6",
      "On an earlier year's tax return, was a home office deduction claimed for this space?",
      [
        o("simplified", "Yes - using the simplified method"),
        o("actual", "Yes - actual expenses (Form 8829)"),
        o("first_year", "No - this would be the first year it is claimed"),
        UNSURE,
      ],
      {
        help: "The IRS instructions explain how switching between the simplified and actual-expense methods affects carryover amounts (unused amounts carried to later years).",
        sources: ["8829"],
        showWhen: HO_YES,
      }
    ),
    single("ho7", "Do you own or rent the home or property where this space is?", [o("own", "Own"), o("rent", "Rent"), UNSURE], { showWhen: HO_YES }),
    single(
      "ho8",
      "Was the space used for EK Consulting for the whole of {year}?",
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
      "In {year}, did EK Consulting start using any equipment or other long-lasting business assets (such as computers, furniture or a vehicle), or does it still own any that the CPA should review?",
      [
        o("none", "None"),
        o("some", "Yes - I will list them in the app's fixed-asset register"),
        UNSURE,
      ],
      {
        help: "The IRS says Form 4562 is filed to claim depreciation (deducting the cost of an asset over time) for property placed in service (first used for business) during the tax year, a section 179 deduction, or depreciation on any vehicle or other listed property. The app only records inputs; it never computes depreciation.",
        sources: ["4562"],
        context: "ekcActive",
        binding: { mode: "shared_choice", questionKey: "fixed_assets_ekc", bank: { none: "none", some: "some", unsure: null } },
      }
    ),
    single("da2", "Did Sudden Valley own a building or other long-lasting property (such as furniture or appliances for the rental) in {year}?", [o("none", "None"), o("some", "Yes - I will list it in the app's fixed-asset register"), UNSURE], {
      context: "svActive",
      binding: { mode: "shared_choice", questionKey: "fixed_assets_sv", bank: { none: "none", some: "some", unsure: null } },
    }),
    multi(
      "da3",
      "What kinds of assets are they (pick all that apply)?",
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
    single("da4", "How is the business vehicle used (only for the business, or for both business and personal driving)?", [o("business_only", "Only for business"), o("mixed", "Business and personal"), UNSURE], {
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
    single("da6", "Were the renovation or improvement costs paid before the building was first rented?", YES_NO, { showWhen: inn("da3", "improvements") }),
    single(
      "da7",
      "Do you have the purchase invoices (or, for a building, the closing statement from the purchase) for these assets?",
      [o("all", "Yes - for all of them"), o("some", "For some of them"), o("none", "No"), UNSURE],
      { showWhen: DA_SOME }
    ),
    single(
      "da8",
      "On an earlier year's tax return, was depreciation (deducting the asset's cost over time) claimed on any of these assets?",
      [o("yes", "Yes - an earlier year's Form 4562 exists"), o("no", "No"), UNSURE],
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
  "The IRS material-participation tests (the tests for how involved you were in the activity) include more than 100 hours and more than 500 hours, and say participation may be shown by any reasonable means such as calendars or narrative summaries. Whether a test is met is for the CPA.";

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
      "In {year}, on average, how long did guests stay at the Sudden Valley rental?",
      [o("avg7", "7 days or less"), o("avg30", "8 to 30 days"), o("over30", "More than 30 days"), UNSURE],
      {
        help: "The IRS instructions say a rental is not treated as a 'rental activity' for these rules when the average period of customer use is 7 days or less, or 30 days or less with significant personal services. How the average is figured is for the CPA.",
        sources: ["8582"],
      }
    ),
    single("pa2", "In {year}, were significant personal services provided to guests at the rental (services that people perform for guests during their stay)?", YES_NO, {
      help: "The IRS says significant personal services include only services performed by individuals and depend on the facts and circumstances.",
      sources: ["8582"],
      showWhen: inn("pa1", "avg30"),
    }),
    single(
      "pa3",
      "For {year}, did the Sudden Valley rental have a net loss, a net profit, or neither (rental income minus rental expenses; choose neither if there was no rental yet)?",
      [o("loss", "A net loss"), o("profit", "A net profit"), o("neither", "Neither, or no rental yet"), UNSURE],
      {
        help: "The IRS instructions say Form 8582 is used to figure any passive activity loss, which occurs when losses from passive activities exceed income from them.",
        sources: ["8582"],
      }
    ),
    single(
      "pa4",
      "Who does the day-to-day work at the rental (guest messaging, cleaning, repairs)?",
      [o("us", "Mostly Eric and Eva"), o("shared", "Shared with a manager or cleaners"), o("others", "Mostly others"), UNSURE]
    ),
    single("pa5", "About how many hours did Eric personally work on the Sudden Valley rental in {year} (a best estimate is fine)?", PA_HOURS, {
      help: PA_HOURS_HELP,
      sources: ["8582"],
      showWhen: inn("pa1", "avg7", "avg30", "unsure"),
    }),
    single("pa6", "About how many hours did Eva personally work on the Sudden Valley rental in {year} (a best estimate is fine)?", PA_HOURS, {
      help: PA_HOURS_HELP,
      sources: ["8582"],
      showWhen: inn("pa1", "avg7", "avg30", "unsure"),
    }),
    single("pa7", "In {year}, did Eric or Eva make management decisions for the rental (approving guests or tenants, setting rates, approving repairs)?", YES_NO, {
      help: "The IRS says active participation is a less stringent requirement than material participation.",
      sources: ["8582"],
      showWhen: inn("pa1", "avg30", "over30", "unsure"),
    }),
    single("pa8", "In {year}, did Eric or Eva work mainly in real estate (real estate is their main occupation, not just owning the rental)?", YES_NO, {
      help: "The IRS instructions treat rental real estate in which you materially participated as an exception only if you were a 'real estate professional'.",
      sources: ["8582"],
    }),
    single("pa9", "Were any losses from the rental or other passive activities (activities you do not actively work in) left unused on earlier returns and carried forward?", YES_NO, {
      help: "The IRS instructions say Form 8582 also reports the use of prior-year unallowed passive losses.",
      sources: ["8582"],
    }),
    single("pa10", "In {year}, did you have any other passive activities (such as a business or partnership you do not work in), apart from the Sudden Valley rental?", YES_NO),
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
      "Who made contributions for {year} to a retirement account, such as an Individual Retirement Account (IRA) or a 401(k) at work?",
      [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), o("neither", "Neither of us"), UNSURE],
      {
        help: "The IRS says the saver's credit is based on contributions to a traditional or Roth IRA, elective deferrals to a 401(k), 403(b), governmental 457(b), SARSEP or SIMPLE plan, voluntary after-tax employee contributions to a qualified plan or 403(b), a 501(c)(18)(D) plan, or an ABLE (Achieving a Better Life Experience) account you are the designated beneficiary of. Health Savings Account (HSA) contributions are not on that list (see the Form 8889 questionnaire).",
        sources: ["SAVER"],
      }
    ),
    multi(
      "sv2",
      "What kinds of accounts did the contributions go into (pick all that apply)?",
      [
        o("ira_trad", "Traditional IRA"),
        o("ira_roth", "Roth IRA"),
        o("deferral", "Money taken from pay into a workplace plan (401(k), 403(b), governmental 457(b), SIMPLE, SARSEP)"),
        o("after_tax", "Voluntary after-tax contributions to a workplace plan"),
        o("able", "ABLE account"),
        o("other", "Something else"),
        UNSURE,
      ],
      { showWhen: SV_POSITIVE }
    ),
    single("sv3", "In the last few years, did Eric or Eva receive a distribution (take money out) from a retirement plan, IRA or ABLE account, other than a rollover into another retirement account?", YES_NO, {
      help: "The IRS says eligible contributions may be reduced by recent distributions, and rollover contributions do not qualify.",
      sources: ["SAVER"],
      showWhen: SV_POSITIVE,
    }),
    single("sv4", "In {year}, was Eric or Eva a full-time student during any part of 5 different months, or claimed as someone else's dependent (for example by a parent)?", YES_NO, {
      help: "The IRS says you must be 18 or older, not claimed as a dependent on another person's return, and not a student; a student is someone enrolled full time during any part of 5 calendar months of the year.",
      sources: ["SAVER"],
      showWhen: SV_POSITIVE,
    }),
    dollars("sv5", "About how much did Eric and Eva contribute in total to these accounts for {year}, not counting a Health Savings Account (HSA), in dollars?", { showWhen: SV_POSITIVE }),
    single(
      "sv6",
      "Do you have account statements or other paperwork showing each contribution?",
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
    "Owner reports retirement contributions and no student/dependent status - the answers feed the computed saver's credit (none above the Form 8880 income limit); the CPA confirms the result.",
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
  intro: "Facts about health-plan coverage and Health Savings Account (HSA) activity in {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  planningLinks: [{ key: "retirement_contributions", label: "Retirement contributions (Planning answer)" }],
  nodes: [
    single(
      "hs1",
      "Which of you was covered by a high-deductible health plan (HDHP) that can be paired with a Health Savings Account (HSA) for any part of {year}? (Your insurer or employer can tell you whether the plan is HSA-eligible.)",
      [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), o("neither", "Neither of us"), UNSURE],
      {
        help: "The IRS says to be eligible to have contributions made to an HSA you must be covered under a high deductible health plan and have no other health coverage except certain disregarded coverage.",
        sources: ["8889"],
      }
    ),
    single(
      "hs2",
      "What kind of HDHP coverage was it in {year} - self-only (covering just one person) or family?",
      [o("self_only", "Self-only"), o("family", "Family"), o("changed", "It changed during the year"), UNSURE],
      {
        help: "The IRS contribution limit depends on self-only versus family coverage; if both spouses are eligible and either has family coverage, both are treated as having family coverage.",
        sources: ["8889"],
        showWhen: HS_POSITIVE,
      }
    ),
    single("hs3", "Was money contributed to an HSA for {year}, whether by you, through payroll deduction at work, or by an employer?", YES_NO, { showWhen: HS_POSITIVE }),
    multi(
      "hs4",
      "How was the money put into the HSA (pick all that apply)?",
      [
        o("payroll", "Through payroll deduction at work"),
        o("employer", "The employer contributed on our behalf"),
        o("direct", "We deposited it ourselves, not through payroll"),
        UNSURE,
      ],
      {
        help: "The IRS says payroll contributions through a cafeteria plan (an employer's pre-tax benefits plan) are treated as employer contributions and are shown on the W-2 in box 12 with code W.",
        sources: ["8889"],
        showWhen: inn("hs3", "yes"),
      }
    ),
    dollars("hs5", "About how much did you deposit yourselves into an HSA for {year} (not through payroll), in dollars?", { showWhen: inn("hs4", "direct") }),
    single("hs6", "Do you have the {year} W-2 from the employer showing an amount in box 12 with code W (HSA contributions through the employer or payroll)?", YES_NO, { showWhen: inn("hs4", "payroll", "employer") }),
    single("hs7", "Did Eric or Eva take money out of an HSA in {year} (any withdrawals are shown on Form 1099-SA, box 1)?", YES_NO, {
      help: "The IRS says anyone who received HSA distributions must file Form 8889 even with no taxable income; distributions are shown on Form 1099-SA, box 1.",
      sources: ["8889"],
      showWhen: HS_POSITIVE,
    }),
    single("hs8", "Was all of the money taken out of the HSA spent on medical costs?", [o("all", "Yes - all of it"), o("part", "Only part of it"), o("none", "None of it"), UNSURE], {
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
    "Owner reports HSA contributions or withdrawals, so Form 8889 likely applies - the Return completeness answers feed the computed HSA deduction; the CPA decides whether and how to prepare it.",
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
  intro: "Facts about tax withheld from pay and estimated tax payments for {year}, for the CPA to review.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  planningLinks: [{ key: "estimated_taxes_2025", label: "Estimated taxes paid (Planning answer)" }],
  nodes: [
    single(
      "ut1",
      "Did your employers withhold federal income tax from your regular paychecks during {year}? (This is the ordinary amount taken out of each paycheck and shown in box 2 of your W-2s, not money collected by the IRS for back taxes.)",
      YES_NO
    ),
    single(
      "ut2",
      "Did you make federal estimated tax payments for {year} (payments you sent to the IRS yourselves during the year, not tax taken out of paychecks)?",
      [o("regular", "Yes - on a regular schedule"), o("some", "Yes - some payments, but not on a regular schedule"), o("none", "No"), UNSURE],
      {
        help: "The IRS says Form 2210 is used to see if you owe a penalty for underpaying estimated tax. The IRS says it will generally figure the penalty for you, and that the form is only filed when a situation requires it, such as requesting a waiver.",
        sources: ["2210"],
      }
    ),
    dollars("ut3", "What was the total of your estimated tax payments for {year}, federal and Connecticut combined, in dollars?", {
      showWhen: inn("ut2", "regular", "some"),
      binding: { mode: "shared_number", questionKey: "estimated_tax_payments_amount", format: "whole_dollars" },
    }),
    dollars("ut4", "Of that total, about how much was federal (paid to the IRS rather than Connecticut), in dollars?", { showWhen: inn("ut2", "regular", "some") }),
    single("ut5", "Were all of those estimated payments made by their due dates?", YES_NO, { showWhen: inn("ut2", "regular", "some") }),
    single("ut6", "In {year}, did your income arrive unevenly during the year (for example, most of it late in the year)?", YES_NO, {
      help: "The IRS describes an annualized income installment method that may reduce the penalty when income is uneven.",
      sources: ["2210"],
    }),
    single("ut7", "Did your {prevYear} federal return show no tax liability (a total tax of zero for that year)?", YES_NO, {
      help: "The IRS says no penalty applies if you had no tax liability for the prior year, were a U.S. citizen or resident for the entire year, and the prior-year return covered a full 12 months.",
      sources: ["2210"],
    }),
    single("ut8", "Was a missed or too-small estimated payment caused by a retirement after age 62, a disability, a casualty (a sudden loss such as a fire), a disaster or another unusual circumstance?", YES_NO, {
      help: "The IRS may waive the penalty in those situations; a waiver is requested on Form 2210 with an explanation.",
      sources: ["2210"],
      showWhen: anyOf(inn("ut2", "some", "none"), inn("ut5", "no")),
    }),
    single("ut9", "Did the IRS send a notice or bill about a penalty for underpaying estimated tax for {year}?", YES_NO, {
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
    "Owner reports facts that may mean an underpayment - the draft return shows a regular-method penalty estimate; the CPA decides whether the form is needed.",
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
      "How is {nextYear} income tax being paid so far (withholding from pay, estimated tax payments you send in yourselves, or both)?",
      [
        o("withholding", "Only through withholding from pay"),
        o("estimates", "Through estimated tax payments we send in ourselves"),
        o("both", "Both"),
        o("nothing", "Nothing set up yet"),
        UNSURE,
      ],
      {
        help: "The IRS says taxes must be paid as you earn income, through withholding or estimated tax payments, and that people in business for themselves generally need to make estimated payments.",
        sources: ["EST"],
      }
    ),
    single("es2", "Have any {nextYear} estimated tax payments (federal or Connecticut) been made so far?", [o("none", "None yet"), o("some", "Some"), o("all_due", "All that have come due"), UNSURE], {
      showWhen: inn("es1", "estimates", "both"),
    }),
    dollars("es3", "About how much has been paid so far toward {nextYear} federal estimated tax, in dollars?", { showWhen: inn("es2", "some", "all_due") }),
    single("es4", "Did Eric or Eva change the tax withholding from their pay for {nextYear} (by giving the employer a new Form W-4)?", YES_NO, {
      help: "The IRS says an employee can ask the employer to withhold more tax by filing a new Form W-4.",
      sources: ["EST"],
      showWhen: inn("es1", "withholding", "both"),
    }),
    single("es5", "Do you expect your household's income in {nextYear} to be higher, lower or about the same as in {year}?", [o("higher", "Higher"), o("lower", "Lower"), o("same", "About the same"), UNSURE], {
      help: "The IRS suggests using the prior year's return as a starting point when estimating.",
      sources: ["EST"],
    }),
    single("es6", "Will your household have a new source of income, or lose one, in {nextYear} (for example rental income starting or ending)?", YES_NO),
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
    single("s31", "Did you send a payment to the IRS with a request for more time to file your {year} return (Form 4868)?", YES_NO, {
      help: "The IRS 1040 instructions list an amount paid with a request for an extension to file among the other payments reported in Schedule 3, Part II.",
      sources: ["1040GI"],
    }),
    dollars("s32", "How much did you pay with the extension request, in dollars?", { showWhen: inn("s31", "yes") }),
    single("s33", "In {year}, did Eric or Eva have more than one employer (more than one W-2 for the same person)?", YES_NO, {
      help: "The IRS says that with more than one employer, too much social security tax may have been withheld, which can be taken as a credit; it is figured separately for each spouse.",
      sources: ["1040GI"],
    }),
    multi(
      "s34",
      "Which of these did Eric and Eva have or pay in {year} (pick all that apply)?",
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
      "Do you have a home solar system, installed and ready to use (placed in service), for which the residential clean energy credit has not yet been claimed?",
      [
        o("yes_unclaimed", "Yes - installed and never claimed", {
          warning: "Also marks Form 5695 as required on the Forms page, as that answer does today.",
        }),
        o("claimed", "Installed, and the credit was already claimed on a prior return", {
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
    single("s36", "Do you have the Schedule 3 and Form 5695 from the earlier return that claimed the solar credit?", YES_NO, { showWhen: inn("s35", "claimed", "unsure") }),
    single("s37", "Do you have the solar installation contract and the date the system was ready to use (the placed-in-service date)?", YES_NO, { showWhen: inn("s35", "yes_unclaimed") }),
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
    "Owner reports possible additional credits or payments - the draft return computes the foreign tax credit, the saver's credit and the extension payment; the CPA decides which other credits apply.",
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
      "Which of these had business income or a business loss in {year} (pick all that apply)?",
      [
        o("ekc", "EK Consulting (Schedule C)", { context: "ekcActive" }),
        o("sv", "Sudden Valley rental (Schedule E)", { context: "svActive" }),
        o("k1", "Income from a partnership or S corporation, shown on a Schedule K-1"),
        o("other", "Another business or self-employment"),
        o("none", "None", { exclusive: true }),
        UNSURE,
      ],
      {
        help: "The IRS 1040 instructions say the qualified business income (QBI) deduction is figured on Form 8995 or Form 8995-A. Performing services as an employee is never a qualified trade or business.",
        sources: ["1040GI", "8995A"],
      }
    ),
    single(
      "qb2",
      "How much of EK Consulting's income comes from giving clients professional advice or counsel (consulting)?",
      [o("all", "Essentially all of it"), o("some", "Some of it"), o("no", "None of it (it comes from products, software or other services)"), UNSURE],
      {
        help: "The Form 8995-A instructions list consulting - giving clients professional advice and counsel - among 'specified service trades or businesses'. Which category applies is for the CPA.",
        sources: ["8995A"],
        showWhen: inn("qb1", "ekc"),
      }
    ),
    single("qb3", "Did EK Consulting pay wages to employees (reported on W-2 forms) in {year}?", YES_NO, {
      help: "The Form 8995-A instructions use W-2 wages paid by the business as one input to limit the deduction.",
      sources: ["8995A"],
      showWhen: inn("qb1", "ekc"),
    }),
    single("qb4", "Is the Sudden Valley rental run as a regular, ongoing business activity (for example guests booked throughout the season, with active management)?", YES_NO, {
      help: "The IRS says renting real property may be a trade or business for the QBI deduction if it meets the section 162 standard, and Rev. Proc. 2019-38 provides a safe harbor for a rental real estate enterprise.",
      sources: ["8995"],
      showWhen: inn("qb1", "sv"),
    }),
    single("qb5", "Was a net business loss from an earlier year carried forward into {year} (a loss left over from an earlier year's return)?", YES_NO, {
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
    single("mt1", "Who, if anyone, had a single W-2 with Medicare wages (box 5) above $200,000 in {year}?", WHO_NONE, {
      help: "The Form 8959 instructions say to file it if Medicare wages on any single W-2 (box 5) are greater than $200,000.",
      sources: ["8959"],
    }),
    single("mt2", "Did your combined wages plus self-employment income for {year} exceed the Additional Medicare Tax threshold for your filing status (Form 8959 lists it)?", YES_NO, {
      help: "The IRS 1040 instructions give $250,000 if married filing jointly, $200,000 if single, head of household or qualifying surviving spouse, and $125,000 if married filing separately.",
      sources: ["1040GI"],
    }),
    single("mt3", "Did an employer withhold Additional Medicare Tax (a separate extra Medicare tax, not the regular Medicare tax) from either of your paychecks in {year}?", YES_NO, {
      help: "The IRS says an employer may have withheld Additional Medicare Tax even if none is owed; withheld amounts are reported using Form 8959.",
      sources: ["1040GI"],
    }),
    single("mt4", "Who had self-employment income (income from their own business or side work) in {year}?", WHO_NONE, {
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
      "Do you claim, or plan to claim, any dependents (such as a child or a parent) on your {year} return?",
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
    whole("cd2", "How many dependents do you claim for {year}?", 1, 20, { showWhen: CD_ANY }),
    single("cd3", "Were all the children you claim under age 17 at the end of {year} (on December 31)?", ALL_SOME_NONE, {
      help: "The IRS 1040 instructions use age under 17 at the end of the year as one test for the child tax credit.",
      sources: ["1040GI"],
      showWhen: inn("cd1", "children"),
    }),
    single(
      "cd4",
      "Did each dependent have a Social Security number (SSN), an Individual Taxpayer Identification Number (ITIN) or an Adoption Taxpayer Identification Number (ATIN) issued on or before the return's due date, including extensions (or an application filed by then)?",
      ALL_SOME_NONE,
      {
        help: "The IRS instructions apply this taxpayer-identification test to the child tax credit and the credit for other dependents.",
        sources: ["1040GI"],
        showWhen: CD_ANY,
      }
    ),
    single("cd5", "Does each child you claim have a valid Social Security number (SSN)?", ALL_SOME_NONE, {
      help: "The IRS says a qualifying child without a valid SSN cannot be used to claim the child tax credit; another taxpayer ID may still support the credit for other dependents.",
      sources: ["8812"],
      showWhen: inn("cd1", "children"),
    }),
    single("cd6", "Did each dependent live with you for more than half of {year}?", ALL_SOME_NONE, {
      help: "The IRS qualifying-child tests use whether the child lived with you for more than half the year, with exceptions.",
      sources: ["1040GI"],
      showWhen: CD_ANY,
    }),
    single("cd7", "Could anyone else (such as the other parent or a grandparent) also claim any of these dependents on their own {year} return?", YES_NO, { showWhen: CD_ANY }),
    single("cd8", "Did you pay for child or dependent care in {year} (dependent care benefits from an employer show in box 10 of the W-2)?", YES_NO, {
      help: "The IRS says dependent care benefits are shown in box 10 of the W-2 and to complete Form 2441 to see how much can be excluded.",
      sources: ["1040GI"],
      showWhen: CD_ANY,
    }),
    single(
      "cd9",
      "Which best describes the other dependent you claim (the one who is not a child)?",
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
      "Did you buy or otherwise acquire a plug-in electric or fuel-cell vehicle in {year}?",
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
    single("ev2", "When did you acquire it (the date you signed the purchase contract and made a payment, even a small down payment)?", [o("before", "On or before September 30, 2025"), o("after", "After September 30, 2025"), UNSURE], {
      help: "The IRS says clean vehicle credits cannot be claimed for vehicles acquired after September 30, 2025, and a vehicle is 'acquired' when a written binding contract is entered into and a payment (including a nominal down payment or a trade-in) has been made.",
      sources: ["8936"],
      showWhen: EV_YES,
    }),
    single("ev3", "How is the vehicle used - for personal use, in a business, or both?", [o("personal", "Personal use"), o("business", "Used in a business"), o("both", "Both"), UNSURE], {
      help: "The IRS says the vehicle must be acquired for use, not for resale, and a separate credit exists for qualified commercial clean vehicles.",
      sources: ["8936"],
      showWhen: EV_YES,
    }),
    single("ev4", "Did you transfer the credit to the dealer at the time of sale (so that you paid a lower price at purchase)?", YES_NO, {
      help: "The IRS says a credit transferred to a registered dealer at the time of sale is reported using Form 8936 and Schedule A (Form 8936).",
      sources: ["1040GI"],
      showWhen: EV_YES,
    }),
    single("ev5", "Did you start using the vehicle (place it in service) in {year}?", YES_NO, {
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
      "What kind of business or entity sent you the Schedule K-1?",
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
    single("kh2", "Whose name is the K-1 issued to?", [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), UNSURE]),
    single("kh3", "Does the person named on the K-1 work in the business, or only hold an investment in it?", [o("works", "I work in the business"), o("invests", "Only an investment"), UNSURE]),
    single("kh4", "Does the {year} K-1 show income, a loss, or both?", [o("income", "Income"), o("loss", "A loss"), o("both", "Both"), UNSURE]),
    single("kh5", "Did you receive cash (a distribution) from the entity in {year}?", YES_NO),
    single("kh6", "Does the K-1 show guaranteed payments (payments to a partner for work or capital, set regardless of the partnership's profit)?", YES_NO, {
      help: "The IRS says you must also pay self-employment tax on your share of certain partnership income and on guaranteed payments.",
      sources: ["SE"],
      showWhen: inn("kh1", "partnership"),
    }),
    single("kh7", "Did the entity pay Connecticut pass-through entity tax (an optional Connecticut tax the entity can choose to pay) on your behalf?", YES_NO, {
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
      "For {year}, did EK Consulting have a net profit, a net loss, or neither (business income minus business expenses)?",
      [o("profit", "A net profit"), o("loss", "A net loss"), o("neither", "Neither"), UNSURE],
      {
        help: "The IRS says Schedule SE is required when line 4c of the schedule is $400 or more, and that even with a loss or small amount it may be to your benefit to file and use an optional method. The CPA works this out.",
        sources: ["SE"],
      }
    ),
    single("se2", "Did Eric or Eva have any other self-employment income in {year}, such as side work, 1099 income or partnership guaranteed payments?", YES_NO, {
      help: "The IRS says you must also pay self-employment tax on certain partnership income and guaranteed payments.",
      sources: ["SE"],
    }),
    single("se3", "Whose other self-employment income was it?", [o("eric", "Eric"), o("eva", "Eva"), o("both", "Both of us"), UNSURE], {
      showWhen: inn("se2", "yes"),
    }),
    single("se4", "Were estimated tax payments made during {year} to cover self-employment tax?", YES_NO),
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
    single("ef1", "How many owners (members) does {entity} have?", [o("one", "One"), o("multiple", "Two or more"), UNSURE], {
      help: "The IRS says an LLC with only one member is treated as disregarded as separate from its owner for income tax unless it files Form 8832 to be treated as a corporation, and a domestic LLC with at least two members is classified as a partnership unless it elects otherwise.",
      sources: ["LLC"],
    }),
    single("ef2", "Who are the owners of {entity}?", [o("us_only", "Eric and Eva only"), o("others", "Includes someone else"), UNSURE], {
      showWhen: inn("ef1", "multiple"),
    }),
    single(
      "ef3",
      "Has {entity} ever filed a form with the IRS to choose to be taxed as a corporation (Form 8832) or as an S corporation (Form 2553)?",
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
      "For an earlier year, did {entity} file its own federal tax return (separate from your personal return)?",
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
      "Does {entity} have employees, or its own employer identification number (EIN)?",
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
      "On which tax return has {entity}'s income been reported so far?",
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
      "How does {entity} report its income to the IRS (on your personal return, or on its own return)?",
      [
        o("household", "On our personal return (disregarded)"),
        o("partnership", "As a partnership (Form 1065)"),
        o("s_corp", "As an S corporation (Form 1120-S)"),
        o("corp", "As a corporation"),
        UNSURE,
      ]
    ),
    single("cf2", "Is {entity} considering the optional Connecticut pass-through entity tax (a tax the entity can choose to pay)?", YES_NO, {
      help: "Connecticut says the pass-through entity tax is optional; the election is made each year by checking a box on a timely filed Form CT-1065/CT-1120SI, and the entity must first complete the federal Form 1065 or 1120-S.",
      sources: ["CTPET"],
      showWhen: inn("cf1", "partnership", "s_corp"),
    }),
    single("cf3", "Did {entity} do business or have income connected to Connecticut in {year}?", YES_NO, {
      help: "Connecticut says an entity that does business in Connecticut or has income from Connecticut sources may elect to file the pass-through entity tax return.",
      sources: ["CTPET"],
    }),
    single("cf4", "Did {entity} pay wages to employees in {year}?", YES_NO),
    single("cf5", "Did {entity} itself collect or pay any other Connecticut taxes besides income tax in {year} (for example sales tax)?", YES_NO),
    single(
      "cf6",
      "Do you have copies of the Connecticut tax filings {entity} made for the previous year?",
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

// ── 17. Return completeness (Phase 1b of the answers-driven TY2025 engine) ───
//
// ONE guided flow. The answers feed lib/tax2025/answers.ts, which turns them into
// facts for the computed return (Schedule 1-A, HSA, IRA, saver's credit, Form 2210
// estimate, payments, CT use tax) and into the "stated none" statements the engine
// needs before it will finish the rare lines of the return. Every question that
// can be answered "none" is answered in one click; follow-up amounts only appear
// after "some". Positive options come first so every follow-up is reachable.
//
// Node ids are PUBLIC to lib/tax2025/answers.ts (it reads them by id); change one
// only together with that file, and bump `version` when a tree changes.

export const RETURN_COMPLETENESS_ID = "return-completeness";

/** The two people the person-by-person questions ask about, in Form 8889 / Form 8880 order (A then B). */
export const RC_PERSONS = [
  { slot: "a", key: "eric", name: "Eric" },
  { slot: "b", key: "eva", name: "Eva" },
] as const;

/** Payment windows (the Form 2210 payment due dates) and the representative payment date each window is recorded with. */
export const RC_PAYMENT_WINDOWS = [
  { n: "1", label: "paid on or before April 15, 2025", date: "2025-04-15" },
  { n: "2", label: "paid after April 15 through June 15, 2025", date: "2025-06-15" },
  { n: "3", label: "paid after June 15 through September 15, 2025", date: "2025-09-15" },
  { n: "4", label: "paid after September 15 through December 31, 2025", date: "2025-12-31" },
  { n: "5", label: "paid January 1 through January 15, 2026", date: "2026-01-15" },
] as const;

/** Group id -> the question text for the "stated none" statements (every NoneGroupId has one; a test pins that). */
const RC_GROUP_PROMPTS: Readonly<Record<NoneGroupId, string>> = {
  other_earned_income:
    "wages as a household employee (for example a nanny or housekeeper) that were not on a W-2, tips you did not report to your employer, Medicaid waiver payments, taxable dependent care or adoption benefits from an employer, wages reported on Form 8919, or other earned income",
  retirement_ss_income: "withdrawals (distributions) from an Individual Retirement Account (IRA), pension or annuity payments, or Social Security benefits",
  other_income:
    "income other than W-2 wages, interest, dividends and EK Consulting business income - for example state income tax refunds, alimony, rental or partnership income, farm income, unemployment compensation, gambling winnings, debt that was canceled or forgiven, jury duty pay, prizes or income from digital assets such as cryptocurrency",
  other_adjustments:
    "deductions that reduce your income before the standard or itemized deduction (called adjustments to income), other than the Health Savings Account (HSA), half of self-employment tax, self-employed retirement, self-employed health insurance and Individual Retirement Account (IRA) deductions - for example educator expenses, a penalty on early withdrawal of savings, alimony paid, student loan interest or an Archer Medical Savings Account (MSA) deduction",
  other_taxes:
    "additional taxes beyond self-employment tax, Additional Medicare Tax and net investment income tax - for example household employment taxes (taxes for paying a nanny or housekeeper), an additional tax for taking money out of a retirement account early, or repaying a premium tax credit (a health insurance marketplace subsidy)",
  other_nonrefundable_credits:
    "credits such as the child and dependent care credit, education credits, the energy efficient home improvement credit, general business credits, the adoption credit, or the credit for the elderly or disabled (not the solar credit, which is asked next)",
  solar_credit: "a residential clean energy credit (for solar, wind, geothermal or battery systems) that is being claimed on the 2025 return (Form 5695 line 15)",
  other_refundable_credits:
    "a refundable credit (one that can be paid out even if no tax is owed), such as a premium tax credit, the credit for federal tax on fuels, the earned income credit, the additional child tax credit, the American opportunity credit, the refundable adoption credit or another refundable credit",
  medical_expenses: "medical or dental expenses you paid in 2025 that insurance or anyone else did not pay back (Schedule A lines 1-4)",
  sch_a_other:
    "other itemized-deduction items (Schedule A): other taxes, mortgage interest or points not shown on Form 1098, investment interest, a charitable carryover (donations left over from an earlier year), casualty or theft losses, or other itemized deductions",
  savings_bond_exclusion: "interest on series EE or I U.S. savings bonds that you want to leave out of your taxable income (Form 8815)",
  sch_c_other_lines: "depletion (a deduction for using up natural resources) or an energy efficient commercial buildings deduction on EK Consulting's Schedule C (business profit or loss)",
  se_other:
    "farm income, income as a church employee, tips you did not report to your employer (Form 4137), wages reported on Form 8919, railroad retirement compensation, or the optional methods for figuring self-employment tax",
  qbi_carryforwards: "a qualified business loss, or a loss from a real estate investment trust (REIT) or a publicly traded partnership, carried forward from an earlier year (Form 8995)",
};

/** Group id -> a short plain-language name used in the follow-up amount question. */
const RC_GROUP_LABELS: Readonly<Record<NoneGroupId, string>> = {
  other_earned_income: "other earned income",
  retirement_ss_income: "retirement and Social Security income",
  other_income: "other income",
  other_adjustments: "other adjustments to income",
  other_taxes: "other taxes",
  other_nonrefundable_credits: "other credits",
  solar_credit: "the residential clean energy credit",
  other_refundable_credits: "refundable credits",
  medical_expenses: "unreimbursed medical and dental expenses",
  sch_a_other: "other itemized deductions",
  savings_bond_exclusion: "savings bond interest",
  sch_c_other_lines: "other EK Consulting Schedule C items",
  se_other: "other self-employment tax items",
  qbi_carryforwards: "qualified business income carryforwards",
};

const SOME_NONE: readonly QOption[] = [o("some", "Yes"), o("none", "No"), UNSURE];

function rcPersonNodes(): QNode[] {
  const out: QNode[] = [];
  const BY_AGE = (k: string) => inn(`age_${k}`, "yes");
  // A. born before January 2, 1961
  for (const P of RC_PERSONS) {
    out.push(
      single(`age_${P.key}`, `Was ${P.name} born before January 2, 1961 (the cutoff for the extra senior deductions)?`, YES_NO, {
        help: "The IRS enhanced deduction for seniors on Schedule 1-A is for a person born before January 2, 1961 who has a Social Security number valid for employment. The same date decides the additional standard deduction (Form 1040 line 12d).",
        sources: ["SCH1A", "1040GI"],
      })
    );
  }
  for (const P of RC_PERSONS) {
    out.push(
      single(`blind_${P.key}`, `Was ${P.name} blind at the end of 2025 (totally blind, or with an eye doctor's statement of blindness)?`, YES_NO, {
        help: "The IRS adds to the standard deduction for each spouse who was blind at the end of the year. A person who is not totally blind needs a statement from an eye doctor that they cannot see better than 20/200 in the better eye with glasses or contact lenses, or that their field of vision is 20 degrees or less.",
        sources: ["1040GI"],
      })
    );
  }
  // B. retirement plans and IRAs
  for (const P of RC_PERSONS) {
    const k = P.key;
    out.push(
      single(`plan_${k}`, `Was ${P.name} covered by a retirement plan at work for 2025 (the 'Retirement plan' box in box 13 of the W-2 is checked if so)?`, YES_NO, {
        help: "The IRS says the 'Retirement plan' box in box 13 of Form W-2 should be checked if you were covered by a plan at work, even if you were not vested, and that a self-employed person with a Simplified Employee Pension (SEP), SIMPLE or qualified retirement plan is also covered.",
        sources: ["1040GI"],
      }),
      single(`def_${k}`, `Did ${P.name} make elective deferrals in 2025 (retirement contributions chosen by the employee) to a 401(k), 403(b), governmental 457(b), SIMPLE, Simplified Employee Pension (SEP) or the federal Thrift Savings Plan? (Box 12 of the W-2 may show them.)`, SOME_NONE, {
        help: "The IRS counts designated Roth contributions as elective deferrals; these amounts may be shown in box 12 of the Form W-2.",
        sources: ["8880F"],
      }),
      dollars(`defamt_${k}`, `What was the total of ${P.name}'s elective deferrals in 2025, in dollars (add up all plans)?`, { showWhen: inn(`def_${k}`, "some"), sources: ["8880F"] }),
      single(`ira_${k}`, `Did ${P.name} contribute to a traditional or Roth IRA for 2025, including contributions made by April 15, 2026 that are designated for 2025?`, SOME_NONE, {
        help: "The IRS 1040 instructions count traditional IRA contributions made, or to be made, by the due date of the 2025 return not counting extensions (April 15, 2026 for most people).",
        sources: ["1040GI"],
      }),
      dollars(`tira_${k}`, `How much did ${P.name} contribute to a traditional IRA for 2025, in dollars (enter 0 if only Roth)?`, { showWhen: inn(`ira_${k}`, "some") }),
      dollars(`roth_${k}`, `How much did ${P.name} contribute to a Roth IRA for 2025, in dollars (enter 0 if none)?`, { showWhen: inn(`ira_${k}`, "some") }),
      single(`ira50_${k}`, `Was ${P.name} age 50 or older at the end of 2025?`, YES_NO, {
        help: "The IRS says the IRA contribution limit and the percentage used to reduce the IRA deduction are higher for a person age 50 or older at the end of 2025.",
        sources: ["590A"],
        showWhen: inn(`ira_${k}`, "some"),
      })
    );
  }
  const CONTRIBUTES = anyOf(...RC_PERSONS.flatMap((P) => [inn(`def_${P.key}`, "some"), inn(`ira_${P.key}`, "some")]));
  out.push(
    single("rdist", "Since January 1, 2023, did Eric or Eva take money out (a distribution) from a retirement plan, IRA or ABLE (Achieving a Better Life Experience) account, other than a rollover into another retirement account?", YES_NO, {
      help: "The IRS saver's credit form says certain distributions received after 2022 and before the return due date reduce the contributions that count.",
      sources: ["8880F"],
      showWhen: CONTRIBUTES,
    }),
    single("student", "For 2025, was Eric or Eva a full-time student during any part of 5 different months, or claimed as someone else's dependent (for example by a parent)?", YES_NO, {
      help: "The IRS saver's credit is not available to a person who was a full-time student for part of 5 calendar months of the year or who is claimed as a dependent on someone else's return.",
      sources: ["8880F"],
      showWhen: CONTRIBUTES,
    })
  );
  // C. HSA
  for (const P of RC_PERSONS) {
    const k = P.key;
    const COVERED = inn(`hsa_${k}`, "self_only", "family");
    out.push(
      single(
        `hsa_${k}`,
        `Was ${P.name} covered by a high-deductible health plan (HDHP) that can be paired with a Health Savings Account (HSA) for any part of 2025?`,
        [o("self_only", "Yes - self-only coverage (just that person) for all the months covered"), o("family", "Yes - family coverage for all the months covered"), o("changed", "Yes - it changed between self-only and family"), o("none", "No"), UNSURE],
        {
          help: "The IRS says to have contributions made to an HSA you must be covered by an HDHP and have no other health coverage except certain disregarded coverage; the contribution limit depends on self-only versus family coverage.",
          sources: ["8889"],
        }
      ),
      whole(`hsam_${k}`, `In how many months of 2025 was ${P.name} covered by the HDHP on the first day of the month (a number from 0 to 12)?`, 0, 12, {
        help: "The IRS contribution limit is figured month by month: a month counts if you were an eligible individual with that coverage on the first day of the month.",
        sources: ["8889"],
        showWhen: COVERED,
      }),
      single(`hsad1_${k}`, `Was ${P.name} still covered by the HDHP on December 1, 2025?`, YES_NO, {
        help: "The IRS last-month rule counts the whole year for the HSA limit if you were an eligible individual on the first day of the last month of the year (December 1), but you must remain an eligible individual through December 31, 2026 or part of the contributions becomes income plus a 10% additional tax.",
        sources: ["8889"],
        showWhen: COVERED,
      }),
      single(`hsamed_${k}`, `For any month of 2025, was ${P.name} enrolled in Medicare or claimed as someone else's dependent?`, YES_NO, {
        help: "The IRS says you cannot deduct HSA contributions for any month you were enrolled in Medicare, or if you are someone else's dependent.",
        sources: ["8889"],
        showWhen: COVERED,
      }),
      single(`hsa55_${k}`, `Was ${P.name} age 55 or older at the end of 2025?`, YES_NO, {
        help: "The IRS allows an additional contribution amount for a person age 55 or older at the end of the tax year.",
        sources: ["8889"],
        showWhen: COVERED,
      }),
      dollars(`hsadir_${k}`, `How much did ${P.name} deposit directly into an HSA for 2025, not through payroll, in dollars (enter 0 if none; deposits made by April 15, 2026 count for 2025)?`, {
        help: "The IRS counts contributions made for 2025 up to April 15, 2026; payroll contributions through a cafeteria plan (an employer's pre-tax benefits plan) are treated as employer contributions (W-2 box 12 code W) and are read from the W-2.",
        sources: ["8889"],
        showWhen: COVERED,
      }),
      single(`hsaemp_${k}`, `Do the HSA contributions ${P.name}'s employer made (W-2 box 12, code W) include money that belongs to a different year (2024 contributions made in 2025, or 2025 contributions made in 2026)?`, YES_NO, {
        help: "The IRS Employer Contribution Worksheet adjusts the W-2 box 12 code W amount for contributions that belong to another year.",
        sources: ["8889"],
        showWhen: COVERED,
      })
    );
  }
  for (const P of RC_PERSONS) {
    out.push(
      single(`hsadist_${P.key}`, `Did ${P.name} take money out of an HSA in 2025 (Form 1099-SA, box 1, shows any withdrawals)?`, SOME_NONE, {
        help: "The IRS says HSA distributions are shown on Form 1099-SA, box 1, and are reported on Form 8889 Part II even when nothing is taxable.",
        sources: ["8889"],
      })
    );
  }
  // D. Schedule 1-A
  for (const P of RC_PERSONS) {
    const k = P.key;
    out.push(
      single(
        `tips_${k}`,
        `Did ${P.name} receive tips as an employee in 2025 in an occupation that customarily received tips (the IRS keeps a list of these occupations)?`,
        [o("some", "Yes - I know the amount"), o("ask_employer", "Yes - I do not know the amount yet, I will ask the employer"), o("none", "No tips"), UNSURE],
        {
          help: "The IRS says qualified tips are cash tips paid voluntarily, not negotiated, determined by the customer, in an occupation that customarily received tips on or before December 31, 2024 (the list is at IRS.gov/TippedOccupations); automatic gratuities and mandatory service charges are not qualified tips. The 2025 Form W-2 does not separately show them: the amount in box 7 or the tips reported to the employer can be used. Tips from your own business need the CPA - answer 'Not sure'.",
          sources: ["SCH1A", "1040GI"],
        }
      ),
      dollars(`tipsamt_${k}`, `How much did ${P.name} receive in qualified tips (the cash tips the IRS counts for this deduction) in 2025 from all employers together, in dollars?`, {
        help: "The IRS worksheet for more than one employer uses, for each employer, the larger of the tips on the W-2 or reported to the employer; enter the total of those.",
        sources: ["1040GI"],
        showWhen: inn(`tips_${k}`, "some"),
      }),
      single(
        `ot_${k}`,
        `Did ${P.name} receive overtime pay in 2025 that the federal Fair Labor Standards Act (FLSA) required (employers may show it in box 14 of the W-2)?`,
        [
          o("premium", "Yes - I know the overtime premium (the 'half' of time-and-a-half)"),
          o("total", "Yes - I know the total pay for the overtime hours (premium plus regular wages)"),
          o("ask_employer", "Yes - I do not know the amount yet, I will ask the employer"),
          o("none", "No overtime"),
          UNSURE,
        ],
        {
          help: "The IRS says qualified overtime is the amount above the regular rate that the FLSA requires (generally the 'half' in time-and-a-half); employers may show it in W-2 box 14; if a statement shows the total pay for the overtime hours (premium plus regular wages), the instructions let you divide that total by three; you can rely on an amount your employer provides.",
          sources: ["1040GI"],
        }
      ),
      dollars(`otamt_${k}`, `How much was ${P.name}'s overtime amount in 2025 from all employers together, in dollars (the total pay for the overtime hours if you chose that answer)?`, { showWhen: inn(`ot_${k}`, "premium", "total") }),
      single(`ssn_${k}`, `Does ${P.name} have a Social Security number that is valid for employment, issued before the due date of the 2025 return?`, YES_NO, {
        help: "The IRS requires a valid Social Security number for the person who received the qualified tips or overtime, or who claims the enhanced deduction for seniors; this app never stores a Social Security number.",
        sources: ["1040GI"],
        showWhen: anyOf(BY_AGE(k), inn(`tips_${k}`, "some"), inn(`ot_${k}`, "premium", "total")),
      })
    );
  }
  out.push(
    single("car", "Did Eric or Eva buy a new vehicle in 2025 with a loan that started after December 31, 2024?", SOME_NONE, {
      help: "The IRS car-loan interest deduction (Schedule 1-A Part IV) is for interest on a loan originated after December 31, 2024 to buy an applicable passenger vehicle.",
      sources: ["1040GI"],
    }),
    single("carq", "Does the vehicle and loan meet ALL of these: the vehicle's original use starts with you (it was bought new, not used), final assembly was in the United States, it is used for personal use (more than 50%), the loan is secured by a first lien on the vehicle (the lender has first claim on it), and you are the borrower?", YES_NO, {
      help: "The IRS lists these conditions (and that the vehicle is a car, minivan, van, SUV, pickup truck or motorcycle under 14,000 pounds gross weight rating). Lease payments do not qualify. The vehicle identification number is required on the return; the app does not store it.",
      sources: ["1040GI"],
      showWhen: inn("car", "some"),
    }),
    dollars("carint", "How much interest was paid or accrued (charged, even if not yet paid) on the car loan(s) in 2025, in dollars?", { showWhen: inn("car", "some") }),
    dollars("carelse", "Of that interest, how much was deducted somewhere else on the return, such as on Schedule C (business profit or loss) for business use, in dollars (enter 0 if none)?", {
      help: "The IRS says the same interest cannot be deducted twice: interest deducted on Schedule C, E or F is not also deducted on Schedule 1-A.",
      sources: ["1040GI"],
      showWhen: inn("car", "some"),
    })
  );
  const SCH1A_CANDIDATE = anyOf(
    ...RC_PERSONS.flatMap((P) => [inn(`age_${P.key}`, "yes"), inn(`tips_${P.key}`, "some"), inn(`ot_${P.key}`, "premium", "total")]),
    inn("car", "some")
  );
  out.push(
    single("pr", "For 2025, did Eric or Eva leave out (exclude) income earned in Puerto Rico, or file Form 2555 (foreign earned income) or Form 4563 (income from American Samoa)?", YES_NO, {
      help: "The IRS adds excluded Puerto Rico income and the Form 2555 / Form 4563 amounts to the income figure used for the Schedule 1-A phase-outs.",
      sources: ["1040GI"],
      showWhen: SCH1A_CANDIDATE,
    })
  );
  // D2. EK Consulting owner: self-employed health insurance and retirement contributions (Schedule 1 lines 17 and 16)
  out.push(
    single("sehi", "Did you pay for health insurance for yourself or your family for {year} on your own, outside an employer's plan or pre-tax payroll (for example premiums you paid personally or through EK Consulting)?", YES_NO, {
      context: "ekcActive",
    }),
    dollars("sehiamt", "How much did you pay in total for that health insurance for {year}, in dollars?", {
      context: "ekcActive",
      showWhen: inn("sehi", "yes"),
    }),
    single("serp", "Did EK Consulting make, or did you make, contributions for yourself to a SEP IRA, SIMPLE IRA or solo 401(k) for {year}?", YES_NO, {
      context: "ekcActive",
    }),
    dollars("serpamt", "How much was contributed for you in total to those plans for {year}, in dollars?", {
      context: "ekcActive",
      showWhen: inn("serp", "yes"),
    })
  );
  // E. Payments
  for (const J of [
    { id: "fe", who: "federal", name: "Federal" },
    { id: "ce", who: "Connecticut", name: "Connecticut" },
  ] as const) {
    out.push(
      single(`${J.id}`, `Did you make ${J.who} estimated income tax payments for 2025 (payments you sent in yourselves during the year, not tax withheld from pay, a payment with an extension request, or a 2024 overpayment applied to 2025 - those are asked separately)?`, SOME_NONE)
    );
    for (const W of RC_PAYMENT_WINDOWS) {
      out.push(dollars(`${J.id}${W.n}`, `In total, how much ${J.who} estimated tax was ${W.label}, in dollars (enter 0 if none)?`, { showWhen: inn(J.id, "some") }));
    }
  }
  for (const E of [
    { id: "fext", prompt: "Did you send a payment to the IRS with a request for more time to file (a federal extension, Form 4868) for 2025?", amt: "How much did you pay with the federal extension request, in dollars?", sources: ["1040GI"] },
    { id: "cext", prompt: "Did you send a payment to Connecticut with a request for more time to file (a Connecticut extension, Form CT-1040 EXT) for 2025?", amt: "How much did you pay with the Connecticut extension request, in dollars?", sources: [] },
    { id: "fov", prompt: "On your 2024 federal return, did you choose to apply an overpayment (instead of getting it refunded) to your 2025 estimated tax?", amt: "How much of your 2024 federal overpayment was applied to your 2025 federal estimated tax, in dollars?", sources: ["2210F"] },
    { id: "cov", prompt: "On your 2024 Connecticut return, did you choose to apply an overpayment (instead of getting it refunded) to your 2025 estimated tax?", amt: "How much of your 2024 Connecticut overpayment was applied to your 2025 Connecticut estimated tax, in dollars?", sources: [] },
    {
      id: "cpy",
      prompt: "During 2025, did you pay Connecticut income tax for tax year 2024 - a balance due on the 2024 return, or the January 2025 estimated installment for 2024?",
      amt: "How much Connecticut income tax did you pay in 2025 for tax year 2024, in dollars?",
      sources: [],
    },
  ] as const) {
    out.push(single(E.id, E.prompt, SOME_NONE, E.sources.length > 0 ? { sources: [...E.sources] } : {}));
    out.push(dollars(`${E.id}amt`, E.amt, { showWhen: inn(E.id, "some") }));
  }
  // F. Use tax
  out.push(
    single("ut", "In 2025, did you buy anything from an out-of-state seller (online, catalog or out-of-state store) without paying Connecticut sales tax, for use in Connecticut (the Connecticut tax owed on these purchases is called use tax)?", SOME_NONE, {
      help: "Connecticut says use tax is due on goods or taxable services bought out of state for use in Connecticut when no Connecticut sales tax was paid, and that CT-1040 line 15 must show 0 if none is due.",
      sources: ["CT1040I"],
    }),
    dollars("utbuy", "What was the total purchase price of those items on which you paid sales or use tax to another state, in dollars (enter 0 if none)?", {
      help: "Connecticut says the CT-1040 use tax worksheet applies the general rate of 6.35% to the purchase price and subtracts tax already paid on the purchase.",
      sources: ["CT1040I"],
      showWhen: inn("ut", "some"),
    }),
    dollars("utbuy2", "What was the total purchase price of those items on which NO sales or use tax was paid anywhere, in dollars (enter 0 if none)?", {
      showWhen: inn("ut", "some"),
    }),
    single("utother", "Were any of those purchases luxury items (most expensive vehicles, jewelry, clothing, footwear, handbags, luggage, umbrellas, wallets or watches above the prices in the Connecticut CT-1040 instructions), computer or data processing services, or a vessel (boat)?", YES_NO, {
      help: "Connecticut says these have a different use tax rate (7.75%, 1% and 2.99%); the app does not compute them.",
      sources: ["CT1040I"],
      showWhen: inn("ut", "some"),
    }),
    dollars("uttax", "How much sales or use tax did you pay to another state on the items in the first amount above, in dollars (enter 0 if none)?", {
      help: "Connecticut says the CT-1040 use tax worksheet subtracts tax already paid on the purchase (column 6).",
      sources: ["CT1040I"],
      showWhen: inn("ut", "some"),
    })
  );
  // G. The 2024 return
  out.push(
    single("pyjoint", "Was your 2024 federal return a joint return (one return filed for both spouses together)?", YES_NO, {
      help: "The IRS says the prior-year tax used for the estimated tax penalty safe harbor is the sum of both spouses' 2024 tax if you file jointly for 2025 but did not file jointly for 2024.",
      sources: ["2210"],
    }),
    single("pyextra", "Did your 2024 federal return show either of these: a refundable credit (earned income, additional child tax, American opportunity, premium tax credit or fuel credit), or a Schedule 2 tax for unreported tips (lines 5 to 7 or 13)?", YES_NO, {
      help: "The IRS says the 2024 tax used for the estimated tax penalty safe harbor includes Additional Medicare Tax and net investment income tax, leaves out some Schedule 2 lines (for example 5 to 7 and 13), and is reduced by refundable credits.",
      sources: ["2210"],
    })
  );
  // H. Header attestations
  out.push(
    single("digital", "At any time in 2025, did either of you receive digital assets such as cryptocurrency (as a reward, award or payment for property or services) or sell, exchange or otherwise dispose of a digital asset or any financial interest in one?", YES_NO, {
      help: "The IRS says to check Yes on the Form 1040 digital assets question for these, but holding a digital asset, moving it between your own wallets, or buying it with regular currency alone does not require Yes.",
      sources: ["1040GI"],
    }),
    single("foreign", "In 2025, did either of you have a financial account outside the United States, or receive a distribution from or create (or transfer to) a foreign trust?", YES_NO, {
      help: "The IRS says Schedule B Part III must be completed if you had a foreign account or received a distribution from, or were a grantor of or transferor to, a foreign trust.",
      sources: ["1040GI"],
    })
  );
  // I. "none" statements for the rare lines
  for (const id of NONE_GROUP_IDS) {
    out.push(
      single(`g_${id}`, `In 2025, did Eric or Eva have any of these: ${RC_GROUP_PROMPTS[id]}? (Answer No only if none of them applies. The app does not calculate these items, so a Yes passes them to the CPA.)`, [o("some", "Yes - at least one"), o("none", "No - none of these"), UNSURE]),
      dollars(`ga_${id}`, `In 2025, about how much was the total for ${RC_GROUP_LABELS[id]}, in dollars (an estimate is fine and only the CPA sees it)?`, {
        showWhen: inn(`g_${id}`, "some"),
      })
    );
  }
  return out;
}

const RC_NODES: readonly QNode[] = rcPersonNodes();

const FORM_RETURN_COMPLETENESS: QuestionnaireDef = {
  id: RETURN_COMPLETENESS_ID,
  version: 2,
  title: "Return completeness",
  formLabel: "Form 1040 and Connecticut CT-1040",
  scope: "household",
  intro:
    "One short flow for {year}: answer Yes or No for each item the return still needs, and give amounts only after a Yes. The app computes the Schedule 1-A deductions (tips, overtime, car-loan interest and the senior deduction), the Health Savings Account (HSA) and Individual Retirement Account (IRA) deductions, the saver's credit, payments and a Form 2210 estimate from these answers, and marks anything it cannot compute for the CPA.",
  sourcesTaxYear: SOURCES_TAX_YEAR,
  planningLinks: [
    { key: "retirement_contributions", label: "Retirement contributions (Planning answer)" },
    { key: "estimated_taxes_2025", label: "Estimated taxes paid (Planning answer)" },
  ],
  nodes: RC_NODES,
  outcomeRules: [
    { when: anyOf(...NONE_GROUP_IDS.map((id) => inn(`g_${id}`, "some"))), outcome: "applies" },
    { when: allOf(...NONE_GROUP_IDS.map((id) => inn(`g_${id}`, "none"))), outcome: "not_applies" },
  ],
  outcomeDefault: "unsure",
  outcomeText: outcomes(
    "Owner reports at least one rare item the app cannot compute - the CPA decides how it is reported; everything else answered here feeds the computed return.",
    "Owner reports none of the rare items apply; the answers feed the computed return."
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
  FORM_RETURN_COMPLETENESS,
];

export function questionnaireById(id: string): QuestionnaireDef | null {
  return QUESTIONNAIRES.find((q) => q.id === id) ?? null;
}

/** Entity-scoped questionnaire ids (the Forms catalog maps an entity entry to one of these). */
export const ENTITY_FEDERAL_QUESTIONNAIRE_ID = "entity-federal-return";
export const ENTITY_CT_QUESTIONNAIRE_ID = "entity-ct-filing";
