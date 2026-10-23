// The environment side of "is online payment possible" (plan P3, P4, P5): the Stripe pre-flight and the link origin. Takes the
// environment as a parameter (callers pass process.env); never returns or logs a value, only booleans, a mode word, a problem word and
// the public origin.
//
// This is the ONLY place the origin of a client link is resolved (the e-mail link, the client PDF's pay line, a link made on the invoice
// page and Checkout's /i/paid and /i/cancelled return pages all read `payEnvironment(...).baseUrl`). Links are built from
// INVOICE_PUBLIC_BASE_URL when it is set (a separate pay domain; validated by lib/invoicing/public-base-url.ts), otherwise from
// NEXTAUTH_URL through the repo's existing `resolveAppBaseUrl`; never from VERCEL_URL, a request's Host or forwarded headers, which are
// attacker-influenced on a public route. An INVALID INVOICE_PUBLIC_BASE_URL never falls back to NEXTAUTH_URL: no link can be built
// (eligibility "no_base_url") and the owner's messages name the variable, so a typo is noticed instead of silently sending clients to
// the other origin. In live mode the origin must be https.

import { resolveAppBaseUrl } from "@/lib/sms-sender";
import { payLinkBaseUrl } from "@/lib/invoicing/stripe/eligibility";
import { INVOICE_PUBLIC_BASE_URL_VAR, parseInvoicePublicBaseUrl } from "@/lib/invoicing/public-base-url";
import { stripePreflight, type StripeMode, type StripePreflight } from "@/lib/invoicing/stripe/preflight";

export { INVOICE_PUBLIC_BASE_URL_VAR, parseInvoicePublicBaseUrl };

/** Why no link origin is available (null when one is). */
export type PayBaseUrlProblem = "invoice_public_base_url_invalid" | "app_url_missing" | "app_url_not_https";

export interface PayEnvironment {
  preflight: StripePreflight;
  configured: boolean;
  mode: StripeMode | null;
  /** The link origin (no trailing slash), or null when it cannot be used. */
  baseUrl: string | null;
  /** Which variable the origin comes from (null when there is none). */
  baseUrlSource: "invoice_public_base_url" | "nextauth_url" | null;
  baseUrlProblem: PayBaseUrlProblem | null;
}

export function payEnvironment(env: Readonly<Record<string, string | undefined>>): PayEnvironment {
  const preflight = stripePreflight(env);
  const mode = preflight.ok ? preflight.mode : null;
  const base = { preflight, configured: preflight.ok, mode };
  const publicRaw = env[INVOICE_PUBLIC_BASE_URL_VAR];
  if (publicRaw !== undefined && publicRaw.trim() !== "") {
    // Set: used when valid, otherwise NO origin (never a silent fallback to NEXTAUTH_URL).
    const origin = payLinkBaseUrl(parseInvoicePublicBaseUrl(publicRaw, mode), mode);
    return origin
      ? { ...base, baseUrl: origin, baseUrlSource: "invoice_public_base_url", baseUrlProblem: null }
      : { ...base, baseUrl: null, baseUrlSource: null, baseUrlProblem: "invoice_public_base_url_invalid" };
  }
  const app = resolveAppBaseUrl({ ...env });
  const origin = payLinkBaseUrl(app, mode);
  if (origin) return { ...base, baseUrl: origin, baseUrlSource: "nextauth_url", baseUrlProblem: null };
  return { ...base, baseUrl: null, baseUrlSource: null, baseUrlProblem: app ? "app_url_not_https" : "app_url_missing" };
}

/** The owner's sentence for an invalid INVOICE_PUBLIC_BASE_URL (the variable's name only, never its value). */
export const INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE =
  "INVOICE_PUBLIC_BASE_URL is invalid, so no client link can be built. It must be an https origin only (for example https://pay.example.com, no path); fix it or remove it in Vercel.";

/** The owner's sentence for a missing link origin (variable names only, never a value). */
export function payBaseUrlProblemMessage(problem: PayBaseUrlProblem): string {
  switch (problem) {
    case "invoice_public_base_url_invalid":
      return INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE;
    case "app_url_not_https":
      return "NEXTAUTH_URL must be the app's public https address in live mode.";
    case "app_url_missing":
      return "NEXTAUTH_URL (the app's public address) is not set, so no client link can be built.";
  }
}
