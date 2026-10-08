// The production LlmClient (plan section 7): the ONLY advisor file that touches @anthropic-ai/sdk. Server only (a test pins that no
// component imports it).
//
// - Calls `client.beta.messages.stream(...)`: `fallbacks` and the server-side-fallback beta exist only on the beta namespace of SDK 0.131.
// - `thinking` is omitted (adaptive by default on this model), `output_config.effort` is always set, NO `temperature` / `top_p` / `top_k`,
//   NO `tool_choice` (auto). Tools are the sorted, byte-stable list; `strict: true` unless degraded (see below).
// - Prompt caching: one explicit breakpoint on the frozen system block (tools render before it) plus the top-level automatic
//   `cache_control`, which marks the last cacheable block of the request, so each loop iteration reads the previous iteration's prefix.
// - Errors never carry the API's message (it can quote the request): they are mapped to LlmError(kind, status).
// - Degradation: strict-mode schema limits and the fallbacks beta cannot be verified offline. If the API answers 400 BEFORE any output, the
//   adapter retries once without `strict`, then once without fallbacks, and remembers the working level for DEGRADE_MS (counts only logged).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { AdvisorConfig } from "@/lib/advisor/config";
import { LlmError, type ContentBlock, type LlmClient, type LlmErrorKind, type LlmMessage, type LlmRequest, type LlmResult } from "@/lib/advisor/loop";
import { toolDefinitions, type ToolDefinition } from "@/lib/advisor/tools/registry";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** 0 = as configured; 1 = without strict tool schemas; 2 = also without fallbacks. */
export type DegradeLevel = 0 | 1 | 2;

type BetaParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

export interface BuildParamsInput {
  cfg: Pick<AdvisorConfig, "model" | "effort" | "strictTools" | "fallbacks" | "maxOutputTokens">;
  tools: readonly ToolDefinition[];
  system: LlmRequest["system"];
  messages: readonly LlmMessage[];
  userId: string;
  level: DegradeLevel;
}

/** Opaque, stable per-user id for Anthropic's abuse detection (never the user id itself, never an email). */
export function metadataUserId(userId: string): string {
  return createHash("sha256").update(`advisor:${userId}`).digest("hex").slice(0, 32);
}

/** Pure request construction (the params test asserts the whole checklist on this output). */
export function buildParams(input: BuildParamsInput): BetaParams {
  const useFallbacks = input.cfg.fallbacks && input.level < 2;
  const tools = input.tools.map((t) => {
    const { strict, ...rest } = t;
    return input.cfg.strictTools && input.level < 1 && strict === true ? { ...rest, strict: true } : rest;
  });
  return {
    model: input.cfg.model,
    max_tokens: input.cfg.maxOutputTokens,
    system: [
      { type: "text", text: input.system.frozen, cache_control: { type: "ephemeral" } },
      { type: "text", text: input.system.volatile },
    ],
    tools: tools as unknown as BetaParams["tools"],
    messages: input.messages.map(toBetaMessage),
    output_config: { effort: input.cfg.effort },
    metadata: { user_id: metadataUserId(input.userId) },
    cache_control: { type: "ephemeral" },
    ...(useFallbacks ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
  };
}

function toBetaMessage(m: LlmMessage): BetaMessageParam {
  return { role: m.role, content: typeof m.content === "string" ? m.content : (m.content as unknown as BetaContentBlockParam[]) };
}

/** Maps any SDK / network error to an LlmError without keeping its text. */
export function classifyLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new LlmError("aborted");
  if (err instanceof Error && err.name === "AbortError") return new LlmError("aborted");
  if (err instanceof Anthropic.APIConnectionError) return new LlmError("upstream");
  const status = err instanceof Anthropic.APIError && typeof err.status === "number" ? err.status : null;
  let kind: LlmErrorKind = "upstream";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429 || status === 529) kind = "overloaded";
  else if (status !== null && status >= 400 && status < 500) kind = "bad_request";
  return new LlmError(kind, status);
}

/** The next, simpler request shape to try after a 400, or null when there is nothing left to drop. */
export function nextDegradation(level: DegradeLevel, cfg: Pick<AdvisorConfig, "strictTools" | "fallbacks">): DegradeLevel | null {
  if (level === 0 && cfg.strictTools) return 1;
  if (level < 2 && cfg.fallbacks) return 2;
  return null;
}

// ── minimal structural view of the SDK (so tests can inject a fake client) ──
interface StreamLike {
  on(event: "text", listener: (delta: string) => void): StreamLike;
  finalMessage(): Promise<MessageLike>;
}
interface MessageLike {
  content: unknown[];
  stop_reason: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    iterations?: ReadonlyArray<{ type: string }> | null;
  };
}
export interface AnthropicLike {
  beta: { messages: { stream(params: BetaParams, options?: { signal?: AbortSignal }): StreamLike } };
}

export const DEGRADE_MS = 15 * 60 * 1000;
let degraded: { level: DegradeLevel; until: number } = { level: 0, until: 0 };

/** For tests. */
export function resetDegradation(): void {
  degraded = { level: 0, until: 0 };
}

export interface CreateLlmInput {
  cfg: AdvisorConfig;
  tools: readonly RegisteredTool[];
  userId: string;
  client?: AnthropicLike;
  now?: () => number;
}

export function createAnthropicLlm(input: CreateLlmInput): LlmClient {
  const now = input.now ?? Date.now;
  const defs = toolDefinitions(input.tools, { strict: true });
  return {
    async stream(req, hooks): Promise<LlmResult> {
      const client = input.client ?? makeClient();
      let level: DegradeLevel = now() < degraded.until ? degraded.level : 0;
      for (;;) {
        const params = buildParams({ cfg: input.cfg, tools: defs, system: req.system, messages: req.messages, userId: input.userId, level });
        let sawText = false;
        try {
          const stream = client.beta.messages.stream(params, { signal: hooks.signal });
          stream.on("text", (d) => {
            sawText = true;
            hooks.onText(d);
          });
          return toResult(await stream.finalMessage());
        } catch (err) {
          const mapped = classifyLlmError(err);
          const next = mapped.kind === "bad_request" && !sawText ? nextDegradation(level, input.cfg) : null;
          if (next === null) throw mapped;
          level = next;
          degraded = { level, until: now() + DEGRADE_MS };
          console.error("advisor llm degraded: level", level);
        }
      }
    },
  };
}

function makeClient(): AnthropicLike {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new LlmError("unavailable");
  return new Anthropic({ apiKey, maxRetries: 2 }) as unknown as AnthropicLike;
}

function toResult(msg: MessageLike): LlmResult {
  return {
    content: msg.content as ContentBlock[],
    stopReason: msg.stop_reason,
    usage: {
      inputTokens: msg.usage.input_tokens,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens,
    },
    model: msg.model,
    // A fallback model served the response iff usage.iterations holds a `fallback_message` entry (SDK 0.131 BetaFallbackMessageIterationUsage).
    fallbackUsed: (msg.usage.iterations ?? []).some((i) => i.type === "fallback_message"),
  };
}
