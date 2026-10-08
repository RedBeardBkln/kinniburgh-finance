// The NDJSON streaming protocol between POST /api/advisor/chat and the UI (plan section 8). PURE; shared by the route and the client.
//
// One JSON object per line, discriminated by `t`. Unknown `t` values (and malformed lines) are ignored so the server can add event types
// without breaking an open tab. Thinking content is never sent.

import type { AppLink } from "@/lib/advisor/links";

export type NoticeCode = "time_budget" | "loop_cap" | "token_cap" | "fallback" | "input_scrubbed" | "max_tokens" | "refusal" | "context";
export type ErrorCode = "limit_reached" | "busy" | "upstream" | "unavailable" | "invalid" | "unauthorized" | "not_found";
export type StopKind = "end_turn" | "max_tokens" | "refusal" | "loop_cap" | "time_budget" | "token_cap" | "aborted" | "error";

export type AdvisorEvent =
  | { t: "meta"; conversationId: string; userMessageId: string; title: string; remaining: { turns: number; tokens24h?: number } }
  | { t: "text"; d: string }
  | { t: "tool"; id: string; name: string; label: string; state: "start" }
  | { t: "tool"; id: string; name: string; state: "done"; ok: boolean; rows: number | null }
  | { t: "notice"; code: NoticeCode; message: string }
  /** A memory note SUGGESTION from propose_memory_note. Live only (not stored); saved only if the person clicks Save. */
  | { t: "memory_proposal"; id: string; text: string; category: string }
  | { t: "ping" }
  | { t: "done"; messageId: string | null; text: string; stop: StopKind; usage: { in: number; out: number; cacheRead: number }; links: AppLink[] }
  | { t: "error"; code: ErrorCode; message: string };

export function encodeEvent(event: AdvisorEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const EVENT_TYPES = new Set(["meta", "text", "tool", "notice", "memory_proposal", "ping", "done", "error"]);

function parseLine(line: string): AdvisorEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== "string" || !EVENT_TYPES.has(t)) return null;
  return value as AdvisorEvent;
}

/** Splits a text stream into events. Chunks may split a line anywhere; call `flush()` at end of stream for a final unterminated line. */
export interface LineDecoder {
  push(chunk: string): AdvisorEvent[];
  flush(): AdvisorEvent[];
}

export function createLineDecoder(): LineDecoder {
  let buffer = "";
  return {
    push(chunk: string): AdvisorEvent[] {
      buffer += chunk;
      const out: AdvisorEvent[] = [];
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const ev = parseLine(buffer.slice(0, nl));
        if (ev !== null) out.push(ev);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      return out;
    },
    flush(): AdvisorEvent[] {
      const ev = parseLine(buffer);
      buffer = "";
      return ev === null ? [] : [ev];
    },
  };
}

/** Bytes in, events out. The TextDecoder runs in streaming mode, so a UTF-8 character split across two chunks is decoded correctly. */
export interface ByteDecoder {
  push(chunk: Uint8Array): AdvisorEvent[];
  flush(): AdvisorEvent[];
}

export function createByteDecoder(): ByteDecoder {
  const text = new TextDecoder("utf-8");
  const lines = createLineDecoder();
  return {
    push: (chunk) => lines.push(text.decode(chunk, { stream: true })),
    flush: () => [...lines.push(text.decode()), ...lines.flush()],
  };
}
