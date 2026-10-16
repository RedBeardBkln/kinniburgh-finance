"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  removeInvoiceLogo,
  revealBusinessEin,
  revealRemitBankText,
  setBusinessEin,
  setInvoiceCounterAction,
  setRemitBankText,
  setRemitMailing,
  updateInvoicingProfile,
  uploadInvoiceLogo,
} from "@/actions/invoicing-setup";
import { GL_ROLES, GL_ROLE_LABELS, GL_ROLE_TYPES, LOGO_MAX_LABEL, type GlRole } from "@/lib/invoicing/constants";
import type { GlOption } from "@/lib/invoicing/catalog-build";
import type { ProfileView } from "@/lib/invoicing/gate-build";
import { maskedEin } from "@/lib/invoicing/tin";
import { ErrorLine, Field, INPUT, OkLine, useRunner } from "@/components/invoicing/shared";

// The settings sections. Each is its own small form; the page shows them only to the owner (the server refuses anyone else too).

export function ProfileForm({ slug, profile, glOptions }: { slug: string; profile: ProfileView; glOptions: GlOption[] }) {
  const { pending, error, ok, run } = useRunner();
  const [v, setV] = useState({
    invoicePrefix: profile.invoicePrefix,
    numberPad: String(profile.numberPad),
    defaultNetDays: String(profile.defaultNetDays),
    termsLabel: profile.termsLabel,
    businessAddress: profile.businessAddress ?? "",
    replyToEmail: profile.replyToEmail ?? "",
    fromName: profile.fromName ?? "",
    footerText: profile.footerText ?? "",
    termsText: profile.termsText ?? "",
    quotePrefix: profile.quotePrefix,
    nextQuoteNumber: String(profile.nextQuoteNumber),
  });
  const [showEin, setShowEin] = useState(profile.showEinOnInvoice);
  const [gl, setGl] = useState<Partial<Record<GlRole, string>>>(profile.glMap ?? {});
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  function submit() {
    const missing = GL_ROLES.find((r) => !gl[r]);
    if (missing) return;
    run(
      () =>
        updateInvoicingProfile({
          slug,
          invoicePrefix: v.invoicePrefix.trim(),
          numberPad: Number(v.numberPad) || 0,
          defaultNetDays: Number(v.defaultNetDays) || 0,
          termsLabel: v.termsLabel,
          businessAddress: v.businessAddress,
          replyToEmail: v.replyToEmail,
          fromName: v.fromName,
          footerText: v.footerText,
          termsText: v.termsText,
          showEinOnInvoice: showEin,
          quotePrefix: v.quotePrefix.trim(),
          nextQuoteNumber: Number(v.nextQuoteNumber),
          glMap: gl as Record<GlRole, string>,
        }),
      { okMessage: "Saved." }
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Number prefix">
          <input className={INPUT} value={v.invoicePrefix} onChange={set("invoicePrefix")} maxLength={12} />
        </Field>
        <Field label="Zero padding (0 = none)">
          <input className={INPUT} inputMode="numeric" value={v.numberPad} onChange={set("numberPad")} />
        </Field>
        <Field label="Days until due (0 = on receipt)">
          <input className={INPUT} inputMode="numeric" value={v.defaultNetDays} onChange={set("defaultNetDays")} />
        </Field>
      </div>
      <Field label="Payment terms (printed)">
        <input className={INPUT} value={v.termsLabel} onChange={set("termsLabel")} maxLength={60} />
      </Field>
      <Field label="Business address (printed on every invoice)">
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
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showEin} disabled={!profile.einLast4} onChange={(e) => setShowEin(e.target.checked)} />
        Print the business EIN on invoices {profile.einLast4 ? "" : "(set the EIN below first)"}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Quote prefix" hint="Quotes themselves are not available yet; this only reserves their numbering.">
          <input className={INPUT} value={v.quotePrefix} onChange={set("quotePrefix")} maxLength={12} />
        </Field>
        <Field label="Next quote number" hint="It can only go up. Numbers are never reused.">
          <input className={INPUT} inputMode="numeric" value={v.nextQuoteNumber} onChange={set("nextQuoteNumber")} />
        </Field>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Accounts</h3>
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
      </div>
      <ErrorLine message={error} />
      <OkLine message={ok} />
      <Button onClick={submit} disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}

export function CounterForm({ slug, next }: { slug: string; next: number }) {
  const { pending, error, ok, run } = useRunner();
  const [value, setValue] = useState(String(next));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The next invoice will be number <strong>{next}</strong>. The counter can only go up and can never be set to a number already used.
      </p>
      <div className="flex max-w-sm items-end gap-2">
        <Field label="Next invoice number" className="flex-1">
          <input className={INPUT} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => run(() => setInvoiceCounterAction({ slug, nextInvoiceNumber: Number(value) }), { okMessage: "Counter updated." })}
        >
          Raise
        </Button>
      </div>
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}

