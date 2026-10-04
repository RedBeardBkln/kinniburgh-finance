// Pure, client-safe rules for changing a document's type from the /documents
// page (donation-receipt-document-type). No DB, no server imports.
//
// Only the owner-chosen "tax-ish" types can be switched among each other.
// Statements, policies and utility bills are NOT retypable here: a
// `bank_statement` Document is linked to a BankStatement row, and the other
// types are produced by their own upload flows.

import { documentTypeLabel, generateDocumentName } from "@/lib/doc-naming";
import { RETIREMENT_PICKER_LABEL } from "@/lib/retirement-statement";

export interface RetypeTarget {
  value: string;
  /** Picker label (the same wording the upload pickers use). */
  label: string;
}

/** Single list the targets AND the "retype from" set derive from. */
export const RETYPE_TARGET_OPTIONS: readonly RetypeTarget[] = [
  { value: "w2", label: "W-2 (wage statement)" },
  { value: "1099", label: "1099 (interest/dividend/contractor)" },
  { value: "k1", label: "K-1 (partnership/S-corp)" },
  { value: "mortgage_interest", label: "Form 1098 (mortgage interest)" },
  { value: "property_tax", label: "Property tax bill" },
  { value: "donation_receipt", label: "Donation receipt / acknowledgment" },
  { value: "retirement_contribution", label: RETIREMENT_PICKER_LABEL },
  { value: "tax_return", label: "Prior-year tax return" },
  { value: "extension", label: "Extension confirmation" },
  { value: "other", label: "Other document" },
];

export const RETYPE_TARGETS: readonly string[] = RETYPE_TARGET_OPTIONS.map((o) => o.value);

/** A document of any of these types can be switched among the targets. */
export const RETYPABLE_FROM: readonly string[] = RETYPE_TARGETS;

/** Exact text the tax workspace's updateTaxDocument already returns for a verified document. */
export const VERIFIED_RETYPE_ERROR = "This document is verified. Un-verify it before changing its type.";

export function isRetypableFrom(docType: string): boolean {
  return RETYPABLE_FROM.includes(docType);
}

export function retypeTargetLabel(docType: string): string {
  return RETYPE_TARGET_OPTIONS.find((o) => o.value === docType)?.label ?? documentTypeLabel(docType);
}

/**
 * Why a retype must be refused, or null when it may go ahead. A verified
 * document keeps the existing "un-verify first" protection (its confirmed
 * values were verified against ITS type); a same-type request is not an error.
 */
export function retypeBlockReason(input: {
  currentDocType: string;
  nextDocType: string;
  verified: boolean;
}): string | null {
  const { currentDocType, nextDocType, verified } = input;
  if (!RETYPE_TARGETS.includes(nextDocType)) return "That document type cannot be chosen here.";
  if (!isRetypableFrom(currentDocType)) return "This kind of document cannot have its type changed here.";
  if (verified && currentDocType !== nextDocType) return VERIFIED_RETYPE_ERROR;
  return null;
}

/**
 * True when `name` is just the auto-generated placeholder for the document (or
 * missing), so a retype may refresh it. A name the owner typed is never
 * overwritten.
 */
export function isPlaceholderName(name: string | null | undefined, docType: string, taxYear: number | null): boolean {
  if (name === null || name === undefined || name.trim() === "") return true;
  const trimmed = name.trim();
  return trimmed === documentTypeLabel(docType) || trimmed === generateDocumentName(docType, taxYear, null);
}
