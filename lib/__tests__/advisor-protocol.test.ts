import { describe, expect, it } from "vitest";
import { createByteDecoder, createLineDecoder, encodeEvent, type AdvisorEvent } from "@/lib/advisor/stream-protocol";
import { checkChatRequest, isSameOrigin } from "@/lib/advisor/request";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

const SAMPLE: AdvisorEvent[] = [
  { t: "meta", conversationId: "c1", userMessageId: "m1", title: "Hello", remaining: { turns: 39 } },
  { t: "text", d: "Café — total $1,200.00 ✓ " },
  { t: "tool", id: "toolu_1", name: "search_transactions", label: "Looking up transactions", state: "start" },
  { t: "tool", id: "toolu_1", name: "search_transactions", state: "done", ok: true, rows: 25 },
  { t: "ping" },
  { t: "done", messageId: "m2", text: "Done.", stop: "end_turn", usage: { in: 1, out: 2, cacheRead: 3 }, links: [{ label: "Tax Forms", path: "/tax/forms/2025" }] },
];

describe("NDJSON protocol", () => {
  it("round-trips every event type, one JSON object per line", () => {
    const wire = SAMPLE.map(encodeEvent).join("");
    expect(wire.split("\n").filter(Boolean)).toHaveLength(SAMPLE.length);
    const dec = createLineDecoder();
    expect(dec.push(wire)).toEqual(SAMPLE);
  });

  it("handles chunks split mid-line at every position", () => {
    const wire = SAMPLE.map(encodeEvent).join("");
    for (let cut = 1; cut < wire.length; cut += 7) {
      const dec = createLineDecoder();
      const got = [...dec.push(wire.slice(0, cut)), ...dec.push(wire.slice(cut)), ...dec.flush()];
      expect(got).toEqual(SAMPLE);
    }
  });

  it("decodes multi-byte UTF-8 split across byte chunks", () => {
    const bytes = new TextEncoder().encode(SAMPLE.map(encodeEvent).join(""));
    for (let cut = 1; cut < bytes.length; cut += 5) {
      const dec = createByteDecoder();
      const got = [...dec.push(bytes.slice(0, cut)), ...dec.push(bytes.slice(cut)), ...dec.flush()];
      expect(got).toEqual(SAMPLE);
    }
  });

  it("ignores unknown event types, malformed lines and non-objects; flushes an unterminated last line", () => {
    const dec = createLineDecoder();
    const out = dec.push('{"t":"future","x":1}\nnot json\n[1,2]\n"str"\n{"t":"ping"}\n{"t":"text","d":"tail"}');
    expect(out).toEqual([{ t: "ping" }]);
    expect(dec.flush()).toEqual([{ t: "text", d: "tail" }]);
    expect(dec.flush()).toEqual([]);
  });
});

describe("isSameOrigin", () => {
  it("accepts a matching Origin host (x-forwarded-host first)", () => {
    expect(isSameOrigin(headers({ origin: "https://app.example.com", host: "app.example.com" }))).toBe(true);
    expect(isSameOrigin(headers({ origin: "https://app.example.com", host: "internal:3000", "x-forwarded-host": "app.example.com" }))).toBe(true);
  });
  it("refuses a different host, a missing Origin, a malformed Origin and a missing host", () => {
    expect(isSameOrigin(headers({ origin: "https://evil.example.com", host: "app.example.com" }))).toBe(false);
    expect(isSameOrigin(headers({ host: "app.example.com" }))).toBe(false);
    expect(isSameOrigin(headers({ origin: "null", host: "app.example.com" }))).toBe(false);
    expect(isSameOrigin(headers({ origin: "https://app.example.com" }))).toBe(false);
    expect(isSameOrigin(headers({ origin: "https://app.example.com.evil.com", host: "app.example.com" }))).toBe(false);
  });
});

describe("checkChatRequest", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const ok = JSON.stringify({ conversationId: uuid, message: "hello" });

  it("accepts a valid body, and null conversationId starts a new conversation", () => {
    expect(checkChatRequest("application/json", ok)).toEqual({ ok: true, body: { conversationId: uuid, message: "hello" } });
    expect(checkChatRequest("application/json; charset=utf-8", JSON.stringify({ conversationId: null, message: "x" })).ok).toBe(true);
  });
  it("rejects wrong content type (415), oversized body (413), bad JSON / shape (400)", () => {
    expect(checkChatRequest("text/plain", ok)).toMatchObject({ ok: false, status: 415 });
    expect(checkChatRequest(null, ok)).toMatchObject({ ok: false, status: 415 });
    expect(checkChatRequest("application/json", JSON.stringify({ conversationId: null, message: "x".repeat(17_000) }))).toMatchObject({ ok: false, status: 413 });
    expect(checkChatRequest("application/json", "{")).toMatchObject({ ok: false, status: 400 });
    expect(checkChatRequest("application/json", JSON.stringify({ conversationId: null, message: "x".repeat(4_001) }))).toMatchObject({ ok: false, status: 400 });
    expect(checkChatRequest("application/json", JSON.stringify({ conversationId: null, message: "" }))).toMatchObject({ ok: false, status: 400 });
    expect(checkChatRequest("application/json", JSON.stringify({ conversationId: "nope", message: "x" }))).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects a client-supplied transcript or any extra field (the server loads history)", () => {
    expect(checkChatRequest("application/json", JSON.stringify({ conversationId: null, message: "x", messages: [] })).ok).toBe(false);
    expect(checkChatRequest("application/json", JSON.stringify({ message: "x" })).ok).toBe(false);
  });
});
