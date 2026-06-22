"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createScheduledTransfer,
  updateScheduledTransfer,
  deleteScheduledTransfer,
} from "@/actions/envelope";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface SerializedTransfer {
  id: string;
  fromAccountId: string;
  fromNickname: string;
  fromMask: string | null;
  toAccountId: string;
  toNickname: string;
  toMask: string | null;
  amount: string;
  cadence: string;
  dayRules: Record<string, unknown>;
  purpose: string | null;
  active: boolean;
}

interface Account {
  id: string;
  nickname: string;
  mask: string | null;
}

interface Props {
  transfers: SerializedTransfer[];
  accounts: Account[];
}

type ModalState =
  | null
  | { mode: "add" }
  | { mode: "edit"; transfer: SerializedTransfer };

function cadenceLabel(cadence: string, dayRules: Record<string, unknown>): string {
  if (cadence === "weekly") {
    const dow = typeof dayRules["dayOfWeek"] === "number" ? dayRules["dayOfWeek"] : 1;
    return `Weekly (${DAY_NAMES[dow]})`;
  }
  if (cadence === "semi_monthly") {
    const days = Array.isArray(dayRules["daysOfMonth"]) ? dayRules["daysOfMonth"] : [1, 15];
    return `Semi-monthly (${(days as number[]).join("th & ")}th)`;
  }
  if (cadence === "monthly") return "Monthly";
  return cadence;
}

function buildDayRules(cadence: string, dayOfWeek: string, day1: string, day2: string): Record<string, unknown> {
  if (cadence === "weekly") return { dayOfWeek: parseInt(dayOfWeek, 10) };
  if (cadence === "semi_monthly") return { daysOfMonth: [parseInt(day1, 10), parseInt(day2, 10)] };
  return {};
}

function DayRuleInputs({ cadence, dayRules }: { cadence: string; dayRules?: Record<string, unknown> }) {
  const defaultDow = typeof dayRules?.["dayOfWeek"] === "number" ? dayRules["dayOfWeek"].toString() : "1";
  const defaultDays = Array.isArray(dayRules?.["daysOfMonth"]) ? dayRules["daysOfMonth"] as number[] : [1, 15];

  if (cadence === "weekly") {
    return (
      <div className="space-y-1">
        <label className="text-sm font-medium">Day of Week</label>
        <select name="dayOfWeek" defaultValue={defaultDow} className="w-full rounded border px-3 py-2 text-sm">
          {DAY_NAMES.map((name, i) => (
            <option key={i} value={i}>{name}</option>
          ))}
        </select>
      </div>
    );
  }
  if (cadence === "semi_monthly") {
    return (
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">First day</label>
          <input name="day1" type="number" min="1" max="28" defaultValue={defaultDays[0]} className="w-full rounded border px-3 py-2 text-sm" required />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Second day</label>
          <input name="day2" type="number" min="1" max="28" defaultValue={defaultDays[1]} className="w-full rounded border px-3 py-2 text-sm" required />
        </div>
      </div>
    );
  }
  return null;
}

