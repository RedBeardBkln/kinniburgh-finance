"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createRecurringExpense,
  deleteRecurringExpense,
} from "@/actions/recurring-expenses";
import { monthlyEquivalentCents, FREQUENCY_LABELS } from "@/lib/recurring-expenses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUSD } from "@/lib/utils";

type Expense = {
  id: string;
  name: string;
  amountCents: number;
  frequency: string;
  dueDay: number | null;
  nextDueDate: Date | null;
  tagId: string | null;
  notes: string | null;
  tag: { id: string; shortName: string; name: string } | null;
};

type Entity = { id: string; name: string };
type Tag = { id: string; name: string; shortName: string };

type SortKey = "name" | "amount" | "dueDay";

interface Props {
  expenses: Expense[];
  entities: Entity[];
  tags: Tag[];
  defaultEntityId: string;
}

const FREQUENCIES = ["monthly", "weekly", "biweekly", "quarterly", "annually"] as const;

export function RecurringExpensesSection({ expenses, entities, tags, defaultEntityId }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Add form state
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<typeof FREQUENCIES[number]>("monthly");
  const [dueDay, setDueDay] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [tagId, setTagId] = useState("");
  const [notes, setNotes] = useState("");
  const [entityId, setEntityId] = useState(defaultEntityId);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = [...expenses].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "name") cmp = a.name.localeCompare(b.name);
    else if (sortKey === "amount")
      cmp = monthlyEquivalentCents(a.amountCents, a.frequency) - monthlyEquivalentCents(b.amountCents, b.frequency);
    else if (sortKey === "dueDay") cmp = (a.dueDay ?? 99) - (b.dueDay ?? 99);
    return sortDir === "asc" ? cmp : -cmp;
  });

  function SortBtn({ k, label }: { k: SortKey; label: string }) {
    const active = sortKey === k;
    return (
      <button
        onClick={() => toggleSort(k)}
        className={`text-left font-medium transition-colors ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        {label}
        {active && <span className="ml-0.5">{sortDir === "asc" ? " ↑" : " ↓"}</span>}
      </button>
    );
  }

  async function handleAdd() {
    const amountDollars = parseFloat(amount);
    if (!name.trim() || isNaN(amountDollars) || amountDollars <= 0) {
      setAddError("Name and a positive amount are required.");
      return;
    }
    setSaving(true);
    setAddError(null);
    const result = await createRecurringExpense({
      entityId,
      name: name.trim(),
      amountCents: Math.round(amountDollars * 100),
      frequency,
      dueDay: dueDay ? parseInt(dueDay, 10) : null,
      nextDueDate: nextDueDate || null,
      tagId: tagId || null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if ("error" in result) {
      setAddError(result.error);
      return;
    }
    setShowAdd(false);
    setName(""); setAmount(""); setDueDay(""); setNextDueDate(""); setTagId(""); setNotes("");
    router.refresh();
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this recurring expense?")) return;
    setDeletingId(id);
    startTransition(async () => {
      await deleteRecurringExpense(id);
      setDeletingId(null);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Recurring Expenses</span>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {showAdd ? "Cancel" : "+ Add Expense"}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {/* Add form */}
        {showAdd && (
          <div className="border-b px-4 py-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="text-xs text-muted-foreground">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Internet bill"
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Amount ($)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Frequency</label>
                <select
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as typeof FREQUENCIES[number])}
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Due day (1–31)</label>
                <input
                  type="number"
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                  placeholder="e.g. 15"
                  min="1"
                  max="31"
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Next due date</label>
                <input
                  type="date"
                  value={nextDueDate}
                  onChange={(e) => setNextDueDate(e.target.value)}
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Budget category</label>
                <select
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">— None —</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              {entities.length > 1 && (
                <div>
                  <label className="text-xs text-muted-foreground">Entity</label>
                  <select
                    value={entityId}
                    onChange={(e) => setEntityId(e.target.value)}
                    className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="text-xs text-muted-foreground">Notes (optional)</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Autopays on the 15th"
                  className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            {addError && (
              <p className="text-xs text-destructive rounded bg-destructive/10 px-2 py-1">{addError}</p>
            )}
            <button
              onClick={handleAdd}
              disabled={saving}
              className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Expense"}
            </button>
          </div>
        )}

        {/* Table */}
        {sorted.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No recurring expenses yet. Add one to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2"><SortBtn k="name" label="Name" /></th>
                  <th className="px-4 py-2">Frequency</th>
                  <th className="px-4 py-2 text-right"><SortBtn k="amount" label="Amount" /></th>
                  <th className="px-4 py-2 text-right">Monthly equiv.</th>
                  <th className="px-4 py-2"><SortBtn k="dueDay" label="Due" /></th>
                  <th className="px-4 py-2">Budget line</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((exp) => {
                  const monthly = monthlyEquivalentCents(exp.amountCents, exp.frequency);
                  return (
                    <tr
                      key={exp.id}
                      className={`border-b last:border-0 hover:bg-muted/30 ${deletingId === exp.id ? "opacity-50" : ""}`}
                    >
                      <td className="px-4 py-2 font-medium">
                        {exp.name}
                        {exp.notes && <span className="block text-xs text-muted-foreground font-normal">{exp.notes}</span>}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {FREQUENCY_LABELS[exp.frequency] ?? exp.frequency}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatUSD(exp.amountCents / 100)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {exp.frequency === "monthly"
                          ? "—"
                          : formatUSD(monthly / 100)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {exp.nextDueDate
                          ? exp.nextDueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
                          : exp.dueDay
                          ? `${exp.dueDay}${ordinal(exp.dueDay)}`
                          : "—"}
                      </td>
                      <td className="px-4 py-2">
                        {exp.tag ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{exp.tag.shortName}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          onClick={() => handleDelete(exp.id)}
                          disabled={deletingId === exp.id}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td className="px-4 py-2 text-xs font-medium text-muted-foreground" colSpan={3}>
                    Total monthly
                  </td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">
                    {formatUSD(
                      sorted.reduce((s, e) => s + monthlyEquivalentCents(e.amountCents, e.frequency), 0) / 100
                    )}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0]!;
}
