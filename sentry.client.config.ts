// Client-side Sentry is intentionally DISABLED for this application.
//
// The household runs ad blockers, which block Sentry's ingest endpoint
// (net::ERR_BLOCKED_BY_CLIENT). With the SDK active under a blocker, its
// wrapped-fetch/router instrumentation fired unhandled rejections during
// hydration that unmounted the React tree — a hard white screen with no
// application error in the console. This is a private, two-person app;
// client telemetry is not worth that failure mode.
//
// Server-side Sentry (sentry.server.config.ts / sentry.edge.config.ts via
// instrumentation.ts) remains active and unaffected.

export {};