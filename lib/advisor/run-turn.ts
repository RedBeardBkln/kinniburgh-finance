// One chat request, end to end (plan sections 7-9): the checks that return plain HTTP statuses (prepareTurn), then the streamed turn
// (streamTurn). The route (app/api/advisor/chat/route.ts) authenticates and validates the request first and calls these two functions; this file
// has no auth of its own and takes every collaborator through `TurnDeps`, so tests run it with fakes and no database or API.
//
// Order of checks (after the route's own auth, same-origin, content-type, size and shape checks):
//   ownership of the conversation (404, same body for missing / archived / someone else's) -> daily caps (429) -> new conversation ->
//   store the user message (409 when another send is in flight) -> stream.
// Nothing is written for a refused request. A usage row (counts only) is written in a `finally` for every streamed turn.
// Never logs prompts, tool results or message text: console.error carries a class name only.

import { LIMITS, type AdvisorConfig } from "@/lib/advisor/config";
import { buildReplay, type StoredTurn } from "@/lib/advisor/history";
import { checkLimits, windowStart } from "@/lib/advisor/limits";
import { runTurn, type LlmClient, type TurnOutcome } from "@/lib/advisor/loop";
import { buildMemoryBlock, type MemoryNoteView } from "@/lib/advisor/memory";
import { firstNameOf } from "@/lib/advisor/names";
import { describePageContext, parsePageContext } from "@/lib/advisor/page-context";
import { buildVolatileBlock, FROZEN_SYSTEM } from "@/lib/advisor/prompt";
import { redactUserText } from "@/lib/advisor/scrub";
import type { AdvisorEvent, ErrorCode } from "@/lib/advisor/stream-protocol";
import type { AppendUserResult, ConversationSummary, StoredMessage, UsageRowInput } from "@/lib/advisor/store";
import { deriveTitle } from "@/lib/advisor/titles";
import { newTurnBudget } from "@/lib/advisor/tools/run-tool";
import type { RegisteredTool } from "@/lib/advisor/tools/types";
import type { UsageTotals } from "@/lib/advisor/limits";

export interface TurnStore {
  getOwnConversation(userId: string, id: string): Promise<ConversationSummary | null>;
  createConversation(userId: string, title: string): Promise<{ id: string }>;
  appendUserMessage(userId: string, conversationId: string, text: string, now?: Date): Promise<AppendUserResult>;
  loadMessages(userId: string, conversationId: string): Promise<StoredMessage[]>;
  appendAssistantMessage(input: { conversationId: string; text: string; toolCalls: TurnOutcome["toolCalls"]; stopReason: string; model: string | null }, now?: Date): Promise<{ id: string; seq: number }>;
  insertUsage(row: UsageRowInput): Promise<void>;
  sumUsageSince(userId: string, since: Date): Promise<{ user: UsageTotals; household: UsageTotals }>;
  listActiveMemory(): Promise<MemoryNoteView[]>;
}

export interface TurnDeps {
  cfg: AdvisorConfig;
  now: () => Date;
  clock: () => number;
  /** Sorted, byte-stable tool list. */
  tools: readonly RegisteredTool[];
  toolMap: ReadonlyMap<string, RegisteredTool>;
  store: TurnStore;
  getPersonName(userId: string): Promise<string | null>;
  createLlm(userId: string): LlmClient;
  isMissingTable(e: unknown): boolean;
}

export type PrepareFailure = { ok: false; status: 400 | 404 | 409 | 429 | 500 | 503; code: ErrorCode; message: string };

export interface PreparedTurn {
  userId: string;
  firstName: string;
  conversationId: string;
  userMessageId: string;
  title: string;
  turnsLeftAfterThis: number;
  inputScrubbed: boolean;
  /** Fresh tokens used by this user in the last 24 hours BEFORE this turn (the usage line). */
  tokens24hBefore?: number;
  /** The server's own one-sentence description of the page (null / absent when the path is unknown or /advisor). Never client text. */
  pageContext?: string | null;
}

