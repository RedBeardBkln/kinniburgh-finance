// Pure suggestion engine for "answer this questionnaire question from a document that is
// already in the system". NO db, NO server imports, NO clock: the questionnaire runner
// (client) imports it to recompute a value when the owner picks a different document, and
// the accept action (server) imports it to recompute the SAME value from the chosen
// document ids (a client-supplied value is never trusted).
//
// Honesty rules:
//   * A suggestion is NOT an answer. Nothing here writes anything; the engine only reads the
//     answers the owner already saved (to label a node "suggested" / "accepted" / "differs").
//   * Positive evidence only: no "yes" or "some" without a document that says so, and a
//     "no" / "none" is only ever suggested from a fully read, current-format document and is
//     always WEAK (never bulk-accepted): a SEP / SIMPLE / solo plan, a 457(b) or an after-tax
//     amount does not appear on a W-2.
//   * STRONG = every document that contributes is owner-verified (extractionConfirmedAt), in the
//     current extraction format, belongs to the right person, nothing that could change the
//     answer is unassigned or unread, and the value is positive evidence. Bulk accept takes
//     strong suggestions only.
//   * The inputs are the facts the TY2025 engine already resolved (lib/tax2025/resolve-facts.ts),
//     so the prefill and the engine cannot disagree about which W-2s count, which are
//     duplicates or what "verified" means. Documents were already mapped through
//     resolveTaxDocForCompute by the loader; this file never reads raw extraction data except
//     the few named fields of the 2024 return documents it is handed.
//   * Output hygiene: suggestions carry only ids, option ids / cents, stable field codes,
//     employer / document display names, verified flags and short plain-text details. Never an
//     EIN, SSN-shaped text, address, account number, taxpayer name or extractionData.

