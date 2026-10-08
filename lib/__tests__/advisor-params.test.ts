import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadAdvisorConfig } from "@/lib/advisor/config";
import { LlmError } from "@/lib/advisor/loop";
import { FALLBACK_BETA, buildParams, classifyLlmError, createAnthropicLlm, metadataUserId, nextDegradation, resetDegradation, type AnthropicLike } from "@/lib/advisor/anthropic";
import { sortTools, toolDefinitions } from "@/lib/advisor/tools/registry";
import { parseInput } from "@/lib/advisor/tools/parse";
import { defineTool } from "@/lib/advisor/tools/types";

const mk = (name: string) =>
  defineTool({
    name,
    description: "Fake.",
    inputJsonSchema: { type: "object", properties: { q: { type: "string", description: "text" } }, required: [], additionalProperties: false },
    parse: (raw) => parseInput(z.object({ q: z.string().optional() }).strict(), raw),
    label: "Fake",
    summarizeArgs: () => "",
    run: async () => ({ data: {} }),
    maxChars: 1000,
    phase: 1,
  });

const cfg = loadAdvisorConfig({});
const defs = toolDefinitions(sortTools([mk("zeta_tool"), mk("alpha_tool")]), { strict: true });
const system = { frozen: "FROZEN", volatile: "VOLATILE" };
const messages = [{ role: "user" as const, content: "hi" }];

afterEach(() => {
  resetDegradation();
  vi.restoreAllMocks();
});

describe("buildParams", () => {
  const p = buildParams({ cfg, tools: defs, system, messages, userId: "user-1", level: 0 });

  it("uses the configured default model and an explicit effort", () => {
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.max_tokens).toBe(16_000);
  });

  it("sets none of the parameters the model rejects or that the rules forbid", () => {
    const keys = Object.keys(p);
    for (const k of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "stop_sequences", "stream"]) expect(keys, k).not.toContain(k);
  });

  it("is the beta shape: fallbacks default plus the beta header value", () => {
    expect(p.fallbacks).toBe("default");
    expect((p as { betas?: string[] }).betas).toEqual([FALLBACK_BETA]);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
  });

  it("marks tools strict, sorted, with additionalProperties:false", () => {
    const tools = p.tools as unknown as { name: string; strict?: boolean; input_schema: { additionalProperties: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(["alpha_tool", "zeta_tool"]);
    for (const t of tools) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
    }
  });

  it("caches: one explicit breakpoint on the frozen system block only, volatile block after it, plus the top-level automatic marker", () => {
    const sys = p.system as { type: string; text: string; cache_control?: unknown }[];
    expect(sys).toHaveLength(2);
    expect(sys[0]).toEqual({ type: "text", text: "FROZEN", cache_control: { type: "ephemeral" } });
    expect(sys[1]).toEqual({ type: "text", text: "VOLATILE" });
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(p.tools)).not.toContain("cache_control");
    expect(JSON.stringify(p.messages)).not.toContain("cache_control");
  });

  it("sends an opaque user id, never the id or an email", () => {
    expect(p.metadata?.user_id).toBe(metadataUserId("user-1"));
    expect(p.metadata?.user_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(p)).not.toContain("user-1");
  });

  it("is byte-identical for identical input (cache stability)", () => {
    const again = buildParams({ cfg, tools: toolDefinitions(sortTools([mk("alpha_tool"), mk("zeta_tool")]), { strict: true }), system, messages, userId: "user-1", level: 0 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(p));
  });

  it("degradation level 1 drops strict, level 2 also drops fallbacks and the beta", () => {
    const l1 = buildParams({ cfg, tools: defs, system, messages, userId: "u", level: 1 });
    expect(JSON.stringify(l1.tools)).not.toContain("strict");
    expect(l1.fallbacks).toBe("default");
    const l2 = buildParams({ cfg, tools: defs, system, messages, userId: "u", level: 2 });
    expect(l2.fallbacks).toBeUndefined();
    expect((l2 as { betas?: string[] }).betas).toBeUndefined();
  });

  it("honours the env switches", () => {
    const off = buildParams({ cfg: loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: "0", ADVISOR_FALLBACKS: "0", ADVISOR_EFFORT: "high", ADVISOR_MODEL: "claude-sonnet-5-5" }), tools: defs, system, messages, userId: "u", level: 0 });
    expect(JSON.stringify(off.tools)).not.toContain("strict");
    expect(off.fallbacks).toBeUndefined();
    expect(off.output_config).toEqual({ effort: "high" });
    expect(off.model).toBe("claude-sonnet-5-5");
  });
});

describe("classifyLlmError", () => {
  const apiErr = (status: number) => new Anthropic.APIError(status, undefined, "message that may quote the request", new Headers());

  it("maps status classes without keeping any text", () => {
    expect(classifyLlmError(apiErr(401))).toMatchObject({ kind: "auth", status: 401 });
    expect(classifyLlmError(apiErr(403)).kind).toBe("auth");
    expect(classifyLlmError(apiErr(429)).kind).toBe("overloaded");
    expect(classifyLlmError(apiErr(529)).kind).toBe("overloaded");
    expect(classifyLlmError(apiErr(400))).toMatchObject({ kind: "bad_request", status: 400 });
    expect(classifyLlmError(apiErr(500)).kind).toBe("upstream");
    expect(classifyLlmError(new Error("boom")).kind).toBe("upstream");
    expect(classifyLlmError(new Anthropic.APIUserAbortError()).kind).toBe("aborted");
    const abort = new Error("x");
    abort.name = "AbortError";
    expect(classifyLlmError(abort).kind).toBe("aborted");
    expect(classifyLlmError(apiErr(400)).message).not.toContain("quote");
  });
});

