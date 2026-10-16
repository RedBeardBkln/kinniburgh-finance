"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import {
  addContact,
  archiveClient,
  archiveContact,
  createClient,
  linkClientW9,
  revealClientEin,
  setClientEin,
  updateClient,
  updateContact,
} from "@/actions/clients";
import { finalizeDocumentUpload, requestDocumentUploadSlot } from "@/actions/documents";
import { validateDocumentFile } from "@/lib/document-upload";
import { CONTACT_ROLES, CONTACT_ROLE_LABELS, type ContactRole } from "@/lib/invoicing/constants";
import { maskedEin } from "@/lib/invoicing/tin";
import type { ClientView, ContactView } from "@/lib/invoicing/clients-build";
import type { W9Option } from "@/lib/invoicing/catalog-build";
import { ErrorLine, Field, INPUT, OkLine, useRunner } from "@/components/invoicing/shared";

// `readOnly` is a plain boolean decided on the server from the owner rule (Eva and any other non-owner may only VIEW). Every server
// action is owner-only as well, so hiding the controls is a convenience, never the protection.

export function ClientForm({ slug, client, readOnly = false }: { slug: string; client?: ClientView; readOnly?: boolean }) {
  const router = useRouter();
  const { pending, error, ok, run } = useRunner();
  const [v, setV] = useState({
    name: client?.name ?? "",
    addressLine1: client?.addressLine1 ?? "",
    addressLine2: client?.addressLine2 ?? "",
    city: client?.city ?? "",
    state: client?.state ?? "",
    postalCode: client?.postalCode ?? "",
    country: client?.country ?? "US",
    defaultNetDays: client?.defaultNetDays === null || client?.defaultNetDays === undefined ? "" : String(client.defaultNetDays),
    notes: client?.notes ?? "",
  });
  const [taxable, setTaxable] = useState(client?.defaultTaxable ?? false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  function payload() {
    return {
      slug,
      name: v.name,
      addressLine1: v.addressLine1,
      addressLine2: v.addressLine2,
      city: v.city,
      state: v.state,
      postalCode: v.postalCode,
      country: v.country,
      defaultNetDays: v.defaultNetDays.trim() === "" ? null : Number(v.defaultNetDays),
      defaultTaxable: taxable,
      notes: v.notes,
    };
  }

  function submit() {
    if (client) run(() => updateClient({ ...payload(), id: client.id }), { okMessage: "Saved." });
    else
      run(() => createClient(payload()), {
        refresh: false,
        onSuccess: (r) => {
          if ("id" in r) router.push(`/business/${slug}/clients/${r.id}` as Route);
        },
      });
  }

  return (
    <fieldset disabled={readOnly} className="space-y-3 border-0 p-0">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client name">
          <input className={INPUT} value={v.name} onChange={set("name")} />
        </Field>
        <Field label="Days until due (blank = use the default)">
          <input className={INPUT} inputMode="numeric" value={v.defaultNetDays} onChange={set("defaultNetDays")} />
        </Field>
        <Field label="Address line 1">
          <input className={INPUT} value={v.addressLine1} onChange={set("addressLine1")} />
        </Field>
        <Field label="Address line 2">
          <input className={INPUT} value={v.addressLine2} onChange={set("addressLine2")} />
        </Field>
        <Field label="City">
          <input className={INPUT} value={v.city} onChange={set("city")} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="State">
            <input className={INPUT} value={v.state} onChange={set("state")} />
          </Field>
          <Field label="Postal code">
            <input className={INPUT} value={v.postalCode} onChange={set("postalCode")} />
          </Field>
          <Field label="Country">
            <input className={INPUT} value={v.country} onChange={set("country")} />
          </Field>
        </div>
      </div>
      <Field label="Notes (not shown to the client)">
        <textarea className={INPUT} rows={2} value={v.notes} onChange={set("notes")} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
        Taxable client (a stored flag only; sales tax is not calculated)
      </label>
      <ErrorLine message={error} />
      <OkLine message={ok} />
      {readOnly ? <p className="text-xs text-muted-foreground">View only. Only the owner can change client details.</p> : null}
      {readOnly ? null : (
        <div className="flex gap-2">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : client ? "Save client" : "Add client"}
          </Button>
          {client ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (window.confirm("Archive this client? Their invoices and payments stay; they leave the lists.")) {
                  run(() => archiveClient({ slug, id: client.id }), { refresh: false, onSuccess: () => router.push(`/business/${slug}/clients` as Route) });
                }
              }}
            >
              Archive
            </Button>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

function ContactRow({ slug, clientId, contact, readOnly }: { slug: string; clientId: string; contact: ContactView; readOnly: boolean }) {
  const { pending, error, run } = useRunner();
  const [editing, setEditing] = useState(false);
  if (editing && !readOnly) {
    return (
      <li className="rounded-md border p-3">
        <ContactForm slug={slug} clientId={clientId} contact={contact} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <div>
        <div className="font-medium">
          {contact.name} <span className="font-normal text-muted-foreground">({contact.role === "other" ? (contact.roleLabel ?? "Other") : CONTACT_ROLE_LABELS[contact.role as ContactRole]})</span>
        </div>
        <div className="text-muted-foreground">
          {contact.email}
          {contact.phone ? ` · ${contact.phone}` : ""}
        </div>
        {contact.receivesInvoices ? <div className="text-xs text-green-700">Receives invoices</div> : null}
      </div>
      {readOnly ? null : (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => archiveContact({ slug, clientId, contactId: contact.id }))}>
            Remove
          </Button>
        </div>
      )}
      <div className="w-full">
        <ErrorLine message={error} />
      </div>
    </li>
  );
}

function ContactForm({ slug, clientId, contact, onDone }: { slug: string; clientId: string; contact?: ContactView; onDone: () => void }) {
  const { pending, error, run } = useRunner();
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [role, setRole] = useState<ContactRole>((contact?.role as ContactRole) ?? "billing");
  const [roleLabel, setRoleLabel] = useState(contact?.roleLabel ?? "");
  const [receives, setReceives] = useState(contact?.receivesInvoices ?? false);

  function submit() {
    const base = { slug, clientId, name, email, phone, role, roleLabel: role === "other" ? roleLabel : null, receivesInvoices: receives };
    run(() => (contact ? updateContact({ ...base, contactId: contact.id }) : addContact(base)), {
      onSuccess: () => {
        if (!contact) {
          setName("");
          setEmail("");
          setPhone("");
          setRoleLabel("");
          setReceives(false);
        }
        onDone();
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="E-mail">
          <input className={INPUT} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Phone (optional)">
          <input className={INPUT} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Role">
          <select className={INPUT} value={role} onChange={(e) => setRole(e.target.value as ContactRole)}>
            {CONTACT_ROLES.map((r) => (
              <option key={r} value={r}>
                {CONTACT_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        {role === "other" ? (
          <Field label="Describe the role">
            <input className={INPUT} value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} />
          </Field>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={receives} onChange={(e) => setReceives(e.target.checked)} />
        Receives invoices (default recipient when an invoice is e-mailed)
      </label>
      <ErrorLine message={error} />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {contact ? "Save contact" : "Add contact"}
        </Button>
        {contact ? (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ContactsPanel({ slug, clientId, contacts, readOnly = false }: { slug: string; clientId: string; contacts: ContactView[]; readOnly?: boolean }) {
  return (
    <div className="space-y-4">
      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {readOnly ? "No contacts yet." : "No contacts yet. Add one and tick \"Receives invoices\" to make them the default recipient."}
        </p>
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => (
            <ContactRow key={c.id} slug={slug} clientId={clientId} contact={c} readOnly={readOnly} />
          ))}
        </ul>
      )}
      {readOnly ? (
        <p className="text-xs text-muted-foreground">View only. Only the owner can add or change contacts.</p>
      ) : (
        <div className="rounded-md border border-dashed p-3">
          <h4 className="mb-2 text-sm font-semibold">Add a contact</h4>
          <ContactForm slug={slug} clientId={clientId} onDone={() => undefined} />
        </div>
      )}
    </div>
  );
}

export function ClientEinPanel({ slug, clientId, last4, canReveal }: { slug: string; clientId: string; last4: string | null; canReveal: boolean }) {
  const { pending, error, ok, run } = useRunner();
  const [ein, setEin] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        EIN: <strong>{maskedEin(last4)}</strong> <span className="text-muted-foreground">(stored encrypted; only the last four digits are shown)</span>
      </p>
      {canReveal ? (
        <div className="flex max-w-md items-end gap-2">
          <Field label={last4 ? "Replace EIN" : "Set EIN"} className="flex-1">
            <input className={INPUT} placeholder="12-3456789" value={ein} onChange={(e) => setEin(e.target.value)} autoComplete="off" />
          </Field>
          <Button variant="outline" disabled={pending || ein.trim() === ""} onClick={() => run(() => setClientEin({ slug, id: clientId, ein }), { okMessage: "EIN saved.", onSuccess: () => setEin("") })}>
            Save
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only the owner can set, replace or remove a tax ID.</p>
      )}
      {last4 ? (
        <div className="flex items-center gap-3">
          {canReveal ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => revealClientEin({ slug, id: clientId }), { refresh: false, onSuccess: (r) => setRevealed("ein" in r ? (r.ein ?? null) : null) })}>
              Reveal (owner)
            </Button>
          ) : null}
          {revealed ? <code className="rounded bg-muted px-2 py-1 text-sm">{revealed}</code> : null}
          {canReveal ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setClientEin({ slug, id: clientId, ein: "" }), { okMessage: "EIN removed." })}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}

export function W9Panel({
  slug,
  clientId,
  entityId,
  onFile,
  label,
  receivedOn,
  options,
  readOnly = false,
}: {
  slug: string;
  clientId: string;
  entityId: string;
  onFile: boolean;
  label: string | null;
  receivedOn: string | null;
  options: W9Option[];
  readOnly?: boolean;
}) {
  const { pending, error, ok, run, setError } = useRunner();
  const fileRef = useRef<HTMLInputElement>(null);
  const [received, setReceived] = useState(receivedOn ?? "");
  const [pick, setPick] = useState("");

  function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose the W-9 file.");
    const pre = validateDocumentFile(file.type, file.size);
    if (!pre.ok) return setError(pre.error);
    run(
      async () => {
        const slot = await requestDocumentUploadSlot({ entityId, fileType: file.type, fileSize: file.size });
        if (!slot.ok) return { error: slot.error };
        const put = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
        if (!put.ok) return { error: "The upload to storage failed. Try again." };
        const fin = await finalizeDocumentUpload({ documentId: slot.documentId, fileKey: slot.fileKey, entityId, fileType: file.type, docType: "w9", notes: "W-9 uploaded from a client page" });
        if (!fin.ok) return { error: fin.error };
        return linkClientW9({ slug, clientId, documentId: fin.documentId, receivedOn: received || null });
      },
      { okMessage: "W-9 uploaded and linked.", onSuccess: () => { if (fileRef.current) fileRef.current.value = ""; } }
    );
  }

  if (readOnly) {
    return (
      <div className="space-y-1">
        <p className="text-sm">
          W-9: {onFile ? <strong className="text-green-700">on file ({label})</strong> : <strong className="text-yellow-700">not on file</strong>}
          {onFile && receivedOn ? ` · received ${receivedOn}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">View only. Only the owner can upload or link a W-9.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        W-9: {onFile ? <strong className="text-green-700">on file ({label})</strong> : <strong className="text-yellow-700">not on file</strong>}
        {onFile && receivedOn ? ` · received ${receivedOn}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        A W-9 counts as on file only when its document is uploaded here (a date alone does not). It goes to the document vault, is never read by AI, and the
        number on it is not copied anywhere.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Received on (optional)">
          <input type="date" className={INPUT} value={received} onChange={(e) => setReceived(e.target.value)} />
        </Field>
        <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="text-sm" />
        <Button variant="outline" disabled={pending} onClick={upload}>
          Upload W-9
        </Button>
      </div>
      {options.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Or link a W-9 already in the vault">
            <select className={INPUT} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="outline" disabled={pending || pick === ""} onClick={() => run(() => linkClientW9({ slug, clientId, documentId: pick, receivedOn: received || null }), { okMessage: "W-9 linked." })}>
            Link
          </Button>
        </div>
      ) : null}
      {onFile ? (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => linkClientW9({ slug, clientId, documentId: null }), { okMessage: "W-9 unlinked." })}>
          Unlink
        </Button>
      ) : null}
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}
