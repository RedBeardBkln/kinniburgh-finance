"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requestDocumentUploadSlot, finalizeDocumentUpload } from "@/actions/documents";
import { validateDocumentFile } from "@/lib/document-upload";
import { uploadTaxFile, type TaxDocType } from "@/components/tax/tax-document-upload";
import { summarizeUploadBatch } from "@/lib/tax-doc-batch";
import { MIN_TAX_YEAR, isValidPriorYear } from "@/lib/tax-year-range";
import {
  ISSUER_MAX_LENGTH,
  attributionLabel,
  isTaxDocType,
  selectValueToSubject,
  type PersonRef,
} from "@/lib/document-attribution";

const DOC_TYPES = [
  { value: "bank_statement", label: "Bank Statement (AI extraction)" },
  { value: "mortgage_statement", label: "Mortgage Statement (AI extraction)" },
  { value: "insurance_policy", label: "Insurance Policy (AI extraction)" },
  { value: "utility_bill", label: "Utility Bill (AI extraction)" },
  { value: "tax_return", label: "Tax return / prior-year filing (AI extraction)" },
  { value: "w2", label: "W-2" },
  { value: "1099", label: "1099" },
  { value: "k1", label: "K-1" },
  { value: "extension", label: "Extension" },
  { value: "property_tax", label: "Property Tax" },
  { value: "donation_receipt", label: "Donation receipt / acknowledgment (AI extraction)" },
  { value: "mortgage_interest", label: "Mortgage Interest (1098)" },
  { value: "policy", label: "Insurance Policy (manual)" },
  { value: "statement", label: "Bank/Account Statement (manual)" },
  { value: "other", label: "Other" },
] as const;

interface Entity {
  id: string;
  name: string;
}

interface Props {
  entities: Entity[];
  /** Entity preselected in the picker (the page passes Personal). */
  defaultEntityId?: string;
  /** Household members (id + name only) for the "Pertains to" picker. */
  people?: PersonRef[];
}

export function DocumentUploadForm({ entities, defaultEntityId, people = [] }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [entityId, setEntityId] = useState(defaultEntityId || entities[0]?.id || "");
  const [subjectValue, setSubjectValue] = useState("");
  const [issuer, setIssuer] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [docType, setDocType] = useState("other");
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Select a file"); return; }

    const precheck = validateDocumentFile(file.type, file.size);
    if (!precheck.ok) { setError(precheck.error); return; }

    setError(null);
    setMessage(null);

    const { subjectType, subjectUserId } = selectValueToSubject(subjectValue);
    const issuerName = issuer.trim() || null;

    // Tax docTypes go through the existing tax upload path (taxes bucket,
    // inline extraction, auto naming, validated year) instead of the vault
    // path, so a W-2/1099/1098/K-1/return uploaded here is parsed and feeds
    // the tax forms exactly like one uploaded from the Tax tab.
    if (isTaxDocType(docType)) {
      const year = Number(taxYear);
      if (!taxYear || !isValidPriorYear(year, new Date().getFullYear())) {
        setError(`Enter the tax year this document covers (${MIN_TAX_YEAR} or later).`);
        return;
      }
      startTransition(async () => {
        const result = await uploadTaxFile(file, entityId, year, docType as TaxDocType, notes.trim() || undefined, {
          subjectType,
          subjectUserId,
          issuerName,
        });
        if (!result.success) {
          setError(result.error);
          return;
        }
        // Honest about extraction: it is skipped for extensions and may fail.
        const note =
          docType !== "extension" && !result.extraction
            ? " Parsing failed or was skipped - use Retry in the Extraction column."
            : "";
        setMessage(summarizeUploadBatch([result]) + note);
        router.refresh();
        if (fileRef.current) fileRef.current.value = "";
        setNotes("");
        setIssuer("");
      });
      return;
    }

    startTransition(async () => {
      try {
        const slot = await requestDocumentUploadSlot({
          entityId,
          fileType: file.type,
          fileSize: file.size,
        });
        if (!slot.ok) throw new Error(slot.error);

        const putRes = await fetch(slot.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(`Upload to storage failed (status ${putRes.status})`);
        }

        const finalized = await finalizeDocumentUpload({
          documentId: slot.documentId,
          fileKey: slot.fileKey,
          entityId,
          fileType: file.type,
          docType: docType as (typeof DOC_TYPES)[number]["value"],
          taxYear: taxYear ? Number(taxYear) : undefined,
          notes: notes.trim() || undefined,
          subjectType,
          subjectUserId,
          issuerName,
        });
        if (!finalized.ok) throw new Error(finalized.error);

        router.refresh();
        if (fileRef.current) fileRef.current.value = "";
        setNotes("");
        setIssuer("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Upload Document</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">Bucket</label>
            <select
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Document type</label>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {DOC_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              Tax year{" "}
              <span className="text-muted-foreground font-normal">
                {isTaxDocType(docType) ? "required" : "optional"}
              </span>
            </label>
            <Input
              type="number"
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
              placeholder="2025"
              min={2000}
              max={2099}
              className="h-9"
            />
            {docType === "tax_return" && (
              <p className="text-xs text-muted-foreground">
                Tax year = the year the return covers (e.g. 2023 for the return filed in 2024).
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Pertains to</label>
            <select
              value={subjectValue}
              onChange={(e) => setSubjectValue(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Unassigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value="joint">
                {attributionLabel({ subjectType: "joint", subjectUser: null }, people).label}
              </option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              Issuer / payer <span className="text-muted-foreground font-normal">optional</span>
            </label>
            <Input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              maxLength={ISSUER_MAX_LENGTH}
              placeholder="e.g. Alpine Bio (employer on a W-2)"
              className="h-9"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Notes <span className="text-muted-foreground font-normal">optional</span></label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Fidelity brokerage 1099-DIV"
              className="h-9"
            />
          </div>

          <div className="space-y-1 sm:col-span-2">
            <label className="text-sm font-medium">File <span className="text-muted-foreground font-normal">(PDF, JPEG, PNG, WebP — max 20MB)</span></label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
          </div>
        </div>

        {message && (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
            {message}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          onClick={handleUpload}
          disabled={isPending}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
        >
          {isPending ? (isTaxDocType(docType) ? "Uploading & parsing…" : "Uploading…") : "Upload Document"}
        </button>
      </CardContent>
    </Card>
  );
}
