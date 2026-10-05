// The approval gate (plan sections 5.5.6 and 5.7), computed by CODE from findings, dispositions and the engine state.
// Nothing a model returns can change it: an LLM finding can only ADD to the open list (it cannot close anything), and
// the verdict "AI review: PASSED" is derived here, never stated by a model.
//
// Owner decisions built in (2026-10-04):
//   D1  a LINE override in force keeps the gate red (the engine does not recompute dependents).
//   D2  an LLM finding that was downgraded from blocker/high because it could not be sourced still needs an
//       acknowledgement (an "accepted" disposition with a written reason) before the gate turns green.
//   D5  the attestation is Eric's, by his account only, text v1 (ATTESTATION_V1_TEXT).
//   D8  there is NO waiver: a layer that has not run (not_run / partial / failed) keeps the gate red, so approval is
//       impossible until L2 and L3 have run for the CURRENT fingerprint.
//
// PURE: no DB, no network, no clock (timestamps arrive as data).

import { REASON_MAX, REASON_MIN, TYPED_PHRASE } from "@/lib/tax-review/limits";
import { sha256Hex, isGatingSeverity, type Finding, type ReviewLayer, type Severity } from "@/lib/tax-review/types";

export { REASON_MAX, REASON_MIN, TYPED_PHRASE };

// ── Dispositions ──────────────────────────────────────────────────────────────


export interface DispositionRow {
  findingKey: string;
  evidenceHash: string;
  action: "accepted" | "reopened";
  reason: string;
  /** ISO string or Date; the latest wins, ties go to the later array position. */
  at: Date | string;
}

