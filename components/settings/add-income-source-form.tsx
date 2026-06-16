"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createIncomeSource } from "@/actions/income-sources";

interface Entity {
  id: string;
  name: string;
}

interface Account {
  id: string;
  entityId: string;
  nickname: string;
  mask: string | null;
}

interface Props {
  entities: Entity[];
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

const today = new Date().toISOString().slice(0, 10);

export function AddIncomeSourceForm({ entities, accounts }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [accountId, setAccountId] = useState("");
  const [description, setDescription] = useState("");
  const [cadence, setCadence] = useState<Cadence>("semi_monthly");
  const [amount, setAmount] = useState("");

  // dayRules state per cadence
  const [semiDay1, setSemiDay1] = useState(15);
  const [semiDay2, setSemiDay2] = useState(30);
  const [biweeklyAnchor, setBiweeklyAnchor] = useState(today);
  const [monthlyDay, setMonthlyDay] = useState(1);
  const [weeklyDay, setWeeklyDay] = useState(1); // 1=Mon

  const entityAccounts = accounts.filter((a) => a.entityId === entityId);

  function buildDayRules(): unknown {
    if (cadence === "semi_monthly") return { daysOfMonth: [semiDay1, semiDay2] };
    if (cadence === "biweekly") return { intervalDays: 14, anchorDate: biweeklyAnchor };
    if (cadence === "monthly") return { dayOfMonth: monthlyDay };
    return { dayOfWeek: weeklyDay };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const selectedAccountId = accountId || entityAccounts[0]?.id;
    if (!selectedAccountId) {
      setError("Select an account");
      return;
    }

    startTransition(async () => {
      const result = await createIncomeSource({
        entityId,
        accountId: selectedAccountId,
        description,
        cadence,
        amount,
        dayRules: buildDayRules(),
      });

      if ("error" in result) {
        setError(result.error);
      } else {
        setDescription("");
        setAmount("");
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Add income source</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Entity</label>
          <select
            value={entityId}
            onChange={(e) => { setEntityId(e.target.value); setAccountId(""); }}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            {entities.map((en) => (
              <option key={en.id} value={en.id}>{en.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Account (deposit to)</label>
          <select
            value={accountId || (entityAccounts[0]?.id ?? "")}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            {entityAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname}{a.mask ? ` (x${a.mask})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Eric payroll"
            required
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
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
            placeholder="5500.00"
            required
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </div>

        {/* Cadence-specific dayRules fields */}
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
              Anchor date (first occurrence)
            </label>
            <input
              type="date"
              value={biweeklyAnchor}
              onChange={(e) => setBiweeklyAnchor(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
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

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Add income source"}
      </button>
    </form>
  );
}
