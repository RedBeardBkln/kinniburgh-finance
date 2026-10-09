"use client";

import { useEffect, useId, useRef, useState, useTransition, type RefObject } from "react";
import {
  addSuggestedRecurringExpense,
  dismissSuggestion,
  restoreSuggestion,
} from "@/actions/recurring-suggestions";
import {
  buildAddRequest,
  clientNameProblem,
  initialAddState,
  type AddStepState,
  type AddTagOption,
} from "@/lib/recurring-add-step";
import { useBudgetFacts, useTagOptions } from "@/components/upcoming/tag-options";
import { selectedTagNotice } from "@/lib/recurring-budget-hint";

// The only client code of the "Looks recurring" list: the buttons of one suggestion. "Add as recurring expense" opens a
// small inline step (budget category + name) before anything is written. The server action re-derives amount, frequency
// and day from (entityId, seriesKey); nothing money-related is sent from here (see lib/recurring-add-step.ts).

export const ADD_TAG_HELP =
  "Link to a budget category so it shows up under your budget and future bank imports of this payee line up.";

interface AddStepProps {
  /** Unique id prefix for the labels / descriptions of this row. */
  idPrefix: string;
  /** The suggestion's display name; the dialog title and the name field's starting value. */
  defaultName: string;
  tags: readonly AddTagOption[];
  state: AddStepState;
  /** The tag the step started on because it covers most of the payee's transactions; null = none was suggested. */
  suggestedTagId: string | null;
  /** Plain-language note about what linking does to the Budgets figure for the selected category, or null. */
  budgetNote?: string | null;
  error: string | null;
  pending: boolean;
  selectRef?: RefObject<HTMLSelectElement | null>;
  onChange: (next: AddStepState) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The inline step. Presentational (all state is owned by SuggestionActions) so it can be rendered open in tests.
 * A real <form>: Enter in the name field confirms, Escape anywhere in it cancels, Tab order is category, name,
 * Confirm, Cancel. Every control has a visible label.
 */
export function AddStep({
  idPrefix,
  defaultName,
  tags,
  state,
  suggestedTagId,
  budgetNote = null,
  error,
  pending,
  selectRef,
  onChange,
  onConfirm,
  onCancel,
}: AddStepProps) {
  const field = "mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
  const button = "rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50";
  const preselected = suggestedTagId !== null && state.tagId === suggestedTagId;
  return (
    <form
      id={`${idPrefix}-step`}
      role="group"
      aria-labelledby={`${idPrefix}-title`}
      className="mt-2 w-full max-w-xl space-y-3 rounded-md border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${idPrefix}-title`} className="text-sm font-medium">
        Add {defaultName} as a recurring expense
      </p>

      <div>
        <label htmlFor={`${idPrefix}-tag`} className="text-xs font-medium">
          Budget category (optional)
        </label>
        <select
          id={`${idPrefix}-tag`}
          ref={selectRef}
          className={field}
          value={state.tagId}
          disabled={pending}
          aria-describedby={budgetNote ? `${idPrefix}-tag-help ${idPrefix}-budget-note` : `${idPrefix}-tag-help`}
          onChange={(e) => onChange({ ...state, tagId: e.target.value })}
        >
          <option value="">No tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <p id={`${idPrefix}-tag-help`} className="mt-1 text-xs text-muted-foreground">
          {ADD_TAG_HELP}
          {preselected ? " Pre-selected because most of this payee's transactions already carry this tag." : ""}
        </p>
        {budgetNote && (
          <p id={`${idPrefix}-budget-note`} role="status" aria-live="polite" className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
            {budgetNote}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={`${idPrefix}-name`} className="text-xs font-medium">
          Name
        </label>
        <input
          id={`${idPrefix}-name`}
          type="text"
          className={field}
          value={state.name}
          disabled={pending}
          autoComplete="off"
          aria-describedby={`${idPrefix}-name-help`}
          aria-invalid={error !== null && clientNameProblem(state.name) !== null ? true : undefined}
          onChange={(e) => onChange({ ...state, name: e.target.value })}
        />
        <p id={`${idPrefix}-name-help`} className="mt-1 text-xs text-muted-foreground">
          Shown in your recurring expenses, up to 80 characters. The amount and schedule are taken from your transaction history.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-amber-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
          disabled={pending}
        >
          {pending ? "Adding..." : "Confirm"}
        </button>
        <button type="button" className={button} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface SuggestionActionsProps {
  entityId: string;
  seriesKey: string;
  /** "suggest": Add as recurring expense + Not a bill. "restore": Show again (dismissed list). */
  mode: "suggest" | "restore";
  /** False for rows that can only be dismissed (never the case for outflow suggestions today). */
  canAdd?: boolean;
  /** The suggestion's display name (account nickname suffix included): the starting value of the name field. */
  defaultName?: string;
  /** The budget tag to pre-select (one tag covers at least 60% of the series' rows), or null. */
  suggestedTagId?: string | null;
  /** This suggestion's payment in cents and its recurring-expense frequency (display only: the server re-derives them). */
  amountCents?: number;
  recurringFrequency?: string;
}

export function SuggestionActions({
  entityId,
  seriesKey,
  mode,
  canAdd = true,
  defaultName = "",
  suggestedTagId = null,
  amountCents,
  recurringFrequency,
}: SuggestionActionsProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const tags = useTagOptions();
  const budgetFacts = useBudgetFacts();
  const idPrefix = `add-${useId().replace(/:/g, "")}`;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<AddStepState>({ tagId: "", name: defaultName });
  const [stepError, setStepError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);

  // Keyboard: opening moves focus to the category list; closing (Cancel / Escape / done) returns it to the button.
  useEffect(() => {
    if (open) selectRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      addButtonRef.current?.focus();
    }
  }, [open]);

  function run(action: (input: { entityId: string; seriesKey: string }) => Promise<{ success: true } | { error: string }>, done: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await action({ entityId, seriesKey });
        if ("error" in res) {
          setFailed(true);
          setMessage(res.error);
        } else {
          setFailed(false);
          setMessage(done);
        }
      } catch {
        setFailed(true);
        setMessage("Something went wrong. Please try again.");
      }
    });
  }

  function openStep() {
    setMessage(null);
    setStepError(null);
    setStep(initialAddState(defaultName, suggestedTagId, tags));
    setOpen(true);
  }

  function closeStep() {
    returnFocus.current = true;
    setOpen(false);
  }

  function confirm() {
    // Only a changed name is checked here (the server checks again); an unchanged long default goes through untouched.
    if (step.name.trim() !== defaultName.trim()) {
      const problem = clientNameProblem(step.name);
      if (problem) {
        setStepError(problem);
        return;
      }
    }
    setStepError(null);
    startTransition(async () => {
      try {
        const res = await addSuggestedRecurringExpense(buildAddRequest({ entityId, seriesKey }, step, defaultName));
        if ("error" in res) {
          if (res.error === "Already recorded") {
            closeStep();
            setFailed(true);
            setMessage(res.error);
          } else {
            setStepError(res.error);
          }
        } else {
          closeStep();
          setFailed(false);
          setMessage(res.notice ?? "Added as a recurring expense");
        }
      } catch {
        setStepError("Something went wrong. Please try again.");
      }
    });
  }

  const button = "rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {mode === "suggest" ? (
          <>
            {canAdd && (
              <button
                ref={addButtonRef}
                type="button"
                className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
                disabled={pending}
                aria-expanded={open}
                aria-controls={open ? `${idPrefix}-step` : undefined}
                onClick={openStep}
              >
                Add as recurring expense
              </button>
            )}
            <button type="button" className={button} disabled={pending} onClick={() => run(dismissSuggestion, "Dismissed")}>
              Not a bill
            </button>
          </>
        ) : (
          <button type="button" className={button} disabled={pending} onClick={() => run(restoreSuggestion, "Restored")}>
            Show again
          </button>
        )}
        {message && (
          <span role="status" className={`text-xs ${failed ? "text-amber-700" : "text-muted-foreground"}`}>
            {message}
          </span>
        )}
      </div>
      {open && mode === "suggest" && canAdd && (
        <AddStep
          idPrefix={idPrefix}
          defaultName={defaultName}
          tags={tags}
          state={step}
          suggestedTagId={suggestedTagId}
          budgetNote={selectedTagNotice(budgetFacts, entityId, step.tagId, amountCents, recurringFrequency)}
          error={stepError}
          pending={pending}
          selectRef={selectRef}
          onChange={setStep}
          onConfirm={confirm}
          onCancel={closeStep}
        />
      )}
    </div>
  );
}
