import * as Sentry from "@sentry/nextjs";

// The household runs ad blockers, which block Sentry's ingest endpoints
// (ERR_BLOCKED_BY_CLIENT). A blocked transport must never cascade into an
// unhandled rejection that unmounts the React tree (white screen), so the
// client SDK is initialized defensively:
// - No session replay (its worker + envelope uploads are the most commonly
//   blocked assets and were the crash vector).
// - Errors are logged locally as a fallback when the transport is blocked.
try {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // Replay disabled: the replay worker bundle is a top ad-block target and
    // its failure path previously crashed the page.
    replaysOnErrorSampleRate: 0.0,
    replaysSessionSampleRate: 0.0,
    beforeSend(event) {
      // Local visibility when the network transport is blocked by a client
      if (typeof console !== "undefined") {
        console.warn("[sentry] event suppressed or transport may be blocked:", event?.exception?.values?.[0]?.value ?? "unknown");
      }
      return event;
    },
  });
} catch (err) {
  // Never let Sentry initialization itself break the app
  console.warn("[sentry] init failed (non-fatal):", err);
}
