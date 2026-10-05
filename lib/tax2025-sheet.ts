// The RETURN REVIEW SHEET view model (Phase 1c): Ty2025Return -> SheetModel.
//
// PURE: no DB, no clock (the caller passes `now`), no network. The model is plain
// JSON (strings, whole-dollar numbers, booleans, null, arrays, objects): no Decimal,
// no undefined, no Date. That is the only shape a server component may hand to a
// client component, and the CSV export is built from the same model so the page and
// the CSV can never disagree.
//
// Honesty rules the builder enforces (pinned by lib/__tests__/tax2025-sheet.test.ts):
//   - every line the engine emitted appears exactly once, in catalog order;
//   - a line without an amount is NEVER rendered as 0: its amount text says
//     "not computed" and the CSV amount cell is empty;
//   - blocking open items come first;
//   - a decision's conservative alternative is marked "default, undecided" until a
//     decision is recorded;
//   - the DRAFT wording says the owner is the preparer of record (no CPA reviews the return);
//   - every owner-visible string leaves buildSheetModel through ownerWordingDeep (lib/tax-wording.ts), so engine prose
//     that still says "the CPA decides" is reworded at this boundary and the identifiers (status, who) stay as they are.

import { allConstants } from "@/lib/tax2025/constants";
import { ownerWordingDeep } from "@/lib/tax-wording";
import {
  DECISION_KEYS,
  DECISION_REGISTRY,
  affectedLines,
  authorityLabel,
  formatOverrideNote,
  isValidDecisionChoice,
  type AppliedDecisionOverride,
  type AppliedLineOverride,
  type EffectiveLine,
  type EffectiveReturn,
  type HeadlineRowId,
  type OverrideAuthority,
} from "@/lib/tax2025/overrides";
import { formatNewYorkDate, formatNewYorkDateTime } from "@/lib/tax2025/pdf/format";
import {
  LINE_KEYS,
  hasAmount,
  lineMeta,
  type FormId,
  type FormRequirement,
  type LineKey,
  type OpenItem,
  type ReturnLine,
  type RuleAlternative,
  type RuleResult,
  type RuleStatus,
  type Ty2025Return,
} from "@/lib/tax2025/types";

export const SHEET_DRAFT_LABEL = "DRAFT - not a filed return - computed from the inputs shown; the owner is the preparer of record";

export const SHEET_SUPPORTED_YEAR = 2025;

// ── Types (all JSON-safe) ─────────────────────────────────────────────────────

/** "overridden": the value on this line is a recorded owner override, not the engine's. */
export type SheetStatus = RuleStatus | "informational" | "overridden";

export const SHEET_STATUS_LABELS: Readonly<Record<SheetStatus, string>> = {
  computed: "computed",
  missing_input: "missing input",
  not_yet_computed: "not yet computed",
  needs_cpa_rule_unverified: "rule not verified (needs a professional's input or your own research)",
  needs_cpa_judgment: "needs your decision",
  not_applicable: "not applicable",
  informational: "informational",
  overridden: "override",
};

export type SheetChipKind =
  | "document_verified"
  | "document_unverified"
  | "owner_answer"
  | "books"
  | "derived"
  | "paystub"
  | "decision"
  | "override";

export interface SheetChip {
  kind: SheetChipKind;
  label: string;
  /** In-app link (document review screen) or null. */
  href: string | null;
}

export const SHEET_CHIP_LABELS: Readonly<Record<SheetChipKind, string>> = {
  document_verified: "document (verified)",
  document_unverified: "document (UNVERIFIED AI read)",
  owner_answer: "owner answer",
  books: "books",
  derived: "derived",
  paystub: "paystub",
  decision: "decision",
  override: "override",
};

/**
 * A recorded line override as the sheet shows it (built from the overrides module's
 * AppliedLineOverride; plain JSON). `note` is formatOverrideNote: the ONE string the
 * sheet, the CSV, the PDF field note and the cover all print.
 */
export interface SheetLineOverride {
  id: string;
  version: number;
  authority: OverrideAuthority;
  /** "Advisor (recorded earlier)" or "Owner (Eric/Eva)". */
  authorityLabel: string;
  /** What the engine computed: "$12,345 computed" or "missing input" ... */
  wasText: string;
  /** The engine's own value for this line (null when it carried none). */
  computedAmount: number | null;
  computedStatusLabel: string;
  /** The override value, whole dollars. */
  nowAmount: number;
  note: string;
  by: string;
  /** ISO timestamp. */
  at: string;
  /** YYYY-MM-DD in America/New_York. */
  atDate: string;
  reason: string;
  /** The override supplies a value the engine could not produce (missing input / needs a decision / not yet computed). */
  supplied: boolean;
  stale: boolean;
  staleMessage: string | null;
}

/** The engine's own state of a line, before any override. */
export interface SheetLineComputed {
  amount: number | null;
  amountText: string;
  statusLabel: string;
  reason: string | null;
  /** The engine has no value for it (the override dialog says "no value yet"). */
  blocked: boolean;
}

export interface SheetCitation {
  id: string;
  url: string | null;
  verifiedOn: string | null;
  note: string | null;
}

export interface SheetLine {
  key: string;
  form: string;
  /** The line id as printed on the form, e.g. "11a". */
  formLine: string;
  label: string;
  status: SheetStatus;
  statusLabel: string;
  /** Whole dollars; null unless the status carries an amount. */
  amount: number | null;
  /** "$1,234", "-$12", or "not computed" (never "0" for a line without an amount). */
  amountText: string;
  reason: string | null;
  citations: SheetCitation[];
  chips: SheetChip[];
  /** Decision label when the line comes from an alternative that is an undecided default. */
  defaultUndecided: string | null;
  override: SheetLineOverride | null;
  /** The engine's own state of this line (before any override). */
  computed: SheetLineComputed;
  /** Lines this line feeds that an override here would NOT recompute (capped at 10; see affectsMore). */
  affects: string[];
  affectsMore: number;
  /** Overridden lines this line depends on: it was NOT recomputed from them. */
  dependsOnOverridden: { key: string; text: string }[];
  /** An override can be set on this line (the sheet was built with overrides wired in). */
  canOverride: boolean;
}

