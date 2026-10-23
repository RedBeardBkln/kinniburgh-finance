import { NextResponse } from "next/server";
import { INVALID_LINK_MESSAGE } from "@/lib/invoicing/constants";
import { invoiceLinkUrl } from "@/lib/invoicing/access-token";
import { loadInvoicePdfSource } from "@/lib/invoicing/pdf-build";
import { loadPaySettings, resolvePublicAccess } from "@/lib/invoicing/pay-build";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";

// The invoice PDF for the client's link (/i/<token>/pdf). SANCTIONED EXCEPTION to "every route starts with auth()": the gate is the
// TOKEN, validated FIRST on every request; any invalid token is a 404 with the neutral sentence. The PDF is the owner's invoice PDF
// without the business EIN, plus the "Pay online" line (this same link) while online payments apply. Nothing is stored; never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await resolvePublicAccess(token, new Date());
  if (!access.ok) return new NextResponse(INVALID_LINK_MESSAGE, { status: 404, headers: NO_STORE });

  try {
    const source = await loadInvoicePdfSource(access.documentId, { hideEin: true });
    if (source.status !== "ok" || source.entityId !== access.entityId) return new NextResponse(INVALID_LINK_MESSAGE, { status: 404, headers: NO_STORE });
    const settings = await loadPaySettings(access.entityId);
    const env = payEnvironment(process.env);
    const eligible = payOnlineEligibility({
      enabled: settings.status === "ok" && settings.stripePayEnabled,
      configured: env.configured,
      baseUrl: env.baseUrl,
      status: source.input.status,
      balanceCents: source.input.balanceCents,
    });
    const input = eligible.ok && env.baseUrl ? { ...source.input, payOnline: { url: invoiceLinkUrl(env.baseUrl, token) } } : source.input;
    const rendered = await renderInvoicePdf(input, { logo: source.logo });
    return new NextResponse(Buffer.from(rendered.bytes), {
      status: 200,
      headers: { ...NO_STORE, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${source.filename}"` },
    });
  } catch (err) {
    console.error("Client invoice PDF failed", err instanceof Error ? err.name : "UnknownError");
    return new NextResponse("The PDF could not be generated", { status: 500, headers: NO_STORE });
  }
}
