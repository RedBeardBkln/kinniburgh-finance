import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Prisma } from "@prisma/client";

// Store + actions of the assistant: behaviour against a mocked db (no database is ever touched) and source-reading pins for auth, ownership
// and the append-only rules (advisor-ai-chatbot plan sections 6 and 17).

const mockAuth = vi.fn();
const d = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    advisorConversation: { create: fn(), findFirst: fn(), findMany: fn(), updateMany: fn() },
    advisorMessage: { create: fn(), findFirst: fn(), findMany: fn() },
    advisorMemory: { create: fn(), findMany: fn(), count: fn(), updateMany: fn() },
    advisorUsage: { create: fn(), aggregate: fn() },
    auditLog: { create: fn() },
    user: { findFirst: fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  };
});

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: d }));

import * as actions from "@/actions/advisor";
import * as store from "@/lib/advisor/store";

const U1 = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-08T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  d.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  mockAuth.mockResolvedValue({ user: { id: U1 } });
});

const uniqueViolation = () => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });

describe("appendUserMessage", () => {
  const conv = { id: C1, title: "t", titleSource: "auto", messageCount: 2, lastMessageAt: NOW, createdAt: NOW };

  it("not found for a missing / archived / someone else's conversation, and the lookup carries the user id and archivedAt:null", async () => {
    d.advisorConversation.findFirst.mockResolvedValue(null);
    expect(await store.appendUserMessage(U1, C1, "hi", NOW)).toEqual({ ok: false, reason: "not_found" });
    expect(d.advisorConversation.findFirst.mock.calls[0]![0].where).toEqual({ id: C1, userId: U1, archivedAt: null });
    expect(d.advisorMessage.create).not.toHaveBeenCalled();
  });

  it("refuses when the previous user message has no reply yet (a second tab), accepts it once stale", async () => {
    d.advisorConversation.findFirst.mockResolvedValue(conv);
    d.advisorMessage.findFirst.mockResolvedValue({ seq: 4, role: "user", createdAt: new Date(NOW.getTime() - 30_000) });
    expect(await store.appendUserMessage(U1, C1, "hi", NOW)).toEqual({ ok: false, reason: "busy" });
    d.advisorMessage.findFirst.mockResolvedValue({ seq: 4, role: "user", createdAt: new Date(NOW.getTime() - store.STALE_TURN_MS - 1) });
    d.advisorMessage.create.mockResolvedValue({ id: "m5" });
    d.advisorConversation.updateMany.mockResolvedValue({ count: 1 });
    expect(await store.appendUserMessage(U1, C1, "hi", NOW)).toEqual({ ok: true, id: "m5", seq: 5 });
  });

  it("assigns seq = last + 1, bumps the counters in the same transaction, and maps a unique violation to busy", async () => {
    d.advisorConversation.findFirst.mockResolvedValue(conv);
    d.advisorMessage.findFirst.mockResolvedValue({ seq: 2, role: "assistant", createdAt: NOW });
    d.advisorMessage.create.mockResolvedValue({ id: "m3" });
    d.advisorConversation.updateMany.mockResolvedValue({ count: 1 });
    expect(await store.appendUserMessage(U1, C1, "hi", NOW)).toEqual({ ok: true, id: "m3", seq: 3 });
    expect(d.advisorMessage.create.mock.calls[0]![0].data).toEqual({ conversationId: C1, seq: 3, role: "user", text: "hi" });
    expect(d.advisorConversation.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: C1, userId: U1 }, data: { messageCount: { increment: 1 } } });
    expect(d.$transaction).toHaveBeenCalledTimes(1);

    d.advisorMessage.create.mockRejectedValue(uniqueViolation());
    expect(await store.appendUserMessage(U1, C1, "hi", NOW)).toEqual({ ok: false, reason: "busy" });
  });

  it("refuses a full conversation (200 messages)", async () => {
    d.advisorConversation.findFirst.mockResolvedValue({ ...conv, messageCount: 200 });
    expect(await store.appendUserMessage(U1, C1, "hi", NOW)).toEqual({ ok: false, reason: "full" });
  });
});

