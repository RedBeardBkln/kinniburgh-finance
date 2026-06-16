"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { addCashValueEntry } from "@/actions/insurance";

type Policy = {
  id: string;
  policyType: string;
  insurer: string;
  policyNumber: string | null;
  faceAmountCents: number | null;
  monthlyPremiumCents: number | null;
  effectiveDate: Date | null;
  expiryDate: Date | null;
  notes: string | null;
  cashValueEntries: Array<{ id: string; asOf: Date; cashValueCents: number; notes: string | null }>;
};

function fmtMoney(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0 })}`;
}

const POLICY_TYPE_LABELS: Record<string, string> = {
  term: "Term Life",
  whole: "Whole Life",
  ul: "Universal Life",
  property: "Property",
  auto: "Auto",
  motorcycle: "Motorcycle",
  other: "Other",
};

export function InsurancePolicyCard({ policy }: { policy: Policy }) {
  const daysUntilExpiry = policy.expiryDate
    ? Math.ceil((policy.expiryDate.getTime() - Date.now()) / 86400000)
    : null;

  const [showAddCV, setShowAddCV] = useState(false);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [cashValue, setCashValue] = useState("");
  const [cvNotes, setCvNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const chartData = policy.cashValueEntries.map((e) => ({
    date: e.asOf.toISOString().slice(0, 7),
    cashValue: e.cashValueCents / 100,
  }));

  // Observational trend note
  let trendNote = "";
  if (policy.cashValueEntries.length >= 2) {
    const first = policy.cashValueEntries[0]!;
    const last = policy.cashValueEntries[policy.cashValueEntries.length - 1]!;
    const growthCents = last.cashValueCents - first.cashValueCents;
    const months =
      (last.asOf.getTime() - first.asOf.getTime()) / (1000 * 60 * 60 * 24 * 30);
    const annualGrowthCents = months > 0 ? (growthCents / months) * 12 : 0;
    if (policy.monthlyPremiumCents) {
      const annualPremiumCents = policy.monthlyPremiumCents * 12;
      if (annualGrowthCents < annualPremiumCents * 0.5) {
        trendNote = `Cash value grew ${fmtMoney(Math.round(annualGrowthCents))}/yr vs. ${fmtMoney(annualPremiumCents)}/yr in premiums paid.`;
      } else {
        trendNote = `Cash value growing ${fmtMoney(Math.round(annualGrowthCents))}/yr annualized.`;
      }
    }
  }

  async function handleAddCV() {
    if (!cashValue) return;
    setSaving(true);
    await addCashValueEntry(policy.id, {
      asOf,
      cashValueCents: Math.round(parseFloat(cashValue) * 100),
      notes: cvNotes || undefined,
    });
    setSaving(false);
    setShowAddCV(false);
    setCashValue("");
    setCvNotes("");
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{policy.insurer}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {POLICY_TYPE_LABELS[policy.policyType] ?? policy.policyType}
              {policy.policyNumber && ` · ${policy.policyNumber}`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold">{fmtMoney(policy.faceAmountCents)}</p>
            <p className="text-xs text-muted-foreground">face amount</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Monthly premium</p>
            <p className="font-medium">{fmtMoney(policy.monthlyPremiumCents)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Effective</p>
            <p className="font-medium">
              {policy.effectiveDate
                ? policy.effectiveDate.toLocaleDateString("en-US", { month: "short", year: "numeric" })
                : "—"}
            </p>
          </div>
          {policy.expiryDate && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Expires</p>
              <div className="flex items-center gap-2">
                <p className="font-medium">
                  {policy.expiryDate.toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                </p>
                {daysUntilExpiry !== null && daysUntilExpiry <= 60 && (
                  daysUntilExpiry < 0 ? (
                    <Badge variant="destructive">Expired</Badge>
                  ) : daysUntilExpiry <= 30 ? (
                    <Badge variant="destructive">
                      Expires in {daysUntilExpiry} day{daysUntilExpiry === 1 ? "" : "s"}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-300 text-amber-600">
                      Expires in {daysUntilExpiry} days
                    </Badge>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        {policy.notes && (
          <p className="text-xs text-muted-foreground">{policy.notes}</p>
        )}

        {chartData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Cash value history</p>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number) => [`$${v.toLocaleString()}`, "Cash value"]} />
                <Line type="monotone" dataKey="cashValue" dot={false} strokeWidth={2} stroke="hsl(var(--primary))" />
              </LineChart>
            </ResponsiveContainer>
            {trendNote && <p className="text-xs text-muted-foreground mt-1">{trendNote}</p>}
          </div>
        )}

        {showAddCV ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium">Add cash value reading</p>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="rounded border px-2 py-1 text-xs"
              />
              <input
                type="number"
                value={cashValue}
                onChange={(e) => setCashValue(e.target.value)}
                placeholder="Cash value ($)"
                className="rounded border px-2 py-1 text-xs"
              />
            </div>
            <input
              type="text"
              value={cvNotes}
              onChange={(e) => setCvNotes(e.target.value)}
              placeholder="Notes (optional)"
              className="w-full rounded border px-2 py-1 text-xs"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAddCV}
                disabled={saving}
                className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => setShowAddCV(false)}
                className="text-xs text-muted-foreground hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddCV(true)}
            className="text-xs text-primary hover:underline"
          >
            + Add cash value reading
          </button>
        )}
      </CardContent>
    </Card>
  );
}
