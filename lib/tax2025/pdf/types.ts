// Types of the PDF layer (plan sections 5.3, 6.3, 6.4). Everything in lib/tax2025/pdf/
// except the (later) adapter depends only on PdfReturnView, a plain JSON-safe view of
// the effective return. Money in PdfLine is INTEGER DOLLARS (the engine already
// applied roundLine); no floats, no Decimal.

import type { FormId, Headline, LineKey, RuleStatus } from "@/lib/tax2025/types";
import type { PendingLineKey } from "@/lib/tax2025/pdf/pending-line-keys";
import type { FitKind } from "@/lib/tax2025/pdf/fit-text";

/** A line a map may reference: an engine key or a not-yet-emitted (pending) key. */
export type LineRef = LineKey | PendingLineKey;

/** `overridden` exists only in the effective view (RuleStatus belongs to the engine). */
export type PdfLineStatus = RuleStatus | "overridden";

export interface PdfLineOverride {
  /** The single note string used everywhere (formatOverrideNote), e.g. "CPA override: was $1 computed, now $2, by ...". */
  note: string;
  /** Base computed whole-dollar amount (null when the base line carried none). */
  computedAmount: number | null;
  stale: boolean;
  /** The override SUPPLIES a value the engine could not compute (missing input / needs CPA / not yet computed). The adapter always sets it. */
  supplied?: boolean;
}

export interface PdfLine {
  key: LineRef;
  status: PdfLineStatus;
  /** Whole dollars. Null unless the status carries an amount. */
  amount: number | null;
  reason: string | null;
  /** "Form 1040", "Schedule C", ... */
  formLabel: string;
  /** As printed, e.g. "11a". */
  formLine: string;
  label: string;
  override?: PdfLineOverride;
  /** Overridden lines this line depends on ("Schedule 1 line 3"): the line was NOT recomputed from them. */
  dependsOnOverridden?: string[];
  /** Set when the line comes from a rule whose in-force alternative is an undecided default: the decision label. */
  defaultUndecided?: string;
  /**
   * The engine marks the line informational (an amount intentionally not estimated that never blocks the
   * return, e.g. CT late-payment penalty / interest): a blank for it is an ADVISORY item, not a blocking one.
   */
  informational?: boolean;
}

export type PdfSeverity = "blocking" | "advisory";

/** An engine/CPA-facing open item as the cover prints it. */
export interface PdfOpenItem {
  id: string;
  severity: PdfSeverity;
  /** "Form 1040", ... or "General". */
  formLabel: string;
  lineKeys: string[];
  message: string;
  action: string;
}

export interface PdfDecision {
  id: string;
  label: string;
  /** Alternative id in force. */
  chosen: string;
  status: "decided" | "default_undecided";
  decidedBy?: string;
  decidedAt?: string;
  /** Plain-language tax effect of the alternative, when known. */
  effectNote?: string;
  /** The recorded-override note (who / when / why / authority) when the decision was recorded through an override. */
  overrideNote?: string;
}

export interface PdfOverrideEntry {
  key: string;
  formLabel: string;
  formLine: string;
  note: string;
  stale: boolean;
  /** The override SUPPLIES a value the engine could not compute. The adapter always sets it. */
  supplied?: boolean;
}

/** A line that depends on an overridden line and was NOT recomputed. */
export interface PdfDependentLine {
  key: string;
  formLabel: string;
  formLine: string;
  /** "Schedule 1 line 3", ... */
  dependsOn: string[];
}

/** A headline row whose source line is overridden or depends on an override. */
export interface PdfHeadlineMark {
  label: string;
  overridden: boolean;
  dependsOnOverride: boolean;
  /** Whole dollars, only when the row's source line is overridden. */
  effectiveAmount: number | null;
}

export interface PdfOverrideNotice {
  /** A line override is in force: totals and dependent lines were NOT recomputed. */
  totalsNotRecomputed: boolean;
  dependents: PdfDependentLine[];
  headlineMarks: PdfHeadlineMark[];
  /** Engine changed since an override was set, value unchanged (advisory). */
  engineChanged: string[];
  /** Overrides in force: line figures + decisions + acknowledgements (counts only go to the audit row). */
  count: number;
}

/** A blocking engine item whose lines were all supplied by overrides: no longer blocking, still listed. */
export interface PdfResolvedItem {
  id: string;
  message: string;
  note: string;
}

export interface PdfAcknowledged {
  ruleId: string;
  /** The recorded acknowledgement note (who / when / why). */
  note: string;
}

export type TableKey =
  | "schb.interest"
  | "schb.dividends"
  | "ct.withholding"
  | "ct.propertyTax"
  | "schc.otherExpenses"
  | "f8283.sectionA"
  // Form 8949 (all copies together; maps/f8949.ts splits them into copies, see FormMap.copies). Every row carries
  // a `box` cell ("A".."L"); the totals tables carry the engine's Schedule D line totals per box.
  | "f8949.partI"
  | "f8949.partII"
  | "f8949.totalsI"
  | "f8949.totalsII";

