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
import { SendInvoiceButton } from "@/components/invoicing/send-invoice";
import { PaymentForm, PaymentsList } from "@/components/invoicing/payment-forms";
import { loadClient, loadClients } from "@/lib/invoicing/clients-build";
import { emailPreflight, invoiceRecipients, SEND_FAILURE_MESSAGES, type SendFailureCategory } from "@/lib/invoicing/email";
import { loadCostTransactionOptions, loadGlCodes, loadItems } from "@/lib/invoicing/catalog-build";
import { loadInvoiceDetail } from "@/lib/invoicing/documents-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { formatCents } from "@/lib/invoicing/money";
import { loadClientPayments, loadOpenInvoices } from "@/lib/invoicing/payments-build";
import { DISPLAY_STATE_LABELS, formatNyDateTime, nyToday } from "@/lib/invoicing/state";
import { toIsoDate, isUuid } from "@/lib/invoicing/validate";
import { TableScroll } from "@/components/ui/table-scroll";
import { PayLinksCard } from "@/components/invoicing/pay-links";
import { BankPendingList, StripeFlagsList, type BankPendingRow } from "@/components/invoicing/online-payments";
import { PAY_FEATURE_NOT_SET_UP, STRIPE_FLAG_LABELS, type StripeFlagReason } from "@/lib/invoicing/constants";
import { loadBankPendingFor, loadInvoiceLinks, loadInvoiceStripeFlags, loadPaySettings } from "@/lib/invoicing/pay-build";
import { OWNER_BANK_PENDING_UNREADABLE, type BankPendingState } from "@/lib/invoicing/stripe/bank-pending";
import { payLinkSendNote, payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";

// Rendering and e-mailing the PDF runs inside this page's server actions ("Save as final and send", "Send invoice").
export const maxDuration = 30;

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ send?: string }>;
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
  emailed: "Sent by e-mail",
  email_failed: "E-mail not delivered",
  link_created: "Client link created",
  link_revoked: "Client link revoked",
  link_viewed: "Client opened the link",
  checkout_started: "Online payment started",
  stripe_flag: "Online payment flagged",
  stripe_flag_reviewed: "Flag reviewed",
  fee_recorded: "Stripe fee recorded",
  bank_payment_pending: "Bank payment processing (ACH)",
  bank_payment_released: "Stopped waiting for a bank payment",
};

function eventLabel(kind: string, data: Record<string, string | number | boolean | null>): string {
  const base = EVENT_LABELS[kind] ?? kind;
  if (kind === "emailed") {
    const n = typeof data.recipientCount === "number" ? data.recipientCount : null;
    const resent = typeof data.sendNumber === "number" && data.sendNumber > 1;
    return `${resent ? "Resent by e-mail" : base}${n ? ` to ${n} recipient${n === 1 ? "" : "s"}` : ""}${data.payLink === true ? ", with a pay link" : ""}`;
  }
  if (kind === "stripe_flag" && typeof data.reason === "string" && data.reason in STRIPE_FLAG_LABELS) return `${base}: ${STRIPE_FLAG_LABELS[data.reason as StripeFlagReason]}`;
  if (kind === "link_revoked" && typeof data.count === "number" && data.count > 1) return `${data.count} client links revoked`;
  return base;
}