export function RemitForm({ slug, profile }: { slug: string; profile: ProfileView }) {
  const mailing = useRunner();
  const bank = useRunner();
  const [address, setAddress] = useState(profile.remitToMailingAddress ?? "");
  const [payee, setPayee] = useState(profile.checkPayableTo ?? "");
  const [bankText, setBankText] = useState("");
  const [editingBank, setEditingBank] = useState(!profile.hasRemitBank);
  const [includeDefault, setIncludeDefault] = useState(profile.includeRemitToByDefault);

  async function loadBank() {
    bank.run(() => revealRemitBankText({ slug }), {
      refresh: false,
      onSuccess: (r) => {
        if ("text" in r) setBankText(r.text ?? "");
        setEditingBank(true);
      },
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Mail checks to</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Address">
            <textarea className={INPUT} rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="Checks payable to">
            <input className={INPUT} value={payee} onChange={(e) => setPayee(e.target.value)} />
          </Field>
        </div>
        <ErrorLine message={mailing.error} />
        <OkLine message={mailing.ok} />
        <Button variant="outline" disabled={mailing.pending} onClick={() => mailing.run(() => setRemitMailing({ slug, remitToMailingAddress: address, checkPayableTo: payee }), { okMessage: "Saved." })}>
          Save mailing details
        </Button>
      </div>

      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Bank / ACH instructions (optional)</h3>
        <p className="text-xs text-muted-foreground">
          Approved exception: text you type here is stored encrypted and is printed only on invoices where you tick &quot;include bank details&quot;. It is never
          logged, never sent to the assistant and never shown in the audit trail. It travels inside the PDF you e-mail, so it will exist in the
          recipient&apos;s mailbox.
        </p>
        {profile.hasRemitBank && !editingBank ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">Bank text is set{profile.remitToUpdatedAt ? ` (saved ${profile.remitToUpdatedAt})` : ""}. It is not shown here.</span>
            <Button variant="outline" size="sm" disabled={bank.pending} onClick={loadBank}>
              Replace
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Instructions text (for example bank name, routing and account for ACH)">
              <textarea className={INPUT} rows={4} value={bankText} onChange={(e) => setBankText(e.target.value)} maxLength={1200} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeDefault} disabled={bankText.trim() === ""} onChange={(e) => setIncludeDefault(e.target.checked)} />
              Include on every new invoice by default (otherwise tick it per invoice)
            </label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={bank.pending}
                onClick={() => bank.run(() => setRemitBankText({ slug, text: bankText, includeByDefault: includeDefault }), { okMessage: bankText.trim() === "" ? "Bank text cleared." : "Bank text saved.", onSuccess: () => { setBankText(""); setEditingBank(false); } })}
              >
                {bankText.trim() === "" ? "Clear bank text" : "Save bank text"}
              </Button>
              {profile.hasRemitBank ? (
                <Button variant="ghost" onClick={() => { setBankText(""); setEditingBank(false); }}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        )}
        <ErrorLine message={bank.error} />
        <OkLine message={bank.ok} />
      </div>
    </div>
  );
}

export function EinForm({ slug, last4 }: { slug: string; last4: string | null }) {
  const { pending, error, ok, run } = useRunner();
  const [ein, setEin] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Business EIN: <strong>{maskedEin(last4)}</strong>. Stored encrypted; only the last four digits are shown. It is used as the payer ID on a future 1099 and
        is printed on invoices only if you turn that on above.
      </p>
      <div className="flex max-w-md items-end gap-2">
        <Field label={last4 ? "Replace EIN" : "Set EIN"} className="flex-1">
          <input className={INPUT} placeholder="12-3456789" value={ein} onChange={(e) => setEin(e.target.value)} autoComplete="off" />
        </Field>
        <Button variant="outline" disabled={pending || ein.trim() === ""} onClick={() => run(() => setBusinessEin({ slug, ein }), { okMessage: "EIN saved.", onSuccess: () => setEin("") })}>
          Save
        </Button>
      </div>
      <div className="flex items-center gap-3">
        {last4 ? (
          <>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => revealBusinessEin({ slug }), { refresh: false, onSuccess: (r) => setRevealed("ein" in r ? (r.ein ?? null) : null) })}>
              Reveal
            </Button>
            {revealed ? <code className="rounded bg-muted px-2 py-1 text-sm">{revealed}</code> : null}
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setBusinessEin({ slug, ein: "" }), { okMessage: "EIN removed." })}>
              Remove
            </Button>
          </>
        ) : null}
      </div>
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}

export function LogoForm({ slug, hasLogo, previewSrc }: { slug: string; hasLogo: boolean; previewSrc: string | null }) {
  const { pending, error, ok, run } = useRunner();
  const fileRef = useRef<HTMLInputElement>(null);
  function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("file", file);
    run(() => uploadInvoiceLogo(fd), { okMessage: "Logo uploaded.", onSuccess: () => { if (fileRef.current) fileRef.current.value = ""; } });
  }
  return (
    <div className="space-y-3">
      {hasLogo && previewSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private data: URI preview of the owner's own logo
        <img src={previewSrc} alt="Current invoice logo" className="max-h-20 max-w-xs rounded border bg-white p-1" />
      ) : (
        <p className="text-sm text-muted-foreground">{hasLogo ? "A logo is set (preview unavailable)." : "No logo uploaded."}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="text-sm" />
        <Button variant="outline" disabled={pending} onClick={upload}>
          Upload logo
        </Button>
        {hasLogo ? (
          <Button variant="ghost" disabled={pending} onClick={() => run(() => removeInvoiceLogo({ slug }), { okMessage: "Logo removed." })}>
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">PNG or JPEG, {LOGO_MAX_LABEL} at most.</p>
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}
