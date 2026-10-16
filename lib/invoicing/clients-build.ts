// Read-only loaders for clients and contacts. No writes, explicit selects (never the encrypted EIN), archived rows excluded.
// "W-9 on file" is true exactly when w9DocumentId points at a non-archived Document of docType w9 (owner answer 2026-10-15).

import { db } from "@/lib/db";
import { toIsoDate } from "@/lib/invoicing/validate";

export interface ContactView {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  roleLabel: string | null;
  receivesInvoices: boolean;
}

export interface ClientView {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  einLast4: string | null;
  defaultNetDays: number | null;
  defaultTaxable: boolean;
  w9DocumentId: string | null;
  w9OnFile: boolean;
  w9ReceivedOn: string | null;
  w9Label: string | null;
  notes: string | null;
  contacts: ContactView[];
}

const CLIENT_SELECT = {
  id: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  einLast4: true,
  defaultNetDays: true,
  defaultTaxable: true,
  w9DocumentId: true,
  w9ReceivedOn: true,
  notes: true,
  w9: { select: { id: true, archivedAt: true, docType: true, documentName: true } },
  contacts: {
    where: { archivedAt: null },
    select: { id: true, name: true, email: true, phone: true, role: true, roleLabel: true, receivesInvoices: true },
    orderBy: { name: "asc" as const },
  },
} as const;

type ClientRow = Awaited<ReturnType<typeof loadClientRows>>[number];

async function loadClientRows(entityId: string, id?: string, opts: { includeArchived?: boolean } = {}) {
  return db.client.findMany({
    where: { entityId, ...(opts.includeArchived ? {} : { archivedAt: null }), ...(id ? { id } : {}) },
    select: CLIENT_SELECT,
    orderBy: { name: "asc" },
  });
}

function toView(r: ClientRow): ClientView {
  const onFile = r.w9 !== null && r.w9.archivedAt === null && r.w9.docType === "w9";
  return {
    id: r.id,
    name: r.name,
    addressLine1: r.addressLine1,
    addressLine2: r.addressLine2,
    city: r.city,
    state: r.state,
    postalCode: r.postalCode,
    country: r.country,
    einLast4: r.einLast4,
    defaultNetDays: r.defaultNetDays,
    defaultTaxable: r.defaultTaxable,
    w9DocumentId: onFile ? r.w9DocumentId : null,
    w9OnFile: onFile,
    w9ReceivedOn: r.w9ReceivedOn ? toIsoDate(r.w9ReceivedOn) : null,
    w9Label: onFile ? (r.w9?.documentName ?? "W-9") : null,
    notes: r.notes,
    contacts: r.contacts,
  };
}

export async function loadClients(entityId: string): Promise<ClientView[]> {
  return (await loadClientRows(entityId)).map(toView);
}

/**
 * One client of the entity. Archived clients are NOT returned unless `includeArchived` is set; only the payment-side deposit search
 * sets it, because an archived client's open invoice can still be paid (store.recordPayment allows that) and its deposit candidates
 * must be findable. Lists, the client page and every editor keep the strict default.
 */
export async function loadClient(entityId: string, id: string, opts: { includeArchived?: boolean } = {}): Promise<ClientView | null> {
  const rows = await loadClientRows(entityId, id, opts);
  return rows[0] ? toView(rows[0]) : null;
}

/** Default invoice recipients: contacts flagged receivesInvoices. */
export function defaultRecipients(c: Pick<ClientView, "contacts">): ContactView[] {
  return c.contacts.filter((x) => x.receivesInvoices);
}
