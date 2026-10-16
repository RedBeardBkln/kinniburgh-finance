import Link from "next/link";
import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { ClientEinPanel, ClientForm, ContactsPanel, W9Panel } from "@/components/invoicing/client-forms";
import { PaymentForm, PaymentsList } from "@/components/invoicing/payment-forms";
import { loadW9Documents } from "@/lib/invoicing/catalog-build";
import { loadClient } from "@/lib/invoicing/clients-build";
import { loadInvoiceRows } from "@/lib/invoicing/documents-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { formatCents } from "@/lib/invoicing/money";
import { loadClientPayments, loadOpenInvoices } from "@/lib/invoicing/payments-build";
import { DISPLAY_STATE_LABELS, nyToday } from "@/lib/invoicing/state";
import { isUuid, toIsoDate } from "@/lib/invoicing/validate";

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}

export default async function ClientDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug, id } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed" || !isUuid(id)) notFound();

  const shell = (title: string, children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <InvoicingNav slug={slug} active="clients" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell("Client", <NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell("Client", <NeedsSetupNotice slug={slug} />);

  const client = await loadClient(ctx.entity.id, id);
  if (!client) notFound();
  const today = nyToday(new Date());
  const [rows, payments, openInvoices, w9Options] = await Promise.all([
    loadInvoiceRows(ctx.entity.id, today),
    loadClientPayments(ctx.entity.id, id),
    loadOpenInvoices(ctx.entity.id, id),
    loadW9Documents(ctx.entity.id),
  ]);
  const invoices = rows.filter((r) => r.clientId === id);
  const balance = invoices.filter((r) => r.status === "issued").reduce((s, r) => s + r.balanceCents, 0);
  const deposits = payments.reduce((s, p) => s + p.unappliedDepositCents, 0);
  // Everything that changes data is owner-only; the page decides read-only mode on the server and passes a plain boolean.
  const readOnly = !ctx.owner.allowed;

  return shell(
    client.name,
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Open balance</div>
            <div className="text-xl font-semibold">{formatCents(balance)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Unapplied deposits</div>
            <div className="text-xl font-semibold">{formatCents(deposits)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">W-9</div>
            <div className="text-xl font-semibold">{client.w9OnFile ? "On file" : "Not on file"}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {readOnly ? null : (
            <Link className="inline-block text-sm text-primary underline" href={`/business/${slug}/invoices/new?client=${id}` as Route}>
              New invoice for this client
            </Link>
          )}
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {invoices.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2">
                      <Link className="text-primary underline" href={`/business/${slug}/invoices/${r.id}` as Route}>
                        {r.displayNumber ?? "Draft"}
                      </Link>
                    </td>
                    <td>{r.issueDate ?? "—"}</td>
                    <td>
                      <Badge variant={r.state === "paid" ? "success" : r.overdue ? "destructive" : "outline"}>{DISPLAY_STATE_LABELS[r.state]}</Badge>
                    </td>
                    <td className="text-right">{formatCents(r.totalCents)}</td>
                    <td className="text-right">{r.status === "issued" ? formatCents(r.balanceCents) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <PaymentsList slug={slug} payments={payments} openInvoices={openInvoices} canAct={ctx.owner.allowed} />
          {readOnly ? null : (
            <div className="space-y-2 border-t pt-4">
              <h3 className="text-sm font-semibold">Record a payment</h3>
              <PaymentForm slug={slug} clientId={id} openInvoices={openInvoices} todayIso={toIsoDate(today)} canRecord={ctx.owner.allowed} ownerReason={ctx.owner.reason} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contacts</CardTitle>
        </CardHeader>
        <CardContent>
          <ContactsPanel slug={slug} clientId={id} contacts={client.contacts} readOnly={readOnly} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client details</CardTitle>
        </CardHeader>
        <CardContent>
          <ClientForm slug={slug} client={client} readOnly={readOnly} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">EIN</CardTitle>
        </CardHeader>
        <CardContent>
          <ClientEinPanel slug={slug} clientId={id} last4={client.einLast4} canReveal={ctx.owner.allowed} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">W-9</CardTitle>
        </CardHeader>
        <CardContent>
          <W9Panel slug={slug} clientId={id} entityId={ctx.entity.id} onFile={client.w9OnFile} label={client.w9Label} receivedOn={client.w9ReceivedOn} options={w9Options} readOnly={readOnly} />
        </CardContent>
      </Card>
    </>
  );
}
