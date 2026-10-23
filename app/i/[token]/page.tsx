import type { Metadata } from "next";
import { InvalidInvoiceLink, PublicInvoice } from "@/components/invoicing/public/public-invoice";
import { loadInvoicePdfSource } from "@/lib/invoicing/pdf-build";
import { loadBankPendingFor, loadPaySettings, resolvePublicAccess } from "@/lib/invoicing/pay-build";
import { toPublicInvoiceView } from "@/lib/invoicing/public-view";
import { payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";
import { publicBankPendingText, type BankPendingState } from "@/lib/invoicing/stripe/bank-pending";
import { nyToday } from "@/lib/invoicing/state";

// The EK Consulting client's invoice link (/i/<token>). SANCTIONED EXCEPTION to "every page calls auth()": the client has no session.
// The middleware lets /i through; the gate is the TOKEN, validated HERE on every render (shape check, hash lookup, revoked / expired /
// not an invoice of the allow-listed entity -> the same neutral page) and again in every export of actions/public-invoice.ts. No
// AppShell, no link into the app. This render performs no writes (a link-preview bot's GET must not count as a view; the view is
// counted from the client after mount).

export const dynamic = "force-dynamic";

const LOGO_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
// "Pay online" runs startCheckout (one Stripe call) under this route's limit.
export const maxDuration = 30;

export const metadata: Metadata = {
  title: "Invoice",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function PublicInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await resolvePublicAccess(token, new Date());
  if (!access.ok) return <InvalidInvoiceLink />;

  const [source, settings] = await Promise.all([loadInvoicePdfSource(access.documentId, { hideEin: true }), loadPaySettings(access.entityId)]);
  if (source.status !== "ok" || source.entityId !== access.entityId) return <InvalidInvoiceLink />;
  const env = payEnvironment(process.env);
  // A bank (ACH) payment still processing hides "Pay online" (plan D-2). A failed read fails CLOSED: no button and no notice.
  let pending: BankPendingState | null = null;
  let pendingUnknown = false;
  try {
    pending = await loadBankPendingFor(access.entityId, access.documentId, env.mode, nyToday(new Date()));
  } catch (err) {
    console.error("Bank payment status could not be read", err instanceof Error ? err.name : "UnknownError");
    pendingUnknown = true;
  }
  const eligible = payOnlineEligibility({
    enabled: settings.status === "ok" && settings.stripePayEnabled,
    configured: env.configured,
    baseUrl: env.baseUrl,
    status: source.input.status,
    balanceCents: source.input.balanceCents,
    bankPending: pendingUnknown || pending !== null,
  });
  const bankPending = pending ? { text: publicBankPendingText(pending), overdue: pending.overdue } : null;
  // The same logo as the PDF (an uploaded one, else the LaunchTime logo), inlined so the page needs no extra request on the pay domain.
  const logoSrc = source.logo && LOGO_MIMES.has(source.logo.mime) ? `data:${source.logo.mime};base64,${Buffer.from(source.logo.bytes).toString("base64")}` : null;
  return <PublicInvoice view={toPublicInvoiceView(source.input, { canPayOnline: eligible.ok, bankPending })} token={token} logoSrc={logoSrc} />;
}
