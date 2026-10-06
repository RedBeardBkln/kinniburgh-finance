// Independent reading of the source documents for L1.C1 / L1.C2 (plan section 5.3). These helpers read the EFFECTIVE extraction of
// each document (corrections overlaid, through resolveTaxDocForCompute upstream) directly by its extraction field keys
// (lib/tax-extraction-schema.ts), NOT through lib/tax2025/resolve-facts.ts, so a bug in the resolver (a box dropped, a document
// attributed to the wrong person, a year filter that is too wide) shows up as a difference between the paper and the return.
//
// SERVER SIDE ONLY: the extraction data holds payer names, EINs and addresses. Nothing here is ever sent anywhere; the findings
// built from it carry document ids and amounts only.

import type { RawDocument } from "@/lib/tax2025/resolve-facts";

type Rec = Record<string, unknown>;

export function dataOf(doc: Pick<RawDocument, "extractionData">): Rec {
  const d = (doc.extractionData as { data?: unknown } | null)?.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Rec) : {};
}

export function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function list(v: unknown): Rec[] {
  return Array.isArray(v) ? v.filter((x): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x)) : [];
}

export const YEAR = 2025;

/** Document types that carry income, withholding or deduction amounts onto the return. */
export const AMOUNT_DOC_TYPES: readonly string[] = ["w2", "1099", "mortgage_interest", "form_1098", "property_tax", "k1", "retirement_contribution"];

export function isAmountDoc(d: Pick<RawDocument, "docType">): boolean {
  return AMOUNT_DOC_TYPES.includes(d.docType);
}

/** A document whose extraction finished (or whose re-extraction left usable data) for the tax year. */
export function isUsableFor2025(d: RawDocument): boolean {
  return d.taxYear === YEAR && (d.extractionStatus === "complete" || d.reextractIncomplete === true);
}

/** Why a document of an amount-carrying type is not usable for the 2025 return, or null when it is usable. */
export function unusableReason(d: RawDocument): string | null {
  if (!isAmountDoc(d)) return null;
  if (d.taxYear === null) return "no tax year is assigned to it";
  if (d.taxYear !== YEAR) return null; // another year: not an error
  if (d.extractionStatus !== "complete" && d.reextractIncomplete !== true) return `its extraction is "${d.extractionStatus ?? "not run"}", not complete`;
  return null;
}

/** Signature of a document for duplicate detection; null when the document carries no key amount. Optionally ignores the person. */
export function docSignature(d: RawDocument, opts: { ignorePerson?: boolean } = {}): string | null {
  const data = dataOf(d);
  const person = opts.ignorePerson === true ? "" : d.subjectUserId ?? "";
  const issuer = (k1: string, k2: string): string => (str(data[k1]) ?? str(data[k2]) ?? "").toLowerCase();
  const nums = (keys: string[]): string => keys.map((k) => String(int(data[k]) ?? "")).join("|");
  switch (d.docType) {
    case "w2":
      return ["w2", person, issuer("employerEIN", "employerName"), nums(["wagesCents", "federalWithheldCents", "socialSecurityWagesCents", "medicareWagesCents"])].join("|");
    case "1099": {
      const amounts = Object.keys(data)
        .filter((k) => k.endsWith("Cents") && int(data[k]) !== null)
        .sort()
        .map((k) => `${k}=${String(data[k])}`)
        .join(",");
      if (amounts === "") return null;
      return ["1099", person, issuer("payerEIN", "payerName"), str(data["formVariant"]) ?? "", amounts].join("|");
    }
    case "mortgage_interest":
    case "form_1098":
      return int(data["interestCents"]) === null ? null : ["1098", issuer("servicerName", "servicerName"), nums(["interestCents", "principalBalanceCents"]), (str(data["propertyAddress"]) ?? "").toLowerCase()].join("|");
    case "property_tax":
      return int(data["totalTaxBilledCents"]) === null && int(data["paidInTaxYearCents"]) === null
        ? null
        : ["property_tax", issuer("jurisdictionName", "jurisdictionName"), (str(data["propertyAddress"]) ?? "").toLowerCase(), str(data["parcelId"]) ?? "", str(data["taxType"]) ?? "", nums(["totalTaxBilledCents", "paidInTaxYearCents"])].join("|");
    default:
      return null;
  }
}

/** Usable 2025 documents of one type with exact duplicates removed (the verified copy, else the first, is kept). */
export function uniqueDocs(docs: readonly RawDocument[], docType: string | readonly string[], opts: { ignorePerson?: boolean } = {}): RawDocument[] {
  const types = typeof docType === "string" ? [docType] : docType;
  const kept = new Map<string, RawDocument>();
  const out: RawDocument[] = [];
  for (const d of docs) {
    if (!types.includes(d.docType) || !isUsableFor2025(d)) continue;
    const sig = docSignature(d, opts);
    if (sig === null) {
      out.push(d);
      continue;
    }
    const prev = kept.get(sig);
    if (prev === undefined) {
      kept.set(sig, d);
      out.push(d);
    } else if (!prev.verified && d.verified) {
      kept.set(sig, d);
      out.splice(out.indexOf(prev), 1, d);
    }
  }
  return out;
}

/** Whole-dollar sum of cents values: null when any value is null (a box that was not read cannot be summed). */
export function sumCents(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}
