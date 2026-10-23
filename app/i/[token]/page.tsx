import type { Metadata } from "next";
import { InvalidInvoiceLink, PublicInvoice } from "@/components/invoicing/public/public-invoice";
import { loadInvoicePdfSource } from "@/lib/invoicing/pdf-build";
import { loadPaySettings, resolvePublicAccess } from "@/lib/invoicing/pay-build";
import { toPublicInvoiceView } from "@/lib/invoicing/public-view";
import { payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";

// The EK Consulting client's invoice link (/i/<token>). SANCTIONED EXCEPTION to "every page calls auth()": the client has no session.
// The middleware lets /i through; the gate is the TOKEN, validated HERE on every render (shape check, hash lookup, revoked / expired /
// not an invoice of the allow-listed entity -> the same neutral page) and again in every export of actions/public-invoice.ts. No
// AppShell, no link into the app. This render performs no writes (a link-preview bot's GET must not count as a view; the view is
// counted from the client after mount).

export const dynamic = "force-dynamic";
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

  const [source, settings] = await Promise.all([loadInvoicePdfSource(access.documentId, { hideEin: true, noLogo: true }), loadPaySettings(access.entityId)]);
  if (source.status !== "ok" || source.entityId !== access.entityId) return <InvalidInvoiceLink />;
  const env = payEnvironment(process.env);
  const eligible = payOnlineEligibility({
    enabled: settings.status === "ok" && settings.stripePayEnabled,
    configured: env.configured,
    baseUrl: env.baseUrl,
    status: source.input.status,
    balanceCents: source.input.balanceCents,
  });
  return <PublicInvoice view={toPublicInvoiceView(source.input, { canPayOnline: eligible.ok })} token={token} />;
}
