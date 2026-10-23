// The environment side of "is online payment possible" (plan P3, P4, P5): the Stripe pre-flight and the link origin. Takes the
// environment as a parameter (callers pass process.env); never returns or logs a value, only booleans, a mode word and the public origin.
//
// Links are built ONLY from NEXTAUTH_URL through the repo's existing `resolveAppBaseUrl` (never VERCEL_URL, never a request's Host or
// forwarded headers, which are attacker-influenced on a public route). In live mode the origin must be https.

import { resolveAppBaseUrl } from "@/lib/sms-sender";
import { payLinkBaseUrl } from "@/lib/invoicing/stripe/eligibility";
import { stripePreflight, type StripeMode, type StripePreflight } from "@/lib/invoicing/stripe/preflight";

export interface PayEnvironment {
  preflight: StripePreflight;
  configured: boolean;
  mode: StripeMode | null;
  /** The link origin (no trailing slash), or null when it cannot be used. */
  baseUrl: string | null;
}

export function payEnvironment(env: Readonly<Record<string, string | undefined>>): PayEnvironment {
  const preflight = stripePreflight(env);
  const mode = preflight.ok ? preflight.mode : null;
  return { preflight, configured: preflight.ok, mode, baseUrl: payLinkBaseUrl(resolveAppBaseUrl({ ...env }), mode) };
}
