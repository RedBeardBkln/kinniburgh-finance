// Open online-payment flags (plan P9). PURE. A flag is a `stripe_flag` timeline row; it is open until a `stripe_flag_reviewed` row names
// it in `data.flagEventId`. A review that names anything other than a flag is ignored. Nothing is ever reversed by a flag or a review.

import { STRIPE_FLAG_LABELS, STRIPE_FLAG_REASONS, type StripeFlagReason } from "@/lib/invoicing/constants";

export interface FlagEventInput {
  id: string;
  kind: string;
  documentId: string | null;
  paymentId: string | null;
  createdAt: string;
  data: Record<string, string | number | boolean | null>;
}

export interface OpenStripeFlag {
  id: string;
  reason: StripeFlagReason;
  label: string;
  documentId: string | null;
  paymentId: string | null;
  amountCents: number | null;
  createdAt: string;
}

export function isStripeFlagReason(v: unknown): v is StripeFlagReason {
  return typeof v === "string" && (STRIPE_FLAG_REASONS as readonly string[]).includes(v);
}

export function openStripeFlags(events: readonly FlagEventInput[]): OpenStripeFlag[] {
  const flags = events.filter((e) => e.kind === "stripe_flag");
  const flagIds = new Set(flags.map((f) => f.id));
  const reviewed = new Set(
    events
      .filter((e) => e.kind === "stripe_flag_reviewed")
      .map((e) => e.data.flagEventId)
      .filter((id): id is string => typeof id === "string" && flagIds.has(id))
  );
  const out: OpenStripeFlag[] = [];
  for (const f of flags) {
    if (reviewed.has(f.id)) continue;
    const reason = isStripeFlagReason(f.data.reason) ? f.data.reason : null;
    if (!reason) continue;
    out.push({
      id: f.id,
      reason,
      label: STRIPE_FLAG_LABELS[reason],
      documentId: f.documentId,
      paymentId: f.paymentId,
      amountCents: typeof f.data.amountCents === "number" ? f.data.amountCents : null,
      createdAt: f.createdAt,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
