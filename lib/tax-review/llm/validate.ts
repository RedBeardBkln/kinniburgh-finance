// Code validators for what the model returns (ai-return-reviewer, B3; plan 5.5.5). Nothing the model says reaches the findings table,
// the gate or the screen except through these functions.
//
// Per finding, in order:
//   1. shape (zod; unknown keys are stripped, so a model that adds `status: "accepted"` or a gate field changes nothing);
//   2. the line it names and every evidence reference must exist in the payload, and every evidence amount must EQUAL the payload's
//      value for that reference (a finding that cites a line or a value that is not there is REJECTED, kept only as a reason class);
//   3. identifier-shaped text (SSN-like, EIN-like, long digit runs) anywhere in it: the finding is dropped and counted;
//   4. citations: a constant id must exist in the registry; a source-pack quote must appear verbatim (after normalisation) in the
//      pinned source it names; a form-text quote must appear in the printed form text of the payload. Otherwise the finding is
//      "unverified";
//   5. dollar-figure guard: a "$" figure in the text must be in the payload, in the source text the task was given, or be a sum or
//      difference of the amounts the finding cites; otherwise "unverified";
//   6. severity guard: a model can never emit a blocker unless a law claim is verified; an unverified finding is capped at medium and
//      keeps its original severity in `downgradedFrom` (lib/tax-review/gate.ts: such a finding still gates until the owner accepts it
//      with a written reason, owner decision D2); a finding with no evidence at all cannot stay at blocker / high;
//   7. duplicates (same key) collapse to the most serious.
// The model can only ADD findings: this module never returns anything that closes, accepts or changes another finding.
//
// PURE.

import { CONSTANTS } from "@/lib/tax2025/constants";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { ownerWording } from "@/lib/tax-wording";
import { dedupeFindings, FindingError, isLineKey, isGatingSeverity, makeFinding, severityRank, type EvidenceItem, type Finding, type FindingCitation, type LlmPass, type Severity, type SourceCitation } from "@/lib/tax-review/types";
import { hasSource, normalizeForQuote, sourceEntry, verifyQuote, type SourcePack } from "@/lib/tax-review/llm/sources";
import type { PayloadIndex } from "@/lib/tax-review/llm/payload";
import { modelChallengeSchema, modelFindingSchema, modelNarrationSchema, type ModelFinding } from "@/lib/tax-review/llm/schemas";
import type { RegisterEntry, RegisterSource } from "@/lib/tax-review/llm/register";

export type RejectReason = "schema" | "unknown_line" | "unknown_ref" | "value_mismatch" | "invalid_finding";

export interface RejectedFinding {
  reason: RejectReason;
  category: string | null;
}

export interface ValidationContext {
  pass: LlmPass;
  /** The task's category list (an unknown category becomes "other"). */
  categories: readonly string[];
  index: PayloadIndex;
  pack: SourcePack;
  /** Numbers appearing in the source text the task was given (a law figure quoted from there is not "invented"). */
  excerptNumbers: ReadonlySet<number>;
}

export interface ValidationOutcome {
  accepted: Finding[];
  rejected: RejectedFinding[];
  /** Findings kept but marked unverified (law claim without a verified source, or a figure not in the payload). */
  unverified: number;
  /** Findings whose severity was lowered. */
  downgraded: number;
  /** Findings dropped because their text looked like an identifier. */
  privacyDropped: number;
}

// ── figures ───────────────────────────────────────────────────────────────────

const FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g;

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Money-looking figures in a text ("$1,234", "$1,234.56", "273,291"), as numbers. */
export function figuresIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const n = toNumber(m[0]);
    if (n !== null) out.push(Math.abs(n));
  }
  return out;
}

const ANY_NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Every number in a text (source excerpts), for the figure guard. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(ANY_NUMBER)) {
    const n = toNumber(m[0]);
    if (n !== null) out.add(Math.abs(n));
  }
  return out;
}

function derivedAmounts(amounts: readonly number[]): Set<number> {
  const out = new Set<number>();
  let sum = 0;
  for (const a of amounts) sum += Math.abs(a);
  out.add(sum);
  for (let i = 0; i < amounts.length; i += 1) {
    for (let j = i + 1; j < amounts.length; j += 1) {
      const a = amounts[i] ?? 0;
      const b = amounts[j] ?? 0;
      out.add(Math.abs(a + b));
      out.add(Math.abs(a - b));
    }
  }
  return out;
}

