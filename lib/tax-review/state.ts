// The Final review state (ai-return-reviewer, A6): everything the page and the server actions need, computed by PURE code from
// rows already read (the latest run and its findings, the dispositions, the approvals) and the CURRENT return fingerprint and
// engine state, which the caller recomputed server-side. The gate is evaluateGate (gate.ts); nothing here is stated by a model
// and nothing arrives from a client. The output is JSON-safe (no Date) and holds only what the owner may see: findings (already
// redacted by construction), counts, short fingerprints; never the facts, the raw documents or the full fingerprint.

import { approvalInForce, approvalRevocationReasons, currentApproval, evaluateGate, findingStatus, isGatingFinding, type ApprovalRevocationFacts, type ApprovalRow, type DispositionRow, type GateEngineState, type GateInput, type GateResult, type LayerRunState } from "@/lib/tax-review/gate";
import type { ApproverResolution } from "@/lib/tax-review/approver";
import { countBySeverity, SEVERITIES, type EvidenceItem, type Finding, type FindingCitation, type ReviewLayer, type Severity } from "@/lib/tax-review/types";
import { emptyProgress, l3GateState, type AiReviewProgress, type AiRunStatus, type TaskProgress } from "@/lib/tax-review/llm/progress";
import type { RegisterEntry } from "@/lib/tax-review/llm/register";

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
  /** The AI review passes' state for this run (derived from its events by lib/tax-review/llm/progress.ts); absent = never run. */
  l3?: { status: LayerRunState; adversarialCompleted: boolean };
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
    // L3 (the AI review passes): only a state derived from the stored events counts; no event = not run, which keeps the gate red
    // (there is no waiver). A run for an older return is already red through the fingerprint item.
    l3: run === null || args.l3 === undefined ? { status: "not_run", adversarialCompleted: false } : args.l3,
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
  /** The adversarial pass's note against this finding (annotation only: it never closes or changes the finding). */
  challenge?: string | null;
}

/** What the page shows of an AI review (counts, task states, tokens and an estimate; never the payload or a model's text). */
export interface AiReviewDto {
  status: AiRunStatus;
  model: string | null;
  promptVersion: string | null;
  completedCount: number;
  /** Of completedCount: tasks copied from an earlier review of the same return (nothing was sent for them, they cost nothing here). */
  reusedCount: number;
  totalCount: number;
  tasks: { id: string; pass: string; title: string; state: TaskProgress["state"]; attempts: number; failures: number; inputTokens: number; outputTokens: number; errorKind: string | null; findingCount: number; rejectedCount: number; unverifiedCount: number; reused: boolean; cutoffRetries: number }[];
  inputTokens: number;
  outputTokens: number;
  costUsdSoFar: number | null;
  estimate: { expectedUsd: number; worstCaseUsd: number; inputTokens: number; outputTokens: number; warn: boolean; warnThresholdUsd: number; priceSource: "env" | "default_upper_bound"; inPerMtok: number; outPerMtok: number; model: string } | null;
  nextTask: string | null;
  busy: boolean;
}

/** The cost estimate shown BEFORE an AI review starts (nothing is sent until the owner confirms it). */
export interface AiEstimateDto {
  model: string;
  inputTokens: number;
  outputTokens: number;
  expectedUsd: number;
  worstCaseUsd: number;
  /** The absolute ceiling including one retry of every cut-off answer at a larger limit (shown next to the worst case). */
  maxWithRetryUsd: number;
  warn: boolean;
  warnThresholdUsd: number;
  priceSource: "env" | "default_upper_bound";
  inPerMtok: number;
  outPerMtok: number;
  payloadBytes: number;
  /** Requests that will be sent (the tasks that are not reused). */
  requests: number;
  /** Finished tasks of an earlier failed / cancelled review of this same return that are copied, not sent again (no cost). */
  reusedTaskIds: string[];
  tasks: { id: string; inputTokens: number; outputTokens: number; reused: boolean }[];
  /** An AI review already exists for this run (it can be resumed, not started again). */
  alreadyStarted: boolean;
  runId: string;
}

