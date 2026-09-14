"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  uploadBankStatement,
  uploadBankStatementsBatch,
  type BatchUploadItemResult,
} from "@/actions/bank-statements";
import type { ExtractedStatement } from "@/lib/bank-statement-extract";

interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
}

interface Props {
  entityId: string;
  accounts: AccountOption[];
}

const ACCEPT_ATTR = "application/pdf,image/jpeg,image/png,image/webp";
const ACCEPTED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];

function isAcceptedFile(file: File): boolean {
  if (file.type && ACCEPT_ATTR.includes(file.type)) return true;
  const lower = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function StatementUploadForm({ entityId, accounts }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [accountId, setAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [singleResult, setSingleResult] = useState<{ extraction: ExtractedStatement | null } | null>(null);
  const [batchResults, setBatchResults] = useState<BatchUploadItemResult[] | null>(null);
  const [singleFile, setSingleFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [isPending, startTransition] = useTransition();

  const pendingFiles: File[] = mode === "single"
    ? singleFile
      ? [singleFile]
      : []
    : folderFiles;

  function resetInputs() {
    if (fileRef.current) fileRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
    setSingleFile(null);
    setFolderFiles([]);
    setNotes("");
  }

  function handleSingleUpload() {
    if (!singleFile) { setError("Select a file"); return; }
    const file = singleFile;
    setError(null);
    setSingleResult(null);
    setBatchResults(null);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("entityId", entityId);
    if (accountId) fd.append("accountId", accountId);
    if (notes.trim()) fd.append("notes", notes.trim());

    startTransition(async () => {
      try {
        const res = await uploadBankStatement(fd);
        setSingleResult({ extraction: res.extraction });
        router.refresh();
        resetInputs();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      }
    });
  }

  function handleBatchUpload() {
    const files = folderFiles;
    if (files.length === 0) { setError("Select a folder with statement files"); return; }
    setError(null);
    setBatchResults(null);
    setSingleResult(null);

    const fd = new FormData();
    for (const file of files) fd.append("files", file);
    fd.append("entityId", entityId);
    if (accountId) fd.append("accountId", accountId);
    if (notes.trim()) fd.append("notes", notes.trim());

    startTransition(async () => {
      try {
        const results = await uploadBankStatementsBatch(fd);
        setBatchResults(results);
        router.refresh();
        resetInputs();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      }
    });
  }

  const okCount = batchResults?.filter((r) => r.ok).length ?? 0;
  const failCount = batchResults ? batchResults.length - okCount : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Upload Bank Statements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Mode toggle */}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => { setMode("single"); setError(null); setBatchResults(null); setSingleResult(null); }}
            className={`rounded-md px-3 py-1.5 text-xs border ${
              mode === "single"
                ? "bg-primary text-primary-foreground border-primary"
                : "border-input bg-background hover:bg-accent"
            }`}
          >
            Single statement
          </button>
          <button
            type="button"
            onClick={() => { setMode("batch"); setError(null); setBatchResults(null); setSingleResult(null); }}
            className={`rounded-md px-3 py-1.5 text-xs border ${
              mode === "batch"
                ? "bg-primary text-primary-foreground border-primary"
                : "border-input bg-background hover:bg-accent"
            }`}
          >
            Folder / multiple
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">
              Linked account <span className="text-muted-foreground font-normal">optional</span>
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Auto-match by last 4 digits</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname}{a.mask ? ` (···${a.mask})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">
              Notes <span className="text-muted-foreground font-normal">optional</span>
            </label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. JCSB checking 2023–2025 history"
              className="h-9"
            />
          </div>

          <div className="space-y-1 sm:col-span-2">
            {mode === "single" ? (
              <>
                <label className="text-sm font-medium">
                  File <span className="text-muted-foreground font-normal">(PDF, JPEG, PNG, WebP — max 20MB)</span>
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  onChange={(e) => setSingleFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
                />
              </>
            ) : (
              <>
                <label className="text-sm font-medium">
                  Folder <span className="text-muted-foreground font-normal">(uploads every statement PDF/image inside — up to 100 files)</span>
                </label>
                <input
                  ref={folderRef}
                  type="file"
                  multiple
                  accept={ACCEPT_ATTR}
                  onChange={(e) =>
                    setFolderFiles(e.target.files ? Array.from(e.target.files).filter(isAcceptedFile) : [])
                  }
                  // @ts-expect-error non-standard but widely supported
                  webkitdirectory=""
                  directory=""
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
                />
                <p className="text-xs text-muted-foreground">
                  Tip: to upload files from multiple folders, or hold Ctrl while clicking to pick
                  individual files, use the file browser dialog instead.
                </p>
              </>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {singleResult?.extraction && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {singleResult.extraction.accounts.length > 0 ? (
              <>
                Extracted {singleResult.extraction.accounts.length} account
                {singleResult.extraction.accounts.length === 1 ? "" : "s"}
                {singleResult.extraction.periodStart && singleResult.extraction.periodEnd && (
                  <> · period {singleResult.extraction.periodStart} to {singleResult.extraction.periodEnd}</>
                )}
                . Review and confirm in the statements table below.
              </>
            ) : (
              <>Uploaded, but extraction could not read balances. Open the statement to enter them manually.</>
            )}
          </div>
        )}

        {batchResults && (
          <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs font-medium">
              Uploaded {okCount} of {batchResults.length} files
              {failCount > 0 && <span className="text-destructive"> — {failCount} failed</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              Batch uploads skip AI extraction (speed/cost). Each statement was filed as
              pending — review each row below to enter its period and balances.
            </p>
            {failCount > 0 && (
              <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-destructive">
                {batchResults.filter((r) => !r.ok).map((r) => (
                  <li key={r.fileName}>
                    {r.fileName}: {r.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <button
          onClick={mode === "single" ? handleSingleUpload : handleBatchUpload}
          disabled={isPending}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
        >
          {isPending
            ? mode === "single"
              ? "Uploading & extracting…"
              : `Uploading ${pendingFiles.length} files…`
            : mode === "single"
              ? "Upload Statement"
              : `Upload ${pendingFiles.length || ""} Statement${pendingFiles.length === 1 ? "" : "s"}`}
        </button>
      </CardContent>
    </Card>
  );
}