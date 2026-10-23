// Pure helper for logging a lib/resend.ts#sendEmail failure safely (kept out of lib/resend.ts so tests that mock that module still get it).
/** Resend's short error code and HTTP status from a `sendEmail` failure (never the message), for logging. */
export function emailFailureCode(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  const e = err as Error & { providerCode?: unknown; statusCode?: unknown };
  const code = typeof e.providerCode === "string" ? e.providerCode : err.name;
  const status = typeof e.statusCode === "number" ? ` ${e.statusCode}` : "";
  return `${code}${status}`;
}