describe("degradation ladder", () => {
  it("steps strict -> fallbacks -> nothing, skipping what is not configured", () => {
    expect(nextDegradation(0, { strictTools: true, fallbacks: true })).toBe(1);
    expect(nextDegradation(1, { strictTools: true, fallbacks: true })).toBe(2);
    expect(nextDegradation(2, { strictTools: true, fallbacks: true })).toBeNull();
    expect(nextDegradation(0, { strictTools: false, fallbacks: true })).toBe(2);
    expect(nextDegradation(0, { strictTools: false, fallbacks: false })).toBeNull();
  });
});

function fakeClient(script: (params: Record<string, unknown>) => unknown): { client: AnthropicLike; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        stream(params) {
          calls.push(JSON.parse(JSON.stringify(params)) as Record<string, unknown>);
          const outcome = script(params as unknown as Record<string, unknown>);
          const listeners: ((d: string) => void)[] = [];
          const stream = {
            on(_e: "text", l: (d: string) => void) {
              listeners.push(l);
              return stream;
            },
            async finalMessage() {
              if (outcome instanceof Error) throw outcome;
              listeners.forEach((l) => l("hello"));
              return outcome as never;
            },
          };
          return stream;
        },
      },
    },
  };
  return { client, calls };
}

const okMessage = (iterations?: { type: string }[]) => ({
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  model: "claude-opus-5-5",
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 7, iterations: iterations ?? null },
});

describe("createAnthropicLlm", () => {
  const sorted = sortTools([mk("alpha_tool")]);
  const bad400 = () => new Anthropic.APIError(400, undefined, "schema", new Headers());

  it("maps usage and content, streams text, and detects a fallback-served response from usage.iterations", async () => {
    const { client } = fakeClient(() => okMessage([{ type: "message" }, { type: "fallback_message" }]));
    const llm = createAnthropicLlm({ cfg, tools: sorted, userId: "u", client });
    const chunks: string[] = [];
    const r = await llm.stream({ system, messages }, { onText: (d) => chunks.push(d), signal: new AbortController().signal });
    expect(chunks).toEqual(["hello"]);
    expect(r).toMatchObject({
      stopReason: "end_turn",
      model: "claude-opus-5-5",
      fallbackUsed: true,
      usage: { inputTokens: 10, cacheWriteTokens: 3, cacheReadTokens: 7, outputTokens: 5 },
    });
    const plain = await createAnthropicLlm({ cfg, tools: sorted, userId: "u", client: fakeClient(() => okMessage([{ type: "message" }])).client }).stream(
      { system, messages },
      { onText: () => undefined, signal: new AbortController().signal },
    );
    expect(plain.fallbackUsed).toBe(false);
  });

  it("on a 400 before any output it retries without strict, then without fallbacks, and remembers the level", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, calls } = fakeClient((p) => {
      const hasStrict = JSON.stringify(p.tools).includes("strict");
      const hasFallbacks = p.fallbacks !== undefined;
      return hasStrict || hasFallbacks ? bad400() : okMessage();
    });
    const llm = createAnthropicLlm({ cfg, tools: sorted, userId: "u", client });
    const r = await llm.stream({ system, messages }, { onText: () => undefined, signal: new AbortController().signal });
    expect(r.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(3);
    // the next request starts from the remembered level
    await llm.stream({ system, messages }, { onText: () => undefined, signal: new AbortController().signal });
    expect(calls).toHaveLength(4);
    expect(calls[3]!.fallbacks).toBeUndefined();
  });

  it("gives up with a mapped error when nothing is left to drop, and never leaks the API text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, calls } = fakeClient(() => bad400());
    const llm = createAnthropicLlm({ cfg: loadAdvisorConfig({ ADVISOR_STRICT_TOOLS: "0", ADVISOR_FALLBACKS: "0" }), tools: sorted, userId: "u", client });
    await expect(llm.stream({ system, messages }, { onText: () => undefined, signal: new AbortController().signal })).rejects.toMatchObject({ name: "LlmError", kind: "bad_request" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry non-400 errors", async () => {
    const { client, calls } = fakeClient(() => new Anthropic.APIError(529, undefined, "overloaded", new Headers()));
    const llm = createAnthropicLlm({ cfg, tools: sorted, userId: "u", client });
    await expect(llm.stream({ system, messages }, { onText: () => undefined, signal: new AbortController().signal })).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(1);
  });

  it("a missing API key is a neutral 'unavailable' error, not a crash", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const llm = createAnthropicLlm({ cfg, tools: sorted, userId: "u" });
      await expect(llm.stream({ system, messages }, { onText: () => undefined, signal: new AbortController().signal })).rejects.toMatchObject({ kind: "unavailable" });
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
