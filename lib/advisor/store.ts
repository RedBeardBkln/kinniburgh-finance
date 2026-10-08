// DB-aware store for the assistant's own tables (plan sections 6 and 14 step 2.2). NO auth here: callers (the page, the actions, the route)
// check the session first and pass the user id. This is the ONLY advisor file that writes (the exclusion test pins it).
//
// Append-only rules, pinned by a source-reading test:
//   AdvisorMessage, AdvisorUsage  INSERT-ONLY (no update / upsert / delete anywhere).
//   AdvisorMemory                 append + archive (the only update sets archivedAt / archivedById / archivedByName / archiveKind); no delete.
//   AdvisorConversation           the only updates touch title / titleSource / messageCount / lastMessageAt / archivedAt; no delete.
// Every conversation or message read carries `userId` in its `where` (conversations are private to the user who created them).
// AuditLog rows for memory changes hold ids only (never the text).

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { LIMITS } from "@/lib/advisor/config";
import type { ToolCallRecord } from "@/lib/advisor/loop";
import type { MemoryDraft, MemoryNoteView } from "@/lib/advisor/memory";
import type { UsageTotals } from "@/lib/advisor/limits";

/** A turn whose user message has no reply yet counts as in flight for this long (the route's maxDuration is 60 s). */
export const STALE_TURN_MS = 120_000;

export function isMissingTableError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2021";
}

export type SafeRead<T> = { state: "ok"; value: T } | { state: "table_missing" } | { state: "error" };

/** Fail-soft reader for pages: an unapplied migration or any error becomes a state, never a throw (and never the error text). */
export async function safeRead<T>(load: () => Promise<T>): Promise<SafeRead<T>> {
  try {
    return { state: "ok", value: await load() };
  } catch (e) {
    if (isMissingTableError(e)) return { state: "table_missing" };
    console.error("advisor store read failed:", e instanceof Error ? e.name : "unknown error");
    return { state: "error" };
  }
}

// ── Conversations ────────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string;
  titleSource: string;
  messageCount: number;
  lastMessageAt: Date;
  createdAt: Date;
}

const CONVERSATION_SELECT = { id: true, title: true, titleSource: true, messageCount: true, lastMessageAt: true, createdAt: true } as const;

export async function createConversation(userId: string, title: string): Promise<{ id: string }> {
  return db.advisorConversation.create({ data: { userId, title }, select: { id: true } });
}

/** The caller's own, non-archived conversation; null for a missing, archived or someone else's id (no way to tell them apart). */
export async function getOwnConversation(userId: string, id: string): Promise<ConversationSummary | null> {
  return db.advisorConversation.findFirst({ where: { id, userId, archivedAt: null }, select: CONVERSATION_SELECT });
}

export async function listConversations(userId: string, take: number = LIMITS.listConversations): Promise<ConversationSummary[]> {
  return db.advisorConversation.findMany({
    where: { userId, archivedAt: null },
    orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
    take,
    select: CONVERSATION_SELECT,
  });
}

export async function renameConversation(userId: string, id: string, title: string): Promise<boolean> {
  const r = await db.advisorConversation.updateMany({ where: { id, userId, archivedAt: null }, data: { title, titleSource: "user" } });
  return r.count > 0;
}

/** Archive-only: the conversation and its messages stay in the database. */
export async function archiveConversation(userId: string, id: string): Promise<boolean> {
  const r = await db.advisorConversation.updateMany({ where: { id, userId, archivedAt: null }, data: { archivedAt: new Date() } });
  return r.count > 0;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface StoredMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason: string | null;
  createdAt: Date;
}

/** Compact tool-call records from the Json column; anything malformed is dropped, never trusted. */
export function parseToolCalls(json: unknown): ToolCallRecord[] {
  if (!Array.isArray(json)) return [];
  const out: ToolCallRecord[] = [];
  for (const raw of json.slice(0, 40)) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.ok !== "boolean") continue;
    out.push({
      name: r.name.slice(0, 64),
      argSummary: typeof r.argSummary === "string" ? r.argSummary.slice(0, 120) : "",
      ok: r.ok,
      rows: typeof r.rows === "number" ? r.rows : null,
      resultChars: typeof r.resultChars === "number" ? r.resultChars : 0,
      ms: typeof r.ms === "number" ? r.ms : 0,
    });
  }
  return out;
}

/** All messages of the caller's own conversation, oldest first (empty for someone else's or an archived one). */
export async function loadMessages(userId: string, conversationId: string): Promise<StoredMessage[]> {
  const rows = await db.advisorMessage.findMany({
    where: { conversationId, conversation: { userId, archivedAt: null } },
    orderBy: { seq: "asc" },
    take: LIMITS.maxConversationMessages + 5,
    select: { id: true, seq: true, role: true, text: true, toolCalls: true, stopReason: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    role: r.role === "assistant" ? "assistant" : "user",
    text: r.text,
    toolCalls: parseToolCalls(r.toolCalls),
    stopReason: r.stopReason,
    createdAt: r.createdAt,
  }));
}

export type AppendUserResult = { ok: true; id: string; seq: number } | { ok: false; reason: "not_found" | "busy" | "full" };

const isUniqueViolation = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Store the user's message. Refused as `busy` when the previous user message has no reply yet (a second tab sending while a turn is running)
 * or when two sends race for the same seq (unique index on (conversationId, seq)). Ownership is checked here too.
 */
