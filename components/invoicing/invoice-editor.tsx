"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { archiveDraft, issueInvoice, saveDraft, sendInvoice } from "@/actions/invoices";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";
import { cn } from "@/lib/utils";
import { newRequestKey } from "@/lib/invoicing/request-key";
import { BILLING_MODELS } from "@/lib/invoicing/constants";
import { computeDocumentTotals, formatCents, parsePercentToBps, parseQuantityMilli, type DiscountInput, type DocumentTotals } from "@/lib/invoicing/money";
import { parseDollarsToCents } from "@/lib/money-input";
import type { CostTransactionOption, GlOption, ItemView } from "@/lib/invoicing/catalog-build";
import type { InvoiceDetail } from "@/lib/invoicing/documents-build";
import { ErrorLine, Field, INPUT, OkLine } from "@/components/invoicing/shared";

// The invoice editor. The totals shown while typing come from lib/invoicing/money.ts, the SAME module the server recomputes with
// (nothing the browser computes is trusted). Quantity x rate lines cover hourly work (hours typed directly; there is no time log or
// timer), project and retainer billing. Issuing is owner-only and numbers the invoice; issued invoices are read-only.
// One "Save" button opens a dialog: save as draft, save as final (issue), or save as final and send (issue, then e-mail it to the
// client's contacts ticked "Receives invoices"). Nothing is ever e-mailed except by that last choice or the Send button.

interface LineState {
  key: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountKind: "" | "percent" | "fixed";
  discountValue: string;
  glCodeId: string;
  taxable: boolean;
  workDate: string;
  itemId: string;
  unitCostCents: number | null;
  markupBps: number | null;
  costTransactionId: string;
  receiptId: string;
}

export interface EditorClient {
  id: string;
  name: string;
  defaultNetDays: number | null;
  defaultTaxable: boolean;
  /** The client's invoice e-mail addresses (contacts ticked "Receives invoices"). */
  recipients: string[];
}

export interface EditorProfile {
  defaultNetDays: number;
  termsLabel: string;
  einLast4: string | null;
  includeRemitToByDefault: boolean;
  hasRemitBank: boolean;
  hasMailing: boolean;
}

function emptyLine(key: number, glCodeId: string, over: Partial<LineState> = {}): LineState {
  return {
    key,
    description: "",
    quantity: "1",
    unit: "",
    unitPrice: "",
    discountKind: "",
    discountValue: "",
    glCodeId,
    taxable: false,
    workDate: "",
    itemId: "",
    unitCostCents: null,
    markupBps: null,
    costTransactionId: "",
    receiptId: "",
    ...over,
  };
}

type Live = { error: string | null; totals: DocumentTotals | null };

function computeLive(lines: LineState[], discKind: "" | "percent" | "fixed", discValue: string): Live {
  const inputs: { quantityMilli: number; unitPriceCents: number; discount: DiscountInput | null }[] = [];
  for (const l of lines) {
    const q = parseQuantityMilli(l.quantity);
    const p = parseDollarsToCents(l.unitPrice || "0", { allowZero: true });
    if (q === null || !p.ok) return { error: "Complete every line (quantity and price) to see totals.", totals: null };
    let discount: DiscountInput | null = null;
    if (l.discountKind) {
      if (l.discountKind === "percent") {
        const bps = parsePercentToBps(l.discountValue);
        if (bps === null) return { error: "A line discount percent is not valid.", totals: null };
        discount = { kind: "percent", value: bps };
      } else {
        const c = parseDollarsToCents(l.discountValue);
        if (!c.ok) return { error: "A line discount amount is not valid.", totals: null };
        discount = { kind: "fixed", value: c.cents };
      }
    }
    inputs.push({ quantityMilli: q, unitPriceCents: p.cents, discount });
  }
  let docDiscount: DiscountInput | null = null;
  if (discKind) {
    if (discKind === "percent") {
      const bps = parsePercentToBps(discValue);
      if (bps === null) return { error: "The invoice discount percent is not valid.", totals: null };
      docDiscount = { kind: "percent", value: bps };
    } else {
      const c = parseDollarsToCents(discValue);
      if (!c.ok) return { error: "The invoice discount amount is not valid.", totals: null };
      docDiscount = { kind: "fixed", value: c.cents };
    }
  }
  const r = computeDocumentTotals(inputs, docDiscount);
  return r.ok ? { error: null, totals: r.totals } : { error: r.error, totals: null };
}

