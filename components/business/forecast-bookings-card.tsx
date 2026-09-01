"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadRentalBookings, clearRentalBookings } from "@/actions/rental-bookings";

interface Booking {
  id: string;
  confirmationCode: string;
  startDate: string; // ISO
  endDate: string; // ISO
  nights: number;
  guest: string;
  listing: string;
  grossEarnings: string;
  payoutDate: string; // ISO
}

interface Props {
  entityId: string;
  entityLabel: string;
  bookings: Booking[];
}

function fmtUSD(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function monthKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ForecastBookingsCard({ entityId, entityLabel, bookings }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setMsg(null);
    setError(null);

    try {
      const text = await file.text();
      const result = await uploadRentalBookings(entityId, text);
      if ("error" in result) {
        setError(result.error);
      } else {
        const skippedNote =
          result.skipped > 0 ? ` · ${result.skipped} row(s) skipped (unparseable)` : "";
        setMsg(
          `Imported ${result.imported} reservation${result.imported !== 1 ? "s" : ""}${skippedNote}`
        );
        startTransition(() => router.refresh());
      }
    } catch (err) {
      // Server-action rejections can arrive as opaque errors — keep the page
      // alive and surface a readable message instead of a blank screen.
      console.error("[bookings-upload] failed", err);
      setError("Upload failed — check the CSV is an Airbnb earnings export, then retry.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleClear() {
    if (!confirm(`Clear all reservation bookings for ${entityLabel}?`)) return;
    setClearing(true);
    await clearRentalBookings(entityId);
    startTransition(() => router.refresh());
    setClearing(false);
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const upcoming = bookings.filter((b) => new Date(b.endDate) >= today);
  const byMonth = new Map<string, number>();
  for (const b of upcoming) {
    const key = monthKey(b.payoutDate);
    byMonth.set(key, (byMonth.get(key) ?? 0) + Number(b.grossEarnings));
  }
  const totalUpcoming = upcoming.reduce((s, b) => s + Number(b.grossEarnings), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              Future reservations — forecasted revenue
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Tentative Airbnb reservations for {entityLabel}. Bookings can be modified or
              cancelled — used for predictive purposes only. Captured revenue appears in
              the transaction list once deposits post to the bank account.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {bookings.length > 0 && (
              <button
                onClick={handleClear}
                disabled={clearing}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                {clearing ? "Clearing…" : "Clear all"}
              </button>
            )}
            <label className="cursor-pointer">
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                className="sr-only"
                onChange={handleFile}
                disabled={uploading}
              />
              <span className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors">
                {uploading
                  ? "Uploading…"
                  : bookings.length > 0
                    ? "Re-upload CSV"
                    : "Upload reservations CSV"}
              </span>
            </label>
          </div>
        </div>
        {msg && <p className="text-xs text-green-600 mt-1">{msg}</p>}
        {error && <p className="text-xs text-destructive mt-1">{error}</p>}
      </CardHeader>
      <CardContent className="space-y-4">
        {bookings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reservation bookings uploaded yet. Export the reservations CSV from Airbnb and
            upload it here to see forecasted revenue.
          </p>
        ) : (
          <>
            {byMonth.size > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Forecasted payout revenue by month
                </p>
                <div className="grid gap-1">
                  {Array.from(byMonth.entries()).map(([month, total]) => (
                    <div key={month} className="flex justify-between text-sm">
                      <span>{month}</span>
                      <span className="font-medium text-green-600">{fmtUSD(total)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-sm font-semibold border-t pt-1.5 mt-0.5">
                    <span>Total upcoming (tentative)</span>
                    <span className="text-green-600">{fmtUSD(totalUpcoming)}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Guest</th>
                    <th className="pb-2 px-3 font-medium">Check-in</th>
                    <th className="pb-2 px-3 font-medium">Check-out</th>
                    <th className="pb-2 px-3 font-medium text-center">Nights</th>
                    <th className="pb-2 px-3 font-medium text-right">Gross earnings</th>
                    <th className="pb-2 px-3 font-medium text-right">Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => {
                    const isPast = new Date(b.endDate) < today;
                    return (
                      <tr
                        key={b.id}
                        className={`border-b last:border-0 hover:bg-muted/30 ${isPast ? "opacity-50" : ""}`}
                      >
                        <td className="py-2 font-medium">{b.guest}</td>
                        <td className="py-2 px-3 text-muted-foreground">
                          {new Date(b.startDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="py-2 px-3 text-muted-foreground">
                          {new Date(b.endDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="py-2 px-3 text-center text-muted-foreground">{b.nights}</td>
                        <td className="py-2 px-3 text-right font-medium text-green-600">
                          {fmtUSD(Number(b.grossEarnings))}
                        </td>
                        <td className="py-2 px-3 text-right text-xs text-muted-foreground">
                          {new Date(b.payoutDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}