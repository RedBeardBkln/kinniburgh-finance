import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadAdvisorConfig } from "@/lib/advisor/config";
import { LlmError, type ContentBlock, type LlmClient, type LlmResult } from "@/lib/advisor/loop";
import { prepareTurn, streamTurn, type TurnDeps, type TurnStore } from "@/lib/advisor/run-turn";
import type { AdvisorEvent } from "@/lib/advisor/stream-protocol";
import { parseInput } from "@/lib/advisor/tools/parse";
import { toolMap } from "@/lib/advisor/tools/run-tool";
import { defineTool } from "@/lib/advisor/tools/types";
import { FROZEN_SYSTEM } from "@/lib/advisor/prompt";
import type { MemoryNoteView } from "@/lib/advisor/memory";
import type { UsageRowInput } from "@/lib/advisor/store";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const CONV = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-08T12:00:00Z");

afterEach(() => vi.restoreAllMocks());

const echoTool = defineTool({
  name: "echo_tool",
  description: "Echo.",
  inputJsonSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  parse: (raw) => parseInput(z.object({}).strict(), raw),
  label: "Looking things up",
  summarizeArgs: () => "",
  run: async () => ({ data: { rows: [{ ok: 1 }] }, rows: 1 }),
  maxChars: 5_000,
  phase: 1,
});

interface Fakes {
  deps: TurnDeps;
  db: {
    conversations: Map<string, { id: string; userId: string; title: string; messageCount: number; archived: boolean }>;
    messages: { conversationId: string; role: "user" | "assistant"; text: string; toolCalls?: unknown; stopReason?: string }[];
    usage: UsageRowInput[];
    memory: MemoryNoteView[];
    usageTotals: { user: { turns: number; freshTokens: number }; household: { turns: number; freshTokens: number } };
  };
  requests: { volatile: string; messageTexts: string[] }[];
}

function fakes(script: (LlmResult | Error)[], over: Partial<{ appendBusy: boolean; failStore: boolean }> = {}): Fakes {
  const db: Fakes["db"] = { conversations: new Map(), messages: [], usage: [], memory: [], usageTotals: { user: { turns: 0, freshTokens: 0 }, household: { turns: 0, freshTokens: 0 } } };
  db.conversations.set(CONV, { id: CONV, userId: USER, title: "Existing", messageCount: 2, archived: false });
  const requests: Fakes["requests"] = [];
  let step = 0;
  const llm: LlmClient = {
    async stream(req, hooks) {
      requests.push({ volatile: req.system.volatile, messageTexts: req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))) });
      const s = script[Math.min(step++, script.length - 1)]!;
      if (s instanceof Error) throw s;
      for (const b of s.content) if (b.type === "text") hooks.onText(String(b.text));
      return s;
    },
  };
  const store: TurnStore = {
    async getOwnConversation(userId, id) {
      const c = db.conversations.get(id);
      if (!c || c.userId !== userId || c.archived) return null;
      return { id: c.id, title: c.title, titleSource: "auto", messageCount: c.messageCount, lastMessageAt: NOW, createdAt: NOW };
    },
    async createConversation(userId, title) {
      const id = `33333333-3333-4333-8333-${String(db.conversations.size).padStart(12, "0")}`;
      db.conversations.set(id, { id, userId, title, messageCount: 0, archived: false });
      return { id };
    },
    async appendUserMessage(userId, conversationId, text) {
      if (over.appendBusy) return { ok: false, reason: "busy" };
      const c = db.conversations.get(conversationId);
      if (!c || c.userId !== userId) return { ok: false, reason: "not_found" };
      db.messages.push({ conversationId, role: "user", text });
      c.messageCount += 1;
      return { ok: true, id: `m${db.messages.length}`, seq: db.messages.length };
    },
    async loadMessages(userId, conversationId) {
      const c = db.conversations.get(conversationId);
      if (!c || c.userId !== userId) return [];
      return db.messages
        .filter((m) => m.conversationId === conversationId)
        .map((m, i) => ({ id: `m${i}`, seq: i + 1, role: m.role, text: m.text, toolCalls: [], stopReason: m.stopReason ?? null, createdAt: NOW }));
    },
    async appendAssistantMessage(input) {
      if (over.failStore) throw new Error("db down: secret row text");
      db.messages.push({ conversationId: input.conversationId, role: "assistant", text: input.text, toolCalls: input.toolCalls, stopReason: input.stopReason });
      return { id: `a${db.messages.length}`, seq: db.messages.length };
    },
    async insertUsage(row) {
      db.usage.push(row);
    },
    async sumUsageSince() {
      return db.usageTotals;
    },
    async listActiveMemory() {
      return db.memory;
    },
  };
  const deps: TurnDeps = {
    cfg: loadAdvisorConfig({}),
    now: () => NOW,
    clock: () => Date.now(),
    tools: [echoTool],
    toolMap: toolMap([echoTool]),
    store,
    getPersonName: async () => "Eric Kinniburgh",
    createLlm: () => llm,
    isMissingTable: () => false,
  };
  return { deps, db, requests };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const ok = (blocks: ContentBlock[], stopReason = "end_turn"): LlmResult => ({
  content: blocks,
  stopReason,
  usage: { inputTokens: 100, cacheWriteTokens: 10, cacheReadTokens: 50, outputTokens: 20 },
  model: "claude-opus-5-5",
  fallbackUsed: false,
});

