// The bounded tool-use loop (plan section 7). It talks to the model only through the injected `LlmClient`, so tests use a fake and the
// production adapter (anthropic.ts) is the only file that touches the SDK. No DB, no auth: the route owns those.
//
// Rules implemented here:
//   - tool_use blocks of one response run in parallel (Promise.all), and ALL their tool_result blocks go back in ONE user message, in order,
//     `is_error: true` for failures;
//   - the assistant content (including thinking blocks) is appended to the next request UNMODIFIED;
//   - caps: tool iterations, per-turn fresh tokens, wall clock, per-turn tool bytes (in runTool);
//   - stop reasons: end_turn / stop_sequence finish; tool_use continues; pause_turn continues; max_tokens, refusal and
//     model_context_window_exceeded finish with a neutral notice;
//   - nothing is logged except tool names and error class names.

import { LIMITS, type AdvisorConfig } from "@/lib/advisor/config";
import type { AppLink } from "@/lib/advisor/links";
import type { ErrorCode, AdvisorEvent, NoticeCode, StopKind } from "@/lib/advisor/stream-protocol";
import { newTurnBudget, runTool, type TurnBudget } from "@/lib/advisor/tools/run-tool";
import type { RegisteredTool, ToolContext } from "@/lib/advisor/tools/types";
import { finalizeModelText, previewModelText } from "@/lib/advisor/wording";

/** An opaque content block (text, thinking, redacted_thinking, tool_use, fallback ...): only text and tool_use are read here. */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LlmUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  system: { frozen: string; volatile: string };
  messages: LlmMessage[];
}

export interface LlmResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage: LlmUsage;
  model: string | null;
  fallbackUsed: boolean;
}