export interface SheetFormGroup {
  form: string;
  /** The engine's packet verdict for this form, when it has one. */
  requirement: { required: boolean | "blocking"; label: string; reason: string } | null;
  lines: SheetLine[];
}

export interface SheetAlternative {
  id: string;
  label: string;
  status: SheetStatus;
  statusLabel: string;
  isDefault: boolean;
  inForce: boolean;
  /** "default, undecided" | "default" | "chosen" | null. */
  marker: string | null;
  effectAmountText: string | null;
  effectNote: string | null;
  reasons: string[];
}

/** A decision recorded through the overrides table (who / when / why, shown with the decision). */
export interface SheetDecisionOverride {
  id: string;
  version: number;
  authority: OverrideAuthority;
  authorityLabel: string;
  note: string;
  by: string;
  at: string;
  atDate: string;
  reason: string;
  choice: string;
}

/** One choice the decision dialog offers (an alternative the engine computed). */
export interface SheetDecisionChoice {
  id: string;
  label: string;
  /** The engine's effect text for this alternative. */
  effectText: string;
  isDefault: boolean;
  inForce: boolean;
}

export interface SheetDecision {
  id: string;
  label: string;
  chosen: string;
  /** The overrides-table key for this decision (null when the id is not a recordable decision). */
  decisionKey: string | null;
  /** The recorded override, when the decision was made through the overrides table. */
  override: SheetDecisionOverride | null;
  /** Choices a user may record (alternatives that are valid decision choices). */
  choices: SheetDecisionChoice[];
  /** "default, undecided" or "decided". */
  statusText: string;
  undecided: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  /** Form lines the in-force alternative carries, e.g. "Schedule C 30". */
  affectedLines: string[];
  alternatives: SheetAlternative[];
  /** The engine's own whole-return effect text, in-force alternative first. */
  wholeReturnEffect: string;
}

/** A decision the engine did not raise for this return (not triggered, or computed in a later phase). */
export interface SheetDecisionPlaceholder {
  id: string;
  label: string;
  note: string;
}

/** Where a figure or an item came from (a document id, a questionnaire node, a GL code ...): what the links on the sheet are resolved from. Constants are never listed. */
export interface SheetRef {
  kind: string;
  id: string;
  label: string;
}

export interface SheetOpenItem {
  id: string;
  severity: "blocking" | "advisory";
  message: string;
  action: string;
  /** Who has to act: the owner's answer ("owner"), the owner's own decision ("cpa": legacy identifier, shown as "your decision"), or nobody ("derived"). */
  who: "owner" | "cpa" | "derived";
  /**
   * What the OWNER has to do (the real root inputs only; derived figures such as taxable income are never asked of the
   * owner). Null unless who === "owner".
   */
  ownerAction: string | null;
  lines: { key: string; text: string }[];
  /** The sources the engine attached to the item (documents, answers, books entries ...). */
  refs: SheetRef[];
}

export interface SheetConflict {
  factKey: string;
  chosen: string | null;
  reason: string;
  candidates: { basisLabel: string; label: string; valueText: string; refs: SheetRef[] }[];
}

export interface SheetHomework {
  id: string;
  severity: "blocking" | "advisory";
  what: string;
  why: string;
  lines: string[];
}

export interface SheetDocumentRow {
  id: string;
  docTypeLabel: string;
  taxYear: number | null;
  subject: string | null;
  /** "verified" | "unverified AI read" | "older format (re-extract)" | "not on file list". */
  statusText: string;
  verified: boolean;
  href: string;
  fedLines: { key: string; text: string }[];
}

export interface SheetHeadlineRow {
  label: string;
  /** The strict (computed) figure or "not computed". */
  computedText: string;
  status: SheetStatus;
  statusLabel: string;
  /** The provisional estimate when the return is incomplete; null when complete or not estimated. */
  provisionalText: string | null;
  /** A line this row is read from is overridden: `computedText` is the ENGINE's figure, `effectiveText` the override-based one. */
  overridden: boolean;
  /** A line this row is read from depends on an override and was NOT recomputed. */
  dependsOnOverride: boolean;
  /** The row's figure read from the effective lines (only when `overridden` and every source has a value). */
  effectiveText: string | null;
}

/** Everything the overrides panel (sheet top, printed) and the CSV notice need. Empty when nothing is overridden. */
export interface SheetOverridesSummary {
  /** Line overrides in force. */
  lineCount: number;
  decisionCount: number;
  ackCount: number;
  /** True when a line override is in force: headline totals and downstream lines were NOT recomputed. */
  totalsNotRecomputed: boolean;
  /** One sentence for the banner; null when nothing is overridden. */
  totalsNotice: string | null;
  lines: { key: string; lineText: string; label: string; note: string; authorityLabel: string; stale: boolean; supplied: boolean }[];
  decisions: { label: string; note: string }[];
  acknowledgements: { ruleId: string; note: string; items: string[] }[];
  /** Lines flagged "depends on an override" (NOT recomputed), each with the overridden lines it depends on. */
  dependents: { key: string; lineText: string; dependsOn: string[] }[];
  /** Blocking engine items whose lines were all supplied by overrides: still listed, no longer counted as blocking. */
  resolvedByOverride: { id: string; message: string; lines: { key: string; text: string }[]; notes: string[] }[];
  stale: { key: string; message: string }[];
  engineChanged: { key: string; message: string }[];
  orphans: string[];
  anomalies: string[];
  invalid: string[];
}

export interface SheetAttestation {
  label: string;
  answerText: string;
  status: "answered" | "unsure" | "missing";
}

export interface SheetModel {
  taxYear: 2025;
  engineVersion: string;
  /** ISO timestamp the sheet was built. */
  generatedAt: string;
  /** America/New_York. */
  generatedAtDisplay: string;
  draftLabel: string;
  summary: {
    complete: boolean;
    /** "COMPLETE per the engine ..." or "INCOMPLETE: N blocking item(s)". */
    completenessText: string;
    blockingItemCount: number;
    advisoryItemCount: number;
    unverifiedDocumentCount: number;
    derivedInputCount: number;
    undecidedDecisionCount: number;
    caveats: string[];
    provisionalNote: string | null;
    provisionalAssumedFacts: string[];
    federal: SheetHeadlineRow[];
    connecticut: SheetHeadlineRow[];
    statusCounts: Record<SheetStatus, number>;
    overrides: SheetOverridesSummary;
  };
  federal: SheetFormGroup[];
  connecticut: SheetFormGroup[];
  attestations: SheetAttestation[];
  decisions: SheetDecision[];
  decisionPlaceholders: SheetDecisionPlaceholder[];
  /** Blocking first. */
  openItems: SheetOpenItem[];
  conflicts: SheetConflict[];
  homework: SheetHomework[];
  documents: SheetDocumentRow[];
  citations: SheetCitation[];
  checklist: string[];
  /** The number of line overrides rendered. */
  overrideCount: number;
}

