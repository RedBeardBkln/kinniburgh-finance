import type { ReactNode } from "react";
import { TableScroll } from "@/components/ui/table-scroll";
import { INVALID_LINK_MESSAGE } from "@/lib/invoicing/constants";
import { formatCents } from "@/lib/invoicing/money";
import type { PublicInvoiceView } from "@/lib/invoicing/public-view";
import { PayOnlineButton } from "@/components/invoicing/public/pay-online-button";
import { ViewTracker } from "@/components/invoicing/public/view-tracker";

// The client's invoice page (/i/<token>). Server-rendered from a plain `PublicInvoiceView` (lib/invoicing/public-view.ts decides what may
// be shown: never an EIN, internal notes, contacts, GL codes, the timeline or Stripe ids). No AppShell, no link into the app. The two
// client leaves (view tracking after mount, the Pay button) get the token only to call the token-gated actions.
//
// Look: the LaunchTime Solutions invoice design (invoice-template/invoice.template.html, the same palette as the PDF). The page is always
// a light "paper" sheet, whatever the viewer's theme, so it reads like the invoice it represents. The logo arrives as an inline data: URI
// (`logoSrc`, built by the page) so the pay domain serves no extra file.

const SLAB = "font-['Roboto_Slab',Georgia,serif]";
const LABEL = `${SLAB} text-[11px] uppercase tracking-[0.14em] text-[#7A6200]`;
const META_DT = `${SLAB} text-[11px] uppercase tracking-[0.1em] text-[#6B645A] sm:text-right`;

function Label({ children }: { children: ReactNode }) {
  return <p className={`${LABEL} mb-1.5`}>{children}</p>;
}

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

