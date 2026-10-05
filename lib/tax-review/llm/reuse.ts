// Reuse of finished AI review tasks (ai-token-budget): a new AI review of the SAME return does not pay again for the tasks an earlier,
// failed or cancelled review of that return already finished.
//
// A finished task of the earlier run is copied into the new run only when EVERYTHING that decided its result is the same:
//   - the run belongs to the same return state (fingerprint) and the same model,
//   - the same pinned source pack,
//   - the task asked the same thing (taskContentHash: system prompt, instruction, categories and output schema),
//   - the exact request would be the same: the instruction + the task's slice of the redacted payload + the source excerpt, built from
//     the EARLIER run's stored payload and from the NEW payload, must be identical text,
//   - every copied finding passes the code checks again against the NEW payload (shape, layer / origin / acceptable, evidence lines and
//     amounts exist, no identifier-shaped text).
// Anything else (a different fingerprint, prompt, model, pack or input; a finding that fails the re-check; a task that never finished)
// means the task is simply sent again. The adversarial pass (f1) is never copied: it reads every other finding, so it is always run.
//
// Copying is INSERT-ONLY: new events (`done:<task>`, marked `reused` with the run they came from) and new finding rows in the new
// run; nothing of the earlier run is touched. A reused task counts as done for the gate exactly like a task that ran, because it is a
// valid result for the current fingerprint. The model can still only ADD findings; nothing here closes, accepts or re-ranks anything.
//
// PURE (the DB reads are in lib/tax-review-l3.ts).

