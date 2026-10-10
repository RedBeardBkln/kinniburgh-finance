"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addOilPrice, removeOilPrice } from "@/actions/seasonal-settings";
import type { UiOilPrices } from "@/lib/seasonal-energy-view";

// The owner's heating-oil price per gallon for ONE entity: a small inline form plus the short list of prices already
// entered (newest first). Only the typed values are sent; the server action validates them again (price above zero and
// at most $20 with up to 4 decimals, a real date not far in the future, a short note) and decides what is saved. A
// removed price is kept as history on the server, only hidden here. Nothing here computes a number.

export function OilPriceForm({ prices }: { prices: UiOilPrices }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const id = useId();
  const field = "mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await addOilPrice({ entityId: prices.entityId, effectiveOn: date, pricePerGal: price, ...(note.trim() !== "" ? { note } : {}) });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setPrice("");
      setDate("");
      setNote("");
      router.refresh();
    });
  }

  function remove(entryId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeOilPrice({ entityId: prices.entityId, id: entryId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3" data-testid="oil-price-form">
      <div>
        <p className="text-sm font-medium">Heating oil price per gallon</p>
        <p className="text-xs text-muted-foreground">
          Enter what you paid per gallon and the date it took effect. The estimate needs at least two prices at least six
          months apart (for example last winter and now), because the payments do not show gallons. Nothing is guessed.
        </p>
      </div>

      {prices.corrupt && (
        <p className="text-xs text-amber-700">
          The saved price list could not be read, so it is shown empty and nothing can be added until it is repaired.
        </p>
      )}

      <form
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) save();
        }}
      >
        <div>
          <label htmlFor={`${id}-price`} className="text-xs font-medium">
            Price per gallon ($)
          </label>
          <input
            id={`${id}-price`}
            className={field}
            inputMode="decimal"
            autoComplete="off"
            placeholder="3.499"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={pending || prices.corrupt}
            required
          />
        </div>
        <div>
          <label htmlFor={`${id}-date`} className="text-xs font-medium">
            Effective date
          </label>
          <input
            id={`${id}-date`}
            className={field}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={pending || prices.corrupt}
            required
          />
        </div>
        <div>
          <label htmlFor={`${id}-note`} className="text-xs font-medium">
            Note (optional)
          </label>
          <input
            id={`${id}-note`}
            className={field}
            maxLength={120}
            autoComplete="off"
            placeholder="e.g. delivery on the invoice"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending || prices.corrupt}
          />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={pending || prices.corrupt}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {pending ? "Saving..." : "Save price"}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {prices.rows.length > 0 ? (
        <ul className="divide-y rounded border bg-background text-sm" aria-label="Prices entered">
          {prices.rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
              <span>
                <span className="font-medium tabular-nums">{row.price}</span> a gallon from {row.date}
                {row.note ? <span className="text-muted-foreground"> ({row.note})</span> : null}
              </span>
              <button
                type="button"
                onClick={() => remove(row.id)}
                disabled={pending}
                className="text-xs text-muted-foreground hover:text-destructive hover:underline disabled:opacity-50"
                aria-label={`Remove the price from ${row.date}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No prices entered yet.</p>
      )}
    </div>
  );
}