/** What the builder needs to know about each document (a subset of the loader's SafeRawSummary). */
export interface SheetRawDocument {
  id: string;
  docType: string;
  taxYear: number | null;
  verified: boolean;
  legacyFormat: boolean;
  subjectType: string | null;
}

export interface BuildSheetInput {
  ret: Ty2025Return;
  documents: readonly SheetRawDocument[];
  now: Date;
  /**
   * The return with the recorded overrides applied (applyOverrides). When present the sheet shows the EFFECTIVE
   * values and marks every override; when absent it shows the engine's own return and offers no override buttons.
   */
  effective?: EffectiveReturn;
}

// ── Static text ───────────────────────────────────────────────────────────────

export const SHEET_CHECKLIST: readonly string[] = [
  "Review every decision on the decisions page (home office method, depreciation elections, Form 8995 versus 8995-A, Arbor Rd property tax) and record the alternative you choose. The defaults shown are the conservative alternative, not a recommendation.",
  "Confirm each open item (blocking first) is resolved or knowingly accepted, and read the conflicts list.",
  "Check every figure that rests on an UNVERIFIED AI document read against the source document.",
  "Confirm Social Security numbers, dates of birth, bank routing and account numbers, signatures and PINs are added by you on the printed forms. This app never stores them and never fills them in.",
  "Confirm prior-year carryforwards from the 2024 return (Form 5695 clean energy credit, qualified business loss, capital loss, charitable and any other carryover). None are assumed.",
  "Confirm the federal and Connecticut estimated-payment dates and amounts against IRS and CT DRS records.",
  "Confirm every line marked rule not verified or needs your decision, and the constants cited for each computed line.",
  "Signing and filing are yours: you add the signatures, PINs and any e-file authorization form yourself. Nothing on this sheet has been filed.",
];

const ID_TO_FORM: Readonly<Record<string, FormId>> = {
  "Form 1040": "f1040",
  "Schedule 1": "sch1",
  "Schedule 2": "sch2",
  "Schedule 3": "sch3",
  "Schedule A": "scha",
  "Schedule B": "schb",
  "Schedule C": "schc",
  "Schedule D": "schd",
  "Form 8949": "f8949",
  "Schedule SE": "schse",
  "Form 8995": "f8995",
  "Form 8959": "f8959",
  "Form 6251": "f6251",
  "Form 8960": "f8960",
  "Schedule 1-A": "sch1a",
  "Form 8889 (spouse A)": "f8889",
  "Form 8889 (spouse B)": "f8889",
  "Form 8880": "f8880",
  "Form 2210": "f2210",
  "CT-1040": "ct1040",
};

const DOC_TYPE_LABELS: Readonly<Record<string, string>> = {
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  extension: "Extension",
  property_tax: "Property tax bill",
  donation_receipt: "Donation receipt",
  retirement_contribution: "Retirement contributions",
  mortgage_interest: "1098",
  mortgage_statement: "Mortgage statement",
  tax_return: "Tax return",
  bank_statement: "Bank statement",
  insurance_policy: "Insurance policy",
  utility_bill: "Utility bill",
  policy: "Policy",
  statement: "Statement",
  other: "Document",
};

const BASIS_LABELS: Readonly<Record<string, string>> = {
  doc_verified: "verified document",
  doc_unverified: "UNVERIFIED document read",
  answer_owner: "owner answer",
  answer_cpa: "advisor answer (recorded earlier)",
  books: "books",
  derived: "derived",
  override: "override",
};

// ── Small formatters ──────────────────────────────────────────────────────────

/** "$1,234" / "-$1,234". Amounts are whole dollars (the engine rounds every line). */
export function formatSheetMoney(n: number): string {
  const abs = Math.abs(n);
  const body = Number.isInteger(abs) ? abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : String(abs);
  return n < 0 ? `-$${body}` : `$${body}`;
}

const NOT_COMPUTED = "not computed";

function amountText(status: RuleStatus, amount: number | null): string {
  return hasAmount(status) && amount !== null ? formatSheetMoney(amount) : NOT_COMPUTED;
}

function lineText(key: string): string {
  if ((LINE_KEYS as readonly string[]).includes(key)) {
    const m = lineMeta(key as LineKey);
    return `${m.form} ${m.formLine}`;
  }
  return key;
}

function statusOfLine(l: ReturnLine): SheetStatus {
  return l.informational === true && !hasAmount(l.status) ? "informational" : l.status;
}

const CITATION_INDEX: ReadonlyMap<string, SheetCitation> = new Map(
  allConstants().map((c): [string, SheetCitation] => [c.id, { id: c.id, url: c.url, verifiedOn: c.verifiedOn, note: c.note }])
);

function citationOf(id: string): SheetCitation {
  return CITATION_INDEX.get(id) ?? { id, url: null, verifiedOn: null, note: null };
}

// ── Provenance chips ──────────────────────────────────────────────────────────

