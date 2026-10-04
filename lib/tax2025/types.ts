// Shared types for the answers-driven TY2025 return engine (lib/tax2025/).
//
// Design rules (plan section 6, .claude/pipeline/filing-packet-compute-roadmap/01-plan.md):
//   - A leaf whose `value` is null is MISSING, never 0. A rule that needs a missing
//     leaf returns status "missing_input" (no silent zero).
//   - Every rule returns the same RuleResult shape: status, lines, reasons,
//     citations (constant ids), inputsUsed / inputsMissing, optional alternatives.
//   - Money inside rules is Decimal dollars; money in facts / at document
//     boundaries is integer cents (number). No floats are ever used for money.
//   - LineKey is a CLOSED union of every line the return can carry. Later phases
//     (1b adjustments/credits, 1c sheet, 2 CT/alternatives) add lines by adding
//     members here and a rule that emits them; Ty2025Return.lines is keyed by it.

import type { Decimal } from "@prisma/client/runtime/library";
import type { BrokerBox } from "@/lib/tax2025/facts";

// ── Provenance ────────────────────────────────────────────────────────────────

/**
 * Where a value came from. Precedence when several sources exist for one fact
 * (documented in resolve-facts.ts and tested): override > doc_verified >
 * answer_owner / answer_cpa > doc_unverified > books > derived > missing.
 */
export type Basis =
  | "doc_verified"
  | "doc_unverified"
  | "answer_owner"
  | "answer_cpa"
  | "books"
  | "derived"
  | "override";

export const BASES: readonly Basis[] = [
  "doc_verified",
  "doc_unverified",
  "answer_owner",
  "answer_cpa",
  "books",
  "derived",
  "override",
];

export type RefKind =
  | "document"
  | "questionnaire"
  | "planning"
  | "gl"
  | "fixed_asset"
  | "donation"
  | "mileage"
  | "paystub"
  | "constant"
  | "decision";

export interface Ref {
  kind: RefKind;
  /** Row id (document id, GL code, question key, constant id ...). */
  id: string;
  label: string;
}

/** One value with its provenance. `value: null` = MISSING (never 0). */
export interface Sourced<T> {
  value: T | null;
  /** null only when the value is missing. */
  basis: Basis | null;
  refs: Ref[];
  note?: string;
}

export function sourced<T>(value: T, basis: Basis, refs: Ref[] = [], note?: string): Sourced<T> {
  return note === undefined ? { value, basis, refs } : { value, basis, refs, note };
}

export function missingLeaf<T>(note?: string): Sourced<T> {
  return note === undefined ? { value: null, basis: null, refs: [] } : { value: null, basis: null, refs: [], note };
}

// ── Rule results ──────────────────────────────────────────────────────────────

export type RuleStatus =
  | "computed"
  | "not_applicable"
  | "missing_input"
  | "needs_cpa_rule_unverified"
  | "needs_cpa_judgment"
  /** A later phase owns this line (1b credits/adjustments, 2 CT modifications / alternatives). Never shown as 0. */
  | "not_yet_computed";

export const RULE_STATUSES: readonly RuleStatus[] = [
  "computed",
  "not_applicable",
  "missing_input",
  "needs_cpa_rule_unverified",
  "needs_cpa_judgment",
  "not_yet_computed",
];

/** Statuses that carry a numeric amount. */
export function hasAmount(status: RuleStatus): boolean {
  return status === "computed" || status === "not_applicable";
}

// The line catalog (every printed money line, with its real 2025 line id) lives in
// line-catalog.ts (data only); LineKey is derived from it.
import type { LineKey, ScheduleCLineId } from "@/lib/tax2025/line-catalog";
export {
  LINE_CATALOG,
  LINE_KEYS,
  NONE_GROUP_IDS,
  NONE_GROUP_TEXT,
  SCHEDULE_C_LINE_IDS,
  lineMeta,
  scheduleCLineKey,
  type LineKey,
  type LineMeta,
  type NoneGroupId,
  type ScheduleCLineId,
  type ScheduleCLineKey,
} from "@/lib/tax2025/line-catalog";

