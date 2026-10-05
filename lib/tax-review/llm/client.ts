// The LLM call wrapper of the AI Return Reviewer (ai-return-reviewer, B1).
//
// Injectable: the review code depends on `LlmTransport` (one method), never on the Anthropic SDK. Production wires the SDK in
// lib/tax-review-anthropic.ts; tests inject a mock, so CI makes no live call.
//
// What `runStructured` guarantees:
//   - the model's text is parsed and validated against a zod schema; anything else is a FAILURE, not a partial result;
//   - a stop at max_tokens is a failure (never a truncated "success") and is not retried HERE (it would stop at the same place): the
//     orchestrator (run.ts) answers it with ONE later request at a larger budget, as a separate step, because a request at a large
//     budget can take minutes and two of them do not fit one serverless call. The reasoning ("thinking") tokens of the model count
//     against max_tokens, so a budget has to cover the reasoning AND the answer;
//   - a refusal is a failure; an abort / timeout is a failure; transient errors (network, 408 / 409 / 429 / 5xx) are retried
//     with backoff, malformed or non-conforming output is retried once;
//   - token usage is summed over every attempt (a failed attempt costs money too);
//   - nothing is logged here and no error text is kept: the detail of a failure is the error CLASS name only, because an error
//     message can quote the request;
//   - the response is hashed (sha256) so the run can show exactly what came back without storing more than it needs to.
//
// No temperature is ever sent (see model.ts). PURE of DB / network / fs / env: timers only.

import { createHash } from "node:crypto";
import type { z } from "zod";
import { extractJsonPayload } from "@/lib/model-json";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** JSON schema for output_config.format (structured output). Absent = the model is asked for JSON in the prompt only. */
  jsonSchema?: Record<string, unknown>;
  effort?: Effort;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Output tokens the model spent on internal reasoning (part of outputTokens), when the API reports it. Diagnostic only. */
  thinkingTokens?: number;
}

export interface LlmResponse {
  text: string;
  /** "end_turn", "max_tokens", "refusal", ... as the API reports it. */
  stopReason: string | null;
  usage: LlmUsage;
  model: string;
}

export type LlmFailureKind = "transient" | "max_tokens" | "refusal" | "invalid_output" | "aborted" | "timeout" | "fatal";

/** What a transport throws; it never carries the API's message text. */
export class LlmTransportError extends Error {
  readonly kind: LlmFailureKind;
  readonly status: number | null;
  constructor(kind: LlmFailureKind, status: number | null = null) {
    super(`llm ${kind}${status !== null ? ` ${status}` : ""}`);
    this.name = "LlmTransportError";
    this.kind = kind;
    this.status = status;
  }
}

export interface LlmTransport {
  send(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

export interface RunStructuredOptions<T> {
  transport: LlmTransport;
  request: LlmRequest;
  schema: z.ZodType<T>;
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Per attempt (default 240 s). */
  timeoutMs?: number;
  /** Caller's abort (the user pressed Cancel): never retried. */
  signal?: AbortSignal;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** First backoff in ms; doubles each retry (default 2000). */
  backoffMs?: number;
}

/** How the call ended, for the task event (never any text of the model). */
export interface CallStats {
  /** The max_tokens the requests were sent with. */
  maxTokensUsed: number;
  /** Length in characters of the visible answer of the last attempt (reasoning is not in it); null when nothing came back. */
  textChars: number | null;
}

export type RunStructuredResult<T> =
  | ({ ok: true; value: T; usage: LlmUsage; attempts: number; responseHash: string; model: string; stopReason: string | null } & CallStats)
  | ({ ok: false; kind: LlmFailureKind; usage: LlmUsage; attempts: number; /** Error class name only. */ detail: string; responseHash: string | null } & CallStats);

export const DEFAULT_TIMEOUT_MS = 240_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callerAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function classify(err: unknown, callerAborted: boolean, timedOut: boolean): { kind: LlmFailureKind; detail: string } {
  if (err instanceof LlmTransportError) return { kind: err.kind === "aborted" && timedOut ? "timeout" : err.kind, detail: err.name };
  if (callerAborted) return { kind: "aborted", detail: "Aborted" };
  if (timedOut) return { kind: "timeout", detail: "Timeout" };
  return { kind: "fatal", detail: err instanceof Error ? err.name : "UnknownError" };
}

/** Parses model text as JSON (a fenced or chatty reply is tolerated) and validates it. Returns null on any problem. */
export function parseAndValidate<T>(text: string, schema: z.ZodType<T>): T | null {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonPayload(text));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function runStructured<T>(opts: RunStructuredOptions<T>): Promise<RunStructuredResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let lastKind: LlmFailureKind = "fatal";
  let lastDetail = "NoAttempt";
  let lastHash: string | null = null;
  let invalidOutputs = 0;
  let textChars: number | null = null;
  const stats = (): CallStats => ({ maxTokensUsed: opts.request.maxTokens, textChars });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (opts.signal?.aborted === true) return { ok: false, kind: "aborted", usage, attempts: attempt - 1, detail: "Aborted", responseHash: lastHash, ...stats() };
    const controller = new AbortController();
    const timer = { fired: false };
    const handle = setTimeout(() => {
      timer.fired = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const res = await opts.transport.send(opts.request, controller.signal);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      if (res.usage.thinkingTokens !== undefined) usage.thinkingTokens = (usage.thinkingTokens ?? 0) + res.usage.thinkingTokens;
      lastHash = sha256Text(res.text);
      textChars = res.text.length;
      if (res.stopReason === "max_tokens") return { ok: false, kind: "max_tokens", usage, attempts: attempt, detail: "MaxTokens", responseHash: lastHash, ...stats() };
      if (res.stopReason === "refusal") return { ok: false, kind: "refusal", usage, attempts: attempt, detail: "Refusal", responseHash: lastHash, ...stats() };
      const value = parseAndValidate(res.text, opts.schema);
      if (value !== null) return { ok: true, value, usage, attempts: attempt, responseHash: lastHash, model: res.model, stopReason: res.stopReason, ...stats() };
      invalidOutputs += 1;
      lastKind = "invalid_output";
      lastDetail = "InvalidOutput";
      // malformed or non-conforming output is retried ONCE
      if (invalidOutputs >= 2) return { ok: false, kind: "invalid_output", usage, attempts: attempt, detail: lastDetail, responseHash: lastHash, ...stats() };
    } catch (err) {
      const c = classify(err, callerAborted(opts.signal), timer.fired);
      lastKind = c.kind;
      lastDetail = c.detail;
      if (c.kind !== "transient") return { ok: false, kind: c.kind, usage, attempts: attempt, detail: c.detail, responseHash: lastHash, ...stats() };
      if (attempt < maxAttempts) await sleep((opts.backoffMs ?? 2000) * 2 ** (attempt - 1));
    } finally {
      clearTimeout(handle);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
  return { ok: false, kind: lastKind, usage, attempts: maxAttempts, detail: lastDetail, responseHash: lastHash, ...stats() };
}
