"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { resetQuestionnaire, saveQuestionnaireAnswer, saveQuestionnaireNote } from "@/actions/tax-questionnaires";
import { acceptPrefillSuggestions } from "@/actions/tax-questionnaire-prefill";
import { PrefillPanel } from "@/components/tax/forms/prefill-panel";
import { NO_PREFILL, combineContributions, ruleForNode, type PrefillAnswer, type PrefillSuggestion, type QuestionnairePrefill } from "@/lib/tax-prefill";
import {
  UNSURE_ID,
  answerLabel,
  buildSummary,
  describeAnswerSource,
  centsToDollarString,
  isUnsureValue,
  nodeOptions,
  parseDollarInputToCents,
  renderCopy,
  statusLabel,
  validateAnswerValue,
  visibleNodes,
  type AnswerValue,
  type BoundNodeInfo,
  type ChoiceNode,
  type EffectiveAnswer,
  type EffectiveAnswers,
  type NumberNode,
  type QNode,
  type QuestionnaireContext,
  type QuestionnaireDef,
} from "@/lib/tax-questionnaire";
import { SOURCES } from "@/lib/tax-questionnaire-content";

// The guided questionnaire for one "Needs CPA input" card. Branching, status and
// the summary panel are computed with the SAME pure functions the server uses
// (lib/tax-questionnaire.ts), so the page can never show a different follow-up
// set than the server will accept. Facts for the CPA - not tax advice. No modal
// and no window.confirm: confirmations are inline steps.

const BTN =
  "inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60";
const BTN_PRIMARY = `${BTN} border-primary bg-primary text-primary-foreground hover:opacity-90`;
const BTN_PLAIN = `${BTN} bg-background hover:bg-accent`;

const DATE_TIME_ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "medium",
  timeStyle: "short",
});

function formatEt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE_TIME_ET.format(d);
}

export interface QuestionnaireRunnerProps {
  year: number;
  def: QuestionnaireDef;
  entityId: string;
  ctx: QuestionnaireContext;
  effective: EffectiveAnswers;
  bound: Record<string, BoundNodeInfo>;
  /** Suggestions from the household's documents (absent / empty = none: the runner behaves exactly as before). */
  prefill?: QuestionnairePrefill;
  note: string | null;
  noteMeta: { at: string; byName: string | null } | null;
  stale: boolean;
  userNames: Record<string, string>;
  meId: string;
  planningLinks: { key: string; label: string; answer: string | null }[];
}

interface PendingConfirm {
  nodeId: string;
  value: AnswerValue;
  message: string;
}

function isChoice(node: QNode): node is ChoiceNode {
  return node.kind === "single" || node.kind === "multi";
}

function sourcesFor(node: QNode): string[] {
  const ids = [...(node.sources ?? [])];
  if (isChoice(node)) for (const o of node.options) ids.push(...(o.sources ?? []));
  return Array.from(new Set(ids)).filter((id) => id in SOURCES);
}

function draftFromValue(node: NumberNode, a: EffectiveAnswer | undefined): string {
  if (!a || typeof a.value !== "number") return "";
  return node.kind === "dollars" ? centsToDollarString(a.value) : String(a.value);
}

