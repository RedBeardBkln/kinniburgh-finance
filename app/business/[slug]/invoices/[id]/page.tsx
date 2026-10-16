import Link from "next/link";
import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { InvoiceActions } from "@/components/invoicing/invoice-actions";
import { InvoiceEditor } from "@/components/invoicing/invoice-editor";
import { PaymentForm, PaymentsList } from "@/components/invoicing/payment-forms";
import { loadClients } from "@/lib/invoicing/clients-build";
import { loadCostTransactionOptions, loadGlCodes, loadItems } from "@/lib/invoicing/catalog-build";
import { loadInvoiceDetail } from "@/lib/invoicing/documents-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { formatCents } from "@/lib/invoicing/money";
import { loadClientPayments, loadOpenInvoices } from "@/lib/invoicing/payments-build";
import { DISPLAY_STATE_LABELS, nyToday } from "@/lib/invoicing/state";
import { toIsoDate, isUuid } from "@/lib/invoicing/validate";

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}

const EVENT_LABELS: Record<string, string> = {
  created: "Draft created",
  edited: "Draft edited",
  issued: "Issued",
  voided: "Voided",
  archived: "Draft archived",
  payment_recorded: "Payment recorded",
  payment_voided: "Payment voided",
  allocated: "Payment applied",
  deallocated: "Application removed",
  deposit_linked: "Bank deposit linked",
  deposit_unlinked: "Bank deposit unlinked",
};

