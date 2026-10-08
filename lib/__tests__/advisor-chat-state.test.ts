import { describe, expect, it } from "vitest";
import { applyEvent, chipText, emptyTurn, liveMessage, relativeDay, toUiMessage, type TurnView } from "@/lib/advisor/chat-state";
import { createLineDecoder, encodeEvent, type AdvisorEvent } from "@/lib/advisor/stream-protocol";

const events: AdvisorEvent[] = [
  { t: "meta", conversationId: "c1", userMessageId: "m1", title: "Budget check", remaining: { turns: 31 } },
  { t: "text", d: "Let me look. " },
  { t: "tool", id: "t1", name: "search_transactions", label: "Looking up transactions", state: "start" },
  { t: "ping" },
  { t: "tool", id: "t1", name: "search_transactions", state: "done", ok: true, rows: 25 },
  { t: "text", d: "You spent $12 (draft wording" },
  { t: "notice", code: "fallback", message: "A substitute model answered part of this request." },
  { t: "notice", code: "fallback", message: "A substitute model answered part of this request." },
  { t: "done", messageId: "a1", text: "You spent $12.00 on groceries.", stop: "end_turn", usage: { in: 1, out: 2, cacheRead: 3 }, links: [{ label: "Transactions", path: "/transactions" }] },
];

function fold(list: AdvisorEvent[]): TurnView {
  return list.reduce(applyEvent, emptyTurn());
}

describe("applyEvent", () => {
  it("shows tool chips running then done, appends text for live display, and `done.text` REPLACES the streamed text", () => {
    const mid = fold(events.slice(0, 3));
    expect(mid.text).toBe("Let me look. ");
    expect(mid.tools).toEqual([{ id: "t1", name: "search_transactions", text: "Looking up transactions", state: "running" }]);
    const afterTool = fold(events.slice(0, 5));
    expect(afterTool.tools[0]).toMatchObject({ text: "Transactions (25 rows)", state: "done" });
    const live = fold(events.slice(0, 6));
    expect(live.text).toBe("Let me look. You spent $12 (draft wording");
    const end = fold(events);
    expect(end).toMatchObject({ text: "You spent $12.00 on groceries.", finished: true, stop: "end_turn", messageId: "a1", conversationId: "c1", title: "Budget check", turnsLeft: 31 });
    expect(end.links).toEqual([{ label: "Transactions", path: "/transactions" }]);
    expect(end.notices).toHaveLength(1); // the same notice twice is shown once
  });

  it("an error event keeps a neutral message; a failed tool says so", () => {
    const v = fold([
      { t: "tool", id: "x", name: "get_tax_facts", label: "Reading confirmed tax facts", state: "start" },
      { t: "tool", id: "x", name: "get_tax_facts", state: "done", ok: false, rows: null },
      { t: "error", code: "upstream", message: "The assistant is temporarily unavailable. Please try again in a moment." },
    ]);
    expect(v.tools[0]).toMatchObject({ text: "Tax facts (failed)", state: "failed" });
    expect(v.error).toBe("The assistant is temporarily unavailable. Please try again in a moment.");
  });

  it("is immutable and ignores events it does not know", () => {
    const base = emptyTurn();
    const next = applyEvent(base, { t: "text", d: "x" });
    expect(base.text).toBe("");
    expect(next.text).toBe("x");
    expect(applyEvent(base, { t: "ping" })).toBe(base);
    expect(applyEvent(base, { t: "mystery" } as unknown as AdvisorEvent)).toBe(base);
  });

  it("works end to end through the wire format, split anywhere", () => {
    const wire = events.map(encodeEvent).join("");
    const dec = createLineDecoder();
    let v = emptyTurn();
    for (let i = 0; i < wire.length; i += 11) for (const e of dec.push(wire.slice(i, i + 11))) v = applyEvent(v, e);
    for (const e of dec.flush()) v = applyEvent(v, e);
    expect(v.text).toBe("You spent $12.00 on groceries.");
    expect(v.finished).toBe(true);
  });

  it("chipText pluralises and handles unknown tools", () => {
    expect(chipText("search_transactions", 1, true)).toBe("Transactions (1 row)");
    expect(chipText("list_goals", null, true)).toBe("Goals");
    expect(chipText("brand_new_tool", 3, true)).toBe("Lookup (3 rows)");
  });
});

describe("transcript helpers", () => {
  it("a stored message becomes a bubble with chips from its compact records", () => {
    const m = toUiMessage({
      id: "a9",
      role: "assistant",
      text: "Done.",
      toolCalls: [
        { name: "get_budget_status", ok: true, rows: 12 },
        { name: "get_tax_review_status", ok: false, rows: null },
      ],
      stopReason: "end_turn",
    });
    expect(m.tools.map((t) => t.text)).toEqual(["Budgets (12 rows)", "Review status (failed)"]);
    expect(m.streaming).toBe(false);
    expect(m.links).toEqual([]);
  });

  it("the live bubble mirrors the turn view", () => {
    const v = fold(events.slice(0, 3));
    expect(liveMessage("live", v, true)).toMatchObject({ id: "live", role: "assistant", text: "Let me look. ", streaming: true });
  });

  it("relativeDay says today, yesterday, then a short date", () => {
    const now = new Date(2026, 9, 8, 12, 0, 0);
    expect(relativeDay(new Date(2026, 9, 8, 1, 0, 0).toISOString(), now)).toBe("today");
    expect(relativeDay(new Date(2026, 9, 7, 23, 0, 0).toISOString(), now)).toBe("yesterday");
    expect(relativeDay(new Date(2026, 8, 20, 12, 0, 0).toISOString(), now)).toBe("Sep 20");
    expect(relativeDay("nonsense", now)).toBe("");
  });
});
