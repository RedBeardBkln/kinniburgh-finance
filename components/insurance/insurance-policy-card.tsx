"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { addCashValueEntry } from "@/actions/insurance";

type Policy = {
  id: string;
  entityId: string;
  policyType: string;
  insurer: string;
  policyNumber: string | null;
  faceAmountCents: number | null;
  monthlyPremiumCents: number | null;
  effectiveDate: Date | null;
  expiryDate: Date | null;
  notes: string | null;
  document: { id: string; extractionStatus: string | null } | null;
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
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const daysUntilExpiry = policy.expiryDate
    ? Math.ceil((policy.expiryDate.getTime() - Date.now()) / 86400000)
    : null;

  // Cash value
  const [showAddCV, setShowAddCV] = useState(false);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [cashValue, setCashValue] = useState("");
  const [cvNotes, setCvNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Document upload
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadDone, setUploadDone] = useState(policy.document?.extractionStatus === "complete");

  // Q&A
  const [showAsk, setShowAsk] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const hasDocument = !!(policy.document || uploadDone);

  const chartData = policy.cashValueEntries.map((e) => ({
    date: e.asOf.toISOString().slice(0, 7),
    cashValue: e.cashValueCents / 100,
  }));

  let trendNote = "";
  if (policy.cashValueEntries.length >= 2) {
    const first = policy.cashValueEntries[0]!;
    const last = policy.cashValueEntries[policy.cashValueEntries.length - 1]!;
    const growthCents = last.cashValueCents - first.cashValueCents;
    const months = (last.asOf.getTime() - first.asOf.getTime()) / (1000 * 60 * 60 * 24 * 30);
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

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/insurance/${policy.id}/upload`, { method: "POST", body: fd });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Upload failed");
      setUploadDone(true);
      router.refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleAsk() {
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    setAskError(null);
    try {
      const res = await fetch(`/api/insurance/${policy.id}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json()) as { answer?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to get answer");
      setAnswer(data.answer ?? "");
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setAsking(false);
    }
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

        {/* Cash value entry */}
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
              <button onClick={() => setShowAddCV(false)} className="text-xs text-muted-foreground hover:underline">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAddCV(true)} className="text-xs text-primary hover:underline">
            + Add cash value reading
          </button>
        )}

        {/* Document upload */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">Policy document</p>
            {hasDocument ? (
              <Badge variant="outline" className="border-green-400 text-green-700 text-xs">
                Document attached
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                No document
              </Badge>
            )}
          </div>

          {uploadError && (
            <p className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{uploadError}</p>
          )}

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={handleUpload}
              className="hidden"
              id={`policy-upload-${policy.id}`}
            />
            <label
              htmlFor={`policy-upload-${policy.id}`}
              className={`cursor-pointer rounded border px-3 py-1 text-xs font-medium transition-colors ${
                uploading ? "opacity-50 pointer-events-none" : "hover:bg-muted"
              }`}
            >
              {uploading ? "Uploading & extracting…" : hasDocument ? "Replace document" : "Upload policy PDF"}
            </label>
            {hasDocument && !showAsk && (
              <button
                onClick={() => { setShowAsk(true); setAnswer(null); setAskError(null); }}
                className="text-xs text-primary hover:underline"
              >
                Ask a question
              </button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            PDF or image, max 20MB. Fields will be auto-populated from the document.
          </p>
        </div>

        {/* Q&A */}
        {showAsk && hasDocument && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Ask about this policy</p>
              <button
                onClick={() => { setShowAsk(false); setAnswer(null); setAskError(null); setQuestion(""); }}
                className="text-xs text-muted-foreground hover:underline"
              >
                Close
              </button>
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What are the exclusions? What is the grace period?"
              rows={2}
              className="w-full rounded border px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={handleAsk}
              disabled={asking || !question.trim()}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {asking ? "Thinking…" : "Ask"}
            </button>

            {askError && (
              <p className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{askError}</p>
            )}
            {answer && (
              <div className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed whitespace-pre-wrap">
                {answer}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
