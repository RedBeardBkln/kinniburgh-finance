"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";
import { TableScroll } from "@/components/ui/table-scroll";
import { cn } from "@/lib/utils";
import { fetchBenchtopTime, linkClientToBenchtop, listBenchtopClients, saveBenchtopKey, syncBenchtopTime, type ImportableEntry } from "@/actions/benchtop-time";
import { formatCents, parseQuantityMilli } from "@/lib/invoicing/money";
import {
  TIME_GROUPINGS,
  TIME_GROUPING_LABELS,
  TIME_ROUNDINGS,
  TIME_ROUNDING_LABELS,
  buildTimeLines,
  nyWorkDate,
  parseHourlyRate,
  type TimeGrouping,
  type TimeLine,
  type TimeRounding,
} from "@/lib/invoicing/benchtop/time-lines";
import { ErrorLine, Field, INPUT, OkLine, useRunner } from "@/components/invoicing/shared";

// Benchtop time import screens (CLAUDE.md "Benchtop time import"): the connection key (Invoicing settings), a client's link and
// default rate (client page), the import dialog (invoice editor) and the billed-in-Benchtop status of an issued or void invoice.

const dollarsText = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const hoursOf = (minutes: number) => (minutes / 60).toFixed(2);

// ── Invoicing settings ───────────────────────────────────────────────────────────

export function BenchtopKeyForm({ slug, keyLast4 }: { slug: string; keyLast4: string | null }) {
  const { pending, error, ok, run } = useRunner();
  const [key, setKey] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {keyLast4 ? (
          <>
            Connected with the key ending <strong>…{keyLast4}</strong>. Stored encrypted.
          </>
        ) : (
          "Not connected."
        )}{" "}
        Make the key in Benchtop (Settings &gt; Invoicing connection) and paste it here. Invoices can then import a client&apos;s unbilled Benchtop time, and
        issuing or voiding an invoice marks that time billed or unbilled in Benchtop.
      </p>
      <div className="flex max-w-xl items-end gap-2">
        <Field label={keyLast4 ? "Replace key" : "Connection key"} className="flex-1">
          <input className={INPUT} placeholder="btk_…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Button variant="outline" disabled={pending || key.trim() === ""} onClick={() => run(() => saveBenchtopKey({ slug, key }), { okMessage: "Benchtop connected.", onSuccess: () => setKey("") })}>
          {pending ? "Checking…" : "Save"}
        </Button>
      </div>
      {keyLast4 ? (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => saveBenchtopKey({ slug, key: "" }), { okMessage: "Benchtop disconnected." })}>
          Disconnect
        </Button>
      ) : null}
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}

// ── Client page ──────────────────────────────────────────────────────────────────

