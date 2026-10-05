// The AI review orchestrator (ai-return-reviewer, B4): starts a run, runs ONE task per call (so every call fits a serverless time
// limit and a failed task is retried alone), validates what comes back and persists it through an INJECTED store.
//
// Everything with a side effect is injected: the store (append-only events + findings), the model transport, the clock and the
// source pack. That is what makes the same function callable from a server action (DB store), from a read-only script (an
// in-memory store: no database write) and from a test (a mock transport: no live call in CI).
//
// Guarantees (each pinned by tests):
//   - fail closed: a task that fails (after retries) is recorded as failed; the run is "failed" after MAX_TASK_ATTEMPTS and the gate
//     treats L3 as not passed; nothing here can turn a failure into a pass;
//   - idempotent: events are keyed (`start:<task>:<n>`, `done:<task>`), a completion can be recorded once, two tabs racing for the
//     same task cannot both run it, and a finished task is never run again;
//   - stale-fingerprint abort: every step re-checks that the return still has the fingerprint the run was made for; if not, the run is
//     marked stale and nothing more is sent;
//   - the model can only ADD findings (validate.ts); the verdict and the gate are computed by code from the stored findings;
//   - nothing is logged here; failure details are error class names only.
//
// PURE of DB / network / fs / env: the clock is passed in.

