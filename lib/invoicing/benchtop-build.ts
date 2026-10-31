// Read-only loaders for the Benchtop time import (CLAUDE.md "Benchtop time import"). No writes, explicit selects, never the encrypted
// key (only tin-store.ts reads it).

import { db } from "@/lib/db";

/** Whether a Benchtop connection key is saved, and its last four characters. */
export async function loadBenchtopStatus(entityId: string): Promise<{ connected: boolean; keyLast4: string | null }> {
  const row = await db.invoicingProfile.findUnique({ where: { entityId }, select: { benchtopKeyLast4: true } });
  return { connected: Boolean(row?.benchtopKeyLast4), keyLast4: row?.benchtopKeyLast4 ?? null };
}

/**
 * Of these Benchtop entry ids, the ones already on another live invoice of the entity (a draft, or an issued invoice; void invoices
 * and archived drafts do not count), with that invoice's number ("draft" for a draft). `excludeDocumentId`: the invoice being edited.
 */
export async function loadTimeEntriesInUse(entityId: string, ids: string[], excludeDocumentId: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const lines = await db.billingLine.findMany({
    where: {
      timeEntryIds: { hasSome: ids },
      document: { entityId, status: { not: "void" }, archivedAt: null, ...(excludeDocumentId ? { id: { not: excludeDocumentId } } : {}) },
    },
    select: { timeEntryIds: true, document: { select: { displayNumber: true } } },
  });
  const wanted = new Set(ids);
  for (const l of lines) {
    for (const id of l.timeEntryIds) if (wanted.has(id)) out.set(id, l.document.displayNumber ?? "draft");
  }
  return out;
}