/**
 * One emitted line of a rule. `amount` is a WHOLE-DOLLAR Decimal (every line is
 * rounded with roundLine, the verified IRS rounding rule) when the status carries
 * an amount, else null. `exact` keeps the unrounded value for the audit trail.
 */
export interface RuleLine {
  key: LineKey;
  label: string;
  /** Form line as printed (display only), e.g. "11a". */
  formLine: string;
  amount: Decimal | null;
  exact?: Decimal | null;
  /** Defaults to the RuleResult status. Lets one rule mix computed and not-computed lines. */
  status?: RuleStatus;
  /** Why this particular line is not computed / what it means. */
  reason?: string;
  /** Provenance of this particular line; when absent the refs given to the assembler for the whole rule result are used. */
  refs?: Ref[];
  /**
   * Informational line: its amount is deliberately NOT estimated (for example CT late-payment penalty and interest, whose
   * minimum / month-counting rules are unverified). It never blocks completeness; it appears as an advisory item.
   */
  informational?: boolean;
}

/** Tax effect of choosing an alternative (only filled when the alternative is fully computed). */
export interface AlternativeEffect {
  /** Amount of the alternative's deduction / input in whole dollars. */
  amount: Decimal | null;
  note: string;
}

export interface RuleAlternative {
  id: string;
  label: string;
  status: RuleStatus;
  /** The conservative alternative the engine uses until a decision is recorded. */
  isDefault: boolean;
  /** This alternative is the one in force (recorded decision, or the default when undecided). */
  inForce: boolean;
  lines: RuleLine[];
  effect: AlternativeEffect | null;
  reasons: string[];
}

export type DecisionId = "X1" | "X2" | "X3" | "X5";

export interface RuleDecision {
  id: DecisionId;
  label: string;
  /** Alternative id in force. */
  chosen: string;
  status: "decided" | "default_undecided";
  decidedBy?: string;
  decidedAt?: string;
}

export interface RuleResult {
  ruleId: string;
  form: string;
  status: RuleStatus;
  /** For credits / deductions. */
  conclusion?: "eligible" | "ineligible" | "partial";
  lines: RuleLine[];
  /** Plain-language "why", citing inputs and numbers. */
  reasons: string[];
  /** Constant ids from constants.ts. */
  citations: string[];
  inputsUsed: Ref[];
  /** Human-readable names of the inputs that were missing. */
  inputsMissing: string[];
  alternatives?: RuleAlternative[];
  decision?: RuleDecision;
  /**
   * The result does not feed a figure on the return (for example the Form 2210
   * penalty ESTIMATE, which the IRS also computes itself): when it is not
   * `computed`, its open item is advisory, not blocking.
   */
  informational?: boolean;
}

const STATUS_PRIORITY: readonly RuleStatus[] = [
  "missing_input",
  "needs_cpa_judgment",
  "needs_cpa_rule_unverified",
  "not_yet_computed",
];

/** The most actionable blocking status among `statuses` (null when every one carries an amount). */
export function worstBlocked(
  statuses: readonly (RuleStatus | undefined)[]
): Exclude<RuleStatus, "computed" | "not_applicable"> | null {
  for (const s of STATUS_PRIORITY) if (statuses.includes(s)) return s as Exclude<RuleStatus, "computed" | "not_applicable">;
  return null;
}

/** The rule-level status implied by its lines: computed/not_applicable only if every line carries an amount. */
export function aggregateStatus(lines: readonly RuleLine[], fallback: RuleStatus = "computed"): RuleStatus {
  const counted = lines.filter((l) => l.informational !== true);
  if (counted.length === 0) return fallback;
  const statuses = counted.map((l) => l.status ?? fallback);
  for (const s of STATUS_PRIORITY) if (statuses.includes(s)) return s;
  return statuses.every((s) => s === "not_applicable") ? "not_applicable" : "computed";
}

// ── Decisions (CPA / owner choices, X1-X8) ────────────────────────────────────

