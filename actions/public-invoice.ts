"use server";

// The client's token-gated actions on the public invoice page /i/[token] (EK Consulting invoicing, Phase 2).
//
// SANCTIONED EXCEPTION to the repo rule "every server action starts with requireAuth()": the caller is the invoice's CLIENT, who has no
// NextAuth session, only the link token from the e-mail. EVERY export in this file MUST start with
// `await requireInvoiceAccess(token)`, which validates the token against the DB on that very request (shape check, sha256 hash lookup;
// unknown / revoked / expired / not an open-or-void invoice of the allow-listed entity -> throws the one neutral sentence). Server
// actions are addressable by id regardless of which page renders them, so this check - not the middleware exemption for /i - is the
// security boundary. A test asserts that every export starts with it (modelled on actions/review-queue.ts).
//
// The invoice is ALWAYS derived server-side from the validated token's own row; nothing about which invoice, which amount or who is
// paying is taken from client input (each export takes only the token). Tokens, token URLs and hashes are never logged; errors are
// logged by name only. No AuditLog row is written here (there is no user).

import { auth } from "@/lib/auth";
import { INVALID_LINK_MESSAGE } from "@/lib/invoicing/constants";
import { loadInvoiceDetail } from "@/lib/invoicing/documents-build";
import { InvoicingRefusal } from "@/lib/invoicing/errors";
import { loadBankPendingFor, loadPaySettings, resolvePublicAccess } from "@/lib/invoicing/pay-build";
import { nyToday } from "@/lib/invoicing/state";
import * as store from "@/lib/invoicing/store";
import { buildCheckoutParams } from "@/lib/invoicing/stripe/checkout-params";
import { createCheckoutSession } from "@/lib/invoicing/stripe/client";
import { payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";

const PAY_UNAVAILABLE = "Online payment is not available right now. Please try again later.";
const PAY_NOT_OFFERED = "Online payment is not available for this invoice. Please contact the sender.";
const PAY_BANK_PENDING = "A bank payment for this invoice is still processing, so online payment is paused. Please check back later or contact the sender.";

async function requireInvoiceAccess(token: string) {
  const access = await resolvePublicAccess(token, new Date());
  if (!access.ok) throw new InvoicingRefusal(INVALID_LINK_MESSAGE);
  return access;
}

/**
 * Called from the client's page after mount (never during the server render, so a link-preview bot's GET does not count). The
 * household's own visits (a signed-in session in this browser) are not counted.
 */
export async function markInvoiceViewed(token: string): Promise<{ ok: true }> {
  const access = await requireInvoiceAccess(token);
  let signedIn = false;
  try {
    const session = await auth();
    signedIn = Boolean(session?.user?.id);
  } catch {
    signedIn = false;
  }
  if (signedIn) return { ok: true };
  try {
    await store.markTokenViewed({ tokenId: access.tokenId, now: new Date() });
  } catch (err) {
    console.error("Invoice link view not recorded", err instanceof Error ? err.name : "UnknownError");
  }
  return { ok: true };
}

/**
 * "Pay online": creates (or, inside the same 10-minute bucket for the same balance, replays) a Stripe Checkout Session for the invoice's
 * CURRENT balance, read on the server now. Returns the hosted Checkout URL for the browser to open. The success page only says the payment
 * was received and will be confirmed; the payment itself is recorded only by the signed webhook.
 */
export async function startCheckout(token: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const access = await requireInvoiceAccess(token);
  try {
    const now = new Date();
    const env = payEnvironment(process.env);
    const settings = await loadPaySettings(access.entityId);
    const detail = await loadInvoiceDetail(access.entityId, access.documentId, nyToday(now));
    if (!detail) return { ok: false, error: PAY_NOT_OFFERED };
    // A bank (ACH) payment still processing pauses online payment (never trust the page): checked BEFORE any Stripe call. A read error
    // throws into the outer catch (PAY_UNAVAILABLE), so nothing is started either.
    const bankPending = (await loadBankPendingFor(access.entityId, detail.id, env.mode, nyToday(now))) !== null;
    const eligible = payOnlineEligibility({
      enabled: settings.status === "ok" && settings.stripePayEnabled,
      configured: env.configured,
      baseUrl: env.baseUrl,
      status: detail.status,
      balanceCents: detail.balanceCents,
      bankPending,
    });
    if (!eligible.ok && eligible.reason === "bank_payment_pending") return { ok: false, error: PAY_BANK_PENDING };
    if (!eligible.ok || !env.baseUrl) return { ok: false, error: PAY_NOT_OFFERED };
    const built = buildCheckoutParams({
      invoiceId: detail.id,
      entityId: access.entityId,
      displayNumber: detail.displayNumber ?? "",
      balanceCents: detail.balanceCents,
      baseUrl: env.baseUrl,
      nowMs: now.getTime(),
    });
    let url: string | null;
    try {
      ({ url } = await createCheckoutSession(built.params, built.idempotencyKey));
    } catch (err) {
      console.error("Stripe checkout could not be started", err instanceof Error ? err.name : "UnknownError");
      return { ok: false, error: PAY_UNAVAILABLE };
    }
    if (!url || !/^https:\/\//.test(url)) return { ok: false, error: PAY_UNAVAILABLE };
    try {
      await store.recordCheckoutStarted({ entityId: access.entityId, documentId: detail.id, eventKey: built.idempotencyKey, amountCents: detail.balanceCents });
    } catch (err) {
      console.error("Checkout start not recorded", err instanceof Error ? err.name : "UnknownError");
    }
    return { ok: true, url };
  } catch (err) {
    console.error("Online payment failed", err instanceof Error ? err.name : "UnknownError");
    return { ok: false, error: PAY_UNAVAILABLE };
  }
}
