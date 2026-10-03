// Pure, data-driven questionnaire engine for the Forms page "Needs CPA input"
// cards. No DB, no "use server", client-safe (the runner component imports it so
// branching is computed with exactly the same code as the server).
//
// Honesty rules (CLAUDE.md ground rules 1 and 8):
//   * A questionnaire only GATHERS owner-reported facts for the CPA. It never
//     computes a tax amount, credit, limit or eligibility conclusion, and the
//     "outcome" it derives is only ever phrased "Owner reports ...".
//   * Questionnaire rows never change a form's applicability, readiness, field
//     counts or the summary counters on the Forms page. The few BOUND answers
//     (below) are the same planning answers the Planning screen writes, so they
//     move whatever the Planning screen would move - through the existing logic.
//
// Single source of truth: for the few questions that overlap an existing planning
// question (TAX_QUESTION_BANK) a node is BOUND - it reads and writes the planning
// answer, and the questionnaire row never keeps its own copy of that value.

import { TAX_QUESTION_BANK } from "@/lib/tax-guidance";
import { formatCentsDisplay } from "@/lib/tax-extraction-schema";
import { isEntityActiveForYear } from "@/lib/tax-entities";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Outcome = "applies" | "not_applies" | "unsure";
export type ContextFlag = "ekcActive" | "svActive";
export type SourceId = string; // key into SOURCES (lib/tax-questionnaire-content.ts)

export type Cond =
  | { kind: "in"; node: string; values: readonly string[] } // node visible and answered; single: value in values; multi: includes any of values
  | { kind: "hidden"; node: string } // node not visible (or its context flag is off)
  | { kind: "all"; of: readonly Cond[] }
  | { kind: "any"; of: readonly Cond[] };

export interface QOption {
  id: string;
  label: string;
  help?: string;
  /** multi: selecting it clears the others (e.g. "None of these"). The "unsure" option is always exclusive. */
  exclusive?: boolean;
  /** The standard "Not sure - ask the CPA" option (id `unsure`). */
  unsure?: true;
  context?: ContextFlag;
  /** Shown before choosing (e.g. "Also marks ... ruled out on the Planning screen"). */
  warning?: string;
  sources?: SourceId[];
}

export interface ChoiceBinding {
  mode: "shared_choice";
  /** A TAX_QUESTION_BANK key. */
  questionKey: string;
  /** option id -> planning-answer value; null = local-only (stored on the questionnaire row, no planning value). */
  bank: Readonly<Record<string, string | null>>;
}
export interface NumberBinding {
  mode: "shared_number";
  questionKey: string;
  format: "whole_number" | "whole_dollars";
}

interface NodeBase {
  id: string;
  prompt: string;
  help?: string;
  sources?: SourceId[];
  showWhen: Cond | null;
  context?: ContextFlag;
}
export interface ChoiceNode extends NodeBase {
  kind: "single" | "multi";
  options: readonly QOption[];
  binding?: ChoiceBinding;
}
/** `dollars`: bounds are WHOLE DOLLARS, the stored/answered value is integer CENTS. */
export interface NumberNode extends NodeBase {
  kind: "whole_number" | "dollars";
  min: number;
  max: number;
  binding?: NumberBinding;
}
export type QNode = ChoiceNode | NumberNode;

export interface QuestionnaireDef {
  id: string;
  version: number;
  title: string;
  formLabel: string;
  scope: "household" | "entity";
  /** One sentence, fact-gathering framing. */
  intro: string;
  introSources?: SourceId[];
  /** Tax year of the IRS instruction revisions the help text paraphrases. */
  sourcesTaxYear: number;
  /** ORDER MATTERS: a node may only reference earlier nodes in `showWhen`. */
  nodes: readonly QNode[];
  /** First match wins. */
  outcomeRules: readonly { when: Cond; outcome: Outcome }[];
  outcomeDefault: Outcome;
  outcomeText: Readonly<Record<Outcome, string>>;
  /** Planning answers shown read-only (free text; never written by the questionnaire). */
  planningLinks?: readonly { key: string; label: string }[];
}

export type AnswerValue = string | string[] | number;

/** What is persisted per node in TaxQuestionnaire.answers. `v: null` = bound node, value lives in the planning answer. */
export type StoredAnswers = Record<string, { v: AnswerValue | null; at: string; by: string | null }>;

export interface EffectiveAnswer {
  value: AnswerValue;
  source: "planning" | "questionnaire";
  at: string | null;
  by: string | null;
}
export type EffectiveAnswers = Record<string, EffectiveAnswer>;

export interface PlanningAnswerInput {
  key: string;
  answer: unknown;
  skippedReason: string | null;
  answeredAt?: Date | null;
}

export interface QuestionnaireContext {
  year: number;
  /** Entity name for entity-scoped questionnaires, else null. */
  entityName: string | null;
  ekcActive: boolean;
  svActive: boolean;
}