import { formatCentsDisplay } from "@/lib/tax-extraction-schema";
import { RC_PERSONS, RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import {
  describeAnswerSource,
  validateAnswerValue,
  type AnswerSource,
  type AnswerValue,
  type EffectiveAnswers,
} from "@/lib/tax-questionnaire";
import { RC_CONTEXT, uniquePersonMatch } from "@/lib/tax2025/answers";
import type { W2Fact } from "@/lib/tax2025/facts";
import type { RawDocument } from "@/lib/tax2025/resolve-facts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrefillRuleId = "w2_plan" | "w2_deferrals" | "w2_withheld" | "return_filing" | "return_no_tax" | "planning_solar";
export type PrefillStrength = "strong" | "weak";
export type StalenessKind = "current" | "value_changed" | "new_candidate" | "doc_gone";

/** Why a document is listed but not counted. */
export type PrefillExclusion = "unassigned" | "unreadable" | "not_extracted" | "duplicate" | "field_unread";

export interface PrefillCandidate {
  docId: string;
  /** Employer / document display name only (sanitized; never an EIN or SSN-shaped text). */
  label: string;
  verified: boolean;
  legacyFormat: boolean;
  selectable: boolean;
  exclusion: PrefillExclusion | null;
  /** Plain-text reason shown next to a non-selectable document. */
  reason: string | null;
  /** Rule-specific read: W-2 deferral cents (w2_deferrals / w2_plan), or the 2024 return's total tax cents (return_no_tax). */
  cents: number | null;
  /** W-2 box 2 federal withholding cents (w2_withheld); null = not read. */
  withheldCents: number | null;
  /** w2_plan: box 13 "Retirement plan" read (null = not read). */
  flag: boolean | null;
  /** return_filing: the filing status code read. */
  code: string | null;
  /** w2_deferrals: the deferral codes present (D, E, AA ...). */
  codes: string[];
  /** Short plain-text contribution, e.g. "box 12 D $12,000.00". */
  detail: string;
}

export interface PrefillAnswer {
  nodeId: string;
  value: AnswerValue;
}

/** What a selection of documents says (the value, how sure we are, and the text to show). */
export interface PrefillEvaluation {
  answers: PrefillAnswer[];
  strength: PrefillStrength;
  basis: AnswerSource["basis"];
  /** A primitive that fully determines `answers` (staleness is detected by comparing it later). */
  docValue: string | number;
  chip: string;
  caveats: string[];
}

export interface PrefillSuggestion extends PrefillEvaluation {
  /** `${questionnaireId}:${ruleId}[:person]` */
  key: string;
  questionnaireId: string;
  ruleId: PrefillRuleId;
  person: "eric" | "eva" | null;
  personName: string | null;
  field: string;
  kind: AnswerSource["kind"];
  /** Node ids this suggestion fills, primary first (a dependent amount node is only in `answers` when it is shown). */
  nodeIds: string[];
  /** True when several documents could be the source and none is chosen yet (answers is then empty). */
  needsPick: boolean;
  /** The default selection (empty when needsPick or for a planning-based suggestion). */
  docIds: string[];
  candidates: PrefillCandidate[];
}

export interface PrefillInput {
  year: number;
  people: readonly { userId: string; name: string }[];
  /** `facts.income.w2s` of the engine's resolved facts (duplicates already collapsed). */
  w2s: readonly W2Fact[];
  /** `facts.income.w2Unusable`. */
  w2Unusable: readonly { docId: string; reason: string }[];
  /** All Personal documents as the loader mapped them (effective extraction). */
  documents: readonly RawDocument[];
  /** The Planning answer about the solar credit (`raw.planning.solarCredit`). */
  solarCredit: string | null;
}

// ── Rule registry ─────────────────────────────────────────────────────────────

/** W-2 box 12 deferral codes. Pinned to the engine's own set by a parity test (tax-prefill.test.ts). W and DD are NOT deferrals. */
export const DEFERRAL_CODES: ReadonlySet<string> = new Set(["D", "E", "F", "G", "H", "S", "AA", "BB", "EE"]);

export const FORM_2210_ID = "form-2210";

interface RuleSpec {
  questionnaireId: string;
  field: string;
  perPerson: boolean;
  nodeIds: (personKey: string | null) => string[];
}

export const PREFILL_RULES: Readonly<Record<PrefillRuleId, RuleSpec>> = {
  w2_plan: { questionnaireId: RETURN_COMPLETENESS_ID, field: "w2.box13.plan", perPerson: true, nodeIds: (k) => [`plan_${k}`] },
  w2_deferrals: { questionnaireId: RETURN_COMPLETENESS_ID, field: "w2.box12.deferrals", perPerson: true, nodeIds: (k) => [`def_${k}`, `defamt_${k}`] },
  return_filing: { questionnaireId: RETURN_COMPLETENESS_ID, field: "return2024.filingStatus", perPerson: false, nodeIds: () => ["pyjoint"] },
  planning_solar: { questionnaireId: RETURN_COMPLETENESS_ID, field: "planning.solar_credit", perPerson: false, nodeIds: () => ["g_solar_credit"] },
  w2_withheld: { questionnaireId: FORM_2210_ID, field: "w2.box2.withheld", perPerson: false, nodeIds: () => ["ut1"] },
  return_no_tax: { questionnaireId: FORM_2210_ID, field: "return2024.totalTax", perPerson: false, nodeIds: () => ["ut7"] },
};

const RULE_IDS = Object.keys(PREFILL_RULES) as PrefillRuleId[];

/** Every (questionnaire, node id, option value) a rule can write, for the id-existence test. */
export function prefillNodeIdsFor(questionnaireId: string): string[] {
  const ids: string[] = [];
  for (const ruleId of RULE_IDS) {
    const spec = PREFILL_RULES[ruleId];
    if (spec.questionnaireId !== questionnaireId) continue;
    if (spec.perPerson) for (const P of RC_PERSONS) ids.push(...spec.nodeIds(P.key));
    else ids.push(...spec.nodeIds(null));
  }
  return ids;
}

/** The suggestion/rule that owns a node id (primary or dependent), or null. */
export function ruleForNode(questionnaireId: string, nodeId: string): { ruleId: PrefillRuleId; person: "eric" | "eva" | null; primary: boolean } | null {
  for (const ruleId of RULE_IDS) {
    const spec = PREFILL_RULES[ruleId];
    if (spec.questionnaireId !== questionnaireId) continue;
    if (spec.perPerson) {
      for (const P of RC_PERSONS) {
        const ids = spec.nodeIds(P.key);
        if (ids.includes(nodeId)) return { ruleId, person: P.key, primary: ids[0] === nodeId };
      }
    } else {
      const ids = spec.nodeIds(null);
      if (ids.includes(nodeId)) return { ruleId, person: null, primary: ids[0] === nodeId };
    }
  }
  return null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

/** Removes anything that looks like an EIN / SSN / long digit run and caps the length; labels are display names only. */
export function safeLabel(raw: string | null | undefined, fallback: string): string {
  const text = (raw ?? "").replace(/\b\d{2}-\d{7}\b/g, "").replace(/\b\d{3}-\d{2}-\d{4}\b/g, "").replace(/\d{6,}/g, "").replace(/\s+/g, " ").trim();
  if (text === "") return fallback;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function dataOf(doc: RawDocument): Rec {
  const d = (doc.extractionData as { data?: unknown } | null)?.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Rec) : {};
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function verifiedText(cands: readonly PrefillCandidate[]): string {
  const n = cands.filter((c) => c.verified).length;
  if (n === cands.length) return "verified";
  if (n === 0) return cands.length === 1 ? "unverified AI read" : "unverified AI reads";
  return `${n} of ${cands.length} verified`;
}

function namesText(cands: readonly PrefillCandidate[]): string {
  const names = Array.from(new Set(cands.map((c) => c.label)));
  const shown = names.slice(0, 4).join(", ");
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

function w2Count(n: number): string {
  return `${n} W-2${n === 1 ? "" : "s"}`;
}

function sumCents(cands: readonly PrefillCandidate[]): number {
  return cands.reduce((s, c) => s + (c.cents ?? 0), 0);
}

function sameValue(a: AnswerValue, b: AnswerValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sb = [...b].sort();
    return [...a].sort().every((x, i) => x === sb[i]);
  }
  return a === b;
}

const FILING_STATUS_TEXT: Readonly<Record<string, string>> = {
  mfj: "married filing jointly",
  single: "single",
  mfs: "married filing separately",
  hoh: "head of household",
  qw: "qualifying surviving spouse",
};

/** Validates every answer against the questionnaire definition (the same validator the save action uses). */
function answersValid(questionnaireId: string, answers: readonly PrefillAnswer[]): boolean {
  const def = questionnaireById(questionnaireId);
  if (!def) return false;
  for (const a of answers) {
    const node = def.nodes.find((n) => n.id === a.nodeId);
    if (!node) return false;
    if (!validateAnswerValue(node, a.value, RC_CONTEXT).ok) return false;
  }
  return true;
}

// ── Evaluating a selection of documents ──────────────────────────────────────

interface EvalContext {
  ruleId: PrefillRuleId;
  questionnaireId: string;
  person: "eric" | "eva" | null;
  personName: string | null;
  /** Every candidate (selectable or not): the non-selectable ones that could change the answer downgrade a suggestion. */
  allCandidates: readonly PrefillCandidate[];
}

const BASE_DEFERRAL_CAVEAT =
  "A W-2 only shows plans run through payroll: a 457(b) or after-tax amount paid some other way may be missing.";

function downgradeNotes(all: readonly PrefillCandidate[]): string[] {
  const notes: string[] = [];
  const n = (k: PrefillExclusion) => all.filter((c) => !c.selectable && c.exclusion === k).length;
  if (n("unassigned") > 0) notes.push(`${n("unassigned")} W-2 not assigned to a person is not counted: assign it on the document, then check this answer again.`);
  if (n("unreadable") > 0) notes.push(`${n("unreadable")} W-2 could not be read and is not counted.`);
  if (n("not_extracted") > 0) notes.push(`${n("not_extracted")} W-2 has not finished being read and is not counted.`);
  return notes;
}

function isStrongInputs(selected: readonly PrefillCandidate[], all: readonly PrefillCandidate[]): boolean {
  if (selected.length === 0) return false;
  if (!selected.every((c) => c.verified && !c.legacyFormat)) return false;
  return !all.some((c) => !c.selectable && (c.exclusion === "unassigned" || c.exclusion === "unreadable" || c.exclusion === "not_extracted"));
}

function selectionCaveats(selected: readonly PrefillCandidate[], all: readonly PrefillCandidate[]): string[] {
  const out: string[] = [];
  if (selected.some((c) => !c.verified)) out.push("At least one document is an unverified AI read: open it and compare with the paper form.");
  if (selected.some((c) => c.legacyFormat)) out.push("At least one document was read in an older format: newer boxes may not have been read.");
  out.push(...downgradeNotes(all));
  return out;
}

function basisOf(selected: readonly PrefillCandidate[]): AnswerSource["basis"] {
  return selected.every((c) => c.verified) ? "doc_verified" : "doc_unverified";
}

function evalDeferrals(ctx: EvalContext, selected: readonly PrefillCandidate[]): PrefillEvaluation | null {
  const k = ctx.person;
  if (k === null || selected.length === 0) return null;
  const total = sumCents(selected);
  const caveats = [BASE_DEFERRAL_CAVEAT, ...selectionCaveats(selected, ctx.allCandidates)];
  const docs = `${w2Count(selected.length)} (${namesText(selected)})`;
  if (total > 0) {
    const codes = Array.from(new Set(selected.flatMap((c) => c.codes))).sort();
    return {
      answers: [
        { nodeId: `def_${k}`, value: "some" },
        { nodeId: `defamt_${k}`, value: total },
      ],
      strength: isStrongInputs(selected, ctx.allCandidates) ? "strong" : "weak",
      basis: basisOf(selected),
      docValue: total,
      chip: `From ${docs}, box 12 code${codes.length === 1 ? "" : "s"} ${codes.join(" + ")}, ${verifiedText(selected)}: ${formatCentsDisplay(total)}`,
      caveats,
    };
  }
  // "None" only from fully read, current-format documents (a legacy W-2 may simply not have had box 12 read).
  if (selected.some((c) => c.legacyFormat)) return null;
  return {
    answers: [{ nodeId: `def_${k}`, value: "none" }],
    strength: "weak",
    basis: basisOf(selected),
    docValue: 0,
    chip: `From ${docs}, no box 12 deferral codes, ${verifiedText(selected)}`,
    caveats: ["Not seeing a deferral on the W-2 is not proof there was none.", ...caveats],
  };
}

function evalPlan(ctx: EvalContext, selected: readonly PrefillCandidate[]): PrefillEvaluation | null {
  const k = ctx.person;
  if (k === null || selected.length === 0) return null;
  const checked = selected.filter((c) => c.flag === true);
  const deferral = selected.filter((c) => c.flag !== true && (c.cents ?? 0) > 0);
  const docs = `${w2Count(selected.length)} (${namesText(selected)})`;
  if (checked.length > 0 || deferral.length > 0) {
    const evidence =
      checked.length > 0
        ? `box 13 "Retirement plan" is checked on ${namesText(checked)}`
        : `box 12 shows a deferral on ${namesText(deferral)}`;
    return {
      answers: [{ nodeId: `plan_${k}`, value: "yes" }],
      strength: isStrongInputs(selected, ctx.allCandidates) ? "strong" : "weak",
      basis: basisOf(selected),
      docValue: "yes",
      chip: `From ${docs}: ${evidence}, ${verifiedText(selected)}`,
      caveats: selectionCaveats(selected, ctx.allCandidates),
    };
  }
  // "No": every selected W-2 is current-format and box 13 was read as unchecked.
  if (selected.every((c) => !c.legacyFormat && c.flag === false)) {
    return {
      answers: [{ nodeId: `plan_${k}`, value: "no" }],
      strength: "weak",
      basis: basisOf(selected),
      docValue: "no",
      chip: `From ${docs}, box 13 unchecked, ${verifiedText(selected)}`,
      caveats: [
        "W-2s do not show a SEP, SIMPLE or solo plan through EK Consulting: answer Yes if you have one.",
        ...selectionCaveats(selected, ctx.allCandidates),
      ],
    };
  }
  return null;
}

function evalWithheld(ctx: EvalContext, selected: readonly PrefillCandidate[]): PrefillEvaluation | null {
  if (selected.length === 0) return null;
  const docs = `${w2Count(selected.length)} (${namesText(selected)})`;
  const total = selected.reduce((sum, c) => sum + (c.withheldCents ?? 0), 0);
  const caveats = selectionCaveats(selected, ctx.allCandidates);
  if (total > 0) {
    return {
      answers: [{ nodeId: "ut1", value: "yes" }],
      strength: selected.every((c) => c.verified && !c.legacyFormat) ? "strong" : "weak",
      basis: basisOf(selected),
      docValue: total,
      chip: `From ${docs}, box 2 federal withholding, ${verifiedText(selected)}: ${formatCentsDisplay(total)}`,
      caveats,
    };
  }
  if (selected.some((c) => c.legacyFormat || c.withheldCents === null)) return null;
  return {
    answers: [{ nodeId: "ut1", value: "no" }],
    strength: "weak",
    basis: basisOf(selected),
    docValue: 0,
    chip: `From ${docs}, box 2 is $0.00, ${verifiedText(selected)}`,
    caveats,
  };
}

function evalFiling(selected: readonly PrefillCandidate[]): PrefillEvaluation | null {
  if (selected.length !== 1) return null;
  const c = selected[0]!;
  if (c.code === null || !(c.code in FILING_STATUS_TEXT)) return null;
  return {
    answers: [{ nodeId: "pyjoint", value: c.code === "mfj" ? "yes" : "no" }],
    strength: c.verified && !c.legacyFormat ? "strong" : "weak",
    basis: basisOf(selected),
    docValue: c.code,
    chip: `From the 2024 federal return, filing status: ${FILING_STATUS_TEXT[c.code]} (${verifiedText(selected)})`,
    caveats: c.verified ? [] : ["Unverified AI read: open the return and compare the filing status."],
  };
}

function evalNoTax(selected: readonly PrefillCandidate[]): PrefillEvaluation | null {
  if (selected.length !== 1) return null;
  const c = selected[0]!;
  if (c.cents === null) return null;
  return {
    answers: [{ nodeId: "ut7", value: c.cents === 0 ? "yes" : "no" }],
    strength: c.verified && !c.legacyFormat ? "strong" : "weak",
    basis: basisOf(selected),
    docValue: c.cents,
    chip: `From the 2024 federal return, total tax (Form 1040 line 24): ${formatCentsDisplay(c.cents)} (${verifiedText(selected)})`,
    caveats: c.verified ? [] : ["Unverified AI read: open the return and compare the total tax."],
  };
}

function evaluate(ctx: EvalContext, selected: readonly PrefillCandidate[]): PrefillEvaluation | null {
  let ev: PrefillEvaluation | null;
  switch (ctx.ruleId) {
    case "w2_deferrals":
      ev = evalDeferrals(ctx, selected);
      break;
    case "w2_plan":
      ev = evalPlan(ctx, selected);
      break;
    case "w2_withheld":
      ev = evalWithheld(ctx, selected);
      break;
    case "return_filing":
      ev = evalFiling(selected);
      break;
    case "return_no_tax":
      ev = evalNoTax(selected);
      break;
    case "planning_solar":
      ev = null;
      break;
  }
  if (ev === null) return null;
  return answersValid(ctx.questionnaireId, ev.answers) ? ev : null;
}

/**
 * Recomputes what a SUBSET of the suggestion's documents says (the picker, and the accept action
 * with the document ids the owner chose). Returns null when any id is not a selectable candidate,
 * the selection is empty, or the documents cannot support an answer. A planning-based suggestion
 * returns its own evaluation.
 */
export function combineContributions(suggestion: PrefillSuggestion, selectedDocIds: readonly string[]): PrefillEvaluation | null {
  if (suggestion.kind === "planning") {
    if (selectedDocIds.length > 0 || suggestion.answers.length === 0) return null;
    const { answers, strength, basis, docValue, chip, caveats } = suggestion;
    return { answers, strength, basis, docValue, chip, caveats };
  }
  const ids = Array.from(new Set(selectedDocIds));
  if (ids.length === 0) return null;
  const selected: PrefillCandidate[] = [];
  for (const id of ids) {
    const c = suggestion.candidates.find((x) => x.docId === id);
    if (!c || !c.selectable) return null;
    selected.push(c);
  }
  return evaluate(
    {
      ruleId: suggestion.ruleId,
      questionnaireId: suggestion.questionnaireId,
      person: suggestion.person,
      personName: suggestion.personName,
      allCandidates: suggestion.candidates,
    },
    selected
  );
}

/** The `src` to store for an accepted evaluation. */
export function buildAnswerSource(suggestion: PrefillSuggestion, evaluation: PrefillEvaluation, docIds: readonly string[]): AnswerSource {
  return {
    kind: suggestion.kind,
    field: suggestion.field,
    docIds: suggestion.kind === "planning" ? [] : Array.from(new Set(docIds)),
    basis: suggestion.kind === "planning" ? "planning" : evaluation.basis,
    docValue: evaluation.docValue,
  };
}

// ── Building the suggestions ─────────────────────────────────────────────────

const MAX_EXCLUDED_LISTED = 12;

function belongsTo(doc: RawDocument, userId: string): "mine" | "unassigned" | "other" {
  if (doc.subjectType === "person" && doc.subjectUserId) return doc.subjectUserId === userId ? "mine" : "other";
  return "unassigned";
}

function w2Candidate(w: W2Fact): PrefillCandidate {
  const deferralLines = w.box12.filter((e) => DEFERRAL_CODES.has(e.code) && e.amountCents !== 0);
  const cents = w.box12.filter((e) => DEFERRAL_CODES.has(e.code)).reduce((s, e) => s + e.amountCents, 0);
  const codes = Array.from(new Set(deferralLines.map((e) => e.code))).sort();
  const detailParts: string[] = [];
  for (const code of codes) {
    const amount = deferralLines.filter((e) => e.code === code).reduce((s, e) => s + e.amountCents, 0);
    detailParts.push(`box 12 ${code} ${formatCentsDisplay(amount)}`);
  }
  if (detailParts.length === 0) detailParts.push("no box 12 deferral code");
  detailParts.push(w.retirementPlan === true ? "box 13 checked" : w.retirementPlan === false ? "box 13 unchecked" : "box 13 not read");
  return {
    docId: w.docId,
    label: safeLabel(w.employer, "W-2"),
    verified: w.basis === "doc_verified",
    legacyFormat: w.legacyFormat,
    selectable: true,
    exclusion: null,
    reason: null,
    cents,
    withheldCents: w.fedWithheldCents,
    flag: w.retirementPlan,
    code: null,
    codes,
    detail: detailParts.join(", "),
  };
}

function excluded(doc: RawDocument, exclusion: PrefillExclusion, reason: string): PrefillCandidate {
  return {
    docId: doc.id,
    label: safeLabel(doc.documentName, "W-2"),
    verified: doc.verified,
    legacyFormat: doc.legacyFormat,
    selectable: false,
    exclusion,
    reason,
    cents: null,
    withheldCents: null,
    flag: null,
    code: null,
    codes: [],
    detail: "",
  };
}

/** W-2 candidates for a person (or, with userId null, for the whole household): counted ones plus listed-but-not-counted ones. */
function w2Candidates(input: PrefillInput, userId: string | null): PrefillCandidate[] {
  const out: PrefillCandidate[] = [];
  const w2ById = new Map(input.w2s.map((w) => [w.docId, w]));
  const unusable = new Set(input.w2Unusable.map((u) => u.docId));
  for (const doc of input.documents) {
    if (doc.docType !== "w2" || doc.taxYear !== input.year) continue;
    const who = userId === null ? "mine" : belongsTo(doc, userId);
    if (who === "other") continue;
    const w = w2ById.get(doc.id);
    if (w) {
      if (userId !== null && w.personUserId !== userId) {
        // Assigned to nobody (the engine's blocking `w2-no-person` item): listed, never counted.
        if (w.personUserId === null) out.push({ ...w2Candidate(w), selectable: false, exclusion: "unassigned", reason: "Not assigned to a person yet" });
        continue;
      }
      out.push(w2Candidate(w));
    } else if (unusable.has(doc.id)) {
      out.push(excluded(doc, "unreadable", "Could not be read (no wages found); fix or re-read it on the document page"));
    } else if (doc.extractionStatus === "complete" || doc.reextractIncomplete === true) {
      out.push(excluded(doc, "duplicate", "An exact duplicate of another W-2: counted once"));
    } else {
      out.push(excluded(doc, "not_extracted", "Has not finished being read"));
    }
  }
  const counted = out.filter((c) => c.selectable);
  const rest = out.filter((c) => !c.selectable).slice(0, MAX_EXCLUDED_LISTED);
  return [...counted, ...rest];
}

function priorReturnCandidates(input: PrefillInput): PrefillCandidate[] {
  const out: PrefillCandidate[] = [];
  for (const doc of input.documents) {
    if (doc.docType !== "tax_return" || doc.taxYear !== input.year - 1 || doc.extractionStatus !== "complete") continue;
    const data = dataOf(doc);
    if (strOrNull(data.formType) !== "1040") continue;
    const code = strOrNull(data.filingStatus);
    const tax = intOrNull(data.totalTaxCents);
    out.push({
      docId: doc.id,
      label: safeLabel(doc.documentName, `${input.year - 1} federal return`),
      verified: doc.verified,
      legacyFormat: doc.legacyFormat,
      selectable: true,
      exclusion: null,
      reason: null,
      cents: tax,
      withheldCents: null,
      flag: null,
      code,
      codes: [],
      detail: [code !== null && code in FILING_STATUS_TEXT ? `filing status ${FILING_STATUS_TEXT[code]}` : "filing status not read", tax !== null ? `total tax ${formatCentsDisplay(tax)}` : "total tax not read"].join(", "),
    });
  }
  return out.slice(0, 12);
}

function withNeed(cands: readonly PrefillCandidate[], need: (c: PrefillCandidate) => boolean, why: string): PrefillCandidate[] {
  return cands.map((c) => (c.selectable && !need(c) ? { ...c, selectable: false, exclusion: "field_unread" as const, reason: why } : c));
}

function finish(
  ctx: Omit<EvalContext, "allCandidates">,
  spec: RuleSpec,
  candidates: PrefillCandidate[],
  mode: "all" | "pick_one"
): PrefillSuggestion | null {
  const selectable = candidates.filter((c) => c.selectable);
  if (selectable.length === 0) return null;
  const full: EvalContext = { ...ctx, allCandidates: candidates };
  const key = `${ctx.questionnaireId}:${ctx.ruleId}${ctx.person ? `:${ctx.person}` : ""}`;
  const nodeIds = spec.nodeIds(ctx.person);
  const base = { key, questionnaireId: ctx.questionnaireId, ruleId: ctx.ruleId, person: ctx.person, personName: ctx.personName, field: spec.field, kind: "document" as const, nodeIds, candidates };
  if (mode === "pick_one" && selectable.length > 1) {
    return {
      ...base,
      answers: [],
      strength: "weak",
      basis: "doc_unverified",
      docValue: 0,
      chip: `${selectable.length} possible ${selectable.length === 1 ? "document" : "documents"}: pick the one that is your filed return`,
      caveats: [],
      needsPick: true,
      docIds: [],
    };
  }
  const selected = selectable;
  const ev = evaluate(full, selected);
  if (!ev) return null;
  return { ...base, ...ev, needsPick: false, docIds: selected.map((c) => c.docId) };
}

/**
 * All suggestions for the TY2025 questionnaires (Return completeness and Form 2210).
 * Conservative: no suggestion without a unique household person match, none from the absence
 * of a document, none for another tax year.
 */
export function computePrefillSuggestions(input: PrefillInput): PrefillSuggestion[] {
  if (input.year !== 2025) return [];
  const out: PrefillSuggestion[] = [];

  // Per-person W-2 rules (Return completeness).
  for (const P of RC_PERSONS) {
    const user = uniquePersonMatch(input.people, P.key);
    if (!user) continue;
    const cands = w2Candidates(input, user.userId);
    for (const ruleId of ["w2_plan", "w2_deferrals"] as const) {
      const spec = PREFILL_RULES[ruleId];
      const s = finish({ ruleId, questionnaireId: spec.questionnaireId, person: P.key, personName: P.name }, spec, cands, "all");
      if (s) out.push(s);
    }
  }

  // Household W-2 rule (Form 2210): federal withholding on any usable W-2.
  {
    const spec = PREFILL_RULES.w2_withheld;
    const s = finish({ ruleId: "w2_withheld", questionnaireId: spec.questionnaireId, person: null, personName: null }, spec, w2Candidates(input, null), "all");
    if (s) out.push(s);
  }

  // The 2024 federal return (exactly one -> default; several -> the owner picks).
  const returns = priorReturnCandidates(input);
  {
    const spec = PREFILL_RULES.return_filing;
    const cands = withNeed(returns, (c) => c.code !== null && c.code in FILING_STATUS_TEXT, "Filing status not read");
    const s = finish({ ruleId: "return_filing", questionnaireId: spec.questionnaireId, person: null, personName: null }, spec, cands, "pick_one");
    if (s) out.push(s);
  }
  {
    const spec = PREFILL_RULES.return_no_tax;
    const cands = withNeed(returns, (c) => c.cents !== null, "Total tax not read");
    const s = finish({ ruleId: "return_no_tax", questionnaireId: spec.questionnaireId, person: null, personName: null }, spec, cands, "pick_one");
    if (s) out.push(s);
  }

  // The Planning answer about the solar credit (weak, never bulk).
  if (input.solarCredit === "claimed_already") {
    const spec = PREFILL_RULES.planning_solar;
    out.push({
      key: `${spec.questionnaireId}:planning_solar`,
      questionnaireId: spec.questionnaireId,
      ruleId: "planning_solar",
      person: null,
      personName: null,
      field: spec.field,
      kind: "planning",
      nodeIds: spec.nodeIds(null),
      answers: [{ nodeId: "g_solar_credit", value: "none" }],
      strength: "weak",
      basis: "planning",
      docValue: "claimed_already",
      chip: "From your Planning answer: the solar credit was already claimed on a prior return",
      caveats: ["A credit carried forward from that return would still be claimed on the 2025 return: check whether there is one."],
      needsPick: false,
      docIds: [],
      candidates: [],
    });
  }

  return out.filter((s) => answersValid(s.questionnaireId, s.answers));
}

// ── Staleness and node state ─────────────────────────────────────────────────

/**
 * Compares a stored `src` with what the documents say NOW. Priority: an accepted document is no
 * longer usable (doc_gone) > the value it gives changed (value_changed) > a new candidate document
 * appeared that the accepted answer does not include (new_candidate) > current. Re-verifying a
 * document without changing its value is `current`; the chip's verified label is always live.
 */
export function classifyStaleness(src: AnswerSource, suggestion: PrefillSuggestion | null): StalenessKind {
  if (suggestion === null || suggestion.kind !== src.kind || suggestion.field !== src.field) return "doc_gone";
  if (src.kind === "planning") return suggestion.docValue === src.docValue ? "current" : "value_changed";
  const selectableIds = suggestion.candidates.filter((c) => c.selectable).map((c) => c.docId);
  if (src.docIds.some((id) => !selectableIds.includes(id))) return "doc_gone";
  const ev = combineContributions(suggestion, src.docIds);
  if (!ev) return "doc_gone";
  if (ev.docValue !== src.docValue) return "value_changed";
  if (selectableIds.some((id) => !src.docIds.includes(id))) return "new_candidate";
  return "current";
}

export type PrefillState = "suggested" | "accepted" | "agrees" | "differs" | "stale";

export interface PrefillNodeState {
  /** The node the suggestion block is rendered under (the rule's primary node). */
  nodeId: string;
  suggestionKey: string | null;
  state: PrefillState;
  staleReason: StalenessKind | null;
  /** True when "Accept N suggestions" would apply it: strong, not yet answered, and a value is ready. */
  bulk: boolean;
  /** The document-based evaluation of what was accepted (for "accepted" / "stale"), so the UI can show old vs new. */
  acceptedDocValue: AnswerSource["docValue"] | null;
}

/**
 * The per-node state for one questionnaire, computed LIVE from the saved answers and the current
 * suggestions (so an owner override or a corrected document is never stored as a flag that can go stale).
 *   suggested - nothing answered yet (or only part of it): a suggestion is waiting
 *   accepted  - saved from this source, which still says the same thing
 *   agrees    - the owner typed the same answer the document gives
 *   differs   - the owner answered differently (or "Not sure"); the document says something else
 *   stale     - accepted from a source that has since changed / gone / grown a new candidate
 */
export function computePrefillStates(
  questionnaireId: string,
  suggestions: readonly PrefillSuggestion[],
  effective: EffectiveAnswers
): Record<string, PrefillNodeState> {
  const out: Record<string, PrefillNodeState> = {};
  const mine = suggestions.filter((s) => s.questionnaireId === questionnaireId);
  const covered = new Set<string>();

  for (const s of mine) {
    const primary = s.nodeIds[0];
    if (!primary) continue;
    covered.add(primary);
    const a = effective[primary];
    const mk = (state: PrefillState, staleReason: StalenessKind | null = null, acceptedDocValue: AnswerSource["docValue"] | null = null): void => {
      out[primary] = {
        nodeId: primary,
        suggestionKey: s.key,
        state,
        staleReason,
        bulk: state === "suggested" && s.strength === "strong" && !s.needsPick && s.answers.length > 0 && s.kind === "document",
        acceptedDocValue,
      };
    };
    if (!a) {
      mk("suggested");
      continue;
    }
    if (a.src && a.src.kind === s.kind) {
      const staleness = classifyStaleness(a.src, s);
      if (staleness !== "current") {
        mk("stale", staleness, a.src.docValue);
        continue;
      }
      const ev = s.kind === "planning" ? combineContributions(s, []) : combineContributions(s, a.src.docIds);
      const wanted = ev ? ev.answers : s.answers;
      const matched = matchState(wanted, effective);
      mk(matched === "agrees" ? "accepted" : matched, null, a.src.docValue);
      continue;
    }
    if (s.needsPick || s.answers.length === 0) {
      mk("suggested");
      continue;
    }
    mk(matchState(s.answers, effective));
  }

  // An accepted answer whose source no longer produces any suggestion (document archived, person
  // unmatched, ...): shown as stale so it is never silently trusted.
  for (const [nodeId, a] of Object.entries(effective)) {
    if (!a.src || covered.has(nodeId)) continue;
    const rule = ruleForNode(questionnaireId, nodeId);
    if (!rule || !rule.primary) continue;
    out[nodeId] = { nodeId, suggestionKey: null, state: "stale", staleReason: "doc_gone", bulk: false, acceptedDocValue: a.src.docValue };
  }
  return out;
}

/** "agrees" when every answer the source gives is already saved with the same value; "differs" if any saved one disagrees; else "suggested". */
function matchState(wanted: readonly PrefillAnswer[], effective: EffectiveAnswers): PrefillState {
  let missing = false;
  for (const w of wanted) {
    const a = effective[w.nodeId];
    if (!a) {
      missing = true;
      continue;
    }
    if (!sameValue(a.value, w.value)) return "differs";
  }
  return missing ? "suggested" : "agrees";
}

/** Re-export so callers have one import for the plain-text source line. */
export const describeSource = describeAnswerSource;

/** A text for a stale state, shown in the amber notice. */
export function staleMessage(reason: StalenessKind): string {
  switch (reason) {
    case "value_changed":
      return "The document now reads differently from when you accepted it.";
    case "new_candidate":
      return "A document was added that is not included in this answer.";
    case "doc_gone":
      return "A document this answer was filled from is no longer available or no longer gives an answer.";
    case "current":
      return "";
  }
}

/** Plain text for a stored / current `docValue`, by rule (cents become dollars; codes become words). */
export function formatDocValue(ruleId: PrefillRuleId, value: AnswerSource["docValue"]): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return formatCentsDisplay(value);
  if (ruleId === "return_filing") return FILING_STATUS_TEXT[value] ?? value;
  if (ruleId === "planning_solar") return "already claimed on a prior return";
  return value;
}

/** The "answer from your documents" data for one questionnaire page (empty when nothing applies). Plain data, client-safe. */
export interface QuestionnairePrefill {
  suggestions: PrefillSuggestion[];
  /** Keyed by the node id the suggestion block renders under. */
  states: Record<string, PrefillNodeState>;
  /** How many suggestions "Accept N suggestions" would apply (strong, still waiting). */
  bulkCount: number;
  /** Waiting suggestions that are NOT strong (each needs its own click). */
  weakCount: number;
}

export const NO_PREFILL: QuestionnairePrefill = { suggestions: [], states: {}, bulkCount: 0, weakCount: 0 };