describe("appendAssistantMessage", () => {
  it("retries the seq when a racing insert took it, stores compact tool records, and gives up after three tries", async () => {
    d.advisorMessage.findFirst.mockResolvedValue({ seq: 6 });
    d.advisorMessage.create.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce({ id: "a8" });
    d.advisorConversation.updateMany.mockResolvedValue({ count: 1 });
    const out = await store.appendAssistantMessage({ conversationId: C1, text: "answer", toolCalls: [{ name: "x", argSummary: "", ok: true, rows: 1, resultChars: 10, ms: 5 }], stopReason: "end_turn", model: "m" });
    expect(out.id).toBe("a8");
    expect(d.advisorMessage.create).toHaveBeenCalledTimes(2);
    expect(d.advisorMessage.create.mock.calls[1]![0].data).toMatchObject({ role: "assistant", stopReason: "end_turn", toolCalls: [{ name: "x" }] });

    d.advisorMessage.create.mockReset();
    d.advisorMessage.create.mockRejectedValue(uniqueViolation());
    await expect(store.appendAssistantMessage({ conversationId: C1, text: "a", toolCalls: [], stopReason: "end_turn", model: null })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(d.advisorMessage.create).toHaveBeenCalledTimes(3);
  });
});

describe("conversation reads are scoped to the user", () => {
  it("list, get, load, rename and archive all put the user id in the where clause", async () => {
    d.advisorConversation.findMany.mockResolvedValue([]);
    d.advisorMessage.findMany.mockResolvedValue([]);
    d.advisorConversation.updateMany.mockResolvedValue({ count: 0 });
    await store.listConversations(U1);
    await store.loadMessages(U1, C1);
    expect(await store.renameConversation(U1, C1, "T")).toBe(false);
    expect(await store.archiveConversation(U1, C1)).toBe(false);
    expect(d.advisorConversation.findMany.mock.calls[0]![0].where).toEqual({ userId: U1, archivedAt: null });
    expect(d.advisorMessage.findMany.mock.calls[0]![0].where).toEqual({ conversationId: C1, conversation: { userId: U1, archivedAt: null } });
    expect(d.advisorConversation.updateMany.mock.calls[0]![0].where).toEqual({ id: C1, userId: U1, archivedAt: null });
    expect(d.advisorConversation.updateMany.mock.calls[1]![0]).toMatchObject({ where: { id: C1, userId: U1, archivedAt: null }, data: { archivedAt: expect.any(Date) } });
  });

  it("parseToolCalls drops malformed records and clips", () => {
    expect(store.parseToolCalls(null)).toEqual([]);
    expect(store.parseToolCalls([{ name: "a", ok: true }, { name: 5 }, null, { name: "b", ok: false, rows: 3, argSummary: "x".repeat(500) }]).map((t) => [t.name, t.argSummary.length])).toEqual([["a", 0], ["b", 120]]);
  });
});

describe("usage totals", () => {
  it("sums turns and fresh tokens (no cache reads) for the user and the household", async () => {
    d.advisorUsage.aggregate
      .mockResolvedValueOnce({ _count: { _all: 3 }, _sum: { inputTokens: 100, cacheWriteTokens: 20, outputTokens: 30 } })
      .mockResolvedValueOnce({ _count: { _all: 5 }, _sum: { inputTokens: null, cacheWriteTokens: null, outputTokens: null } });
    const t = await store.sumUsageSince(U1, NOW);
    expect(t).toEqual({ user: { turns: 3, freshTokens: 150 }, household: { turns: 5, freshTokens: 0 } });
    expect(d.advisorUsage.aggregate.mock.calls[0]![0].where).toEqual({ userId: U1, at: { gte: NOW } });
    expect(d.advisorUsage.aggregate.mock.calls[1]![0].where).toEqual({ at: { gte: NOW } });
  });
});

describe("memory", () => {
  it("adds a note with an id-only audit row; the text is never in the audit row", async () => {
    d.advisorMemory.count.mockResolvedValue(3);
    d.advisorMemory.create.mockResolvedValue({ id: "x" });
    d.auditLog.create.mockResolvedValue({ id: "a" });
    const r = await store.addMemoryNote({ text: "Prefer short answers", category: "preference" }, { id: U1, firstName: "Eric" });
    expect(r.ok).toBe(true);
    const audit = d.auditLog.create.mock.calls[0]![0].data;
    expect(audit.changeType).toBe("advisor_memory_add");
    expect(JSON.stringify(audit)).not.toContain("Prefer short");
    expect(Object.keys(audit.after)).toEqual(["memoryId"]);
    expect(d.advisorMemory.create.mock.calls[0]![0].data).toMatchObject({ createdById: U1, createdByName: "Eric", source: "panel" });
  });

  it("refuses the 51st active note", async () => {
    d.advisorMemory.count.mockResolvedValue(50);
    const r = await store.addMemoryNote({ text: "x", category: "other" }, { id: U1, firstName: "Eric" });
    expect(r.ok).toBe(false);
    expect(d.advisorMemory.create).not.toHaveBeenCalled();
  });

  it("forget archives (never deletes), records who, and audits only when something changed", async () => {
    d.advisorMemory.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    d.auditLog.create.mockResolvedValue({ id: "a" });
    expect(await store.forgetMemoryNote("n1", { id: U1, firstName: "Eva" })).toBe(true);
    expect(d.advisorMemory.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: "n1", archivedAt: null },
      data: { archivedAt: expect.any(Date), archivedById: U1, archivedByName: "Eva", archiveKind: "forgotten" },
    });
    expect(d.auditLog.create.mock.calls[0]![0].data.after).toEqual({ memoryId: "n1" });
    expect(await store.forgetMemoryNote("n1", { id: U1, firstName: "Eva" })).toBe(false);
    expect(d.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("safeRead turns a missing table into a state and never leaks the error", async () => {
    const missing = new Prisma.PrismaClientKnownRequestError("table x does not exist", { code: "P2021", clientVersion: "x" });
    expect(await store.safeRead(async () => Promise.reject(missing))).toEqual({ state: "table_missing" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await store.safeRead(async () => Promise.reject(new Error("secret row"))).then((r) => JSON.stringify(r))).toBe('{"state":"error"}');
  });
});

describe("actions", () => {
  it("throw without a session and touch nothing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(actions.listMyConversations()).rejects.toThrow("Unauthorized");
    await expect(actions.addMemoryNote("x", "other")).rejects.toThrow("Unauthorized");
    await expect(actions.forgetMemoryNote(C1)).rejects.toThrow("Unauthorized");
    for (const m of [d.advisorConversation.findMany, d.advisorMemory.create, d.advisorMemory.updateMany]) expect(m).not.toHaveBeenCalled();
  });

  it("another user's or malformed conversation id looks exactly like a missing one", async () => {
    d.advisorConversation.findFirst.mockResolvedValue(null);
    expect(await actions.getMyConversation(C1)).toBeNull();
    expect(await actions.getMyConversation("not-a-uuid")).toBeNull();
    d.advisorConversation.updateMany.mockResolvedValue({ count: 0 });
    expect(await actions.renameConversation(C1, "New")).toEqual({ ok: false, error: "Conversation not found." });
    expect(await actions.archiveConversation(C1)).toEqual({ ok: false, error: "Conversation not found." });
    expect(await actions.renameConversation("bad", "New")).toEqual({ ok: false, error: "Conversation not found." });
    expect(d.advisorConversation.findFirst.mock.calls[0]![0].where).toEqual({ id: C1, userId: U1, archivedAt: null });
  });

  it("rename scrubs the title; an empty title is refused before the db", async () => {
    d.advisorConversation.updateMany.mockResolvedValue({ count: 1 });
    expect(await actions.renameConversation(C1, "  ")).toEqual({ ok: false, error: "Type a title." });
    expect(d.advisorConversation.updateMany).not.toHaveBeenCalled();
    expect(await actions.renameConversation(C1, "Taxes 123-45-6789")).toEqual({ ok: true });
    expect(d.advisorConversation.updateMany.mock.calls[0]![0].data.title).not.toContain("123-45-6789");
  });

  it("addMemoryNote rejects an identifier-like note before any database call and never echoes it", async () => {
    const r = await actions.addMemoryNote("my ssn is 123-45-6789", "household");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("123-45-6789");
    expect(d.advisorMemory.count).not.toHaveBeenCalled();
    expect((await actions.addMemoryNote("fine note", "bogus")).ok).toBe(false);
  });

  it("addMemoryNote attributes the note to the signed-in person's first name", async () => {
    d.user.findFirst.mockResolvedValue({ id: U1, name: "Eva-Laura Ramirez" });
    d.advisorMemory.count.mockResolvedValue(0);
    d.advisorMemory.create.mockResolvedValue({ id: "n" });
    d.auditLog.create.mockResolvedValue({ id: "a" });
    expect(await actions.addMemoryNote("Prefer short answers", "preference")).toEqual({ ok: true });
    expect(d.advisorMemory.create.mock.calls[0]![0].data.createdByName).toBe("Eva-Laura");
    expect(d.user.findFirst.mock.calls[0]![0].select).toEqual({ id: true, name: true });
  });
});

// ── source-reading pins ──────────────────────────────────────────────────────

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".claude" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");

describe("source pins", () => {
  const actionsSrc = stripComments(read(join(ROOT, "actions/advisor.ts")));

  it("every export of actions/advisor.ts starts with const user = await requireAuth() or await requireAuth()", () => {
    const parts = actionsSrc.split(/\nexport async function /).slice(1);
    expect(parts.length).toBe(8); // + confirmMemorySuggestion (Phase 2)
    for (const body of parts) {
      const open = body.indexOf("{\n") + 2;
      const first = body.slice(open, open + 60).trimStart();
      expect(/^(const user = )?await requireAuth\(\);/.test(first), body.slice(0, 40)).toBe(true);
    }
    expect(actionsSrc).toMatch(/\nasync function requireAuth\(\): Promise<\{ id: string \}> \{/);
    expect(actionsSrc).not.toMatch(/export (async )?function requireAuth/);
  });

  it("every conversation / message read or write in the store carries userId (or goes through a userId-checked lookup)", () => {
    const src = stripComments(read(join(ROOT, "lib/advisor/store.ts")));
    const calls = [...src.matchAll(/db\.advisorConversation\.(findFirst|findMany|updateMany)\(\{([\s\S]*?)\}\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(6); // not vacuous
    for (const m of calls) {
      const call = m[0];
      if (call.includes("id: conversationId") || call.includes("id: input.conversationId")) continue; // post-ownership counter bumps
      expect(call, call.slice(0, 80)).toMatch(/\buserId\b/);
    }
    expect(src).toMatch(/conversation: \{ userId, archivedAt: null \}/);
  });

  it("append-only: no update / upsert / delete on messages or usage; memory is never deleted; conversations are never deleted", () => {
    const files = ["lib", "actions", "app", "components", "scripts"].flatMap((dir) => {
      try {
        return walk(join(ROOT, dir));
      } catch {
        return [];
      }
    }).filter((p) => !p.includes(`${sep}__tests__${sep}`));
    expect(files.length).toBeGreaterThan(300);
    for (const p of files) {
      const src = stripComments(read(p));
      const f = relative(ROOT, p).split(sep).join("/");
      expect(/advisorMessage\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(src), f).toBe(false);
      expect(/advisorUsage\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(src), f).toBe(false);
      expect(/advisorMemory\s*\.\s*(delete|deleteMany|upsert)\b/.test(src), f).toBe(false);
      expect(/advisorConversation\s*\.\s*(delete|deleteMany|upsert)\b/.test(src), f).toBe(false);
    }
  });

  it("the memory update only archives; conversation updates only touch the allowed columns", () => {
    const src = stripComments(read(join(ROOT, "lib/advisor/store.ts")));
    const memUpdates = [...src.matchAll(/advisorMemory\.updateMany\(\{([\s\S]*?)\n  \}\)/g)];
    expect(memUpdates).toHaveLength(1);
    expect(memUpdates[0]![1]).toMatch(/data: \{ archivedAt: new Date\(\), archivedById: by\.id, archivedByName: by\.firstName, archiveKind: "forgotten" \}/);
    const convUpdates = [...src.matchAll(/advisorConversation\.updateMany\(\{[\s\S]*?data: (\{[^}]*(?:\{[^}]*\}[^}]*)?\})/g)];
    expect(convUpdates.length).toBe(4);
    for (const m of convUpdates) {
      const keys = [...m[1]!.matchAll(/\b(\w+):/g)].map((k) => k[1]!).filter((k) => !["increment"].includes(k));
      for (const k of keys) expect(["title", "titleSource", "messageCount", "lastMessageAt", "archivedAt"], `data key ${k}`).toContain(k);
    }
  });

  it("the store and actions never read an excluded model", () => {
    const all = stripComments(read(join(ROOT, "lib/advisor/store.ts")) + read(join(ROOT, "actions/advisor.ts")));
    expect(/\bdb\.(vault\w*|plaidItem|session|passwordResetToken|pushSubscription|reviewLinkToken)\b/.test(all)).toBe(false);
  });
});