export default async function InvoiceDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug, id } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed" || !isUuid(id)) notFound();

  const shell = (title: string, children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <InvoicingNav slug={slug} active="invoices" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell("Invoice", <NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell("Invoice", <NeedsSetupNotice slug={slug} />);

  const today = nyToday(new Date());
  const detail = await loadInvoiceDetail(ctx.entity.id, id, today);
  if (!detail) notFound();

  if (detail.status === "draft" && ctx.owner.allowed) {
    const [clients, items, gl, costs] = await Promise.all([
      loadClients(ctx.entity.id),
      loadItems(ctx.entity.id),
      loadGlCodes(ctx.entity.id),
      loadCostTransactionOptions(ctx.entity.id, today),
    ]);
    const incomeAccounts = gl.filter((g) => g.type === "revenue");
    const services = incomeAccounts.find((g) => g.name.trim().toLowerCase() === "services") ?? null;
    return shell(
      "Draft invoice",
      <InvoiceEditor
        slug={slug}
        clients={clients.map((c) => ({ id: c.id, name: c.name, defaultNetDays: c.defaultNetDays, defaultTaxable: c.defaultTaxable }))}
        items={items}
        glOptions={incomeAccounts}
        costOptions={costs}
        defaultGlId={services?.id ?? null}
        profile={{
          defaultNetDays: ctx.profile.defaultNetDays,
          termsLabel: ctx.profile.termsLabel,
          einLast4: ctx.profile.einLast4,
          includeRemitToByDefault: ctx.profile.includeRemitToByDefault,
          hasRemitBank: ctx.profile.hasRemitBank,
          hasMailing: Boolean(ctx.profile.remitToMailingAddress),
        }}
        canIssue={ctx.owner.allowed}
        setupMissing={ctx.profile.setupMissing}
        initial={detail}
      />
    );
  }

  const [openInvoices, clientPayments] = await Promise.all([loadOpenInvoices(ctx.entity.id, detail.clientId), loadClientPayments(ctx.entity.id, detail.clientId)]);
  const related = clientPayments.filter((p) => p.allocations.some((a) => a.invoiceId === detail.id));
  const activeApplications = detail.allocations.filter((a) => a.voidedAt === null);
  const voidBlockedReason = activeApplications.length > 0 ? "This invoice has payments applied. Remove those applications (or void the payments) first, then void the invoice." : null;
  const stateVariant = detail.state === "paid" ? "success" : detail.state === "void" ? "secondary" : detail.overdue ? "destructive" : "outline";

  return shell(
    detail.status === "draft" ? "Draft invoice" : `Invoice ${detail.displayNumber ?? ""}`,
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={stateVariant}>{DISPLAY_STATE_LABELS[detail.state]}</Badge>
        {detail.status === "draft" ? <span className="text-xs text-muted-foreground">Draft (view only: only the owner can edit or issue it).</span> : null}
        {detail.overdue ? <span className="text-sm text-red-700">{detail.daysPastDue} days past due</span> : null}
        <Link className="text-sm text-primary underline" href={`/business/${slug}/clients/${detail.clientId}` as Route}>
          {detail.clientName}
        </Link>
        {detail.state === "issued_unsent" ? <span className="text-xs text-muted-foreground">Issued, not sent. Download the PDF to send it yourself (e-mail delivery is a later step).</span> : null}
      </div>

      <InvoiceActions slug={slug} documentId={detail.id} status={detail.status} canEdit={ctx.owner.allowed} voidBlockedReason={voidBlockedReason} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-3">
          <div>Issue date: {detail.issueDate ?? "—"}</div>
          <div>Due: {detail.netDays && detail.netDays > 0 ? `${detail.dueDate} (net ${detail.netDays})` : ctx.profile.termsLabel}</div>
          <div>Billing type: {detail.billingModel}</div>
          {detail.title ? <div className="sm:col-span-3">Title: {detail.title}</div> : null}
          {detail.poNumber ? <div>PO: {detail.poNumber}</div> : null}
          {detail.status === "void" ? <div className="sm:col-span-3 text-red-700">Voided on {detail.voidedAt ? toIsoDate(new Date(detail.voidedAt)) : ""}: {detail.voidReason}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Description</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Rate</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0 align-top">
                  <td className="py-2">
                    {l.description}
                    {l.workDate ? <span className="block text-xs text-muted-foreground">Work date {l.workDate}</span> : null}
                    {l.discountKind ? <span className="block text-xs text-muted-foreground">{l.discountKind === "percent" ? `${l.discountValueText}% off` : `$${l.discountValueText} off`}</span> : null}
                  </td>
                  <td className="text-right">
                    {l.quantity}
                    {l.unit ? ` ${l.unit}` : ""}
                  </td>
                  <td className="text-right">{formatCents(l.unitPriceCents)}</td>
                  <td className="text-right">{formatCents(l.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto mt-4 max-w-xs space-y-1 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatCents(detail.subtotalCents)}</dd>
            </div>
            {detail.discountCents > 0 ? (
              <div className="flex justify-between">
                <dt>Discount</dt>
                <dd>-{formatCents(detail.discountCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t pt-1 font-semibold">
              <dt>Total</dt>
              <dd>{formatCents(detail.totalCents)}</dd>
            </div>
            {detail.status === "issued" ? (
              <>
                <div className="flex justify-between">
                  <dt>Applied</dt>
                  <dd>-{formatCents(detail.allocatedCents)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>Balance</dt>
                  <dd>{formatCents(detail.balanceCents)}</dd>
                </div>
              </>
            ) : null}
          </dl>
          {detail.notes ? <p className="mt-4 whitespace-pre-line text-sm text-muted-foreground">{detail.notes}</p> : null}
        </CardContent>
      </Card>

      {detail.status === "issued" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <PaymentsList slug={slug} payments={related} openInvoices={openInvoices} canAct={ctx.owner.allowed} />
            {detail.balanceCents > 0 ? (
              <div className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-semibold">Record a payment or deposit received</h3>
                <PaymentForm slug={slug} clientId={detail.clientId} openInvoices={openInvoices} presetInvoiceId={detail.id} todayIso={toIsoDate(today)} canRecord={ctx.owner.allowed} ownerReason={ctx.owner.reason} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {detail.events.map((e) => (
              <li key={e.id} className="flex justify-between">
                <span>{EVENT_LABELS[e.kind] ?? e.kind}</span>
                <span className="text-xs text-muted-foreground">{e.createdAt.slice(0, 16).replace("T", " ")} UTC</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