const NOT_FOUND: PrepareFailure = { ok: false, status: 404, code: "not_found", message: "Conversation not found." };

export async function prepareTurn(
  deps: TurnDeps,
  input: { userId: string; conversationId: string | null; message: string; pageContext?: string | null },
): Promise<{ ok: true; turn: PreparedTurn } | PrepareFailure> {
  try {
    const now = deps.now();
    const cleaned = redactUserText(input.message);
    if (cleaned.text === "") return { ok: false, status: 400, code: "invalid", message: "Type a message of 1 to 4000 characters." };

    // (4) ownership: the same 404 for a missing, archived or someone else's conversation
    let existing: ConversationSummary | null = null;
    if (input.conversationId !== null) {
      existing = await deps.store.getOwnConversation(input.userId, input.conversationId);
      if (existing === null) return NOT_FOUND;
      // (5) conversation size cap
      if (existing.messageCount >= LIMITS.maxConversationMessages) {
        return { ok: false, status: 409, code: "invalid", message: "This conversation is full; start a new chat." };
      }
    }

    // (6) daily caps (before anything is written)
    const totals = await deps.store.sumUsageSince(input.userId, windowStart(now));
    const decision = checkLimits(deps.cfg, totals.user, totals.household);
    if (!decision.ok) return { ok: false, status: 429, code: "limit_reached", message: decision.message };

    const person = await deps.getPersonName(input.userId);
    const firstName = firstNameOf(person);
    let conversationId: string;
    let title: string;
    if (existing !== null) {
      conversationId = existing.id;
      title = existing.title;
    } else {
      title = deriveTitle(cleaned.text);
      conversationId = (await deps.store.createConversation(input.userId, title)).id;
    }

    // (7) store the user message; a send already in flight for this conversation is refused
    const stored = await deps.store.appendUserMessage(input.userId, conversationId, cleaned.text.slice(0, LIMITS.storedUserChars), now);
    if (!stored.ok) {
      if (stored.reason === "busy") return { ok: false, status: 409, code: "busy", message: "Another question in this conversation is still being answered. Wait for it to finish, then try again." };
      if (stored.reason === "full") return { ok: false, status: 409, code: "invalid", message: "This conversation is full; start a new chat." };
      return NOT_FOUND;
    }
    return {
      ok: true,
      turn: {
        userId: input.userId,
        firstName,
        conversationId,
        userMessageId: stored.id,
        title,
        turnsLeftAfterThis: Math.max(0, decision.turnsLeft - 1),
        inputScrubbed: cleaned.changed,
        tokens24hBefore: totals.user.freshTokens,
        pageContext: pageSentence(input.pageContext),
      },
    };
  } catch (e) {
    console.error("advisor prepare failed:", e instanceof Error ? e.name : "unknown error");
    if (deps.isMissingTable(e)) return { ok: false, status: 503, code: "unavailable", message: "The assistant's storage has not been set up yet." };
    return { ok: false, status: 500, code: "upstream", message: "Something went wrong. Nothing was changed; please try again." };
  }
}

/** The page sentence for the prompt, from the client's pathname re-parsed against the closed table (null when unknown or the Advisor page itself). */
function pageSentence(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const ctx = parsePageContext(path);
  return ctx === null ? null : describePageContext(ctx);
}

function usageOf(o: TurnOutcome | null): { in: number; out: number; cacheRead: number } {
  return o === null ? { in: 0, out: 0, cacheRead: 0 } : { in: o.usage.inputTokens + o.usage.cacheWriteTokens, out: o.usage.outputTokens, cacheRead: o.usage.cacheReadTokens };
}

