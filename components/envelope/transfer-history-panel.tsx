"use client";

import { useState, useEffect } from "react";
import {
  getScheduledTransferHistory,
  type ScheduledTransferHistoryRow,
} from "@/actions/envelope";

interface Props {
  scheduledTransferId: string;
  fromNickname: string;
  toNickname: string;
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

function rowMatchesSearch(row: ScheduledTransferHistoryRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    fmtDate(row.postedAtIso),
    fmtUSD(row.amount),
    row.fromNickname,
    row.fromMask ?? "",
    row.toNickname,
    row.toMask ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function TransferHistoryPanel({ scheduledTransferId, fromNickname, toNickname }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ScheduledTransferHistoryRow[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Lazy-fetch the first time the panel is mounted (i.e. the first time it's
  // opened, since the parent only renders it while expanded) — avoids
  // loading history for every schedule up front. Mirrors the fetch-on-open
  // pattern used by CategoryDrilldownModal.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getScheduledTransferHistory(scheduledTransferId)
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load history");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scheduledTransferId]);

  const filtered = rows.filter((r) => rowMatchesSearch(r, search));

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {fromNickname} → {toNickname} history
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search date, amount, account…"
          className="w-56 rounded border px-2 py-1 text-xs"
        />
      </div>

      {loading && !loaded && (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</p>
      )}

      {error && <p className="px-2 py-2 text-xs text-destructive">{error}</p>}

      {loaded && !error && rows.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">
          No linked transfers yet.
        </p>
      )}

      {loaded && !error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">Date</th>
                <th className="px-2 py-1 font-medium text-right">Amount</th>
                <th className="px-2 py-1 font-medium">From</th>
                <th className="px-2 py-1 font-medium">To</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.pairId} className="border-b last:border-0">
                  <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.postedAtIso)}</td>
                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                    {fmtUSD(r.amount)}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {r.fromNickname}
                    {r.fromMask ? ` ···${r.fromMask}` : ""}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {r.toNickname}
                    {r.toMask ? ` ···${r.toMask}` : ""}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-3 text-center text-muted-foreground">
                    No matches for &ldquo;{search}&rdquo;.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