function figureAllowed(fig: number, allowed: readonly ReadonlySet<number>[]): boolean {
  if (fig === 0) return true;
  const rounded = Math.round(fig);
  return allowed.some((set) => set.has(fig) || set.has(rounded));
}

// ── evidence ──────────────────────────────────────────────────────────────────

type EvidenceResult = { ok: true; item: EvidenceItem } | { ok: false; reason: RejectReason };

/** Exported for reuse.ts, which re-checks the evidence of a reused finding against the CURRENT payload with this same function. */
export function resolveEvidence(ref: string, amount: number | null, index: PayloadIndex): EvidenceResult {
  if (isLineKey(ref)) {
    const line = index.lines.get(ref);
    if (line === undefined) return { ok: false, reason: "unknown_line" };
    if (amount !== line.amount) return { ok: false, reason: "value_mismatch" };
    return { ok: true, item: { ref, amount, status: line.status } };
  }
  // something shaped like a line key ("f1040.999") that is not one of this return's lines
  if (/^[a-z][a-z0-9]*\.[A-Za-z0-9._]+$/.test(ref)) return { ok: false, reason: "unknown_line" };
  if (ref.startsWith("doc:")) {
    const alias = ref.slice(4);
    const doc = index.docs.get(alias);
    if (doc === undefined) return { ok: false, reason: "unknown_ref" };
    if (amount !== null && !doc.numbers.has(Math.abs(amount))) return { ok: false, reason: "value_mismatch" };
    return { ok: true, item: { ref, amount, status: "document" } };
  }
  if (ref.startsWith("head:")) {
    const key = ref.slice(5);
    if (!index.headRows.has(key)) return { ok: false, reason: "unknown_ref" };
    if (amount !== (index.headRows.get(key) ?? null)) return { ok: false, reason: "value_mismatch" };
    return { ok: true, item: { ref, amount, status: "headline" } };
  }
  return { ok: false, reason: "unknown_ref" };
}

// ── citations ─────────────────────────────────────────────────────────────────

const MIN_FORM_QUOTE = 8;

function buildCitation(model: ModelFinding, ctx: ValidationContext): { citation: FindingCitation; anyVerified: boolean } {
  const normalizedForms = ctx.index.formTexts.map((t) => normalizeForQuote(t));
  const sources: SourceCitation[] = [];
  let anyVerified = false;
  for (const s of model.sources) {
    const quote = s.quote ?? undefined;
    if (s.kind === "constant") {
      const c = (CONSTANTS as Record<string, { url: string } | undefined>)[s.id];
      if (c !== undefined) {
        anyVerified = true;
        sources.push({ kind: "constant", id: s.id, url: c.url });
      } else sources.push({ kind: "constant", id: s.id });
    } else if (s.kind === "source_pack") {
      const verified = hasSource(ctx.pack, s.id) && verifyQuote(ctx.pack, s.id, quote);
      const entry = sourceEntry(ctx.pack, s.id);
      if (verified) anyVerified = true;
      sources.push({ kind: "source_pack", id: s.id, ...(entry !== undefined ? { url: entry.url } : {}), ...(quote !== undefined ? { quote } : {}) });
    } else if (s.kind === "form_text") {
      const q = quote === undefined ? "" : normalizeForQuote(quote);
      const verified = q.length >= MIN_FORM_QUOTE && normalizedForms.some((t) => t.includes(q));
      if (verified) anyVerified = true;
      sources.push({ kind: "form_text", id: s.id, ...(quote !== undefined ? { quote } : {}) });
    } else {
      sources.push({ kind: s.kind, id: s.id, ...(quote !== undefined ? { quote } : {}) });
    }
  }
  const sourceStatus: FindingCitation["sourceStatus"] = model.legalClaim ? (anyVerified ? "verified" : "unverified") : "not_applicable";
  return { citation: { sources, sourceStatus }, anyVerified };
}

// ── one finding ───────────────────────────────────────────────────────────────

const clipText = (s: string, n: number): string => ownerWording(s).replace(/\s+/g, " ").trim().slice(0, n);