/** Streams the turn through `emit`, persists the reply and the usage row. Never throws: failures become in-band events. */
export async function streamTurn(deps: TurnDeps, turn: PreparedTurn, emitRaw: (e: AdvisorEvent) => void, signal: AbortSignal): Promise<void> {
  // Writing to a closed stream (the browser went away) must never break persistence.
  const emit = (e: AdvisorEvent): void => {
    try {
      emitRaw(e);
    } catch {
      /* the client is gone */
    }
  };
  const started = deps.clock();
  let outcome: TurnOutcome | null = null;
  let messageId: string | null = null;
  const pinger = setInterval(() => emit({ t: "ping" }), LIMITS.pingMs);
  try {
    emit({ t: "meta", conversationId: turn.conversationId, userMessageId: turn.userMessageId, title: turn.title, remaining: { turns: turn.turnsLeftAfterThis, ...(turn.tokens24hBefore !== undefined ? { tokens24h: turn.tokens24hBefore } : {}) } });
    if (turn.inputScrubbed) emit({ t: "notice", code: "input_scrubbed", message: "A number that looked like an SSN, EIN or account number was removed from your message." });

    const [stored, memory] = await Promise.all([deps.store.loadMessages(turn.userId, turn.conversationId), deps.store.listActiveMemory().catch(() => [] as MemoryNoteView[])]);
    const history: StoredTurn[] = stored.map((m) => ({ role: m.role, text: m.text }));
    const messages = buildReplay(history, { maxMessages: LIMITS.replayMaxMessages, maxChars: LIMITS.replayMaxChars });

    const now = deps.now();
    outcome = await runTurn({
      llm: deps.createLlm(turn.userId),
      tools: deps.toolMap,
      ctx: { userId: turn.userId, firstName: turn.firstName, now, memo: new Map(), signal },
      cfg: deps.cfg,
      system: { frozen: FROZEN_SYSTEM, volatile: buildVolatileBlock({ now, firstName: turn.firstName, memory: buildMemoryBlock(memory), ...(turn.pageContext ? { pageContext: turn.pageContext } : {}) }) },
      messages,
      emit,
      signal,
      clock: deps.clock,
      budget: newTurnBudget(),
    });
  } catch (e) {
    console.error("advisor turn failed:", e instanceof Error ? e.name : "unknown error");
  } finally {
    clearInterval(pinger);
  }

  const stop = outcome?.stop ?? "error";
  const text = outcome === null || outcome.text.trim() === "" ? (stop === "aborted" ? "(Stopped before an answer.)" : "I couldn't produce an answer. Please try again.") : outcome.text;
  try {
    const saved = await deps.store.appendAssistantMessage({ conversationId: turn.conversationId, text, toolCalls: outcome?.toolCalls ?? [], stopReason: stop, model: outcome?.model ?? null }, deps.now());
    messageId = saved.id;
  } catch (e) {
    console.error("advisor reply could not be stored:", e instanceof Error ? e.name : "unknown error");
  }
  try {
    await deps.store.insertUsage({
      userId: turn.userId,
      conversationId: turn.conversationId,
      model: outcome?.model ?? null,
      inputTokens: outcome?.usage.inputTokens ?? 0,
      cacheWriteTokens: outcome?.usage.cacheWriteTokens ?? 0,
      cacheReadTokens: outcome?.usage.cacheReadTokens ?? 0,
      outputTokens: outcome?.usage.outputTokens ?? 0,
      iterations: outcome?.usage.iterations ?? 0,
      toolCalls: outcome?.usage.toolCalls ?? 0,
      fallbackUsed: outcome?.fallbackUsed ?? false,
      outcome: stop,
      durationMs: Math.max(0, deps.clock() - started),
    });
  } catch (e) {
    console.error("advisor usage could not be recorded:", e instanceof Error ? e.name : "unknown error");
  }

  if (outcome === null) emit({ t: "error", code: "upstream", message: "Something went wrong. Please try again." });
  else if (outcome.error !== undefined) emit({ t: "error", code: outcome.error.code, message: outcome.error.message });
  emit({ t: "done", messageId, text, stop, usage: usageOf(outcome), links: outcome?.links ?? [] });
}