export type LlmErrorKind = "aborted" | "overloaded" | "auth" | "bad_request" | "upstream" | "unavailable";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;
  constructor(kind: LlmErrorKind, status: number | null = null) {
    super(`llm ${kind}`);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

export interface LlmClient {
  stream(req: LlmRequest, hooks: { onText: (delta: string) => void; signal: AbortSignal }): Promise<LlmResult>;
}

export interface ToolCallRecord {
  name: string;
  argSummary: string;
  ok: boolean;
  rows: number | null;
  resultChars: number;
  ms: number;
}

export interface TurnUsage extends LlmUsage {
  iterations: number;
  toolCalls: number;
}

export interface TurnOutcome {
  /** The authoritative final text (wording + scrubber applied). */
  text: string;
  stop: StopKind;
  usage: TurnUsage;
  toolCalls: ToolCallRecord[];
  fallbackUsed: boolean;
  model: string | null;
  links: AppLink[];
  /** Set for stop === "error": the in-band error to show. */
  error?: { code: ErrorCode; message: string };
}

export interface LoopInput {
  llm: LlmClient;
  tools: ReadonlyMap<string, RegisteredTool>;
  ctx: ToolContext;
  cfg: Pick<AdvisorConfig, "maxToolIterations" | "turnTokenCap" | "turnBudgetMs">;
  system: { frozen: string; volatile: string };
  /** Replayed history ending with the new user turn. */
  messages: LlmMessage[];
  emit: (event: AdvisorEvent) => void;
  signal: AbortSignal;
  /** Injected clock (ms). */
  clock?: () => number;
  budget?: TurnBudget;
}

export const NUDGE_TEXT = "Tool budget for this turn is used. Answer now from the results above; do not call more tools.";
export const REFUSAL_TEXT = "I can't help with that request.";
export const MESSAGES = {
  max_tokens: "The answer was cut off. Say \"continue\" to get the rest.",
  time_budget: "I ran out of time before finishing. Ask me to continue, or narrow the question.",
  loop_cap: "I reached the limit of lookups for one answer. Ask me to continue, or narrow the question.",
  token_cap: "This answer used the most it is allowed to in one turn. Ask me to continue, or narrow the question.",
  context: "This conversation is too long; start a new chat.",
  empty: "I couldn't produce an answer. Please try rephrasing the question.",
  upstream: "The assistant is temporarily unavailable. Please try again in a moment.",
  overloaded: "The assistant is busy right now. Please try again in a moment.",
  unavailable: "The assistant is not configured.",
  bad_request: "The assistant could not process that request.",
} as const;

/** Buffers streamed text and releases it at sentence / newline boundaries, or every ~400 ms. Each flush is wording-processed and scrubbed. */
export function createTextFlusher(send: (chunk: string) => void, clock: () => number, intervalMs = 400) {
  let pending = "";
  let last = clock();
  const release = (): void => {
    if (pending === "") return;
    const chunk = previewModelText(pending);
    pending = "";
    last = clock();
    if (chunk !== "") send(chunk);
  };
  return {
    push(delta: string): void {
      pending += delta;
      if (/[\n]|[.!?:]\s$/.test(pending) || clock() - last >= intervalMs) release();
    },
    flush: release,
  };
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

function toolUsesOf(content: readonly ContentBlock[]): ToolUse[] {
  const out: ToolUse[] = [];
  for (const b of content) {
    if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") out.push({ id: b.id, name: b.name, input: b.input });
  }
  return out;
}

export async function runTurn(input: LoopInput): Promise<TurnOutcome> {
  const clock = input.clock ?? Date.now;
  const started = clock();
  const budget = input.budget ?? newTurnBudget();
  const messages: LlmMessage[] = [...input.messages];
  const usage: TurnUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, iterations: 0, toolCalls: 0 };
  const records: ToolCallRecord[] = [];
  const links: AppLink[] = [];
  const texts: string[] = [];
  let fallbackUsed = false;
  let fallbackNoticed = false;
  let model: string | null = null;

  const done = (stop: StopKind, extra: { notice?: { code: NoticeCode; message: string }; replaceText?: string; error?: TurnOutcome["error"] } = {}): TurnOutcome => {
    let text = extra.replaceText ?? finalizeModelText(texts.join("\n\n").trim());
    if (extra.notice !== undefined) {
      input.emit({ t: "notice", code: extra.notice.code, message: extra.notice.message });
      if (extra.replaceText === undefined) text = text === "" ? extra.notice.message : `${text}\n\n_${extra.notice.message}_`;
    }
    if (text === "" && stop === "end_turn") text = MESSAGES.empty;
    return {
      text: text.slice(0, LIMITS.storedAssistantChars),
      stop,
      usage,
      toolCalls: records,
      fallbackUsed,
      model,
      links: links.slice(0, 8),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    };
  };

  const fresh = (): number => usage.inputTokens + usage.cacheWriteTokens + usage.outputTokens;

  for (let iteration = 1; iteration <= input.cfg.maxToolIterations; iteration++) {
    if (input.signal.aborted) return done("aborted");
    const remainingMs = input.cfg.turnBudgetMs - (clock() - started);
    if (remainingMs < LIMITS.finalizeReserveMs) return done("time_budget", { notice: { code: "time_budget", message: MESSAGES.time_budget } });
    if (iteration > 1 && fresh() > input.cfg.turnTokenCap) return done("token_cap", { notice: { code: "token_cap", message: MESSAGES.token_cap } });

    // A deadline for this model call, so a slow stream cannot run past the wall clock.
    const deadline = AbortSignal.timeout(Math.max(1_000, remainingMs - 2_000));
    const callSignal = AbortSignal.any([input.signal, deadline]);
    let iterText = "";
    if (texts.length > 0) input.emit({ t: "text", d: "\n\n" });
    const flusher = createTextFlusher((chunk) => input.emit({ t: "text", d: chunk }), clock);

    let res: LlmResult;
    try {
      res = await input.llm.stream(
        { system: input.system, messages },
        {
          onText: (delta) => {
            iterText += delta;
            flusher.push(delta);
          },
          signal: callSignal,
        },
      );
    } catch (err) {
      flusher.flush();
      if (iterText !== "") texts.push(iterText);
      if (input.signal.aborted) return done("aborted");
      if (deadline.aborted) return done("time_budget", { notice: { code: "time_budget", message: MESSAGES.time_budget } });
      const kind: LlmErrorKind = err instanceof LlmError ? err.kind : "upstream";
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error("advisor llm error:", name, err instanceof LlmError ? `${err.kind} ${err.status ?? ""}`.trim() : "");
      if (kind === "aborted") return done("aborted");
      const notConfigured = kind === "unavailable" || kind === "auth";
      const code: ErrorCode = notConfigured ? "unavailable" : "upstream";
      const message = kind === "overloaded" ? MESSAGES.overloaded : notConfigured ? MESSAGES.unavailable : kind === "bad_request" ? MESSAGES.bad_request : MESSAGES.upstream;
      return done("error", { replaceText: iterText === "" ? message : finalizeModelText(texts.join("\n\n")), error: { code, message } });
    }
    flusher.flush();

    usage.iterations += 1;
    usage.inputTokens += res.usage.inputTokens;
    usage.cacheWriteTokens += res.usage.cacheWriteTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens;
    usage.outputTokens += res.usage.outputTokens;
    fallbackUsed = fallbackUsed || res.fallbackUsed;
    model = res.model ?? model;
    if (res.fallbackUsed && !fallbackNoticed) {
      fallbackNoticed = true;
      input.emit({ t: "notice", code: "fallback", message: "A substitute model answered part of this request." });
    }

    const text = textOf(res.content);
    if (res.stopReason === "refusal") {
      return done("refusal", { replaceText: REFUSAL_TEXT, notice: { code: "refusal", message: REFUSAL_TEXT } });
    }
    if (text.trim() !== "") texts.push(text);

    switch (res.stopReason) {
      case "end_turn":
      case "stop_sequence":
      case null:
        return done("end_turn");
      case "max_tokens":
        return done("max_tokens", { notice: { code: "max_tokens", message: MESSAGES.max_tokens } });
      case "model_context_window_exceeded":
        return done("error", { replaceText: MESSAGES.context, notice: { code: "context", message: MESSAGES.context }, error: { code: "invalid", message: MESSAGES.context } });
      case "pause_turn":
        messages.push({ role: "assistant", content: res.content });
        continue;
      case "tool_use": {
        const uses = toolUsesOf(res.content);
        if (uses.length === 0) return done("end_turn");
        messages.push({ role: "assistant", content: res.content });
        if (iteration === input.cfg.maxToolIterations) {
          // Nothing left to feed the results into.
          return done("loop_cap", { notice: { code: "loop_cap", message: MESSAGES.loop_cap } });
        }
        for (const u of uses) {
          const tool = input.tools.get(u.name);
          input.emit({ t: "tool", id: u.id, name: u.name, label: tool?.label ?? "Looking something up", state: "start" });
        }
        const results = await Promise.all(
          uses.map(async (u) => {
            const r = await runTool(input.tools, input.ctx, budget, u.name, u.input);
            input.emit({ t: "tool", id: u.id, name: u.name, state: "done", ok: r.ok, rows: r.rows });
            return r;
          }),
        );
        usage.toolCalls += results.length;
        const blocks: ContentBlock[] = [];
        uses.forEach((u, i) => {
          const r = results[i]!;
          records.push({ name: r.name, argSummary: r.argSummary, ok: r.ok, rows: r.rows, resultChars: r.resultChars, ms: r.ms });
          for (const l of r.links) if (!links.some((x) => x.path === l.path)) links.push(l);
          blocks.push({ type: "tool_result", tool_use_id: u.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
        });
        // On the last allowed round trip, tell the model to answer now.
        if (iteration === input.cfg.maxToolIterations - 1) blocks.push({ type: "text", text: NUDGE_TEXT });
        messages.push({ role: "user", content: blocks });
        continue;
      }
      default:
        return done("error", { replaceText: MESSAGES.upstream, error: { code: "upstream", message: MESSAGES.upstream } });
    }
  }
  return done("loop_cap", { notice: { code: "loop_cap", message: MESSAGES.loop_cap } });
}
