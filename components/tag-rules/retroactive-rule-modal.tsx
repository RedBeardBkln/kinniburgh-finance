"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  previewRetroactiveRule,
  applyRetroactiveTag,
  getAccountsForSearch,
  type RetroactiveMatch,
  type AccountOption,
} from "@/actions/tag-rules";

// The Payee column of the results table can be dragged wider (or nudged with the arrow keys) to read a whole description.
const PAYEE_WIDTH_KEY = "retro-rule-payee-width";
const PAYEE_WIDTH_DEFAULT = 200;
const PAYEE_WIDTH_MIN = 120;
const PAYEE_WIDTH_MAX = 900;

function clampPayeeWidth(n: number): number {
  return Math.min(PAYEE_WIDTH_MAX, Math.max(PAYEE_WIDTH_MIN, Math.round(n)));
}

function loadPayeeWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(PAYEE_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampPayeeWidth(saved) : PAYEE_WIDTH_DEFAULT;
  } catch {
    return PAYEE_WIDTH_DEFAULT;
  }
}

type Step = "ask" | "accounts" | "range" | "loading" | "results" | "done";

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
  /** Pre-select this account in the account picker (the current transaction's account). */
  initialAccountId?: string;
  onDone: () => void;
  /** Called as soon as transactions were tagged, so the list behind the dialog can reload right away. */
  onApplied?: () => void;
}

