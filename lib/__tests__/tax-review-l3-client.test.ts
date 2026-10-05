import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmTransportError, parseAndValidate, runStructured, sha256Text, type LlmRequest, type LlmResponse, type LlmTransport } from "@/lib/tax-review/llm/client";
import { mapAnthropicError, transientStatus } from "@/lib/tax-review-anthropic";
import Anthropic from "@anthropic-ai/sdk";

// The LLM call wrapper (ai-return-reviewer, B1): validation, max_tokens, refusal, retry, abort, usage, hashes, no payload logging.
// A mock transport only: no live call is ever made from a test.

const schema = z.object({ findings: z.array(z.unknown()) }).strict();
const REQUEST: LlmRequest = { model: "mock-model", system: "SYSTEM SECRET-PAYLOAD", user: "USER SECRET-PAYLOAD 123456789", maxTokens: 100 };
const reply = (text: string, over: Partial<LlmResponse> = {}): LlmResponse => ({ text, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, model: "mock-model", ...over });
const sleepSpy = () => vi.fn(async () => undefined);

function transport(...steps: (LlmResponse | LlmTransportError | ((signal: AbortSignal) => Promise<LlmResponse>))[]): LlmTransport & { calls: number } {
  let i = 0;
  const t = {
    calls: 0,
    async send(_req: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      t.calls += 1;
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof LlmTransportError) throw step;
      if (typeof step === "function") return step(signal);
      if (step === undefined) throw new Error("no step");
      return step;
    },
  };
  return t;
}

afterEach(() => vi.restoreAllMocks());