function time(at: Date | string): number {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

/** The latest disposition for this exact finding state, or null. A changed evidence hash means no disposition applies. */
export function dispositionFor(finding: Pick<Finding, "key" | "evidenceHash">, dispositions: readonly DispositionRow[]): DispositionRow | null {
  let best: DispositionRow | null = null;
  let bestTime = -Infinity;
  for (const d of dispositions) {
    if (d.findingKey !== finding.key || d.evidenceHash !== finding.evidenceHash) continue;
    const t = time(d.at);
    if (t >= bestTime) {
      best = d;
      bestTime = t;
    }
  }
  return best;
}

/** Check id prefix of the L1 finding that says a decision is still at its default alternative (l1/engine-state.ts). */
export const DEFAULT_DECISION_CHECK = "L1.D2.decision";

export type FindingStatus = "open" | "accepted";

/** accepted only for an acceptable finding whose latest disposition is "accepted" with a written reason. */
export function findingStatus(finding: Pick<Finding, "key" | "evidenceHash" | "acceptable">, dispositions: readonly DispositionRow[]): FindingStatus {
  if (!finding.acceptable) return "open";
  const d = dispositionFor(finding, dispositions);
  if (d === null || d.action !== "accepted") return "open";
  return d.reason.trim().length >= REASON_MIN ? "accepted" : "open";
}

/** Gates the approval while open: blocker / high, and an unverified LLM finding that was downgraded from one of them (D2). */
export function isGatingFinding(f: Pick<Finding, "severity" | "downgradedFrom" | "citation"> & { check?: string }): boolean {
  if (isGatingSeverity(f.severity)) return true;
  // Owner decision (2026-10-04): a decision still at its DEFAULT alternative (X1, X3, X5 and any future one) gates approval until the owner
  // records the decision (the finding disappears with the new return state) or accepts the default with a written reason.
  if (f.check !== undefined && f.check.startsWith(DEFAULT_DECISION_CHECK)) return true;
  return f.downgradedFrom !== undefined && isGatingSeverity(f.downgradedFrom) && f.citation.sourceStatus === "unverified";
}

// ── The gate ──────────────────────────────────────────────────────────────────

export type LayerRunState = "not_run" | "partial" | "completed" | "failed";

export interface GateEngineState {
  /** headline.complete of the EFFECTIVE return. */
  complete: boolean;
  blockingItemCount: number;
  /** Active LINE overrides (D1). */
  lineOverrideCount: number;
  staleOverrideCount: number;
}

export interface GateInput {
  /** Fingerprint the run is bound to; null = there is no run for this return. */
  runFingerprint: string | null;
  /** Recomputed now from the live inputs. */
  currentFingerprint: string;
  engine: GateEngineState;
  /** Every finding of the run (all layers). */
  findings: readonly Finding[];
  dispositions: readonly DispositionRow[];
  l1: { status: LayerRunState };
  l2: { status: LayerRunState; coverageListed: boolean };
  l3: { status: LayerRunState; adversarialCompleted: boolean };
}

export const GATE_ITEM_IDS = ["fingerprint", "engine", "l1", "l2", "l3", "verdict"] as const;
export type GateItemId = (typeof GATE_ITEM_IDS)[number];

export type GateItemState = "pass" | "fail" | "not_run";

export interface GateItem {
  id: GateItemId;
  label: string;
  state: GateItemState;
  /** Counts only; never a value. */
  detail: string;
  /** Open gating items behind a failing state. */
  openCount: number;
}

export type Verdict = "passed" | "flagged";

export interface OpenGatingFinding {
  key: string;
  layer: ReviewLayer;
  check: string;
  severity: Severity;
  acceptable: boolean;
}

export interface GateResult {
  items: GateItem[];
  /** "AI review: PASSED" only when every item before "verdict" is green; computed here, never by a model. */
  verdict: Verdict;
  openGating: OpenGatingFinding[];
  /** Counts of open findings per layer and severity band (for the banner). */
  openByLayer: Record<ReviewLayer, { gating: number; other: number }>;
}

function openFindings(findings: readonly Finding[], dispositions: readonly DispositionRow[], layer: ReviewLayer): Finding[] {
  return findings.filter((f) => f.layer === layer && findingStatus(f, dispositions) === "open");
}

function layerItem(
  id: "l1" | "l2" | "l3",
  label: string,
  run: LayerRunState,
  findings: readonly Finding[],
  dispositions: readonly DispositionRow[],
  layer: ReviewLayer,
  extraNotReady: string | null
): GateItem {
  const open = openFindings(findings, dispositions, layer).filter((f) => isGatingFinding(f) || !f.acceptable);
  if (run === "not_run") return { id, label, state: "not_run", detail: "not run for this return state", openCount: 0 };
  if (run === "partial") return { id, label, state: "fail", detail: "not finished: some checks have not completed", openCount: open.length };
  if (run === "failed") return { id, label, state: "fail", detail: "a check failed to run (the gate fails closed)", openCount: open.length };
  if (extraNotReady !== null) return { id, label, state: "fail", detail: extraNotReady, openCount: open.length };
  if (open.length > 0) return { id, label, state: "fail", detail: `${open.length} open item(s) that block approval`, openCount: open.length };
  return { id, label, state: "pass", detail: "nothing open that blocks approval", openCount: 0 };
}

export function evaluateGate(input: GateInput): GateResult {
  const items: GateItem[] = [];

  // 1. fingerprint
  if (input.runFingerprint === null) {
    items.push({ id: "fingerprint", label: "A review run exists for this return", state: "not_run", detail: "no review has been run yet", openCount: 0 });
  } else if (input.runFingerprint !== input.currentFingerprint) {
    items.push({ id: "fingerprint", label: "The review matches the current return", state: "fail", detail: "the return changed after this review (stale)", openCount: 0 });
  } else {
    items.push({ id: "fingerprint", label: "The review matches the current return", state: "pass", detail: "unchanged since the review", openCount: 0 });
  }

  // 2. engine state (D1: no line override in force)
  const e = input.engine;
  const engineProblems: string[] = [];
  if (!e.complete) engineProblems.push("the return is not complete");
  if (e.blockingItemCount > 0) engineProblems.push(`${e.blockingItemCount} blocking item(s)`);
  if (e.lineOverrideCount > 0) engineProblems.push(`${e.lineOverrideCount} line override(s) in force`);
  if (e.staleOverrideCount > 0) engineProblems.push(`${e.staleOverrideCount} stale override(s)`);
  items.push(
    engineProblems.length === 0
      ? { id: "engine", label: "The return is complete with nothing blocking", state: "pass", detail: "complete, no blocking items, no line override", openCount: 0 }
      : { id: "engine", label: "The return is complete with nothing blocking", state: "fail", detail: engineProblems.join("; "), openCount: e.blockingItemCount }
  );

  // 3-5. layers
  items.push(layerItem("l1", "Deterministic checks (footing, forms, documents)", input.l1.status, input.findings, input.dispositions, "L1", null));
  items.push(
    layerItem("l2", "Independent recomputation", input.l2.status, input.findings, input.dispositions, "L2", input.l2.status === "completed" && !input.l2.coverageListed ? "the list of what was recomputed is missing" : null)
  );
  items.push(
    layerItem("l3", "AI review passes", input.l3.status, input.findings, input.dispositions, "L3", input.l3.status === "completed" && !input.l3.adversarialCompleted ? "the adversarial pass has not completed" : null)
  );

  // 6. verdict: derived, never stated by a model
  const allGreen = items.every((i) => i.state === "pass");
  items.push({
    id: "verdict",
    label: "AI review verdict",
    state: allGreen ? "pass" : "fail",
    detail: allGreen ? "AI review: PASSED for this return state" : "AI review: FLAGGED",
    openCount: 0,
  });

  const openGating: OpenGatingFinding[] = input.findings
    .filter((f) => findingStatus(f, input.dispositions) === "open" && (isGatingFinding(f) || !f.acceptable))
    .map((f) => ({ key: f.key, layer: f.layer, check: f.check, severity: f.severity, acceptable: f.acceptable }));
  const openByLayer: GateResult["openByLayer"] = { L1: { gating: 0, other: 0 }, L2: { gating: 0, other: 0 }, L3: { gating: 0, other: 0 } };
  for (const f of input.findings) {
    if (findingStatus(f, input.dispositions) !== "open") continue;
    openByLayer[f.layer][isGatingFinding(f) || !f.acceptable ? "gating" : "other"] += 1;
  }
  return { items, verdict: allGreen ? "passed" : "flagged", openGating, openByLayer };
}

/** Counts-only snapshot stored on the approval row (no finding text, no value). */
export function gateSnapshot(gate: GateResult): { verdict: Verdict; items: { id: GateItemId; state: GateItemState; openCount: number }[]; openGating: number } {
  return {
    verdict: gate.verdict,
    items: gate.items.map((i) => ({ id: i.id, state: i.state, openCount: i.openCount })),
    openGating: gate.openGating.length,
  };
}

// ── Owner attestation (decision D5) ───────────────────────────────────────────

export const ATTESTATION_VERSION = "v1";

/** Text v1, exactly as the plan (5.7) words it. Changing a word is a new version, never an edit of v1. */
export const ATTESTATION_V1_TEXT =
  "I, Eric Kinniburgh, prepared this 2025 federal and Connecticut income tax return myself. I have reviewed every figure and every decision recorded in the Final review, I understand the AI review is an automated aid and not a professional opinion, and I take full responsibility for the return as its preparer.";


export function attestationTextHash(text: string = ATTESTATION_V1_TEXT): string {
  return sha256Hex(text);
}

function norm(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Hash of the typed phrase + typed name as the owner entered them (normalised), so the record proves what was typed without storing it. */
export function typedConfirmationHash(phrase: string, name: string): string {
  return sha256Hex(`${norm(phrase)}|${norm(name)}`);
}

export interface ApprovalAttempt {
  /** The ticked box. */
  checked: boolean;
  /** The attestation text the client displayed (must be v1 verbatim). */
  attestationText: string;
  typedPhrase: string;
  typedName: string;
}

export interface ApprovalContext {
  /** The owner's full name as recorded on his account (compared case-insensitively). */
  approverName: string;
  /** The signed-in account is the one allowed to approve (D5: Eric's account only). Decided by the caller from the session. */
  approverAllowed: boolean;
}

export interface ApprovalDecision {
  ok: boolean;
  /** Plain-language reasons the approval is refused (empty when ok). */
  reasons: string[];
}

/** Server-side check: the gate must be PASSED and every attestation condition met. The client's own view of the gate is never used. */
export function evaluateApproval(gate: GateResult, attempt: ApprovalAttempt, ctx: ApprovalContext): ApprovalDecision {
  const reasons: string[] = [];
  if (gate.verdict !== "passed") reasons.push("The review is not PASSED for the current return, so it cannot be approved.");
  if (!ctx.approverAllowed) reasons.push("Only the owner's own account can record the approval.");
  if (!attempt.checked) reasons.push("Tick the box to confirm you prepared the return.");
  if (attempt.attestationText !== ATTESTATION_V1_TEXT) reasons.push("The confirmation text shown is out of date; reload the page.");
  if (attempt.typedPhrase.trim() !== TYPED_PHRASE) reasons.push(`Type exactly: ${TYPED_PHRASE}`);
  if (norm(attempt.typedName) !== norm(ctx.approverName) || norm(ctx.approverName) === "") reasons.push("Type your full name as it appears on your account.");
  return { ok: reasons.length === 0, reasons };
}

// ── Current approval ──────────────────────────────────────────────────────────

export interface ApprovalRow {
  kind: "approved" | "withdrawn";
  fingerprint: string;
  at: Date | string;
  runId?: string;
}

/**
 * The approval that is the latest word, whatever return it is bound to: walk the rows oldest first; an "approved" row sets it, a
 * "withdrawn" row clears it. (Withdrawing must work on a stale approval too, so it looks here and not at currentApproval.)
 */
export function approvalInForce<T extends ApprovalRow>(rows: readonly T[]): T | null {
  const ordered = rows.map((r, i) => ({ r, i, t: time(r.at) })).sort((a, b) => a.t - b.t || a.i - b.i);
  let state: T | null = null;
  for (const { r } of ordered) {
    if (r.kind === "approved") state = r;
    else state = null;
  }
  return state;
}

/**
 * The approval that is in force AND counts for this return: its fingerprint must equal the CURRENT return fingerprint (any later
 * change makes it non-current without deleting it).
 */
export function currentApproval<T extends ApprovalRow>(rows: readonly T[], currentFingerprint: string): T | null {
  const state = approvalInForce(rows);
  return state !== null && state.fingerprint === currentFingerprint ? state : null;
}