export interface PdfTableRow {
  /** Column id -> value. Numbers are whole dollars (money columns); strings are text columns. */
  cells: Readonly<Record<string, string | number | null>>;
}

/** An answer a checkbox/text map entry can read (filing status, Y/N attestations, occupations ...). */
export type PdfAnswer = string | boolean | null;

export interface PdfHeader {
  /** "Name1 and Name2". */
  householdNames: string | null;
  taxpayerName: string | null;
  spouseName: string | null;
  /** Schedule C proprietor business name (EKC). */
  ekcName: string | null;
}

/** The engine's verdict on whether a form belongs in the filing (Ty2025Return.formsRequired entry). */
export interface PdfFormRequirement {
  /** true = include; false = not needed; "blocking" = cannot tell until a blocking item is resolved. */
  required: boolean | "blocking";
  reason: string;
}

export interface PdfReturnView {
  taxYear: 2025;
  filingStatus: "mfj";
  /** ISO timestamp the view was built (display converted to America/New_York). */
  generatedAt: string;
  generatedBy: string;
  /** Hex SHA-256 of the canonical JSON of { lines, openItems, decisions, headline }; the cover prints 12 hex. */
  fingerprint: string;
  /** Optional engine version const. */
  engineVersion?: string;
  lines: Partial<Record<LineRef, PdfLine>>;
  header: PdfHeader;
  answers: Readonly<Record<string, PdfAnswer>>;
  tables: Partial<Record<TableKey, PdfTableRow[]>>;
  openItems: PdfOpenItem[];
  decisions: PdfDecision[];
  overrides: PdfOverrideEntry[];
  /** Totals-not-recomputed notice, dependent lines, headline marks (empty / false when nothing is overridden). */
  overrideNotice: PdfOverrideNotice;
  /** Blocking items resolved by line overrides (kept visible; not counted as blocking). */
  resolvedByOverride: PdfResolvedItem[];
  /** Rules the CPA acknowledged, with the recorded note (kept visible; not blocking). */
  acknowledged: PdfAcknowledged[];
  headline: Headline;
  /** Constant ids used anywhere in the return, for the citation legend. */
  citations: string[];
  /**
   * Ty2025Return.formsRequired keyed by the engine's FormId ("schb", "f8959", "f8995", ...).
   * When present, a map with an `engineFormId` is included/omitted by the engine's verdict
   * instead of the line-based inclusion rule (policy.ts formInclusion).
   */
  formsRequired?: Partial<Record<string, PdfFormRequirement>>;
}

// ── Maps ──────────────────────────────────────────────────────────────────────

export type BlankReason =
  | "ssn"
  | "ein"
  | "bank"
  | "signature_pin"
  | "preparer"
  | "contact_address"
  | "owner_statement_na"
  | "not_modeled"
  | "form_na";

export const BLANK_REASON_LABELS: Readonly<Record<BlankReason, string>> = {
  ssn: "Social security numbers",
  ein: "Employer identification numbers",
  bank: "Bank routing / account numbers",
  signature_pin: "Signatures and PINs",
  preparer: "Paid preparer and third-party designee",
  contact_address: "Address, phone, email, occupation",
  owner_statement_na: "Does not apply (owner statement)",
  not_modeled: "Not modeled by the engine yet",
  form_na: "Not used by this return (the form directs it elsewhere or has no such entry)",
};

export type HeaderSource =
  | "household.names"
  | "household.taxpayer"
  | "household.spouse"
  | "household.taxpayerFirst"
  | "household.taxpayerLast"
  | "household.spouseFirst"
  | "household.spouseLast"
  | "entity.ekcName"
  | "year";

export interface MapMoneyLine {
  kind: "money";
  field: string;
  line: LineRef;
  /** Print "0" for a computed/not-applicable zero (subtotals and lines the form says to enter 0 on). */
  zero?: "print";
  /**
   * Print "0" for a computed / not-applicable zero only while an answer holds (answers[choice] === equals):
   * Form 1040 line 7a is blank unless Schedule D is filed with line 16 exactly 0 ("enter -0- on line 7a").
   */
  zeroWhen?: { choice: string; equals: string | boolean };
  /** The form is not valid without this line: list under "lines the engine does not emit" when absent. */
  expected?: boolean;
  /**
   * One signed engine amount feeds two printed lines (e.g. CT balance: positive = tax due,
   * negative = overpayment). "owed" prints the amount only when it is positive; "refund"
   * prints the magnitude only when it is negative. Anything else leaves the field blank.
   */
  sign?: "owed" | "refund";
}

export interface MapCheckLine {
  kind: "check";
  field: string;
  /** Key of PdfReturnView.answers (e.g. "filingStatus", "digitalAssets"). */
  choice: string;
  /** Checked iff answers[choice] === equals. Unanswered (undefined / null) => unchecked. */
  equals: string | boolean;
  /** When true and the answer is missing, an open item "answer needed" is raised. */
  required?: boolean;
  /** Human text for the open item. */
  label?: string;
}