export type QuestionnaireStatus =
  | { kind: "not_started" }
  | { kind: "in_progress"; answered: number; shown: number }
  | { kind: "answered"; shown: number; unsureCount: number; outcome: Outcome };

export const UNSURE_ID = "unsure";
export const UNSURE_LABEL = "Not sure - ask the CPA";

// ── Copy ──────────────────────────────────────────────────────────────────────

export function renderCopy(text: string, ctx: Pick<QuestionnaireContext, "year" | "entityName">): string {
  return text
    .replace(/\{prevYear\}/g, String(ctx.year - 1))
    .replace(/\{nextYear\}/g, String(ctx.year + 1))
    .replace(/\{year\}/g, String(ctx.year))
    .replace(/\{entity\}/g, ctx.entityName ?? "the entity");
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function flagOn(flag: ContextFlag | undefined, ctx: QuestionnaireContext): boolean {
  return !flag || ctx[flag];
}

function isChoiceNode(node: QNode): node is ChoiceNode {
  return node.kind === "single" || node.kind === "multi";
}

/** A choice node's options with the context-off ones removed. */
export function nodeOptions(node: ChoiceNode, ctx: QuestionnaireContext): QOption[] {
  return node.options.filter((o) => flagOn(o.context, ctx));
}

function isExclusiveOption(o: QOption): boolean {
  return o.exclusive === true || o.unsure === true;
}

export function isUnsureValue(v: AnswerValue): boolean {
  if (Array.isArray(v)) return v.length === 1 && v[0] === UNSURE_ID;
  return v === UNSURE_ID;
}

/** Planning-question rule: answered = a value is present and it was not skipped. */
export function isPlanningAnswered(row: { answer: unknown; skippedReason: string | null }): boolean {
  return row.answer !== null && row.answer !== undefined && !row.skippedReason;
}

/** Defensive parse of the stored JSON column (anything malformed is dropped). */
export function parseStoredAnswers(raw: unknown): StoredAnswers {
  const out: StoredAnswers = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [nodeId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const v = e.v;
    const okValue =
      v === null ||
      typeof v === "string" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!okValue || typeof e.at !== "string") continue;
    out[nodeId] = { v: v as AnswerValue | null, at: e.at, by: typeof e.by === "string" ? e.by : null };
  }
  return out;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type ValidationResult = { ok: true; value: AnswerValue } | { ok: false; error: string };

/**
 * Validates (and normalizes) one answer value for a node. Pass `ctx` to also
 * reject options whose context flag is off. Number nodes accept the string
 * "unsure" ("Not sure" button); a `dollars` node's value is integer CENTS and
 * must be a whole number of dollars.
 */
export function validateAnswerValue(node: QNode, value: unknown, ctx?: QuestionnaireContext): ValidationResult {
  if (isChoiceNode(node)) {
    const options = ctx ? nodeOptions(node, ctx) : [...node.options];
    const known = new Map(options.map((o) => [o.id, o]));
    if (node.kind === "single") {
      if (typeof value !== "string" || !known.has(value)) return { ok: false, error: "Pick one of the listed answers" };
      return { ok: true, value };
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
      return { ok: false, error: "Pick at least one of the listed answers" };
    }
    const unique = Array.from(new Set(value as string[]));
    if (!unique.every((v) => known.has(v))) return { ok: false, error: "Pick only listed answers" };
    if (unique.length > 1 && unique.some((v) => isExclusiveOption(known.get(v)!))) {
      return { ok: false, error: "That answer cannot be combined with the others" };
    }
    return { ok: true, value: unique };
  }
  if (value === UNSURE_ID) return { ok: true, value: UNSURE_ID };
  if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, error: "Enter a whole number" };
  if (node.kind === "whole_number") {
    if (value < node.min || value > node.max) return { ok: false, error: `Enter a whole number from ${node.min} to ${node.max}` };
    return { ok: true, value };
  }
  // Dollar nodes hold integer cents; cents are allowed so a Planning answer such
  // as "12000.50" round-trips. Compared in integer cents, no float division.
  if (value < node.min * 100 || value > node.max * 100) {
    return { ok: false, error: `Enter a dollar amount from ${node.min} to ${node.max}` };
  }
  return { ok: true, value };
}

/**
 * Integer cents as an exact decimal-dollar string with no float math:
 * 1200000 -> "12000", 1200050 -> "12000.50", 5 -> "0.05". Used for the Planning
 * answer string and the number-input prefill so they round-trip exactly.
 */
export function centsToDollarString(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rem = cents - whole * 100;
  return rem === 0 ? String(whole) : `${whole}.${String(rem).padStart(2, "0")}`;
}

/**
 * Parses what the owner typed in a dollars box ("12000", "$12,000", "12000.5",
 * "12000.50") to integer cents with integer math, or null when it is not a plain
 * amount with at most two decimals (up to 10 whole-dollar digits).
 */
