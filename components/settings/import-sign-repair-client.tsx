"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { applyImportSignRepair, type SignRepairPreview } from "@/actions/import-sign-repair";

function fmtUSD(amountStr: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(parseFloat(amountStr));
}

export function ImportSignRepairClient({ previews }: { previews: SignRepairPreview[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleApply(p: SignRepairPreview) {
    const ok = confirm(
      `Correct ${p.importRowCount} imported transactions on ${p.nickname}?\n\n` +
        `• ${p.importRowCount} rows flip from deposit to outflow\n` +
        `• ${p.overlapCount} of them duplicate Plaid rows and are archived (undo from Duplicate Log)`
    );
    if (!ok) return;
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await applyImportSignRepair(p.accountId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setMessage(
        `Corrected ${result.flipped} transactions on ${p.nickname}; archived ${result.archived} that Plaid already covers` +
          (result.tagsCopied > 0 ? ` (copied ${result.tagsCopied} tags onto the Plaid rows)` : "") +
          `. ${result.remainingPositive} imported deposits remain.`
      );
      router.refresh();
    });
  }

  return (
    <>
      {message && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {previews.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No accounts need repair. Every checking/savings account with imported transactions
            has at least one outflow.
          </CardContent>
        </Card>
      ) : (
        previews.map((p) => (
          <Card key={p.accountId}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {p.nickname}
                {p.mask ? ` ···${p.mask}` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="text-muted-foreground">
                All {p.importRowCount} imported transactions ({p.firstDate} → {p.lastDate}) are
                stored as deposits, totalling {fmtUSD(p.totalBefore)}. After the fix they total{" "}
                {fmtUSD(p.totalAfter)}.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>{p.flipOnlyCount}</strong> rows flip to outflows.
                </li>
                <li>
                  <strong>{p.overlapCount}</strong> rows flip <em>and are archived</em> because
                  Plaid already has the same transaction (same day and amount). The Plaid row
                  stays
                  {p.tagCopyCount > 0 || p.projectCopyCount > 0
                    ? `; ${[
                        p.tagCopyCount > 0 ? `${p.tagCopyCount} tags` : "",
                        p.projectCopyCount > 0 ? `${p.projectCopyCount} project assignments` : "",
                      ]
                        .filter(Boolean)
                        .join(" and ")} are copied onto it`
                    : ""}
                  . Reversible from Duplicate Log.
                </li>
                {p.linkedOverlapCount > 0 && (
                  <li>
                    <strong>{p.linkedOverlapCount}</strong> rows match Plaid but have a receipt,
                    note, GL code, or a conflicting project — flipped but left active for you to review.
                  </li>
                )}
              </ul>

              {p.samples.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1 pr-3 font-medium">Date</th>
                        <th className="py-1 pr-3 font-medium">Import row (archived)</th>
                        <th className="py-1 pr-3 font-medium">Plaid row (kept)</th>
                        <th className="py-1 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.samples.map((s, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1 pr-3 whitespace-nowrap">{s.date}</td>
                          <td className="py-1 pr-3 max-w-[260px] truncate">{s.importPayee}</td>
                          <td className="py-1 pr-3 max-w-[200px] truncate">{s.plaidPayee}</td>
                          <td className="py-1 text-right tabular-nums">{fmtUSD(s.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[11px] text-muted-foreground">First {p.samples.length} of {p.overlapCount} overlapping pairs.</p>
                </div>
              )}

              <button
                onClick={() => handleApply(p)}
                disabled={isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {isPending ? "Correcting…" : "Correct signs & archive overlap"}
              </button>
            </CardContent>
          </Card>
        ))
      )}
    </>
  );
}
