"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createManualAsset, archiveManualAsset } from "@/actions/net-worth";

interface AssetRow {
  id: string;
  name: string;
  category: string;
  valueCents: number;
  asOf: Date;
  notes: string | null;
}

interface Props {
  assets: AssetRow[];
}

const CATEGORY_LABELS: Record<string, string> = {
  real_estate: "Real estate",
  vehicle: "Vehicle",
  other: "Other",
};

export function ManualAssetForm({ assets }: Props) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"real_estate" | "vehicle" | "other">("real_estate");
  const [value, setValue] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleAdd() {
    if (!name.trim()) { setError("Name required"); return; }
    const cents = Math.round(parseFloat(value) * 100);
    if (!cents || cents <= 0) { setError("Value must be positive"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await createManualAsset({
          name: name.trim(),
          category,
          valueCents: cents,
          asOf,
          notes: notes.trim() || undefined,
        });
        setName(""); setValue(""); setNotes(""); setShowAdd(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add asset");
      }
    });
  }

  function handleRemove(id: string, assetName: string) {
    if (!confirm(`Remove "${assetName}"?`)) return;
    startTransition(async () => {
      await archiveManualAsset(id);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Manual asset values</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground italic">
          Values are your estimates — this app never invents property or vehicle valuations. Enter or update amounts when you have a reliable estimate.
        </p>

        {/* Existing assets */}
        {assets.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Category</th>
                <th className="pb-2 font-medium text-right">Value</th>
                <th className="pb-2 font-medium">As of</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-2">{a.name}</td>
                  <td className="py-2 text-xs text-muted-foreground">{CATEGORY_LABELS[a.category] ?? a.category}</td>
                  <td className="py-2 text-right tabular-nums">
                    ${(a.valueCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {new Date(a.asOf).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                  </td>
                  <td className="py-2 text-right">
                    <button onClick={() => handleRemove(a.id, a.name)} className="text-xs text-muted-foreground hover:text-destructive">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {showAdd ? (
          <div className="space-y-3 border-t pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sudden Valley property"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="real_estate">Real estate</option>
                  <option value="vehicle">Vehicle</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Estimated value ($)</label>
                <input type="number" step="1000" min="0" value={value} onChange={(e) => setValue(e.target.value)} placeholder="450000"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">As of date</label>
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-sm font-medium">Notes <span className="text-xs text-muted-foreground font-normal">optional</span></label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Zillow estimate, Zestimate, appraisal, etc."
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={isPending}
                className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {isPending ? "Adding…" : "Add asset"}
              </button>
              <button onClick={() => setShowAdd(false)} className="text-sm text-muted-foreground hover:underline">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAdd(true)}
            className="text-sm text-primary hover:underline">
            + Add property / vehicle
          </button>
        )}
      </CardContent>
    </Card>
  );
}
