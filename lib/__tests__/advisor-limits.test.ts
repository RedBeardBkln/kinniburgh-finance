import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISOR_MODEL, loadAdvisorConfig } from "@/lib/advisor/config";
import { WINDOW_MS, checkLimits, freshTokensOf, windowStart } from "@/lib/advisor/limits";
import { OMITTED_MARKER, buildReplay, type StoredTurn } from "@/lib/advisor/history";
import { DEFAULT_TITLE, cleanUserTitle, deriveTitle } from "@/lib/advisor/titles";

describe("loadAdvisorConfig", () => {
  it("has conservative defaults", () => {
    const c = loadAdvisorConfig({});
    expect(c).toMatchObject({
      model: DEFAULT_ADVISOR_MODEL,
      effort: "medium",
      // Off by default since Phase 2 (25 tools do not fit any strict limit); ADVISOR_STRICT_TOOLS=1 opts in.
      strictTools: false,
      fallbacks: true,
      maxOutputTokens: 16_000,
      maxToolIterations: 8,
      turnTokenCap: 150_000,
      turnBudgetMs: 50_000,
      dailyTurns: 40,
      dailyTokens: 1_500_000,
      householdDailyTurns: 80,
    });
    expect(DEFAULT_ADVISOR_MODEL).toBe("claude-opus-5-5");
  });

  it("parses env values and clamps them", () => {
    const c = loadAdvisorConfig({
      ADVISOR_MODEL: "claude-sonnet-5-5",
      ADVISOR_EFFORT: "high",
      ADVISOR_DAILY_TURNS: "10",
      ADVISOR_MAX_TOOL_ITERATIONS: "999",
      ADVISOR_TURN_TOKEN_CAP: "5",
      ADVISOR_STRICT_TOOLS: "0",
      ADVISOR_FALLBACKS: "false",
    });
    expect(c.model).toBe("claude-sonnet-5-5");
    expect(c.effort).toBe("high");
    expect(c.dailyTurns).toBe(10);
    expect(c.householdDailyTurns).toBe(20);
    expect(c.maxToolIterations).toBe(16);
    expect(c.turnTokenCap).toBe(10_000);
    expect(c.strictTools).toBe(false);
    expect(c.fallbacks).toBe(false);
  });

  it("ignores junk: bad numbers, an unknown effort, a hostile model string", () => {
    const c = loadAdvisorConfig({ ADVISOR_DAILY_TURNS: "lots", ADVISOR_EFFORT: "ludicrous", ADVISOR_MODEL: "x y\nz" });
    expect(c.dailyTurns).toBe(40);
    expect(c.effort).toBe("medium");
    expect(c.model).toBe(DEFAULT_ADVISOR_MODEL);
  });
});

describe("checkLimits", () => {
  const cfg = loadAdvisorConfig({});
  const none = { turns: 0, freshTokens: 0 };

  it("allows under the caps and reports turns left", () => {
    expect(checkLimits(cfg, { turns: 5, freshTokens: 100 }, { turns: 10, freshTokens: 100 })).toEqual({ ok: true, turnsLeft: 35 });
  });
  it("the household cap can leave fewer turns than the personal one", () => {
    expect(checkLimits(cfg, { turns: 5, freshTokens: 0 }, { turns: 77, freshTokens: 0 })).toEqual({ ok: true, turnsLeft: 3 });
  });
  it("blocks at exactly the cap (boundary) with the specified message", () => {
    const at = checkLimits(cfg, { turns: 40, freshTokens: 0 }, none);
    expect(at).toMatchObject({ ok: false, code: "user_turns" });
    if (!at.ok) expect(at.message).toBe("Daily assistant limit reached (40 questions in 24 hours). Older questions drop off as time passes (the window is the last 24 hours).");
    expect(checkLimits(cfg, { turns: 39, freshTokens: 0 }, none).ok).toBe(true);
  });
  it("blocks on fresh tokens and on the household turn cap", () => {
    expect(checkLimits(cfg, { turns: 1, freshTokens: 1_500_000 }, none)).toMatchObject({ ok: false, code: "user_tokens" });
    expect(checkLimits(cfg, { turns: 1, freshTokens: 0 }, { turns: 80, freshTokens: 0 })).toMatchObject({ ok: false, code: "household_turns" });
  });
  it("counts fresh tokens without cache reads", () => {
    expect(freshTokensOf({ inputTokens: 10, cacheWriteTokens: 20, outputTokens: 30 })).toBe(60);
  });
  it("uses a rolling 24 hour window", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(now.getTime() - windowStart(now).getTime()).toBe(WINDOW_MS);
    expect(windowStart(now).toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });
});

describe("buildReplay", () => {
  const t = (role: "user" | "assistant", text: string): StoredTurn => ({ role, text });

  it("returns the history unchanged when it fits", () => {
    const h = [t("user", "a"), t("assistant", "b"), t("user", "c")];
    expect(buildReplay(h, { maxMessages: 30, maxChars: 1_000 })).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
  });

  it("drops oldest first, starts with a user turn and inserts the omitted marker", () => {
    const h = [t("user", "u1"), t("assistant", "a1"), t("user", "u2"), t("assistant", "a2"), t("user", "u3")];
    const r = buildReplay(h, { maxMessages: 4, maxChars: 1_000 });
    expect(r[0]!.role).toBe("user");
    expect(r[0]!.content.startsWith(OMITTED_MARKER)).toBe(true);
    expect(r.at(-1)).toEqual({ role: "user", content: "u3" });
    expect(r.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("is exact at the trim boundary (no marker when everything fits)", () => {
    const h = [t("user", "aa"), t("assistant", "bb")];
    expect(buildReplay(h, { maxMessages: 2, maxChars: 4 })[0]!.content).toBe("aa");
    expect(buildReplay(h, { maxMessages: 1, maxChars: 4 })).toEqual([]);
  });

  it("always keeps the newest turn even when it alone exceeds the char budget", () => {
    const r = buildReplay([t("user", "x".repeat(500))], { maxMessages: 30, maxChars: 10 });
    expect(r).toHaveLength(1);
  });

  it("merges consecutive same-role turns and skips empty ones", () => {
    const r = buildReplay([t("user", "q1"), t("assistant", " "), t("user", "q2")], { maxMessages: 30, maxChars: 1_000 });
    expect(r).toEqual([{ role: "user", content: "q1\n\nq2" }]);
  });

  it("handles empty history", () => {
    expect(buildReplay([], { maxMessages: 30, maxChars: 100 })).toEqual([]);
  });
});

describe("titles", () => {
  it("derives from the first non-empty line, scrubbed and capped", () => {
    expect(deriveTitle("\n\n  How are we doing on groceries?  \nsecond line")).toBe("How are we doing on groceries?");
    expect(deriveTitle("x".repeat(200)).length).toBeLessThanOrEqual(80);
    expect(deriveTitle("my ssn is 123-45-6789")).not.toContain("123-45-6789");
    expect(deriveTitle("   ")).toBe(DEFAULT_TITLE);
  });
  it("cleans a user title and rejects an empty one", () => {
    expect(cleanUserTitle("  Taxes  2025 ")).toBe("Taxes 2025");
    expect(cleanUserTitle("   ")).toBeNull();
  });
});