function chipsFor(line: ReturnLine, docs: ReadonlyMap<string, SheetRawDocument>, defaultUndecided: string | null): SheetChip[] {
  const out: SheetChip[] = [];
  const seen = new Set<string>();
  const push = (chip: SheetChip, id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(chip);
  };
  for (const r of line.refs) {
    switch (r.kind) {
      case "document": {
        const doc = docs.get(r.id);
        const verified = doc?.verified === true;
        const legacy = doc?.legacyFormat === true;
        push(
          {
            kind: verified ? "document_verified" : "document_unverified",
            label: `${r.label}${legacy ? " (older format)" : ""}`,
            href: `/documents/${r.id}/review`,
          },
          `d:${r.id}`
        );
        break;
      }
      case "questionnaire":
      case "planning":
        push({ kind: "owner_answer", label: r.label, href: null }, `${r.kind}:${r.id}`);
        break;
      case "gl":
      case "fixed_asset":
      case "donation":
      case "mileage":
        push({ kind: "books", label: `${r.kind === "gl" ? "GL " : ""}${r.label}`, href: null }, `${r.kind}:${r.id}`);
        break;
      case "paystub":
        push({ kind: "paystub", label: r.label, href: null }, `paystub:${r.id}`);
        break;
      case "decision":
        push({ kind: "decision", label: r.label, href: null }, `decision:${r.id}`);
        break;
      case "constant":
        break; // constants are shown as citations, not chips
      default: {
        const never: never = r.kind;
        void never;
      }
    }
  }
  if (line.ruleId === "derive") {
    push({ kind: "derived", label: "from other lines on this sheet", href: null }, "derived");
  } else if (out.length === 0 && hasAmount(line.status)) {
    push({ kind: "derived", label: `computed by rule ${line.ruleId}`, href: null }, "derived");
  }
  if (defaultUndecided !== null) push({ kind: "decision", label: `default, undecided: ${defaultUndecided}`, href: null }, "default-undecided");
  // Every source the engine cites is kept: an UNVERIFIED document, an owner answer or a book account is never folded away.
  return out;
}

/** Lines carried by an in-force default alternative of an undecided decision: key -> decision label. */
function defaultUndecidedLines(ret: Ty2025Return): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of ret.results) {
    if (r.decision?.status !== "default_undecided") continue;
    for (const alt of r.alternatives ?? []) {
      if (!alt.inForce || !alt.isDefault) continue;
      for (const l of alt.lines) out.set(l.key, r.decision.label);
    }
  }
  return out;
}

const AFFECTS_CAP = 10;

function atDateOf(iso: string): string {
  return formatNewYorkDate(iso);
}

/** "$1,000 computed" / "missing input": what the engine had when the override was applied. */
function wasTextOf(o: AppliedLineOverride): string {
  return o.was.status === "computed" && o.was.amount !== null ? `${formatSheetMoney(o.was.amount)} computed` : SHEET_STATUS_LABELS[o.was.status];
}

function toSheetLineOverride(o: AppliedLineOverride): SheetLineOverride {
  return {
    id: o.id,
    version: o.version,
    authority: o.authority,
    authorityLabel: authorityLabel(o.authority),
    wasText: wasTextOf(o),
    computedAmount: hasAmount(o.was.status) ? o.was.amount : null,
    computedStatusLabel: SHEET_STATUS_LABELS[o.was.status],
    nowAmount: o.nowAmount,
    note: formatOverrideNote(o),
    by: o.setByName,
    at: o.setAt,
    atDate: atDateOf(o.setAt),
    reason: o.reason,
    supplied: o.wasBlocked,
    stale: o.stale !== null,
    staleMessage: o.stale?.message ?? null,
  };
}

function toSheetLine(
  l: ReturnLine,
  docs: ReadonlyMap<string, SheetRawDocument>,
  undecided: ReadonlyMap<string, string>,
  eff: EffectiveLine | undefined,
  present: Partial<Record<LineKey, unknown>>
): SheetLine {
  const baseStatus = statusOfLine(l);
  const defaultUndecided = undecided.get(l.key) ?? null;
  const computed: SheetLineComputed = {
    amount: hasAmount(l.status) ? l.amount : null,
    amountText: amountText(l.status, l.amount),
    statusLabel: SHEET_STATUS_LABELS[baseStatus],
    reason: l.reason,
    blocked: !hasAmount(l.status),
  };
  const ov = eff?.override === undefined ? null : toSheetLineOverride(eff.override);
  const affected = eff === undefined ? [] : affectedLines(l.key, present).map(lineText);
  const dependsOn = (eff?.dependsOnOverridden ?? []).map((k) => ({ key: k, text: lineText(k) }));
  const common = {
    key: l.key,
    form: l.form,
    formLine: l.formLine,
    label: l.label,
    citations: l.citations.map(citationOf),
    defaultUndecided,
    computed,
    affects: affected.slice(0, AFFECTS_CAP),
    affectsMore: Math.max(0, affected.length - AFFECTS_CAP),
    dependsOnOverridden: dependsOn,
    canOverride: eff !== undefined,
  };
  if (ov === null) {
    return {
      ...common,
      status: baseStatus,
      statusLabel: SHEET_STATUS_LABELS[baseStatus],
      amount: computed.amount,
      amountText: computed.amountText,
      reason: l.reason,
      chips: chipsFor(l, docs, defaultUndecided),
      override: null,
    };
  }
  // An overridden line prints the override value; its provenance is the override itself (the computed state is kept in `computed`).
  return {
    ...common,
    status: "overridden",
    statusLabel: `${ov.authority === "cpa" ? "Advisor" : "Owner"} override${ov.stale ? " (STALE)" : ""}`,
    amount: ov.nowAmount,
    amountText: formatSheetMoney(ov.nowAmount),
    reason: null,
    chips: [{ kind: "override", label: `${ov.authority === "cpa" ? "Advisor" : "Owner"} override by ${ov.by} on ${ov.atDate}`, href: null }],
    override: ov,
  };
}

// ── Form groups ───────────────────────────────────────────────────────────────

const REQUIRED_LABEL = (r: boolean | "blocking"): string =>
  r === true ? "needed in the packet" : r === false ? "not needed" : "cannot tell yet (blocking item)";

function requirementFor(form: string, req: Partial<Record<FormId, FormRequirement>>): SheetFormGroup["requirement"] {
  const id = ID_TO_FORM[form];
  if (id === undefined) return null;
  const r = req[id];
  return r === undefined ? null : { required: r.required, label: REQUIRED_LABEL(r.required), reason: r.reason };
}

function buildGroups(lines: readonly SheetLine[], req: Partial<Record<FormId, FormRequirement>>): SheetFormGroup[] {
  const groups = new Map<string, SheetLine[]>();
  for (const l of lines) groups.set(l.form, [...(groups.get(l.form) ?? []), l]);
  return [...groups.entries()].map(([form, ls]) => ({ form, requirement: requirementFor(form, req), lines: ls }));
}

