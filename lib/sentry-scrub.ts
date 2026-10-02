// Keeps magic-link tokens out of Sentry. A review-queue link is a bearer
// credential in the URL PATH (/queue/<43-char base64url token>); request URLs,
// transaction names, breadcrumbs and span attributes would otherwise carry it
// to a third-party store. Used as beforeSend / beforeSendTransaction in
// sentry.server.config.ts and sentry.edge.config.ts. Pure, no I/O.

// "/queue/" followed by a run of token characters. Matches 20+ rather than
// exactly 43 so a truncated/mangled token is scrubbed too; the literal
// "/queue/[token]" placeholder contains "[" so it never matches.
const QUEUE_TOKEN_PATH = /\/queue\/[A-Za-z0-9_-]{20,}/g;
export const QUEUE_PATH_PLACEHOLDER = "/queue/[token]";

const MAX_DEPTH = 12;

/** Scrubs a single string. */
export function scrubQueueTokens(value: string): string {
  return value.includes("/queue/") ? value.replace(QUEUE_TOKEN_PATH, QUEUE_PATH_PLACEHOLDER) : value;
}

function scrubInPlace(node: unknown, depth: number, seen: WeakSet<object>): void {
  if (node === null || typeof node !== "object" || depth > MAX_DEPTH) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v: unknown = node[i];
      if (typeof v === "string") node[i] = scrubQueueTokens(v);
      else scrubInPlace(v, depth + 1, seen);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (typeof v === "string") record[key] = scrubQueueTokens(v);
    else scrubInPlace(v, depth + 1, seen);
  }
}

/**
 * Rewrites every /queue/<token> occurrence anywhere in a Sentry event
 * (request.url, transaction name, breadcrumb URLs/messages, span descriptions
 * and http.url / url.full attributes, headers such as Referer, ...) to
 * /queue/[token]. Mutates and returns the same event; never throws.
 */
export function scrubQueueTokensFromEvent<T>(event: T): T {
  try {
    scrubInPlace(event, 0, new WeakSet());
  } catch {
    // Scrubbing must never drop or break an event.
  }
  return event;
}
