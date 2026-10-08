"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closeTaxYear, reopenTaxYear, type YearCloseActionResult } from "@/actions/tax-year-close";
import { ModalShell } from "@/components/tax/forms/modal-shell";
import { CLOSE_HONESTY, CLOSE_MIGRATION_MISSING, CLOSE_PRIVACY_WARNING } from "@/lib/tax-year-close/format";
import type { YearCloseView } from "@/lib/tax-year-close/state";
import { NOTE_MAX } from "@/lib/tax-year-close/types";

// The owner's control for marking a household tax year filed and reopening it for revision, with the year's history. Each write
// goes through a server action that starts with requireAuth() and checks that the signed-in account is the owner's; a non-owner
// sees the state read-only with the reason. The label is a soft record: it blocks nothing and changes no return. The modal is the
// repo's ModalShell (no browser confirm dialog).

export interface YearCloseCardProps {
  view: YearCloseView;
  /** The signed-in account is the owner's (computed on the server; the action checks it again). */
  canAct: boolean;
  /** Why the owner control is not offered (shown to any other account). */
  refusal: string | null;
  /** The migration for the close table has not been applied: nothing can be recorded yet. */
  migrationMissing: boolean;
  /** Business entity workspaces for this year whose own status is not "filed" (advice only; nothing is written to them). */
  pendingWorkspaces: string[];
  /** Today in New York as YYYY-MM-DD, a default for the date input. */
  today: string;
}

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
const button = "rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-60";

function useCloseAction(onDone: () => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(call: () => Promise<YearCloseActionResult>) {
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

function CloseModal({ props, onClose }: { props: YearCloseCardProps; onClose: () => void }) {
  const year = props.view.taxYear;
  const [filedOn, setFiledOn] = useState(props.today);
  const [note, setNote] = useState("");
  const { pending, error, run } = useCloseAction(onClose);
  return (
    <ModalShell title={`Mark TY${year} as filed`} onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">{CLOSE_HONESTY}</p>
        <label className="block space-y-1">
          <span className="text-xs">Date you filed (the later of the federal and Connecticut dates)</span>
          <input type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs">Note (optional, up to {NOTE_MAX} characters, for example how it was filed)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={NOTE_MAX} className={field} />
        </label>
        <p className="text-xs text-destructive">{CLOSE_PRIVACY_WARNING}</p>
        {props.pendingWorkspaces.length > 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            These entity workspaces for {year} do not say Filed yet: {props.pendingWorkspaces.join(", ")}. Marking the year filed does
            not change them; update them on their own pages if you want them to match.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button type="button" onClick={() => run(() => closeTaxYear({ taxYear: year, filedOn, note }))} disabled={pending} className={button}>
            {pending ? "Saving..." : `Mark TY${year} filed`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ReopenModal({ props, onClose }: { props: YearCloseCardProps; onClose: () => void }) {
  const year = props.view.taxYear;
  const [reason, setReason] = useState("");
  const { pending, error, run } = useCloseAction(onClose);
  return (
    <ModalShell title={`Reopen TY${year} for revision`} onClose={onClose} busy={pending}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Reopening adds a record; the earlier filing stays in the history and nothing is deleted. It changes no computation, form or
          approval.
        </p>
        <label className="block space-y-1">
          <span className="text-xs">Reason (required, 3 to {NOTE_MAX} characters)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={NOTE_MAX} className={field} />
        </label>
        <p className="text-xs text-destructive">{CLOSE_PRIVACY_WARNING}</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={button}>
            Cancel
          </button>
          <button type="button" onClick={() => run(() => reopenTaxYear({ taxYear: year, reason }))} disabled={pending} className={button}>
            {pending ? "Saving..." : "Reopen for revision"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function YearCloseCard(props: YearCloseCardProps) {
  const { view } = props;
  const [open, setOpen] = useState<"close" | "reopen" | null>(null);
  const close = () => setOpen(null);
  const status = view.status;
  const tone =
    status === "closed" ? "border-green-300 bg-green-50" : status === "reopened" ? "border-amber-300 bg-amber-50" : "border-border bg-card";
  return (
    <section className={`space-y-2 rounded-lg border px-4 py-3 ${tone}`} data-testid="year-close-card" aria-label={`TY${view.taxYear} filing status`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-sm">
          {status === "open" && (
            <>
              <p className="font-medium">TY{view.taxYear}: not marked filed</p>
              <p className="text-xs text-muted-foreground">
                When you have filed this return, mark the year filed so every page shows it is complete. You can reopen it later to
                revise it.
              </p>
            </>
          )}
          {status === "closed" && (
            <>
              <p className="font-medium text-green-900">
                TY{view.taxYear} filed {view.filedOn}
              </p>
              <p className="text-xs text-muted-foreground">
                Recorded by {view.closedByName}.{view.note ? ` Note: ${view.note}` : ""}
              </p>
            </>
          )}
          {status === "reopened" && (
            <>
              <p className="font-medium text-amber-900">TY{view.taxYear} reopened for revision</p>
              <p className="text-xs text-muted-foreground">
                Reopened {view.reopenedOn} by {view.reopenedByName}. Reason: {view.reopenReason}
                {view.filedOn ? ` Earlier filing date: ${view.filedOn}.` : ""}
              </p>
            </>
          )}
        </div>
        {props.migrationMissing ? null : props.canAct ? (
          <div className="flex gap-1.5">
            {status !== "closed" && (
              <button type="button" className={button} onClick={() => setOpen("close")}>
                {status === "reopened" ? "Mark filed again" : `Mark TY${view.taxYear} as filed`}
              </button>
            )}
            {status === "closed" && (
              <button type="button" className={button} onClick={() => setOpen("reopen")}>
                Reopen for revision
              </button>
            )}
          </div>
        ) : null}
      </div>
      {props.migrationMissing && <p className="text-xs text-amber-900">{CLOSE_MIGRATION_MISSING}</p>}
      {!props.migrationMissing && !props.canAct && props.refusal && <p className="text-xs text-muted-foreground">{props.refusal}</p>}
      <p className="text-xs text-muted-foreground">{CLOSE_HONESTY}</p>
      {view.history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            History ({view.history.length} event{view.history.length === 1 ? "" : "s"})
          </summary>
          <ol className="mt-2 space-y-1.5 border-l pl-3">
            {view.history.map((h) => (
              <li key={h.seq}>
                <p>
                  <span className="font-medium">#{h.seq}</span> {h.kind === "closed" ? `Marked filed${h.filedOn ? ` (filed ${h.filedOn})` : ""}` : "Reopened for revision"}
                </p>
                <p className="text-muted-foreground">
                  {h.on} by {h.byName}
                  {h.note ? `; ${h.kind === "closed" ? "note" : "reason"}: ${h.note}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
      {open === "close" && <CloseModal props={props} onClose={close} />}
      {open === "reopen" && <ReopenModal props={props} onClose={close} />}
    </section>
  );
}