function textsOf(m: ModelFinding): string[] {
  return [m.message, m.recommendedAction, m.form ?? "", m.lineKey ?? "", ...m.evidence.map((e) => e.ref), ...m.sources.flatMap((s) => [s.id, s.quote ?? ""])];
}

type One = { kind: "ok"; finding: Finding; unverified: boolean; downgraded: boolean } | { kind: "reject"; reason: RejectReason } | { kind: "privacy" };

function validateOne(raw: unknown, ctx: ValidationContext): { result: One; category: string | null } {
  const parsed = modelFindingSchema.safeParse(raw);
  if (!parsed.success) return { result: { kind: "reject", reason: "schema" }, category: null };
  const m = parsed.data;
  const category = ctx.categories.includes(m.category) ? m.category : "other";
  if (textsOf(m).some((t) => findRedactionIssues(t).length > 0)) return { result: { kind: "privacy" }, category };

  if (m.lineKey !== null && !ctx.index.lines.has(m.lineKey)) return { result: { kind: "reject", reason: "unknown_line" }, category };
  const evidence: EvidenceItem[] = [];
  for (const e of m.evidence) {
    const r = resolveEvidence(e.ref, e.amount, ctx.index);
    if (!r.ok) return { result: { kind: "reject", reason: r.reason }, category };
    evidence.push(r.item);
  }

  const { citation, anyVerified } = buildCitation(m, ctx);
  const message = clipText(m.message, 900);
  const action = clipText(m.recommendedAction, 500);

  // dollar-figure guard
  const evidenceAmounts = evidence.map((e) => e.amount).filter((a): a is number => a !== null);
  const own = numbersIn(m.sources.map((s) => s.quote ?? "").join(" "));
  const allowed: ReadonlySet<number>[] = [ctx.index.numbers, ctx.excerptNumbers, derivedAmounts(evidenceAmounts), own];
  const figureProblem = figuresIn(`${message} ${action}`).some((f) => !figureAllowed(f, allowed));

  let severity: Severity = m.severity;
  const original = severity;
  const lawUnverified = m.legalClaim && !anyVerified;
  // a serious finding that points at nothing in the return (no line, no document, no headline row) cannot be checked: unverified
  const noEvidenceGating = evidence.length === 0 && m.lineKey === null && isGatingSeverity(original);
  const unverified = lawUnverified || figureProblem || noEvidenceGating;
  if (severity === "blocker" && !(m.legalClaim && anyVerified && !figureProblem)) severity = "high";
  if (unverified && severityRank(severity) < severityRank("medium")) severity = "medium";
  const downgraded = severity !== original;
  const finalCitation: FindingCitation = unverified ? { sources: citation.sources, sourceStatus: "unverified" } : citation;
  const note = figureProblem
    ? " (a dollar figure in this finding is not in the return data or the quoted source)"
    : noEvidenceGating
      ? " (it does not point at a line or a document of the return)"
      : "";

  try {
    const finding = makeFinding({
      layer: "L3",
      check: `L3.${ctx.pass}.${category}`,
      severity,
      area: m.area,
      ...(m.form !== null ? { formKey: m.form } : {}),
      ...(m.lineKey !== null && isLineKey(m.lineKey) ? { lineKey: m.lineKey } : {}),
      ruleTag: evidence[0]?.ref ?? m.lineKey ?? "",
      message: `${message}${note}`.slice(0, 1200),
      evidence,
      citation: finalCitation,
      recommendedAction: action,
      acceptable: true,
      origin: "llm",
      pass: ctx.pass,
      ...(downgraded && (isGatingSeverity(original) || unverified) ? { downgradedFrom: original } : {}),
    });
    return { result: { kind: "ok", finding, unverified, downgraded }, category };
  } catch (err) {
    // an identifier-shaped string that slipped past the per-text scan (a joined value), or a malformed field
    if (err instanceof FindingError && /SSN-like|EIN-like|long digit/.test(err.message)) return { result: { kind: "privacy" }, category };
    return { result: { kind: "reject", reason: "invalid_finding" }, category };
  }
}

