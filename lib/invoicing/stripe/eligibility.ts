// When a pay link / the "Pay online" button is offered (plan P4). PURE. One rule used by the send action, the client's page, its PDF and
// the Checkout action, so they can never disagree.

import { STRIPE_MIN_CHARGE_CENTS } from "@/lib/invoicing/constants";

export type PayOnlineReason = "off" | "not_configured" | "no_base_url" | "not_issued" | "no_balance" | "below_minimum";
export type PayOnlineEligibility = { ok: true } | { ok: false; reason: PayOnlineReason };

export interface PayOnlineInput {
  /** InvoicingProfile.stripePayEnabled (false when the setting cannot be read). */
  enabled: boolean;
  /** stripePreflight(env).ok */
  configured: boolean;
  /** resolveAppBaseUrl(env) (and https in live mode) */
  baseUrl: string | null;
  status: string;
  balanceCents: number;
}

export function payOnlineEligibility(i: PayOnlineInput): PayOnlineEligibility {
  if (!i.enabled) return { ok: false, reason: "off" };
  if (!i.configured) return { ok: false, reason: "not_configured" };
  if (!i.baseUrl) return { ok: false, reason: "no_base_url" };
  if (i.status !== "issued") return { ok: false, reason: "not_issued" };
  if (!Number.isSafeInteger(i.balanceCents) || i.balanceCents <= 0) return { ok: false, reason: "no_balance" };
  if (i.balanceCents < STRIPE_MIN_CHARGE_CENTS) return { ok: false, reason: "below_minimum" };
  return { ok: true };
}

/** The link origin for this mode: `resolveAppBaseUrl`'s result, refused in live mode unless it is https. */
export function payLinkBaseUrl(baseUrl: string | null, mode: "test" | "live" | null): string | null {
  if (!baseUrl) return null;
  if (mode === "live" && !baseUrl.startsWith("https://")) return null;
  return baseUrl;
}

/**
 * The owner's note beside "Send invoice" about the pay link the next e-mail will (or will not) carry. Null when online payments are
 * off. A fully paid invoice says so; only a balance between $0.01 and $0.49 gets the "less than $0.50" sentence.
 */
export function payLinkSendNote(onlineOn: boolean, eligibility: PayOnlineEligibility): string | null {
  if (!onlineOn) return null;
  if (eligibility.ok) return "The e-mail and its PDF will include a new “View and pay online” link.";
  switch (eligibility.reason) {
    case "off":
      return null;
    case "not_configured":
    case "no_base_url":
      return "Online payments are on but not set up, so this e-mail will go without a pay link.";
    case "not_issued":
      return "No pay link: only an issued invoice can be paid online.";
    case "no_balance":
      return "No pay link: this invoice is paid in full, nothing is due.";
    case "below_minimum":
      return "No pay link: less than $0.50 is due on this invoice.";
  }
}
