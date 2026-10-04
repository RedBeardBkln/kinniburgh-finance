"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  combineContributions,
  formatDocValue,
  staleMessage,
  type PrefillAnswer,
  type PrefillNodeState,
  type PrefillSuggestion,
} from "@/lib/tax-prefill";

// The "answer from your documents" block shown under a question that has a suggestion.
// Presentational: the runner owns the server calls. No modal and no window.confirm - the
// picker is an inline panel. Every state is spelled out in words (never colour alone), and
// every button is at least 44px tall and wraps on a phone. Suggestion data is already
// sanitized (employer / document display names, ids, cents, verified flags - no EIN, SSN,
// address or raw extraction).

const BTN =
  "inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60";
const BTN_PRIMARY = `${BTN} border-primary bg-primary text-primary-foreground hover:opacity-90`;
const BTN_PLAIN = `${BTN} bg-background hover:bg-accent`;

export interface PrefillPanelProps {
  /** Null when the accepted source no longer produces any suggestion (document archived, ...). */
  suggestion: PrefillSuggestion | null;
  state: PrefillNodeState;
  /** The saved answer as text (e.g. "Yes"), or null when unanswered. */
  savedText: string | null;
  /** Text for a set of answers (labels resolved by the runner from the questionnaire definition). */
  answerText: (answers: readonly PrefillAnswer[]) => string;
  /** Live chip for what was accepted (recomputed from the accepted document ids), when accepted / stale. */
  acceptedChip: string | null;
  /** "accepted by Eric on Oct 4, 2026" (accepted / stale). */
  acceptedLine: string | null;
  /** The document ids the saved answer was accepted from. */
  acceptedDocIds: readonly string[];
  busy: boolean;
  /** `undefined` = the suggestion's default documents. */
  onAccept: (documentIds: string[] | undefined) => void;
  onKeepMine: () => void;
  /** Start with the document picker open (used by tests; the runner leaves it closed). */
  initialOpen?: boolean;
}

