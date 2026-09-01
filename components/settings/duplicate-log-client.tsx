"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  undoDedupAction,
  undoAllDedupActions,
  runDuplicateDetection,
} from "@/actions/dedupe";

interface ActionRow {
  id: string;
  duplicateTxId: string;
  keptTxId: string;
  accountNickname: string;
  accountMask: string | null;
  postedAt: string;
  amount: string;
  payeeNormalized: string | null;
  detectedBy: string;
  createdAt: string;
}

interface Props {
  actions: ActionRow[];
  undoneCount: number;
}

function fmtUSD(amountStr: string): string {
  const n = parseFloat(amountStr);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function DuplicateLogClient({ actions, undoneCount }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleRunNow() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await runDuplicateDetection("manual");
      if ("error" in result) {
        setError(result.error);
      } else {
        setMessage(
          result.archived > 0
            ? `Removed ${result.archived} duplicate transaction${result.archived !== 1 ? "s" : ""} (across ${result.groups} group${result.groups !== 1 ? "s" : ""}).`
            : "Scan complete — no new duplicates found."
        );
        router.refresh();
      }
    });
  }

  function handleUndo(actionId: string) {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await undoDedupAction(actionId);
      if ("error" in result) {
        setError(result.error);
      } else {
        setMessage("Duplicate restored — it's back in the transaction list and protected from re-removal.");
        router.refresh();
      }
    });
  }

  function handleUndoAll() {
    if (!confirm(`Restore all ${actions.length} removed duplicates?`)) return;
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await undoAllDedupActions();
      setMessage(`Restored ${result.count} duplicate${result.count !== 1 ? "s" : ""}.`);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {actions.length} active removal{actions.length !== 1 ? "s" : ""}
          {undoneCount > 0 && ` · ${undoneCount} previously undone`}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRunNow}
            disabled={isPending}
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
          >
            {isPending ? "Scanning…" : "Scan now"}
          </button>
          {actions.length > 0 && (
            <button
              onClick={handleUndoAll}
              disabled={isPending}
              className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/5 disabled:opacity-60"
            >
              Undo all
            </button>
          )}
        </div>
      </div>

      {message && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Removals awaiting undo</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {actions.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No duplicate removals on record. When the daily sync removes exact duplicates,
              they appear here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium whitespace-nowrap">Posted date</th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">Payee</th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">Account</th>
                    <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Amount</th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">Detected by</th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">Removed on</th>
                    <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((a) => (
                    <tr key={a.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 whitespace-nowrap">{fmtDate(a.postedAt)}</td>
                      <td className="px-4 py-2 font-medium">
                        {a.payeeNormalized ?? "—"}
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          duplicate of kept transaction
                        </span>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                        {a.accountNickname}
                        {a.accountMask ? ` ···${a.accountMask}` : ""}
                      </td>
                      <td
                        className={`px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium ${
                          parseFloat(a.amount) < 0 ? "text-destructive" : "text-green-600"
                        }`}
                      >
                        {fmtUSD(a.amount)}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="secondary" className="text-xs">
                          {a.detectedBy === "cron" ? "Daily sync" : "Manual scan"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(a.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          timeZone: "America/New_York",
                        })}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => handleUndo(a.id)}
                          disabled={isPending}
                          className="text-xs text-primary hover:underline disabled:opacity-60"
                        >
                          Undo
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        A duplicate is an exact match on date, amount, payee, and account. Transfer legs are never
        treated as duplicates. Undo restores the transaction to the list exactly as it was and
        marks it protected — it will not be removed again by future scans.
      </p>
    </>
  );
}