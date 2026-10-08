// The client's view of one streamed turn, as a PURE reducer over the protocol events (plan sections 8 and 12). No React here, so the rules the
// UI relies on are unit-tested: text chunks append for live display, `done.text` REPLACES the streamed text (the stored message equals it),
// an `error` event shows a neutral message, tool chips follow `tool` events, unknown events are ignored.

import type { AppLink } from "@/lib/advisor/links";
import type { AdvisorEvent, StopKind } from "@/lib/advisor/stream-protocol";
import { chipNameFor } from "@/lib/advisor/tool-labels";

export interface ToolChip {
  id: string;
  name: string;
  /** While running: "Looking up transactions". After: "Transactions (25 rows)". */
  text: string;
  state: "running" | "done" | "failed";
}

/** A memory note the assistant SUGGESTED this turn (live only; saved only if the person clicks Save). */
export interface MemoryProposalView {
  id: string;
  text: string;
  category: string;
}

export interface TurnView {
  conversationId: string | null;
  userMessageId: string | null;
  title: string | null;
  turnsLeft: number | null;
  text: string;
  tools: ToolChip[];
  notices: string[];
  links: AppLink[];
  finished: boolean;
  stop: StopKind | null;
  error: string | null;
  messageId: string | null;
  /** Memory suggestions, in arrival order (absent until one arrives). */
  proposals?: MemoryProposalView[];
  /** Fresh tokens used in the last 24 hours BEFORE this turn (from `meta`; the client adds this turn's usage when it finishes). */
  tokens24h?: number;
}

export function emptyTurn(): TurnView {
  return { conversationId: null, userMessageId: null, title: null, turnsLeft: null, text: "", tools: [], notices: [], links: [], finished: false, stop: null, error: null, messageId: null };
}

export function chipText(name: string, rows: number | null, ok: boolean): string {
  if (!ok) return `${chipNameFor(name)} (failed)`;
  return rows === null ? chipNameFor(name) : `${chipNameFor(name)} (${rows} ${rows === 1 ? "row" : "rows"})`;
}

export function applyEvent(v: TurnView, e: AdvisorEvent): TurnView {
  switch (e.t) {
    case "meta":
      return { ...v, conversationId: e.conversationId, userMessageId: e.userMessageId, title: e.title, turnsLeft: e.remaining.turns, ...(e.remaining.tokens24h !== undefined ? { tokens24h: e.remaining.tokens24h } : {}) };
    case "text":
      return { ...v, text: v.text + e.d };
    case "tool":
      if (e.state === "start") return { ...v, tools: [...v.tools, { id: e.id, name: e.name, text: e.label, state: "running" }] };
      return { ...v, tools: v.tools.map((t) => (t.id === e.id ? { ...t, text: chipText(t.name, e.rows, e.ok), state: e.ok ? "done" : "failed" } : t)) };
    case "notice":
      return v.notices.includes(e.message) ? v : { ...v, notices: [...v.notices, e.message] };
    case "memory_proposal": {
      const have = v.proposals ?? [];
      // At most two per answer (the server enforces it too); a repeated id is the same suggestion.
      if (have.length >= 2 || have.some((p) => p.id === e.id)) return v;
      return { ...v, proposals: [...have, { id: e.id, text: e.text, category: e.category }] };
    }
    case "error":
      return { ...v, error: e.message };
    case "done":
      return { ...v, text: e.text, finished: true, stop: e.stop, links: e.links, messageId: e.messageId };
    default:
      return v; // ping and anything unknown
  }
}

// ── what the transcript renders ──────────────────────────────────────────────

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  links: AppLink[];
  notices: string[];
  streaming: boolean;
  error: string | null;
  /** Memory suggestions under this answer (live only; not stored with the message). */
  proposals?: MemoryProposalView[];
}

/** A conversation row as the client gets it (dates as ISO strings). */
export interface ConversationView {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
}

export interface StoredLike {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: { name: string; ok: boolean; rows: number | null }[];
  stopReason: string | null;
}

/** A stored message as the transcript shows it after a reload (chips from the compact tool records; sources are not stored). */
export function toUiMessage(m: StoredLike): UiMessage {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    tools: m.toolCalls.map((t, i) => ({ id: `${m.id}:${i}`, name: t.name, text: chipText(t.name, t.rows, t.ok), state: t.ok ? "done" : "failed" })),
    links: [],
    notices: [],
    streaming: false,
    error: null,
  };
}

/** The live assistant bubble for a turn in progress. */
export function liveMessage(id: string, v: TurnView, streaming: boolean): UiMessage {
  return { id, role: "assistant", text: v.text, tools: v.tools, links: v.links, notices: v.notices, streaming, error: v.error, ...(v.proposals !== undefined && v.proposals.length > 0 ? { proposals: v.proposals } : {}) };
}

/** "today", "yesterday" or a short date, for the conversation list (the clock is injected). */
export function relativeDay(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date): number => Math.floor(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000);
  const diff = day(now) - day(d);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(diff > 300 ? { year: "numeric" } : {}) });
}