// "Save as final and send" lands here with ?send=<outcome>; only these fixed values are read (never echoed text).
const SEND_NOTICE: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Saved as final and e-mailed." },
  ok_nolink: { ok: true, text: "Saved as final and e-mailed, without a pay link: online payments are on but not set up (see Invoicing settings)." },
  ok_bankpending: { ok: true, text: "Saved as final and e-mailed, without a pay link: a bank payment for this invoice is still processing." },
  ok_nolinkcheck: { ok: true, text: "Saved as final and e-mailed, without a pay link: the bank payment status could not be checked." },
  ...Object.fromEntries(
    (Object.keys(SEND_FAILURE_MESSAGES) as SendFailureCategory[]).map((k) => [k, { ok: false, text: `Saved as final, but not e-mailed. ${SEND_FAILURE_MESSAGES[k]}` }])
  ),
  failed: { ok: false, text: "Saved as final, but the e-mail could not be sent. Use Send invoice to try again." },
};
export default async function InvoiceDetailPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug, id } = await params;
  const sendNotice = SEND_NOTICE[(await searchParams).send ?? ""] ?? null;
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
        clients={clients.map((c) => ({ id: c.id, name: c.name, defaultNetDays: c.defaultNetDays, defaultTaxable: c.defaultTaxable, recipients: invoiceRecipients(c.contacts) }))}
        emailReady={emailPreflight(process.env).ok}
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

  const [openInvoices, clientPayments, client, pay, links, flags] = await Promise.all([
    loadOpenInvoices(ctx.entity.id, detail.clientId),
    loadClientPayments(ctx.entity.id, detail.clientId),
    loadClient(ctx.entity.id, detail.clientId, { includeArchived: true }),
    loadPaySettings(ctx.entity.id),
    loadInvoiceLinks(ctx.entity.id, detail.id, new Date()),
    loadInvoiceStripeFlags(ctx.entity.id, detail.id),
  ]);
  // Online payments (Phase 2): what the next e-mail will carry, decided here on the server (booleans and fixed sentences only).
  const onlineOn = pay.status === "ok" && pay.stripePayEnabled;
  const payEnv = payEnvironment(process.env);
  // A bank (ACH) payment still processing (fail soft here: the page shows one line; the send action re-checks and fails closed).
  let bankPending: BankPendingState | null = null;
  let bankPendingFailed = false;
  try {
    bankPending = await loadBankPendingFor(ctx.entity.id, detail.id, payEnv.mode, today);
  } catch (err) {
    console.error("Bank payment status could not be read", err instanceof Error ? err.name : "UnknownError");
    bankPendingFailed = true;
  }
  const bankRows: BankPendingRow[] = bankPending ? bankPending.items.map((i) => ({ ...i, documentId: detail.id, invoiceNumber: detail.displayNumber })) : [];
  const eligible = payOnlineEligibility({
    enabled: onlineOn,
    configured: payEnv.configured,
    baseUrl: payEnv.baseUrl,
    status: detail.status,
    balanceCents: detail.balanceCents,
    bankPending: bankPendingFailed || bankPending !== null,
  });
  const payLinkNote = payLinkSendNote(onlineOn, eligible, payEnv.baseUrlProblem === "invoice_public_base_url_invalid");
  const recipients = client ? invoiceRecipients(client.contacts) : [];
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
        {detail.state === "issued_unsent" ? <span className="text-xs text-muted-foreground">Final, not sent yet. Nothing is e-mailed until you click Send invoice.</span> : null}
      </div>

      {sendNotice ? (
        <p className={sendNotice.ok ? "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" : "rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900"}>{sendNotice.text}</p>
      ) : null}

      {detail.status === "issued" && ctx.owner.allowed ? (
        <SendInvoiceButton
          slug={slug}
          documentId={detail.id}
          displayNumber={detail.displayNumber ?? ""}
          sendCount={detail.sendCount}
          lastSentText={detail.lastSentAt ? formatNyDateTime(detail.lastSentAt) : null}
          recipients={recipients}
          emailReady={emailPreflight(process.env).ok}
          payLinkNote={payLinkNote}
        />
      ) : detail.lastSentAt ? (
        <p className="text-xs text-muted-foreground">
          Last sent {formatNyDateTime(detail.lastSentAt)}
          {detail.sendCount > 1 ? ` (sent ${detail.sendCount} times)` : ""}
        </p>
      ) : null}

      <InvoiceActions slug={slug} documentId={detail.id} status={detail.status} canEdit={ctx.owner.allowed} voidBlockedReason={voidBlockedReason} />
      {onlineOn && detail.status === "issued" ? (
        <p className="text-xs text-muted-foreground">Downloaded PDFs do not include the pay link. E-mailed copies do, and so does the PDF on the client&apos;s link page.</p>
      ) : null}

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
          <TableScroll>
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
          </TableScroll>
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

      {bankRows.length > 0 || bankPendingFailed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bank payment processing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {bankPendingFailed ? (
              <p className="text-sm text-muted-foreground">{OWNER_BANK_PENDING_UNREADABLE}</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">The client started a bank (ACH) payment. &quot;Pay online&quot; stays hidden for this invoice until Stripe reports the result.</p>
                <BankPendingList slug={slug} rows={bankRows} canEdit={ctx.owner.allowed} showInvoice={false} />
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {flags.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Needs your review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">Online payments that need a look. Nothing was reversed: decide what to do (for example apply a deposit on account), then mark it reviewed.</p>
            <StripeFlagsList slug={slug} flags={flags} canEdit={ctx.owner.allowed} showInvoice={false} />
          </CardContent>
        </Card>
      ) : null}

      {detail.status === "issued" || (links.status === "ok" && links.links.length > 0) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client link</CardTitle>
          </CardHeader>
          <CardContent>
            {links.status === "ok" ? (
              <PayLinksCard slug={slug} documentId={detail.id} links={links.links} canEdit={ctx.owner.allowed} issued={detail.status === "issued"} />
            ) : (
              <p className="text-sm text-muted-foreground">{PAY_FEATURE_NOT_SET_UP}</p>
            )}
          </CardContent>
        </Card>
      ) : null}

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
                <span>{eventLabel(e.kind, e.data)}</span>
                <span className="text-xs text-muted-foreground">{formatNyDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
