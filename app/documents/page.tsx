import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentUploadForm } from "@/components/documents/document-upload-form";
import { listDocuments, getDocumentSignedUrl, archiveDocument } from "@/actions/documents";
import { DocumentAttributionCells } from "@/components/documents/document-attribution-editor";
import { ResizableTable, type ResizableColumn } from "@/components/documents/resizable-table";
import { isTaxDocType, suggestIssuerFromExtraction } from "@/lib/document-attribution";
import { buildExtractionOverview } from "@/lib/document-extraction-state";
import { ExtractionCell } from "@/components/documents/extraction-cell";
import { DocumentTypeCell } from "@/components/documents/document-type-cell";
import { ExtractionBulkBar } from "@/components/documents/extraction-bulk-bar";
import { FillMissingYearsBar } from "@/components/documents/fill-missing-years-bar";
import { planYearFill } from "@/lib/document-year";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  searchParams: Promise<{
    entityId?: string;
    year?: string;
    docType?: string;
    /** "tax" = the Tax documents view; "all" = explicitly everything. */
    view?: string;
    /** The Taxes sidebar sends ?bucket=taxes; that defaults to the tax view. */
    bucket?: string;
  }>;
}

// Starting widths (px) for the drag-to-resize table; the last column (row
// actions) has no width of its own and fills whatever space is left.
const DOCUMENT_TABLE_COLUMNS: ResizableColumn[] = [
  { key: "type", label: "Document Type", defaultWidth: 125 },
  { key: "name", label: "Document Name", defaultWidth: 210 },
  { key: "bucket", label: "Bucket", defaultWidth: 95 },
  { key: "pertains", label: "Pertains to", defaultWidth: 120 },
  { key: "issuer", label: "Issuer / payer", defaultWidth: 190 },
  { key: "year", label: "Year", defaultWidth: 90 },
  { key: "extraction", label: "Extraction", defaultWidth: 200 },
  { key: "uploaded", label: "Uploaded", defaultWidth: 105 },
  { key: "actions", label: "", defaultWidth: 0 },
];

const DOC_TYPE_LABELS: Record<string, string> = {
  bank_statement: "Bank Statement",
  mortgage_statement: "Mortgage Statement",
  insurance_policy: "Insurance Policy",
  utility_bill: "Utility Bill",
  tax_return: "Tax Return",
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  extension: "Extension",
  property_tax: "Property Tax",
  donation_receipt: "Donation Receipt",
  mortgage_interest: "Mortgage Interest",
  policy: "Policy",
  statement: "Statement",
  other: "Other",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  w2: "bg-blue-50 text-blue-700 border-blue-200",
  "1099": "bg-purple-50 text-purple-700 border-purple-200",
  k1: "bg-indigo-50 text-indigo-700 border-indigo-200",
  extension: "bg-amber-50 text-amber-700 border-amber-200",
  property_tax: "bg-orange-50 text-orange-700 border-orange-200",
  donation_receipt: "bg-rose-50 text-rose-700 border-rose-200",
  mortgage_interest: "bg-cyan-50 text-cyan-700 border-cyan-200",
  policy: "bg-teal-50 text-teal-700 border-teal-200",
  statement: "bg-gray-50 text-gray-700 border-gray-200",
  other: "bg-muted text-muted-foreground border-border",
};

