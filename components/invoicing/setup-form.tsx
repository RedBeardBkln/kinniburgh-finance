"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { setupInvoicing } from "@/actions/invoicing-setup";
import { DEFAULT_QUOTE_PREFIX, GL_ROLES, GL_ROLE_LABELS, GL_ROLE_TYPES, type GlRole } from "@/lib/invoicing/constants";
import { formatQuoteNumber } from "@/lib/invoicing/numbering";
import type { GlOption } from "@/lib/invoicing/catalog-build";
import { ErrorLine, Field, INPUT, useRunner } from "@/components/invoicing/shared";

// First-time setup. The owner TYPES every value (nothing is baked in or pre-filled except the account map, which is pre-selected by
// matching account NAMES from the business's own chart, and the check payee, which suggests the legal entity name).

/** "The first quote will print as Q-2001. Quotes themselves are not available yet." */
function quoteHint(prefix: string, next: string, pad: string): string {
  const n = Number(next);
  const printed = /^\d+$/.test(next.trim()) && Number.isSafeInteger(n) && prefix.trim() !== "" ? ` The first quote will print as ${formatQuoteNumber(prefix.trim(), n, Number(pad) || 0)}.` : "";
  return `Numbers are never reused.${printed} Quotes themselves are not available yet; this only reserves their numbering.`;
}

export function SetupForm({
  slug,
  glOptions,
  suggestedGlMap,
  suggestedPayee,
}: {
  slug: string;
  glOptions: GlOption[];
  suggestedGlMap: Partial<Record<GlRole, string>>;
  suggestedPayee: string;
}) {
  const { pending, error, run, setError } = useRunner();
  const [v, setV] = useState({
    goLiveOn: "",
    invoicePrefix: "",
    nextInvoiceNumber: "",
    quotePrefix: DEFAULT_QUOTE_PREFIX,
    nextQuoteNumber: "",
    numberPad: "0",
    defaultNetDays: "0",
    termsLabel: "",
    businessAddress: "",
    replyToEmail: "",
    fromName: "",
    footerText: "",
    termsText: "",
    remitToMailingAddress: "",
    checkPayableTo: suggestedPayee,
  });
  const [gl, setGl] = useState<Partial<Record<GlRole, string>>>(suggestedGlMap);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  function submit() {
    setError(null);
    const next = Number(v.nextInvoiceNumber);
    if (!/^\d+$/.test(v.nextInvoiceNumber.trim()) || !Number.isSafeInteger(next)) return setError("Enter the first invoice number as a whole number.");
    const nextQuote = Number(v.nextQuoteNumber);
    if (!/^\d+$/.test(v.nextQuoteNumber.trim()) || !Number.isSafeInteger(nextQuote)) return setError("Enter the first quote number as a whole number.");
    if (v.quotePrefix.trim() === "") return setError("Enter a quote prefix (for example Q-).");
    for (const r of GL_ROLES) if (!gl[r]) return setError(`Choose an account for "${GL_ROLE_LABELS[r]}".`);
    run(
      () =>
        setupInvoicing({
          slug,
          goLiveOn: v.goLiveOn,
          invoicePrefix: v.invoicePrefix.trim(),
          nextInvoiceNumber: next,
          quotePrefix: v.quotePrefix.trim(),
          nextQuoteNumber: nextQuote,
          numberPad: Number(v.numberPad) || 0,
          defaultNetDays: Number(v.defaultNetDays) || 0,
          termsLabel: v.termsLabel,
          businessAddress: v.businessAddress,
          replyToEmail: v.replyToEmail,
          fromName: v.fromName,
          footerText: v.footerText,
          termsText: v.termsText,
          remitToMailingAddress: v.remitToMailingAddress,
          checkPayableTo: v.checkPayableTo,
          glMap: gl as Record<GlRole, string>,
        })
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Numbering and dates</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="First invoice number" hint="Numbers are never reused. Typed by you; nothing is assumed.">
            <input className={INPUT} inputMode="numeric" value={v.nextInvoiceNumber} onChange={set("nextInvoiceNumber")} />
          </Field>
          <Field label="Number prefix (optional)" hint="Leave blank for plain numbers.">
            <input className={INPUT} value={v.invoicePrefix} onChange={set("invoicePrefix")} maxLength={12} />
          </Field>
          <Field label="Zero padding (0 = none)">
            <input className={INPUT} inputMode="numeric" value={v.numberPad} onChange={set("numberPad")} />
          </Field>
          <Field label="Quote prefix" hint="Quote numbers print with this prefix so they are never mistaken for invoices.">
            <input className={INPUT} value={v.quotePrefix} onChange={set("quotePrefix")} maxLength={12} />
          </Field>
          <Field label="First quote number" hint={quoteHint(v.quotePrefix, v.nextQuoteNumber, v.numberPad)}>
            <input className={INPUT} inputMode="numeric" value={v.nextQuoteNumber} onChange={set("nextQuoteNumber")} />
          </Field>
          <Field label="Invoicing start date" hint="No invoice can be dated before this day.">
            <input type="date" className={INPUT} value={v.goLiveOn} onChange={set("goLiveOn")} />
          </Field>
          <Field label="Payment terms (printed)" hint='For example "Due upon receipt".'>
            <input className={INPUT} value={v.termsLabel} onChange={set("termsLabel")} maxLength={60} />
          </Field>
          <Field label="Days until due (0 = on receipt)">
            <input className={INPUT} inputMode="numeric" value={v.defaultNetDays} onChange={set("defaultNetDays")} />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Business block</h2>
        <Field label="Business address (printed on every invoice)" hint="The business record has no address, so type the exact text to print.">
          <textarea className={INPUT} rows={3} value={v.businessAddress} onChange={set("businessAddress")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reply-to e-mail">
            <input className={INPUT} type="email" value={v.replyToEmail} onChange={set("replyToEmail")} />
          </Field>
          <Field label="From name (e-mails)">
            <input className={INPUT} value={v.fromName} onChange={set("fromName")} />
          </Field>
        </div>
        <Field label="Footer text">
          <textarea className={INPUT} rows={2} value={v.footerText} onChange={set("footerText")} />
        </Field>
        <Field label="Terms text (optional)">
          <textarea className={INPUT} rows={2} value={v.termsText} onChange={set("termsText")} />
        </Field>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Where payments are sent</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mail checks to (address)">
            <textarea className={INPUT} rows={3} value={v.remitToMailingAddress} onChange={set("remitToMailingAddress")} />
          </Field>
          <Field label="Checks payable to" hint="Suggested from the business name; change it if checks should name something else.">
            <input className={INPUT} value={v.checkPayableTo} onChange={set("checkPayableTo")} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">Bank / ACH instructions can be added after setup, in Settings. They are optional.</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Accounts</h2>
        <p className="text-xs text-muted-foreground">Each role is pre-selected by matching account names in your chart. Check them before saving.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {GL_ROLES.map((r) => (
            <Field key={r} label={`${GL_ROLE_LABELS[r]} (${GL_ROLE_TYPES[r]})`}>
              <select className={INPUT} value={gl[r] ?? ""} onChange={(e) => setGl((s) => ({ ...s, [r]: e.target.value }))}>
                <option value="">Choose…</option>
                {glOptions
                  .filter((o) => o.type === GL_ROLE_TYPES[r])
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} {o.name}
                    </option>
                  ))}
              </select>
            </Field>
          ))}
        </div>
      </section>

      <ErrorLine message={error} />
      <Button onClick={submit} disabled={pending}>
        {pending ? "Saving…" : "Set up invoicing"}
      </Button>
    </div>
  );
}
