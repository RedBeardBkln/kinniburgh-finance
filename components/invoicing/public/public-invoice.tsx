import { TableScroll } from "@/components/ui/table-scroll";
import { INVALID_LINK_MESSAGE } from "@/lib/invoicing/constants";
import { formatCents } from "@/lib/invoicing/money";
import type { PublicInvoiceView } from "@/lib/invoicing/public-view";
import { PayOnlineButton } from "@/components/invoicing/public/pay-online-button";
import { ViewTracker } from "@/components/invoicing/public/view-tracker";

// The client's invoice page (/i/<token>). Server-rendered from a plain `PublicInvoiceView` (lib/invoicing/public-view.ts decides what may
// be shown: never an EIN, internal notes, contacts, GL codes, the timeline or Stripe ids). No AppShell, no link into the app. The two
// client leaves (view tracking after mount, the Pay button) get the token only to call the token-gated actions.

export function InvalidInvoiceLink() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold">This link is no longer valid</h1>
        <p className="text-base text-muted-foreground">{INVALID_LINK_MESSAGE}</p>
      </div>
    </main>
  );
}

export function PublicInvoice({ view, token, track = true }: { view: PublicInvoiceView; token: string; track?: boolean }) {
  const pdfHref = `/i/${token}/pdf`;
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      {track ? <ViewTracker token={token} /> : null}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-0.5">
          <p className="text-lg font-semibold">{view.businessName}</p>
          {view.businessAddressLines.map((l, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              {l}
            </p>
          ))}
        </div>
        <div className="space-y-0.5 text-right text-sm">
          <p className="text-xl font-semibold tracking-wide">INVOICE {view.displayNumber}</p>
          {view.issueDate ? <p>Issued {view.issueDate}</p> : null}
          <p className="text-muted-foreground">{view.dueText}</p>
          {view.poNumber ? <p className="text-muted-foreground">PO {view.poNumber}</p> : null}
        </div>
      </header>

      {view.state === "void" ? (
        <p role="status" className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
          This invoice was cancelled. Nothing is due on it.
        </p>
      ) : view.state === "paid" ? (
        <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          Paid in full. Thank you.
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bill to</p>
          <p className="font-medium">{view.billToName}</p>
        </div>
        {view.title ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Project</p>
            <p className="font-medium">{view.title}</p>
          </div>
        ) : null}
      </section>

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
            {view.lines.map((l, i) => (
              <tr key={i} className="border-b align-top last:border-0">
                <td className="py-2 pr-2">
                  {l.description}
                  {l.detail ? <span className="block text-xs text-muted-foreground">{l.detail}</span> : null}
                </td>
                <td className="whitespace-nowrap text-right">{l.quantityText}</td>
                <td className="whitespace-nowrap pl-2 text-right">{formatCents(l.unitPriceCents)}</td>
                <td className="whitespace-nowrap pl-2 text-right">{formatCents(l.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      <dl className="ml-auto max-w-xs space-y-1 text-sm">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd>{formatCents(view.subtotalCents)}</dd>
        </div>
        {view.discountCents > 0 ? (
          <div className="flex justify-between">
            <dt>{view.discountLabel ?? "Discount"}</dt>
            <dd>-{formatCents(view.discountCents)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t pt-1 font-semibold">
          <dt>Total</dt>
          <dd>{formatCents(view.totalCents)}</dd>
        </div>
        {view.paidCents > 0 ? (
          <div className="flex justify-between">
            <dt>Paid</dt>
            <dd>-{formatCents(view.paidCents)}</dd>
          </div>
        ) : null}
        {view.state !== "void" ? (
          <div className="flex justify-between text-base font-semibold">
            <dt>{view.paidCents > 0 ? "Balance due" : "Amount due"}</dt>
            <dd>{formatCents(view.balanceCents)}</dd>
          </div>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        {view.bankPending ? (
          <p
            role="status"
            className={
              view.bankPending.overdue
                ? "rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900"
                : "rounded-md border bg-muted px-3 py-2 text-sm"
            }
          >
            {view.bankPending.text}
          </p>
        ) : view.canPayOnline ? (
          <PayOnlineButton token={token} amountText={formatCents(view.balanceCents)} />
        ) : null}
        {/* A plain link on purpose: the PDF is a route handler, not a page. */}
        <a href={pdfHref} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent">
          Download PDF
        </a>
      </div>

      {view.notes ? (
        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</p>
          <p className="whitespace-pre-line text-sm">{view.notes}</p>
        </section>
      ) : null}

      {view.state === "open" && (view.payableTo || view.mailingLines.length > 0 || view.bankLines.length > 0) ? (
        <section className="grid gap-4 sm:grid-cols-2">
          {view.payableTo || view.mailingLines.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mail checks to</p>
              {[...(view.payableTo ? [view.payableTo] : []), ...view.mailingLines].map((l, i) => (
                <p key={i} className="text-sm">
                  {l}
                </p>
              ))}
            </div>
          ) : null}
          {view.bankLines.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bank / ACH details</p>
              {view.bankLines.map((l, i) => (
                <p key={i} className="break-words text-sm">
                  {l}
                </p>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {view.termsText ? (
        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Terms and conditions</p>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{view.termsText}</p>
        </section>
      ) : null}
      {view.footerText ? <p className="text-center text-sm italic text-muted-foreground">{view.footerText}</p> : null}
    </main>
  );
}
