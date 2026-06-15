"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { uploadDocument } from "@/actions/documents";

const DOC_TYPES = [
  { value: "bank_statement", label: "Bank Statement (AI extraction)" },
  { value: "mortgage_statement", label: "Mortgage Statement (AI extraction)" },
  { value: "insurance_policy", label: "Insurance Policy (AI extraction)" },
  { value: "utility_bill", label: "Utility Bill (AI extraction)" },
  { value: "tax_return", label: "Tax Return (AI extraction)" },
  { value: "w2", label: "W-2" },
  { value: "1099", label: "1099" },
  { value: "k1", label: "K-1" },
  { value: "extension", label: "Extension" },
  { value: "property_tax", label: "Property Tax" },
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
}

export function DocumentUploadForm({ entities }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [docType, setDocType] = useState("other");
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Select a file"); return; }
    setError(null);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("entityId", entityId);
    fd.append("docType", docType);
    if (taxYear) fd.append("taxYear", taxYear);
    if (notes.trim()) fd.append("notes", notes.trim());

    startTransition(async () => {
      try {
        await uploadDocument(fd);
        router.refresh();
        if (fileRef.current) fileRef.current.value = "";
        setNotes("");
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
            <label className="text-sm font-medium">Entity</label>
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
            <label className="text-sm font-medium">Tax year <span className="text-muted-foreground font-normal">optional</span></label>
            <Input
              type="number"
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
              placeholder="2025"
              min={2000}
              max={2099}
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

        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          onClick={handleUpload}
          disabled={isPending}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
        >
          {isPending ? "Uploading…" : "Upload Document"}
        </button>
      </CardContent>
    </Card>
  );
}