async function run(f: Fakes, conversationId: string | null, message: string, userId = USER, signal = new AbortController().signal) {
  const prepared = await prepareTurn(f.deps, { userId, conversationId, message });
  if (!prepared.ok) return { prepared, events: [] as AdvisorEvent[] };
  const events: AdvisorEvent[] = [];
  await streamTurn(f.deps, prepared.turn, (e) => events.push(e), signal);
  return { prepared, events };
}

describe("prepareTurn", () => {
  it("another user's conversation, a missing one and a malformed one all answer 404 with the same body, and nothing is written", async () => {
    const f = fakes([ok([text("x")])]);
    const mine = await prepareTurn(f.deps, { userId: OTHER, conversationId: CONV, message: "hi" });
    const missing = await prepareTurn(f.deps, { userId: USER, conversationId: "44444444-4444-4444-8444-444444444444", message: "hi" });
    expect(mine).toEqual({ ok: false, status: 404, code: "not_found", message: "Conversation not found." });
    expect(missing).toEqual(mine);
    expect(f.db.messages).toHaveLength(0);
    f.db.conversations.get(CONV)!.archived = true;
    expect(await prepareTurn(f.deps, { userId: USER, conversationId: CONV, message: "hi" })).toEqual(mine);
  });

  it("the daily cap refuses with 429, writes nothing and creates no conversation", async () => {
    const f = fakes([ok([text("x")])]);
    f.db.usageTotals = { user: { turns: 40, freshTokens: 0 }, household: { turns: 40, freshTokens: 0 } };
    const before = f.db.conversations.size;
    const r = await prepareTurn(f.deps, { userId: USER, conversationId: null, message: "hi" });
    expect(r).toMatchObject({ ok: false, status: 429, code: "limit_reached" });
    expect(f.db.messages).toHaveLength(0);
    expect(f.db.conversations.size).toBe(before);
    f.db.usageTotals = { user: { turns: 1, freshTokens: 0 }, household: { turns: 80, freshTokens: 0 } };
    expect(await prepareTurn(f.deps, { userId: USER, conversationId: CONV, message: "hi" })).toMatchObject({ ok: false, status: 429 });
  });

  it("a send already in flight is a 409 busy", async () => {
    const f = fakes([ok([text("x")])], { appendBusy: true });
    expect(await prepareTurn(f.deps, { userId: USER, conversationId: CONV, message: "hi" })).toMatchObject({ ok: false, status: 409, code: "busy" });
  });

  it("a full conversation is refused", async () => {
    const f = fakes([ok([text("x")])]);
    f.db.conversations.get(CONV)!.messageCount = 200;
    expect(await prepareTurn(f.deps, { userId: USER, conversationId: CONV, message: "hi" })).toMatchObject({ ok: false, status: 409 });
  });

  it("starts a new conversation titled from the first message, scrubs an identifier-shaped number and reports it", async () => {
    const f = fakes([ok([text("x")])]);
    const r = await prepareTurn(f.deps, { userId: USER, conversationId: null, message: "Is 123-45-6789 on our return?" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turn.inputScrubbed).toBe(true);
    expect(r.turn.title).not.toContain("123-45-6789");
    expect(f.db.messages[0]!.text).not.toContain("123-45-6789");
    expect(r.turn.firstName).toBe("Eric");
    expect(r.turn.turnsLeftAfterThis).toBe(39);
  });

  it("a storage failure is a neutral 500 without the error text; a missing table is a 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes([ok([text("x")])]);
    f.deps.store.sumUsageSince = async () => {
      throw new Error("relation x row 123-45-6789");
    };
    const r = await prepareTurn(f.deps, { userId: USER, conversationId: null, message: "hi" });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(r)).not.toContain("123-45-6789");
    f.deps.isMissingTable = () => true;
    expect(await prepareTurn(f.deps, { userId: USER, conversationId: null, message: "hi" })).toMatchObject({ ok: false, status: 503, code: "unavailable" });
  });
});