export function parseDollarInputToCents(text: string): number | null {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text.replace(/[$,\s]/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

// ── Planning-answer binding ───────────────────────────────────────────────────

// These two regexes mirror parseSqftAnswer / parseDollarAnswerToCents in
// lib/tax-compute-build.ts (which cannot be imported here: that module pulls in
// the database client and this module must stay client-safe). A unit test
// asserts they agree with the real parsers.
const SQFT_RE = /^(\d{1,5})\s*(sq\s?\.?\s?ft\.?)?$/i;
const DOLLAR_RE = /^\$?\s*([\d,]+)(\.\d{1,2})?\s*$/;

function parsePlanningNumber(node: NumberNode, answer: unknown): number | undefined {
  if (typeof answer !== "string") return undefined;
  const text = answer.trim();
  if (node.binding?.format === "whole_number") {
    const m = SQFT_RE.exec(text);
    if (!m) return undefined;
    const n = Number(m[1]);
    return n >= node.min && n <= node.max ? n : undefined;
  }
  const m = DOLLAR_RE.exec(text);
  if (!m) return undefined;
  const dollarsPart = m[1]!.replace(/,/g, "");
  const centsPart = m[2] ? m[2].slice(1).padEnd(2, "0") : "00";
  const cents = Number(dollarsPart) * 100 + Number(centsPart);
  if (!Number.isFinite(cents)) return undefined;
  return cents >= node.min * 100 && cents <= node.max * 100 ? cents : undefined;
}

/** The questionnaire value a planning answer maps to, or undefined when it does not map. */
function readPlanningValue(node: QNode, answer: unknown): AnswerValue | undefined {
  if (!node.binding) return undefined;
  if (isChoiceNode(node) && node.binding.mode === "shared_choice") {
    if (typeof answer !== "string") return undefined;
    const bank = node.binding.bank;
    const hit = node.options.find((o) => bank[o.id] === answer);
    return hit ? hit.id : undefined;
  }
  if (!isChoiceNode(node) && node.binding.mode === "shared_number") return parsePlanningNumber(node, answer);
  return undefined;
}

function planningRowFor(node: QNode, planning: readonly PlanningAnswerInput[]): PlanningAnswerInput | undefined {
  if (!node.binding) return undefined;
  const key = node.binding.questionKey;
  return planning.find((p) => p.key === key);
}

/**
 * When a bound node's planning answer exists but does not map to a value (free
 * text on a number question, or an unknown choice), returns that raw answer so the
 * UI can show it and the owner must confirm before it is replaced. Otherwise null.
 */
export function boundPlanningConflict(node: QNode, planning: readonly PlanningAnswerInput[]): string | null {
  const row = planningRowFor(node, planning);
  if (!row || !isPlanningAnswered(row)) return null;
  if (readPlanningValue(node, row.answer) !== undefined) return null;
  return typeof row.answer === "string" ? row.answer : JSON.stringify(row.answer);
}

/** Per-bound-node facts the runner needs to explain what saving will do. */
export interface BoundNodeInfo {
  /** The planning answer exists and maps to an answer (so a local-only choice would clear it). */
  hasPlanningValue: boolean;
  /** The planning answer exists but is free text / unknown (replacing it needs confirmation). */
  conflict: string | null;
}

/** True when a bound node's planning answer exists and maps to a value. */
export function boundPlanningHasValue(node: QNode, planning: readonly PlanningAnswerInput[]): boolean {
  const row = planningRowFor(node, planning);
  return !!row && isPlanningAnswered(row) && readPlanningValue(node, row.answer) !== undefined;
}

/** Is `value` a local-only answer on a bound node (stored on the row, no planning value)? */
export function isLocalOnlyValue(node: QNode, value: AnswerValue): boolean {
  if (!node.binding) return false;
  if (node.binding.mode === "shared_choice") {
    return typeof value === "string" && node.binding.bank[value] === null;
  }
  return value === UNSURE_ID;
}

/**
 * What to write to the planning answer for a (validated) value on a bound node.
 * `planningValue: null` means "local-only": the planning answer is cleared and the
 * value is kept on the questionnaire row. Returns null for an unbound node.
 */
export function resolveBoundWrite(
  node: QNode,
  value: AnswerValue
): { questionKey: string; planningValue: string | null } | null {
  const binding = node.binding;
  if (!binding) return null;
  if (binding.mode === "shared_choice") {
    if (typeof value !== "string") return null;
    return { questionKey: binding.questionKey, planningValue: binding.bank[value] ?? null };
  }
  if (typeof value !== "number") return { questionKey: binding.questionKey, planningValue: null };
  const planningValue = binding.format === "whole_dollars" ? centsToDollarString(value) : String(value);
  return { questionKey: binding.questionKey, planningValue };
}

// ── Effective answers ─────────────────────────────────────────────────────────

/**
 * The answers currently in force. Unbound nodes: the stored value (validated -
 * unknown options / out-of-range numbers are dropped). Bound nodes: the planning
 * answer wins when it is answered AND maps to a value; otherwise a stored
 * local-only value (e.g. "Not sure"); otherwise unanswered. `by` is only trusted
 * when the stored mirror's `at` equals the planning row's `answeredAt` exactly
 * (both are written with the same Date); otherwise the answer came from the
 * Planning screen and `by` is null.
 */
export function effectiveAnswers(
  def: QuestionnaireDef,
  stored: StoredAnswers,
  planning: readonly PlanningAnswerInput[],
  ctx: QuestionnaireContext
): EffectiveAnswers {
  const out: EffectiveAnswers = {};
  for (const node of def.nodes) {
    const s = stored[node.id];
    let storedValue: AnswerValue | undefined;
    if (s && s.v !== null) {
      const checked = validateAnswerValue(node, s.v, ctx);
      if (checked.ok) storedValue = checked.value;
    }

    if (node.binding) {
      const row = planningRowFor(node, planning);
      if (row && isPlanningAnswered(row)) {
        const fromPlanning = readPlanningValue(node, row.answer);
        if (fromPlanning !== undefined) {
          const at = row.answeredAt ? row.answeredAt.toISOString() : null;
          out[node.id] = {
            value: fromPlanning,
            source: "planning",
            at,
            by: s && at !== null && s.at === at ? s.by : null,
          };
          continue;
        }
      }
      if (s && storedValue !== undefined && isLocalOnlyValue(node, storedValue)) {
        out[node.id] = { value: storedValue, source: "questionnaire", at: s.at, by: s.by };
      }
      continue;
    }

    if (s && storedValue !== undefined) {
      out[node.id] = { value: storedValue, source: "questionnaire", at: s.at, by: s.by };
    }
  }
  return out;
}

// ── Visibility ────────────────────────────────────────────────────────────────

function matchesValues(answer: EffectiveAnswer | undefined, values: readonly string[]): boolean {
  if (!answer) return false;
  const v = answer.value;
  if (Array.isArray(v)) return v.some((x) => values.includes(x));
  if (typeof v === "string") return values.includes(v);
  return false;
}

function evalCond(cond: Cond, answers: EffectiveAnswers, visibleIds: ReadonlySet<string>): boolean {
  switch (cond.kind) {
    case "in":
      return visibleIds.has(cond.node) && matchesValues(answers[cond.node], cond.values);
    case "hidden":
      return !visibleIds.has(cond.node);
    case "all":
      return cond.of.every((c) => evalCond(c, answers, visibleIds));
    case "any":
      return cond.of.some((c) => evalCond(c, answers, visibleIds));
  }
}

interface Analysis {
  visible: QNode[];
  visibleIds: Set<string>;
  /** Effective answers of VISIBLE nodes only (hidden answers are kept in storage but ignored). */
  answers: EffectiveAnswers;
}

function analyze(def: QuestionnaireDef, ctx: QuestionnaireContext, effective: EffectiveAnswers): Analysis {
  const visible: QNode[] = [];
  const visibleIds = new Set<string>();
  const answers: EffectiveAnswers = {};
  for (const node of def.nodes) {
    if (!flagOn(node.context, ctx)) continue;
    if (node.showWhen !== null && !evalCond(node.showWhen, answers, visibleIds)) continue;
    visible.push(node);
    visibleIds.add(node.id);
    const a = effective[node.id];
    if (a) answers[node.id] = a;
  }
  return { visible, visibleIds, answers };
}

/** The questions currently shown, in order. */
export function visibleNodes(def: QuestionnaireDef, ctx: QuestionnaireContext, effective: EffectiveAnswers): QNode[] {
  return analyze(def, ctx, effective).visible;
}

export function isNodeVisible(
  def: QuestionnaireDef,
  ctx: QuestionnaireContext,
  effective: EffectiveAnswers,
  nodeId: string
): boolean {
  return analyze(def, ctx, effective).visibleIds.has(nodeId);
}

// ── Status / outcome ──────────────────────────────────────────────────────────

export function computeOutcome(def: QuestionnaireDef, ctx: QuestionnaireContext, effective: EffectiveAnswers): Outcome {
  const { answers, visibleIds } = analyze(def, ctx, effective);
  for (const rule of def.outcomeRules) {
    if (evalCond(rule.when, answers, visibleIds)) return rule.outcome;
  }
  return def.outcomeDefault;
}

export function computeStatus(
  def: QuestionnaireDef,
  ctx: QuestionnaireContext,
  effective: EffectiveAnswers
): QuestionnaireStatus {
  const { visible, answers } = analyze(def, ctx, effective);
  const shown = visible.length;
  const answered = visible.filter((n) => answers[n.id] !== undefined).length;
  if (answered === 0) return { kind: "not_started" };
  if (answered < shown) return { kind: "in_progress", answered, shown };
  const unsureCount = visible.filter((n) => {
    const a = answers[n.id];
    return a !== undefined && isUnsureValue(a.value);
  }).length;
  return { kind: "answered", shown, unsureCount, outcome: computeOutcome(def, ctx, effective) };
}

export function statusLabel(status: QuestionnaireStatus): string {
  switch (status.kind) {
    case "not_started":
      return "Not started";
    case "in_progress":
      return `In progress (${status.answered} of ${status.shown} answered)`;
    case "answered":
      return "Answered";
  }
}

/** The single line a card shows under an Answered questionnaire. Never a determination. */
export const OWNER_LINE: Readonly<Record<Outcome, string>> = {
  applies: "Owner reports this likely applies - confirm with the CPA.",
  not_applies: "Owner reports this likely does not apply - confirm with the CPA.",
  unsure: "Owner is unsure - the CPA decides.",
};

// ── Summary ───────────────────────────────────────────────────────────────────

export interface SummaryFact {
  nodeId: string;
  prompt: string;
  answerLabel: string;
  unsure: boolean;
  answeredAt: string | null;
  /** User id; the view maps it to a name. Null when the answer came from the Planning screen. */
  by: string | null;
  source: "planning" | "questionnaire";
}

export interface QuestionnaireSummary {
  status: QuestionnaireStatus;
  outcome: Outcome | null;
  outcomeText: string | null;
  facts: SummaryFact[];
  /** Prompts of visible questions marked Not sure or still unanswered. */
  openQuestions: string[];
  planningLinks: { key: string; label: string }[];
  note: string | null;
}

export function answerLabel(node: QNode, value: AnswerValue, ctx: QuestionnaireContext): string {
  if (isUnsureValue(value)) return UNSURE_LABEL;
  if (isChoiceNode(node)) {
    const ids = Array.isArray(value) ? value : [String(value)];
    return ids
      .map((id) => {
        const o = node.options.find((x) => x.id === id);
        return o ? renderCopy(o.label, ctx) : id;
      })
      .join(", ");
  }
  if (typeof value !== "number") return String(value);
  return node.kind === "dollars" ? formatCentsDisplay(value) : String(value);
}

/** Deterministic summary of what the owner reported. Contains no computed tax figure. */
export function buildSummary(
  def: QuestionnaireDef,
  ctx: QuestionnaireContext,
  effective: EffectiveAnswers,
  note: string | null
): QuestionnaireSummary {
  const { visible, answers } = analyze(def, ctx, effective);
  const status = computeStatus(def, ctx, effective);
  const facts: SummaryFact[] = [];
  const openQuestions: string[] = [];
  for (const node of visible) {
    const prompt = renderCopy(node.prompt, ctx);
    const a = answers[node.id];
    if (!a) {
      openQuestions.push(prompt);
      continue;
    }
    const unsure = isUnsureValue(a.value);
    facts.push({
      nodeId: node.id,
      prompt,
      answerLabel: answerLabel(node, a.value, ctx),
      unsure,
      answeredAt: a.at,
      by: a.by,
      source: a.source,
    });
    if (unsure) openQuestions.push(prompt);
  }
  const outcome = status.kind === "answered" ? status.outcome : null;
  return {
    status,
    outcome,
    outcomeText: outcome ? renderCopy(def.outcomeText[outcome], ctx) : null,
    facts,
    openQuestions,
    planningLinks: (def.planningLinks ?? []).map((l) => ({ key: l.key, label: l.label })),
    note: note && note.trim() !== "" ? note : null,
  };
}

// ── Forms-page card state ─────────────────────────────────────────────────────

export interface QuestionnaireRowInput {
  taxYear: number;
  entityId: string;
  questionnaireId: string;
  definitionVersion: number;
  answers: unknown;
  note: string | null;
  noteUpdatedAt?: Date | null;
  noteUpdatedById?: string | null;
}

export interface QuestionnaireCardState {
  questionnaireId: string;
  entityId: string;
  scope: "household" | "entity";
  title: string;
  status: QuestionnaireStatus;
  outcome: Outcome | null;
  /** The per-questionnaire "Owner reports ..." sentence when answered. */
  outcomeText: string | null;
  /** The generic "Owner reports this likely applies ..." line when answered. */
  ownerLine: string | null;
  /** The saved row was written against an older version of the questions. */
  stale: boolean;
}

export function buildCardState(
  def: QuestionnaireDef,
  entityId: string,
  ctx: QuestionnaireContext,
  row: QuestionnaireRowInput | null,
  planning: readonly PlanningAnswerInput[]
): QuestionnaireCardState {
  const stored = row ? parseStoredAnswers(row.answers) : {};
  const effective = effectiveAnswers(def, stored, planning, ctx);
  const status = computeStatus(def, ctx, effective);
  const outcome = status.kind === "answered" ? status.outcome : null;
  return {
    questionnaireId: def.id,
    entityId,
    scope: def.scope,
    title: renderCopy(def.title, ctx),
    status,
    outcome,
    outcomeText: outcome ? renderCopy(def.outcomeText[outcome], ctx) : null,
    ownerLine: outcome ? OWNER_LINE[outcome] : null,
    stale: row !== null && row.definitionVersion !== def.version,
  };
}

export interface QuestionnaireCounts {
  total: number;
  notStarted: number;
  inProgress: number;
  answered: number;
}

export function summarizeQuestionnaires(entries: readonly { status: QuestionnaireStatus }[]): QuestionnaireCounts {
  return {
    total: entries.length,
    notStarted: entries.filter((e) => e.status.kind === "not_started").length,
    inProgress: entries.filter((e) => e.status.kind === "in_progress").length,
    answered: entries.filter((e) => e.status.kind === "answered").length,
  };
}

export function questionnaireHref(
  year: number,
  def: Pick<QuestionnaireDef, "id" | "scope">,
  entityId: string
): string {
  const base = `/tax/forms/${year}/questionnaire/${def.id}`;
  return def.scope === "entity" ? `${base}?entity=${encodeURIComponent(entityId)}` : base;
}

// ── Scope (which entity a questionnaire may be saved under) ──────────────────

export interface ScopeEntity {
  id: string;
  name: string;
  slug: string | null;
  type: string; // "personal" | "business"
  foundedDate: Date | null;
  taxStatusNotes: string | null;
}

const SLUG_EKC = "ek-consulting";
const SLUG_SV = "sudden-valley";

/** Questionnaires whose card only exists when Sudden Valley is active (existing SV_ONLY_CPA_OPPORTUNITIES). */
const SV_ONLY_QUESTIONNAIRES: ReadonlySet<string> = new Set(["form-4562", "form-8582"]);

/** EK Consulting / Sudden Valley "active for the year" flags from the (non-archived) entity list. */
export function activeFlags(entities: readonly ScopeEntity[], year: number): { ekcActive: boolean; svActive: boolean } {
  const ekc = entities.find((e) => e.slug === SLUG_EKC);
  const sv = entities.find((e) => e.slug === SLUG_SV);
  return {
    ekcActive: ekc ? isEntityActiveForYear(ekc, year) : false,
    svActive: sv ? isEntityActiveForYear(sv, year) : false,
  };
}

/**
 * Server-side scope check shared by the actions and the pages: a household
 * questionnaire belongs to the Personal entity, an entity-scoped one to an active
 * business entity, and the Sudden Valley-only questionnaires need Sudden Valley
 * active. Context flags always come from the entity records, never from a client.
 */
export function resolveQuestionnaireScope(
  def: QuestionnaireDef,
  entities: readonly ScopeEntity[],
  year: number,
  entityId: string
): { ok: true; ctx: QuestionnaireContext; entityName: string } | { ok: false; error: string } {
  const target = entities.find((e) => e.id === entityId);
  if (!target) return { ok: false, error: "Entity not found" };
  const flags = activeFlags(entities, year);
  if (def.scope === "household") {
    if (target.type !== "personal") return { ok: false, error: "This questionnaire belongs to the household" };
  } else {
    if (target.type !== "business") return { ok: false, error: "This questionnaire belongs to a business entity" };
    if (!isEntityActiveForYear(target, year)) return { ok: false, error: "That entity has no filing for this tax year" };
  }
  if (SV_ONLY_QUESTIONNAIRES.has(def.id) && !flags.svActive) {
    return { ok: false, error: "This questionnaire does not apply to this tax year" };
  }
  return {
    ok: true,
    entityName: target.name,
    ctx: { year, entityName: def.scope === "entity" ? target.name : null, ...flags },
  };
}

// ── Path enumeration (tests + reachability) ──────────────────────────────────

function condNodes(cond: Cond, into: Set<string>): void {
  switch (cond.kind) {
    case "in":
    case "hidden":
      into.add(cond.node);
      return;
    case "all":
    case "any":
      for (const c of cond.of) condNodes(c, into);
  }
}

function referencedNodeIds(def: QuestionnaireDef): Set<string> {
  const ids = new Set<string>();
  for (const n of def.nodes) if (n.showWhen) condNodes(n.showWhen, ids);
  for (const r of def.outcomeRules) condNodes(r.when, ids);
  return ids;
}

function representativeValues(node: QNode, referenced: boolean, ctx: QuestionnaireContext): AnswerValue[] {
  if (isChoiceNode(node)) {
    const options = nodeOptions(node, ctx);
    const plain = options.filter((o) => !isExclusiveOption(o));
    if (node.kind === "single") {
      if (referenced) return options.map((o) => o.id);
      return [(plain[0] ?? options[0])!.id];
    }
    if (!referenced) return [[(plain[0] ?? options[0])!.id]];
    const reps: AnswerValue[] = plain.map((o) => [o.id]);
    if (plain.length > 1) reps.push(plain.map((o) => o.id));
    for (const o of options) if (isExclusiveOption(o)) reps.push([o.id]);
    return reps;
  }
  const valid = node.kind === "dollars" ? node.min * 100 : node.min;
  return referenced ? [valid, UNSURE_ID] : [valid];
}

/**
 * Depth-first enumeration of complete answer paths (every visible question
 * answered). Only questions that a condition references are expanded over all
 * their options; the rest collapse to one representative. Stops at `cap`.
 */
export function enumerateAnswerPaths(
  def: QuestionnaireDef,
  ctx: QuestionnaireContext,
  cap = 20000
): { paths: EffectiveAnswers[]; truncated: boolean } {
  const referenced = referencedNodeIds(def);
  const paths: EffectiveAnswers[] = [];
  let truncated = false;

  const walk = (index: number, answers: EffectiveAnswers, visibleIds: Set<string>): void => {
    if (truncated) return;
    if (index >= def.nodes.length) {
      if (paths.length >= cap) {
        truncated = true;
        return;
      }
      paths.push(answers);
      return;
    }
    const node = def.nodes[index]!;
    const show =
      flagOn(node.context, ctx) && (node.showWhen === null || evalCond(node.showWhen, answers, visibleIds));
    if (!show) {
      walk(index + 1, answers, visibleIds);
      return;
    }
    for (const value of representativeValues(node, referenced.has(node.id), ctx)) {
      const nextIds = new Set(visibleIds).add(node.id);
      walk(index + 1, { ...answers, [node.id]: { value, source: "questionnaire", at: null, by: null } }, nextIds);
      if (truncated) return;
    }
  };

  walk(0, {}, new Set());
  return { paths, truncated };
}

// ── Definition integrity ──────────────────────────────────────────────────────

const MONEY_IN_COPY = /\$\d/;

function checkCond(
  cond: Cond,
  def: QuestionnaireDef,
  indexById: ReadonlyMap<string, number>,
  where: string,
  maxIndex: number,
  problems: string[]
): void {
  switch (cond.kind) {
    case "in":
    case "hidden": {
      const idx = indexById.get(cond.node);
      if (idx === undefined) {
        problems.push(`${where}: references unknown node "${cond.node}"`);
        return;
      }
      if (idx >= maxIndex) problems.push(`${where}: references "${cond.node}" which is not an earlier node`);
      if (cond.kind === "in") {
        const target = def.nodes[idx]!;
        if (!isChoiceNode(target)) {
          problems.push(`${where}: "in" on non-choice node "${cond.node}"`);
        } else {
          const ids = new Set(target.options.map((o) => o.id));
          for (const v of cond.values) {
            if (!ids.has(v)) problems.push(`${where}: "${cond.node}" has no option "${v}"`);
          }
        }
      }
      return;
    }
    case "all":
    case "any":
      if (cond.of.length === 0) problems.push(`${where}: empty ${cond.kind}`);
      for (const c of cond.of) checkCond(c, def, indexById, where, maxIndex, problems);
  }
}

/**
 * Returns a list of problems (empty = valid): unique ids, conditions only
 * reference real EARLIER nodes and real option ids, exactly one `unsure` option on
 * every choice node, valid exclusive options, binding integrity against
 * TAX_QUESTION_BANK, a source for any `$` amount in copy, known source ids (when
 * `sourceIds` is given), and every node reachable.
 */
export function validateDefinition(def: QuestionnaireDef, sourceIds?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!def.id) problems.push("definition has no id");
  if (def.nodes.length === 0) problems.push(`${def.id}: no nodes`);

  const indexById = new Map<string, number>();
  def.nodes.forEach((n, i) => {
    if (indexById.has(n.id)) problems.push(`${def.id}: duplicate node id "${n.id}"`);
    else indexById.set(n.id, i);
  });

  const checkSources = (ids: readonly string[] | undefined, where: string) => {
    if (!ids || !sourceIds) return;
    for (const s of ids) if (!sourceIds.has(s)) problems.push(`${where}: unknown source "${s}"`);
  };
  checkSources(def.introSources, `${def.id} intro`);

  def.nodes.forEach((node, i) => {
    const where = `${def.id}.${node.id}`;
    if (node.showWhen) checkCond(node.showWhen, def, indexById, `${where} showWhen`, i, problems);
    checkSources(node.sources, where);

    const copy = [node.prompt, node.help ?? ""];
    let hasSource = (node.sources?.length ?? 0) > 0;

    if (isChoiceNode(node)) {
      const ids = new Set<string>();
      for (const o of node.options) {
        if (ids.has(o.id)) problems.push(`${where}: duplicate option id "${o.id}"`);
        ids.add(o.id);
        copy.push(o.label, o.help ?? "", o.warning ?? "");
        if ((o.sources?.length ?? 0) > 0) hasSource = true;
        checkSources(o.sources, `${where}.${o.id}`);
        if (o.exclusive && node.kind !== "multi") problems.push(`${where}: "exclusive" only applies to multi`);
        if (o.unsure && o.id !== UNSURE_ID) problems.push(`${where}: the unsure option must have id "unsure"`);
        if (o.id === UNSURE_ID && !o.unsure) problems.push(`${where}: option "unsure" must be flagged unsure`);
      }
      const unsureCount = node.options.filter((o) => o.unsure).length;
      if (unsureCount !== 1) problems.push(`${where}: needs exactly one "unsure" option (has ${unsureCount})`);
      if (node.options.length < 2) problems.push(`${where}: needs at least two options`);
      if (node.binding) {
        if (node.kind !== "single") problems.push(`${where}: only a single-choice node can be bound`);
        if (node.binding.mode !== "shared_choice") problems.push(`${where}: choice node needs a shared_choice binding`);
        else checkChoiceBinding(node, where, problems);
      }
    } else {
      if (!Number.isInteger(node.min) || !Number.isInteger(node.max) || node.min > node.max) {
        problems.push(`${where}: invalid min/max`);
      }
      if (node.binding) {
        if (node.binding.mode !== "shared_number") problems.push(`${where}: number node needs a shared_number binding`);
        else {
          const wantsFormat = node.kind === "dollars" ? "whole_dollars" : "whole_number";
          if (node.binding.format !== wantsFormat) problems.push(`${where}: binding format must be ${wantsFormat}`);
          const bank = TAX_QUESTION_BANK.find((q) => q.key === node.binding!.questionKey);
          if (!bank) problems.push(`${where}: unknown planning question "${node.binding.questionKey}"`);
          else if (bank.options) problems.push(`${where}: planning question "${bank.key}" is a choice question`);
        }
      }
    }

    if (copy.some((c) => MONEY_IN_COPY.test(c)) && !hasSource) {
      problems.push(`${where}: a dollar amount in the copy needs a source`);
    }
  });

  def.outcomeRules.forEach((r, i) => {
    checkCond(r.when, def, indexById, `${def.id} outcomeRules[${i}]`, def.nodes.length, problems);
  });
  for (const o of ["applies", "not_applies", "unsure"] as const) {
    if (!def.outcomeText[o] || def.outcomeText[o].trim() === "") problems.push(`${def.id}: outcomeText.${o} is empty`);
  }
  if (!["applies", "not_applies", "unsure"].includes(def.outcomeDefault)) problems.push(`${def.id}: bad outcomeDefault`);
  for (const l of def.planningLinks ?? []) {
    if (!TAX_QUESTION_BANK.some((q) => q.key === l.key)) problems.push(`${def.id}: planning link "${l.key}" is not a planning question`);
  }

  // Reachability: every node is visible on at least one complete path (all context flags on).
  if (problems.length === 0) {
    const full: QuestionnaireContext = { year: 2025, entityName: "Entity", ekcActive: true, svActive: true };
    const { paths } = enumerateAnswerPaths(def, full);
    const seen = new Set<string>();
    for (const p of paths) for (const id of Object.keys(p)) seen.add(id);
    for (const n of def.nodes) if (!seen.has(n.id)) problems.push(`${def.id}.${n.id}: unreachable`);
  }
  return problems;
}

function checkChoiceBinding(node: ChoiceNode, where: string, problems: string[]): void {
  const binding = node.binding;
  if (!binding) return;
  const bank = TAX_QUESTION_BANK.find((q) => q.key === binding.questionKey);
  if (!bank) {
    problems.push(`${where}: unknown planning question "${binding.questionKey}"`);
    return;
  }
  if (!bank.options) {
    problems.push(`${where}: planning question "${bank.key}" is not a choice question`);
    return;
  }
  const bankValues = new Set(bank.options.map((o) => o.value));
  const mapped = new Set<string>();
  for (const o of node.options) {
    if (!(o.id in binding.bank)) {
      problems.push(`${where}: option "${o.id}" has no binding entry (use null for local-only)`);
      continue;
    }
    const v = binding.bank[o.id];
    if (v === null || v === undefined) continue;
    if (!bankValues.has(v)) problems.push(`${where}: option "${o.id}" maps to "${v}", which is not a "${bank.key}" answer`);
    if (mapped.has(v)) problems.push(`${where}: two options map to "${v}"`);
    mapped.add(v);
  }
  for (const id of Object.keys(binding.bank)) {
    if (!node.options.some((o) => o.id === id)) problems.push(`${where}: binding names unknown option "${id}"`);
  }
  for (const v of bankValues) {
    if (!mapped.has(v)) problems.push(`${where}: planning answer "${v}" is not reachable from any option`);
  }
}
