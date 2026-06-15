"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createPolicy } from "@/actions/insurance";

const POLICY_TYPES = [
  { value: "term", label: "Term Life" },
  { value: "whole", label: "Whole Life" },
  { value: "ul", label: "Universal Life" },
  { value: "property", label: "Property" },
  { value: "auto", label: "Auto" },
  { value: "motorcycle", label: "Motorcycle" },
  { value: "other", label: "Other" },
] as const;

interface Props {
  entities: Array<{ id: string; name: string }>;
}

export function AddPolicyForm({ entities }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [policyType, setPolicyType] = useState("whole");
  const [insurer, setInsurer] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [faceAmount, setFaceAmount] = useState("");
  const [monthlyPremium, setMonthlyPremium] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");

  function handleSubmit() {
    if (!insurer) { setError("Insurer is required"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await createPolicy({
          entityId,
          policyType: policyType as "term" | "whole" | "ul" | "property" | "auto" | "motorcycle" | "other",
          insurer,
          policyNumber: policyNumber || undefined,
          faceAmountCents: faceAmount ? Math.round(parseFloat(faceAmount) * 100) : undefined,
          monthlyPremiumCents: monthlyPremium ? Math.round(parseFloat(monthlyPremium) * 100) : undefined,
          effectiveDate: effectiveDate || undefined,
          expiryDate: expiryDate || undefined,
          notes: notes || undefined,
        });
        setOpen(false);
        setInsurer(""); setFaceAmount(""); setMonthlyPremium(""); setPolicyNumber(""); setNotes("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add policy");
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
      >
        + Add policy
      </button>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Add insurance policy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">Entity</label>
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Policy type</label>
            <select value={policyType} onChange={(e) => setPolicyType(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              {POLICY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Insurer <span className="text-muted-foreground font-normal text-xs">required</span></label>
            <input value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="Northwestern Mutual"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Policy number <span className="text-muted-foreground font-normal text-xs">optional</span></label>
            <input value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Face amount ($) <span className="text-muted-foreground font-normal text-xs">optional</span></label>
            <input type="number" value={faceAmount} onChange={(e) => setFaceAmount(e.target.value)} placeholder="500000"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Monthly premium ($) <span className="text-muted-foreground font-normal text-xs">optional</span></label>
            <input type="number" value={monthlyPremium} onChange={(e) => setMonthlyPremium(e.target.value)} placeholder="755"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Effective date <span className="text-muted-foreground font-normal text-xs">optional</span></label>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Expiry date <span className="text-muted-foreground font-normal text-xs">optional</span></label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="text-sm font-medium">Notes <span className="text-muted-foreground font-normal text-xs">optional</span></label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. NWM whole life, advisor: John Smith"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleSubmit} disabled={isPending}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {isPending ? "Adding…" : "Add policy"}
          </button>
          <button onClick={() => setOpen(false)} className="text-sm text-muted-foreground hover:underline">
            Cancel
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
