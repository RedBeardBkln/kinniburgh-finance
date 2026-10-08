import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "@/components/advisor/composer";
import { loadAdvisorConfig } from "@/lib/advisor/config";
import type { LlmClient, LlmResult } from "@/lib/advisor/loop";
import { prepareTurn, streamTurn, type TurnDeps, type TurnStore } from "@/lib/advisor/run-turn";
import type { AdvisorEvent } from "@/lib/advisor/stream-protocol";
import { toolMap } from "@/lib/advisor/tools/run-tool";
import { formatTokenCount, formatUsageLine } from "@/lib/advisor/usage-format";

(globalThis as unknown as { React: typeof React }).React = React;
const ROOT = resolve(__dirname, "../..");
const NOW = new Date("2026-10-08T12:00:00Z");

describe("formatTokenCount", () => {
  it("is compact: plain below 1,000, k below a million, M above", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(48_000)).toBe("48k");
    expect(formatTokenCount(48_499)).toBe("48k");
    expect(formatTokenCount(999_499)).toBe("999k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });
});

describe("formatUsageLine", () => {
  it("says questions left and tokens in the last 24 hours", () => {
    expect(formatUsageLine({ turnsLeft: 12, tokens24h: 48_000 })).toBe("12 questions left today. About 48k tokens used in the last 24 hours.");
  });

  it("singular, zero, unknown halves and nothing", () => {
    expect(formatUsageLine({ turnsLeft: 1, tokens24h: 500 })).toBe("1 question left today. About 500 tokens used in the last 24 hours.");
    expect(formatUsageLine({ turnsLeft: 0, tokens24h: 1_200_000 })).toBe("0 questions left today. About 1.2M tokens used in the last 24 hours.");
    expect(formatUsageLine({ turnsLeft: 7, tokens24h: null })).toBe("7 questions left today.");
    expect(formatUsageLine({ turnsLeft: null, tokens24h: 0 })).toBe("No tokens used in the last 24 hours.");
    expect(formatUsageLine({ turnsLeft: null, tokens24h: null })).toBe("");
  });

  it("never carries a dollar sign or any cost wording", () => {
    for (const turnsLeft of [null, 0, 1, 40]) {
      for (const tokens24h of [null, 0, 999, 48_000, 2_500_000]) {
        const line = formatUsageLine({ turnsLeft, tokens24h });
        expect(line).not.toMatch(/\$|cost|price|dollar|usd|spend|charge|bill/i);
      }
    }
  });
});

describe("the composer footer", () => {
  const html = (over: Partial<React.ComponentProps<typeof Composer>> = {}) =>
    renderToStaticMarkup(<Composer value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined} streaming={false} turnsLeft={12} tokens24h={48_000} maxChars={4_000} {...over} />);

  it("shows the usage line next to the existing hint", () => {
    const h = html();
    expect(h).toContain("12 questions left today.");
    expect(h).toContain("About 48k tokens used in the last 24 hours.");
    expect(h).toContain("Press Enter to send, Shift+Enter for a new line.");
    expect(h).not.toContain("$");
  });

  it("a refused (limit reached) state shows 0 left and the limit message", () => {
    const h = html({ turnsLeft: 0 });
    expect(h).toContain("0 questions left today.");
    expect(h).toContain("The daily assistant limit has been reached.");
  });

  it("without usage numbers it shows no usage line", () => {
    const h = html({ turnsLeft: null, tokens24h: null });
    expect(h).not.toContain("left today");
    expect(h).not.toContain("tokens used");
  });
});

// ── server side: the number the client starts from ───────────────────────────
function deps(fresh: number): TurnDeps {
  const llm: LlmClient = {
    async stream(): Promise<LlmResult> {
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5 }, model: "m", fallbackUsed: false };
    },
  };
  const store: TurnStore = {
    getOwnConversation: async () => null,
    createConversation: async () => ({ id: "33333333-3333-4333-8333-333333333333" }),
    appendUserMessage: async () => ({ ok: true, id: "m1", seq: 1 }),
    loadMessages: async () => [{ id: "m1", seq: 1, role: "user", text: "hello", toolCalls: [], stopReason: null, createdAt: NOW }],
    appendAssistantMessage: async () => ({ id: "a1", seq: 2 }),
    insertUsage: async () => undefined,
    sumUsageSince: async () => ({ user: { turns: 3, freshTokens: fresh }, household: { turns: 5, freshTokens: fresh * 2 } }),
    listActiveMemory: async () => [],
  };
  return { cfg: loadAdvisorConfig({}), now: () => NOW, clock: () => Date.now(), tools: [], toolMap: toolMap([]), store, getPersonName: async () => "Eric", createLlm: () => llm, isMissingTable: () => false };
}

describe("meta carries the last-24-hours tokens read before the turn", () => {
  it("prepareTurn records the user's fresh tokens and streamTurn puts them in meta.remaining", async () => {
    const d = deps(48_000);
    const r = await prepareTurn(d, { userId: "u1", conversationId: null, message: "hello" });
    if (!r.ok) throw new Error("prepare failed");
    expect(r.turn.tokens24hBefore).toBe(48_000);
    const events: AdvisorEvent[] = [];
    await streamTurn(d, r.turn, (e) => events.push(e), new AbortController().signal);
    const meta = events.find((e) => e.t === "meta");
    expect(meta).toMatchObject({ t: "meta", remaining: { turns: 36, tokens24h: 48_000 } });
    const done = events.find((e) => e.t === "done");
    expect(done).toMatchObject({ usage: { in: 10, out: 5 } });
  });

  it("household tokens are never in the user's line", async () => {
    const r = await prepareTurn(deps(1_000), { userId: "u1", conversationId: null, message: "hello" });
    if (!r.ok) throw new Error("prepare failed");
    expect(r.turn.tokens24hBefore).toBe(1_000);
  });
});

describe("getMyAdvisorUsage (server action)", () => {
  const src = readFileSync(join(ROOT, "actions/advisor-usage.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");

  it("is a use-server module whose only export starts with requireAuth()", () => {
    expect(src.startsWith('"use server";')).toBe(true);
    const exported = [...code.matchAll(/export (async )?function (\w+)/g)].map((m) => m[2]);
    expect(exported).toEqual(["getMyAdvisorUsage"]);
    const body = code.split("export async function getMyAdvisorUsage")[1]!;
    const first = body.slice(body.indexOf("{\n") + 2).trimStart();
    expect(first.startsWith("const user = await requireAuth();")).toBe(true);
  });

  it("reads counts only and mutates nothing", () => {
    expect(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(code)).toBe(false);
    expect(/store\.(\w+)/.exec(code.replace(/store\.safeRead|store\.sumUsageSince/g, ""))).toBeNull();
    expect(code).toMatch(/store\.safeRead\(\(\) => store\.sumUsageSince\(user\.id, windowStart\(new Date\(\)\)\)\)/);
    expect(code).not.toMatch(/\$|price|cost/);
  });

  it("falls back to nulls when the tables are unreadable (fail-soft)", () => {
    expect(code).toMatch(/if \(read\.state !== "ok"\) return \{ turnsLeft: null, tokens24h: null \};/);
  });
});
