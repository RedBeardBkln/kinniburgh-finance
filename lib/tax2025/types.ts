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
  provisional: ProvisionalHeadline | null;
}

/** Schedule C accounts feeding one line (for Part II / Part V printing and the review sheet). */
export interface ScheduleCAccountDetail {
  code: string;
  name: string;
  /** Booked amount, integer cents (unsigned, as the P&L reports it). */
  rawCents: number;
  /** Amount that goes on the line after the account's own rule (meals: 50%). */
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
  | "ct1040";

/** Whether a form belongs in the filing packet, derived from the computed return. */
export interface FormRequirement {
  /** true = include; false = not needed; "blocking" = cannot tell until a blocking item is resolved. */
  required: boolean | "blocking";
  reason: string;
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
  /** Which forms the packet needs (C7). */
  formsRequired: Partial<Record<FormId, FormRequirement>>;
}
