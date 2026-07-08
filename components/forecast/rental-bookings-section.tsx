"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadRentalBookings, clearRentalBookings } from "@/actions/rental-bookings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUSD } from "@/lib/utils";
import { Prisma } from "@prisma/client";

type Booking = {
  id: string;
  confirmationCode: string;
  startDate: Date;
  endDate: Date;
  nights: number;
  guest: string;
  grossEarnings: Prisma.Decimal | number | string;
  payoutDate: Date;
};

interface Props {
  entityId: string;
  entityName: string;
  bookings: Booking[];
}

function toNum(v: Prisma.Decimal | number | string): number {
  return typeof v === "number" ? v : Number(v);
}

function monthKey(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function RentalBookingsSection({ entityId, entityName, bookings }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadMsg(null);
    setUploadError(null);

    try {
      const text = await file.text();
      const result = await uploadRentalBookings(entityId, text);
      if ("error" in result) {
        setUploadError(result.error);
      } else {
        setUploadMsg(`Imported ${result.imported} booking${result.imported !== 1 ? "s" : ""}`);
        startTransition(() => router.refresh());
      }
    } catch {
      setUploadError("Upload failed — please try again");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleClear() {
    if (!confirm(`Clear all rental bookings for ${entityName}?`)) return;
    setClearing(true);
    await clearRentalBookings(entityId);
    startTransition(() => router.refresh());
    setClearing(false);
  }

  // Group by payout month for revenue summary
  const byMonth = new Map<string, number>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const upcomingBookings = bookings.filter((b) => new Date(b.endDate) >= today);

  for (const b of upcomingBookings) {
    const key = monthKey(new Date(b.payoutDate));
    byMonth.set(key, (byMonth.get(key) ?? 0) + toNum(b.grossEarnings));
  }

  const totalUpcoming = upcomingBookings.reduce((s, b) => s + toNum(b.grossEarnings), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>Rental Bookings — {entityName}</CardTitle>
          <div className="flex items-center gap-2">
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
                {uploading ? "Uploading…" : bookings.length > 0 ? "Re-upload CSV" : "Upload Airbnb CSV"}
              </span>
            </label>
          </div>
        </div>
        {uploadMsg && <p className="text-xs text-green-600 mt-1">{uploadMsg}</p>}
        {uploadError && <p className="text-xs text-destructive mt-1">{uploadError}</p>}
      </CardHeader>

      <CardContent className="space-y-4">
        {bookings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bookings uploaded yet. Export your earnings CSV from Airbnb → Earnings → Export earnings (CSV) and upload it here.
          </p>
        ) : (
          <>
            {/* Monthly revenue summary */}
            {byMonth.size > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Upcoming Revenue by Month</p>
                <div className="grid gap-1">
                  {Array.from(byMonth.entries()).map(([month, total]) => (
                    <div key={month} className="flex justify-between text-sm">
                      <span>{month}</span>
                      <span className="font-medium text-green-600">{formatUSD(total)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-sm font-semibold border-t pt-1.5 mt-0.5">
                    <span>Total upcoming</span>
                    <span className="text-green-600">{formatUSD(totalUpcoming)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Bookings table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Guest</th>
                    <th className="pb-2 px-4 font-medium">Check-in</th>
                    <th className="pb-2 px-4 font-medium">Check-out</th>
                    <th className="pb-2 px-4 font-medium text-center">Nights</th>
                    <th className="pb-2 px-4 font-medium text-right">Gross earnings</th>
                    <th className="pb-2 px-2 font-medium text-right">Payout</th>
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
                        <td className="py-2 px-4 text-muted-foreground">
                          {new Date(b.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                        </td>
                        <td className="py-2 px-4 text-muted-foreground">
                          {new Date(b.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                        </td>
                        <td className="py-2 px-4 text-center text-muted-foreground">{b.nights}</td>
                        <td className="py-2 px-4 text-right font-medium text-green-600">
                          {formatUSD(toNum(b.grossEarnings))}
                        </td>
                        <td className="py-2 px-2 text-right text-xs text-muted-foreground">
                          {new Date(b.payoutDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
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