export function QuestionnaireRunner(props: QuestionnaireRunnerProps) {
  const { year, def, entityId, ctx, bound, userNames, meId } = props;
  const prefill = props.prefill ?? NO_PREFILL;
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Optimistic local copy of the answers; replaced whenever the server sends new ones.
  const [effective, setEffective] = useState<EffectiveAnswers>(props.effective);
  const [seenServer, setSeenServer] = useState<EffectiveAnswers>(props.effective);
  if (props.effective !== seenServer) {
    setSeenServer(props.effective);
    setEffective(props.effective);
  }

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState(props.note ?? "");
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const visible = visibleNodes(def, ctx, effective);
  const summary = buildSummary(def, ctx, effective, props.note);
  const answeredCount = visible.filter((n) => effective[n.id] !== undefined).length;
  const pct = visible.length > 0 ? Math.round((answeredCount / visible.length) * 100) : 0;

  async function commit(node: QNode, value: AnswerValue, confirmed = false) {
    setError(null);
    setPending(null);
    const before = effective;
    const next: EffectiveAnswers = {
      ...effective,
      [node.id]: { value, source: "questionnaire", at: new Date().toISOString(), by: meId },
    };
    const beforeIds = new Set(visibleNodes(def, ctx, before).map((n) => n.id));
    setHighlight(new Set(visibleNodes(def, ctx, next).map((n) => n.id).filter((id) => !beforeIds.has(id))));
    setEffective(next);
    setBusy(true);
    try {
      const res = await saveQuestionnaireAnswer({
        taxYear: year,
        questionnaireId: def.id,
        entityId,
        nodeId: node.id,
        value,
        confirmed,
      });
      if (res.ok) {
        startTransition(() => router.refresh());
      } else {
        setEffective(before);
        setHighlight(new Set());
        if (res.code === "needs_confirm") setPending({ nodeId: node.id, value, message: res.error });
        else setError(res.error);
      }
    } catch {
      setEffective(before);
      setHighlight(new Set());
      setError("Could not save. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function chooseSingle(node: ChoiceNode, optionId: string) {
    void commit(node, optionId);
  }

  function toggleMulti(node: ChoiceNode, optionId: string) {
    const options = nodeOptions(node, ctx);
    const picked = options.find((o) => o.id === optionId);
    if (!picked) return;
    const current = effective[node.id]?.value;
    const currentIds = Array.isArray(current) ? current : [];
    let nextIds: string[];
    if (picked.unsure || picked.exclusive) {
      nextIds = [optionId];
    } else if (currentIds.includes(optionId)) {
      nextIds = currentIds.filter((id) => id !== optionId);
    } else {
      const exclusiveIds = new Set(options.filter((o) => o.unsure || o.exclusive).map((o) => o.id));
      nextIds = [...currentIds.filter((id) => !exclusiveIds.has(id)), optionId];
    }
    if (nextIds.length === 0) {
      setError("Pick at least one answer, or choose Not sure.");
      return;
    }
    void commit(node, nextIds);
  }

  function saveNumber(node: NumberNode) {
    const text = (drafts[node.id] ?? draftFromValue(node, effective[node.id])).replace(/[$,\s]/g, "");
    let value: number | null;
    if (node.kind === "dollars") {
      value = parseDollarInputToCents(text);
    } else {
      value = /^\d{1,10}$/.test(text) ? Number(text) : null;
    }
    if (value === null) {
      setError(
        node.kind === "dollars"
          ? "Enter a dollar amount, digits only (up to two decimals)."
          : "Enter a whole number, digits only."
      );
      return;
    }
    const checked = validateAnswerValue(node, value, ctx);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    void commit(node, checked.value);
  }

  async function saveNote() {
    setNoteMsg(null);
    setError(null);
    setBusy(true);
    try {
      const res = await saveQuestionnaireNote({ taxYear: year, questionnaireId: def.id, entityId, note });
      if (res.ok) {
        setNoteMsg("Note saved.");
        startTransition(() => router.refresh());
      } else {
        setError(res.error);
      }
    } catch {
      setError("Could not save the note. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    setError(null);
    setResetOpen(false);
    setBusy(true);
    try {
      const res = await resetQuestionnaire({ taxYear: year, questionnaireId: def.id, entityId });
      if (res.ok) {
        setNote("");
        setDrafts({});
        setHighlight(new Set());
        startTransition(() => router.refresh());
      } else {
        setError(res.error);
      }
    } catch {
      setError("Could not reset. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Accept one suggestion (optionally from a chosen subset of documents) or, with `bulk`, every strong one. The server recomputes the value; only ids are sent. */
  async function acceptPrefill(items: { nodeId: string; documentIds?: string[] }[], mode: "items" | "bulk") {
    if (year !== 2025) return;
    setError(null);
    setBusy(true);
    try {
      const res = await acceptPrefillSuggestions({ taxYear: 2025, questionnaireId: def.id, entityId, mode, items });
      if (res.ok) startTransition(() => router.refresh());
      else setError(res.error);
    } catch {
      setError("Could not save. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  /** "Keep my answer": re-saves the same value(s) through the normal save, which stores them with no document link. */
  async function keepMine(nodeId: string) {
    const rule = ruleForNode(def.id, nodeId);
    if (!rule) return;
    setError(null);
    setBusy(true);
    try {
      const targets = Object.entries(effective).filter(([id, a]) => {
        const r = ruleForNode(def.id, id);
        return a.src !== undefined && r !== null && r.ruleId === rule.ruleId && r.person === rule.person;
      });
      for (const [id, a] of targets) {
        const res = await saveQuestionnaireAnswer({ taxYear: year, questionnaireId: def.id, entityId, nodeId: id, value: a.value });
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Could not save. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function answerText(answers: readonly PrefillAnswer[]): string {
    return answers
      .map((x) => {
        const n = def.nodes.find((q) => q.id === x.nodeId);
        return n ? answerLabel(n, x.value, ctx) : String(x.value);
      })
      .join(", ");
  }

  function savedTextFor(s: PrefillSuggestion | null, nodeId: string): string | null {
    const ids = s ? s.nodeIds : [nodeId];
    const parts = ids
      .filter((id) => effective[id] !== undefined)
      .map((id) => {
        const n = def.nodes.find((q) => q.id === id);
        const v = effective[id]!.value;
        return n ? answerLabel(n, v, ctx) : String(v);
      });
    return parts.length > 0 ? parts.join(", ") : null;
  }

  function provenance(a: EffectiveAnswer): string {
    if (a.source === "planning" && !a.by) return `Answered on the Planning screen${a.at ? ` ${formatEt(a.at)}` : ""}`;
    const name = a.by ? userNames[a.by] : undefined;
    if (a.src) {
      return `Accepted${name ? ` by ${name}` : ""}${a.at ? ` on ${formatEt(a.at)}` : ""} - ${describeAnswerSource(a.src)}`;
    }
    return `Answered${name ? ` by ${name}` : ""}${a.at ? ` on ${formatEt(a.at)}` : ""}`;
  }

  function isSelected(a: EffectiveAnswer | undefined, optionId: string): boolean {
    if (!a) return false;
    return Array.isArray(a.value) ? a.value.includes(optionId) : a.value === optionId;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{statusLabel(summary.status)}</span>
            <span className="text-muted-foreground">
              {answeredCount} of {visible.length} questions shown answered
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            More questions can appear as you answer. Every question has a &quot;Not sure&quot; choice - the CPA decides.
          </p>
        </div>

        {props.stale && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            These questions changed since the answers were saved - review them.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        {(prefill.bulkCount > 0 || prefill.weakCount > 0) && (
          <section
            data-prefill-banner="true"
            aria-label="Answers from your documents"
            className="space-y-2 rounded-md border-2 border-dashed border-primary/60 bg-primary/5 p-3 text-sm"
          >
            {prefill.bulkCount > 0 && (
              <>
                <p className="font-medium">
                  {prefill.bulkCount} {prefill.bulkCount === 1 ? "answer can" : "answers can"} be filled from your documents
                </p>
                <p className="text-xs text-muted-foreground">
                  These come from verified documents. Nothing is saved until you accept; you can still change any answer.
                </p>
                <button type="button" disabled={busy} onClick={() => void acceptPrefill([], "bulk")} className={BTN_PRIMARY}>
                  {`Accept ${prefill.bulkCount} ${prefill.bulkCount === 1 ? "suggestion" : "suggestions"}`}
                </button>
              </>
            )}
            {prefill.weakCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {prefill.weakCount} more {prefill.weakCount === 1 ? "answer needs" : "answers need"} a look: they are marked below and are
                accepted one at a time.
              </p>
            )}
          </section>
        )}

        <ol className="space-y-3">
          {visible.map((node, index) => {
            const a = effective[node.id];
            const info = bound[node.id];
            const nodeSources = sourcesFor(node);
            const confirmHere = pending && pending.nodeId === node.id ? pending : null;
            const pst = prefill.states[node.id];
            const psug = pst && pst.suggestionKey ? (prefill.suggestions.find((x) => x.key === pst.suggestionKey) ?? null) : null;
            const suggestedValue =
              psug && pst && (pst.state === "suggested" || pst.state === "differs") && !psug.needsPick
                ? psug.answers.find((x) => x.nodeId === node.id)?.value
                : undefined;
            return (
              <li
                key={node.id}
                id={`q-${node.id}`}
                className={`rounded-lg border bg-card p-4 ${highlight.has(node.id) ? "ring-2 ring-primary/50" : ""}`}
              >
                <p className="text-base font-medium">
                  {index + 1}. {renderCopy(node.prompt, ctx)}
                </p>
                {node.help && <p className="mt-1 text-sm text-muted-foreground">{renderCopy(node.help, ctx)}</p>}
                {nodeSources.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Source:{" "}
                    {nodeSources.map((id, i) => (
                      <span key={id}>
                        {i > 0 && "; "}
                        <a href={SOURCES[id]!.url} target="_blank" rel="noreferrer" className="underline">
                          {SOURCES[id]!.title}
                        </a>
                      </span>
                    ))}
                  </p>
                )}

                {pst && (
                  <PrefillPanel
                    key={`${node.id}:${pst.state}:${pst.staleReason ?? ""}:${a?.src?.docIds.join(",") ?? ""}`}
                    suggestion={psug}
                    state={pst}
                    savedText={savedTextFor(psug, node.id)}
                    answerText={answerText}
                    acceptedChip={psug && a?.src ? (combineContributions(psug, psug.kind === "planning" ? [] : a.src.docIds)?.chip ?? null) : null}
                    acceptedLine={
                      a?.src
                        ? `accepted${a.by && userNames[a.by] ? ` by ${userNames[a.by]}` : ""}${a.at ? ` on ${formatEt(a.at)}` : ""}`
                        : null
                    }
                    acceptedDocIds={a?.src?.docIds ?? []}
                    busy={busy}
                    onAccept={(documentIds) => void acceptPrefill([{ nodeId: node.id, ...(documentIds ? { documentIds } : {}) }], "items")}
                    onKeepMine={() => void keepMine(node.id)}
                  />
                )}

                {isChoice(node) ? (
                  <div className="mt-3 grid gap-2" role={node.kind === "single" ? "radiogroup" : "group"}>
                    {nodeOptions(node, ctx).map((o) => {
                      const selected = isSelected(a, o.id);
                      const suggestedOption =
                        !selected &&
                        suggestedValue !== undefined &&
                        (Array.isArray(suggestedValue) ? suggestedValue.includes(o.id) : suggestedValue === o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          aria-pressed={selected}
                          disabled={busy}
                          onClick={() => (node.kind === "single" ? chooseSingle(node, o.id) : toggleMulti(node, o.id))}
                          className={`min-h-12 w-full rounded-md border px-4 py-3 text-left text-base disabled:opacity-60 ${
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : suggestedOption
                                ? "border-dashed border-primary bg-primary/5 hover:bg-accent"
                                : "bg-background hover:bg-accent"
                          }`}
                        >
                          <span className="block">
                            {node.kind === "multi" && <span aria-hidden="true">{selected ? "[x] " : "[ ] "}</span>}
                            {renderCopy(o.label, ctx)}
                            {suggestedOption && <span className="ml-2 text-xs font-medium"> (suggested, not saved)</span>}
                          </span>
                          {o.warning && <span className="mt-1 block text-xs opacity-90">{o.warning}</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {node.kind === "dollars" && <span className="text-base">$</span>}
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      aria-label={renderCopy(node.prompt, ctx)}
                      disabled={busy}
                      value={drafts[node.id] ?? draftFromValue(node, a)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [node.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveNumber(node);
                      }}
                      className="h-12 w-40 rounded-md border bg-background px-3 text-base"
                    />
                    <button type="button" disabled={busy} onClick={() => saveNumber(node)} className={BTN_PRIMARY}>
                      Save
                    </button>
                    <button
                      type="button"
                      aria-pressed={a !== undefined && isUnsureValue(a.value)}
                      disabled={busy}
                      onClick={() => void commit(node, UNSURE_ID)}
                      className={`${BTN} ${
                        a !== undefined && isUnsureValue(a.value)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-background hover:bg-accent"
                      }`}
                    >
                      Not sure
                    </button>
                  </div>
                )}

                {info && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Also saved as your Planning answer - it feeds the draft numbers.
                    {info.conflict && !a && (
                      <>
                        {" "}
                        Planning currently holds the written answer &quot;{info.conflict}&quot;; saving a number here
                        replaces it (you will be asked to confirm).
                      </>
                    )}
                  </p>
                )}

                {confirmHere && (
                  <div role="alert" className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <p>{confirmHere.message} Continue?</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void commit(node, confirmHere.value, true)}
                        className={BTN_PRIMARY}
                      >
                        Yes, continue
                      </button>
                      <button type="button" disabled={busy} onClick={() => setPending(null)} className={BTN_PLAIN}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {a && <p className="mt-2 text-xs text-muted-foreground">{provenance(a)}</p>}
              </li>
            );
          })}
        </ol>

        <section className="space-y-2 rounded-lg border bg-card p-4">
          <label htmlFor="cpa-note" className="text-sm font-semibold">
            Note for the CPA
          </label>
          <textarea
            id="cpa-note"
            value={note}
            maxLength={2000}
            rows={4}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteMsg(null);
            }}
            className="w-full rounded-md border bg-background p-3 text-base"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={() => void saveNote()} className={BTN_PRIMARY}>
              Save note
            </button>
            <span className="text-xs text-muted-foreground">{note.length}/2000</span>
            {noteMsg && <span className="text-xs text-green-700">{noteMsg}</span>}
          </div>
          {props.noteMeta && (
            <p className="text-xs text-muted-foreground">
              Last saved{props.noteMeta.byName ? ` by ${props.noteMeta.byName}` : ""} on {formatEt(props.noteMeta.at)}.
            </p>
          )}
        </section>

        <section className="space-y-2">
          {!resetOpen ? (
            <button type="button" disabled={busy} onClick={() => setResetOpen(true)} className={BTN_PLAIN}>
              Reset answers saved here
            </button>
          ) : (
            <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                Reset? This empties the answers and note saved on this questionnaire. The note is erased for good
                (copy it first if you want it); the earlier answers are kept in the change history. Shared Planning
                answers stay as they are.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void doReset()} className={BTN_PRIMARY}>
                  Yes, reset
                </button>
                <button type="button" disabled={busy} onClick={() => setResetOpen(false)} className={BTN_PLAIN}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <aside className="space-y-3 self-start rounded-lg border bg-card p-4 lg:sticky lg:top-4" aria-label="Facts reported by owner">
        <h2 className="text-sm font-semibold">Facts reported by owner</h2>
        {summary.outcomeText && <p className="text-sm font-medium">{summary.outcomeText}</p>}
        {summary.facts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing answered yet.</p>
        ) : (
          <ul className="space-y-2">
            {summary.facts.map((f) => (
              <li key={f.nodeId} className="text-sm">
                <span className="text-muted-foreground">{f.prompt}</span>
                <br />
                <span className={f.unsure ? "font-medium text-amber-800" : "font-medium"}>{f.answerLabel}</span>
                {f.sourceNote && (
                  <>
                    <br />
                    <span className="text-xs text-muted-foreground">{f.sourceNote}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {summary.openQuestions.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
              Open questions for the CPA
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
              {summary.openQuestions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        )}
        {props.planningLinks.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
              Related Planning answers
            </h3>
            <ul className="mt-1 space-y-1 text-sm">
              {props.planningLinks.map((l) => (
                <li key={l.key}>
                  <span className="text-muted-foreground">{l.label}:</span>{" "}
                  <span className="whitespace-pre-wrap">{l.answer ?? "not answered"}</span>
                </li>
              ))}
            </ul>
            <Link href={`/tax/personal/${year}` as Route} className="text-xs text-primary hover:underline">
              Change on the Planning screen
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}
