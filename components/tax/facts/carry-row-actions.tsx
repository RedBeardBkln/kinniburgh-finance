"use client";

import { useState } from "react";
import { reconfirmTaxFact } from "@/actions/tax-facts";
import { changeTaxFactForCarry } from "@/actions/tax-facts-carry";
import { ModalShell } from "@/components/tax/forms/modal-shell";
import { ValueInput, button, field, useFactAction } from "@/components/tax/facts/fact-row-actions";
import { formatFactValue } from "@/lib/tax-facts/format";
import { parseDollarsToCents } from "@/lib/tax-facts/group";
import type { FactValueKind } from "@/lib/tax-facts/types";

// Per-fact buttons for the carry screen /tax/facts/carry/[year]. Every button acts on exactly ONE fact: there is no
// selection, no "all" and no batch call anywhere in this file. Each write goes through a server action that starts with
// requireAuth() and refuses TY2025 and earlier; nothing is deleted (a new version is added). The modal is the repo's
// ModalShell (no window.confirm).

export interface CarryActionsProps {
  factKey: string;
  label: string;
  valueKind: FactValueKind;
  valueText: string | null;
  valueCents: number | null;
  /** The year this value was last confirmed for (shown next to every value). */
  fromTaxYear: number;
  targetYear: number;
  canStillTrue: boolean;
  canChange: boolean;
  canAnswer: boolean;
  canSameAnswer: boolean;
}

function centsToText(cents: number | null): string {
  if (cents === null) return "";
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}

function StillTrueModal({ fact, onClose }: { fact: CarryActionsProps; onClose: () => void }) {
  const [note, setNote] = useState("");
  const { pending, error, run } = useFactAction(onClose);
  return (
    <ModalShell title={`Still true for TY${fact.targetYear}: ${fact.label}`} onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="rounded-md border bg-muted/40 px-3 py-2">
          <span className="block text-xs text-muted-foreground">
            Value from TY{fact.fromTaxYear}, to be recorded again for TY{fact.targetYear}
          </span>
          <span className="break-words">{formatFactValue(fact)}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          This records only that you say this fact is still true for TY{fact.targetYear}. It adds a new version; the earlier
          one stays in the history. It is not verified by documents and the return does not read it.
        </p>
        <label className="block space-y-1">
          <span className="text-xs">Note (optional; never put an SSN, EIN, account number or birth date here)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={field} />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              run(() =>
                reconfirmTaxFact({ factKey: fact.factKey, taxYear: fact.targetYear, reason: note.trim() === "" ? null : note })
              )
            }
            disabled={pending}
            className={button}
          >
            {pending ? "Saving..." : `Confirm for TY${fact.targetYear}`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/** "It changed" (value pre-filled from the earlier year) and "Answer for TY<year>" (an EMPTY box, never pre-filled). */
function ChangeModal({ fact, fresh, onClose }: { fact: CarryActionsProps; fresh: boolean; onClose: () => void }) {
  const initial = fresh ? "" : fact.valueKind === "money_cents" ? centsToText(fact.valueCents) : (fact.valueText ?? "");
  const [text, setText] = useState(initial);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useFactAction(onClose);

  function save() {
    const cents = fact.valueKind === "money_cents" ? parseDollarsToCents(text) : null;
    if (fact.valueKind === "money_cents" && cents === null) {
      run(async () => ({ ok: false, error: "Enter the amount in dollars, for example 14,300 or 14300.50." }));
      return;
    }
    run(() =>
      changeTaxFactForCarry({
        factKey: fact.factKey,
        taxYear: fact.targetYear,
        valueCents: cents,
        valueText: fact.valueKind === "money_cents" ? null : text,
        reason,
      })
    );
  }

  return (
    <ModalShell
      title={fresh ? `Answer for TY${fact.targetYear}: ${fact.label}` : `It changed: ${fact.label}`}
      onClose={onClose}
      busy={pending}
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {fresh
            ? `This fact is asked fresh each year. The TY${fact.fromTaxYear} value is not carried: ${formatFactValue(fact)}.`
            : `Saving adds a new version for TY${fact.targetYear}; the earlier version stays in the history.`}{" "}
          The value is what you tell the app; the return does not read it.
        </p>
        <label className="block space-y-1">
          <span className="text-xs">{fresh ? `Your answer for TY${fact.targetYear}` : "New value"}</span>
          <ValueInput kind={fact.valueKind} text={text} setText={setText} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Reason (required, 3 to 500 characters; never put an SSN, EIN, account number or birth date here)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={field} />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          {fresh && fact.canSameAnswer && (
            <button
              type="button"
              onClick={() => run(() => reconfirmTaxFact({ factKey: fact.factKey, taxYear: fact.targetYear, reason: null }))}
              disabled={pending}
              className={button}
              title={`Records the TY${fact.fromTaxYear} value again for TY${fact.targetYear}, for this one fact`}
            >
              Same answer as TY{fact.fromTaxYear}
            </button>
          )}
          <button type="button" onClick={save} disabled={pending} className={button}>
            {pending ? "Saving..." : "Save new version"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function CarryRowActions({ fact }: { fact: CarryActionsProps }) {
  const [open, setOpen] = useState<"still" | "change" | "answer" | null>(null);
  const close = () => setOpen(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      {fact.canStillTrue && (
        <button type="button" className={button} onClick={() => setOpen("still")}>
          Still true for TY{fact.targetYear}
        </button>
      )}
      {fact.canChange && (
        <button type="button" className={button} onClick={() => setOpen("change")}>
          It changed
        </button>
      )}
      {fact.canAnswer && (
        <button type="button" className={button} onClick={() => setOpen("answer")}>
          Answer for TY{fact.targetYear}
        </button>
      )}
      {open === "still" && <StillTrueModal fact={fact} onClose={close} />}
      {open === "change" && <ChangeModal fact={fact} fresh={false} onClose={close} />}
      {open === "answer" && <ChangeModal fact={fact} fresh onClose={close} />}
    </div>
  );
}