// ── Decisions ─────────────────────────────────────────────────────────────────

function altEffectText(a: RuleAlternative): string {
  const detail = a.effect?.note ?? a.reasons[0] ?? SHEET_STATUS_LABELS[a.status];
  return `${a.label}: ${detail}`;
}

function decisionKeyFor(decisionId: string): (typeof DECISION_KEYS)[number] | null {
  return DECISION_KEYS.find((k) => DECISION_REGISTRY[k].decisionId === decisionId) ?? null;
}

function toSheetDecisionOverride(o: AppliedDecisionOverride): SheetDecisionOverride {
  return {
    id: o.id,
    version: o.version,
    authority: o.authority,
    authorityLabel: authorityLabel(o.authority),
    note: formatOverrideNote(o),
    by: o.setByName,
    at: o.setAt,
    atDate: atDateOf(o.setAt),
    reason: o.reason,
    choice: o.choice,
  };
}

function toSheetDecision(r: RuleResult, applied: ReadonlyMap<string, AppliedDecisionOverride>): SheetDecision | null {
  const d = r.decision;
  if (d === undefined) return null;
  const undecided = d.status === "default_undecided";
  const decisionKey = decisionKeyFor(d.id);
  const appliedOverride = applied.get(d.id);
  const choices: SheetDecisionChoice[] =
    decisionKey === null
      ? []
      : (r.alternatives ?? [])
          .filter((a) => isValidDecisionChoice(decisionKey, a.id))
          .map((a) => ({ id: a.id, label: a.label, effectText: altEffectText(a), isDefault: a.isDefault, inForce: a.inForce }));
  const alts = (r.alternatives ?? []).map((a): SheetAlternative => {
    const marker = undecided
      ? a.isDefault
        ? "default, undecided"
        : null
      : a.inForce
        ? a.isDefault
          ? "chosen (the default)"
          : "chosen"
        : a.isDefault
          ? "default"
          : null;
    return {
      id: a.id,
      label: a.label,
      status: a.status,
      statusLabel: SHEET_STATUS_LABELS[a.status],
      isDefault: a.isDefault,
      inForce: a.inForce,
      marker,
      effectAmountText: a.effect !== null && a.effect.amount !== null ? formatSheetMoney(a.effect.amount.toNumber()) : null,
      effectNote: a.effect?.note ?? null,
      reasons: [...a.reasons],
    };
  });
  const inForce = (r.alternatives ?? []).find((a) => a.inForce);
  const others = (r.alternatives ?? []).filter((a) => !a.inForce);
  const parts: string[] = [];
  if (inForce) parts.push(`In force: ${altEffectText(inForce)}`);
  if (others.length > 0) parts.push(`Alternatives: ${others.map(altEffectText).join(" | ")}`);
  const affected = new Set<string>();
  for (const a of r.alternatives ?? []) if (a.inForce) for (const l of a.lines) affected.add(lineText(l.key));
  return {
    id: d.id,
    label: d.label,
    chosen: d.chosen,
    decisionKey,
    override: appliedOverride === undefined ? null : toSheetDecisionOverride(appliedOverride),
    choices,
    statusText: undecided ? "default, undecided" : "decided",
    undecided,
    decidedBy: d.decidedBy ?? null,
    decidedAt: d.decidedAt ?? null,
    affectedLines: [...affected],
    alternatives: alts,
    wholeReturnEffect: parts.length > 0 ? parts.join(" ") : "The engine gives no effect text for this decision.",
  };
}

/**
 * Which Schedule C answers are still open, read from the engine's own result (schedule-c `inputsMissing`), not guessed.
 * The engine's packet verdicts for Form 8829 / 4562 say "not needed" when the answer is simply missing; the sheet must not
 * print that as an all-clear.
 */
export function scheduleCUnanswered(ret: Pick<Ty2025Return, "results">): { homeOffice: string | null; fixedAssets: string | null } {
  const missing = ret.results.find((r) => r.ruleId === "schedule-c")?.inputsMissing ?? [];
  const find = (needle: string): string | null => missing.find((m) => m.includes(needle)) ?? null;
  return { homeOffice: find("home office eligibility") ?? find("home office square footage"), fixedAssets: find("fixed-asset register") };
}

function qbiUnresolved(ret: Ty2025Return): boolean {
  return ret.formsRequired.f8995?.required === "blocking";
}

function propertyTaxUnresolved(ret: Ty2025Return): boolean {
  return ret.openItems.some((o) => o.id.startsWith("bill-unclassified:") || o.id === "no-second-property-bill" || o.id === "rule:schedule-a");
}

const KNOWN_DECISIONS: readonly { id: string; label: string; notRaised: (ret: Ty2025Return) => string }[] = [
  {
    id: "X1",
    label: "Home office: simplified method or actual expenses (Form 8829)",
    notRaised: (ret) => {
      const open = scheduleCUnanswered(ret).homeOffice;
      return open !== null
        ? `Not decided: the ${open} has not been answered, so it is not known whether a home office decision arises.`
        : `Not raised for this return: ${ret.formsRequired.f8829?.reason ?? "no home office deduction is claimed"}`;
    },
  },
  {
    id: "X2",
    label: "Depreciation elections (Form 4562): regular MACRS, bonus, section 179, de minimis safe harbor",
    notRaised: (ret) => {
      const open = scheduleCUnanswered(ret).fixedAssets;
      return open !== null
        ? `Not decided: the ${open} has not been answered, so it is not known whether depreciation elections arise. The engine does not compute these alternatives yet; you decide.`
        : `The engine does not compute these alternatives yet; you decide. ${ret.formsRequired.f4562?.reason ?? ""}`.trim();
    },
  },
  {
    id: "X3",
    label: "QBI deduction form: Form 8995 or Form 8995-A",
    notRaised: (ret) =>
      qbiUnresolved(ret)
        ? `Not decided: the QBI deduction is not computed yet (inputs are missing), so it is not known whether Form 8995-A is needed. ${ret.formsRequired.f8995?.reason ?? ""}`.trim()
        : `Not raised for this return: Form 8995 is used unless taxable income before the QBI deduction is over the Form 8995 limit. ${ret.formsRequired.f8995?.reason ?? ""}`.trim(),
  },
  {
    id: "X5",
    label: "Arbor Rd 2025 property tax: Schedule A or capitalize",
    notRaised: (ret) =>
      propertyTaxUnresolved(ret)
        ? "Not decided: the property tax bills are not all classified or answered yet, so it is not known whether a non-primary property (Arbor Rd) decision arises."
        : "Not raised for this return: the engine raises it only when a property tax bill is classified as non-primary real estate (Arbor Rd).",
  },
];