export default async function DocumentsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const sp = await searchParams;

  const entities = await db.entity.findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true, type: true },
  });
  // Household members for attribution — id + name only (never email/hash/TOTP).
  const people = await db.user.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  // Tax view: explicit ?view=tax, or ?bucket=taxes (what the Taxes sidebar
  // sends) when no other filter/view was chosen. ?view=all always shows everything.
  const taxView =
    sp.view === "tax" ||
    (sp.bucket === "taxes" && !sp.view && !sp.entityId && !sp.year && !sp.docType);

  const allDocs = await listDocuments({
    entityId: sp.entityId,
    taxYear: sp.year ? Number(sp.year) : undefined,
    docType: sp.docType,
  });
  const docs = taxView && !sp.docType ? allDocs.filter((d) => isTaxDocType(d.docType)) : allDocs;

  // Honest extraction state for EVERY row (pure; no DB, no AI call). Rendering
  // this page never starts an extraction: Run/Retry/bulk are button clicks only.
  const { displayById: extractionById, plan: bulkPlan } = buildExtractionOverview(docs);
  const docNames = Object.fromEntries(
    docs.map((d) => [d.id, d.documentName ?? d.notes ?? DOC_TYPE_LABELS[d.docType] ?? d.docType])
  );

  // Yearless documents whose stored extraction says a year: drives the "fill in
  // missing years" control. Whole vault (independent of the filters/view above);
  // read-only here, the write is the user-confirmed fillMissingDocumentYears action.
  const yearlessDocs = await db.document.findMany({
    where: { archivedAt: null, taxYear: null },
    select: { id: true, docType: true, extractionData: true, extractionCorrections: true, extractionConfirmedAt: true },
  });
  const fillableYears = planYearFill(yearlessDocs).fills.length;

  // Default upload bucket is Personal, not alphabetical-first.
  const defaultEntityId =
    (entities.find((e) => e.slug === "personal") ?? entities.find((e) => e.type === "personal") ?? entities[0])?.id ?? "";

  // Chip links keep the bucket param so the Taxes tab stays active.
  const keepBucket: Record<string, string> = sp.bucket ? { bucket: sp.bucket } : {};
  const chipHref = (params: Record<string, string>): Route => {
    const qs = new URLSearchParams({ ...params, ...keepBucket }).toString();
    return (qs ? `/documents?${qs}` : "/documents") as Route;
  };
  const noFilter = !sp.entityId && !sp.year && !sp.docType;

  const availableYears = Array.from(
    new Set(docs.map((d) => d.taxYear).filter(Boolean) as number[])
  ).sort((a, b) => b - a);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Document Vault</h1>
          <p className="text-sm text-muted-foreground">
            Tax documents, policies, and statements. Each document shows who it pertains to and its
            issuer. Documents are never deleted — archive only.
          </p>
        </div>

        <DocumentUploadForm
          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
          defaultEntityId={defaultEntityId}
          people={people}
        />

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <FilterLink href={chipHref({ view: "all" })} active={!taxView && noFilter} label="All" />
          <FilterLink href={chipHref({ view: "tax" })} active={taxView && !sp.docType} label="Tax documents" />
          <FilterLink
            href={chipHref({ docType: "tax_return" })}
            active={sp.docType === "tax_return"}
            label="Prior-year returns"
          />
          <FilterLink
            href={chipHref({ docType: "donation_receipt" })}
            active={sp.docType === "donation_receipt"}
            label="Donation receipts"
          />
          {entities.map((e) => (
            <FilterLink
              key={e.id}
              href={chipHref({ entityId: e.id })}
              active={sp.entityId === e.id}
              label={(e.name.split(",")[0] ?? e.name).replace(" Property Management", "").replace(" Consulting", "")}
            />
          ))}
          {availableYears.map((y) => (
            <FilterLink
              key={y}
              href={chipHref(taxView ? { view: "tax", year: String(y) } : { year: String(y) })}
              active={sp.year === String(y)}
              label={String(y)}
            />
          ))}
        </div>

        {/* Fill missing years from already-extracted data: user-initiated, no AI calls. */}
        <FillMissingYearsBar count={fillableYears} />

        {/* Bulk extraction: user-initiated only, counted, capped, concurrency-limited. */}
        <ExtractionBulkBar mode="missing" ids={bulkPlan.missing} names={docNames} />
        <ExtractionBulkBar
          mode="outdated"
          ids={bulkPlan.outdated}
          names={docNames}
          needIndividual={bulkPlan.needIndividual}
        />

        {/* Document table */}
        <Card>
          <CardContent className="p-0">
            <ResizableTable columns={DOCUMENT_TABLE_COLUMNS} storageKey="documents-table-column-widths-v3">
              <tbody>
                {docs.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                      No documents yet. Upload one above.
                    </td>
                  </tr>
                )}
                {docs.map((doc) => {
                  const extraction = extractionById[doc.id];
                  return (
                    <tr key={doc.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2">
                        <DocumentTypeCell
                          documentId={doc.id}
                          docType={doc.docType}
                          label={DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                          badgeClass={DOC_TYPE_COLORS[doc.docType] ?? DOC_TYPE_COLORS.other!}
                          extractionKind={extraction?.kind ?? null}
                        />
                      </td>
                      {/* Falls back to the legacy upload note for documents that
                          have no generated name, so nothing previously visible is lost. */}
                      <td
                        className="px-4 py-2 text-xs truncate"
                        title={doc.documentName ?? doc.notes ?? undefined}
                      >
                        {doc.documentName ?? doc.notes ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {doc.entity.name.split(",")[0]}
                      </td>
                      <DocumentAttributionCells
                        documentId={doc.id}
                        subjectType={doc.subjectType}
                        subjectUserId={doc.subjectUserId}
                        issuerName={doc.issuerName}
                        suggestedIssuer={suggestIssuerFromExtraction(doc.docType, doc.extractionData)}
                        people={people}
                      />
                      <td className="px-4 py-2 text-xs">
                        {doc.taxYear ?? (
                          <span className="whitespace-nowrap rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                            No year
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {extraction ? (
                          <ExtractionCell documentId={doc.id} display={extraction} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {doc.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2 justify-end">
                          {extraction?.actions.includes("review") && (
                            // prefetch={false} — see the matching comment in
                            // components/bank-statements/statements-table.tsx;
                            // this route's render can trigger a real
                            // non-idempotent AI extraction call as a side effect.
                            <Link
                              href={`/documents/${doc.id}/review` as Route}
                              prefetch={false}
                              className="text-xs text-primary hover:underline"
                            >
                              Review
                            </Link>
                          )}
                          <ViewLink documentId={doc.id} />
                          <ArchiveButton documentId={doc.id} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </ResizableTable>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function FilterLink({ href, active, label }: { href: Route | "/documents"; active: boolean; label: string }) {
  return (
    <a
      href={href}
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground border-border hover:bg-accent"
      }`}
    >
      {label}
    </a>
  );
}

async function ViewLink({ documentId }: { documentId: string }) {
  const url = await getDocumentSignedUrl(documentId);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-primary hover:underline"
    >
      View
    </a>
  );
}

function ArchiveButton({ documentId }: { documentId: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await archiveDocument(documentId);
      }}
    >
      <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
        Archive
      </button>
    </form>
  );
}
