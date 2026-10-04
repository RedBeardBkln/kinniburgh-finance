// The Final review state (ai-return-reviewer, A6): everything the page and the server actions need, computed by PURE code from
// rows already read (the latest run and its findings, the dispositions, the approvals) and the CURRENT return fingerprint and
// engine state, which the caller recomputed server-side. The gate is evaluateGate (gate.ts); nothing here is stated by a model
// and nothing arrives from a client. The output is JSON-safe (no Date) and holds only what the owner may see: findings (already
// redacted by construction), counts, short fingerprints; never the facts, the raw documents or the full fingerprint.

import { approvalInForce, currentApproval, evaluateGate, findingStatus, isGatingFinding, type ApprovalRow, type DispositionRow, type GateEngineState, type GateInput, type GateResult, type LayerRunState } from "@/lib/tax-review/gate";
import type { ApproverResolution } from "@/lib/tax-review/approver";
import { countBySeverity, SEVERITIES, type EvidenceItem, type Finding, type FindingCitation, type ReviewLayer, type Severity } from "@/lib/tax-review/types";

/** Said plainly on the page while a layer has not run: there is no waiver (owner decision D8). */
export const NOT_RUN_NOTICE = "Independent recalculation and AI review passes not run yet: required before approval.";

export const SUPPORTED_REVIEW_YEAR = 2025 as const;

export interface RunRowLike {
  id: string;
  fingerprint: string;
  engineVersion: string;
  startedAt: Date | string;
  startedByName: string;
  l1Summary: unknown;
  l2Summary: unknown;
}

export interface DispositionDetail extends DispositionRow {
  byName: string;
}

