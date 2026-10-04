// Shared types for the AI Return Reviewer (plan ai-return-reviewer, section 5.1): the Finding model every review
// layer (L1 deterministic checks, L2 recomputation, L3 AI passes) produces, plus the stable finding key and the
// evidence hash that tie a disposition (an owner's "accepted" with a reason) to one finding in one state.
//
// PURE: no DB, no network, no clock. Everything here is JSON-safe so a finding can be stored as-is.
//
// Honesty contract (plan section 2): the reviewer is software plus an AI model, NOT a licensed professional. No
// message produced here may say or imply a professional certified the return; makeFinding refuses SSN-like text so a
// finding can never carry a taxpayer id into the database or a prompt.

import { createHash } from "node:crypto";
import { z } from "zod";
import { isSafeOutgoing } from "@/lib/tax-review/redact";
import { LINE_KEYS, type LineKey } from "@/lib/tax2025/line-catalog";
import { canonicalJson } from "@/lib/tax2025/pdf/format";

// ── Vocabulary ────────────────────────────────────────────────────────────────

export const REVIEW_LAYERS = ["L1", "L2", "L3"] as const;
export type ReviewLayer = (typeof REVIEW_LAYERS)[number];

/** Most serious first. */
export const SEVERITIES = ["blocker", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

/** True for blocker and high: the severities that keep the gate red while open. */
export function isGatingSeverity(s: Severity): boolean {
  return s === "blocker" || s === "high";
}

/** True for severities at or above `min` (blocker is the most serious). */
export function atLeast(s: Severity, min: Severity): boolean {
  return severityRank(s) <= severityRank(min);
}

export const FINDING_AREAS = [
  "income",
  "adjustments",
  "deductions",
  "credits",
  "payments",
  "tax",
  "state",
  "forms",
  "process",
  "packaging",
  "privacy",
] as const;
export type FindingArea = (typeof FINDING_AREAS)[number];

export const FINDING_ORIGINS = ["deterministic", "llm"] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

export const LLM_PASSES = ["income", "deductions", "forms", "ct", "risk", "adversarial"] as const;
export type LlmPass = (typeof LLM_PASSES)[number];

export const SOURCE_KINDS = ["constant", "source_pack", "form_text", "spec09", "heuristic", "engine"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATUSES = ["verified", "unverified", "not_applicable"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** `engine` = the finding is about a value the engine produced and cites nothing outside this repo. */
export interface SourceCitation {
  kind: SourceKind;
  /** A constant id (constants.ts), a source-pack id, a form + line id ("f1040:9") or a spec section. */
  id: string;
  url?: string;
  /** Verbatim text from the source (the printed form line, an instruction sentence). */
  quote?: string;
}

export interface FindingCitation {
  sources: SourceCitation[];
  sourceStatus: SourceStatus;
}

/**
 * One value a finding relies on, as it was when the run was made. `ref` is a LineKey (validated against LINE_KEYS)
 * or a namespaced reference: "doc:<id>", "table:<key>", "pdf:<form>:<field>", "sheet:<key>", "csv:<key>", "head:<row>".
 */
export interface EvidenceItem {
  ref: string;
  /** Whole dollars (or a count / ratio x100 where the note says so); null = the source carried no amount. */
  amount: number | null;
  /** Engine RuleStatus, "overridden", "absent" or a short check-specific state. */
  status: string;
  note?: string;
}

export const EVIDENCE_NAMESPACES = ["doc", "table", "pdf", "sheet", "csv", "head", "form", "check"] as const;

export interface Finding {
  /** STABLE: the same defect in a later run has the same key (layer|check|formKey|lineKey|ruleTag). */
  key: string;
  layer: ReviewLayer;
  /** e.g. "L1.F1.f1040.9". */
  check: string;
  severity: Severity;
  area: FindingArea;
  formKey?: string;
  lineKey?: LineKey;
  /** What distinguishes this finding from others of the same check / form / line (part of the key); not stored in the table. */
  ruleTag?: string;
  message: string;
  evidence: EvidenceItem[];
  citation: FindingCitation;
  recommendedAction: string;
  /** false = a broken invariant: it cannot be accepted, the return must be fixed. */
  acceptable: boolean;
  origin: FindingOrigin;
  pass?: LlmPass;
  downgradedFrom?: Severity;
  /** Adversarial-pass annotation (never closes a finding). */
  challenge?: string;
  /** sha256(canonical evidence) first 16 hex: an acceptance applies only while it is unchanged. */
  evidenceHash: string;
}

/** What a check supplies; makeFinding adds the key and the evidence hash and validates the rest. */
export interface FindingDraft {
  layer: ReviewLayer;
  check: string;
  severity: Severity;
  area: FindingArea;
  formKey?: string;
  lineKey?: LineKey;
  /** Distinguishes several findings of one check on the same form/line (a document id, a field name ...). */
  ruleTag?: string;
  message: string;
  evidence?: EvidenceItem[];
  citation?: FindingCitation;
  recommendedAction: string;
  acceptable: boolean;
  origin?: FindingOrigin;
  pass?: LlmPass;
  downgradedFrom?: Severity;
  challenge?: string;
}

// ── Hashes ────────────────────────────────────────────────────────────────────

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable key of a finding: the same check on the same form/line/tag is the same finding in every run. */
export function findingKey(parts: { layer: ReviewLayer; check: string; formKey?: string; lineKey?: string; ruleTag?: string }): string {
  return sha256Hex([parts.layer, parts.check, parts.formKey ?? "", parts.lineKey ?? "", parts.ruleTag ?? ""].join("|")).slice(0, 16);
}

/** Hash of the evidence values (order-independent): if the numbers behind a finding change, an old acceptance no longer applies. */
export function evidenceHashOf(evidence: readonly EvidenceItem[]): string {
  const rows = evidence.map((e) => ({ ref: e.ref, amount: e.amount, status: e.status })).sort((a, b) => a.ref.localeCompare(b.ref) || a.status.localeCompare(b.status));
  return sha256Hex(canonicalJson(rows)).slice(0, 16);
}

// ── Validation ────────────────────────────────────────────────────────────────

const LINE_KEY_SET: ReadonlySet<string> = new Set<string>(LINE_KEYS);

export function isLineKey(value: string): value is LineKey {
  return LINE_KEY_SET.has(value);
}

/** An evidence ref is a real LineKey or a "namespace:id" reference. */
export function isValidEvidenceRef(ref: string): boolean {
  if (isLineKey(ref)) return true;
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) return false;
  return (EVIDENCE_NAMESPACES as readonly string[]).includes(ref.slice(0, at));
}

export const MESSAGE_MAX = 1200;
export const ACTION_MAX = 600;

const sourceCitationSchema = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    id: z.string().min(1).max(200),
    url: z.string().max(400).optional(),
    quote: z.string().max(1200).optional(),
  })
  .strict();