import { findRedactionIssues } from "@/lib/tax-review/redact";
import { foldProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { indexPayload, type PayloadIndex, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import type { RegisterEntry } from "@/lib/tax-review/llm/register";
import type { RunEstimate } from "@/lib/tax-review/llm/model";
import { buildPrompt, estimateAiRun, type NewRunEvent, type StoredFinding } from "@/lib/tax-review/llm/run";
import { sourcePackDigestInput, type SourcePack } from "@/lib/tax-review/llm/sources";
import { taskContentHash, TASKS, type TaskDef, type TaskId } from "@/lib/tax-review/llm/tasks";
import { resolveEvidence } from "@/lib/tax-review/llm/validate";
import { dedupeFindings, findingSchema, sha256Hex, type Finding } from "@/lib/tax-review/types";

/**
 * Runs made before task events carried a `contentHash` (prompt version l3-prompts-1, the first live run of 2026-10-05) stored only
 * `sha256(<task>|<run prompt hash>)`. For THAT prompt hash, the content hash of a task whose text is unchanged since then is pinned here
 * (computed from the l3-prompts-1 code). A task whose text was edited later no longer matches its pinned hash, so it is not reused.
 */
export const LEGACY_PROMPTS_1: { runPromptHash: string; contentHashes: Readonly<Record<string, string>> } = {
  runPromptHash: "d17eeaa34b8e7b5a585e8e8adabb012a5f060faf9972f88fc005fb97c851d1cb",
  contentHashes: {
    a1: "f98c448d61acea21203bc8b51e76326b0f4be0b3abeb7730971589529c921f1a",
    a2: "90a0cbd3093299be8db7277ec0009490b80f97bd1a234c206d3a1666231f9e5b",
    b1: "85c5a5297713fe5c39d5f674d90671af3ea7a9c1a730742fe4006590be00ef39",
    b2: "6cf6b65acdbe9c52be6b4a05e3fc7eb979a260dc054ec393ce9953b94ebf997e",
    b3: "5561911d9c7ea5a5db9ea2cd995dc5988110dc8256bdbfede9b93be7f8d7cdf5",
  },
};

export type ReuseReason =
  | "no_earlier_review"
  | "fingerprint_differs"
  | "model_differs"
  | "source_pack_differs"
  | "earlier_payload_missing"
  | "adversarial_pass"
  | "not_finished"
  | "prompt_differs"
  | "input_differs"
  | "findings_missing"
  | "findings_invalid";

export interface ReuseSource {
  runId: string;
  /** Fingerprint of the return the earlier run was made for. */
  fingerprint: string;
  events: readonly RunEvent[];
  /** The earlier run's L3 finding rows as stored, with the time each was stored. */
  findingRows: readonly StoredFinding[];
}

export interface ReuseTarget {
  runId: string;
  /** Fingerprint of the return as it is now. */
  fingerprint: string;
  model: string;
  /** The redacted payload the new run will send (the same object startAiRun stores). */
  payload: ReviewPayload;
  /** The deterministic register the new run stores. */
  register: readonly RegisterEntry[];
  pack: SourcePack;
}

export interface TaskReuse {
  taskId: TaskId;
  reused: boolean;
  /** Why the task is sent again; null when it is reused. */
  reason: ReuseReason | null;
  findingCount: number;
}

export interface ReusePlan {
  sourceRunId: string | null;
  decisions: TaskReuse[];
  reusedTaskIds: TaskId[];
  /** `done:<task>` events for the new run (kind task_completed, data.reused = true). */
  events: NewRunEvent[];
  /** The copied finding rows for the new run. */
  findings: Finding[];
}

export const NO_REUSE: ReusePlan = { sourceRunId: null, decisions: [], reusedTaskIds: [], events: [], findings: [] };

/** The cost estimate when the tasks in `plan` are reused: only the tasks that will be sent are counted (a reused task costs nothing). */
export function estimateWithReuse(prep: { serialized: { payload: ReviewPayload }; pack: SourcePack; estimate: RunEstimate; model: string; register: readonly RegisterEntry[] }, plan: ReusePlan): RunEstimate {
  if (plan.reusedTaskIds.length === 0) return prep.estimate;
  return estimateAiRun(prep.serialized.payload, prep.pack, prep.estimate.price, prep.model, prep.register, new Set<string>(plan.reusedTaskIds));
}

const REUSABLE_STATES: readonly string[] = ["failed", "cancelled"];

/** The earlier run to reuse from: the newest of `candidates` (newest first, same return state) whose AI review failed or was cancelled. */
export function pickReuseSource(candidates: readonly { runId: string; events: readonly RunEvent[] }[], nowMs: number): string | null {
  for (const c of candidates) {
    const p = foldProgress(c.events, nowMs);
    if (p.started && REUSABLE_STATES.includes(p.status)) return c.runId;
  }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function timeOf(at: Date | string): number {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

function payloadOf(events: readonly RunEvent[]): ReviewPayload | null {
  const json = obj(events.find((e) => e.kind === "payload")?.data)["json"];
  if (typeof json !== "string") return null;
  try {
    return JSON.parse(json) as ReviewPayload;
  } catch {
    return null;
  }
}

function registerOf(events: readonly RunEvent[]): RegisterEntry[] {
  const entries = obj(events.find((e) => e.kind === "register")?.data)["entries"];
  return Array.isArray(entries) ? (entries as RegisterEntry[]) : [];
}

/** The content hash the earlier run's task result was produced under (stored on the event, or pinned for l3-prompts-1 runs); null = unknown. */
function storedContentHash(started: Record<string, unknown>, ev: RunEvent): string | null {
  const d = obj(ev.data);
  if (typeof d["contentHash"] === "string") return d["contentHash"];
  const runHash = started["promptHash"];
  if (runHash === LEGACY_PROMPTS_1.runPromptHash && ev.taskId !== null && d["promptHash"] === sha256Hex(`${ev.taskId}|${LEGACY_PROMPTS_1.runPromptHash}`)) return LEGACY_PROMPTS_1.contentHashes[ev.taskId] ?? null;
  return null;
}

/** Findings of one finished task: by the keys its event lists, or (events from before keys were listed) by when they were stored. */
function findingsOfTask(ev: RunEvent, doneEvents: readonly RunEvent[], rows: readonly StoredFinding[]): Finding[] | null {
  const d = obj(ev.data);
  const keys = d["findingKeys"];
  if (Array.isArray(keys)) {
    const byKey = new Map(dedupeFindings(rows.map((r) => r.finding)).map((f) => [f.key, f]));
    const out: Finding[] = [];
    for (const k of keys) {
      const f = typeof k === "string" ? byKey.get(k) : undefined;
      if (f === undefined) return null;
      out.push(f);
    }
    return out;
  }
  // Findings are written right after their task's `done:` event (same step) and the next task starts seconds later: a row belongs to the
  // latest `done:` event that is not later than the row (a quarter of a second of tolerance for the order of the two writes).
  const count = typeof d["findingCount"] === "number" ? d["findingCount"] : -1;
  if (count < 0) return null;
  const mine = timeOf(ev.createdAt);
  const owned = rows.filter((r) => {
    let owner: RunEvent | null = null;
    for (const e of doneEvents) if (timeOf(e.createdAt) <= r.at + 250 && (owner === null || timeOf(e.createdAt) > timeOf(owner.createdAt))) owner = e;
    return owner !== null && timeOf(owner.createdAt) === mine && r.at - mine < 60_000;
  });
  // the count must match exactly: a task whose findings cannot be told apart for certain is sent again
  return owned.length === count ? owned.map((r) => r.finding) : null;
}

/** The code checks a copied finding must pass again against the NEW payload; returns a problem name or null. */
export function reusedFindingProblem(f: Finding, task: TaskDef, index: PayloadIndex): string | null {
  if (!findingSchema.safeParse(f).success) return "shape";
  if (f.layer !== "L3" || f.origin !== "llm" || f.acceptable !== true) return "layer_origin_acceptable";
  if (f.pass !== task.pass || !f.check.startsWith(`L3.${task.pass}.`)) return "pass";
  if (f.challenge !== undefined) return "challenge";
  if (f.lineKey !== undefined && !index.lines.has(f.lineKey)) return "unknown_line";
  for (const e of f.evidence) if (!resolveEvidence(e.ref, e.amount, index).ok) return "evidence";
  const texts = [f.message, f.recommendedAction, ...f.evidence.map((e) => e.ref), ...f.citation.sources.flatMap((s) => [s.id, s.quote ?? ""])];
  if (texts.some((t) => findRedactionIssues(t).length > 0)) return "identifier_text";
  return null;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

// ── the plan ──────────────────────────────────────────────────────────────────

/** Decides, per task, whether a finished result of `source` is reused in the new run, and builds the events and findings to copy. */
export function planReuse(source: ReuseSource | null, target: ReuseTarget): ReusePlan {
  const none = (reason: ReuseReason): ReusePlan => ({ sourceRunId: source?.runId ?? null, decisions: TASKS.map((t) => ({ taskId: t.id, reused: false, reason, findingCount: 0 })), reusedTaskIds: [], events: [], findings: [] });
  if (source === null) return none("no_earlier_review");
  // never across a different return state
  if (source.fingerprint !== target.fingerprint) return none("fingerprint_differs");
  const started = obj(source.events.find((e) => e.kind === "run_started")?.data);
  if (started["model"] !== target.model) return none("model_differs");
  if (started["sourcePackHash"] !== sha256Hex(sourcePackDigestInput(target.pack))) return none("source_pack_differs");
  const oldPayload = payloadOf(source.events);
  if (oldPayload === null) return none("earlier_payload_missing");
  const oldRegister = registerOf(source.events);
  const newIndex = indexPayload(target.payload);

  const doneEvents = source.events.filter((e) => e.kind === "task_completed");
  const decisions: TaskReuse[] = [];
  const events: NewRunEvent[] = [];
  const findings: Finding[] = [];
  const reusedTaskIds: TaskId[] = [];
  for (const task of TASKS) {
    const skip = (reason: ReuseReason): void => {
      decisions.push({ taskId: task.id, reused: false, reason, findingCount: 0 });
    };
    // the adversarial pass reads every other finding: it is always run
    if (task.kind === "adversarial") {
      skip("adversarial_pass");
      continue;
    }
    const ev = doneEvents.find((e) => e.taskId === task.id);
    if (ev === undefined) {
      skip("not_finished");
      continue;
    }
    const stored = storedContentHash(started, ev);
    if (stored === null || stored !== taskContentHash(task)) {
      skip("prompt_differs");
      continue;
    }
    // the exact request: the earlier payload and the new one must give the same text for this task
    const before = buildPrompt(task, oldPayload, target.pack, { priorFindings: [], register: oldRegister });
    const now = buildPrompt(task, target.payload, target.pack, { priorFindings: [], register: target.register });
    if (before.system !== now.system || before.user !== now.user) {
      skip("input_differs");
      continue;
    }
    const copied = findingsOfTask(ev, doneEvents, source.findingRows);
    if (copied === null) {
      skip("findings_missing");
      continue;
    }
    if (copied.some((f) => reusedFindingProblem(f, task, newIndex) !== null)) {
      skip("findings_invalid");
      continue;
    }
    const d = obj(ev.data);
    events.push({
      runId: target.runId,
      eventKey: `done:${task.id}`,
      kind: "task_completed",
      taskId: task.id,
      attempt: null,
      // nothing was sent for this task in this run: its usage here is zero; what it cost the earlier run is kept for the record
      data: { ...d, usage: ZERO_USAGE, originalUsage: d["usage"] ?? null, reused: true, reusedFromRunId: source.runId, contentHash: stored, findingKeys: copied.map((f) => f.key), findingCount: copied.length },
    });
    findings.push(...copied);
    reusedTaskIds.push(task.id);
    decisions.push({ taskId: task.id, reused: true, reason: null, findingCount: copied.length });
  }
  return { sourceRunId: source.runId, decisions, reusedTaskIds, events, findings };
}
