import * as Sentry from "@sentry/nextjs";
import { scrubQueueTokensFromEvent } from "./lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  // /queue/<token> is a bearer credential in the URL path; never send it to Sentry.
  beforeSend: (event) => scrubQueueTokensFromEvent(event),
  beforeSendTransaction: (event) => scrubQueueTokensFromEvent(event),
});
