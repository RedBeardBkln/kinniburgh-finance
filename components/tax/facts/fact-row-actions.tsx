"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retireTaxFact, setTaxFact, setTaxFactPolicy } from "@/actions/tax-facts";
import { ModalShell } from "@/components/tax/forms/modal-shell";
import { parseDollarsToCents } from "@/lib/tax-facts/group";
import { POLICY_LABELS } from "@/lib/tax-facts/format";
import {
  CARRY_POLICIES,
  FACT_CATEGORIES,
  FACT_CATEGORY_LABELS,
  VALUE_KINDS,
  type CarryPolicy,
  type FactCategory,
  type FactValueKind,
} from "@/lib/tax-facts/types";

// Small client leaves for /tax/facts: edit (a new version), change the carry-forward policy, retire / resolve, add.
// Every write goes through the server actions (each starts with requireAuth()); nothing is deleted. The modal is the
// repo's ModalShell (no window.confirm). Fields hold plain text: the server re-validates everything.

export interface FactActionsProps {
  factKey: string;
  label: string;
  valueKind: FactValueKind;
  valueText: string | null;
  valueCents: number | null;
  carryPolicy: CarryPolicy;
  taxYear: number;
}

const VALUE_KIND_LABELS: Readonly<Record<FactValueKind, string>> = {
  text: "Text",
  choice: "Choice (a short id)",
  bool: "Yes / no",
  percent: "Percent",
  money_cents: "Amount",
  none_statement: "Statement that there is none",
  open_item: "Open item",
};

export const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
export const button = "rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-60";

function centsToDollarsText(cents: number | null): string {
  if (cents === null) return "";
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}

