// Pure document-name generation — client-safe.
// Builds a human-friendly name from extraction data, e.g.:
//   "W-2 — Acme Corp (2025)"
//   "1099-NEC — Fiverr (2025)"
//   "1098 — PennyMac (2025)"

import type { ExtractedDocument } from "./doc-extract";

const DOC_TYPE_LABELS: Record<string, string> = {
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  extension: "Extension",
  property_tax: "Property Tax Bill",
  mortgage_interest: "1098",
  mortgage_statement: "Mortgage Statement",
  tax_return: "Tax Return",
  bank_statement: "Bank Statement",
  insurance_policy: "Insurance Policy",
  utility_bill: "Utility Bill",
  policy: "Policy",
  statement: "Statement",
  other: "Document",
};

export function documentTypeLabel(docType: string): string {
  return DOC_TYPE_LABELS[docType] ?? docType;
}

/**
 * Generates a document name from the extraction payload when possible,
 * falling back to type + tax year. Pure — never throws.
 */
export function generateDocumentName(
  docType: string,
  taxYear: number | null,
  extraction: Pick<ExtractedDocument, "docType" | "data"> | null
): string {
  const typeLabel = documentTypeLabel(docType);
  const data = (extraction?.data ?? {}) as Record<string, unknown>;
  const year =
    (typeof data["taxYear"] === "number" ? data["taxYear"] : null) ?? taxYear;

  // Per-type source names
  let source: string | null = null;
  if (docType === "w2") {
    source = typeof data["employerName"] === "string" ? data["employerName"] : null;
  } else if (docType === "1099") {
    const payer = typeof data["payerName"] === "string" ? data["payerName"] : null;
    const variant = typeof data["formVariant"] === "string" ? data["formVariant"] : null;
    if (payer && variant && variant !== "other") {
      return `1099${variant.startsWith("1099") ? variant.slice(4) : `-${variant.slice(-3)}`} — ${payer}${year ? ` (${year})` : ""}`;
    }
    source = payer;
  } else if (docType === "k1") {
    source = typeof data["entityName"] === "string" ? data["entityName"] : null;
  } else if (docType === "mortgage_interest" || docType === "mortgage_statement") {
    source =
      typeof data["servicerName"] === "string" ? data["servicerName"] : null;
  } else if (docType === "tax_return") {
    source = typeof data["taxpayerName"] === "string" ? data["taxpayerName"] : null;
  } else if (docType === "utility_bill") {
    source = typeof data["provider"] === "string" ? data["provider"] : null;
  } else if (docType === "bank_statement") {
    source =
      typeof data["institutionName"] === "string" ? data["institutionName"] : null;
    const period = typeof data["period"] === "string" ? data["period"] : null;
    if (source && period) {
      return `${typeLabel} — ${source} (${period})`;
    }
  } else if (docType === "insurance_policy") {
    source = typeof data["insurer"] === "string" ? data["insurer"] : null;
  }

  if (source) {
    return `${typeLabel} — ${source}${year ? ` (${year})` : ""}`;
  }
  return year ? `${typeLabel} (${year})` : typeLabel;
}