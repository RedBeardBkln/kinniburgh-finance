// The state of an AI review run, folded from its append-only event rows (ai-return-reviewer, B4).
//
// The review run row is immutable (lib/tax-review-store.ts is insert-only), so a run's progress is NOT a column that gets updated:
// every step appends an event (run_started, payload, task_started, task_completed, task_failed, cancelled, stale) and the state is
// derived here, by a pure function of the events and the clock passed in. Event keys are unique per run, which makes every append
// idempotent (the same completion cannot be recorded twice) and makes two tabs racing for the same task safe (the second insert of
// `start:<task>:<n>` fails and that tab backs off).
//
// PURE: no DB, no network, no clock (the caller passes `nowMs`).

import { costUsd, type Price, type RunEstimate } from "@/lib/tax-review/llm/model";
import type { LlmFailureKind } from "@/lib/tax-review/llm/client";
import type { RegisterEntry } from "@/lib/tax-review/llm/register";
import type { Challenge } from "@/lib/tax-review/llm/validate";
import { TASKS, TASK_IDS, type TaskDef, type TaskId } from "@/lib/tax-review/llm/tasks";
import type { LayerRunState } from "@/lib/tax-review/gate";

/** A task that started more than this long ago and never finished is treated as abandoned (its tab was closed or the request died). */
export const STALE_RUNNING_MS = 5 * 60 * 1000;
/** Tries per task (each try already retries transient errors inside the client). After this many failures the run fails closed. */
export const MAX_TASK_ATTEMPTS = 3;

export type RunEventKind = "run_started" | "payload" | "register" | "task_started" | "task_completed" | "task_failed" | "cancelled" | "stale";

export interface RunEvent {
  runId: string;
  eventKey: string;
  kind: RunEventKind;
  taskId: string | null;
  attempt: number | null;
  data: unknown;
  createdAt: Date | string;
}

export const eventKeys = {
  runStarted: "run_started",
  payload: "payload",
  register: "register",
  cancelled: "cancelled",
  stale: "stale",
  taskStarted: (task: string, n: number): string => `start:${task}:${n}`,
  taskDone: (task: string): string => `done:${task}`,
  taskFailed: (task: string, n: number): string => `fail:${task}:${n}`,
} as const;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type TaskState = "pending" | "running" | "completed" | "failed";

export interface TaskProgress {
  id: TaskId;
  pass: TaskDef["pass"];
  title: string;
  state: TaskState;
  /** Tries started so far. */
  attempts: number;
  failures: number;
  usage: Usage;
  error: { kind: LlmFailureKind | "unknown"; detail: string } | null;
  findingCount: number;
  rejectedCount: number;
  unverifiedCount: number;
  privacyDropped: number;
}

export type AiRunStatus = "not_run" | "running" | "completed" | "failed" | "cancelled" | "stale";