// ── Open items, conflicts, homework ───────────────────────────────────────────

const OWNER_ACTION = /^(Archive|Record|Set |Enter|Upload|Open|Re-extract|Re-open|Answer|Confirm|Check|Provide|Read|GL-code|Reconcile|Give the details|Review the transactions)/i;

/**
 * Parts of a "Provide: a; b; c." action that name a figure the ENGINE derives from other lines (taxable income, AGI, Schedule C
 * profit, Schedule SE earnings ...). The owner cannot provide those: they resolve when the root inputs are answered.
 */
const DERIVED_PART =
  /^(taxable income|(federal |CT )?AGI\b|Form 1040 line (2b|3b|5b|7a|11a|11b|22)\b|Schedule 1 line \d|Schedule A line \d|Schedule 1-A line \d|Schedule A taxes|adjusted gross income \(1040 line 11b\)|total deductions \(1040 line 14\)|Form 8959 line 24|Schedule C net profit|Schedule SE net earnings|Schedule 3 line amounts|deductible half of SE tax|standard[- ]versus[- ]itemized|regular tax|interest \/ dividend)/i;

function provideParts(action: string): string[] | null {
  const m = /^Provide:\s*([\s\S]*?)\.?\s*$/.exec(action.trim());
  if (m === null || m[1] === undefined) return null;
  return m[1].split(/;\s*/).map((x) => x.trim()).filter((x) => x !== "");
}

export interface OpenItemRouting {
  who: "owner" | "cpa" | "derived";
  /** For the owner: what they must do (root inputs only). */
  ownerAction: string | null;
}

/**
 * Who has to act on an open item: the owner (a real fact: an answer, a verification, an upload), the owner's own decision ("cpa", a legacy identifier), or nobody
 * ("derived": the item only waits for figures computed from other lines, which resolve when the owner answers the root items).
 */
export function routeOpenItem(item: Pick<OpenItem, "id" | "action">): OpenItemRouting {
  const cpa: OpenItemRouting = { who: "cpa", ownerAction: null };
  const owner = (action: string): OpenItemRouting => ({ who: "owner", ownerAction: action });
  if (item.id.startsWith("decision:") || item.id.startsWith("info:")) return cpa;
  if (item.id === "assumptions-no-ct-sales-tax-or-other" || item.id === "filing-status-not-mfj") return cpa;
  // A household member whose first name does not match exactly one user is an account/name fix the owner makes.
  if (item.id.startsWith("rc-person-unmatched:")) return owner(item.action);
  if (item.id.startsWith("doc-unverified:") || item.id.startsWith("doc-legacy:") || item.id.startsWith("none:")) return owner(item.action);
  if (/^The CPA/i.test(item.action) || /^CPA to/i.test(item.action) || /^Tell the CPA/i.test(item.action)) return cpa;
  if (item.id.startsWith("rule:")) {
    const parts = provideParts(item.action);
    if (parts !== null) {
      const real = parts.filter((p) => !DERIVED_PART.test(p));
      if (real.length === 0) return { who: "derived", ownerAction: null };
      return owner(real.length === parts.length ? item.action : `Provide: ${real.join("; ")}.`);
    }
  }
  return OWNER_ACTION.test(item.action.trim()) ? owner(item.action) : cpa;
}

/** Who acts on an item (see routeOpenItem). */
export function openItemOwner(item: Pick<OpenItem, "id" | "action">): "owner" | "cpa" | "derived" {
  return routeOpenItem(item).who;
}

const sheetRefs = (refs: readonly { kind: string; id: string; label: string }[]): SheetRef[] => refs.filter((r) => r.kind !== "constant").map((r) => ({ kind: r.kind, id: r.id, label: r.label }));

function toSheetOpenItems(items: readonly OpenItem[]): SheetOpenItem[] {
  const seen = new Set<string>();
  const unique: OpenItem[] = [];
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    unique.push(i);
  }
  const rank = (i: OpenItem): number => (i.severity === "blocking" ? 0 : 1);
  return unique
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => rank(a.i) - rank(b.i) || a.idx - b.idx)
    .map(({ i }) => ({
      id: i.id,
      severity: i.severity,
      message: i.message,
      action: i.action,
      who: routeOpenItem(i).who,
      ownerAction: routeOpenItem(i).ownerAction,
      lines: i.lineKeys.map((k) => ({ key: k, text: lineText(k) })),
      refs: sheetRefs(i.refs),
    }));
}

function valueText(v: string | number | null): string {
  if (v === null) return "none";
  return typeof v === "number" ? String(v) : v;
}

function toSheetConflicts(ret: Ty2025Return): SheetConflict[] {
  return ret.conflicts.map((c) => ({
    factKey: c.factKey,
    chosen: c.chosen,
    reason: c.reason,
    candidates: c.candidates.map((x) => ({ basisLabel: BASIS_LABELS[x.basis] ?? x.basis, label: x.label, valueText: valueText(x.value), refs: sheetRefs(x.refs) })),
  }));
}

function toHomework(items: readonly SheetOpenItem[]): SheetHomework[] {
  return items
    .filter((i) => i.who === "owner")
    .map((i) => ({ id: i.id, severity: i.severity, what: i.ownerAction ?? i.action, why: i.message, lines: i.lines.map((l) => l.text) }));
}

// ── Documents ─────────────────────────────────────────────────────────────────

function docTypeText(docType: string): string {
  return DOC_TYPE_LABELS[docType] ?? docType;
}

