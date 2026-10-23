"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TableScroll } from "@/components/ui/table-scroll";
import { markStripeFlagReviewed } from "@/actions/invoices";
import { linkPayoutDeposit, refreshStripeFee, searchPayoutCandidates } from "@/actions/billing-payments";
import { ErrorLine, OkLine, useRunner } from "@/components/invoicing/shared";
import { formatCents } from "@/lib/invoicing/money";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/invoicing/constants";
import { formatNyDateTime } from "@/lib/invoicing/state";
import type { FlagView, PayoutCandidateView, StripePaymentView } from "@/lib/invoicing/pay-build";

// The owner's review of online (Stripe) payments: open flags, payments whose Stripe fee is not known yet, and payments waiting for their
// bank payout. Every button is owner-only on the server as well; `canEdit` (decided on the server) only hides them for Eva. Nothing here
// reverses a payment: a flag is only marked reviewed.

export function StripeFlagsList({ slug, flags, canEdit, showInvoice }: { slug: string; flags: FlagView[]; canEdit: boolean; showInvoice: boolean }) {
  const { pending, error, run } = useRunner();
  if (flags.length === 0) return <p className="text-sm text-muted-foreground">Nothing needs review.</p>;
  return (
    <div className="space-y-2">
      <ul className="space-y-2 text-sm">
        {flags.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-yellow-900">
            <span>
              {f.label}
              {f.amountCents !== null ? ` (${formatCents(f.amountCents)})` : ""}
              {showInvoice && f.documentId ? (
                <>
                  {" "}
                  on{" "}
                  <Link className="underline" href={`/business/${slug}/invoices/${f.documentId}` as Route}>
                    invoice {f.invoiceNumber ?? ""}
                  </Link>
                </>
              ) : null}
              <span className="block text-xs">{formatNyDateTime(f.createdAt)}</span>
            </span>
            {canEdit ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => markStripeFlagReviewed({ slug, flagEventId: f.id }))}>
                Mark reviewed
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorLine message={error} />
    </div>
  );
}

const methodLabel = (m: string) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m;

export function FeeUnknownList({ slug, payments, canEdit }: { slug: string; payments: StripePaymentView[]; canEdit: boolean }) {
  const { pending, error, ok, run } = useRunner();
  if (payments.length === 0) return <p className="text-sm text-muted-foreground">Every online payment has its Stripe fee recorded.</p>;
  return (
    <div className="space-y-2">
      <TableScroll>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2">Received</th>
              <th>Client</th>
              <th>Method</th>
              <th className="text-right">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="py-2">{p.receivedOn}</td>
                <td>{p.clientName}</td>
                <td>{methodLabel(p.method)}</td>
                <td className="text-right">{formatCents(p.amountCents)}</td>
                <td className="text-right">
                  {canEdit ? (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => refreshStripeFee({ slug, paymentId: p.id }), { okMessage: "Fee recorded." })}>
                      Fetch fee
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}

export function PayoutLinker({ slug, payments, canEdit }: { slug: string; payments: StripePaymentView[]; canEdit: boolean }) {
  const search = useRunner();
  const link = useRunner();
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<{ netCents: number; candidates: PayoutCandidateView[] } | null>(null);
  if (payments.length === 0) return <p className="text-sm text-muted-foreground">No online payment is waiting for its bank payout.</p>;
  const toggle = (id: string) => {
    setResult(null);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Stripe pays out several payments together, minus its fees. Tick the payments one payout covers, then find the bank deposit and link it.
      </p>
      <TableScroll>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2" />
              <th>Received</th>
              <th>Client</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Fee</th>
              <th className="text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="py-2">
                  {canEdit ? <input type="checkbox" aria-label={`Include the payment of ${p.receivedOn}`} checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} /> : null}
                </td>
                <td>{p.receivedOn}</td>
                <td>{p.clientName}</td>
                <td className="text-right">{formatCents(p.amountCents)}</td>
                <td className="text-right">{formatCents(p.feeCents)}</td>
                <td className="text-right">{formatCents(p.amountCents - p.feeCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {canEdit ? (
        <Button
          size="sm"
          variant="outline"
          disabled={search.pending || chosen.length === 0}
          onClick={() =>
            search.run(() => searchPayoutCandidates({ slug, paymentIds: chosen }), {
              refresh: false,
              onSuccess: (r) => {
                if ("candidates" in r) setResult({ netCents: r.netCents, candidates: r.candidates });
              },
            })
          }
        >
          Find the payout deposit
        </Button>
      ) : null}
      <ErrorLine message={search.error} />
      {result ? (
        <div className="space-y-2">
          <p className="text-sm">Payout to find: {formatCents(result.netCents)} (the chosen payments after Stripe fees).</p>
          {result.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No posted bank deposit fits yet. Payouts usually arrive a few business days after the payment.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {result.candidates.map((c) => (
                <li key={c.transactionId} className="flex flex-wrap items-center justify-between gap-2 border-b py-1 last:border-0">
                  <span>
                    {c.postedAt} {formatCents(c.amountCents)} <span className="text-muted-foreground">{c.text}</span>
                    <span className="block text-xs text-muted-foreground">{c.reasons.join(", ")}</span>
                  </span>
                  <Button
                    size="sm"
                    disabled={link.pending}
                    onClick={() =>
                      link.run(() => linkPayoutDeposit({ slug, depositTransactionId: c.transactionId, paymentIds: chosen }), {
                        okMessage: "Deposit linked to the chosen payments.",
                        onSuccess: () => {
                          setChosen([]);
                          setResult(null);
                        },
                      })
                    }
                  >
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <ErrorLine message={link.error} />
      <OkLine message={link.ok} />
    </div>
  );
}
