"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { archiveItem, createItem, updateItem } from "@/actions/reimbursable-items";
import { formatBps, formatCents, markupPriceCents, parsePercentToBps } from "@/lib/invoicing/money";
import { parseDollarsToCents } from "@/lib/money-input";
import type { GlOption, ItemView } from "@/lib/invoicing/catalog-build";
import { ErrorLine, Field, INPUT, OkLine, useRunner } from "@/components/invoicing/shared";

// Catalog item form. The billed price shown while typing is derived by the SAME pure function the server uses (markupPriceCents);
// the server re-derives it. Gross method is the unconfirmed default (owner question Q7): the cost stays an expense, the billed price is income.

export function ItemForm({ slug, glOptions, defaultGlId, item, onDone }: { slug: string; glOptions: GlOption[]; defaultGlId: string | null; item?: ItemView; onDone?: () => void }) {
  const { pending, error, ok, run } = useRunner();
  const [name, setName] = useState(item?.name ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "ea");
  const [cost, setCost] = useState(item ? (item.unitCostCents / 100).toFixed(2) : "");
  const [mode, setMode] = useState<"markup" | "fixed_price">((item?.pricingMode as "markup" | "fixed_price") ?? "markup");
  const [markup, setMarkup] = useState(item?.markupBps !== null && item?.markupBps !== undefined ? formatBps(item.markupBps) : "");
  const [fixed, setFixed] = useState(item?.billedUnitPriceCents != null ? (item.billedUnitPriceCents / 100).toFixed(2) : "");
  const [glCodeId, setGlCodeId] = useState(item?.glCodeId ?? defaultGlId ?? "");
  const [taxable, setTaxable] = useState(item?.taxable ?? false);

  const costParsed = parseDollarsToCents(cost, { allowZero: true });
  let preview: string | null = null;
  if (costParsed.ok) {
    if (mode === "markup") {
      const bps = markup.trim() === "" || /^0+(\.0+)?$/.test(markup.trim()) ? 0 : parsePercentToBps(markup);
      if (bps !== null) preview = formatCents(markupPriceCents(costParsed.cents, bps));
    } else {
      const f = parseDollarsToCents(fixed);
      if (f.ok) preview = formatCents(f.cents);
    }
  }

  function submit() {
    const base = { slug, name, unit, unitCost: cost, pricingMode: mode, markupPercent: mode === "markup" ? markup : null, billedUnitPrice: mode === "fixed_price" ? fixed : null, glCodeId, taxable };
    run(() => (item ? updateItem({ ...base, id: item.id }) : createItem(base)), {
      okMessage: "Saved.",
      onSuccess: () => {
        if (!item) {
          setName("");
          setCost("");
          setMarkup("");
          setFixed("");
        }
        onDone?.();
      },
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Item name">
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Unit (for example ea, mile)">
          <input className={INPUT} value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} />
        </Field>
        <Field label="Your cost per unit ($)">
          <input className={INPUT} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label="Pricing">
          <select className={INPUT} value={mode} onChange={(e) => setMode(e.target.value as "markup" | "fixed_price")}>
            <option value="markup">Cost plus markup</option>
            <option value="fixed_price">Fixed billed price</option>
          </select>
        </Field>
        {mode === "markup" ? (
          <Field label="Markup (%)" hint="Blank or 0 = billed at cost.">
            <input className={INPUT} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} />
          </Field>
        ) : (
          <Field label="Billed price per unit ($)">
            <input className={INPUT} inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} />
          </Field>
        )}
        <Field label="Income account for this item">
          <select className={INPUT} value={glCodeId} onChange={(e) => setGlCodeId(e.target.value)}>
            <option value="">Choose…</option>
            {glOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} {o.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
        Taxable item (a stored flag only; sales tax is not calculated)
      </label>
      <p className="text-sm text-muted-foreground">
        Billed price per unit: <strong>{preview ?? "—"}</strong>
        {preview && costParsed.ok ? ` (your cost ${formatCents(costParsed.cents)})` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        Billed gross (unconfirmed default): your cost stays a normal expense and the billed price is income, so the P&amp;L shows both. Catalog only: no stock counts.
      </p>
      <ErrorLine message={error} />
      <OkLine message={ok} />
      <div className="flex gap-2">
        <Button onClick={submit} disabled={pending}>
          {item ? "Save item" : "Add item"}
        </Button>
        {item ? (
          <>
            <Button variant="ghost" onClick={() => onDone?.()}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (window.confirm("Archive this item? Existing invoice lines keep their own copy of the price.")) run(() => archiveItem({ slug, id: item.id }), { onSuccess: () => onDone?.() });
              }}
            >
              Archive
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// `readOnly` is a plain boolean decided on the server from the owner rule; the item actions are owner-only as well.
export function ItemRow({ slug, item, glOptions, readOnly = false }: { slug: string; item: ItemView; glOptions: GlOption[]; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing && !readOnly) {
    return (
      <tr>
        <td colSpan={6} className="border-b py-3">
          <ItemForm slug={slug} glOptions={glOptions} defaultGlId={null} item={item} onDone={() => setEditing(false)} />
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 font-medium">{item.name}</td>
      <td>{item.unit}</td>
      <td className="text-right">{formatCents(item.unitCostCents)}</td>
      <td className="text-right">
        {formatCents(item.billedPriceCents)}
        <span className="ml-1 text-xs text-muted-foreground">{item.pricingMode === "markup" ? `(+${formatBps(item.markupBps ?? 0)}%)` : "(fixed)"}</span>
      </td>
      <td>{item.glLabel}</td>
      <td className="text-right">
        {readOnly ? null : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </td>
    </tr>
  );
}