describe("runStructured", () => {
  it("returns the validated value with usage, attempts, model and the response hash", async () => {
    const text = JSON.stringify({ findings: [] });
    const r = await runStructured({ transport: transport(reply(text)), request: REQUEST, schema });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ findings: [] });
      expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(r.attempts).toBe(1);
      expect(r.responseHash).toBe(sha256Text(text));
      expect(r.model).toBe("mock-model");
    }
  });
  it("tolerates a fenced or chatty reply", async () => {
    const r = await runStructured({ transport: transport(reply('Here you go:\n```json\n{"findings": []}\n```')), request: REQUEST, schema });
    expect(r.ok).toBe(true);
  });
  it("max_tokens is a FAILURE (never a truncated success) and is not retried", async () => {
    const t = transport(reply('{"findings": [', { stopReason: "max_tokens" }));
    const r = await runStructured({ transport: t, request: REQUEST, schema, sleep: sleepSpy() });
    expect(r).toMatchObject({ ok: false, kind: "max_tokens", attempts: 1 });
    expect(t.calls).toBe(1);
    // the tokens it cost are still counted
    if (!r.ok) expect(r.usage.outputTokens).toBe(5);
  });
  it("a refusal is a failure and is not retried", async () => {
    const t = transport(reply("", { stopReason: "refusal" }));
    expect(await runStructured({ transport: t, request: REQUEST, schema })).toMatchObject({ ok: false, kind: "refusal" });
    expect(t.calls).toBe(1);
  });
  it("malformed JSON is retried once, then fails (and both attempts' usage is counted)", async () => {
    const t = transport(reply("not json at all"));
    const r = await runStructured({ transport: t, request: REQUEST, schema, sleep: sleepSpy() });
    expect(r).toMatchObject({ ok: false, kind: "invalid_output", attempts: 2 });
    expect(t.calls).toBe(2);
    if (!r.ok) expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });
  it("output that parses but does not match the schema is invalid output (retried once)", async () => {
    const t = transport(reply('{"findings": [], "verdict": "passed"}'));
    expect(await runStructured({ transport: t, request: REQUEST, schema, sleep: sleepSpy() })).toMatchObject({ ok: false, kind: "invalid_output" });
    expect(t.calls).toBe(2);
  });
  it("a bad first answer followed by a good one succeeds on the retry", async () => {
    const t = transport(reply("oops"), reply('{"findings": []}'));
    const r = await runStructured({ transport: t, request: REQUEST, schema, sleep: sleepSpy() });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    if (r.ok) expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });
  it("transient errors are retried with doubling backoff, then give up", async () => {
    const sleep = sleepSpy();
    const t = transport(new LlmTransportError("transient", 529));
    const r = await runStructured({ transport: t, request: REQUEST, schema, sleep, backoffMs: 100, maxAttempts: 3 });
    expect(r).toMatchObject({ ok: false, kind: "transient", attempts: 3 });
    expect(t.calls).toBe(3);
    expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([100, 200]);
  });
  it("a transient error followed by success recovers", async () => {
    const t = transport(new LlmTransportError("transient", 429), reply('{"findings": []}'));
    expect(await runStructured({ transport: t, request: REQUEST, schema, sleep: sleepSpy() })).toMatchObject({ ok: true, attempts: 2 });
  });
  it("a fatal error (bad key, bad request) is not retried", async () => {
    const t = transport(new LlmTransportError("fatal", 401));
    expect(await runStructured({ transport: t, request: REQUEST, schema, sleep: sleepSpy() })).toMatchObject({ ok: false, kind: "fatal", attempts: 1 });
    expect(t.calls).toBe(1);
  });
  it("the caller's abort stops the call and is never retried", async () => {
    const controller = new AbortController();
    const t = transport((signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new LlmTransportError("aborted")))));
    const p = runStructured({ transport: t, request: REQUEST, schema, signal: controller.signal });
    controller.abort();
    expect(await p).toMatchObject({ ok: false, kind: "aborted" });
    expect(t.calls).toBe(1);
  });
  it("an already-aborted signal makes no call at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = transport(reply("{}"));
    expect(await runStructured({ transport: t, request: REQUEST, schema, signal: controller.signal })).toMatchObject({ ok: false, kind: "aborted", attempts: 0 });
    expect(t.calls).toBe(0);
  });
  it("a call that never answers times out (the per-attempt timer aborts it)", async () => {
    const t = transport((signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new LlmTransportError("aborted")))));
    const r = await runStructured({ transport: t, request: REQUEST, schema, timeoutMs: 20, maxAttempts: 1 });
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
  });
  it("never logs the prompt, the payload or the response, and keeps only the error class name", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const r1 = await runStructured({ transport: transport(reply("SECRET-RESPONSE not json")), request: REQUEST, schema, sleep: sleepSpy() });
    const r2 = await runStructured({ transport: transport(new LlmTransportError("transient", 500)), request: REQUEST, schema, sleep: sleepSpy(), maxAttempts: 2 });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const text = JSON.stringify([r1, r2]);
    expect(text).not.toMatch(/SECRET|123456789/);
    if (!r1.ok) expect(r1.detail).toBe("InvalidOutput");
    if (!r2.ok) expect(r2.detail).toBe("LlmTransportError");
  });
  it("sends no temperature: the request type has none and the wrapper adds none", async () => {
    let seen: LlmRequest | null = null;
    const t: LlmTransport = {
      async send(req) {
        seen = req;
        return reply('{"findings": []}');
      },
    };
    await runStructured({ transport: t, request: REQUEST, schema });
    expect(Object.keys(seen as unknown as Record<string, unknown>)).not.toContain("temperature");
    const src = readFileSync(path.join(process.cwd(), "lib", "tax-review-anthropic.ts"), "utf8");
    expect(src.replace(/\/\/.*$/gm, "")).not.toMatch(/temperature/);
  });
});

describe("parseAndValidate", () => {
  it("returns null for anything that is not valid JSON of the schema", () => {
    expect(parseAndValidate("", schema)).toBeNull();
    expect(parseAndValidate("{", schema)).toBeNull();
    expect(parseAndValidate('{"findings": 3}', schema)).toBeNull();
    expect(parseAndValidate('{"findings": []}', schema)).toEqual({ findings: [] });
  });
});

describe("Anthropic transport error mapping", () => {
  it("maps statuses: 408 / 409 / 429 / 5xx are transient, 4xx else are fatal; never keeps the message text", () => {
    for (const s of [408, 409, 429, 500, 502, 529]) expect(transientStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(transientStatus(s)).toBe(false);
    const e = new Anthropic.APIError(429, { error: { message: "SECRET-PAYLOAD" } }, "SECRET-PAYLOAD rate limit", new Headers());
    const m = mapAnthropicError(e);
    expect(m.kind).toBe("transient");
    expect(m.message).not.toMatch(/SECRET/);
    expect(mapAnthropicError(new Anthropic.APIError(401, {}, "x", new Headers())).kind).toBe("fatal");
    expect(mapAnthropicError(new Anthropic.APIUserAbortError()).kind).toBe("aborted");
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: "SECRET" })).kind).toBe("transient");
    expect(mapAnthropicError(new Error("SECRET")).kind).toBe("fatal");
  });
});
