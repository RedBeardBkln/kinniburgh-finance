"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  applyPaymentToInvoice,
  linkDeposit,
  recordPayment,
  removeApplication,
  searchDepositCandidates,
  unlinkDeposit,
  voidPayment,
} from "@/actions/billing-payments";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/invoicing/constants";
import { formatCents } from "@/lib/invoicing/money";
import { newRequestKey } from "@/lib/invoicing/request-key";
import type { DepositCandidateView, OpenInvoice, PaymentView } from "@/lib/invoicing/payments-build";
import { ErrorLine, Field, INPUT, OkLine, useRunner } from "@/components/invoicing/shared";

// Recording and managing payments (owner only; the server refuses anyone else). A payment may be applied to several invoices, a part
// of one, or none (the rest stays as a deposit on account, applied later). The bank deposit is LINKED, never changed.

const newKey = () => newRequestKey(); // never a constant: see lib/invoicing/request-key.ts
const dollars = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
// Display-side only (the server parses and validates the real amount): "1,250.5" -> 125050, anything unclear -> null.
function typedCents(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim().replace(/,/g, ""));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : null;
}

function DepositPicker({
  slug,
  clientId,
  paymentId,
  amount,
  fee,
  receivedOn,
  value,
  onPick,
}: {
  slug: string;
  clientId: string;
  paymentId: string | null;
  amount: string;
  fee: string;
  receivedOn: string;
  value: string | null;
  onPick: (id: string | null) => void;
}) {
  const { pending, error, run } = useRunner();
  const [candidates, setCandidates] = useState<DepositCandidateView[] | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(() => searchDepositCandidates({ slug, paymentId, clientId, amount, fee, receivedOn }), {
              refresh: false,
              onSuccess: (r) => setCandidates("candidates" in r ? r.candidates : null),
            })
          }
        >
          Find matching bank deposit
        </Button>
        {value ? (
          <Button size="sm" variant="ghost" onClick={() => onPick(null)}>
            Clear choice
          </Button>
        ) : null}
      </div>
      <ErrorLine message={error} />
      {candidates !== null ? (
        candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No deposits within two weeks of that date matched. You can record the payment now and link a deposit later.</p>
        ) : (
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={c.transactionId}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs">
                  <input type="radio" name={`dep-${paymentId ?? "new"}`} checked={value === c.transactionId} onChange={() => onPick(c.transactionId)} />
                  <span>
                    <strong>{formatCents(c.amountCents)}</strong> on {c.postedAt} · {c.text || "(no description)"}
                    <span className="block text-muted-foreground">{c.reasons.join(", ")}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

export function PaymentForm({
  slug,
  clientId,
  openInvoices,
  presetInvoiceId,
  todayIso,
  canRecord,
  ownerReason,
}: {
  slug: string;
  clientId: string;
  openInvoices: OpenInvoice[];
  presetInvoiceId?: string;
  todayIso: string;
  canRecord: boolean;
  ownerReason: string | null;
}) {
  const { pending, error, ok, run, setError } = useRunner();
  const preset = openInvoices.find((i) => i.id === presetInvoiceId);
  const [method, setMethod] = useState<PaymentMethod>("check");
  const [receivedOn, setReceivedOn] = useState(todayIso);
  const [amount, setAmount] = useState(preset ? dollars(preset.balanceCents) : "");
  const [fee, setFee] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [apply, setApply] = useState<Record<string, string>>(preset ? { [preset.id]: dollars(preset.balanceCents) } : {});
  const [deposit, setDeposit] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(newKey);
  const [applyTouched, setApplyTouched] = useState(false);

  // On an invoice's own page the amount typed is applied to THAT invoice (up to its balance) until the owner edits the Apply column.
  function changeAmount(v: string) {
    setAmount(v);
    if (preset && !applyTouched) {
      const c = typedCents(v);
      setApply({ [preset.id]: c !== null && c > 0 ? dollars(Math.min(c, preset.balanceCents)) : "" });
    }
  }

  if (!canRecord) {
    return <p className="text-sm text-muted-foreground">Only the owner can record payments. {ownerReason}</p>;
  }

  function submit() {
    setError(null);
    run(
      () =>
        recordPayment({
          slug,
          clientId,
          method,
          receivedOn,
          amount,
          fee,
          reference,
          notes,
          depositTransactionId: deposit,
          requestKey,
          allocations: openInvoices.filter((i) => (apply[i.id] ?? "").trim() !== "").map((i) => ({ invoiceId: i.id, amount: apply[i.id]! })),
        }),
      {
        okMessage: "Payment recorded.",
        onSuccess: () => {
          setAmount("");
          setFee("");
          setReference("");
          setNotes("");
          setApply({});
          setApplyTouched(false);
          setDeposit(null);
          setRequestKey(newKey());
        },
      }
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Received on">
          <input type="date" className={INPUT} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </Field>
        <Field label="Method">
          <select className={INPUT} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount received ($)">
          <input className={INPUT} inputMode="decimal" value={amount} onChange={(e) => changeAmount(e.target.value)} />
        </Field>
        <Field label="Processing fee ($, optional)">
          <input className={INPUT} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <Field label="Reference (check number, optional)">
          <input className={INPUT} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Notes (optional)" className="sm:col-span-3">
          <input className={INPUT} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Apply to invoices</h4>
        {openInvoices.length === 0 ? (
          <p className="text-xs text-muted-foreground">No open invoices. The whole payment will be kept as a deposit on account.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1">Invoice</th>
                <th>Due</th>
                <th className="text-right">Balance</th>
                <th className="text-right">Apply ($)</th>
              </tr>
            </thead>
            <tbody>
              {openInvoices.map((i) => (
                <tr key={i.id} className="border-b last:border-0">
                  <td className="py-1">{i.displayNumber}</td>
                  <td>{i.dueDate ?? "—"}</td>
                  <td className="text-right">{formatCents(i.balanceCents)}</td>
                  <td className="flex justify-end gap-1 py-1">
                    <input className={`${INPUT} max-w-[7rem] text-right`} inputMode="decimal" value={apply[i.id] ?? ""} onChange={(e) => { setApplyTouched(true); setApply((s) => ({ ...s, [i.id]: e.target.value })); }} />
                    <Button size="sm" variant="ghost" onClick={() => { setApplyTouched(true); setApply((s) => ({ ...s, [i.id]: dollars(i.balanceCents) })); }}>
                      Full
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted-foreground">The amount you type is applied to this invoice automatically (up to its balance) and reduces what is owed. Only money left over stays as a deposit on account.</p>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-semibold">Bank deposit (optional)</h4>
        <p className="text-xs text-muted-foreground">Linking connects this payment to the deposit in your books. The deposit itself is not changed.</p>
        <DepositPicker slug={slug} clientId={clientId} paymentId={null} amount={amount} fee={fee} receivedOn={receivedOn} value={deposit} onPick={setDeposit} />
      </div>

      <ErrorLine message={error} />
      <OkLine message={ok} />
      <Button onClick={submit} disabled={pending}>
        {pending ? "Recording…" : "Record payment"}
      </Button>
    </div>
  );
}

function PaymentRow({ slug, p, openInvoices, canAct }: { slug: string; p: PaymentView; openInvoices: OpenInvoice[]; canAct: boolean }) {
  const { pending, error, run } = useRunner();
  const [applyInvoice, setApplyInvoice] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [linking, setLinking] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const isVoid = p.status === "void";
  return (
    <li className={`space-y-2 rounded-md border p-3 text-sm ${isVoid ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <strong>{formatCents(p.amountCents)}</strong> · {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method} · {p.receivedOn}
          {p.reference ? ` · ${p.reference}` : ""}
          {p.feeCents > 0 ? ` · fee ${formatCents(p.feeCents)}` : ""}
          {isVoid ? <span className="ml-2 text-xs font-semibold text-red-700">VOID</span> : null}
        </div>
        {!isVoid && canAct ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              const reason = window.prompt("Why is this payment being voided?");
              if (reason && reason.trim() !== "") run(() => voidPayment({ slug, paymentId: p.id, reason }));
            }}
          >
            Void
          </Button>
        ) : null}
      </div>
      {p.allocations.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {p.allocations.map((a) => (
            <li key={a.id} className="flex items-center justify-between">
              <span>
                Applied {formatCents(a.amountCents)} to invoice {a.invoiceNumber ?? ""} on {a.appliedOn}
              </span>
              {canAct && !isVoid ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removeApplication({ slug, allocationId: a.id }))}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!isVoid && p.unappliedDepositCents > 0 ? (
        <div className="space-y-1 text-xs">
          <div className="font-medium text-yellow-800">Unapplied deposit: {formatCents(p.unappliedDepositCents)}</div>
          {canAct && openInvoices.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <select className={`${INPUT} max-w-[14rem]`} value={applyInvoice} onChange={(e) => setApplyInvoice(e.target.value)}>
                <option value="">Apply deposit to invoice…</option>
                {openInvoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.displayNumber} (balance {formatCents(i.balanceCents)})
                  </option>
                ))}
              </select>
              <input className={`${INPUT} max-w-[7rem]`} placeholder="Amount" inputMode="decimal" value={applyAmount} onChange={(e) => setApplyAmount(e.target.value)} />
              <Button size="sm" variant="outline" disabled={pending || applyInvoice === "" || applyAmount.trim() === ""} onClick={() => run(() => applyPaymentToInvoice({ slug, paymentId: p.id, invoiceId: applyInvoice, amount: applyAmount }), { onSuccess: () => { setApplyAmount(""); setApplyInvoice(""); } })}>
                Apply
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {!isVoid ? (
        <div className="space-y-1 text-xs">
          {p.deposit ? (
            <div className="flex items-center justify-between">
              <span>
                Bank deposit linked: {formatCents(p.deposit.amountCents)} on {p.deposit.postedAt}
                {p.deposit.archived ? " (that deposit was archived; treated as unlinked)" : ""}
              </span>
              {canAct ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unlinkDeposit({ slug, paymentId: p.id }))}>
                  Unlink
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-muted-foreground">No bank deposit linked (counted by received date in the cash view).</div>
              {canAct ? (
                linking ? (
                  <div className="space-y-2">
                    <DepositPicker slug={slug} clientId={p.clientId} paymentId={p.id} amount={dollars(p.amountCents)} fee={dollars(p.feeCents)} receivedOn={p.receivedOn} value={pick} onPick={setPick} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={pending || !pick} onClick={() => run(() => linkDeposit({ slug, paymentId: p.id, depositTransactionId: pick! }), { onSuccess: () => { setLinking(false); setPick(null); } })}>
                        Link this deposit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setLinking(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
                    Link a bank deposit
                  </Button>
                )
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      <ErrorLine message={error} />
    </li>
  );
}

export function PaymentsList({ slug, payments, openInvoices, canAct }: { slug: string; payments: PaymentView[]; openInvoices: OpenInvoice[]; canAct: boolean }) {
  if (payments.length === 0) return <p className="text-sm text-muted-foreground">No payments recorded yet.</p>;
  return (
    <ul className="space-y-2">
      {payments.map((p) => (
        <PaymentRow key={p.id} slug={slug} p={p} openInvoices={openInvoices} canAct={canAct} />
      ))}
    </ul>
  );
}