export function ValueInput({
  kind,
  text,
  setText,
}: {
  kind: FactValueKind;
  text: string;
  setText: (v: string) => void;
}) {
  if (kind === "bool") {
    return (
      <select value={text} onChange={(e) => setText(e.target.value)} className={field} aria-label="Value">
        <option value="">Choose...</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (kind === "text" || kind === "none_statement" || kind === "open_item") {
    return <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={600} className={field} aria-label="Value" />;
  }
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      className={field}
      inputMode={kind === "percent" || kind === "money_cents" ? "decimal" : "text"}
      placeholder={kind === "money_cents" ? "Dollars, for example 14,300" : kind === "percent" ? "0 to 100" : "lower_case_id"}
      aria-label="Value"
    />
  );
}

export function useFactAction(onDone: () => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(call: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await call();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }
  return { pending, error, run };
}

function EditModal({ fact, onClose }: { fact: FactActionsProps; onClose: () => void }) {
  const [text, setText] = useState(fact.valueKind === "money_cents" ? centsToDollarsText(fact.valueCents) : (fact.valueText ?? ""));
  const [year, setYear] = useState(String(fact.taxYear));
  const [reason, setReason] = useState("");
  const { pending, error, run } = useFactAction(onClose);

  function save() {
    const cents = fact.valueKind === "money_cents" ? parseDollarsToCents(text) : null;
    if (fact.valueKind === "money_cents" && cents === null) {
      run(async () => ({ ok: false, error: "Enter the amount in dollars, for example 14,300 or 14300.50." }));
      return;
    }
    run(() =>
      setTaxFact({
        mode: "change",
        factKey: fact.factKey,
        taxYear: Number(year),
        valueCents: cents,
        valueText: fact.valueKind === "money_cents" ? null : text,
        reason,
      })
    );
  }

  return (
    <ModalShell title={`Change: ${fact.label}`} onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Saving adds a new version; the earlier version stays in the history. The value is what you tell the app; the
          return does not read it.
        </p>
        <label className="block space-y-1">
          <span className="text-xs">New value</span>
          <ValueInput kind={fact.valueKind} text={text} setText={setText} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Tax year this applies from</span>
          <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Reason (required, 3 to 500 characters; never put an SSN, EIN, account number or birth date here)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={field} />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={pending} className={button}>
            {pending ? "Saving..." : "Save new version"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PolicyModal({ fact, onClose }: { fact: FactActionsProps; onClose: () => void }) {
  const [policy, setPolicy] = useState<CarryPolicy>(fact.carryPolicy);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useFactAction(onClose);
  return (
    <ModalShell title={`Carry-forward policy: ${fact.label}`} onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          This changes what happens when a new tax year starts. The value and the year you confirmed it for do not change.
        </p>
        <label className="block space-y-1">
          <span className="text-xs">Policy</span>
          <select value={policy} onChange={(e) => setPolicy(e.target.value as CarryPolicy)} className={field}>
            {CARRY_POLICIES.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Reason (optional)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={field} />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => run(() => setTaxFactPolicy({ factKey: fact.factKey, carryPolicy: policy, reason }))}
            disabled={pending}
            className={button}
          >
            {pending ? "Saving..." : "Save policy"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function RetireModal({ fact, isOpenItem, onClose }: { fact: FactActionsProps; isOpenItem: boolean; onClose: () => void }) {
  const [year, setYear] = useState(String(Math.max(fact.taxYear, new Date().getUTCFullYear())));
  const [reason, setReason] = useState("");
  const { pending, error, run } = useFactAction(onClose);
  const verb = isOpenItem ? "Resolve" : "Retire";
  return (
    <ModalShell title={`${verb}: ${fact.label}`} onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {isOpenItem
            ? "Resolving records that this item is settled. It stays in the history; nothing is deleted."
            : "Retiring records that this fact no longer applies from the year below. It stays in the history; nothing is deleted."}
        </p>
        <label className="block space-y-1">
          <span className="text-xs">{isOpenItem ? "Tax year resolved" : "First tax year it no longer applies"}</span>
          <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Reason (required; never put an SSN, EIN, account number or birth date here)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={field} />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => run(() => retireTaxFact({ factKey: fact.factKey, taxYear: Number(year), reason }))}
            disabled={pending}
            className={button}
          >
            {pending ? "Saving..." : verb}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function FactActions({ fact, isOpenItem }: { fact: FactActionsProps; isOpenItem: boolean }) {
  const [open, setOpen] = useState<"edit" | "policy" | "retire" | null>(null);
  const close = () => setOpen(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={button} onClick={() => setOpen("edit")}>
        Change
      </button>
      {!isOpenItem && (
        <button type="button" className={button} onClick={() => setOpen("policy")}>
          Policy
        </button>
      )}
      <button type="button" className={button} onClick={() => setOpen("retire")}>
        {isOpenItem ? "Resolve" : "Retire"}
      </button>
      {open === "edit" && <EditModal fact={fact} onClose={close} />}
      {open === "policy" && <PolicyModal fact={fact} onClose={close} />}
      {open === "retire" && <RetireModal fact={fact} isOpenItem={isOpenItem} onClose={close} />}
    </div>
  );
}

function AddModal({ onClose }: { onClose: () => void }) {
  const [factKey, setFactKey] = useState("");
  const [category, setCategory] = useState<FactCategory>("household");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<FactValueKind>("text");
  const [text, setText] = useState("");
  const [policy, setPolicy] = useState<CarryPolicy>("reconfirm");
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const { pending, error, run } = useFactAction(onClose);

  function save() {
    const cents = kind === "money_cents" ? parseDollarsToCents(text) : null;
    if (kind === "money_cents" && cents === null) {
      run(async () => ({ ok: false, error: "Enter the amount in dollars, for example 14,300 or 14300.50." }));
      return;
    }
    const isOpen = kind === "open_item";
    run(() =>
      setTaxFact({
        mode: "create",
        factKey,
        category: isOpen ? "open_item" : category,
        label,
        valueKind: kind,
        valueCents: cents,
        valueText: kind === "money_cents" ? null : text,
        carryPolicy: isOpen ? "stable" : policy,
        taxYear: Number(year),
      })
    );
  }

  return (
    <ModalShell title="Add a fact" onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Record something you are telling the app. Never include a Social Security number, EIN, account number or birth date.
        </p>
        <label className="block space-y-1">
          <span className="text-xs">Key (dotted lower-case words, for example property.cabin.use)</span>
          <input value={factKey} onChange={(e) => setFactKey(e.target.value)} className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Title</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} className={field} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs">Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as FactValueKind)} className={field}>
              {VALUE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {VALUE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs">Category</span>
            <select
              value={kind === "open_item" ? "open_item" : category}
              onChange={(e) => setCategory(e.target.value as FactCategory)}
              disabled={kind === "open_item"}
              className={field}
            >
              {FACT_CATEGORIES.filter((c) => c !== "open_item").map((c) => (
                <option key={c} value={c}>
                  {FACT_CATEGORY_LABELS[c]}
                </option>
              ))}
              {kind === "open_item" && <option value="open_item">{FACT_CATEGORY_LABELS.open_item}</option>}
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs">Value</span>
          <ValueInput kind={kind} text={text} setText={setText} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs">Tax year</span>
            <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className={field} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs">When a new year starts</span>
            <select
              value={kind === "open_item" ? "stable" : policy}
              onChange={(e) => setPolicy(e.target.value as CarryPolicy)}
              disabled={kind === "open_item"}
              className={field}
            >
              {CARRY_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={pending} className={button}>
            {pending ? "Saving..." : "Add fact"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function AddFactButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={button} onClick={() => setOpen(true)}>
        Add a fact
      </button>
      {open && <AddModal onClose={() => setOpen(false)} />}
    </>
  );
}