export interface AiReviewProgress {
  started: boolean;
  status: AiRunStatus;
  model: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  sourcePackHash: string | null;
  estimate: RunEstimate | null;
  tasks: TaskProgress[];
  completedCount: number;
  totalCount: number;
  usage: Usage;
  /** Cost of the tokens used so far at the run's price assumption; null before the run started. */
  costUsdSoFar: number | null;
  /** Adversarial notes by finding key (annotation only). */
  challenges: Challenge[];
  /** The register: narrated when task e2 completed, else null (the caller uses the deterministic one). */
  narratedRegister: RegisterEntry[] | null;
  /** Next task a step would run, or null. */
  nextTask: TaskId | null;
  /** A task is running right now (a step from another tab). */
  busy: boolean;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function timeOf(at: Date | string): number {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

function usageOf(v: unknown): Usage {
  const o = obj(v);
  return { inputTokens: num(o["inputTokens"]), outputTokens: num(o["outputTokens"]) };
}

export function emptyProgress(): AiReviewProgress {
  return {
    started: false,
    status: "not_run",
    model: null,
    promptVersion: null,
    promptHash: null,
    sourcePackHash: null,
    estimate: null,
    tasks: TASKS.map((t) => ({ id: t.id, pass: t.pass, title: t.title, state: "pending", attempts: 0, failures: 0, usage: { inputTokens: 0, outputTokens: 0 }, error: null, findingCount: 0, rejectedCount: 0, unverifiedCount: 0, privacyDropped: 0 })),
    completedCount: 0,
    totalCount: TASK_IDS.length,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsdSoFar: null,
    challenges: [],
    narratedRegister: null,
    nextTask: null,
    busy: false,
  };
}

/** Folds the events of one run (any order) into its progress at `nowMs`. */
export function foldProgress(events: readonly RunEvent[], nowMs: number): AiReviewProgress {
  const out = emptyProgress();
  const ordered = [...events].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
  const started = ordered.find((e) => e.kind === "run_started");
  if (started === undefined) return out;
  out.started = true;
  const cfg = obj(started.data);
  out.model = typeof cfg["model"] === "string" ? cfg["model"] : null;
  out.promptVersion = typeof cfg["promptVersion"] === "string" ? cfg["promptVersion"] : null;
  out.promptHash = typeof cfg["promptHash"] === "string" ? cfg["promptHash"] : null;
  out.sourcePackHash = typeof cfg["sourcePackHash"] === "string" ? cfg["sourcePackHash"] : null;
  out.estimate = cfg["estimate"] !== undefined && cfg["estimate"] !== null ? (cfg["estimate"] as RunEstimate) : null;
  const price: Price | null = out.estimate?.price ?? null;

  const lastStart = new Map<string, number>();
  const running = new Map<string, boolean>();
  for (const e of ordered) {
    const tid = e.taskId;
    if (tid === null) continue;
    const t = out.tasks.find((x) => x.id === tid);
    if (t === undefined) continue;
    const d = obj(e.data);
    if (e.kind === "task_started") {
      t.attempts += 1;
      lastStart.set(tid, timeOf(e.createdAt));
      running.set(tid, true);
    } else if (e.kind === "task_failed") {
      t.failures += 1;
      running.set(tid, false);
      const u = usageOf(d["usage"]);
      t.usage.inputTokens += u.inputTokens;
      t.usage.outputTokens += u.outputTokens;
      t.error = { kind: (typeof d["kind"] === "string" ? d["kind"] : "unknown") as LlmFailureKind | "unknown", detail: typeof d["detail"] === "string" ? d["detail"] : "" };
    } else if (e.kind === "task_completed") {
      t.state = "completed";
      running.set(tid, false);
      const u = usageOf(d["usage"]);
      t.usage.inputTokens += u.inputTokens;
      t.usage.outputTokens += u.outputTokens;
      t.findingCount = num(d["findingCount"]);
      t.rejectedCount = Array.isArray(d["rejected"]) ? d["rejected"].length : 0;
      t.unverifiedCount = num(d["unverified"]);
      t.privacyDropped = num(d["privacyDropped"]);
      t.error = null;
      if (tid === "f1" && Array.isArray(d["challenges"])) out.challenges = d["challenges"].filter((c): c is Challenge => typeof obj(c)["findingKey"] === "string" && typeof obj(c)["note"] === "string");
      if (tid === "e2" && Array.isArray(d["register"])) out.narratedRegister = d["register"] as RegisterEntry[];
    }
  }
  for (const t of out.tasks) {
    if (t.state === "completed") continue;
    if (t.failures >= MAX_TASK_ATTEMPTS) t.state = "failed";
    else if (running.get(t.id) === true) t.state = nowMs - (lastStart.get(t.id) ?? 0) < STALE_RUNNING_MS ? "running" : "pending";
    else t.state = "pending";
    // a task abandoned while "running" consumed an attempt but left no failure row: count it so retries are bounded
    if (t.state === "pending" && t.attempts - t.failures >= MAX_TASK_ATTEMPTS) t.state = "failed";
  }
  out.completedCount = out.tasks.filter((t) => t.state === "completed").length;
  for (const t of out.tasks) {
    out.usage.inputTokens += t.usage.inputTokens;
    out.usage.outputTokens += t.usage.outputTokens;
  }
  out.costUsdSoFar = price === null ? null : costUsd(out.usage.inputTokens, out.usage.outputTokens, price);
  out.busy = out.tasks.some((t) => t.state === "running");
  const cancelled = ordered.some((e) => e.kind === "cancelled");
  const stale = ordered.some((e) => e.kind === "stale");
  if (stale) out.status = "stale";
  else if (cancelled) out.status = "cancelled";
  else if (out.completedCount === out.totalCount) out.status = "completed";
  else if (out.tasks.some((t) => t.state === "failed")) out.status = "failed";
  else out.status = "running";
  // next task: the first pending one; the adversarial pass waits for every other task to be completed
  if (out.status === "running" && !out.busy) {
    const pending = out.tasks.find((t) => t.state === "pending");
    if (pending !== undefined && !(pending.id === "f1" && out.tasks.some((t) => t.id !== "f1" && t.state !== "completed"))) out.nextTask = pending.id;
  }
  return out;
}

/** What the gate needs: a layer state and whether the adversarial pass completed. Anything but a finished run fails closed. */
export function l3GateState(progress: AiReviewProgress): { status: LayerRunState; adversarialCompleted: boolean } {
  const adversarialCompleted = progress.tasks.some((t) => t.id === "f1" && t.state === "completed");
  if (!progress.started) return { status: "not_run", adversarialCompleted: false };
  switch (progress.status) {
    case "completed":
      return { status: "completed", adversarialCompleted };
    case "running":
      return { status: "partial", adversarialCompleted };
    default:
      return { status: "failed", adversarialCompleted };
  }
}
