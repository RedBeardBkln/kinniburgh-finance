// Tells Benchtop about an invoice's imported time: issued -> its entries are marked billed with the invoice number, void -> marked
// unbilled again (only those still billed on that number). Server only, NOT a "use server" file: the invoice actions call it after
// their own auth, entity gate and owner rule, once the issue / void has committed. A failure never undoes the issue or the void:
// it is recorded on the timeline and the invoice page offers to try again.

import { BenchtopError, markBenchtopBilled } from "@/lib/invoicing/benchtop/client";
import * as store from "@/lib/invoicing/store";
import { readBenchtopKey } from "@/lib/invoicing/tin-store";

export type TimeSyncOutcome = { ok: true; note: string | null } | { ok: false; error: string };

export async function syncInvoiceTime(args: {
  entityId: string;
  userId: string;
  documentId: string;
  direction: "bill" | "unbill";
  invoiceRef: string;
  entryIds: string[];
}): Promise<TimeSyncOutcome> {
  const { entityId, userId, documentId, direction, invoiceRef, entryIds } = args;
  if (entryIds.length === 0) return { ok: true, note: null };
  const failKind = direction === "bill" ? "time_bill_failed" : "time_unbill_failed";
  try {
    const key = await readBenchtopKey(entityId);
    if (!key) throw new BenchtopError("No Benchtop connection key is saved (Invoicing settings), so Benchtop was not told about this invoice's time.");
    const r = await markBenchtopBilled(key, entryIds, direction === "bill", invoiceRef);
    await store.recordTimeSync({
      entityId,
      userId,
      documentId,
      kind: direction === "bill" ? "time_billed" : "time_unbilled",
      data: { changed: r.change.length, unchanged: r.unchanged.length, conflicts: r.conflicts.length, missing: r.missing.length },
    });
    const skipped = r.conflicts.length + r.missing.length;
    const note =
      skipped === 0
        ? null
        : direction === "bill"
          ? `${skipped} of the ${entryIds.length} Benchtop time entries were not marked billed: they were already billed some other way, or are no longer in Benchtop.`
          : `${skipped} of the ${entryIds.length} Benchtop time entries were left as they are: they are billed on something else now, or are no longer in Benchtop.`;
    return { ok: true, note };
  } catch (err) {
    const error = err instanceof BenchtopError ? err.message : "Benchtop could not be updated.";
    if (!(err instanceof BenchtopError)) console.error("Benchtop time sync failed", err instanceof Error ? err.name : "UnknownError");
    try {
      await store.recordTimeSync({ entityId, userId, documentId, kind: failKind, data: { entries: entryIds.length } });
    } catch {
      // the timeline row is best effort; the page still shows the invoice as needing a retry
    }
    return { ok: false, error };
  }
}
