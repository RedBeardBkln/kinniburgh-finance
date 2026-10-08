// Tool: list_documents. Shaper is PURE and unit-tested; the reads are in queries/documents.ts, which never selects an extraction value column.
// The row id is returned so get_document_values can be called for a document whose values are readable.

import { z } from "zod";
import { LIMITS, loadAdvisorConfig } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadDocumentCounts, loadDocumentList, type DocumentCountRow, type DocumentListRow } from "@/lib/advisor/queries/documents";
import { safeDescriptive, safeField } from "@/lib/advisor/scrub";
import { isoDay } from "@/lib/advisor/tools/format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import { schemaTypeForDocType } from "@/lib/tax-extraction-schema";

const DEFAULT_LIMIT = 25;
const MAX_COUNT_GROUPS = 40;

const schema = z
  .object({
    year: optional(z.number().int().min(2000).max(2100)),
    entity: optional(shortText),
    doc_type: optional(z.string().trim().regex(/^[a-z0-9_]{1,40}$/)),
    limit: optional(z.number().int().min(1).max(40)),
  })
  .strict();
type Input = z.output<typeof schema>;

/** A document's values can be read only when its type has a tax schema and it is not a linked insurance-policy document. */
export function valuesReadable(docType: string, insurancePolicy: { id: string } | null): boolean {
  return schemaTypeForDocType(docType) !== null && insurancePolicy === null;
}

/**
 * With TAX_REVIEW_PAYER_NAMES=generic the document name (auto-generated from the parsed payer / employer) and the issuer are hidden: the name
 * becomes the document type and year.
 */
export function genericDocumentName(docType: string, taxYear: number | null): string {
  return safeField(`${docType}${taxYear !== null ? ` ${taxYear}` : ""}`, 60);
}

function subjectOf(s: string | null): "person" | "joint" | "unassigned" {
  return s === "person" ? "person" : s === "joint" ? "joint" : "unassigned";
}

export function shapeDocuments(rows: readonly DocumentListRow[], counts: readonly DocumentCountRow[], opts: { payerNames: "keep" | "generic" } = { payerNames: "keep" }): ToolOutput {
  const shaped = rows.map((d) => ({
    id: d.id,
    name: opts.payerNames === "generic" ? genericDocumentName(d.docType, d.taxYear) : safeDescriptive(d.documentName, 80),
    doc_type: safeField(d.docType, 40),
    tax_year: d.taxYear,
    entity: safeField(d.entity.name, 80),
    extraction_status: d.extractionStatus === null ? null : safeField(d.extractionStatus, 30),
    verified: d.extractionConfirmedAt !== null,
    values_readable: valuesReadable(d.docType, d.insurancePolicy),
    subject: subjectOf(d.subjectType),
    issuer: d.issuerName === null || opts.payerNames === "generic" ? null : safeDescriptive(d.issuerName, 60),
    added: isoDay(d.createdAt),
  }));
  const countRows = [...counts]
    .sort((a, b) => (a.docType < b.docType ? -1 : a.docType > b.docType ? 1 : (a.extractionStatus ?? "") < (b.extractionStatus ?? "") ? -1 : 1))
    .slice(0, MAX_COUNT_GROUPS)
    .map((c) => ({ doc_type: safeField(c.docType, 40), extraction_status: c.extractionStatus === null ? null : safeField(c.extractionStatus, 30), count: c.count }));
  const total = counts.reduce((n, c) => n + c.count, 0);
  return {
    data: {
      rows: shaped,
      counts_by_type: countRows,
      notes: [
        "verified means the owner marked the extracted values as checked; otherwise any values are an unverified AI read. values_readable=true means get_document_values can return this document's amounts and dates.",
      ],
    },
    rows: shaped.length,
    total,
    links: [links.documents()],
  };
}

export const listDocumentsTool = defineTool<Input>({
  name: "list_documents",
  description:
    "Lists uploaded documents, newest first: id, name, type, tax year, entity, extraction status, whether the owner verified the extracted values, whether get_document_values can read them, who the document is for and the issuer, plus counts by type and status. Filters: year, entity (name or slug), doc_type (for example w2, 1099, k1, property_tax, mortgage_interest, bank_statement, other). limit is 1 to 40, default 25. It never returns file contents or extracted values.",
  inputJsonSchema: {
    type: "object",
    properties: {
      year: { type: "integer", description: "Optional. Tax year to filter by, for example 2025." },
      entity: { type: "string", description: "Optional. Entity name or slug to restrict to." },
      doc_type: { type: "string", description: "Optional. Document type, for example w2, 1099, k1, property_tax, mortgage_interest, bank_statement, other." },
      limit: { type: "integer", description: "Optional. Documents to list, 1 to 40. Default 25." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up documents",
  summarizeArgs: (i) => `year=${i.year ?? "any"}, type=${i.doc_type === undefined ? "any" : "set"}, entity=${i.entity === undefined ? "all" : "set"}, limit ${i.limit ?? DEFAULT_LIMIT}`,
  run: async (_ctx, i) => {
    const filter = { ...(i.year !== undefined ? { year: i.year } : {}), ...(i.entity !== undefined ? { entity: i.entity } : {}), ...(i.doc_type !== undefined ? { docType: i.doc_type } : {}) };
    const [rows, counts] = await Promise.all([loadDocumentList(filter, i.limit ?? DEFAULT_LIMIT), loadDocumentCounts(filter)]);
    return shapeDocuments(rows, counts, { payerNames: loadAdvisorConfig().payerNames });
  },
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