export function validateFindings(raw: readonly unknown[], ctx: ValidationContext): ValidationOutcome {
  const accepted: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  let unverified = 0;
  let downgraded = 0;
  let privacyDropped = 0;
  for (const r of raw) {
    const { result, category } = validateOne(r, ctx);
    if (result.kind === "ok") {
      accepted.push(result.finding);
      if (result.unverified) unverified += 1;
      if (result.downgraded) downgraded += 1;
    } else if (result.kind === "privacy") privacyDropped += 1;
    else rejected.push({ reason: result.reason, category });
  }
  return { accepted: dedupeFindings(accepted), rejected, unverified, downgraded, privacyDropped };
}

// ── challenges (adversarial pass) ─────────────────────────────────────────────

export interface Challenge {
  findingKey: string;
  note: string;
}

/** Challenges against known finding keys only; identifier-shaped text is dropped; one per key (the first). Annotation only. */
export function validateChallenges(raw: readonly unknown[], knownKeys: ReadonlySet<string>): Challenge[] {
  const out = new Map<string, Challenge>();
  for (const r of raw) {
    const p = modelChallengeSchema.safeParse(r);
    if (!p.success || !knownKeys.has(p.data.findingKey) || out.has(p.data.findingKey)) continue;
    if (findRedactionIssues(p.data.note).length > 0) continue;
    out.set(p.data.findingKey, { findingKey: p.data.findingKey, note: clipText(p.data.note, 400) });
  }
  return [...out.values()];
}

// ── register narration (task e2) ──────────────────────────────────────────────

export interface NarrationOutcome {
  entries: RegisterEntry[];
  narrated: number;
  rejected: number;
}

/**
 * Applies validated narrations to the deterministic register: only an existing entry id can be narrated; the text must be free of
 * identifier-shaped strings and of dollar figures that are not in the payload or the entry's own engine figures; sources are
 * verified like a finding's (an unverifiable quote is kept as an unverified source, never as verified). The dollar impact, the
 * status, the id, the topic and who decides are NEVER taken from the model.
 */
export function applyNarrations(entries: readonly RegisterEntry[], raw: readonly unknown[], ctx: Pick<ValidationContext, "index" | "pack" | "excerptNumbers">): NarrationOutcome {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const done = new Map<string, RegisterEntry>();
  let rejected = 0;
  for (const r of raw) {
    const p = modelNarrationSchema.safeParse(r);
    if (!p.success) {
      rejected += 1;
      continue;
    }
    const n = p.data;
    const base = byId.get(n.id);
    if (base === undefined || done.has(n.id)) {
      rejected += 1;
      continue;
    }
    const texts = [n.recommendedPosition, n.alternative ?? "", n.rationale ?? "", ...n.sources.flatMap((s) => [s.id, s.quote ?? ""])];
    if (texts.some((t) => findRedactionIssues(t).length > 0)) {
      rejected += 1;
      continue;
    }
    const impactFigures = new Set<number>(base.dollarImpact.amountDollars === null ? [] : [base.dollarImpact.amountDollars]);
    const allowed: ReadonlySet<number>[] = [ctx.index.numbers, ctx.excerptNumbers, impactFigures, numbersIn(base.recommendedPosition + " " + (base.alternative ?? "") + " " + base.dollarImpact.note)];
    if (figuresIn(texts.join(" ")).some((f) => !figureAllowed(f, allowed))) {
      rejected += 1;
      continue;
    }
    const sources: RegisterSource[] = [...base.sources];
    for (const s of n.sources) {
      if (s.kind === "constant" && (CONSTANTS as Record<string, unknown>)[s.id] !== undefined) sources.push({ kind: "constant", id: s.id, verified: true });
      else if (s.kind === "source_pack" && hasSource(ctx.pack, s.id)) {
        const ok = verifyQuote(ctx.pack, s.id, s.quote);
        sources.push({ kind: "source_pack", id: s.id, ...(ok && s.quote !== null ? { quote: s.quote } : {}), verified: ok });
      }
    }
    done.set(n.id, {
      ...base,
      recommendedPosition: clipText(n.recommendedPosition, 500),
      alternative: n.alternative === null ? base.alternative : clipText(n.alternative, 400),
      rationale: n.rationale === null ? base.rationale : clipText(n.rationale, 500),
      sources,
      narrated: true,
    });
  }
  return { entries: entries.map((e) => done.get(e.id) ?? e), narrated: done.size, rejected };
}