const evidenceItemSchema = z
  .object({
    ref: z.string().min(1).max(300),
    amount: z.number().int().nullable(),
    status: z.string().min(1).max(60),
    note: z.string().max(300).optional(),
  })
  .strict();

/** Zod schema of a stored/validated Finding (strict: unknown keys are rejected). */
export const findingSchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{16}$/),
    layer: z.enum(REVIEW_LAYERS),
    check: z.string().min(1).max(200),
    severity: z.enum(SEVERITIES),
    area: z.enum(FINDING_AREAS),
    formKey: z.string().max(60).optional(),
    lineKey: z.string().max(80).optional(),
    ruleTag: z.string().max(300).optional(),
    message: z.string().min(1).max(MESSAGE_MAX),
    evidence: z.array(evidenceItemSchema).max(60),
    citation: z.object({ sources: z.array(sourceCitationSchema).max(10), sourceStatus: z.enum(SOURCE_STATUSES) }).strict(),
    recommendedAction: z.string().min(1).max(ACTION_MAX),
    acceptable: z.boolean(),
    origin: z.enum(FINDING_ORIGINS),
    pass: z.enum(LLM_PASSES).optional(),
    downgradedFrom: z.enum(SEVERITIES).optional(),
    challenge: z.string().max(600).optional(),
    evidenceHash: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();

export class FindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingError";
  }
}

const NO_CITATION: FindingCitation = { sources: [], sourceStatus: "not_applicable" };

