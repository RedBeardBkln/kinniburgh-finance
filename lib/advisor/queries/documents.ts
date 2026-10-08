// Document LIST reads for the assistant. DB-aware, explicit select only. This file never selects an extraction value column (the extracted
// data and the owner corrections), a file key, the metadata JSON, the notes or an error text: the list shows what exists and whether its values
// are readable. The ONLY advisor file that may read extraction values is queries/document-values.ts.

import { db } from "@/lib/db";

export interface DocumentListRow {
  id: string;
  documentName: string | null;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  extractionConfirmedAt: Date | null;
  subjectType: string | null;
  issuerName: string | null;
  createdAt: Date;
  entity: { name: string };
  /** Only used to compute a boolean; the policy id itself is never returned. */
  insurancePolicy: { id: string } | null;
}

export interface DocumentCountRow {
  docType: string;
  extractionStatus: string | null;
  count: number;
}

export interface DocumentFilter {
  year?: number;
  entity?: string;
  docType?: string;
}

function whereOf(f: DocumentFilter) {
  return {
    archivedAt: null,
    ...(f.year !== undefined ? { taxYear: f.year } : {}),
    ...(f.docType !== undefined ? { docType: f.docType } : {}),
    ...(f.entity !== undefined
      ? { entity: { OR: [{ name: { equals: f.entity, mode: "insensitive" as const } }, { slug: { equals: f.entity, mode: "insensitive" as const } }] } }
      : {}),
  };
}

export async function loadDocumentList(f: DocumentFilter, take: number): Promise<DocumentListRow[]> {
  return db.document.findMany({
    where: whereOf(f),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take,
    select: {
      id: true,
      documentName: true,
      docType: true,
      taxYear: true,
      extractionStatus: true,
      extractionConfirmedAt: true,
      subjectType: true,
      issuerName: true,
      createdAt: true,
      entity: { select: { name: true } },
      insurancePolicy: { select: { id: true } },
    },
  });
}

export async function loadDocumentCounts(f: DocumentFilter): Promise<DocumentCountRow[]> {
  const groups = await db.document.groupBy({ by: ["docType", "extractionStatus"], where: whereOf(f), _count: { _all: true } });
  return groups.map((g) => ({ docType: g.docType, extractionStatus: g.extractionStatus, count: g._count._all }));
}
