import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentUploadForm } from "@/components/documents/document-upload-form";
import { listDocuments, getDocumentSignedUrl, archiveDocument } from "@/actions/documents";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  searchParams: Promise<{ entityId?: string; year?: string; docType?: string }>;
}

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
  mortgage_interest: "Mortgage Interest",
  policy: "Policy",
  statement: "Statement",
  other: "Other",
};

const EXTRACTION_TYPES = new Set([
  "bank_statement", "mortgage_statement", "insurance_policy", "utility_bill", "tax_return",
]);

const EXTRACTION_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending:    { label: "Pending", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  processing: { label: "Processing", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  complete:   { label: "Extracted", cls: "bg-green-50 text-green-700 border-green-200" },
  failed:     { label: "Failed", cls: "bg-red-50 text-red-700 border-red-200" },
  skipped:    { label: "Skipped", cls: "bg-muted text-muted-foreground border-border" },
};

const DOC_TYPE_COLORS: Record<string, string> = {
  w2: "bg-blue-50 text-blue-700 border-blue-200",
  "1099": "bg-purple-50 text-purple-700 border-purple-200",
  k1: "bg-indigo-50 text-indigo-700 border-indigo-200",
  extension: "bg-amber-50 text-amber-700 border-amber-200",
  property_tax: "bg-orange-50 text-orange-700 border-orange-200",
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
    select: { id: true, name: true },
  });

  const docs = await listDocuments({
    entityId: sp.entityId,
    taxYear: sp.year ? Number(sp.year) : undefined,
    docType: sp.docType,
  });

  const availableYears = Array.from(
    new Set(docs.map((d) => d.taxYear).filter(Boolean) as number[])
  ).sort((a, b) => b - a);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Document Vault</h1>
          <p className="text-sm text-muted-foreground">
            Tax documents, policies, and statements. Documents are never deleted — archive only.
          </p>
        </div>

        <DocumentUploadForm entities={entities} />

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <FilterLink href="/documents" active={!sp.entityId && !sp.year && !sp.docType} label="All" />
          {entities.map((e) => (
            <FilterLink
              key={e.id}
              href={`/documents?entityId=${e.id}` as Route}
              active={sp.entityId === e.id}
              label={(e.name.split(",")[0] ?? e.name).replace(" Property Management", "").replace(" Consulting", "")}
            />
          ))}
          {availableYears.map((y) => (
            <FilterLink
              key={y}
              href={`/documents?year=${y}` as Route}
              active={sp.year === String(y)}
              label={String(y)}
            />
          ))}
        </div>

        {/* Document table */}
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Entity</th>
                  <th className="px-4 py-3 font-medium">Year</th>
                  <th className="px-4 py-3 font-medium">Notes</th>
                  <th className="px-4 py-3 font-medium">Extraction</th>
                  <th className="px-4 py-3 font-medium">Uploaded</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      No documents yet. Upload one above.
                    </td>
                  </tr>
                )}
                {docs.map((doc) => {
                  const extractable = EXTRACTION_TYPES.has(doc.docType);
                  const statusInfo = doc.extractionStatus ? EXTRACTION_STATUS_BADGE[doc.extractionStatus] : null;
                  return (
                    <tr key={doc.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2">
                        <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${DOC_TYPE_COLORS[doc.docType] ?? DOC_TYPE_COLORS.other}`}>
                          {DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {doc.entity.name.split(",")[0]}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {doc.taxYear ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground max-w-xs truncate">
                        {doc.notes ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {extractable ? (
                          statusInfo ? (
                            <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${statusInfo.cls}`}>
                              {statusInfo.label}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {doc.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2 justify-end">
                          {extractable && (
                            <Link
                              href={`/documents/${doc.id}/review` as Route}
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
            </table>
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