export function PrefillPanel(props: PrefillPanelProps) {
  const { suggestion: s, state: st } = props;
  const startSelection = props.acceptedDocIds.length > 0 && st.state !== "suggested" ? [...props.acceptedDocIds] : s ? [...s.docIds] : [];
  const [open, setOpen] = useState(props.initialOpen === true);
  const [selected, setSelected] = useState<string[]>(startSelection);

  const single = s !== null && (s.ruleId === "return_filing" || s.ruleId === "return_no_tax");
  const evalNow = s ? combineContributions(s, s.kind === "planning" ? [] : selected) : null;
  const canPick = s !== null && s.kind === "document" && s.candidates.length > 0;

  function toggle(docId: string) {
    setSelected((cur) => {
      if (single) return [docId];
      return cur.includes(docId) ? cur.filter((x) => x !== docId) : [...cur, docId];
    });
  }

  const picker =
    open && s ? (
      <div className="space-y-2 rounded-md border bg-background p-3" aria-label="Choose which documents to use">
        <p className="text-sm font-medium">{single ? "Which document is the source?" : "Which documents should be counted?"}</p>
        <ul className="space-y-1">
          {s.candidates
            .filter((c) => c.selectable)
            .map((c) => (
              <li key={c.docId}>
                <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm">
                  <input
                    type={single ? "radio" : "checkbox"}
                    name={`prefill-${s.key}`}
                    checked={selected.includes(c.docId)}
                    onChange={() => toggle(c.docId)}
                    className="mt-1 h-4 w-4"
                  />
                  <span>
                    <span className="font-medium">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {c.detail ? `${c.detail} - ` : ""}
                      {c.verified ? "verified" : "unverified AI read"}
                      {c.legacyFormat ? " - older read format" : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
        </ul>
        {s.candidates.some((c) => !c.selectable) && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Not counted</p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {s.candidates
                .filter((c) => !c.selectable)
                .map((c) => (
                  <li key={c.docId}>
                    {c.label}: {c.reason ?? "not usable"}{" "}
                    <Link href={`/documents/${c.docId}/review` as Route} className="underline">
                      Open the document
                    </Link>
                  </li>
                ))}
            </ul>
          </div>
        )}
        <p className="text-sm" aria-live="polite">
          {evalNow ? (
            <>
              With these documents: <strong>{props.answerText(evalNow.answers)}</strong>. {evalNow.chip}
            </>
          ) : selected.length === 0 ? (
            "Pick a document."
          ) : (
            "These documents do not give an answer."
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={props.busy || evalNow === null} onClick={() => props.onAccept(selected)} className={BTN_PRIMARY}>
            Use this selection
          </button>
          <button type="button" disabled={props.busy} onClick={() => setOpen(false)} className={BTN_PLAIN}>
            Close
          </button>
        </div>
      </div>
    ) : null;

  const pickButton = canPick && !open && (
    <button type="button" disabled={props.busy} onClick={() => setOpen(true)} className={BTN_PLAIN}>
      Use a different document
    </button>
  );

  const caveats =
    evalNow && evalNow.caveats.length > 0 ? (
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        {evalNow.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    ) : null;

  if (st.state === "agrees") {
    return (
      <section data-prefill="agrees" aria-label="Answer from your documents" className="mt-3 rounded-md border bg-muted/40 p-3 text-sm">
        <p>
          <span className="font-medium">Matches your documents.</span> {s ? s.chip : ""}
        </p>
      </section>
    );
  }

  if (st.state === "accepted") {
    return (
      <section data-prefill="accepted" aria-label="Answer from your documents" className="mt-3 space-y-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
        <p>
          <span className="font-medium">Filled from your documents</span>
          {props.acceptedLine ? `, ${props.acceptedLine}` : ""}.
        </p>
        {props.acceptedChip && <p className="text-xs">{props.acceptedChip}</p>}
        <p className="text-xs">To answer differently, choose a different answer below; it is then marked as answered by you.</p>
        <div className="flex flex-wrap gap-2">{pickButton}</div>
        {picker}
      </section>
    );
  }

  if (st.state === "stale") {
    const was = s && st.acceptedDocValue !== null ? formatDocValue(s.ruleId, st.acceptedDocValue) : null;
    return (
      <section data-prefill="stale" data-stale={st.staleReason ?? ""} aria-label="Answer from your documents" className="mt-3 space-y-2 rounded-md border-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-medium">Changed since you accepted this answer</p>
        <p>{staleMessage(st.staleReason ?? "doc_gone")}</p>
        {props.acceptedChip && <p className="text-xs">You accepted: {props.acceptedChip}</p>}
        {was !== null && <p className="text-xs">Value when you accepted it: {was}.</p>}
        {s && s.answers.length > 0 && !s.needsPick && (
          <p className="text-xs">
            The documents now say: <strong>{props.answerText(s.answers)}</strong>. {s.chip}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {s && s.answers.length > 0 && !s.needsPick && (
            <button type="button" disabled={props.busy} onClick={() => props.onAccept(undefined)} className={BTN_PRIMARY}>
              {`Update to ${props.answerText(s.answers)}`}
            </button>
          )}
          <button type="button" disabled={props.busy} onClick={props.onKeepMine} className={BTN_PLAIN}>
            Keep my answer
          </button>
          {pickButton}
        </div>
        {!s && <p className="text-xs">Keeping your answer saves it as answered by you; the CPA summary will then no longer cite a document.</p>}
        {picker}
      </section>
    );
  }

  if (st.state === "differs" && s) {
    return (
      <section data-prefill="differs" aria-label="Answer from your documents" className="mt-3 space-y-2 rounded-md border-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-medium">You answered differently from your documents</p>
        <p>
          You answered <strong>{props.savedText ?? "something else"}</strong>.
          {s.answers.length > 0 && !s.needsPick ? (
            <>
              {" "}
              The documents say <strong>{props.answerText(s.answers)}</strong>.
            </>
          ) : null}
        </p>
        <p className="text-xs">{s.chip}</p>
        <p className="text-xs">Your answer stays as you gave it unless you choose to use the document value. The CPA summary shows both.</p>
        <div className="flex flex-wrap gap-2">
          {s.answers.length > 0 && !s.needsPick && (
            <button type="button" disabled={props.busy} onClick={() => props.onAccept(undefined)} className={BTN_PRIMARY}>
              Use the document value
            </button>
          )}
          {pickButton}
        </div>
        {picker}
      </section>
    );
  }

  // suggested
  if (!s) return null;
  return (
    <section data-prefill="suggested" aria-label="Answer from your documents" className="mt-3 space-y-2 rounded-md border-2 border-dashed border-primary/60 bg-primary/5 p-3 text-sm">
      <p className="font-medium">Suggested from your documents - not saved yet</p>
      {s.needsPick ? (
        <p>More than one document could be the source. {s.chip}</p>
      ) : (
        <>
          <p>
            Suggested answer: <strong>{props.answerText(s.answers)}</strong>
            {s.strength === "weak" ? " (check this one before using it)" : ""}
          </p>
          <p className="text-xs text-muted-foreground">{s.chip}</p>
          {caveats}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {!s.needsPick && (
          <button type="button" disabled={props.busy} onClick={() => props.onAccept(undefined)} className={BTN_PRIMARY}>
            Use this answer
          </button>
        )}
        {s.needsPick && !open && (
          <button type="button" disabled={props.busy} onClick={() => setOpen(true)} className={BTN_PRIMARY}>
            Choose the document
          </button>
        )}
        {!s.needsPick && pickButton}
      </div>
      <p className="text-xs text-muted-foreground">Or answer it yourself below: an answer you choose is saved as answered by you.</p>
      {picker}
    </section>
  );
}