function buildDocumentIndex(ret: Ty2025Return, documents: readonly SheetRawDocument[]): SheetDocumentRow[] {
  const fed = new Map<string, { key: string; text: string }[]>();
  const labels = new Map<string, string>();
  for (const key of LINE_KEYS) {
    const l = ret.lines[key];
    if (l === undefined) continue;
    for (const r of l.refs) {
      if (r.kind !== "document") continue;
      labels.set(r.id, r.label);
      const list = fed.get(r.id) ?? [];
      if (!list.some((x) => x.key === key)) list.push({ key, text: lineText(key) });
      fed.set(r.id, list);
    }
  }
  const rows: SheetDocumentRow[] = documents.map((d) => ({
    id: d.id,
    docTypeLabel: docTypeText(d.docType),
    taxYear: d.taxYear,
    subject: d.subjectType,
    statusText: d.legacyFormat ? "older format (re-extract)" : d.verified ? "verified" : "unverified AI read",
    verified: d.verified,
    href: `/documents/${d.id}/review`,
    fedLines: fed.get(d.id) ?? [],
  }));
  const known = new Set(documents.map((d) => d.id));
  for (const [id, list] of fed) {
    if (known.has(id)) continue;
    rows.push({
      id,
      docTypeLabel: labels.get(id) ?? "Document",
      taxYear: null,
      subject: null,
      statusText: "not in the loader's document list",
      verified: false,
      href: `/documents/${id}/review`,
      fedLines: list,
    });
  }
  // Unverified first (the CPA's attention), then by type.
  return rows.sort((a, b) => Number(a.verified) - Number(b.verified) || a.docTypeLabel.localeCompare(b.docTypeLabel) || a.id.localeCompare(b.id));
}

// ── Headline ──────────────────────────────────────────────────────────────────

function balanceText(n: number): string {
  return n > 0 ? `owed ${formatSheetMoney(n)}` : n < 0 ? `refund ${formatSheetMoney(-n)}` : "$0 (no balance)";
}

function headlineRow(
  label: string,
  h: { status: RuleStatus; amount: number | null },
  provisional: number | null | undefined,
  complete: boolean,
  balance: boolean,
  rowId: HeadlineRowId,
  eff: EffectiveReturn | undefined
): SheetHeadlineRow {
  const fmt = (n: number): string => (balance ? balanceText(n) : formatSheetMoney(n));
  const state = eff?.headlineRows[rowId];
  return {
    label,
    computedText: hasAmount(h.status) && h.amount !== null ? fmt(h.amount) : NOT_COMPUTED,
    status: h.status,
    statusLabel: SHEET_STATUS_LABELS[h.status],
    provisionalText: complete || provisional === undefined || provisional === null ? null : fmt(provisional),
    overridden: state?.overridden ?? false,
    dependsOnOverride: state?.dependsOnOverride ?? false,
    effectiveText: state?.effectiveAmount === undefined || state?.effectiveAmount === null ? null : fmt(state.effectiveAmount),
  };
}

export const SHEET_TOTALS_NOT_RECOMPUTED =
  "Totals are NOT recomputed for the overrides listed; you figure them out. Lines that depend on an override are flagged.";

function emptyOverridesSummary(): SheetOverridesSummary {
  return {
    lineCount: 0,
    decisionCount: 0,
    ackCount: 0,
    totalsNotRecomputed: false,
    totalsNotice: null,
    lines: [],
    decisions: [],
    acknowledgements: [],
    dependents: [],
    resolvedByOverride: [],
    stale: [],
    engineChanged: [],
    orphans: [],
    anomalies: [],
    invalid: [],
  };
}

/** The overrides panel / CSV notice model: plain strings from the effective view. */
export function buildOverridesSummary(eff: EffectiveReturn): SheetOverridesSummary {
  const lines = eff.applied.lines.map((o) => ({
    key: o.targetKey,
    lineText: `${o.form} ${o.formLine}`,
    label: o.label,
    note: formatOverrideNote(o),
    authorityLabel: authorityLabel(o.authority),
    stale: o.stale !== null,
    supplied: o.wasBlocked,
  }));
  const dependents: SheetOverridesSummary["dependents"] = [];
  for (const key of LINE_KEYS) {
    const e = eff.lines[key];
    if (e?.dependsOnOverridden === undefined) continue;
    dependents.push({ key, lineText: lineText(key), dependsOn: e.dependsOnOverridden.map(lineText) });
  }
  const noteOf = (kind: string, key: string): string => `${kind} ${key}`;
  return {
    lineCount: eff.applied.lines.length,
    decisionCount: eff.applied.decisions.length,
    ackCount: eff.applied.acks.length,
    totalsNotRecomputed: eff.totalsNotRecomputed,
    totalsNotice: eff.totalsNotRecomputed ? SHEET_TOTALS_NOT_RECOMPUTED : null,
    lines,
    decisions: eff.applied.decisions.map((d) => ({ label: d.label, note: formatOverrideNote(d) })),
    acknowledgements: eff.applied.acks.map((a) => ({ ruleId: a.ruleId, note: formatOverrideNote(a), items: a.items.map((i) => i.message) })),
    dependents,
    resolvedByOverride: eff.resolvedByOverride.map((r) => ({
      id: r.item.id,
      message: r.item.message,
      lines: r.item.lineKeys.map((k) => ({ key: k, text: lineText(k) })),
      notes: [...r.notes],
    })),
    stale: eff.stale.map((s) => ({ key: noteOf(s.targetKind, s.targetKey), message: s.info.message })),
    engineChanged: eff.engineChanged.map((s) => ({ key: noteOf(s.targetKind, s.targetKey), message: s.message })),
    orphans: eff.orphans.map((o) => o.message),
    anomalies: eff.anomalies.map((a) => a.message),
    invalid: eff.invalid.map((i) => `A recorded override could not be read (${i.error}) and was NOT applied.`),
  };
}

