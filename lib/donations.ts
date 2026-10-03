// Pure donation-log input validation. No DB, no "use server": shared by the
// server actions (authoritative) and the client forms (to show the same
// vocabulary). The log RECORDS what the owner entered; it never computes a
// deductible amount or applies an AGI limit.

import { z } from "zod";
import { parseDollarsToCents } from "@/lib/money-input";
import { parseIsoDateNoonUtc } from "@/lib/tax-log-dates";

export const DONATION_KINDS = ["cash", "noncash"] as const;
export type DonationKind = (typeof DONATION_KINDS)[number];

/** The owner-reported evidence type for a gift (a claim, not a verification). */
export const DONATION_SUBSTANTIATION = ["none", "bank_record", "written_acknowledgment"] as const;
export type DonationSubstantiation = (typeof DONATION_SUBSTANTIATION)[number];

export const DONATION_KIND_LABELS: Record<DonationKind, string> = {
  cash: "Cash / check / card",
  noncash: "Non-cash (goods, property)",
};

export const DONATION_SUBSTANTIATION_LABELS: Record<DonationSubstantiation, string> = {
  none: "No record yet",
  bank_record: "Bank / card record",
  written_acknowledgment: "Written acknowledgment from the charity",
};

/** Raw input as typed by the owner: every money/date field is a STRING. */
export const donationInputSchema = z.object({
  date: z.string(),
  recipient: z.string().trim().min(1, "Recipient is required").max(200, "Recipient is too long (200 characters max)"),
  amount: z.string(),
  kind: z.enum(DONATION_KINDS, { errorMap: () => ({ message: "Choose cash or non-cash" }) }),
  substantiation: z.enum(DONATION_SUBSTANTIATION, { errorMap: () => ({ message: "Choose a record type" }) }),
  receiptDocumentId: z.string().uuid("Invalid receipt document").nullable().optional(),
  notes: z.string().trim().max(2000, "Notes are too long (2000 characters max)").nullable().optional(),
});

export type DonationInput = z.input<typeof donationInputSchema>;

export interface NormalizedDonation {
  date: Date;
  recipient: string;
  amountCents: number;
  kind: DonationKind;
  substantiation: DonationSubstantiation;
  receiptDocumentId: string | null;
  notes: string | null;
}

export type NormalizeDonationResult = { ok: true; value: NormalizedDonation } | { ok: false; error: string };

export function normalizeDonationInput(raw: unknown): NormalizeDonationResult {
  const parsed = donationInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;

  const date = parseIsoDateNoonUtc(v.date);
  if (!date) return { ok: false, error: "Enter a valid date (YYYY-MM-DD, 2000-2100)" };

  const amount = parseDollarsToCents(v.amount);
  if (!amount.ok) return { ok: false, error: amount.error };

  // A bank/card record documents a payment, not donated goods.
  if (v.kind === "noncash" && v.substantiation === "bank_record") {
    return {
      ok: false,
      error: "A bank record does not document donated goods - choose a written acknowledgment or no record yet",
    };
  }

  return {
    ok: true,
    value: {
      date,
      recipient: v.recipient,
      amountCents: amount.cents,
      kind: v.kind,
      substantiation: v.substantiation,
      receiptDocumentId: v.receiptDocumentId ?? null,
      notes: v.notes && v.notes !== "" ? v.notes : null,
    },
  };
}
