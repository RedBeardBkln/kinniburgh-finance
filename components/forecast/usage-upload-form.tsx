"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addUtilityUsageMonth, previewUtilityUsage, saveUtilityUsage } from "@/actions/utility-usage";
import { formKey, saveBlockedReason } from "@/lib/utility-usage-form";
import type { ColumnRole, ParseOk, ParsedRow, RowStatus, UsageKind, UsageUnit } from "@/lib/utility-usage-parse";

// The "Add history" form of the Seasonal card: choose the utility, then upload a CSV file, paste rows, or type one month.
// Nothing is saved from here without a preview of exactly the text and column mapping on screen: the server parses the text
// (this component never sends parsed rows), the owner confirms the column for each role, sees every row with its status,
// warnings and errors, and only then saves. A change to the text, the utility, the unit or any column resets the preview and
// disables Save. All text shown comes back escaped by React. Nothing here computes a number.

type Mode = "file" | "paste" | "month";

function helpFor(kind: UsageKind, hasSolar: boolean): string {
  if (kind === "electric") {
    return `Enter the kWh you were billed for each month, bought from the grid${hasSolar ? " (net of what the solar panels sent back; a surplus can go in the note column, which is kept and shown but not modelled)" : ""}. Add the bill amount if you have it: with 12 or more months of amounts the app can measure your own price per kWh; without it the amounts are scaled from your payments. Months are written 2024-01, 1/2024 or Jan 2024 (month/day/year if a full date), or as a yearly recap with years down and month names across. A negative kWh is refused.`;
  }
  if (kind === "oil") {
    return "One row per delivery: date, gallons, and the amount if you have it. List every delivery from the first date you give through today; a month you leave out is treated as no delivery.";
  }
  return "One row per purchase with cords (or face cords; pick one) and the amount paid. A season with a purchase that has no amount is left out of the estimate.";
}

const ROLE_LABEL: Record<ColumnRole, string> = {
  month: "Month / date",
  periodEnd: "Period end (electric)",
  quantity: "Quantity",
  cost: "Amount billed ($)",
  unit: "Unit (firewood)",
  note: "Note",
  ignore: "Ignore this column",
};

const STATUS_LABEL: Record<RowStatus, string> = {
  new: "New",
  unchanged: "Already saved",
  conflict: "Different from saved",
  fills_cost: "Adds the amount",
  duplicate_in_file: "Repeat (ignored)",
  error: "Error",
};

const STATUS_CLASS: Record<RowStatus, string> = {
  new: "border-green-200 bg-green-50 text-green-700",
  unchanged: "border-muted-foreground/30 bg-muted text-muted-foreground",
  conflict: "border-amber-200 bg-amber-50 text-amber-700",
  fills_cost: "border-green-200 bg-green-50 text-green-700",
  duplicate_in_file: "border-muted-foreground/30 bg-muted text-muted-foreground",
  error: "border-red-200 bg-red-50 text-red-700",
};

const DELIM_NAME: Record<ParseOk["delimiter"], string> = { ",": "comma", "\t": "tab", ";": "semicolon", "|": "pipe" };

const field = "mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
const button = "rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50";

function rolesFor(kind: UsageKind): ColumnRole[] {
  return (["month", "periodEnd", "quantity", "cost", "unit", "note", "ignore"] as const).filter((r) => (r !== "periodEnd" || kind === "electric") && (r !== "unit" || kind === "firewood"));
}

function rowWhen(r: ParsedRow): string {
  return r.occurredOn ?? r.period ?? "";
}