const dollarsText = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function InvoiceEditor({
  slug,
  clients,
  items,
  glOptions,
  costOptions,
  defaultGlId,
  profile,
  canIssue,
  setupMissing,
  initial,
  preselectClientId,
  emailReady,
}: {
  slug: string;
  clients: EditorClient[];
  items: ItemView[];
  glOptions: GlOption[];
  costOptions: CostTransactionOption[];
  defaultGlId: string | null;
  profile: EditorProfile;
  canIssue: boolean;
  setupMissing: string[];
  initial?: InvoiceDetail;
  preselectClientId?: string;
  /** E-mail is configured (decided on the server; no value of the environment is passed). */
  emailReady: boolean;
}) {
  const router = useRouter();
  const blankLine = (key: number, over: Partial<LineState> = {}): LineState => emptyLine(key, defaultGlId ?? "", over);

  const [clientId, setClientId] = useState(initial?.clientId ?? preselectClientId ?? "");
  const [billingModel, setBillingModel] = useState(initial?.billingModel ?? "general");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [poNumber, setPoNumber] = useState(initial?.poNumber ?? "");
  const [issueDate, setIssueDate] = useState(initial?.issueDate ?? "");
  const [netDays, setNetDays] = useState(initial?.netDays === null || initial?.netDays === undefined ? "" : String(initial.netDays));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [internalNotes, setInternalNotes] = useState(initial?.internalNotes ?? "");
  const [discKind, setDiscKind] = useState<"" | "percent" | "fixed">((initial?.discountKind as "percent" | "fixed" | null) ?? "");
  const [discValue, setDiscValue] = useState(initial?.discountValueText ?? "");
  const [includeRemitTo, setIncludeRemitTo] = useState(initial ? initial.includeRemitTo : false);
  const [showEin, setShowEin] = useState(initial?.showEin ?? false);
  const [lines, setLines] = useState<LineState[]>(() =>
    initial && initial.lines.length > 0
      ? initial.lines.map((l, i) =>
          blankLine(i, {
            description: l.description,
            quantity: l.quantity,
            unit: l.unit ?? "",
            unitPrice: dollarsText(l.unitPriceCents),
            discountKind: (l.discountKind as "percent" | "fixed" | null) ?? "",
            discountValue: l.discountValueText,
            glCodeId: l.glCodeId ?? "",
            taxable: l.taxable,
            workDate: l.workDate ?? "",
            itemId: l.itemId ?? "",
            unitCostCents: l.unitCostCents,
            markupBps: l.markupBps,
            costTransactionId: l.costTransactionId ?? "",
            receiptId: l.receiptId ?? "",
          })
        )
      : [blankLine(0)]
  );
  const [nextKey, setNextKey] = useState(() => (initial && initial.lines.length > 0 ? initial.lines.length : 1));
  const [stamp, setStamp] = useState<string | null>(initial?.updatedAt ?? null);
  const [docId, setDocId] = useState<string | null>(initial?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  const hourly = billingModel === "hourly";
  const client = clients.find((c) => c.id === clientId);
  const effectiveNetDays = netDays.trim() !== "" ? Number(netDays) : (client?.defaultNetDays ?? profile.defaultNetDays);

  // Live totals (same module as the server).
  const live = computeLive(lines, discKind, discValue);

  function setLine(key: number, patch: Partial<LineState>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return setLine(key, { itemId: "", unitCostCents: null, markupBps: null });
    setLine(key, {
      itemId: item.id,
      description: item.name,
      unit: item.unit,
      unitPrice: dollarsText(item.billedPriceCents),
      glCodeId: item.glCodeId,
      taxable: item.taxable,
      unitCostCents: item.unitCostCents,
      markupBps: item.pricingMode === "markup" ? (item.markupBps ?? 0) : null,
    });
  }

  function pickClient(id: string) {
    setClientId(id);
    const c = clients.find((x) => x.id === id);
    if (c && lines.length === 1 && lines[0] && lines[0].description === "") setLines([{ ...lines[0], taxable: c.defaultTaxable }]);
  }

  function payload() {
    return {
      clientId,
      billingModel,
      title,
      poNumber,
      issueDate: issueDate || null,
      netDays: netDays.trim() === "" ? null : netDays.trim(),
      notes,
      internalNotes,
      discountKind: discKind || null,
      discountValue: discKind ? discValue : null,
      includeRemitTo,
      showEin,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit || null,
        unitPrice: l.unitPrice || "0",
        discountKind: l.discountKind || null,
        discountValue: l.discountKind ? l.discountValue : null,
        glCodeId: l.glCodeId || null,
        taxable: l.taxable,
        workDate: hourly && l.workDate ? l.workDate : null,
        itemId: l.itemId || null,
        unitCostCents: l.itemId ? l.unitCostCents : null,
        markupBps: l.itemId ? l.markupBps : null,
        costTransactionId: l.costTransactionId || null,
        receiptId: l.receiptId || null,
      })),
    };
  }

  async function save(): Promise<{ id: string; updatedAt: string } | null> {
    const r = await saveDraft({ slug, documentId: docId, expectedUpdatedAt: stamp, draft: payload() });
    if ("error" in r) {
      setError(r.error);
      return null;
    }
    setDocId(r.id);
    setStamp(r.updatedAt);
    return { id: r.id, updatedAt: r.updatedAt };
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const saved = await save();
      if (saved) {
        setOk("Draft saved.");
        if (!initial) router.replace(`/business/${slug}/invoices/${saved.id}` as Route);
        else router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  /** Saves, issues (numbers) the draft and, when `send` is set, e-mails it. Lands on the issued invoice's page. */
  async function onFinal(send: boolean) {
    setChoosing(false);
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const saved = await save();
      if (!saved) return;
      const r = await issueInvoice({ slug, documentId: saved.id, expectedUpdatedAt: saved.updatedAt });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      let query = "";
      if (send) {
        let outcome = "failed";
        try {
          const sent = await sendInvoice({ slug, documentId: saved.id, requestKey: newRequestKey() });
          outcome = "error" in sent ? (sent.sendFailure ?? "failed") : sent.payLink === "omitted_not_configured" ? "ok_nolink" : "ok";
        } catch {
          outcome = "failed";
        }
        query = `?send=${outcome}`;
      }
      router.replace(`/business/${slug}/invoices/${saved.id}${query}` as Route);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onArchive() {
    if (!docId || !stamp) return;
    if (!window.confirm("Archive this draft? It was never numbered and will be hidden.")) return;
    setBusy(true);
    try {
      const r = await archiveDraft({ slug, documentId: docId, expectedUpdatedAt: stamp });
      if ("error" in r) setError(r.error);
      else router.push(`/business/${slug}/invoices` as Route);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Client">
          <select className={INPUT} value={clientId} onChange={(e) => pickClient(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Billing type" hint="Descriptive; hours are typed as the quantity (no timer).">
          <select className={INPUT} value={billingModel} onChange={(e) => setBillingModel(e.target.value)}>
            {BILLING_MODELS.map((m) => (
              <option key={m} value={m}>
                {m === "general" ? "General" : m === "hourly" ? "Hourly" : m === "project" ? "Project" : "Retainer"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title (optional)">
          <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Issue date" hint="Blank = today when issued. Cannot be in the future or before invoicing started.">
          <input type="date" className={INPUT} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </Field>
        <Field label="Days until due" hint={`Blank = ${client?.defaultNetDays ?? profile.defaultNetDays} (${profile.termsLabel}).`}>
          <input className={INPUT} inputMode="numeric" value={netDays} onChange={(e) => setNetDays(e.target.value)} />
        </Field>
        <Field label="PO number (optional)">
          <input className={INPUT} value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
        </Field>
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold">Lines</h2>
        {lines.map((l, idx) => {
          const q = parseQuantityMilli(l.quantity);
          const lineTotal = live.totals?.lines[idx]?.totalCents;
          return (
            <div key={l.key} className="space-y-2 rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-12">
                <Field label="Description" className="sm:col-span-6">
                  <input className={INPUT} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                </Field>
                <Field label={hourly ? "Hours" : "Quantity"} className="sm:col-span-2">
                  <input className={INPUT} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} aria-invalid={q === null} />
                </Field>
                <Field label={hourly ? "Rate ($/hr)" : "Unit price ($)"} className="sm:col-span-2">
                  <input className={INPUT} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />
                </Field>
                <div className="sm:col-span-2">
                  <span className="text-xs font-medium text-muted-foreground">Line total</span>
                  <div className="py-2 text-sm font-medium">{lineTotal === undefined ? "—" : formatCents(lineTotal)}</div>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-12">
                <Field label="Income account" className="sm:col-span-4">
                  <select className={INPUT} value={l.glCodeId} onChange={(e) => setLine(l.key, { glCodeId: e.target.value })}>
                    <option value="">Choose…</option>
                    {glOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.code} {o.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reimbursable item (optional)" className="sm:col-span-3">
                  <select className={INPUT} value={l.itemId} onChange={(e) => pickItem(l.key, e.target.value)}>
                    <option value="">None</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({formatCents(i.billedPriceCents)}/{i.unit})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Unit" className="sm:col-span-1">
                  <input className={INPUT} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} maxLength={20} />
                </Field>
                <Field label="Discount" className="sm:col-span-2">
                  <div className="flex gap-1">
                    <select className={INPUT} value={l.discountKind} onChange={(e) => setLine(l.key, { discountKind: e.target.value as LineState["discountKind"] })}>
                      <option value="">None</option>
                      <option value="percent">%</option>
                      <option value="fixed">$</option>
                    </select>
                    {l.discountKind ? <input className={INPUT} inputMode="decimal" value={l.discountValue} onChange={(e) => setLine(l.key, { discountValue: e.target.value })} /> : null}
                  </div>
                </Field>
                {hourly ? (
                  <Field label="Work date" className="sm:col-span-2">
                    <input type="date" className={INPUT} value={l.workDate} onChange={(e) => setLine(l.key, { workDate: e.target.value })} />
                  </Field>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={l.taxable} onChange={(e) => setLine(l.key, { taxable: e.target.checked })} />
                  Taxable (flag only, no tax is calculated)
                </label>
                {costOptions.length > 0 ? (
                  <label className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Cost it recovers:</span>
                    <select className="rounded-md border border-input bg-background px-2 py-1 text-xs" value={l.costTransactionId} onChange={(e) => setLine(l.key, { costTransactionId: e.target.value })}>
                      <option value="">none</option>
                      {costOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {lines.length > 1 ? (
                  <Button size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    Remove line
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        <Button variant="outline" size="sm" onClick={() => {
            setLines((ls) => [...ls, blankLine(nextKey, { taxable: client?.defaultTaxable ?? false })]);
            setNextKey((k) => k + 1);
          }}>
          Add line
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <Field label="Notes (shown to the client)">
            <textarea className={INPUT} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field label="Internal notes (never printed)">
            <textarea className={INPUT} rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeRemitTo} disabled={!profile.hasRemitBank} onChange={(e) => setIncludeRemitTo(e.target.checked)} />
            Print ACH Details {profile.hasRemitBank ? "" : "(none saved in settings)"}
          </label>
          <p className="text-xs text-muted-foreground">
            {profile.hasMailing ? "The mail-checks-to address and payee always print." : "No mailing address for checks is set in settings."} Terms printed: {profile.termsLabel}.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showEin} disabled={!profile.einLast4} onChange={(e) => setShowEin(e.target.checked)} />
            Print the business EIN on this invoice {profile.einLast4 ? "" : "(none saved in settings)"}
          </label>
        </div>
        <div className="space-y-3 rounded-md border p-4">
          <Field label="Invoice-level discount">
            <div className="flex gap-1">
              <select className={INPUT} value={discKind} onChange={(e) => setDiscKind(e.target.value as "" | "percent" | "fixed")}>
                <option value="">None</option>
                <option value="percent">Percent</option>
                <option value="fixed">Dollar amount</option>
              </select>
              {discKind ? <input className={INPUT} inputMode="decimal" value={discValue} onChange={(e) => setDiscValue(e.target.value)} /> : null}
            </div>
          </Field>
          {live.totals ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt>Subtotal</dt>
                <dd>{formatCents(live.totals.subtotalCents)}</dd>
              </div>
              {live.totals.discountCents > 0 ? (
                <div className="flex justify-between">
                  <dt>Discount</dt>
                  <dd>-{formatCents(live.totals.discountCents)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t pt-1 text-base font-semibold">
                <dt>Total</dt>
                <dd>{formatCents(live.totals.totalCents)}</dd>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <dt>Due</dt>
                <dd>{Number.isFinite(effectiveNetDays) && effectiveNetDays > 0 ? `${effectiveNetDays} days after issue` : profile.termsLabel}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{live.error}</p>
          )}
        </div>
      </div>

      <ErrorLine message={error} />
      <OkLine message={ok} />
      {setupMissing.length > 0 ? (
        <p className="text-sm text-yellow-800">Saving as final is turned off until {setupMissing.join(" and ")} {setupMissing.length === 1 ? "is" : "are"} set in settings.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setChoosing(true)} disabled={busy || clientId === ""}>
          {busy ? "Working…" : "Save"}
        </Button>
        {canIssue ? null : <span className="self-center text-xs text-muted-foreground">Only the owner can issue an invoice.</span>}
        {docId ? (
          <Button variant="ghost" onClick={onArchive} disabled={busy}>
            Archive draft
          </Button>
        ) : null}
      </div>
      {choosing ? (
        <SaveChoiceDialog
          finalBlocked={!canIssue ? "Only the owner can issue an invoice." : setupMissing.length > 0 ? `Saving as final is turned off until ${setupMissing.join(" and ")} ${setupMissing.length === 1 ? "is" : "are"} set in settings.` : null}
          sendBlocked={!emailReady ? "E-mail is not set up yet (INVOICE_EMAIL_FROM is not set in Vercel, or is not an address on the verified domain)." : (client?.recipients.length ?? 0) === 0 ? "No contact of this client is ticked \"Receives invoices\"." : null}
          recipients={client?.recipients ?? []}
          onCancel={() => setChoosing(false)}
          onDraft={() => {
            setChoosing(false);
            void onSave();
          }}
          onFinal={() => void onFinal(false)}
          onFinalAndSend={() => void onFinal(true)}
        />
      ) : null}
    </div>
  );
}

function SaveChoiceDialog({
  finalBlocked,
  sendBlocked,
  recipients,
  onCancel,
  onDraft,
  onFinal,
  onFinalAndSend,
}: {
  finalBlocked: string | null;
  sendBlocked: string | null;
  recipients: string[];
  onCancel: () => void;
  onDraft: () => void;
  onFinal: () => void;
  onFinalAndSend: () => void;
}) {
  return (
    <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-label="Save invoice">
      <div className={cn(modalPanelClass("md"), "space-y-4 bg-background p-5 shadow-lg")}>
        <h2 className="text-base font-semibold">Save invoice</h2>
        <div className="space-y-3">
          <div>
            <Button className="w-full justify-start" variant="outline" onClick={onDraft}>
              Save as draft
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">Keeps it editable. No number, nothing is sent.</p>
          </div>
          <div>
            <Button className="w-full justify-start" variant="outline" onClick={onFinal} disabled={finalBlocked !== null}>
              Save as final
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">{finalBlocked ?? "Numbers the invoice; it can no longer be edited (only voided). Nothing is e-mailed."}</p>
          </div>
          <div>
            <Button className="w-full justify-start" onClick={onFinalAndSend} disabled={finalBlocked !== null || sendBlocked !== null}>
              Save as final and send
            </Button>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {finalBlocked ?? sendBlocked ?? `Numbers the invoice and e-mails the PDF to ${recipients.join(", ")}.`}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
