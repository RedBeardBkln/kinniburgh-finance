import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableScroll } from "@/components/ui/table-scroll";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { FeeUnknownList, PayoutLinker, StripeFlagsList } from "@/components/invoicing/online-payments";
import { PAY_FEATURE_NOT_SET_UP } from "@/lib/invoicing/constants";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { loadOnlinePaymentsOverview, loadPaySettings } from "@/lib/invoicing/pay-build";
import { formatNyDateTime } from "@/lib/invoicing/state";

// The owner's "Online payments" page (Phase 2): flags to review, unmatched Stripe events, payments whose Stripe fee is not known yet, and
// linking one bank payout deposit to several Stripe payments (task 2.6). Everyone signed in can view it; every button is owner-only (and
// so is every action behind it). Nothing here reverses a payment.

// "Fetch fee" calls Stripe from this page's server action.
export const maxDuration = 30;

interface PageProps {
  params: Promise<{ slug: string }>;
}

const OUTCOME_TEXT: Record<string, string> = {
  unmatched_metadata: "Not one of our payment links (no invoice reference)",
  unmatched_reference: "The invoice reference did not match",
  unmatched_invoice: "The invoice was not found",
  unmatched_entity: "Invoicing is not enabled for that business",
  unmatched_currency: "Not a US-dollar payment",
  unmatched_amount: "No amount was paid",
  unmatched_payment_intent: "Stripe did not name the payment",
  unmatched_status: "The payment was not complete",
  unmatched_payment: "No recorded payment matches this refund or dispute",
  unsupported_format: "Stripe sent an event format this app does not read (check the webhook is set to snapshot events)",
};

export default async function OnlinePaymentsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed") notFound();

  const shell = (children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Online payments</h1>
          <p className="text-sm text-muted-foreground">Card and bank (ACH) payments clients made through Stripe from their invoice link.</p>
        </div>
        <InvoicingNav slug={slug} active="online" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell(<NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell(<NeedsSetupNotice slug={slug} />);

  const [settings, overview] = await Promise.all([loadPaySettings(ctx.entity.id), loadOnlinePaymentsOverview(ctx.entity.id)]);
  if (overview.status !== "ok" || settings.status !== "ok") {
    return shell(
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">{PAY_FEATURE_NOT_SET_UP}</CardContent>
      </Card>
    );
  }
  const canEdit = ctx.owner.allowed;

  return shell(
    <>
      <p className="text-sm">
        Online payments are <strong>{settings.stripePayEnabled ? "on" : "off"}</strong> (change it in Invoicing settings).
        {!canEdit ? ` View only. ${ctx.owner.reason ?? ""}` : ""}
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Needs review</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StripeFlagsList slug={slug} flags={overview.flags} canEdit={canEdit} showInvoice />
          {overview.unmatched.length > 0 ? (
            <div className="space-y-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Stripe events that matched no invoice</h3>
              <p className="text-xs text-muted-foreground">Nothing was recorded for these. Look them up in the Stripe Dashboard by their event id.</p>
              <TableScroll>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2">Received</th>
                      <th>Event</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.unmatched.map((u) => (
                      <tr key={u.id} className="border-b align-top last:border-0">
                        <td className="whitespace-nowrap py-2 pr-2">{formatNyDateTime(u.receivedAt)}</td>
                        <td className="pr-2">
                          {u.type}
                          <span className="block break-all text-xs text-muted-foreground">{u.id}</span>
                        </td>
                        <td>{OUTCOME_TEXT[u.outcome] ?? u.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stripe fee not known yet</CardTitle>
        </CardHeader>
        <CardContent>
          <FeeUnknownList slug={slug} payments={overview.feeUnknown} canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waiting for a bank deposit</CardTitle>
        </CardHeader>
        <CardContent>
          <PayoutLinker slug={slug} payments={overview.awaitingDeposit} canEdit={canEdit} />
        </CardContent>
      </Card>
    </>
  );
}
