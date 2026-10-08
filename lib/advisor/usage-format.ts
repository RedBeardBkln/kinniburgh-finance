// The usage line under the composer (advisor-ai-chatbot-phase2 plan, section 6). PURE and client-safe. Counts only: questions left today and fresh
// tokens in the last 24 hours. No money, no price, no cost wording anywhere (a test pins that no "$" can appear).

/** 0-999 as is, thousands as "48k", millions as "1.2M". */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  const m = Math.round(v / 100_000) / 10;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
}

export interface UsageLineInput {
  /** null = unknown. 0 = the daily limit is reached. */
  turnsLeft: number | null;
  /** Fresh tokens used in the last 24 hours; null = unknown. */
  tokens24h: number | null;
}

/** "12 questions left today. About 48k tokens used in the last 24 hours." Either half is left out when unknown; "" when both are. */
export function formatUsageLine(u: UsageLineInput): string {
  const parts: string[] = [];
  if (u.turnsLeft !== null) {
    const n = Math.max(0, Math.trunc(u.turnsLeft));
    parts.push(`${n} question${n === 1 ? "" : "s"} left today.`);
  }
  if (u.tokens24h !== null) {
    parts.push(u.tokens24h <= 0 ? "No tokens used in the last 24 hours." : `About ${formatTokenCount(u.tokens24h)} tokens used in the last 24 hours.`);
  }
  return parts.join(" ");
}