function TransferModal({ modal, accounts, onClose }: { modal: ModalState & { mode: "add" | "edit" }; accounts: Account[]; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cadence, setCadence] = useState<string>(modal.mode === "edit" ? modal.transfer.cadence : "monthly");

  const isEdit = modal.mode === "edit";
  const t = isEdit ? modal.transfer : null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);

    const dayRules = buildDayRules(
      cadence,
      fd.get("dayOfWeek") as string ?? "1",
      fd.get("day1") as string ?? "1",
      fd.get("day2") as string ?? "15",
    );

    startTransition(async () => {
      try {
        if (isEdit) {
          const amount = fd.get("amount") as string;
          await updateScheduledTransfer({ id: t!.id, amount, dayRules, active: t!.active });
        } else {
          await createScheduledTransfer({
            fromAccountId: fd.get("fromAccountId") as string,
            toAccountId: fd.get("toAccountId") as string,
            amount: fd.get("amount") as string,
            cadence: cadence as "weekly" | "semi_monthly" | "monthly",
            dayRules,
            purpose: (fd.get("purpose") as string) || undefined,
          });
        }
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">
          {isEdit ? "Edit Transfer" : "Add Scheduled Transfer"}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* From account */}
          <div className="space-y-1">
            <label className="text-sm font-medium">From Account</label>
            {isEdit ? (
              <p className="rounded border bg-muted px-3 py-2 text-sm">
                {t!.fromNickname}{t!.fromMask ? ` ···${t!.fromMask}` : ""}
              </p>
            ) : (
              <select name="fromAccountId" className="w-full rounded border px-3 py-2 text-sm" required>
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.nickname}{a.mask ? ` ···${a.mask}` : ""}</option>
                ))}
              </select>
            )}
          </div>

          {/* To account */}
          <div className="space-y-1">
            <label className="text-sm font-medium">To Account</label>
            {isEdit ? (
              <p className="rounded border bg-muted px-3 py-2 text-sm">
                {t!.toNickname}{t!.toMask ? ` ···${t!.toMask}` : ""}
              </p>
            ) : (
              <select name="toAccountId" className="w-full rounded border px-3 py-2 text-sm" required>
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.nickname}{a.mask ? ` ···${a.mask}` : ""}</option>
                ))}
              </select>
            )}
          </div>

          {/* Amount */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Amount</label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={t?.amount ?? ""}
                placeholder="0.00"
                className="w-full rounded border px-3 py-2 text-sm"
                required
              />
            </div>
          </div>

          {/* Cadence */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Cadence</label>
            {isEdit ? (
              <p className="rounded border bg-muted px-3 py-2 text-sm capitalize">{t!.cadence.replace("_", " ")}</p>
            ) : (
              <select
                name="cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                className="w-full rounded border px-3 py-2 text-sm"
              >
                <option value="weekly">Weekly</option>
                <option value="semi_monthly">Semi-monthly</option>
                <option value="monthly">Monthly</option>
              </select>
            )}
          </div>

          {/* Day rules */}
          <DayRuleInputs cadence={isEdit ? t!.cadence : cadence} dayRules={t?.dayRules} />

          {/* Purpose */}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Purpose <span className="font-normal text-muted-foreground">(optional)</span></label>
              <input name="purpose" type="text" maxLength={200} placeholder="e.g. Slush Funds / Home projects" className="w-full rounded border px-3 py-2 text-sm" />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={isPending} className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ScheduledTransfersClient({ transfers, accounts }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalState>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function onDelete(id: string) {
    if (!confirm("Delete this scheduled transfer? This cannot be undone.")) return;
    setDeletingId(id);
    startTransition(async () => {
      await deleteScheduledTransfer(id);
      setDeletingId(null);
      router.refresh();
    });
  }

  function onTogglePause(t: SerializedTransfer) {
    startTransition(async () => {
      await updateScheduledTransfer({ id: t.id, active: !t.active });
      router.refresh();
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Scheduled Transfers</span>
            <button
              onClick={() => setModal({ mode: "add" })}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              + Add Transfer
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Cadence</th>
                <th className="px-4 py-2 font-medium">Purpose</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                    No scheduled transfers yet.
                  </td>
                </tr>
              )}
              {transfers.map((t) => (
                <tr key={t.id} className={`border-b last:border-0 hover:bg-muted/30 ${!t.active ? "opacity-50" : ""} ${deletingId === t.id ? "opacity-30" : ""}`}>
                  <td className="px-4 py-2">
                    <span className="font-medium">{t.fromNickname}</span>
                    {t.fromMask && <span className="ml-1 font-mono text-xs text-muted-foreground">···{t.fromMask}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-medium">{t.toNickname}</span>
                    {t.toMask && <span className="ml-1 font-mono text-xs text-muted-foreground">···{t.toMask}</span>}
                  </td>
                  <td className="px-4 py-2 font-medium tabular-nums">
                    ${parseFloat(t.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {cadenceLabel(t.cadence, t.dayRules)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{t.purpose ?? "—"}</td>
                  <td className="px-4 py-2">
                    <Badge variant={t.active ? "default" : "outline"}>
                      {t.active ? "Active" : "Paused"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-3">
                      <button onClick={() => setModal({ mode: "edit", transfer: t })} className="text-xs text-primary hover:underline">Edit</button>
                      <button onClick={() => onTogglePause(t)} className="text-xs text-muted-foreground hover:text-foreground">
                        {t.active ? "Pause" : "Resume"}
                      </button>
                      <button onClick={() => onDelete(t.id)} disabled={deletingId === t.id} className="text-xs text-destructive hover:underline disabled:opacity-50">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {modal && (modal.mode === "add" || modal.mode === "edit") && (
        <TransferModal modal={modal} accounts={accounts} onClose={() => setModal(null)} />
      )}
    </>
  );
}
