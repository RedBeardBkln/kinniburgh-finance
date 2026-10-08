// Extraction VALUE read for get_document_values: the ONLY advisor file allowed to select the extraction columns (exclusions.ts ALLOWED_RAW_USES).
//
// Rules this file keeps (pinned by advisor-exclusions.test.ts):
//   - the raw columns are named only inside a `select: { ... }` block;
//   - every row goes through resolveTaxDocForCompute (the same policy-aware reader the Forms page uses: owner corrections win over the AI
//     read, and the result says whether the values are verified), and only that RESOLVED view leaves this file;
//   - nothing here iterates the extraction object or serializes it. Which fields may be returned is decided later, by the typed registry
//     allowlist in tools/document-fields.ts; the stored JSON's own keys never become output.
// A document with no tax schema, or one linked to an insurance policy, never leaves this file (the same "not available" answer as a missing id).

import { db } from "@/lib/db";
import { TAX_EXTRACTION_POLICY, resolveTaxDocForCompute, type TaxDocRowInput, type TaxExtractionPolicy } from "@/lib/tax-extraction-policy";
import { schemaTypeForDocType, type TaxSchemaDocType } from "@/lib/tax-extraction-schema";

/** One document as the shaper sees it: provenance flags and the effective values object (untrusted shape). */
export interface DocumentValuesRow {
  id: string;
  docType: string;
  schemaType: TaxSchemaDocType;
  taxYear: number | null;
  name: string | null;
  entity: string;
  status: string | null;
  verified: boolean;
  correctedCount: number;
  legacyFormat: boolean;
  reextractIncomplete: boolean;
  /** `verified_only` policy took an unverified document out: `data` is null and the shaper says why. */
  excludedByPolicy: boolean;
  /** The effective `data` object (owner corrections over the AI read), or null. Only registry keys are ever read from it. */
  data: unknown;
}

/** The row shape the select below returns (the extraction columns come from TaxDocRowInput). */
export type RawDocumentRow = TaxDocRowInput & {
  id: string;
  taxYear: number | null;
  documentName: string | null;
  entity: { name: string };
  insurancePolicy: { id: string } | null;
};

/** PURE: gate + resolve one row. null = not available (no tax schema, or linked to an insurance policy). */
export function resolveDocumentRow(row: RawDocumentRow, policy: TaxExtractionPolicy = TAX_EXTRACTION_POLICY): DocumentValuesRow | null {
  const schemaType = schemaTypeForDocType(row.docType);
  if (schemaType === null || row.insurancePolicy !== null) return null;
  const resolved = resolveTaxDocForCompute(row, policy);
  const effective = resolved.extractionData;
  const data = effective !== null && typeof effective === "object" ? (effective as { data?: unknown }).data : undefined;
  return {
    id: row.id,
    docType: row.docType,
    schemaType,
    taxYear: row.taxYear,
    name: row.documentName,
    entity: row.entity.name,
    status: row.extractionStatus,
    verified: resolved.verified,
    correctedCount: resolved.correctedKeys.length,
    legacyFormat: resolved.legacyFormat,
    reextractIncomplete: resolved.reextractIncomplete,
    excludedByPolicy: resolved.excludedByPolicy,
    data: resolved.excludedByPolicy ? null : (data ?? null),
  };
}

export const DOCUMENT_VALUES_MAX_IDS = 5;

export async function loadDocumentValues(ids: readonly string[], policy: TaxExtractionPolicy = TAX_EXTRACTION_POLICY): Promise<DocumentValuesRow[]> {
  const rows = await db.document.findMany({
    where: { id: { in: [...ids] }, archivedAt: null },
    take: DOCUMENT_VALUES_MAX_IDS,
    select: {
      id: true,
      docType: true,
      taxYear: true,
      documentName: true,
      extractionStatus: true,
      extractionData: true,
      extractionCorrections: true,
      extractionConfirmedAt: true,
      entity: { select: { name: true } },
      insurancePolicy: { select: { id: true } },
    },
  });
  return rows.map((r) => resolveDocumentRow(r, policy)).filter((r): r is DocumentValuesRow => r !== null);
}
