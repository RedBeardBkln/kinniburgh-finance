"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmDocExtraction } from "@/actions/documents";
import { confirmStatementImport } from "@/actions/bank-statements";
import type { ExtractedDocument, TransactionRow } from "@/lib/doc-extract";
import { defaultImportSelection, isWithinPlaidCoverage } from "@/lib/statement-review";
import { validateStatementRow } from "@/lib/statement-import";

interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  plaidCoverageStart?: string | null;
}

interface Props {
  documentId: string;
  extraction: ExtractedDocument;
  entityId: string;
  isBankStatement: boolean;
  accounts?: AccountOption[];
  defaultAccountId?: string | null;
  canFlagBusinessExpense?: boolean;
  /**
   * accountId -> per-row flag (index-aligned with extraction.transactionRows):
   * true when that row is already in that account's ledger.
   */
  ledgerPresence: Record<string, boolean[]>;
  backHref: Route;
  backLabel: string;
  nextReviewHref: Route | null;
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

export function DocumentReviewClient({
  documentId,
  extraction,
  isBankStatement,
  accounts,
  defaultAccountId,
  canFlagBusinessExpense,
  ledgerPresence,
  backHref,
  backLabel,
  nextReviewHref,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const selectedAccountOption = accounts?.find((a) => a.id === accountId) ?? null;
  const plaidCoverageStart = selectedAccountOption?.plaidCoverageStart ?? null;

  const rows: TransactionRow[] = extraction.transactionRows ?? [];
  const presence = ledgerPresence[accountId] ?? [];
  const isInLedger = (i: number) => presence[i] === true;
  const isImportable = (row: unknown) => validateStatementRow(row);

  // Default selection for a given target account: everything the existing
  // rules select (not a card payment, not inside Plaid's live coverage), minus
  // rows already in that account's ledger (they would only be skipped as
  // duplicates) and rows too malformed to import at all.
  function selectionFor(forAccountId: string): Set<number> {
    const coverageStart = accounts?.find((a) => a.id === forAccountId)?.plaidCoverageStart ?? null;
    const inLedger = ledgerPresence[forAccountId] ?? [];
    return new Set(
      defaultImportSelection(rows, coverageStart).filter(
        (i) => validateStatementRow(rows[i]) && inLedger[i] !== true
      )
    );
  }

  const [selectedRows, setSelectedRows] = useState<Set<number>>(() => selectionFor(defaultAccountId ?? ""));

  // The target account (and therefore its Plaid coverage window and ledger
  // contents) can change after the row list first renders, so the default
  // selection is recomputed on every account change. Rows toggled by hand
  // before switching are intentionally reset, since the switch itself changes
  // which rows are excluded by default. Done in the handler, not an effect.
  function handleAccountChange(nextAccountId: string) {
    setAccountId(nextAccountId);
    setSelectedRows(selectionFor(nextAccountId));
  }

  const [businessExpenseRows, setBusinessExpenseRows] = useState<Set<number>>(new Set());
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; invalid: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const hasRows = rows.length > 0;
  const needsAccount = isBankStatement && hasRows && !accountId;
  const importableCount = rows.filter(isImportable).length;
  const alreadyInLedgerCount = rows.filter((_, i) => isInLedger(i)).length;

  const dataEntries = Object.entries(extraction.data ?? {}).filter(([k]) => !["raw"].includes(k));

  function toggleRow(i: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleBusinessExpense(i: number) {
    setBusinessExpenseRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    const selectable = rows.map((r, i) => (isImportable(r) ? i : -1)).filter((i) => i >= 0);
    const allSelected = selectable.length > 0 && selectable.every((i) => selectedRows.has(i));
    setSelectedRows(allSelected ? new Set() : new Set(selectable));
  }

  // One decision, one server call. For a bank statement the server imports the
  // selected rows first and only then marks the statement confirmed, so a
  // failure here leaves it unconfirmed and shows the reason, instead of the
  // page looking finished with nothing in the ledger.
  function handleConfirm() {
    if (needsAccount) {
      setConfirmError("Select a target account before confirming — needed to import the transactions below.");
      return;
    }
    setConfirmError(null);
    startTransition(async () => {
      try {
        if (isBankStatement) {
          // Only rows that are both selected for import AND flagged get the
          // business-expense override — a flagged-but-unselected row must
          // not silently import anyway.
          const businessExpenseIndices = Array.from(businessExpenseRows).filter((i) => selectedRows.has(i));
          const res = await confirmStatementImport({
            documentId,
            selectedIndices: Array.from(selectedRows),
            accountId,
            businessExpenseIndices,
          });
          if (!res.ok) {
            setConfirmError(res.error);
            return;
          }
          setImportResult({ imported: res.imported, skipped: res.skipped, invalid: res.invalid });
        } else {
          await confirmDocExtraction(documentId, extraction as unknown as Record<string, unknown>);
        }
        setSaved(true);
        router.refresh();
      } catch {
        setConfirmError(
          "Something went wrong while confirming. It is safe to try again — rows already imported are skipped as duplicates."
        );
      }
    });
  }

  const selectedCount = selectedRows.size;
  const confirmLabel = isPending
    ? isBankStatement && hasRows
      ? "Confirming & importing…"
      : "Saving…"
    : isBankStatement && hasRows
      ? selectedCount > 0
        ? `Confirm extraction & import ${selectedCount} transaction${selectedCount === 1 ? "" : "s"}`
        : "Confirm extraction (no transactions selected)"
      : "Confirm extraction";

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

      {extraction.warnings && extraction.warnings.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {extraction.warnings.map((w) => (
            <p key={w}>⚠ {w}</p>
          ))}
        </div>
      )}

      {/* The one action. Always rendered — it used to live inside the
          "Extracted fields" card and vanished whenever that card was empty. */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          {!saved ? (
            <>
              {isBankStatement && hasRows && (
                <p className="text-sm text-muted-foreground">
                  {selectedCount} of {importableCount} transactions selected
                  {alreadyInLedgerCount > 0 && ` · ${alreadyInLedgerCount} already in your ledger`}. Nothing reaches your
                  transactions until you confirm.
                </p>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleConfirm}
                  disabled={isPending}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {confirmLabel}
                </button>
              </div>
              {confirmError && (
                <p role="alert" className="text-sm text-destructive">
                  {confirmError}
                </p>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-green-700">
                ✓ Confirmed
                {importResult
                  ? ` — ${importResult.imported} transaction${importResult.imported === 1 ? "" : "s"} imported${
                      importResult.skipped ? `, ${importResult.skipped} skipped as already in your ledger` : ""
                    }${importResult.invalid ? `, ${importResult.invalid} unreadable row${importResult.invalid === 1 ? "" : "s"} skipped` : ""}.`
                  : "."}
              </p>
              <div className="flex items-center gap-3">
                <Link
                  href={backHref}
                  className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
                >
                  ← Back to {backLabel}
                </Link>
                {nextReviewHref && (
                  <Link
                    href={nextReviewHref}
                    prefetch={false}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Next statement →
                  </Link>
                )}
              </div>
            </div>
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
          </CardContent>
        </Card>
      )}

      {/* Transaction rows (bank statements) */}
      {hasRows && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Transactions ({rows.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select transactions to import. Rows already in your ledger are unchecked and marked; if you import one
              anyway it is skipped as a duplicate.
            </p>

            <div className="space-y-2">
              <label className="text-sm font-medium">Target account</label>
              {accounts && accounts.length > 0 ? (
                <select
                  value={accountId}
                  onChange={(e) => handleAccountChange(e.target.value)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select an account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname}
                      {a.mask ? ` (···${a.mask})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={accountId}
                  onChange={(e) => handleAccountChange(e.target.value)}
                  placeholder="Account ID (paste from account settings)"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              )}
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30 text-left text-muted-foreground">
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all importable transactions"
                        checked={importableCount > 0 && selectedRows.size === importableCount}
                        onChange={toggleAll}
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    {canFlagBusinessExpense && <th className="px-3 py-2">EK Consulting business expense</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row: TransactionRow, i: number) => {
                    const importable = isImportable(row);
                    const isPaymentRow = row.lineType === "payment";
                    const isPlaidOverlap = isWithinPlaidCoverage(row.date, plaidCoverageStart);
                    return (
                      <tr key={i} className={selectedRows.has(i) ? "" : "opacity-40"}>
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Import row ${i + 1}`}
                            checked={selectedRows.has(i)}
                            disabled={!importable}
                            onChange={() => toggleRow(i)}
                            className="h-3.5 w-3.5 cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{row.date}</td>
                        <td className="px-3 py-1.5 max-w-xs">
                          <span className="truncate block">{row.description}</span>
                          {!importable && (
                            <span className="mt-0.5 inline-block rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                              Unreadable row — can’t be imported; check the PDF
                            </span>
                          )}
                          {isInLedger(i) && (
                            <span className="mt-0.5 inline-block rounded border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                              ✓ Already in your ledger
                            </span>
                          )}
                          {isPaymentRow && (
                            <span className="mt-0.5 ml-1 inline-block rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                              Payment — already captured elsewhere, excluded by default
                            </span>
                          )}
                          {isPlaidOverlap && (
                            <span className="mt-0.5 ml-1 inline-block rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                              ⚠ possibly already synced automatically — verify before importing
                            </span>
                          )}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right whitespace-nowrap font-mono ${
                            row.amountCents < 0 ? "text-destructive" : "text-green-600"
                          }`}
                        >
                          {formatCents(row.amountCents)}
                        </td>
                        {canFlagBusinessExpense && (
                          <td className="px-3 py-1.5 text-center">
                            <input
                              type="checkbox"
                              aria-label={`Flag row ${i + 1} as EK Consulting business expense`}
                              checked={businessExpenseRows.has(i)}
                              onChange={() => toggleBusinessExpense(i)}
                              className="h-3.5 w-3.5 cursor-pointer"
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {canFlagBusinessExpense && !saved && (
              <p className="text-xs text-muted-foreground">
                Rows flagged “EK Consulting business expense” import to that entity instead of Personal.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
