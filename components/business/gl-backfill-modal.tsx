"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  previewGlCodeBackfill,
  applyGlCodeBackfill,
  type BackfillPreview,
} from "@/actions/gl-code-mappings";

type Step = "ask" | "loading" | "results" | "done";

interface Props {
  entityId: string;
  onDone: () => void;
}

export function GlBackfillModal({ entityId, onDone }: Props) {
  const [step, setStep] = useState<Step>("ask");
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [resultMsg, setResultMsg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handlePreview() {
    setStep("loading");
    setError(null);
    startTransition(async () => {
      try {
        const res = await previewGlCodeBackfill(entityId);
        setPreview(res);
        setChecked(new Set(res.wouldAssign.map((m) => m.id)));
        setStep("results");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Preview failed");
        setStep("ask");
      }
    });
  }

  function handleApply() {
    const selectedIds = [...checked];
    startTransition(async () => {
      try {
        const res = await applyGlCodeBackfill(selectedIds);
        setResultMsg(
          `${res.assigned} transaction${res.assigned !== 1 ? "s" : ""} coded.`
        );
        setStep("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Apply failed");
      }
    });
  }

  function toggleRow(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Backfill GL codes from tag mappings</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto space-y-4">
          {step === "ask" && (
            <div className="space-y-4">
              <p className="text-sm">
                Scan this entity&apos;s existing tagged-but-uncoded transactions and
                preview which GL codes would be auto-assigned based on the
                current tag mappings above.
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-3">
                <button
                  onClick={handlePreview}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Preview backfill
                </button>
                <button
                  onClick={onDone}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {step === "loading" && (
            <p className="text-sm text-muted-foreground">Resolving GL codes…</p>
          )}

          {step === "results" && preview && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {preview.noMappingCount > 0 && (
                  <Badge variant="outline">
                    {preview.noMappingCount} excluded — no mapping
                  </Badge>
                )}
                {preview.conflicts.length > 0 && (
                  <Badge variant="outline">
                    {preview.conflicts.length} excluded — conflicting tags
                  </Badge>
                )}
              </div>

              {preview.wouldAssign.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No currently-uncoded transactions can be resolved from the
                  current mappings.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Found <strong>{preview.wouldAssign.length}</strong> transaction
                    {preview.wouldAssign.length !== 1 ? "s" : ""} that would be coded.
                    Uncheck any you want to skip.
                  </p>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                          <th className="px-3 py-2 w-8">
                            <input
                              type="checkbox"
                              checked={checked.size === preview.wouldAssign.length}
                              onChange={(e) =>
                                setChecked(
                                  e.target.checked
                                    ? new Set(preview.wouldAssign.map((m) => m.id))
                                    : new Set()
                                )
                              }
                              className="accent-primary"
                            />
                          </th>
                          <th className="px-3 py-2 font-medium">Date</th>
                          <th className="px-3 py-2 font-medium">Payee</th>
                          <th className="px-3 py-2 font-medium text-right">Amount</th>
                          <th className="px-3 py-2 font-medium">Tags</th>
                          <th className="px-3 py-2 font-medium">GL Code</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.wouldAssign.map((m) => (
                          <tr
                            key={m.id}
                            className={`border-b last:border-0 hover:bg-muted/30 cursor-pointer ${
                              !checked.has(m.id) ? "opacity-50" : ""
                            }`}
                            onClick={() => toggleRow(m.id)}
                          >
                            <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={checked.has(m.id)}
                                onChange={() => toggleRow(m.id)}
                                className="accent-primary"
                              />
                            </td>
                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                              {new Date(m.postedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                timeZone: "UTC",
                              })}
                            </td>
                            <td className="px-3 py-2 max-w-[160px] truncate">{m.payeeRaw}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{m.amount}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {m.tagNames.map((t) => (
                                  <Badge key={t} variant="secondary" className="text-xs">
                                    {t}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-xs">
                              {m.resolvedGlCodeLabel}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-3 items-center">
                {preview.wouldAssign.length > 0 && (
                  <button
                    onClick={handleApply}
                    disabled={checked.size === 0 || isPending}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isPending ? "Applying…" : `Apply to ${checked.size} selected`}
                  </button>
                )}
                <button
                  onClick={onDone}
                  disabled={isPending}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:pointer-events-none"
                >
                  {preview.wouldAssign.length === 0 ? "Close" : "Cancel"}
                </button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-4">
              <p className="text-sm text-green-700">{resultMsg}</p>
              <button
                onClick={onDone}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