export function BenchtopClientLink({
  slug,
  clientId,
  linkedId,
  rateCents,
  connected,
  readOnly,
}: {
  slug: string;
  clientId: string;
  linkedId: string | null;
  rateCents: number | null;
  connected: boolean;
  readOnly: boolean;
}) {
  const { pending, error, ok, run, setError } = useRunner();
  const [options, setOptions] = useState<{ id: string; name: string }[] | null>(null);
  const [choice, setChoice] = useState(linkedId ?? "");
  const [rate, setRate] = useState(rateCents === null ? "" : dollarsText(rateCents));

  useEffect(() => {
    if (!connected || readOnly) return;
    let live = true;
    listBenchtopClients({ slug }).then(
      (r) => {
        if (!live) return;
        if ("error" in r) setError(r.error);
        else setOptions(r.clients);
      },
      () => live && setError("The Benchtop clients could not be loaded.")
    );
    return () => {
      live = false;
    };
  }, [slug, connected, readOnly, setError]);

  if (!connected) {
    return <p className="text-sm text-muted-foreground">Benchtop is not connected. Save a connection key in Invoicing settings to import time for this client.</p>;
  }
  const linkedName = options?.find((o) => o.id === linkedId)?.name;
  if (readOnly) {
    return (
      <p className="text-sm">
        {linkedId ? "Linked to a Benchtop client." : "Not linked to a Benchtop client."} Hourly rate: {rateCents === null ? "not set" : `${formatCents(rateCents)}/hr`}.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Time logged for the linked Benchtop client can be imported into this client&apos;s invoices. The rate fills in imported lines; you can change it on each import or line.
      </p>
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Field label="Benchtop client">
          <select className={INPUT} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={options === null}>
            <option value="">{options === null ? "Loading…" : "Not linked"}</option>
            {options?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            {linkedId && options !== null && !linkedName ? <option value={linkedId}>(a client no longer in Benchtop)</option> : null}
          </select>
        </Field>
        <Field label="Hourly rate ($)">
          <input className={INPUT} inputMode="decimal" placeholder="175.00" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
      </div>
      <Button
        variant="outline"
        disabled={pending || options === null}
        onClick={() => run(() => linkClientToBenchtop({ slug, clientId, benchtopClientId: choice || null, hourlyRate: rate }), { okMessage: "Saved." })}
      >
        {pending ? "Saving…" : "Save"}
      </Button>
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}

// ── Invoice editor: the import dialog ─────────────────────────────────────────────

/** Local calendar day "YYYY-MM-DD" -> the ISO time of that midnight (the browser's zone, the owner's own). */
function dayStartIso(day: string, plusDays = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays).toISOString();
}

export interface ImportedTime {
  lines: TimeLine[];
  rate: string;
}

export function BenchtopImportDialog({
  slug,
  clientId,
  clientName,
  benchtopClientId,
  documentId,
  defaultRateCents,
  inEditor,
  onCancel,
  onImport,
}: {
  slug: string;
  clientId: string;
  clientName: string;
  /** The client's linked Benchtop client (kept as is when the rate is saved) */
  benchtopClientId: string;
  documentId: string | null;
  defaultRateCents: number | null;
  /** Entry ids already on this editor's lines */
  inEditor: Set<string>;
  onCancel: () => void;
  onImport: (t: ImportedTime) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ImportableEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<TimeGrouping>("entry");
  const [rounding, setRounding] = useState<TimeRounding>("exact");
  const [rate, setRate] = useState(defaultRateCents === null ? "" : dollarsText(defaultRateCents));
  const [saveRate, setSaveRate] = useState(false);
  const [saving, setSaving] = useState(false);

  const blockedBy = (e: ImportableEntry) => (inEditor.has(e.id) ? "already on this invoice" : e.inUse ? (e.inUse === "draft" ? "on another draft" : `on invoice ${e.inUse}`) : null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchBenchtopTime({ slug, clientId, documentId, from: from ? dayStartIso(from) : null, to: to ? dayStartIso(to, 1) : null });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setEntries(r.entries);
      setTruncated(r.truncated);
      setPicked(new Set(r.entries.filter((e) => !inEditor.has(e.id) && !e.inUse).map((e) => e.id)));
      if (rate === "" && r.rateCents !== null) setRate(dollarsText(r.rateCents));
    } catch {
      setError("The Benchtop time could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  const chosen = useMemo(() => (entries ?? []).filter((e) => picked.has(e.id)), [entries, picked]);
  const preview = useMemo(() => buildTimeLines(chosen, { grouping, rounding }), [chosen, grouping, rounding]);
  const rateCents = parseHourlyRate(rate);
  const totalCents =
    rateCents === null ? null : preview.lines.reduce((s, l) => s + Math.round(((parseQuantityMilli(l.quantity) ?? 0) * rateCents) / 1000), 0);
  const billedHours = preview.lines.reduce((s, l) => s + (parseQuantityMilli(l.quantity) ?? 0), 0) / 1000;

  function toggle(id: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function add() {
    if (rateCents === null) return setError("Enter the hourly rate in dollars, for example 175 or 175.50.");
    if (preview.lines.length === 0) return setError("Choose some time to add.");
    if (saveRate) {
      setSaving(true);
      try {
        const r = await linkClientToBenchtop({ slug, clientId, benchtopClientId, hourlyRate: rate }).catch(() => ({ error: "The client's rate could not be saved." }));
        if ("error" in r) return setError(r.error);
      } finally {
        setSaving(false);
      }
    }
    onImport({ lines: preview.lines, rate: dollarsText(rateCents) });
  }

  return (
    <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-label="Import time from Benchtop">
      <div className={cn(modalPanelClass("2xl"), "space-y-4 bg-background p-5 shadow-lg")}>
        <h2 className="text-base font-semibold">Import time from Benchtop: {clientName}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From (optional)">
            <input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (optional)">
            <input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : entries ? "Reload" : "Show unbilled time"}
            </Button>
          </div>
        </div>
        <ErrorLine message={error} />
        {entries !== null && entries.length === 0 ? <p className="text-sm text-muted-foreground">No unbilled time for this client{from || to ? " in those dates" : ""}.</p> : null}
        {truncated ? <p className="text-xs text-yellow-800">Only the most recent 2,000 entries were loaded. Narrow the dates to see the rest.</p> : null}
        {entries && entries.length > 0 ? (
          <>
            <TableScroll className="max-h-72 overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="w-8 px-2 py-2">
                      <input
                        type="checkbox"
                        aria-label="Choose all"
                        checked={entries.filter((e) => !blockedBy(e)).every((e) => picked.has(e.id))}
                        onChange={(ev) => setPicked(ev.target.checked ? new Set(entries.filter((e) => !blockedBy(e)).map((e) => e.id)) : new Set())}
                      />
                    </th>
                    <th className="py-2">Date</th>
                    <th className="text-right">Hours</th>
                    <th className="px-2">Work</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const blocked = blockedBy(e);
                    return (
                      <tr key={e.id} className={cn("border-b align-top last:border-0", blocked && "text-muted-foreground")}>
                        <td className="px-2 py-2">
                          <input type="checkbox" aria-label="Bill this entry" checked={picked.has(e.id)} disabled={blocked !== null} onChange={() => toggle(e.id)} />
                        </td>
                        <td className="whitespace-nowrap py-2">{nyWorkDate(e.startedAt)}</td>
                        <td className="py-2 text-right tabular-nums">{hoursOf(e.minutes)}</td>
                        <td className="px-2 py-2">
                          <span className="font-medium">{e.activity}</span>: {e.task}
                          <span className="block text-xs text-muted-foreground">
                            {[e.projectName, e.person, blocked].filter(Boolean).join(" · ")}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Lines">
                <select className={INPUT} value={grouping} onChange={(e) => setGrouping(e.target.value as TimeGrouping)}>
                  {TIME_GROUPINGS.map((g) => (
                    <option key={g} value={g}>
                      {TIME_GROUPING_LABELS[g]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Hours">
                <select className={INPUT} value={rounding} onChange={(e) => setRounding(e.target.value as TimeRounding)}>
                  {TIME_ROUNDINGS.map((r) => (
                    <option key={r} value={r}>
                      {TIME_ROUNDING_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Rate ($/hr)" hint={defaultRateCents === null ? "No rate is saved for this client." : `Client rate: ${formatCents(defaultRateCents)}/hr`}>
                <input className={INPUT} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
              </Field>
            </div>
            {rateCents !== null && rateCents !== defaultRateCents ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={saveRate} onChange={(e) => setSaveRate(e.target.checked)} />
                Also make {formatCents(rateCents)}/hr this client&apos;s rate
              </label>
            ) : null}
            <p className="text-sm">
              {chosen.length} {chosen.length === 1 ? "entry" : "entries"} → {preview.lines.length} {preview.lines.length === 1 ? "line" : "lines"}, {billedHours.toFixed(2)} hr
              {totalCents !== null ? `, about ${formatCents(totalCents)}` : ""}.
              {preview.skipped.length > 0 ? ` ${preview.skipped.length} short ${preview.skipped.length === 1 ? "entry rounds" : "entries round"} to zero and will be left unbilled.` : ""}
            </p>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => void add()} disabled={saving || preview.lines.length === 0}>
            Add {preview.lines.length > 0 ? preview.lines.length : ""} {preview.lines.length === 1 ? "line" : "lines"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Invoice page: billed in Benchtop ────────────────────────────────────────────

export function BenchtopSyncStatus({
  slug,
  documentId,
  entryCount,
  pending,
  canAct,
}: {
  slug: string;
  documentId: string;
  entryCount: number;
  pending: { direction: "bill" | "unbill"; failed: boolean } | null;
  canAct: boolean;
}) {
  const { pending: busy, error, ok, run } = useRunner();
  const what = `${entryCount} Benchtop time ${entryCount === 1 ? "entry" : "entries"}`;
  if (!pending) {
    return <p className="text-sm text-muted-foreground">This invoice bills {what}. Benchtop is up to date.</p>;
  }
  const verb = pending.direction === "bill" ? "marked billed" : "marked unbilled";
  return (
    <div className="space-y-2">
      <p className="text-sm text-yellow-900">
        This invoice bills {what}, but they have not been {verb} in Benchtop yet{pending.failed ? " (the last try failed)" : ""}.
      </p>
      {canAct ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run(() => syncBenchtopTime({ slug, documentId }), { okMessage: `Benchtop updated: the time is ${verb}.` })}
        >
          {busy ? "Updating…" : "Update Benchtop now"}
        </Button>
      ) : null}
      <ErrorLine message={error} />
      <OkLine message={ok} />
    </div>
  );
}
