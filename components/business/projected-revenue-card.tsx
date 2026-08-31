"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createProjectedRevenue,
  markProjectedRevenueRealized,
  archiveProjectedRevenue,
} from "@/actions/projected-revenue";

interface ProjectedRevenueRow {
  id: string;
  description: string;
  expectedDate: string; // ISO
  amountCents: number;
  notes: string | null;
  realizedAt: string | null; // ISO
}

interface Props {
  entityId: string;
  entityLabel: string;
  rows: ProjectedRevenueRow[];
}

function fmtUSD(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function ProjectedRevenueCard({ entityId, entityLabel, rows }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const upcoming = rows.filter((r) => !r.realizedAt);
  const upcomingTotal = upcoming.reduce((s, r) => s + r.amountCents, 0);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);

    const amountStr = formData.get("amount") as string;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      setError("Enter a positive amount.");
      return;
    }

    setSaving(true);
    const result = await createProjectedRevenue({
      entityId,
      description: formData.get("description") as string,
      expectedDate: formData.get("expectedDate") as string,
      amountCents: Math.round(amount * 100),
      notes: (formData.get("notes") as string) || undefined,
    });
    setSaving(false);

    if ("error" in result) {
      setError(result.error);
      return;
    }

    setSuccess("Projected revenue added — tentative only, not booked as income.");
    formEl.reset();
    startTransition(() => router.refresh());
  }

  async function handleRealized(id: string, realized: boolean) {
    await markProjectedRevenueRealized(id, realized);
    startTransition(() => router.refresh());
  }

  async function handleArchive(id: string) {
    if (!confirm("Remove this projected revenue entry?")) return;
    await archiveProjectedRevenue(id);
    startTransition(() => router.refresh());
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Projected revenue (forecast-only)</CardTitle>
          {upcoming.length > 0 && (
            <span className="text-sm font-medium text-muted-foreground">
              Upcoming: <span className="text-green-600">{fmtUSD(upcomingTotal)}</span>
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Tentative expected income for {entityLabel}. Not booked — captured revenue comes
          from bank deposits once they land.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No projected revenue entries. Add one when there&apos;s expected income worth
            forecasting.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 font-medium">Expected</th>
                  <th className="py-2 px-3 font-medium">Description</th>
                  <th className="py-2 px-3 font-medium text-right">Amount</th>
                  <th className="py-2 px-3 font-medium">Status</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isPast = new Date(r.expectedDate) < today;
                  return (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className={`py-2 ${isPast ? "text-muted-foreground" : "font-medium"}`}>
                        {new Date(r.expectedDate).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          timeZone: "UTC",
                        })}
                      </td>
                      <td className="py-2 px-3">
                        {r.description}
                        {r.notes && (
                          <span className="block text-xs text-muted-foreground">{r.notes}</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-medium text-green-600 tabular-nums">
                        {fmtUSD(r.amountCents)}
                      </td>
                      <td className="py-2 px-3">
                        {r.realizedAt ? (
                          <span className="text-xs font-medium text-green-600">Realized</span>
                        ) : isPast ? (
                          <span className="text-xs font-medium text-amber-600">Past due</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Expected</span>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleRealized(r.id, !r.realizedAt)}
                          className="text-xs text-primary hover:underline"
                        >
                          {r.realizedAt ? "Mark expected" : "Mark realized"}
                        </button>
                        <button
                          onClick={() => handleArchive(r.id)}
                          className="ml-3 text-xs text-muted-foreground hover:text-destructive"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Add form */}
        <div className="border-t pt-4">
          <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">Description *</label>
              <input
                name="description"
                required
                maxLength={200}
                className="w-full rounded border px-2 py-1.5 text-sm"
                placeholder="e.g. Client invoice — Project X"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Expected date *</label>
              <input
                name="expectedDate"
                type="date"
                required
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Amount (USD) *</label>
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                className="w-full rounded border px-2 py-1.5 text-sm tabular-nums"
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Notes</label>
              <input
                name="notes"
                maxLength={500}
                className="w-full rounded border px-2 py-1.5 text-sm"
                placeholder="Optional"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {saving ? "Adding…" : "Add projected revenue"}
              </button>
            </div>
          </form>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          {success && <p className="mt-2 text-xs text-green-600">{success}</p>}
        </div>
      </CardContent>
    </Card>
  );
}