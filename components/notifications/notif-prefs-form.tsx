"use client";

import { useState } from "react";
import { updateNotifPrefs, type NotifPrefs } from "@/actions/notifications";

const PREF_TYPES = [
  { key: "overspend" as const, label: "Budget overspend", description: "Alert when spending reaches a percentage of budget." },
  { key: "low_balance" as const, label: "Low balance projection", description: "Alert when an account is projected to fall below its minimum balance." },
  { key: "accrual_shortfall" as const, label: "Accrual shortfall", description: "Alert when an accrual envelope is underfunded before its draw season." },
  { key: "bill_due" as const, label: "Bill reminders", description: "Alert a few days before a scheduled bill autopays." },
  { key: "anomaly" as const, label: "Spending anomaly", description: "Alert when tag spending is significantly above historical average." },
];

interface Props {
  initialPrefs: NotifPrefs;
}

export function NotifPrefsForm({ initialPrefs }: Props) {
  const [prefs, setPrefs] = useState<NotifPrefs>(initialPrefs);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function setEnabled(key: keyof NotifPrefs, enabled: boolean) {
    setPrefs((p) => ({ ...p, [key]: { ...(p[key] ?? {}), enabled } }));
    setSaved(false);
  }

  function setThreshold(key: "overspend", threshold: number) {
    setPrefs((p) => ({ ...p, [key]: { ...(p[key] ?? { enabled: true }), threshold } }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    await updateNotifPrefs(prefs);
    setSaving(false);
    setSaved(true);
  }

  return (
    <div className="space-y-4">
      {PREF_TYPES.map(({ key, label, description }) => {
        const pref = prefs[key] ?? { enabled: true };
        const enabled = "enabled" in pref ? pref.enabled : true;
        return (
          <div key={key} className="flex items-start gap-4 rounded-lg border p-4">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(key, e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
              id={`pref-${key}`}
            />
            <div className="flex-1 min-w-0">
              <label htmlFor={`pref-${key}`} className="cursor-pointer text-sm font-medium">
                {label}
              </label>
              <p className="text-xs text-muted-foreground">{description}</p>
              {key === "overspend" && enabled && (
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">Alert at</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={"threshold" in pref ? (pref as { threshold?: number }).threshold ?? 80 : 80}
                    onChange={(e) => setThreshold("overspend", Number(e.target.value))}
                    className="w-16 rounded border px-2 py-0.5 text-xs"
                  />
                  <span className="text-xs text-muted-foreground">% of budget</span>
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
        {saved && <span className="text-sm text-green-600">Saved</span>}
      </div>
    </div>
  );
}
