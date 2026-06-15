"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmDocExtraction, importStatementTransactions } from "@/actions/documents";
import type { ExtractedDocument, TransactionRow } from "@/lib/doc-extract";

interface Props {
  documentId: string;
  extraction: ExtractedDocument;
  entityId: string;
}

function formatCents(cents: unknown): string {
  if (typeof cents !== "number") return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatField(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" && key.toLowerCase().includes("cents")) return formatCents(value);
  if (typeof value === "number" && key.toLowerCase().includes("rate")) return `${(value * 100).toFixed(3)}%`;
  return String(value);
}

export function DocumentReviewClient({ documentId, extraction, entityId }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedRows, setSelectedRows] = useState<Set<number>>(
    new Set(extraction.transactionRows?.map((_, i) => i) ?? [])
  );
  const [accountId, setAccountId] = useState("");
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [saved, setSaved] = useState(false);

  const dataEntries = Object.entries(extraction.data ?? {}).filter(
    ([k]) => !["raw"].includes(k)
  );

  function toggleRow(i: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  function toggleAll() {
    const all = extraction.transactionRows?.length ?? 0;
    setSelectedRows(selectedRows.size === all ? new Set() : new Set(Array.from({ length: all }, (_, i) => i)));
  }

  function handleConfirm() {
    startTransition(async () => {
      await confirmDocExtraction(documentId, extraction as unknown as Record<string, unknown>);
      setSaved(true);
      router.refresh();
    });
  }

  function handleImport() {
    if (!accountId) return;
    startTransition(async () => {
      const result = await importStatementTransactions(documentId, Array.from(selectedRows), accountId);
      setImportResult(result);
    });
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{extraction.summary}</p>
          {extraction.period && (
            <p className="mt-1 text-xs text-muted-foreground">Period: {extraction.period}</p>
          )}
        </CardContent>
      </Card>

      {/* Extracted fields */}
      {dataEntries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Extracted fields</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {dataEntries.map(([key, value]) => (
                  <tr key={key}>
                    <td className="py-2 pr-4 text-xs font-medium text-muted-foreground w-48">
                      {key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
                    </td>
                    <td className="py-2 text-sm">{formatField(key, value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={handleConfirm}
                disabled={isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isPending ? "Saving…" : "Confirm extraction"}
              </button>
              {saved && <span className="text-sm text-green-600">Saved</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transaction rows (bank statements) */}
      {extraction.transactionRows && extraction.transactionRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Transactions ({extraction.transactionRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select transactions to import. Duplicates (matching account, date, amount, and payee) will be skipped automatically.
            </p>

            <div className="space-y-2">
              <label className="text-sm font-medium">Target account</label>
              <input
                type="text"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Account ID (paste from account settings)"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30 text-left text-muted-foreground">
                    <th className="px-3 py-2 w-8">
                      <input type="checkbox"
                        checked={selectedRows.size === extraction.transactionRows.length}
                        onChange={toggleAll}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {extraction.transactionRows.map((row: TransactionRow, i: number) => (
                    <tr key={i} className={selectedRows.has(i) ? "" : "opacity-40"}>
                      <td className="px-3 py-1.5">
                        <input type="checkbox"
                          checked={selectedRows.has(i)}
                          onChange={() => toggleRow(i)}
                          className="h-3.5 w-3.5 cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{row.date}</td>
                      <td className="px-3 py-1.5 max-w-xs truncate">{row.description}</td>
                      <td className={`px-3 py-1.5 text-right whitespace-nowrap font-mono ${row.amountCents < 0 ? "text-destructive" : "text-green-600"}`}>
                        {formatCents(row.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleImport}
                disabled={isPending || !accountId || selectedRows.size === 0}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isPending ? "Importing…" : `Import ${selectedRows.size} transactions`}
              </button>
              {importResult && (
                <span className="text-sm text-muted-foreground">
                  {importResult.imported} imported, {importResult.skipped} skipped as duplicates
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
