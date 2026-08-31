"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateIncomeSource } from "@/actions/income-sources";

interface Account {
  id: string;
  entityId: string;
  nickname: string;
  mask: string | null;
}

interface Props {
  id: string;
  entityId: string;
  description: string;
  cadence: string;
  amount: string;
  accountId: string;
  dayRules: unknown;
  accounts: Account[];
}

type Cadence = "semi_monthly" | "biweekly" | "monthly" | "weekly";

const CADENCE_LABELS: Record<Cadence, string> = {
  semi_monthly: "Semi-monthly (twice/month)",
  biweekly: "Bi-weekly (every 2 weeks)",
  monthly: "Monthly",
  weekly: "Weekly",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Parses stored dayRules into editable state, per cadence. */
function parseRules(cadence: string, rules: unknown) {
  const r = (rules ?? {}) as Record<string, unknown>;
  if (cadence === "semi_monthly") {
    const days = Array.isArray(r.daysOfMonth) ? (r.daysOfMonth as number[]) : [15, 30];
    return { semiDay1: days[0] ?? 15, semiDay2: days[1] ?? 30, biweeklyAnchor: "", monthlyDay: 1, weeklyDay: 1 };
  }
  if (cadence === "biweekly") {
    const anchor = typeof r.anchorDate === "string" ? r.anchorDate : new Date().toISOString().slice(0, 10);
    return { semiDay1: 15, semiDay2: 30, biweeklyAnchor: anchor, monthlyDay: 1, weeklyDay: 1 };
  }
  if (cadence === "monthly") {
    return { semiDay1: 15, semiDay2: 30, biweeklyAnchor: "", monthlyDay: typeof r.dayOfMonth === "number" ? r.dayOfMonth : 1, weeklyDay: 1 };
  }
  return {
    semiDay1: 15,
    semiDay2: 30,
    biweeklyAnchor: "",
    monthlyDay: 1,
    weeklyDay: typeof r.dayOfWeek === "number" ? r.dayOfWeek : 1,
  };
}

export function EditIncomeSourceButton(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const entityAccounts = props.accounts.filter((a) => a.entityId === props.entityId);

  const initial = parseRules(props.cadence, props.dayRules);
  const [accountId, setAccountId] = useState(props.accountId);
  const [description, setDescription] = useState(props.description);
  const [cadence, setCadence] = useState(props.cadence as Cadence);
  const [amount, setAmount] = useState(props.amount);
  const [semiDay1, setSemiDay1] = useState(initial.semiDay1);
  const [semiDay2, setSemiDay2] = useState(initial.semiDay2);
  const [biweeklyAnchor, setBiweeklyAnchor] = useState(initial.biweeklyAnchor);
  const [monthlyDay, setMonthlyDay] = useState(initial.monthlyDay);
  const [weeklyDay, setWeeklyDay] = useState(initial.weeklyDay);

  function buildDayRules(): unknown {
    if (cadence === "semi_monthly") return { daysOfMonth: [semiDay1, semiDay2] };
    if (cadence === "biweekly") return { intervalDays: 14, anchorDate: biweeklyAnchor };
    if (cadence === "monthly") return { dayOfMonth: monthlyDay };
    return { dayOfWeek: weeklyDay };
  }

  function handleSave() {
    setError(null);
    setSavedMsg(null);

    if (!description.trim()) {
      setError("Description is required.");
      return;
    }
    if (!accountId) {
      setError("Select a deposit account.");
      return;
    }
    if (cadence === "biweekly" && !biweeklyAnchor) {
      setError("Bi-weekly cadence needs an anchor date.");
      return;
    }

    startTransition(async () => {
      const result = await updateIncomeSource(props.id, {
        accountId,
        description: description.trim(),
        cadence,
        amount,
        dayRules: buildDayRules(),
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setSavedMsg("Saved — forecast updated.");
        setTimeout(() => setOpen(false), 800);
        router.refresh();
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-primary hover:underline"
      >
        {open ? "Close" : "Edit"}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-background p-5 shadow-lg space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Edit income source</h3>
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                />
              </div>

              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Deposits into (direct deposit account)
                </label>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  {entityAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname}{a.mask ? ` (x${a.mask})` : ""}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Changing this re-points where the forecast projects the deposits.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Cadence</label>
                <select
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as Cadence)}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  {(Object.keys(CADENCE_LABELS) as Cadence[]).map((c) => (
                    <option key={c} value={c}>{CADENCE_LABELS[c]}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  step="0.01"
                  min="0.01"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums"
                />
              </div>

              {cadence === "semi_monthly" && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">First day of month</label>
                    <input
                      type="number"
                      value={semiDay1}
                      onChange={(e) => setSemiDay1(Number(e.target.value))}
                      min={1} max={31}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Second day of month</label>
                    <input
                      type="number"
                      value={semiDay2}
                      onChange={(e) => setSemiDay2(Number(e.target.value))}
                      min={1} max={31}
                      className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    />
                  </div>
                </>
              )}

              {cadence === "biweekly" && (
                <div className="space-y-1 sm:col-span-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Anchor date (a recent pay date)
                  </label>
                  <input
                    type="date"
                    value={biweeklyAnchor}
                    onChange={(e) => setBiweeklyAnchor(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Every 14 days from this date. Use a real pay date for accurate forecasting.
                  </p>
                </div>
              )}

              {cadence === "monthly" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Day of month</label>
                  <input
                    type="number"
                    value={monthlyDay}
                    onChange={(e) => setMonthlyDay(Number(e.target.value))}
                    min={1} max={31}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
              )}

              {cadence === "weekly" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Day of week</label>
                  <select
                    value={weeklyDay}
                    onChange={(e) => setWeeklyDay(Number(e.target.value))}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  >
                    {DAY_NAMES.map((name, i) => (
                      <option key={i} value={i}>{name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {savedMsg && <p className="text-sm text-green-600">{savedMsg}</p>}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isPending}
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}