export interface MapTextLine {
  kind: "text";
  field: string;
  /** Key of PdfReturnView.answers holding a string. */
  answer: string;
  label?: string;
}

export type MapLine = MapMoneyLine | MapCheckLine | MapTextLine;

export interface MapHeaderEntry {
  field: string;
  source: HeaderSource;
}

export interface MapTable {
  table: TableKey;
  /** One record per row: column id -> full field name. */
  rows: ReadonlyArray<Readonly<Record<string, string>>>;
  /** Column id holding whole-dollar money, summed into the overflow row. */
  amountColumn: string;
  /** Column id holding the row label, set to "Other (see statement)" in the overflow row. */
  labelColumn: string;
  /**
   * What happens when there are more rows than the table holds. "summary_row_and_statement": the last
   * row becomes "Other (see statement)" with the rest summed (fine for Schedule B style lists).
   * "none": the table must never overflow (Form 8949: the IRS forbids a summary total without the
   * statement, so the map's `copies` splits rows over more copies); more rows than capacity is a defect and throws.
   * amountColumn / labelColumn are unused for "none".
   */
  overflow: "summary_row_and_statement" | "none";
  /**
   * List every row on the cover even when they all fit (for tables where the printed form has
   * no column that identifies a row, e.g. the CT-1040 withholding schedule has no employer name).
   */
  coverList?: boolean;
  /**
   * Columns whose text must be fitted into the cell (fit-text.ts): column id -> kind of cell. A shortened or truncated
   * value raises an advisory item carrying the full text; a value that only needs a smaller font does not.
   */
  fit?: Readonly<Record<string, FitKind>>;
}

export type MapBlank =
  | { field: string; reason: BlankReason; note?: string }
  | { match: RegExp; reason: BlankReason; note?: string };

/**
 * One physical copy of a form that may be filed several times (Form 8949: one Part I box and one Part II
 * box per copy). The map fills the unchanged blank once per copy against a derived view (the base view with
 * `answers` merged and `tables` replaced); every copy is a separate PDF in the packet.
 */
export interface FormCopy {
  /** File-name suffix: lowercase letters, digits and dashes, unique within the form ("a-1", "ad-2"). */
  suffix: string;
  /** One line for the cover: what this copy holds ("Part I box A (1 row); Part II not used"). */
  label: string;
  /** Merged over view.answers for this copy (the box checkboxes). */
  answers: Readonly<Record<string, PdfAnswer>>;
  /** Replaces the same keys of view.tables for this copy (the rows that belong on it). */
  tables: Partial<Record<TableKey, PdfTableRow[]>>;
}

export interface FormMap {
  formId: string;
  /** The engine's FormId for this form (Ty2025Return.formsRequired key), when the engine decides inclusion. */
  engineFormId?: FormId;
  lines: MapLine[];
  tables: MapTable[];
  header: MapHeaderEntry[];
  blank: MapBlank[];
  /**
   * Present only for a form filed in several copies. Pure function of the view. An empty result means "nothing
   * to put on a copy": the packet then emits ONE copy filled from the view as it is (a blank form) when the
   * form is included at all (the engine's verdict decides inclusion, never this function).
   */
  copies?: (view: PdfReturnView) => FormCopy[];
}

// ── Fill output ───────────────────────────────────────────────────────────────

export type PacketOpenItemSource = "line_blank" | "fill";

/** An item produced while filling a form (never the engine's own OpenItem). */
export interface PacketOpenItem {
  /** Stable within a packet (de-duplicated by id): e.g. "blank:f1040:f1040.11a". */
  id: string;
  severity: PdfSeverity;
  source: PacketOpenItemSource;
  formId: string;
  lineKey?: string;
  field?: string;
  message: string;
}

export interface ContinuationList {
  formId: string;
  table: TableKey;
  /** Every row, including those that fit on the form. */
  rows: Array<Record<string, string | number | null>>;
}

export interface FillOptions {
  /** Per-page DRAFT footer (decision E1). Default true. */
  stamp: boolean;
  /** 12 hex chars of the fingerprint, printed in the stamp. */
  fingerprint: string;
  /** Display date for the stamp ("2026-10-03"). */
  stampDate: string;
  /** When set (use ALTERNATIVE_STAMP_TEXT), this text is stamped on every page regardless of `stamp`. */
  alternativeLabel?: string;
}

export interface FillResult {
  formId: string;
  bytes: Uint8Array;
  openItems: PacketOpenItem[];
  /** Fields that received a value (name only; values are never logged). */
  filledFields: string[];
  /** Per blank reason: how many fields were left blank by design. */
  blankByDesign: Partial<Record<BlankReason, number>>;
  /**
   * Plain-language notes of the blank entries that carry one (a box or entry the app does not
   * decide, e.g. "12a: someone can claim you or your spouse as a dependent"). The cover lists
   * each so a not-modeled box is never silently skipped. Deduplicated, in map order.
   */
  blankNotes: string[];
  continuations: ContinuationList[];
}