export function UsageUploadForm({
  entityId,
  kinds,
  maxChars,
  hasSolar,
}: {
  entityId: string;
  kinds: Array<{ kind: UsageKind; title: string }>;
  maxChars: number;
  hasSolar: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const [kind, setKind] = useState<UsageKind>(kinds[0]?.kind ?? "electric");
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [unit, setUnit] = useState<UsageUnit>("cord");
  const [mapping, setMapping] = useState<ColumnRole[] | null>(null);
  const [preview, setPreview] = useState<ParseOk | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [skipBad, setSkipBad] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // one month at a time
  const [month, setMonth] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [replaceOne, setReplaceOne] = useState(false);

  const currentKey = formKey(kind, text, mapping ?? preview?.mapping ?? null, unit);
  const fresh = preview !== null && previewKey === currentKey;
  const errorRows = preview ? preview.rows.filter((r) => r.status === "error").length : 0;
  const blocked = saveBlockedReason({ preview, previewKey, currentKey, pending, skipBad });
  const canSave = blocked === null;

  function resetPreview() {
    setPreview(null);
    setPreviewKey(null);
    setReplace(new Set());
  }

  async function onFile(file: File | undefined) {
    setError(null);
    setMessage(null);
    if (!file) return;
    if (file.size > maxChars * 4) {
      setError(`That file is too large (the limit is ${maxChars.toLocaleString("en-US")} characters). Split the history into smaller files.`);
      return;
    }
    const content = await file.text();
    if (content.length > maxChars) {
      setError(`That file is too large (${content.length.toLocaleString("en-US")} characters; the limit is ${maxChars.toLocaleString("en-US")}). Split the history into smaller files.`);
      return;
    }
    setFileName(file.name);
    setText(content);
    setMapping(null);
    resetPreview();
  }

  function runPreview() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await previewUtilityUsage({ entityId, kind, text, ...(mapping ? { mapping } : {}), ...(kind === "firewood" ? { defaultUnit: unit } : {}) });
      if ("error" in r) {
        resetPreview();
        setError(r.error);
        return;
      }
      setPreview(r.preview);
      setMapping(r.preview.mapping);
      // The key of what the server actually used: the text, the confirmed mapping, the unit.
      setPreviewKey(formKey(kind, text, r.preview.mapping, unit));
      setReplace(new Set());
    });
  }

  function save() {
    if (!preview || !canSave) return;
    setError(null);
    startTransition(async () => {
      const r = await saveUtilityUsage({
        entityId,
        kind,
        text,
        mapping: preview.mapping,
        ...(kind === "firewood" ? { defaultUnit: unit } : {}),
        replaceKeys: [...replace],
        skipBadRows: skipBad,
      });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setMessage(
        r.inserted === 0
          ? "Nothing new to save: those rows are already saved (or were not ticked to replace)."
          : `Saved ${r.inserted} row${r.inserted === 1 ? "" : "s"}${r.replaced > 0 ? `, replacing ${r.replaced} (the old ${r.replaced === 1 ? "row is" : "rows are"} archived, not deleted)` : ""}.`
      );
      setText("");
      setFileName(null);
      setMapping(null);
      setSkipBad(false);
      resetPreview();
      router.refresh();
    });
  }

  function saveOne() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await addUtilityUsageMonth({
        entityId,
        kind,
        month,
        quantity: qty,
        ...(kind === "firewood" ? { unit } : {}),
        ...(cost.trim() !== "" ? { cost } : {}),
        ...(note.trim() !== "" ? { note } : {}),
        ...(replaceOne ? { replace: true } : {}),
      });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setMessage(r.inserted === 0 ? "That row is already saved with these values." : r.replaced > 0 ? "Saved. The old row is archived, not deleted." : "Saved.");
      setMonth("");
      setQty("");
      setCost("");
      setNote("");
      setReplaceOne(false);
      router.refresh();
    });
  }

  function toggleReplace(key: string) {
    setReplace((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const kindTitle = kinds.find((k) => k.kind === kind)?.title ?? kind;
  const qtyLabel = kind === "electric" ? "kWh" : kind === "oil" ? "Gallons" : unit === "face_cord" ? "Face cords" : "Cords";

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3" data-testid="usage-upload-form">
      <div>
        <p className="text-sm font-medium">Add history</p>
        <p className="text-xs text-muted-foreground">
          Upload or paste your past usage so the monthly estimates follow the real seasons. You see exactly what will be saved before anything is.
          A saved row is never deleted, only archived.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${id}-kind`} className="text-xs font-medium">
            Utility
          </label>
          <select
            id={`${id}-kind`}
            className={field}
            value={kind}
            disabled={pending}
            onChange={(e) => {
              setKind(e.target.value as UsageKind);
              setMapping(null);
              resetPreview();
              setError(null);
            }}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.title}
              </option>
            ))}
          </select>
        </div>
        {kind === "firewood" && (
          <div>
            <label htmlFor={`${id}-unit`} className="text-xs font-medium">
              Unit (when a row has none)
            </label>
            <select id={`${id}-unit`} className={field} value={unit} disabled={pending} onChange={(e) => setUnit(e.target.value as UsageUnit)}>
              <option value="cord">Cords</option>
              <option value="face_cord">Face cords</option>
            </select>
          </div>
        )}
        <div role="tablist" aria-label="How to add" className="flex gap-1">
          {(
            [
              ["file", "Upload file"],
              ["paste", "Paste"],
              ["month", "One month"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`rounded-md border px-3 py-1.5 text-sm ${mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => {
                setMode(m);
                setError(null);
                setMessage(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{helpFor(kind, hasSolar)}</p>

      {mode !== "month" && (
        <div className="space-y-2">
          {mode === "file" && (
            <div>
              <label htmlFor={`${id}-file`} className="text-xs font-medium">
                CSV or text file (up to {maxChars.toLocaleString("en-US")} characters)
              </label>
              <input
                id={`${id}-file`}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="mt-1 block w-full text-sm"
                disabled={pending}
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              {fileName && <p className="mt-1 text-xs text-muted-foreground">Read {fileName}.</p>}
            </div>
          )}
          {mode === "paste" && (
            <div>
              <label htmlFor={`${id}-text`} className="text-xs font-medium">
                Rows (month, quantity, optional amount; a header row is fine)
              </label>
              <textarea
                id={`${id}-text`}
                className={`${field} font-mono`}
                rows={6}
                spellCheck={false}
                autoComplete="off"
                placeholder={kind === "electric" ? "Month,kWh,Amount\n2024-01,850,142.18\n2024-02,790,131.40" : kind === "oil" ? "Date,Gallons,Amount\n2025-10-15,112.5,400.00" : "Date,Cords,Amount\n2025-10-01,2,500.00"}
                value={text}
                disabled={pending}
                onChange={(e) => {
                  if (e.target.value.length > maxChars) {
                    setError(`That is more than ${maxChars.toLocaleString("en-US")} characters. Paste a smaller part.`);
                    return;
                  }
                  setError(null);
                  setText(e.target.value);
                  setFileName(null);
                  setMapping(null);
                  resetPreview();
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={button} disabled={pending || text.trim() === ""} onClick={runPreview}>
              {pending ? "Reading..." : preview && !fresh ? "Preview again" : "Preview"}
            </button>
            {preview && !fresh && <span className="text-xs text-amber-700">Something changed since the preview. Preview again before saving.</span>}
          </div>
        </div>
      )}

      {mode === "month" && (
        <form
          className="grid gap-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending) saveOne();
          }}
        >
          <div>
            <label htmlFor={`${id}-m`} className="text-xs font-medium">
              {kind === "electric" ? "Month" : "Date"}
            </label>
            <input id={`${id}-m`} className={field} placeholder={kind === "electric" ? "2024-01 or Jan 2024" : "2025-10-15"} value={month} onChange={(e) => setMonth(e.target.value)} disabled={pending} required autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${id}-q`} className="text-xs font-medium">
              {qtyLabel}
            </label>
            <input id={`${id}-q`} className={field} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} disabled={pending} required autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${id}-c`} className="text-xs font-medium">
              Amount billed ($, optional)
            </label>
            <input id={`${id}-c`} className={field} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} disabled={pending} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${id}-n`} className="text-xs font-medium">
              Note (optional)
            </label>
            <input id={`${id}-n`} className={field} maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} autoComplete="off" />
          </div>
          <div className="flex flex-col justify-end gap-1">
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={replaceOne} onChange={(e) => setReplaceOne(e.target.checked)} disabled={pending} /> Replace a saved month
            </label>
            <button type="submit" disabled={pending} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {pending ? "Saving..." : `Save ${kindTitle}`}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-xs text-green-700">
          {message}
        </p>
      )}

      {mode !== "month" && preview && (
        <div className="space-y-2" data-testid="usage-preview">
          <p className="text-xs text-muted-foreground">
            {preview.wide
              ? `Read as a recap table (years down, month names across) and turned into one row per month. It holds kWh only: paste the bill amounts afterwards as month, kWh, amount rows and they are added to these months.`
              : `Read as ${DELIM_NAME[preview.delimiter]}-separated text${preview.hasHeader ? " with a header row" : " with no header row"}. Check which column is which:`}
          </p>
          <div className="flex flex-wrap gap-3" hidden={preview.wide}>
            {preview.columns.map((c) => (
              <div key={c.index} className="min-w-[8rem]">
                <label htmlFor={`${id}-col-${c.index}`} className="block text-xs font-medium">
                  Column {c.index + 1}
                  {c.header ? `: ${c.header}` : ""}
                </label>
                <select
                  id={`${id}-col-${c.index}`}
                  className={field}
                  value={(mapping ?? preview.mapping)[c.index] ?? "ignore"}
                  disabled={pending || preview.wide}
                  onChange={(e) => {
                    const next = [...(mapping ?? preview.mapping)];
                    next[c.index] = e.target.value as ColumnRole;
                    setMapping(next);
                  }}
                >
                  {rolesFor(kind).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <span className="block truncate text-xs text-muted-foreground">e.g. {c.sample || "(blank)"}</span>
              </div>
            ))}
          </div>

          {preview.mappingError && <p className="text-xs text-amber-700">{preview.mappingError}</p>}

          {!preview.mappingError && (
            <>
              <p className="text-xs">
                {preview.summary.rowCount} row{preview.summary.rowCount === 1 ? "" : "s"}
                {preview.summary.first ? ` (${preview.summary.first} to ${preview.summary.last})` : ""}: {preview.summary.counts.new + preview.summary.counts.fills_cost} to save,{" "}
                {preview.summary.counts.unchanged} already saved, {preview.summary.counts.conflict} different from saved, {preview.summary.counts.error} with errors.
              </p>
              <div className="max-h-80 overflow-auto rounded border bg-background">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-2 py-1 font-medium">Line</th>
                      <th className="px-2 py-1 font-medium">{kind === "electric" ? "Month" : "Date"}</th>
                      <th className="px-2 py-1 text-right font-medium">{qtyLabel}</th>
                      <th className="px-2 py-1 text-right font-medium">Amount</th>
                      <th className="px-2 py-1 font-medium">What will happen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={`${r.line}-${i}`} className="border-b align-top last:border-0">
                        <td className="px-2 py-1 tabular-nums text-muted-foreground">{r.line}</td>
                        <td className="px-2 py-1 tabular-nums">{rowWhen(r)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{r.quantity ?? ""}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{r.costCents === null ? "" : (r.costCents / 100).toFixed(2)}</td>
                        <td className="px-2 py-1">
                          <span className={`rounded-full border px-2 py-0.5 ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                          {r.status === "conflict" && r.key && (
                            <label className="ml-2 inline-flex items-center gap-1">
                              <input type="checkbox" checked={replace.has(r.key)} onChange={() => toggleReplace(r.key as string)} disabled={pending} /> Replace
                            </label>
                          )}
                          {r.errors.map((m) => (
                            <span key={m} className="block text-red-700">
                              {m}
                            </span>
                          ))}
                          {r.warnings.map((m) => (
                            <span key={m} className="block text-muted-foreground">
                              {m}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {errorRows > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={skipBad} onChange={(e) => setSkipBad(e.target.checked)} disabled={pending} />
                  Skip the {errorRows} row{errorRows === 1 ? "" : "s"} with errors and save the rest
                </label>
              )}
              <div className="flex items-center gap-3">
                <button type="button" onClick={save} disabled={!canSave} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  {pending ? "Saving..." : "Save"}
                </button>
                {blocked && !pending && <span className="text-xs text-muted-foreground">{blocked}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
