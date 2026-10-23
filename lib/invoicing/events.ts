// BillingEvent payload guard (plan section 5: "data Json (ids, counts, cents only; never free text, never an e-mail address, never a
// TIN, never remit-to text)"). PURE. The store calls `assertSafeEventData` before every append, so a careless caller cannot put
// a note, an address or a number with a name in the timeline.

export type EventDatum = string | number | boolean | null;
export type EventData = Record<string, EventDatum>;

export const EVENT_KINDS = [
  "created",
  "edited",
  "issued",
  "voided",
  "archived",
  "payment_recorded",
  "payment_voided",
  "allocated",
  "deallocated",
  "deposit_linked",
  "deposit_unlinked",
  "emailed",
  "email_failed",
  // Phase 2 (online payments and the client's view link)
  "link_created",
  "link_revoked",
  "link_viewed",
  "checkout_started",
  "stripe_flag",
  "stripe_flag_reviewed",
  "fee_recorded",
  // A US bank (ACH) payment that is still processing, and the owner's "Stop waiting for this payment" (stripe-ach-pending-hide-pay)
  "bank_payment_pending",
  "bank_payment_released",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// An id-like token: letters, digits and _ : . - only, no spaces and no "@" (so names, addresses and e-mails cannot fit).
const SAFE_STRING = /^[A-Za-z0-9_:.\-]{0,80}$/;

export function assertSafeEventData(data: Record<string, unknown>): EventData {
  const out: EventData = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) throw new Error("event key is not allowed");
    if (v === null || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("event number is not finite");
      out[k] = v;
    } else if (typeof v === "string") {
      if (!SAFE_STRING.test(v)) throw new Error("event text is not an id-like token");
      out[k] = v;
    } else throw new Error("event value type is not allowed");
  }
  return out;
}