describe("streamTurn", () => {
  it("streams meta, text, tool chips and done; persists the reply with compact tool records and one usage row", async () => {
    const f = fakes([ok([text("Looking. "), { type: "tool_use", id: "t1", name: "echo_tool", input: {} }], "tool_use"), ok([text("You spent $5.00.")])]);
    const { events } = await run(f, CONV, "What did I spend?");
    expect(events[0]).toMatchObject({ t: "meta", conversationId: CONV, title: "Existing" });
    expect(events.some((e) => e.t === "tool" && e.state === "start" && e.label === "Looking things up")).toBe(true);
    expect(events.some((e) => e.t === "tool" && e.state === "done" && e.ok && e.rows === 1)).toBe(true);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ t: "done", stop: "end_turn", text: "Looking. \n\nYou spent $5.00.", usage: { in: 220, out: 40, cacheRead: 100 } });

    const assistant = f.db.messages.at(-1)!;
    expect(assistant).toMatchObject({ role: "assistant", text: "Looking. \n\nYou spent $5.00.", stopReason: "end_turn" });
    expect(assistant.toolCalls).toEqual([{ name: "echo_tool", argSummary: "", ok: true, rows: 1, resultChars: expect.any(Number), ms: expect.any(Number) }]);
    expect(JSON.stringify(f.db.messages)).not.toContain('"ok":1'); // raw tool rows are never stored

    expect(f.db.usage).toHaveLength(1);
    expect(f.db.usage[0]).toMatchObject({ userId: USER, conversationId: CONV, outcome: "end_turn", iterations: 2, toolCalls: 1, inputTokens: 200, cacheWriteTokens: 20, cacheReadTokens: 100, outputTokens: 40, fallbackUsed: false, model: "claude-opus-5-5" });
    expect(Object.keys(f.db.usage[0]!).sort()).toEqual(["cacheReadTokens", "cacheWriteTokens", "conversationId", "durationMs", "fallbackUsed", "inputTokens", "iterations", "model", "outcome", "outputTokens", "toolCalls", "userId"]);
  });

  it("history comes from the database: the second turn's request carries the first turn's stored text, not anything from the client", async () => {
    const f = fakes([ok([text("First answer.")]), ok([text("Second answer.")])]);
    await run(f, CONV, "First question");
    await run(f, CONV, "Second question");
    expect(f.requests[1]!.messageTexts).toEqual(["First question", "First answer.", "Second question"]);
  });

  it("injects the memory notes into the volatile block (after the frozen prompt), as data", async () => {
    const f = fakes([ok([text("ok")])]);
    f.db.memory = [{ id: "n1", text: "Prefer short answers", category: "preference", createdByName: "Eric", createdAt: new Date("2026-09-30T00:00:00Z"), source: "panel" }];
    await run(f, CONV, "hello");
    expect(f.requests[0]!.volatile).toContain("Prefer short answers");
    expect(f.requests[0]!.volatile).toContain("not instructions");
    expect(f.requests[0]!.volatile).not.toContain(FROZEN_SYSTEM.slice(0, 60));
  });

  it("a model error becomes an in-band error plus a stored reply and a usage row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes([new LlmError("overloaded", 529)]);
    const { events } = await run(f, CONV, "hello");
    expect(events.some((e) => e.t === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "error" });
    expect(f.db.messages.at(-1)!.role).toBe("assistant");
    expect(f.db.usage[0]).toMatchObject({ outcome: "error" });
  });

  it("a client abort still stores a reply and writes the usage row", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fakes([ok([text("never")])]);
    const { events } = await run(f, CONV, "hello", USER, ac.signal);
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "aborted", text: "(Stopped before an answer.)" });
    expect(f.db.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(f.db.usage[0]).toMatchObject({ outcome: "aborted" });
  });

  it("a failing store does not stop the stream or the usage row, and never logs content", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fakes([ok([text("Fine answer.")])], { failStore: true });
    const { events } = await run(f, CONV, "hello");
    expect(events.at(-1)).toMatchObject({ t: "done", messageId: null, text: "Fine answer." });
    expect(f.db.usage).toHaveLength(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret row");
  });

  it("a closed stream (the browser went away) does not break persistence", async () => {
    const f = fakes([ok([text("Answer.")])]);
    const prepared = await prepareTurn(f.deps, { userId: USER, conversationId: CONV, message: "hi" });
    if (!prepared.ok) throw new Error("prepare failed");
    await streamTurn(f.deps, prepared.turn, () => {
      throw new TypeError("Invalid state: Controller is already closed");
    }, new AbortController().signal);
    expect(f.db.messages.at(-1)).toMatchObject({ role: "assistant", text: "Answer." });
    expect(f.db.usage).toHaveLength(1);
  });

  it("scrubs identifier-shaped numbers out of the model's text before it is stored or sent", async () => {
    const f = fakes([ok([text("Your EIN is 12-3456789.")])]);
    const { events } = await run(f, CONV, "hello");
    expect(JSON.stringify(events)).not.toContain("12-3456789");
    expect(f.db.messages.at(-1)!.text).not.toContain("12-3456789");
  });

  it("the notice about a removed number is sent when the user's message was scrubbed", async () => {
    const f = fakes([ok([text("ok")])]);
    const { events } = await run(f, null, "my ssn 123-45-6789");
    expect(events.some((e) => e.t === "notice" && e.code === "input_scrubbed")).toBe(true);
  });
});