export function toAiDto(p: AiReviewProgress): AiReviewDto {
  return {
    status: p.status,
    model: p.model,
    promptVersion: p.promptVersion,
    completedCount: p.completedCount,
    reusedCount: p.reusedCount,
    totalCount: p.totalCount,
    tasks: p.tasks.map((t) => ({ id: t.id, pass: t.pass, title: t.title, state: t.state, attempts: t.attempts, failures: t.failures, inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, errorKind: t.error?.kind ?? null, findingCount: t.findingCount, rejectedCount: t.rejectedCount, unverifiedCount: t.unverifiedCount, reused: t.reused, cutoffRetries: t.cutoffRetries })),
    inputTokens: p.usage.inputTokens,
    outputTokens: p.usage.outputTokens,
    costUsdSoFar: p.costUsdSoFar,
    estimate:
      p.estimate === null
        ? null
        : { expectedUsd: p.estimate.expectedUsd, worstCaseUsd: p.estimate.worstCaseUsd, inputTokens: p.estimate.inputTokens, outputTokens: p.estimate.outputTokens, warn: p.estimate.warn, warnThresholdUsd: p.estimate.warnThresholdUsd, priceSource: p.estimate.price.source, inPerMtok: p.estimate.price.inPerMtok, outPerMtok: p.estimate.price.outPerMtok, model: p.estimate.model },
    nextTask: p.nextTask,
    busy: p.busy,
  };
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
  /** In force AND for exactly the current return AND not revoked since (a reopened finding, a new open blocking finding, a cancelled AI review). */
  current: boolean;
  /** Why an approval for exactly the current return no longer counts (empty / absent when it does, or when none exists). */
  revokedReasons?: string[];
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
  /** The AI review passes of the run the gate looks at (status "not_run" when none started). */
  ai: AiReviewDto;
  /** The judgments register: the AI-narrated wording when that task completed, else the engine's own text. */
  register: RegisterEntry[];
  registerNarrated: boolean;
  /** The engine's decisions and whether each is recorded (id and status only): the "To do by hand" list drops the lines a recorded decision prints. */
  /** null = the decisions were not supplied (the "To do by hand" list then shows everything). */
  decisions: { id: string; status: "decided" | "default_undecided" }[] | null;
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

export function toFindingDto(f: Finding, dispositions: readonly DispositionDetail[], challenge: string | null = null): FindingDto {
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
    challenge: challenge ?? f.challenge ?? null,
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
  /** The AI review of the run in `latest` (folded from its events); absent = none. */
  ai?: AiReviewProgress | null;
  /** The engine's own register for the current return (shown when no narrated one exists). */
  register?: readonly RegisterEntry[];
  /** The engine's decisions (id and status) for the current return; absent = none known. */
  decisions?: readonly { id: string; status: "decided" | "default_undecided" }[];
  /**
   * What an approval is re-checked against (lib/tax-review-approval-facts.ts readRevocationFacts: the same facts the clean-copy routes use).
   * Absent: derived from `latest` and `dispositions` (no cancellation times), for callers that build the state by hand.
   */
  revocation?: ApprovalRevocationFacts;
}

export function buildReviewState(input: ReviewStateInput): ReviewStateDto {
  const run = input.latest?.run ?? null;
  const findings = input.latest?.findings ?? [];
  const ai = run === null ? emptyProgress() : input.ai ?? emptyProgress();
  const gate = evaluateGate(gateInputFor({ run, findings, dispositions: input.dispositions, currentFingerprint: input.currentFingerprint, engine: input.engine, l3: l3GateState(ai) }));
  const challengeOf = new Map(ai.challenges.map((c) => [c.findingKey, c.note]));
  const dtos = findings.map((f) => toFindingDto(f, input.dispositions, challengeOf.get(f.key) ?? null));
  // the latest word: an approved row not followed by a withdrawal (any fingerprint)
  const inForceRows = approvalInForce(input.approvals);
  const revocation: ApprovalRevocationFacts =
    input.revocation ?? { findings: run !== null && run.fingerprint === input.currentFingerprint ? findings : [], dispositions: input.dispositions, aiCancelledAt: [] };
  const current = currentApproval(input.approvals, input.currentFingerprint, revocation);
  const revokedReasons = inForceRows !== null && inForceRows.fingerprint === input.currentFingerprint ? approvalRevocationReasons(inForceRows, revocation) : [];
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
      ...(revokedReasons.length > 0 ? { revokedReasons } : {}),
      approvedByName: (current ?? inForceRows)?.approvedByName ?? null,
      at: (current ?? inForceRows) === null ? null : iso((current ?? inForceRows)!.at),
      fingerprint12: (current ?? inForceRows) === null ? null : short12((current ?? inForceRows)!.fingerprint),
    },
    approver: { allowed: input.approver.allowed, reason: input.approver.reason },
    notRunNotice: l2l3Red ? NOT_RUN_NOTICE : null,
    canApproveNow: gate.verdict === "passed" && input.approver.allowed,
    ai: toAiDto(ai),
    register: [...(ai.narratedRegister ?? input.register ?? [])],
    registerNarrated: ai.narratedRegister !== null,
    decisions: input.decisions === undefined ? null : input.decisions.map((d) => ({ id: d.id, status: d.status })),
  };
}

/** Counts of findings by severity (re-export for the page chips). */
export function severityCounts(findings: readonly Pick<FindingDto, "severity">[]): Record<Severity, number> {
  return countBySeverity(findings);
}