export interface ApprovalDetail extends ApprovalRow {
  id: string;
  approvedByName: string;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
export const short12 = (fingerprint: string): string => fingerprint.slice(0, 12);

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** L1's state from the stored summary: only an explicit "completed" counts; anything else fails closed. */
export function l1StateOf(l1Summary: unknown): LayerRunState {
  return obj(l1Summary)?.["status"] === "completed" ? "completed" : "failed";
}

/** L2 / L3 are not built at this phase: whatever the stored summary says, only an explicit state is believed, else not_run. */
export function layerStateOf(summary: unknown): LayerRunState {
  const s = obj(summary)?.["status"];
  return s === "completed" || s === "partial" || s === "failed" ? s : "not_run";
}

/** The run the gate looks at: the newest run made for the CURRENT return fingerprint, else the newest run (stale), else null. `runs` is newest first. */
export function pickRun<T extends Pick<RunRowLike, "fingerprint">>(runs: readonly T[], currentFingerprint: string): T | null {
  return runs.find((r) => r.fingerprint === currentFingerprint) ?? runs[0] ?? null;
}

/** The gate's input for the latest run (null run = no review has been run). */
export function gateInputFor(args: {
  run: RunRowLike | null;
  findings: readonly Finding[];
  dispositions: readonly DispositionRow[];
  currentFingerprint: string;
  engine: GateEngineState;
}): GateInput {
  const { run } = args;
  const l2 = run === null ? "not_run" : layerStateOf(run.l2Summary);
  const coverage = obj(run?.l2Summary)?.["coverage"];
  return {
    runFingerprint: run?.fingerprint ?? null,
    currentFingerprint: args.currentFingerprint,
    engine: args.engine,
    findings: args.findings,
    dispositions: args.dispositions,
    l1: { status: run === null ? "not_run" : l1StateOf(run.l1Summary) },
    l2: { status: l2, coverageListed: Array.isArray(coverage) && coverage.length > 0 },
    // L3 (the AI review passes) is Phase B: never run here, so the gate stays red and approval is impossible
    l3: { status: "not_run", adversarialCompleted: false },
  };
}

export interface FindingDto {
  key: string;
  evidenceHash: string;
  layer: ReviewLayer;
  check: string;
  severity: Severity;
  area: Finding["area"];
  formKey: string | null;
  lineKey: string | null;
  message: string;
  evidence: EvidenceItem[];
  citation: FindingCitation;
  recommendedAction: string;
  acceptable: boolean;
  status: "open" | "accepted";
  /** An open finding that keeps approval blocked (blocker/high, or an unverified downgraded one, or one that cannot be accepted). */
  gating: boolean;
  acceptedReason: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
}

export interface RunDto {
  id: string;
  startedAt: string;
  startedByName: string;
  fingerprint12: string;
  /** Equals the return as it is now. */
  isCurrent: boolean;
  engineVersion: string;
  counts: Record<Severity, number> | null;
  l1Status: LayerRunState;
}

export interface ApprovalDto {
  /** An approval row is the latest word (approved and not withdrawn), whatever fingerprint it is bound to. */
  inForce: boolean;
  /** In force AND for exactly the current return. */
  current: boolean;
  approvedByName: string | null;
  at: string | null;
  fingerprint12: string | null;
}

export interface ReviewStateDto {
  year: typeof SUPPORTED_REVIEW_YEAR;
  currentFingerprint12: string;
  latestRun: RunDto | null;
  /** A run exists but the return changed after it. */
  runIsStale: boolean;
  gate: GateResult;
  /** Findings of the latest run only (an older run is read through its own listing). */
  findings: FindingDto[];
  totals: { findings: number; open: number; accepted: number; gatingOpen: number };
  runs: RunDto[];
  approval: ApprovalDto;
  approver: { allowed: boolean; reason: string | null };
  /** Plain statement shown while L2 / L3 have not run (empty when both ran). */
  notRunNotice: string | null;
  /** Approval can be recorded right now (the gate is green and the signed-in account is the owner's); the server re-checks everything. */
  canApproveNow: boolean;
}

export function toRunDto(run: RunRowLike, currentFingerprint: string): RunDto {
  const counts = obj(run.l1Summary)?.["counts"];
  const c = obj(counts);
  let parsed: Record<Severity, number> | null = null;
  if (c !== null) {
    parsed = { blocker: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const s of SEVERITIES) {
      const n = c[s];
      parsed[s] = typeof n === "number" && Number.isFinite(n) ? n : 0;
    }
  }
  return {
    id: run.id,
    startedAt: iso(run.startedAt),
    startedByName: run.startedByName,
    fingerprint12: short12(run.fingerprint),
    isCurrent: run.fingerprint === currentFingerprint,
    engineVersion: run.engineVersion,
    counts: parsed,
    l1Status: l1StateOf(run.l1Summary),
  };
}

export function toFindingDto(f: Finding, dispositions: readonly DispositionDetail[]): FindingDto {
  const status = findingStatus(f, dispositions);
  let acceptedReason: string | null = null;
  let acceptedBy: string | null = null;
  let acceptedAt: string | null = null;
  if (status === "accepted") {
    // the latest "accepted" disposition for this exact finding state (the one findingStatus used)
    const hit = [...dispositions]
      .filter((d) => d.findingKey === f.key && d.evidenceHash === f.evidenceHash)
      .sort((a, b) => Date.parse(iso(a.at)) - Date.parse(iso(b.at)))
      .pop();
    if (hit !== undefined) {
      acceptedReason = hit.reason;
      acceptedBy = hit.byName;
      acceptedAt = iso(hit.at);
    }
  }
  return {
    key: f.key,
    evidenceHash: f.evidenceHash,
    layer: f.layer,
    check: f.check,
    severity: f.severity,
    area: f.area,
    formKey: f.formKey ?? null,
    lineKey: f.lineKey ?? null,
    message: f.message,
    evidence: f.evidence,
    citation: f.citation,
    recommendedAction: f.recommendedAction,
    acceptable: f.acceptable,
    status,
    gating: status === "open" && (isGatingFinding(f) || !f.acceptable),
    acceptedReason,
    acceptedBy,
    acceptedAt,
  };
}

export interface ReviewStateInput {
  currentFingerprint: string;
  engine: GateEngineState;
  latest: { run: RunRowLike; findings: readonly Finding[] } | null;
  runs: readonly RunRowLike[];
  dispositions: readonly DispositionDetail[];
  approvals: readonly ApprovalDetail[];
  approver: ApproverResolution;
}

export function buildReviewState(input: ReviewStateInput): ReviewStateDto {
  const run = input.latest?.run ?? null;
  const findings = input.latest?.findings ?? [];
  const gate = evaluateGate(gateInputFor({ run, findings, dispositions: input.dispositions, currentFingerprint: input.currentFingerprint, engine: input.engine }));
  const dtos = findings.map((f) => toFindingDto(f, input.dispositions));
  // the latest word: an approved row not followed by a withdrawal (any fingerprint)
  const inForceRows = approvalInForce(input.approvals);
  const current = currentApproval(input.approvals, input.currentFingerprint);
  const l2l3Red = gate.items.some((i) => (i.id === "l2" || i.id === "l3") && i.state === "not_run");
  return {
    year: SUPPORTED_REVIEW_YEAR,
    currentFingerprint12: short12(input.currentFingerprint),
    latestRun: run === null ? null : toRunDto(run, input.currentFingerprint),
    runIsStale: run !== null && run.fingerprint !== input.currentFingerprint,
    gate,
    findings: dtos,
    totals: {
      findings: dtos.length,
      open: dtos.filter((d) => d.status === "open").length,
      accepted: dtos.filter((d) => d.status === "accepted").length,
      gatingOpen: dtos.filter((d) => d.gating).length,
    },
    runs: input.runs.map((r) => toRunDto(r, input.currentFingerprint)),
    approval: {
      inForce: inForceRows !== null,
      current: current !== null,
      approvedByName: (current ?? inForceRows)?.approvedByName ?? null,
      at: (current ?? inForceRows) === null ? null : iso((current ?? inForceRows)!.at),
      fingerprint12: (current ?? inForceRows) === null ? null : short12((current ?? inForceRows)!.fingerprint),
    },
    approver: { allowed: input.approver.allowed, reason: input.approver.reason },
    notRunNotice: l2l3Red ? NOT_RUN_NOTICE : null,
    canApproveNow: gate.verdict === "passed" && input.approver.allowed,
  };
}

/** Counts of findings by severity (re-export for the page chips). */
export function severityCounts(findings: readonly Pick<FindingDto, "severity">[]): Record<Severity, number> {
  return countBySeverity(findings);
}