import type { z } from "zod";
import { runStructured, type LlmTransport, type RunStructuredResult } from "@/lib/tax-review/llm/client";
import { estimateRun, estimateTokens, type Price, type RunEstimate, type TaskEstimate } from "@/lib/tax-review/llm/model";
import { indexPayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { foldProgress, eventKeys, type AiReviewProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { buildRegister, type RegisterEntry } from "@/lib/tax-review/llm/register";
import { adversarialOutputSchema, findingsOutputSchema, registerOutputSchema } from "@/lib/tax-review/llm/schemas";
import { excerptForTopics, sourcePackDigestInput, topicsForTask, type SourcePack } from "@/lib/tax-review/llm/sources";
import { jsonSchemaFor, promptHash, PROMPT_VERSION, SYSTEM_PROMPT, taskById, TASKS, userPrompt, type TaskDef, type TaskId } from "@/lib/tax-review/llm/tasks";
import { applyNarrations, numbersIn, validateChallenges, validateFindings, type Challenge } from "@/lib/tax-review/llm/validate";
import { dedupeFindings, severityRank, sha256Hex, type Finding } from "@/lib/tax-review/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { Ty2025Return } from "@/lib/tax2025/types";

/** Characters of source text one task may carry (about 28k tokens). */
export const EXCERPT_MAX_CHARS = 110_000;

// ── store ─────────────────────────────────────────────────────────────────────

export class DuplicateEventError extends Error {
  constructor() {
    super("duplicate run event");
    this.name = "DuplicateEventError";
  }
}

export type NewRunEvent = Omit<RunEvent, "createdAt">;

export interface AiRunStore {
  /** Every event of a run. */
  listEvents(runId: string): Promise<RunEvent[]>;
  /** The run's findings of layer L3 (for the adversarial pass and to skip duplicates). */
  listL3Findings(runId: string): Promise<Finding[]>;
  /**
   * ATOMIC: insert the events and the findings together or neither. Throws DuplicateEventError when an event key already exists for the
   * run (the caller backs off). Findings whose key the run already has are skipped by the store.
   */
  append(runId: string, events: readonly NewRunEvent[], findings: readonly Finding[]): Promise<void>;
}

/** An in-memory store (read-only script path, tests): nothing is ever written anywhere else. */
export class MemoryRunStore implements AiRunStore {
  readonly events: RunEvent[] = [];
  readonly findings: Finding[] = [];
  private tick = 0;
  /** The clock is injected (this module never reads the time itself): epoch milliseconds. */
  constructor(private readonly clock: () => number) {}
  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.events.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }
  async listL3Findings(): Promise<Finding[]> {
    // the more severe of two findings with one key (see dbAiRunStore)
    return dedupeFindings(this.findings.filter((f) => f.layer === "L3"));
  }
  async append(runId: string, events: readonly NewRunEvent[], findings: readonly Finding[]): Promise<void> {
    for (const e of events) if (this.events.some((x) => x.runId === runId && x.eventKey === e.eventKey)) throw new DuplicateEventError();
    for (const e of events) {
      this.tick += 1;
      this.events.push({ ...e, createdAt: new Date(this.clock() + this.tick) });
    }
    // same rule as dbAiRunStore: a key already held is stored again only when strictly more serious
    const best = new Map<string, number>();
    for (const f of this.findings) best.set(f.key, Math.min(best.get(f.key) ?? Infinity, severityRank(f.severity)));
    for (const f of dedupeFindings(findings)) {
      const have = best.get(f.key);
      if (have === undefined || severityRank(f.severity) < have) {
        this.findings.push(f);
        best.set(f.key, severityRank(f.severity));
      }
    }
  }
}

// ── estimate ──────────────────────────────────────────────────────────────────

export function excerptFor(pack: SourcePack, task: TaskDef): ReturnType<typeof excerptForTopics> {
  return excerptForTopics(pack, topicsForTask(pack, task.id), EXCERPT_MAX_CHARS);
}

export interface PromptParts {
  system: string;
  user: string;
  excerptNumbers: ReadonlySet<number>;
  excerpt: { included: { source: string; pages: [number, number] | null }[]; truncated: boolean };
}

export function buildPrompt(task: TaskDef, payload: ReviewPayload, pack: SourcePack, ctx: { priorFindings: readonly Finding[]; register: readonly RegisterEntry[] }): PromptParts {
  const excerpt = excerptFor(pack, task);
  const slice = task.slice(payload, ctx);
  return {
    system: SYSTEM_PROMPT,
    user: userPrompt(task, JSON.stringify(slice), excerpt.text),
    excerptNumbers: numbersIn(excerpt.text),
    excerpt: { included: excerpt.included, truncated: excerpt.truncated },
  };
}

/**
 * The cost estimate shown BEFORE a run starts: input tokens from the real prompt text of every task (chars / 3.5), expected output
 * at half of each task's max_tokens, worst case at max_tokens. For the adversarial pass the prior findings are assumed to be 25
 * short findings. An estimate, not a quote: the real cost is the tokens the API reports.
 */
export function estimateAiRun(payload: ReviewPayload, pack: SourcePack, price: Price, model: string, register: readonly RegisterEntry[]): RunEstimate {
  const assumed: Finding[] = [];
  const tasks: TaskEstimate[] = TASKS.map((t) => {
    const parts = buildPrompt(t, payload, pack, { priorFindings: assumed, register });
    const priorExtra = t.id === "f1" ? 25 * 120 : 0;
    return { taskId: t.id, inputTokens: estimateTokens(parts.system) + estimateTokens(parts.user) + priorExtra, outputTokens: Math.round(t.maxTokens / 2), maxOutputTokens: t.maxTokens };
  });
  return estimateRun(tasks, price, model);
}

// ── start ─────────────────────────────────────────────────────────────────────

export interface StartInput {
  runId: string;
  /** The exact payload text and object (lib/tax-review/llm/payload.ts serializePayload). */
  payload: { json: string; payload: ReviewPayload };
  model: string;
  estimate: RunEstimate;
  pack: SourcePack;
  ret: Ty2025Return;
  facts: Ty2025Facts;
  /** Optional exact tax deltas for the register (from the independent recomputation). */
  counterfactuals?: Parameters<typeof buildRegister>[0]["counterfactuals"];
}

/** Records the start of an AI review of a run: the config, the redacted payload and the deterministic register. Idempotent. */
export async function startAiRun(store: AiRunStore, input: StartInput): Promise<{ started: boolean }> {
  const register = buildRegister({ ret: input.ret, facts: input.facts, ...(input.counterfactuals !== undefined ? { counterfactuals: input.counterfactuals } : {}) });
  const events: NewRunEvent[] = [
    {
      runId: input.runId,
      eventKey: eventKeys.runStarted,
      kind: "run_started",
      taskId: null,
      attempt: null,
      data: { model: input.model, promptVersion: PROMPT_VERSION, promptHash: promptHash(), sourcePackHash: sha256Hex(sourcePackDigestInput(input.pack)), schemaVersion: 1, estimate: input.estimate, payloadHash: sha256Hex(input.payload.json), payloadBytes: Buffer.byteLength(input.payload.json, "utf8") },
    },
    { runId: input.runId, eventKey: eventKeys.payload, kind: "payload", taskId: null, attempt: null, data: { json: input.payload.json } },
    { runId: input.runId, eventKey: eventKeys.register, kind: "register", taskId: null, attempt: null, data: { entries: register } },
  ];
  try {
    await store.append(input.runId, events, []);
    return { started: true };
  } catch (err) {
    if (err instanceof DuplicateEventError) return { started: false };
    throw err;
  }
}

// ── one step ──────────────────────────────────────────────────────────────────

export type StepResult =
  | { status: "ran"; task: TaskId; ok: boolean; progress: AiReviewProgress }
  | { status: "busy" | "done" | "not_started" | "stale" | "cancelled" | "failed"; progress: AiReviewProgress };

export interface StepDeps {
  store: AiRunStore;
  transport: LlmTransport;
  pack: SourcePack;
  /** Epoch milliseconds. */
  nowMs: () => number;
  /** The fingerprint of the return as it is NOW, recomputed by the caller from the live inputs (never taken from a client). */
  currentFingerprint: string;
  /** The fingerprint the run was made for. */
  runFingerprint: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
}

function payloadOf(events: readonly RunEvent[]): { json: string; payload: ReviewPayload } | null {
  const e = events.find((x) => x.kind === "payload");
  const json = e !== undefined && typeof (e.data as { json?: unknown } | null)?.json === "string" ? (e.data as { json: string }).json : null;
  if (json === null) return null;
  try {
    return { json, payload: JSON.parse(json) as ReviewPayload };
  } catch {
    return null;
  }
}

function registerOf(events: readonly RunEvent[]): RegisterEntry[] {
  const e = events.find((x) => x.kind === "register");
  const entries = (e?.data as { entries?: unknown } | undefined)?.entries;
  return Array.isArray(entries) ? (entries as RegisterEntry[]) : [];
}

function failureData(r: Extract<RunStructuredResult<unknown>, { ok: false }>): Record<string, unknown> {
  return { kind: r.kind, detail: r.detail, attempts: r.attempts, usage: r.usage, responseHash: r.responseHash };
}

/** Runs the next pending task of a run (at most one model request) and records the outcome. */
export async function runNextTask(runId: string, deps: StepDeps): Promise<StepResult> {
  const events = await deps.store.listEvents(runId);
  const progress = foldProgress(events, deps.nowMs());
  if (!progress.started) return { status: "not_started", progress };
  if (progress.status === "completed") return { status: "done", progress };
  if (progress.status === "cancelled") return { status: "cancelled", progress };
  if (progress.status === "stale") return { status: "stale", progress };
  if (progress.status === "failed") return { status: "failed", progress };

  // stale-fingerprint abort: the return changed since this run was made, so nothing more may be sent about it
  if (deps.currentFingerprint !== deps.runFingerprint) {
    try {
      await deps.store.append(runId, [{ runId, eventKey: eventKeys.stale, kind: "stale", taskId: null, attempt: null, data: {} }], []);
    } catch (err) {
      if (!(err instanceof DuplicateEventError)) throw err;
    }
    return { status: "stale", progress: foldProgress(await deps.store.listEvents(runId), deps.nowMs()) };
  }
  if (progress.busy) return { status: "busy", progress };
  if (progress.nextTask === null) return { status: "done", progress };

  const task = taskById(progress.nextTask);
  const loaded = payloadOf(events);
  if (task === undefined || loaded === null) return { status: "failed", progress };

  const tp = progress.tasks.find((t) => t.id === task.id);
  const n = (tp?.attempts ?? 0) + 1;
  try {
    await deps.store.append(runId, [{ runId, eventKey: eventKeys.taskStarted(task.id, n), kind: "task_started", taskId: task.id, attempt: n, data: {} }], []);
  } catch (err) {
    if (err instanceof DuplicateEventError) return { status: "busy", progress };
    throw err;
  }

  const model = progress.model ?? "";
  const priorFindings = task.kind === "adversarial" ? await deps.store.listL3Findings(runId) : [];
  const register = registerOf(events);
  const parts = buildPrompt(task, loaded.payload, deps.pack, { priorFindings, register });
  const schema: z.ZodType<unknown> = task.kind === "register" ? registerOutputSchema : task.kind === "adversarial" ? adversarialOutputSchema : findingsOutputSchema;
  const result = await runStructured({
    transport: deps.transport,
    request: { model, system: parts.system, user: parts.user, maxTokens: task.maxTokens, jsonSchema: jsonSchemaFor(task), effort: "high" },
    schema,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.backoffMs !== undefined ? { backoffMs: deps.backoffMs } : {}),
  });

  if (!result.ok) {
    await appendIgnoringDuplicate(deps.store, runId, { runId, eventKey: eventKeys.taskFailed(task.id, n), kind: "task_failed", taskId: task.id, attempt: n, data: failureData(result) });
    return { status: "ran", task: task.id, ok: false, progress: foldProgress(await deps.store.listEvents(runId), deps.nowMs()) };
  }

  const index = indexPayload(loaded.payload);
  const ctx = { pass: task.pass, categories: task.categories, index, pack: deps.pack, excerptNumbers: parts.excerptNumbers };
  const value = result.value as { findings?: unknown[]; challenges?: unknown[]; entries?: unknown[] };
  let accepted: Finding[] = [];
  let rejected: { reason: string; category: string | null }[] = [];
  let unverified = 0;
  let downgraded = 0;
  let privacyDropped = 0;
  let challenges: Challenge[] = [];
  let narrated: { entries: RegisterEntry[]; narrated: number; rejected: number } | null = null;
  if (task.kind === "register") {
    narrated = applyNarrations(register, value.entries ?? [], ctx);
  } else {
    const v = validateFindings(value.findings ?? [], ctx);
    accepted = v.accepted;
    rejected = v.rejected;
    unverified = v.unverified;
    downgraded = v.downgraded;
    privacyDropped = v.privacyDropped;
    if (task.kind === "adversarial") challenges = validateChallenges(value.challenges ?? [], new Set(priorFindings.map((f) => f.key)));
  }
  const data: Record<string, unknown> = {
    findingCount: accepted.length,
    rejected,
    unverified,
    downgraded,
    privacyDropped,
    usage: result.usage,
    attempts: result.attempts,
    responseHash: result.responseHash,
    promptHash: sha256Hex(`${task.id}|${promptHash()}`),
    model: result.model,
    excerpt: parts.excerpt,
    ...(task.kind === "adversarial" ? { challenges } : {}),
    ...(narrated !== null ? { register: narrated.entries, narrated: narrated.narrated, narrationsRejected: narrated.rejected } : {}),
  };
  try {
    await deps.store.append(runId, [{ runId, eventKey: eventKeys.taskDone(task.id), kind: "task_completed", taskId: task.id, attempt: n, data }], accepted);
  } catch (err) {
    // another tab already recorded this task: its record stands; ours is discarded (nothing was written)
    if (!(err instanceof DuplicateEventError)) throw err;
  }
  return { status: "ran", task: task.id, ok: true, progress: foldProgress(await deps.store.listEvents(runId), deps.nowMs()) };
}

async function appendIgnoringDuplicate(store: AiRunStore, runId: string, event: NewRunEvent): Promise<void> {
  try {
    await store.append(runId, [event], []);
  } catch (err) {
    if (!(err instanceof DuplicateEventError)) throw err;
  }
}

/** Records that the owner cancelled the run: the gate treats L3 as not passed. Idempotent. */
export async function cancelAiRun(store: AiRunStore, runId: string): Promise<void> {
  await appendIgnoringDuplicate(store, runId, { runId, eventKey: eventKeys.cancelled, kind: "cancelled", taskId: null, attempt: null, data: {} });
}

/** Runs steps until the run is done, failed, stale, cancelled or busy (script path: one process, no serverless limit). */
export async function runAllTasks(runId: string, deps: StepDeps, maxSteps = 60): Promise<AiReviewProgress> {
  let last: AiReviewProgress | null = null;
  for (let i = 0; i < maxSteps; i += 1) {
    const step = await runNextTask(runId, deps);
    last = step.progress;
    if (step.status !== "ran") break;
    if (!step.ok && step.progress.status === "failed") break;
  }
  return last ?? foldProgress(await deps.store.listEvents(runId), deps.nowMs());
}
