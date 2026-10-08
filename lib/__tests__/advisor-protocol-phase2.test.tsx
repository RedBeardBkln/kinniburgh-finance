import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { applyEvent, emptyTurn, liveMessage } from "@/lib/advisor/chat-state";
import { createByteDecoder, createLineDecoder, encodeEvent, type AdvisorEvent } from "@/lib/advisor/stream-protocol";

// Phase 2 additions to the NDJSON protocol and the client reducer: the memory_proposal event, an optional tokens24h on `meta`, and the
// suggestion chip's static markup. The chip's server action is stubbed (the real one needs next-auth).
vi.mock("@/actions/advisor", () => ({ confirmMemorySuggestion: async () => ({ ok: false, error: "stub" }) }));
(globalThis as unknown as { React: typeof React }).React = React;

const proposal: AdvisorEvent = { t: "memory_proposal", id: "p1", text: "We prefer short answers.", category: "preference" };

describe("memory_proposal on the wire", () => {
  it("round-trips through the line decoder and the byte decoder", () => {
    const wire = encodeEvent(proposal);
    expect(wire.endsWith("\n")).toBe(true);
    expect(createLineDecoder().push(wire)).toEqual([proposal]);
    const bytes = new TextEncoder().encode(wire + wire);
    const d = createByteDecoder();
    // split in the middle of the first event
    const out = [...d.push(bytes.slice(0, 9)), ...d.push(bytes.slice(9)), ...d.flush()];
    expect(out).toEqual([proposal, proposal]);
  });

  it("an unknown event type is still ignored, and malformed lines are skipped", () => {
    const d = createLineDecoder();
    const out = d.push('{"t":"something_new","x":1}\nnot json\n{"t":"text","d":"hi"}\n[1,2]\n' + encodeEvent(proposal));
    expect(out).toEqual([{ t: "text", d: "hi" }, proposal]);
  });

  it("an old meta event (turns only) is still valid; a new one may carry tokens24h", () => {
    const old = '{"t":"meta","conversationId":"c","userMessageId":"u","title":"T","remaining":{"turns":5}}\n';
    const fresh = '{"t":"meta","conversationId":"c","userMessageId":"u","title":"T","remaining":{"turns":5,"tokens24h":48000}}\n';
    const [a] = createLineDecoder().push(old);
    const [b] = createLineDecoder().push(fresh);
    expect(a).toMatchObject({ t: "meta", remaining: { turns: 5 } });
    expect(b).toMatchObject({ t: "meta", remaining: { turns: 5, tokens24h: 48000 } });
  });
});

describe("the reducer", () => {
  it("collects suggestions in arrival order, at most two, once per id", () => {
    let v = emptyTurn();
    v = applyEvent(v, proposal);
    v = applyEvent(v, proposal); // repeat of the same id
    v = applyEvent(v, { t: "memory_proposal", id: "p2", text: "Eva pays the oil bill.", category: "household" });
    v = applyEvent(v, { t: "memory_proposal", id: "p3", text: "A third one.", category: "other" });
    expect(v.proposals?.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("a turn without suggestions has none; liveMessage carries them only when present", () => {
    const empty = emptyTurn();
    expect(empty.proposals).toBeUndefined();
    expect(liveMessage("m", empty, true).proposals).toBeUndefined();
    const withOne = applyEvent(empty, proposal);
    expect(liveMessage("m", withOne, false).proposals).toEqual([{ id: "p1", text: "We prefer short answers.", category: "preference" }]);
  });

  it("meta stores the optional tokens24h and an old meta leaves it unset", () => {
    const old = applyEvent(emptyTurn(), { t: "meta", conversationId: "c", userMessageId: "u", title: "T", remaining: { turns: 3 } });
    expect(old.turnsLeft).toBe(3);
    expect(old.tokens24h).toBeUndefined();
    const fresh = applyEvent(emptyTurn(), { t: "meta", conversationId: "c", userMessageId: "u", title: "T", remaining: { turns: 3, tokens24h: 1200 } });
    expect(fresh.tokens24h).toBe(1200);
  });

  it("done keeps the suggestions already received", () => {
    let v = applyEvent(emptyTurn(), proposal);
    v = applyEvent(v, { t: "done", messageId: "a1", text: "Suggested.", stop: "end_turn", usage: { in: 1, out: 1, cacheRead: 0 }, links: [] });
    expect(v.finished).toBe(true);
    expect(v.proposals).toHaveLength(1);
  });
});

describe("the suggestion chip under an answer", () => {
  const msg = (text: string) => ({
    ...liveMessage("m1", applyEvent(applyEvent(emptyTurn(), { t: "text", d: "Done." }), { t: "memory_proposal", id: "p1", text, category: "preference" }), false),
  });

  it("shows the exact note text, who suggested it, that it is saved only on a click, and Save / Dismiss buttons", () => {
    const html = renderToStaticMarkup(<MessageBubble message={msg("We prefer short answers.")} />);
    expect(html).toContain("We prefer short answers.");
    expect(html).toContain("Suggested by the assistant. Saved only if you click Save.");
    expect(html).toContain(">Save<");
    expect(html).toContain(">Dismiss<");
    expect(html).toContain("Preference");
  });

  it("escapes hostile suggestion text (it is a React text node, never HTML)", () => {
    const html = renderToStaticMarkup(<MessageBubble message={msg('<script>alert(1)</script><img src=x onerror=alert(1)>')} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("an answer without suggestions renders no chip", () => {
    const html = renderToStaticMarkup(<MessageBubble message={liveMessage("m2", applyEvent(emptyTurn(), { t: "text", d: "Hello." }), false)} />);
    expect(html).not.toContain("Suggested by the assistant");
  });
});