/**
 * Builds a validated Finding. Throws FindingError (the message never echoes the offending text) when: the line key or an
 * evidence ref does not exist, the message / action / any quote contains SSN-like text, an invariant (acceptable: false)
 * is not deterministic, or the finding is too long. A check module that throws here has a bug; the runner turns that
 * into a "check failed to run" finding instead of dropping the check silently.
 */
export function makeFinding(draft: FindingDraft): Finding {
  const evidence = draft.evidence ?? [];
  if (draft.lineKey !== undefined && !isLineKey(draft.lineKey)) throw new FindingError(`unknown line key on finding ${draft.check}`);
  for (const e of evidence) {
    if (!isValidEvidenceRef(e.ref)) throw new FindingError(`unknown evidence ref on finding ${draft.check}`);
    if (e.amount !== null && !Number.isInteger(e.amount)) throw new FindingError(`non-integer evidence amount on finding ${draft.check}`);
  }
  const origin = draft.origin ?? "deterministic";
  if (!draft.acceptable && origin !== "deterministic") throw new FindingError(`only a deterministic finding can be a non-acceptable invariant (${draft.check})`);
  const citation = draft.citation ?? NO_CITATION;
  const texts = [draft.ruleTag ?? "", draft.message, draft.recommendedAction, draft.challenge ?? "", ...citation.sources.flatMap((s) => [s.id, s.quote ?? ""]), ...evidence.map((e) => `${e.ref} ${e.note ?? ""}`)];
  if (texts.some((t) => !isSafeOutgoing(t))) throw new FindingError(`finding ${draft.check} contains SSN-like, EIN-like or long digit text`);
  const finding: Finding = {
    key: findingKey({ layer: draft.layer, check: draft.check, ...(draft.formKey !== undefined ? { formKey: draft.formKey } : {}), ...(draft.lineKey !== undefined ? { lineKey: draft.lineKey } : {}), ...(draft.ruleTag !== undefined ? { ruleTag: draft.ruleTag } : {}) }),
    layer: draft.layer,
    check: draft.check,
    severity: draft.severity,
    area: draft.area,
    ...(draft.formKey !== undefined ? { formKey: draft.formKey } : {}),
    ...(draft.lineKey !== undefined ? { lineKey: draft.lineKey } : {}),
    ...(draft.ruleTag !== undefined ? { ruleTag: draft.ruleTag } : {}),
    message: draft.message,
    evidence: evidence.map((e) => ({ ...e })),
    citation: { sources: citation.sources.map((s) => ({ ...s })), sourceStatus: citation.sourceStatus },
    recommendedAction: draft.recommendedAction,
    acceptable: draft.acceptable,
    origin,
    ...(draft.pass !== undefined ? { pass: draft.pass } : {}),
    ...(draft.downgradedFrom !== undefined ? { downgradedFrom: draft.downgradedFrom } : {}),
    ...(draft.challenge !== undefined ? { challenge: draft.challenge } : {}),
    evidenceHash: evidenceHashOf(evidence),
  };
  const parsed = findingSchema.safeParse(finding);
  if (!parsed.success) throw new FindingError(`finding ${draft.check} is not valid (${parsed.error.issues[0]?.path.join(".") ?? "shape"})`);
  return finding;
}

/** Findings ordered most serious first, then by check and key (stable output for the UI, tests and the stored run). */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.check.localeCompare(b.check) || a.key.localeCompare(b.key));
}

/** Counts per severity (every severity present, zeros included). */
export function countBySeverity(findings: readonly Pick<Finding, "severity">[]): Record<Severity, number> {
  const out: Record<Severity, number> = { blocker: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

/** Two findings of the same run must have distinct keys; a duplicate is collapsed to the more serious one. */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const prev = byKey.get(f.key);
    if (prev === undefined || severityRank(f.severity) < severityRank(prev.severity)) byKey.set(f.key, f);
  }
  return [...byKey.values()];
}

/** The lines a finding is about, for the evidence table. */
export function evidenceLineKeys(finding: Pick<Finding, "evidence">): LineKey[] {
  return finding.evidence.map((e) => e.ref).filter(isLineKey);
}