export function PublicInvoice({
  view,
  token,
  track = true,
  logoSrc = null,
}: {
  view: PublicInvoiceView;
  token: string;
  track?: boolean;
  logoSrc?: string | null;
}) {
  const pdfHref = `/i/${token}/pdf`;
  const dueLabel = view.paidCents > 0 ? "Balance due" : "Amount due";
  const pdfLink = (
    // A plain link on purpose: the PDF is a route handler, not a page.
    <a
      href={pdfHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-10 items-center justify-center rounded-md border border-[#B9AF9C] bg-white px-4 text-sm font-medium text-[#201D16] hover:bg-[#F4F1EA]"
    >
      Download PDF
    </a>
  );
  return (
    <div className="min-h-dvh bg-[#F4F1EA] text-[#201D16] sm:py-10">
      <main className="mx-auto w-full max-w-3xl space-y-8 border-t-4 border-[#D7B418] bg-white px-5 py-8 shadow-sm sm:rounded-b-lg sm:px-10 sm:py-10">
        {track ? <ViewTracker token={token} /> : null}

        <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- an inline data: URI of the business logo
              <img src={logoSrc} alt={view.businessName} className="h-16 w-auto max-w-[14rem] object-contain" />
            ) : null}
            <div className="text-sm text-[#6B645A]">
              <p className={`${SLAB} text-base font-semibold text-[#201D16]`}>{view.businessName}</p>
              {view.businessAddressLines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          </div>
          <div className="sm:text-right">
            <h1 className={`${SLAB} mb-3 text-3xl font-medium tracking-[0.18em]`}>INVOICE</h1>
            <dl className="grid grid-cols-[auto_auto] justify-start gap-x-4 gap-y-0.5 text-sm sm:justify-end">
              <dt className={META_DT}>Invoice number</dt>
              <dd>{view.displayNumber}</dd>
              {view.issueDate ? (
                <>
                  <dt className={META_DT}>Issue date</dt>
                  <dd>{view.issueDate}</dd>
                </>
              ) : null}
              <dt className={META_DT}>Terms</dt>
              <dd>{view.dueText}</dd>
              {view.poNumber ? (
                <>
                  <dt className={META_DT}>PO</dt>
                  <dd>{view.poNumber}</dd>
                </>
              ) : null}
            </dl>
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

        {view.state === "open" ? (
          <section className="flex flex-col gap-4 rounded-lg border border-[#E4DDD0] bg-[#FBF8EF] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className={LABEL}>{dueLabel}</p>
              <p className={`${SLAB} text-3xl font-semibold`}>{formatCents(view.balanceCents)}</p>
            </div>
            <div className="flex flex-col gap-3 sm:items-end">
              {view.bankPending ? (
                <p
                  role="status"
                  className={
                    view.bankPending.overdue
                      ? "max-w-sm rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900"
                      : "max-w-sm rounded-md border border-[#E4DDD0] bg-white px-3 py-2 text-sm"
                  }
                >
                  {view.bankPending.text}
                </p>
              ) : view.canPayOnline ? (
                <PayOnlineButton token={token} amountText={formatCents(view.balanceCents)} />
              ) : null}
              {pdfLink}
            </div>
          </section>
        ) : (
          <div>{pdfLink}</div>
        )}

        <section className="grid gap-6 border-t border-[#E4DDD0] pt-6 sm:grid-cols-2">
          <div>
            <Label>Bill to</Label>
            <p className="text-base font-medium">{view.billToName}</p>
          </div>
          {view.title ? (
            <div>
              <Label>Project</Label>
              <p className="text-base font-medium">{view.title}</p>
            </div>
          ) : null}
        </section>

        <div>
          <TableScroll>
            <table className="w-full text-sm">
              <thead>
                <tr className={`${SLAB} border-b-2 border-[#B9AF9C] text-[11px] uppercase tracking-[0.12em] text-[#6B645A]`}>
                  <th className="py-2 text-left font-normal">Description</th>
                  <th className="py-2 pl-3 text-right font-normal">Qty</th>
                  <th className="py-2 pl-3 text-right font-normal">Rate</th>
                  <th className="py-2 pl-3 text-right font-normal">Amount</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((l, i) => (
                  <tr key={i} className="border-b border-[#E4DDD0] align-top">
                    <td className="py-2.5 pr-2">
                      {l.description}
                      {l.detail ? <span className="block text-xs text-[#6B645A]">{l.detail}</span> : null}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right">{l.quantityText}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right">{formatCents(l.unitPriceCents)}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right">{formatCents(l.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>

          <dl className="ml-auto mt-4 w-full space-y-1 text-sm sm:max-w-xs">
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
            <div className="flex justify-between">
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
              <div className={`${SLAB} mt-1 flex items-baseline justify-between border-t-2 border-[#B9AF9C] pt-2`}>
                <dt className="text-[13px] uppercase tracking-[0.12em]">{dueLabel}</dt>
                <dd className="text-2xl font-semibold">{formatCents(view.balanceCents)}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {view.notes ? (
          <section>
            <Label>Notes</Label>
            <p className="whitespace-pre-line text-sm">{view.notes}</p>
          </section>
        ) : null}

        {view.state === "open" && (view.payableTo || view.mailingLines.length > 0 || view.bankLines.length > 0) ? (
          <section className="grid gap-6 border-t border-[#E4DDD0] pt-6 text-sm sm:grid-cols-2">
            {view.payableTo || view.mailingLines.length > 0 ? (
              <div>
                <Label>Mail checks to</Label>
                {[...(view.payableTo ? [view.payableTo] : []), ...view.mailingLines].map((l, i) => (
                  <p key={i} className="text-[#6B645A]">
                    {l}
                  </p>
                ))}
              </div>
            ) : null}
            {view.bankLines.length > 0 ? (
              <div>
                <Label>Bank / ACH details</Label>
                {view.bankLines.map((l, i) => (
                  <p key={i} className="break-words text-[#6B645A]">
                    {l}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {view.termsText ? (
          <section>
            <Label>Terms and conditions</Label>
            <p className="whitespace-pre-line text-sm text-[#6B645A]">{view.termsText}</p>
          </section>
        ) : null}
        {view.footerText ? <p className="border-t border-[#E4DDD0] pt-6 text-center text-sm italic text-[#6B645A]">{view.footerText}</p> : null}
      </main>
    </div>
  );
}
