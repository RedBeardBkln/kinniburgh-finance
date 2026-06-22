"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  previewRetroactiveRule,
  applyRetroactiveTag,
  type RetroactiveMatch,
} from "@/actions/tag-rules";

type Step = "ask" | "range" | "loading" | "results" | "done";

type DateRange = "30d" | "90d" | "1y" | "all";

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "1y", label: "Last year" },
  { value: "all", label: "All time" },
];

function sinceFromRange(range: DateRange): string {
  const now = new Date();
  if (range === "30d") {
    now.setDate(now.getDate() - 30);
  } else if (range === "90d") {
    now.setDate(now.getDate() - 90);
  } else if (range === "1y") {
    now.setFullYear(now.getFullYear() - 1);
  } else {
    return new Date(0).toISOString();
  }
  return now.toISOString();
}

interface Props {
  ruleId: string;
  tagName: string;
  onDone: () => void;
}

export function RetroactiveRuleModal({ ruleId, tagName, onDone }: Props) {
  const [step, setStep] = useState<Step>("ask");
  const [range, setRange] = useState<DateRange>("90d");
  const [matches, setMatches] = useState<RetroactiveMatch[]>([]);
  const [tagId, setTagId] = useState<string>("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [resultMsg, setResultMsg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleSearch() {
    setStep("loading");
    setError(null);
    startTransition(async () => {
      try {
        const res = await previewRetroactiveRule(ruleId, sinceFromRange(range));
        setTagId(res.tagId);
        setMatches(res.matches);
        setChecked(new Set(res.matches.map((m) => m.id)));
        setStep("results");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setStep("range");
      }
    });
  }

  function handleApply() {
    const selectedIds = [...checked];
    startTransition(async () => {
      try {
        const res = await applyRetroactiveTag(selectedIds, tagId);
        setResultMsg(
          `${res.applied} transaction${res.applied !== 1 ? "s" : ""} tagged "${tagName}"`
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
          <CardTitle className="text-base">Apply rule retroactively</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto space-y-4">

          {step === "ask" && (
            <div className="space-y-4">
              <p className="text-sm">
                Would you like to search your existing transactions and apply the{" "}
                <strong>{tagName}</strong> tag to any that match this rule?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setStep("range")}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Yes, search history
                </button>
                <button
                  onClick={onDone}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          {step === "range" && (
            <div className="space-y-4">
              <p className="text-sm font-medium">How far back should we search?</p>
              <div className="space-y-2">
                {DATE_RANGE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="range"
                      value={opt.value}
                      checked={range === opt.value}
                      onChange={() => setRange(opt.value)}
                      className="accent-primary"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-3">
                <button
                  onClick={handleSearch}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Search →
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
            <p className="text-sm text-muted-foreground">Searching transactions…</p>
          )}

          {step === "results" && (
            <div className="space-y-4">
              {matches.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No matching transactions found in the selected period.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Found <strong>{matches.length}</strong> transaction
                    {matches.length !== 1 ? "s" : ""} matching{" "}
                    <strong>{tagName}</strong>. Uncheck any you want to skip.
                  </p>

                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                          <th className="px-3 py-2 w-8">
                            <input
                              type="checkbox"
                              checked={checked.size === matches.length}
                              onChange={(e) =>
                                setChecked(
                                  e.target.checked
                                    ? new Set(matches.map((m) => m.id))
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
                        </tr>
                      </thead>
                      <tbody>
                        {matches.map((m) => (
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
                            <td className="px-3 py-2 max-w-[200px] truncate">
                              {m.payeeRaw}
                              {!m.isExactMatch && (
                                <Badge
                                  variant="outline"
                                  className="ml-1.5 text-xs text-muted-foreground"
                                >
                                  partial match
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{m.amount}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {m.existingTags.map((t) => (
                                  <Badge key={t} variant="secondary" className="text-xs">
                                    {t}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-3">
                {matches.length > 0 && (
                  <button
                    onClick={handleApply}
                    disabled={checked.size === 0}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Apply to {checked.size} selected
                  </button>
                )}
                <button
                  onClick={onDone}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {matches.length === 0 ? "Close" : "Cancel"}
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
