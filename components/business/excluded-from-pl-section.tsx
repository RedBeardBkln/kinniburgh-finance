"use client";

import { useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { assignGlCode } from "@/actions/gl-codes";
import { isPLGlType } from "@/lib/gl-code-warnings";

interface GlCodeOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface ExcludedTxRow {
  id: string;
  postedAt: string; // ISO
  payee: string;
  accountNickname: string;
  amount: string; // signed decimal string, negative = outflow
  glCodeId: string;
  glCode: string;
  glName: string;
  glType: string;
}

interface Props {
  glCodes: GlCodeOption[];
  rows: ExcludedTxRow[];
  totalCount: number;
  periodLabel: string | null;
}

const TYPE_ORDER = ["revenue", "expense", "asset", "liability", "equity"];

// Amount is a signed decimal string from the server (Decimal.toString()).
// Display-only formatting; no arithmetic is done on it in the client.
function formatSignedAmount(amount: string): string {
  const negative = amount.startsWith("-");
  const abs = negative ? amount.slice(1) : amount;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Number(abs));
  return `${negative ? "−" : "+"}${formatted}`;
}

export function ExcludedFromPlSection({ glCodes, rows: initialRows, totalCount, periodLabel }: Props) {
  const [rows, setRows] = useState(initialRows);
  const [removedCount, setRemovedCount] = useState(0);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const grouped = TYPE_ORDER.map((type) => ({
    type,
    codes: glCodes.filter((g) => g.type === type),
  })).filter((grp) => grp.codes.length > 0);
  // Any unexpected type strings still need to be selectable.
  const otherCodes = glCodes.filter((g) => !TYPE_ORDER.includes(g.type));

  function handleRecode(tx: ExcludedTxRow, glCodeId: string) {
    if (!glCodeId || glCodeId === tx.glCodeId) return;
    setAssigningId(tx.id);
    setRowError((prev) => {
      if (!(tx.id in prev)) return prev;
      const next = { ...prev };
      delete next[tx.id];
      return next;
    });
    startTransition(async () => {
      try {
        await assignGlCode(tx.id, glCodeId);
        const target = glCodes.find((g) => g.id === glCodeId);
        if (target && !isPLGlType(target.type)) {
          // Still a balance-sheet code: stays in the list under its new code.
          setRows((prev) =>
            prev.map((r) =>
              r.id === tx.id
                ? { ...r, glCodeId: target.id, glCode: target.code, glName: target.name, glType: target.type }
                : r
            )
          );
        } else {
          setRows((prev) => prev.filter((r) => r.id !== tx.id));
          setRemovedCount((n) => n + 1);
        }
      } catch (err) {
        setRowError((prev) => ({
          ...prev,
          [tx.id]: err instanceof Error ? err.message : "Failed to re-code — try again.",
        }));
      } finally {
        setAssigningId(null);
      }
    });
  }

  const remainingTotal = Math.max(0, totalCount - removedCount);
  const truncated = remainingTotal > rows.length;

  if (rows.length === 0 && remainingTotal === 0) return null;

  return (
    <div id="excluded-from-pl" className="space-y-3 scroll-mt-4">
      <h2 className="font-medium">Coded to balance-sheet accounts (excluded from P&amp;L)</h2>
      <p className="text-sm text-muted-foreground">
        These transactions are coded to asset, liability or equity accounts, so they do not appear on
        the Profit &amp; Loss. That is correct for owner contributions/draws or loan principal; if one is
        really revenue or an expense, re-code it below.
        {periodLabel ? <> Showing period: {periodLabel}.</> : <> Showing all periods.</>}
      </p>
      <p className="text-xs text-muted-foreground">
        {truncated
          ? `Showing ${rows.length} of ${remainingTotal} transactions.`
          : `${remainingTotal} ${remainingTotal === 1 ? "transaction" : "transactions"}.`}
      </p>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium text-xs">Date</th>
                  <th className="px-3 py-2 font-medium text-xs">Payee</th>
                  <th className="px-3 py-2 font-medium text-xs">Account</th>
                  <th className="px-3 py-2 font-medium text-xs text-right">Amount</th>
                  <th className="px-3 py-2 font-medium text-xs">Current code</th>
                  <th className="px-3 py-2 font-medium text-xs">Re-code</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tx) => {
                  const isOut = tx.amount.startsWith("-");
                  const inList = glCodes.some((g) => g.id === tx.glCodeId);
                  return (
                    <tr
                      key={tx.id}
                      className={`border-b last:border-0 align-top ${assigningId === tx.id ? "opacity-50" : ""}`}
                    >
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(tx.postedAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          timeZone: "America/New_York",
                        })}
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[180px] truncate">{tx.payee}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{tx.accountNickname}</td>
                      <td
                        className={`px-3 py-2 text-xs text-right font-mono ${isOut ? "text-destructive" : "text-green-600"}`}
                      >
                        {formatSignedAmount(tx.amount)}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <span className="font-mono">{tx.glCode}</span> {tx.glName}{" "}
                        <span className="text-amber-600">({tx.glType})</span>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={tx.glCodeId}
                          onChange={(e) => handleRecode(tx, e.target.value)}
                          disabled={assigningId === tx.id}
                          className="block w-full rounded border border-input bg-background px-1.5 py-1 text-xs"
                        >
                          {!inList && (
                            <option value={tx.glCodeId}>
                              {tx.glCode} {tx.glName} ({tx.glType})
                            </option>
                          )}
                          {grouped.map((grp) => (
                            <optgroup key={grp.type} label={grp.type}>
                              {grp.codes.map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.code} {g.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                          {otherCodes.length > 0 && (
                            <optgroup label="other">
                              {otherCodes.map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.code} {g.name} ({g.type})
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                        {rowError[tx.id] && (
                          <p className="mt-1 text-xs text-destructive">{rowError[tx.id]}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
