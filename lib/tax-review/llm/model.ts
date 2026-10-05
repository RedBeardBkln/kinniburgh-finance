// Model choice, price assumptions and the cost estimate of an AI review run (ai-return-reviewer, B0 / B4).
//
// B0 probe result (2026-10-04, one tiny call per id with this repo's ANTHROPIC_API_KEY, no tax data): claude-opus-5-5,
// claude-opus-5, claude-fable-5-1, claude-sonnet-5-5 and claude-opus-4-8 answered; claude-mythos-5-1 returned 404.
// output_config.format (structured output) worked on claude-opus-5-5, claude-opus-4-8 and claude-sonnet-5-5 (claude-fable-5-1
// returned non-conforming text in the probe). The default is the newest Opus id that answered. TAX_REVIEW_MODEL overrides it.
//
// NO temperature is ever sent: models released after Claude Opus 4.6 reject any value but 1.0 (SDK 0.131.0 documents it).
// Determinism comes from schema-constrained output, stored prompt / response hashes, code validators and a gate that only
// code decides; the wording of a finding can still differ between two runs.
//
// PURE: the environment is passed in (never read here).

export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";

/** Candidates the probe tried, newest first (documentation and the probe script share this list). */
export const PROBED_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-sonnet-5-5", "claude-opus-4-8"] as const;

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function reviewModelId(env: EnvLike): string {
  const v = env["TAX_REVIEW_MODEL"]?.trim();
  return v !== undefined && /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(v) ? v : DEFAULT_REVIEW_MODEL;
}

/** Eric's decision: no in-app spend cap, only a warning when one run's estimate exceeds this many US dollars. */
export const WARN_ESTIMATE_USD = 50;

export interface Price {
  /** US dollars per million input tokens. */
  inPerMtok: number;
  /** US dollars per million output tokens. */
  outPerMtok: number;
  /** "env" = set by TAX_REVIEW_PRICE_*; "default_upper_bound" = the built-in conservative assumption (NOT a verified price). */
  source: "env" | "default_upper_bound";
}

/**
 * No price could be verified for these model ids. The built-in numbers are a deliberately HIGH upper-end assumption so the
 * estimate errs on the side of warning too early; set TAX_REVIEW_PRICE_IN_PER_MTOK / TAX_REVIEW_PRICE_OUT_PER_MTOK to the real
 * rates from your Anthropic account to make the estimate meaningful.
 */
export const DEFAULT_PRICE: Price = { inPerMtok: 15, outPerMtok: 75, source: "default_upper_bound" };

function positive(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : null;
}

export function priceFromEnv(env: EnvLike): Price {
  const i = positive(env["TAX_REVIEW_PRICE_IN_PER_MTOK"]);
  const o = positive(env["TAX_REVIEW_PRICE_OUT_PER_MTOK"]);
  return i !== null && o !== null ? { inPerMtok: i, outPerMtok: o, source: "env" } : DEFAULT_PRICE;
}

/** Characters per token used for the estimate (a conservative figure for English / JSON text). */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function costUsd(inputTokens: number, outputTokens: number, price: Price): number {
  return (inputTokens / 1_000_000) * price.inPerMtok + (outputTokens / 1_000_000) * price.outPerMtok;
}

export interface TaskEstimate {
  taskId: string;
  inputTokens: number;
  /** Expected (not maximum) output tokens. */
  outputTokens: number;
  maxOutputTokens: number;
}

export interface RunEstimate {
  tasks: TaskEstimate[];
  inputTokens: number;
  outputTokens: number;
  /** Cost if every output hits max_tokens (the ceiling of the estimate). */
  worstCaseUsd: number;
  expectedUsd: number;
  price: Price;
  warn: boolean;
  warnThresholdUsd: number;
  model: string;
}

export function estimateRun(tasks: readonly TaskEstimate[], price: Price, model: string): RunEstimate {
  const inputTokens = tasks.reduce((n, t) => n + t.inputTokens, 0);
  const outputTokens = tasks.reduce((n, t) => n + t.outputTokens, 0);
  const worst = tasks.reduce((n, t) => n + t.maxOutputTokens, 0);
  const expectedUsd = costUsd(inputTokens, outputTokens, price);
  const worstCaseUsd = costUsd(inputTokens, worst, price);
  return {
    tasks: tasks.map((t) => ({ ...t })),
    inputTokens,
    outputTokens,
    worstCaseUsd,
    expectedUsd,
    price,
    // warn on the worse of the two so a cheap expectation cannot hide a high ceiling
    warn: worstCaseUsd > WARN_ESTIMATE_USD,
    warnThresholdUsd: WARN_ESTIMATE_USD,
    model,
  };
}

/** "$1.23" (cents precision, never more digits than a person needs). */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