function buildSummary(ret: Ty2025Return, items: readonly SheetOpenItem[], eff: EffectiveReturn | undefined): SheetModel["summary"] {
  const h = eff?.headline ?? ret.headline;
  const p = h.provisional;
  const f = h.federal;
  const c = h.connecticut;
  const statusCounts: Record<SheetStatus, number> = {
    computed: 0,
    missing_input: 0,
    not_yet_computed: 0,
    needs_cpa_rule_unverified: 0,
    needs_cpa_judgment: 0,
    not_applicable: 0,
    informational: 0,
    overridden: 0,
  };
  for (const key of LINE_KEYS) {
    const l = ret.lines[key];
    if (l === undefined) continue;
    statusCounts[eff?.lines[key]?.override !== undefined ? "overridden" : statusOfLine(l)] += 1;
  }
  const notRecomputed = eff?.totalsNotRecomputed === true;
  const incomplete = `INCOMPLETE: ${h.blockingItemCount} blocking item(s). Figures marked "not computed" are NOT zero.`;
  return {
    complete: h.complete,
    completenessText: h.complete
      ? "No blocking items: every headline figure is computed. Read the caveats below."
      : notRecomputed
        ? `${h.blockingItemCount > 0 ? incomplete : "No blocking items, but the headline figures are the engine's."} ${SHEET_TOTALS_NOT_RECOMPUTED}`
        : incomplete,
    blockingItemCount: h.blockingItemCount,
    advisoryItemCount: items.filter((i) => i.severity === "advisory").length,
    unverifiedDocumentCount: h.unverifiedDocumentCount,
    derivedInputCount: h.derivedInputCount,
    undecidedDecisionCount: h.undecidedDecisionCount,
    caveats: [...h.caveats],
    provisionalNote: !h.complete && p !== null ? p.note : null,
    provisionalAssumedFacts: !h.complete && p !== null ? [...p.assumedFacts] : [],
    federal: [
      headlineRow("Federal AGI (Form 1040 line 11a)", f.agi, p?.agi, h.complete, false, "federal.agi", eff),
      headlineRow("Federal taxable income (line 15)", f.taxableIncome, p?.taxableIncome, h.complete, false, "federal.taxableIncome", eff),
      headlineRow("Federal total tax (line 24)", f.totalTax, p?.totalTax, h.complete, false, "federal.totalTax", eff),
      headlineRow("Federal total payments (line 33)", f.totalPayments, p?.totalPayments, h.complete, false, "federal.totalPayments", eff),
      headlineRow("Federal balance", f.balance, p?.federalBalance, h.complete, true, "federal.balance", eff),
    ],
    connecticut: [
      headlineRow("Connecticut AGI", c.ctAgi, null, h.complete, false, "connecticut.ctAgi", eff),
      headlineRow("Connecticut income tax (line 6)", c.tax, p?.ctTax, h.complete, false, "connecticut.tax", eff),
      headlineRow("Connecticut total payments (lines 18-20)", c.totalPayments, p?.ctPayments, h.complete, false, "connecticut.totalPayments", eff),
      headlineRow("Connecticut balance", c.balance, p?.ctBalance, h.complete, true, "connecticut.balance", eff),
    ],
    statusCounts,
    overrides: eff === undefined ? emptyOverridesSummary() : buildOverridesSummary(eff),
  };
}

function answerText(a: Ty2025Return["attestations"]["digitalAssets"]): string {
  if (a.status === "missing") return "not answered";
  if (a.status === "unsure") return "owner is not sure (decide before filing)";
  return a.value === true ? "Yes" : "No";
}

// ── The builder ───────────────────────────────────────────────────────────────

export function buildSheetModel(input: BuildSheetInput): SheetModel {
  // Engine prose (rule reasons, item messages and actions) still says "the CPA decides" in places: reword it once here.
  return ownerWordingDeep(buildSheetModelRaw(input));
}

function buildSheetModelRaw(input: BuildSheetInput): SheetModel {
  const { ret, now, effective } = input;
  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const undecided = defaultUndecidedLines(ret);
  const all: SheetLine[] = [];
  for (const key of LINE_KEYS) {
    const l = ret.lines[key];
    if (l !== undefined) all.push(toSheetLine(l, docs, undecided, effective?.lines[key], ret.lines));
  }
  const federal = all.filter((l) => l.form !== "CT-1040");
  const ct = all.filter((l) => l.form === "CT-1040");
  // The effective open items (acknowledged / resolved blocking items moved out, override items added) when overrides are applied.
  const openItems = toSheetOpenItems(effective?.openItems ?? ret.openItems);
  const appliedDecisions = new Map((effective?.applied.decisions ?? []).map((d) => [d.decisionId, d]));
  const decisions = ret.results.map((r) => toSheetDecision(r, appliedDecisions)).filter((d): d is SheetDecision => d !== null);
  const raised = new Set(decisions.map((d) => d.id));
  const placeholders: SheetDecisionPlaceholder[] = KNOWN_DECISIONS.filter((k) => !raised.has(k.id)).map((k) => ({
    id: k.id,
    label: k.label,
    note: k.notRaised(ret),
  }));
  const citationIds = new Set<string>(ret.citations);
  for (const l of all) for (const c of l.citations) citationIds.add(c.id);
  return {
    taxYear: 2025,
    engineVersion: ret.engineVersion,
    generatedAt: now.toISOString(),
    generatedAtDisplay: formatNewYorkDateTime(now),
    draftLabel: SHEET_DRAFT_LABEL,
    summary: buildSummary(ret, openItems, effective),
    federal: buildGroups(federal, ret.formsRequired),
    connecticut: buildGroups(ct, ret.formsRequired),
    attestations: [
      { label: ret.attestations.digitalAssets.where, answerText: answerText(ret.attestations.digitalAssets), status: ret.attestations.digitalAssets.status },
      { label: ret.attestations.foreignAccounts.where, answerText: answerText(ret.attestations.foreignAccounts), status: ret.attestations.foreignAccounts.status },
    ],
    decisions,
    decisionPlaceholders: placeholders,
    openItems,
    conflicts: toSheetConflicts(ret),
    homework: toHomework(openItems),
    documents: buildDocumentIndex(ret, input.documents),
    citations: [...citationIds].sort().map(citationOf),
    checklist: [...SHEET_CHECKLIST],
    overrideCount: all.filter((l) => l.override !== null).length,
  };
}

/** "2026-10-03" for an override timestamp (America/New_York). */
export function formatOverrideDate(iso: string): string {
  return formatNewYorkDate(iso);
}

/**
 * The one-line override note used on the page and in the CSV: formatOverrideNote (lib/tax2025/overrides.ts), the same
 * string the PDF field note and the cover print, plus the STALE marker when the computed value moved after it was set.
 */
export function overrideNote(o: SheetLineOverride): string {
  return `${o.note}${o.stale ? " (STALE: re-confirm or clear)" : ""}`;
}
