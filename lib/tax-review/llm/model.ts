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

/**
 * Characters per token used for the estimate. Calibrated on the first live run (2026-10-05, claude-opus-5-5): the prompts (JSON data
 * plus source text) came to 2.35 to 2.66 characters per token (c1 2.35, a1 2.58, a2 2.66, b1 2.66, b2 2.53, b3 2.59); the earlier 3.5
 * under-counted the input by about 35%. 2.4 errs slightly high on purpose.
 */
export const CHARS_PER_TOKEN = 2.4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function costUsd(inputTokens: number, outputTokens: number, price: Price): number {
  return (inputTokens / 1_000_000) * price.inPerMtok + (outputTokens / 1_000_000) * price.outPerMtok;
}

export interface TaskEstimate {
  taskId: string;
  /** Input tokens of ONE request of this task (0 for a reused task: it is not sent). */
  inputTokens: number;
  /** Expected (not maximum) output tokens (0 for a reused task). */
  outputTokens: number;
  /** max_tokens of the first request (0 for a reused task). */
  maxOutputTokens: number;
  /** max_tokens of the one retry after a cut-off answer; 0 = no retry is possible (or the task is reused). Absent in estimates stored before the retry existed. */
  retryOutputTokens?: number;
  /** The task already has a finished, valid result from an earlier review of the same return: it is not sent and costs nothing. */
  reused?: boolean;
}

export interface RunEstimate {
  tasks: TaskEstimate[];
  /** Requests that will be sent (tasks that are not reused), each at least once. */
  requests?: number;
  /** Tasks whose finished results are reused (not sent, no cost). */
  reusedTaskIds?: string[];
  inputTokens: number;
  outputTokens: number;
  /** Cost if every request that will be sent uses its whole first output budget (max_tokens) and none is cut off. The $50 warning looks at this. */
  worstCaseUsd: number;
  /**
   * The absolute ceiling under the run's rules: every request that will be sent is cut off at its budget once and answered on the one
   * retry using the whole larger budget (the input is paid twice then). Shown next to the worst case so no ceiling is hidden; absent in
   * estimates stored before the retry existed.
   */
  maxWithRetryUsd?: number;
  expectedUsd: number;
  price: Price;
  warn: boolean;
  warnThresholdUsd: number;
  model: string;
}

export function estimateRun(tasks: readonly TaskEstimate[], price: Price, model: string): RunEstimate {
  const sent = tasks.filter((t) => t.reused !== true);
  const inputTokens = sent.reduce((n, t) => n + t.inputTokens, 0);
  const outputTokens = sent.reduce((n, t) => n + t.outputTokens, 0);
  const worst = sent.reduce((n, t) => n + t.maxOutputTokens, 0);
  // ceiling with the retry: each task is cut off at its budget once and answered at the larger budget (input sent twice, both outputs full)
  const ceilingInput = sent.reduce((n, t) => n + t.inputTokens * ((t.retryOutputTokens ?? 0) > 0 ? 2 : 1), 0);
  const ceilingOutput = sent.reduce((n, t) => n + t.maxOutputTokens + (t.retryOutputTokens ?? 0), 0);
  const expectedUsd = costUsd(inputTokens, outputTokens, price);
  const worstCaseUsd = costUsd(inputTokens, worst, price);
  const maxWithRetryUsd = costUsd(ceilingInput, ceilingOutput, price);
  return {
    tasks: tasks.map((t) => ({ ...t })),
    requests: sent.length,
    reusedTaskIds: tasks.filter((t) => t.reused === true).map((t) => t.taskId),
    inputTokens,
    outputTokens,
    worstCaseUsd,
    maxWithRetryUsd,
    expectedUsd,
    price,
    // warn on the worst case, not on the expectation, so a cheap expectation cannot hide a high ceiling
    warn: worstCaseUsd > WARN_ESTIMATE_USD,
    warnThresholdUsd: WARN_ESTIMATE_USD,
    model,
  };
}

/** "$1.23" (cents precision, never more digits than a person needs). */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