export interface Decided<T extends string> {
  chosen: T;
  /** User id or name that made the decision. */
  by: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * Recorded decisions. An absent entry means "undecided": the engine then uses the
 * conservative alternative and marks the line "default, undecided". Storage of
 * decisions (a later phase) just fills this object; nothing else changes.
 */
export interface Ty2025Decisions {
  /** X1: home office, EKC. Conservative default: simplified. */
  homeOfficeMethod?: Decided<"simplified" | "actual">;
  /** X2: depreciation elections (Phase 2 computes the alternatives). */
  depreciationElection?: Decided<"regular_macrs" | "bonus" | "section_179" | "de_minimis">;
  /** X3: QBI form. Conservative default: Form 8995 when allowed. */
  qbiForm?: Decided<"8995" | "8995a">;
  /** X5: 56 Arbor Rd 2025 property tax. Default: Schedule A (subject to the SALT cap). */
  arborRoadPropertyTax?: Decided<"schedule_a" | "capitalize">;
}

// ── Conflicts and open items ──────────────────────────────────────────────────

export interface ConflictCandidate {
  basis: Basis;
  label: string;
  value: string | number | null;
  refs: Ref[];
}

export interface FactConflict {
  factKey: string;
  candidates: ConflictCandidate[];
  /** What the engine used (candidate label) or null when it used none. */
  chosen: string | null;
  reason: string;
}

export type OpenItemSeverity = "blocking" | "advisory";

export interface OpenItem {
  id: string;
  severity: OpenItemSeverity;
  message: string;
  /** What the owner / CPA should do. */
  action: string;
  lineKeys: LineKey[];
  refs: Ref[];
}

// ── The assembled return ──────────────────────────────────────────────────────

/** One line of the assembled return, serializable (plain numbers and strings). */
export interface ReturnLine {
  key: LineKey;
  /** "Form 1040", "Schedule C", "CT-1040" ... */
  form: string;
  formLine: string;
  label: string;
  status: RuleStatus;
  /** Whole dollars; null unless status carries an amount. */
  amount: number | null;
  /** Unrounded decimal string, or null. */
  exact: string | null;
  reason: string | null;
  /** See RuleLine.informational: an amount that is intentionally not estimated and never blocks the return. */
  informational?: boolean;
  ruleId: string;
  citations: string[];
  refs: Ref[];
}

export interface HeadlineAmount {
  status: RuleStatus;
  amount: number | null;
  reason: string | null;
}

/**
 * Best-known numbers when the strict return is incomplete: every unresolved
 * (missing / not-yet-computed / needs-CPA) input is treated as $0 and LISTED, so
 * the figures are an explicit provisional estimate, never presented as computed.
 */
export interface ProvisionalHeadline {
  note: string;
  /** Lines whose unresolved value was treated as $0 in this provisional run. */
  assumedZeroLines: LineKey[];
  /** Input facts that were missing and were filled with a neutral value (0, none) in this provisional run. */
  assumedFacts: string[];
  agi: number | null;
  taxableIncome: number | null;
  totalTax: number | null;
  totalPayments: number | null;
  /** Positive = amount owed, negative = refund (whole dollars). */
  federalBalance: number | null;
  ctTax: number | null;
  ctPayments: number | null;
  ctBalance: number | null;
  /** Every line the provisional pass could compute (whole dollars). Estimates only: never print them as computed. */
  lines: Partial<Record<LineKey, number>>;
}

export interface Headline {
  /** True only when every headline line below is `computed`. */
  complete: boolean;
  federal: {
    agi: HeadlineAmount;
    taxableIncome: HeadlineAmount;
    totalTax: HeadlineAmount;
    totalPayments: HeadlineAmount;
    /** Positive = amount owed, negative = refund. */
    balance: HeadlineAmount;
  };
  connecticut: {
    ctAgi: HeadlineAmount;
    tax: HeadlineAmount;
    totalPayments: HeadlineAmount;
    balance: HeadlineAmount;
  };
  blockingItemCount: number;
  /**
   * `complete` means: every headline amount is computed and there is no blocking open item. It does NOT mean "nothing left to
   * check": the caveats below are things the numbers rest on or leave out (unverified AI document reads, inferred owner /
   * residence, decisions still at their default, deliberately unestimated penalty lines). A sheet must print them next to
   * a "complete" headline.
   */
  unverifiedDocumentCount: number;
  /** Inputs inferred rather than stated (Schedule C owner by name, primary residence by the 1098 address). */
  derivedInputCount: number;
  /** Decisions (X1 / X3 / X5) still at their default alternative. */
  undecidedDecisionCount: number;
  /** Plain-language caveats (advisory), one per item above plus every informational line. */
  caveats: string[];
  provisional: ProvisionalHeadline | null;
}

/** Schedule C accounts feeding one line (for Part II / Part V printing and the review sheet). */
export interface ScheduleCAccountDetail {
  code: string;
  name: string;
  /** Booked amount, integer cents (unsigned, as the P&L reports it). */
  rawCents: number;
  /**
   * Amount that goes on the line after the account's own rule (meals: 50%), informational only: for meals each account is rounded
   * to whole dollars while the LINE applies 50% once to the cent-accurate total, so per-account figures may differ from the
   * line by a dollar or two. Print line amounts from the line, not from these.
   */
  deductibleCents: number;
}

/** Per-GL-code breakdown of Schedule C so the PDF layer can print Part II / Part V and explain every line. */
export interface ScheduleCDetail {
  lines: { lineId: ScheduleCLineId; amountCents: number; accounts: ScheduleCAccountDetail[] }[];
  /** Part V (line 48) items: one per GL account mapped to line 27b. */
  otherExpenseItems: { code: string; name: string; amountCents: number }[];
  unmapped: { code: string; name: string; totalCents: number; glType: "revenue" | "expense" }[];
  needsCpa: { code: string; name: string; totalCents: number; reason: string }[];
  /** Home-office GL accounts (inputs to Form 8829 under the actual method, decision X1). */
  homeOfficeActualCandidates: { code: string; name: string; totalCents: number }[];
  vehicleActual: { code: string; name: string; totalCents: number }[];
  mileage: { entries: number; miles: number; deductionCents: number };
  cogsTotalCents: number;
  /**
   * Interest earned on the business bank account per the books (GL map target `interest_to_1040_2b`): EXCLUDED from Schedule C and
   * added to 1040 line 2b / Schedule B (print as one payer row "Interest from business bank account (per EK Consulting books)").
   */
  booksInterest: { code: string; name: string; amountCents: number }[];
}

export type FormId =
  | "f1040"
  | "sch1"
  | "sch2"
  | "sch3"
  | "scha"
  | "schb"
  | "schc"
  | "schse"
  | "f8995"
  | "f8959"
  | "f6251"
  | "f8960"
  | "f8283"
  | "f2210"
  | "sch1a"
  | "f8889"
  | "f8880"
  | "f5695"
  | "f4562"
  | "f8829"
  | "schd"
  | "f8949"
  | "ct1040";

/** Whether a form belongs in the filing packet, derived from the computed return. */
export interface FormRequirement {
  /** true = include; false = not needed; "blocking" = cannot tell until a blocking item is resolved. */
  required: boolean | "blocking";
  reason: string;
}

/** A yes / no answer printed on the return (not a money line): Form 1040 page 1 and Schedule B Part III. */
export interface AttestationAnswer {
  /** true = Yes, false = No, null = not answered / not sure. */
  value: boolean | null;
  status: "answered" | "unsure" | "missing";
  /** Where it is printed, e.g. "Form 1040 page 1, digital assets question". */
  where: string;
  refs: Ref[];
}

/** Schedule D line a Form 8949 category's totals land on (lines 1b, 2, 3, 8b, 9, 10) or is entered directly (1a, 8a). */
export type ScheduleDLineId = "1a" | "1b" | "2" | "3" | "8a" | "8b" | "9" | "10";

/** One broker summary row of a category: the Form 8949 "Exception 2" summary row for that broker. Exact integer cents. */
export interface ScheduleDSummaryRow {
  docIds: string[];
  /** Broker name as read, null when not read. */
  payer: string | null;
  proceedsCents: number | null;
  costCents: number | null;
  /** Column (g): the wash sale loss disallowed, as a POSITIVE number (null = not read). */
  washSaleCents: number | null;
  /** Column (h) = proceeds - cost + column (g), exact cents; null when any input is null. */
  gainCents: number | null;
  /** The broker-printed gain, summed over this row's documents (null when any is not read); a cross-check only. */
  brokerGainCents: number | null;
}

/** One Form 8949 category (information return + box), summed over the documents that report it. */
export interface ScheduleDCategory {
  form: "1099-B" | "1099-DA";
  box: BrokerBox;
  part: "I" | "II";
  /** The Schedule D line this category's totals are entered on. */
  line: ScheduleDLineId;
  /** schedule_d_direct = lines 1a / 8a (no Form 8949); form_8949_summary = a Form 8949 summary row per broker (Exception 2) with an attached statement. */
  routing: "schedule_d_direct" | "form_8949_summary";
  proceedsCents: number | null;
  costCents: number | null;
  washSaleCents: number | null;
  gainCents: number | null;
  /** Form 8949 column (f) code(s) for a summary row in alphabetical order ("M", or "MW" with wash sales); "" when entered directly. */
  codes: string;
  /** Form 8949 column (a) text for a summary row: the broker name followed by "see attached statement" (columns (b) and (c) stay blank). */
  description: string;
  /** One row per broker (the instructions: totals from each broker on a separate row). */
  rows: ScheduleDSummaryRow[];
}

/** Schedule D / Form 8949 detail for the PDF layer and the review sheet (the engine's own numbers are in the `schd.*` lines). */
export interface ScheduleDDetail {
  /** true = Schedule D is filed; false = Exception 1 (only capital gain distributions, 1040 line 7b box); "blocking" = cannot tell yet. */
  required: boolean | "blocking";
  /** Exception 1 applies: 1040 line 7a = Form 1099-DIV box 2a and the "Schedule D not required" box on line 7b is checked. */
  exception1: boolean;
  /** Some category goes through Form 8949 (summary rows + attached statement). "blocking" = a category's routing cannot be decided yet. */
  form8949Required: boolean | "blocking";
  categories: ScheduleDCategory[];
  /** Line 17 "Are lines 15 and 16 both gains?" (null = not known / not asked). */
  line17: boolean | null;
  /** Line 20 "Are lines 18 and 19 both zero or blank and you are not filing Form 4952?" (null = not asked / not known). Form 4952 is not modeled. */
  line20: boolean | null;
  /** Line 22 "Do you have qualified dividends on Form 1040 line 3a?" (null = not asked). */
  line22: boolean | null;
  /** The Schedule D Tax Worksheet (not implemented) would be needed: lines 15 and 16 gains and line 18 or 19 not known to be zero. */
  taxWorksheetNeeded: boolean;
  /** Capital loss carried to 2026, provisional (the 2026 Capital Loss Carryover Worksheet governs); null when there is none or it cannot be figured. */
  carryoverOut: { shortCents: number; longCents: number; totalCents: number } | null;
}

export interface Ty2025Return {
  /** Bumped whenever a rule or the line catalog changes (stale-output detection). */
  engineVersion: string;
  taxYear: 2025;
  filingStatus: "mfj";
  lines: Partial<Record<LineKey, ReturnLine>>;
  results: RuleResult[];
  conflicts: FactConflict[];
  openItems: OpenItem[];
  decisions: RuleDecision[];
  headline: Headline;
  /** Constant ids used anywhere in the return, for the citation list. */
  citations: string[];
  /** Schedule C per-account breakdown (null when the books could not be read at all). */
  scheduleC: ScheduleCDetail | null;
  /** Schedule D / Form 8949 detail (null when the whole return is blocked before Schedule D is assessed). */
  scheduleD: ScheduleDDetail | null;
  /** Which forms the packet needs (C7). */
  formsRequired: Partial<Record<FormId, FormRequirement>>;
  /** Header yes / no questions answered by the owner (Phase 1b). */
  attestations: { digitalAssets: AttestationAnswer; foreignAccounts: AttestationAnswer };
}
