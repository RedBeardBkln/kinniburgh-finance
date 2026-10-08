// Daily cost caps for the assistant (plan section 9). PURE: the caller supplies the usage sums (a rolling 24 h window, no timezone math).

import type { AdvisorConfig } from "@/lib/advisor/config";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UsageTotals {
  turns: number;
  /** inputTokens + cacheWriteTokens + outputTokens (cache reads excluded). */
  freshTokens: number;
}

export interface TokenCounts {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export function windowStart(now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS);
}

export function freshTokensOf(u: Pick<TokenCounts, "inputTokens" | "cacheWriteTokens" | "outputTokens">): number {
  return u.inputTokens + u.cacheWriteTokens + u.outputTokens;
}

export type LimitCode = "user_turns" | "user_tokens" | "household_turns";

export type LimitDecision =
  | { ok: true; turnsLeft: number }
  | { ok: false; code: LimitCode; message: string };

export const LIMIT_RESET_HINT = "Older questions drop off as time passes (the window is the last 24 hours).";

/** The cap check. It runs BEFORE the user message is stored, so a refused request writes nothing. */
export function checkLimits(cfg: Pick<AdvisorConfig, "dailyTurns" | "dailyTokens" | "householdDailyTurns">, user: UsageTotals, household: UsageTotals): LimitDecision {
  if (user.turns >= cfg.dailyTurns) {
    return { ok: false, code: "user_turns", message: `Daily assistant limit reached (${cfg.dailyTurns} questions in 24 hours). ${LIMIT_RESET_HINT}` };
  }
  if (user.freshTokens >= cfg.dailyTokens) {
    return { ok: false, code: "user_tokens", message: `Daily assistant usage limit reached for your login. ${LIMIT_RESET_HINT}` };
  }
  if (household.turns >= cfg.householdDailyTurns) {
    return { ok: false, code: "household_turns", message: `The household's daily assistant limit has been reached (${cfg.householdDailyTurns} questions in 24 hours). ${LIMIT_RESET_HINT}` };
  }
  const turnsLeft = Math.max(0, Math.min(cfg.dailyTurns - user.turns, cfg.householdDailyTurns - household.turns));
  return { ok: true, turnsLeft };
}