export function RetroactiveRuleModal({ ruleId, tagName, initialAccountId, onDone, onApplied }: Props) {
  const [step, setStep] = useState<Step>("ask");
  const [range, setRange] = useState<DateRange>("90d");
  const [matches, setMatches] = useState<RetroactiveMatch[]>([]);
  const [tagId, setTagId] = useState<string>("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [resultMsg, setResultMsg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Payee column width (remembered between uses)
  const [payeeWidth, setPayeeWidth] = useState<number>(loadPayeeWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function savePayeeWidth(width: number) {
    try {
      window.localStorage.setItem(PAYEE_WIDTH_KEY, String(width));
    } catch {
      // storage unavailable: the width just is not remembered
    }
  }

  function onResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: payeeWidth };
  }

  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag) setPayeeWidth(clampPayeeWidth(drag.startWidth + e.clientX - drag.startX));
  }

  function onResizeUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    savePayeeWidth(payeeWidth);
  }

  function onResizeKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampPayeeWidth(payeeWidth + (e.key === "ArrowRight" ? 20 : -20));
    setPayeeWidth(next);
    savePayeeWidth(next);
  }

  function resetPayeeWidth() {
    setPayeeWidth(PAYEE_WIDTH_DEFAULT);
    savePayeeWidth(PAYEE_WIDTH_DEFAULT);
  }

  // Account selection
  const [availableAccounts, setAvailableAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  // Fetch accounts when the accounts step is entered
  useEffect(() => {
    if (step !== "accounts") return;
    setLoadingAccounts(true);
    getAccountsForSearch().then((accounts) => {
      setAvailableAccounts(accounts);
      // Pre-select the current transaction's account, or all if none provided
      if (initialAccountId) {
        setSelectedAccountIds(new Set([initialAccountId]));
      } else {
        setSelectedAccountIds(new Set(accounts.map((a) => a.id)));
      }
      setLoadingAccounts(false);
    });
  }, [step, initialAccountId]);

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSearch() {
    setStep("loading");
    setError(null);
    startTransition(async () => {
      try {
        const accountIds = selectedAccountIds.size > 0
          ? [...selectedAccountIds]
          : undefined;
        const res = await previewRetroactiveRule(ruleId, sinceFromRange(range), accountIds);
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
        onApplied?.();
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
      <Card className={`w-full ${step === "results" ? "max-w-5xl" : "max-w-2xl"} max-h-[90vh] flex flex-col shadow-xl`}>
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
                  onClick={() => setStep("accounts")}
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

          {step === "accounts" && (
            <div className="space-y-4">
              <p className="text-sm font-medium">Which accounts should we search?</p>
              {loadingAccounts ? (
                <p className="text-sm text-muted-foreground">Loading accounts…</p>
              ) : (
                <>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedAccountIds(new Set(availableAccounts.map((a) => a.id)))
                      }
                      className="underline hover:text-foreground"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedAccountIds(new Set())}
                      className="underline hover:text-foreground"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="space-y-2 max-h-56 overflow-y-auto rounded-md border p-3">
                    {availableAccounts.map((acct) => (
                      <label
                        key={acct.id}
                        className="flex items-center gap-2 text-sm cursor-pointer select-none"
                      >
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.has(acct.id)}
                          onChange={() => toggleAccount(acct.id)}
                          className="accent-primary"
                        />
                        <span className="font-medium">{acct.nickname}</span>
                        {acct.mask && (
                          <span className="text-muted-foreground">···{acct.mask}</span>
                        )}
                        <span className="text-muted-foreground text-xs">
                          {acct.institutionName}
                        </span>
                      </label>
                    ))}
                  </div>
                  {selectedAccountIds.size === 0 && (
                    <p className="text-xs text-destructive">
                      Select at least one account to continue.
                    </p>
                  )}
                </>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setStep("range")}
                  disabled={selectedAccountIds.size === 0 || loadingAccounts}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Next →
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

          {step === "range" && (
            <div className="space-y-4">
              <p className="text-sm font-medium">How far back should we search?</p>
              <p className="text-xs text-muted-foreground">
                Searching {selectedAccountIds.size}{" "}
                account{selectedAccountIds.size !== 1 ? "s" : ""}.{" "}
                <button
                  type="button"
                  onClick={() => setStep("accounts")}
                  className="underline hover:text-foreground"
                >
                  Change
                </button>
              </p>
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

                  <div className="rounded-md border overflow-x-auto">
                    <table className="w-max min-w-full text-sm">
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
                          <th
                            className="relative px-3 py-2 font-medium"
                            style={{ width: payeeWidth, minWidth: payeeWidth, maxWidth: payeeWidth }}
                          >
                            Payee
                            <div
                              role="separator"
                              aria-orientation="vertical"
                              aria-label="Payee column width. Drag, or use the left and right arrow keys, to resize. Double-click to reset."
                              aria-valuenow={payeeWidth}
                              aria-valuemin={PAYEE_WIDTH_MIN}
                              aria-valuemax={PAYEE_WIDTH_MAX}
                              tabIndex={0}
                              title="Drag to widen the Payee column (double-click to reset)"
                              onPointerDown={onResizeDown}
                              onPointerMove={onResizeMove}
                              onPointerUp={onResizeUp}
                              onKeyDown={onResizeKey}
                              onDoubleClick={resetPayeeWidth}
                              className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none select-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
                            />
                          </th>
                          <th className="px-3 py-2 font-medium text-right">Amount</th>
                          <th className="px-3 py-2 font-medium">Account</th>
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
                            <td
                              className="px-3 py-2 truncate"
                              style={{ width: payeeWidth, minWidth: payeeWidth, maxWidth: payeeWidth }}
                              title={m.payeeRaw ?? undefined}
                            >
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
                            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">
                              {m.accountNickname}
                              {m.accountMask && <span> ···{m.accountMask}</span>}
                            </td>
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

              <div className="flex gap-3 items-center">
                {matches.length > 0 && (
                  <button
                    onClick={handleApply}
                    disabled={checked.size === 0 || isPending}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isPending ? (
                      <>
                        <svg
                          className="h-3.5 w-3.5 animate-spin"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Applying…
                      </>
                    ) : (
                      `Apply to ${checked.size} selected`
                    )}
                  </button>
                )}
                <button
                  onClick={onDone}
                  disabled={isPending}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:pointer-events-none"
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