export async function appendUserMessage(userId: string, conversationId: string, text: string, now: Date = new Date()): Promise<AppendUserResult> {
  const conv = await getOwnConversation(userId, conversationId);
  if (conv === null) return { ok: false, reason: "not_found" };
  if (conv.messageCount >= LIMITS.maxConversationMessages) return { ok: false, reason: "full" };
  const last = await db.advisorMessage.findFirst({ where: { conversationId }, orderBy: { seq: "desc" }, select: { seq: true, role: true, createdAt: true } });
  if (last !== null && last.role === "user" && now.getTime() - last.createdAt.getTime() < STALE_TURN_MS) return { ok: false, reason: "busy" };
  const seq = (last?.seq ?? 0) + 1;
  try {
    const [msg] = await db.$transaction([
      db.advisorMessage.create({ data: { conversationId, seq, role: "user", text }, select: { id: true } }),
      db.advisorConversation.updateMany({ where: { id: conversationId, userId }, data: { messageCount: { increment: 1 }, lastMessageAt: now } }),
    ]);
    return { ok: true, id: msg.id, seq };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "busy" };
    throw e;
  }
}

export interface AssistantMessageInput {
  conversationId: string;
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason: string;
  model: string | null;
}

/** Store the assistant's reply (also for partial / aborted / failed turns). Retries the seq once or twice if a racing insert took it. */
export async function appendAssistantMessage(input: AssistantMessageInput, now: Date = new Date()): Promise<{ id: string; seq: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.advisorMessage.findFirst({ where: { conversationId: input.conversationId }, orderBy: { seq: "desc" }, select: { seq: true } });
    const seq = (last?.seq ?? 0) + 1;
    try {
      const [msg] = await db.$transaction([
        db.advisorMessage.create({
          data: {
            conversationId: input.conversationId,
            seq,
            role: "assistant",
            text: input.text,
            toolCalls: input.toolCalls.length > 0 ? (input.toolCalls as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
            stopReason: input.stopReason,
            model: input.model,
          },
          select: { id: true },
        }),
        db.advisorConversation.updateMany({ where: { id: input.conversationId }, data: { messageCount: { increment: 1 }, lastMessageAt: now } }),
      ]);
      return { id: msg.id, seq };
    } catch (e) {
      if (!isUniqueViolation(e) || attempt === 2) throw e;
    }
  }
  throw new Error("unreachable");
}

// ── Usage (counts only) ──────────────────────────────────────────────────────

export interface UsageRowInput {
  userId: string;
  conversationId: string | null;
  model: string | null;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  iterations: number;
  toolCalls: number;
  fallbackUsed: boolean;
  outcome: string;
  durationMs: number;
}

export async function insertUsage(row: UsageRowInput): Promise<void> {
  await db.advisorUsage.create({ data: row, select: { id: true } });
}

/** Turns and fresh tokens since `since`, for one user and for the whole household. */
export async function sumUsageSince(userId: string, since: Date): Promise<{ user: UsageTotals; household: UsageTotals }> {
  const agg = (where: Prisma.AdvisorUsageWhereInput) =>
    db.advisorUsage.aggregate({ where, _count: { _all: true }, _sum: { inputTokens: true, cacheWriteTokens: true, outputTokens: true } });
  const [u, h] = await Promise.all([agg({ userId, at: { gte: since } }), agg({ at: { gte: since } })]);
  const totals = (r: Awaited<ReturnType<typeof agg>>): UsageTotals => ({
    turns: r._count._all,
    freshTokens: (r._sum.inputTokens ?? 0) + (r._sum.cacheWriteTokens ?? 0) + (r._sum.outputTokens ?? 0),
  });
  return { user: totals(u), household: totals(h) };
}

// ── Household memory ─────────────────────────────────────────────────────────

const MEMORY_SELECT = { id: true, text: true, category: true, createdByName: true, createdAt: true, source: true } as const;

/** Active (not forgotten) notes, oldest first. */
export async function listActiveMemory(): Promise<MemoryNoteView[]> {
  return db.advisorMemory.findMany({ where: { archivedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: LIMITS.maxActiveMemoryNotes + 10, select: MEMORY_SELECT });
}

export type AddMemoryResult = { ok: true; id: string } | { ok: false; error: string };

/** Append a validated note (the caller ran validateMemoryDraft). Writes one AuditLog row holding the memory id only. */
export async function addMemoryNote(draft: MemoryDraft, author: { id: string; firstName: string }, source: "panel" | "assistant" = "panel"): Promise<AddMemoryResult> {
  const active = await db.advisorMemory.count({ where: { archivedAt: null } });
  if (active >= LIMITS.maxActiveMemoryNotes) {
    return { ok: false, error: `There are already ${LIMITS.maxActiveMemoryNotes} notes. Forget one before adding another.` };
  }
  const id = randomUUID();
  await db.$transaction([
    db.advisorMemory.create({
      data: { id, text: draft.text, category: draft.category, source, createdById: author.id, createdByName: author.firstName },
      select: { id: true },
    }),
    db.auditLog.create({ data: { changedBy: author.id, changeType: "advisor_memory_add", before: Prisma.JsonNull, after: { memoryId: id } }, select: { id: true } }),
  ]);
  return { ok: true, id };
}

/** "Forget" = archive. The row stays; it just stops being shown to the model and in the panel. */
export async function forgetMemoryNote(id: string, by: { id: string; firstName: string }): Promise<boolean> {
  const r = await db.advisorMemory.updateMany({
    where: { id, archivedAt: null },
    data: { archivedAt: new Date(), archivedById: by.id, archivedByName: by.firstName, archiveKind: "forgotten" },
  });
  if (r.count === 0) return false;
  await db.auditLog.create({ data: { changedBy: by.id, changeType: "advisor_memory_forget", before: Prisma.JsonNull, after: { memoryId: id } }, select: { id: true } });
  return true;
}
