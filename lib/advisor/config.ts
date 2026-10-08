// Advisor configuration: model, effort and every cost / abuse cap (plan sections 7 and 9). PURE: reads only the env object it is given.
//
// Every number is clamped, so a typo in an env var cannot remove a cap. No prices are hard-coded (counts only).

export const DEFAULT_ADVISOR_MODEL = "claude-opus-5-5";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AdvisorEffort = (typeof EFFORT_LEVELS)[number];

export interface AdvisorConfig {
  model: string;
  effort: AdvisorEffort;
  /** `strict: true` on tool schemas (kill switch ADVISOR_STRICT_TOOLS=0, see anthropic.ts degradation). */
  strictTools: boolean;
  /** Opt in to server-side fallbacks (beta). ADVISOR_FALLBACKS=0 turns it off. */
  fallbacks: boolean;
  maxOutputTokens: number;
  maxToolIterations: number;
  turnTokenCap: number;
  turnBudgetMs: number;
  dailyTurns: number;
  dailyTokens: number;
  householdDailyTurns: number;
}

export const LIMITS = {
  /** Request body, bytes. */
  maxBodyBytes: 16 * 1024,
  /** One chat message, characters. */
  maxMessageChars: 4_000,
  /** Messages in one conversation. */
  maxConversationMessages: 200,
  /** Replayed history: messages and a chars/4 token estimate. */
  replayMaxMessages: 30,
  replayMaxChars: 24_000 * 4,
  /** Tool results. */
  toolResultChars: 12_000,
  overviewResultChars: 16_000,
  turnToolChars: 60_000,
  perToolTimeoutMs: 20_000,
  /** Persisted assistant / user text. */
  storedUserChars: 4_000,
  storedAssistantChars: 24_000,
  titleChars: 80,
  /** Memory block injected into the volatile system block. */
  memoryBlockChars: 3_000,
  maxActiveMemoryNotes: 50,
  /** Silent-stream keepalive. */
  pingMs: 15_000,
  /** Time kept back from the wall clock for finalising and the usage write. */
  finalizeReserveMs: 12_000,
  /** Conversations listed on the page. */
  listConversations: 50,
} as const;

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function flagFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export function isEffort(v: string | undefined): v is AdvisorEffort {
  return v !== undefined && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export function loadAdvisorConfig(env: Readonly<Record<string, string | undefined>> = process.env): AdvisorConfig {
  const model = env.ADVISOR_MODEL?.trim();
  const dailyTurns = intFromEnv(env.ADVISOR_DAILY_TURNS, 40, 1, 1_000);
  return {
    model: model !== undefined && model !== "" && /^[A-Za-z0-9._-]{1,80}$/.test(model) ? model : DEFAULT_ADVISOR_MODEL,
    effort: isEffort(env.ADVISOR_EFFORT?.trim()) ? (env.ADVISOR_EFFORT!.trim() as AdvisorEffort) : "medium",
    strictTools: flagFromEnv(env.ADVISOR_STRICT_TOOLS, true),
    fallbacks: flagFromEnv(env.ADVISOR_FALLBACKS, true),
    maxOutputTokens: intFromEnv(env.ADVISOR_MAX_OUTPUT_TOKENS, 16_000, 1_024, 64_000),
    maxToolIterations: intFromEnv(env.ADVISOR_MAX_TOOL_ITERATIONS, 8, 1, 16),
    turnTokenCap: intFromEnv(env.ADVISOR_TURN_TOKEN_CAP, 150_000, 10_000, 1_000_000),
    turnBudgetMs: intFromEnv(env.ADVISOR_TURN_BUDGET_MS, 50_000, 15_000, 280_000),
    dailyTurns,
    dailyTokens: intFromEnv(env.ADVISOR_DAILY_TOKENS, 1_500_000, 10_000, 100_000_000),
    householdDailyTurns: intFromEnv(env.ADVISOR_HOUSEHOLD_DAILY_TURNS, dailyTurns * 2, 1, 2_000),
  };
}
