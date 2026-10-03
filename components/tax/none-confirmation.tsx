"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { answerTaxQuestionByKey, clearTaxQuestionAnswerByKey } from "@/actions/tax-planning";

// "None this year" banner shared by the donation log and the fixed-asset
// register pages. Confirming answers the matching planning question "none";
// Undo clears it again (so the Forms-page line reads as missing). When entries
// exist but "none" is still confirmed, a notice suggests undoing it - entries
// always win, the answer is never silently rewritten.

export function NoneConfirmation({
  taxYear,
  questionKey,
  confirmed,
  hasEntries,
  noneLabel,
  entriesLabel,
  uncountedNote,
}: {
  taxYear: number;
  questionKey: string;
  confirmed: boolean;
  hasEntries: boolean;
  /** e.g. "No charitable gifts in 2025" */
  noneLabel: string;
  /** e.g. "gifts" - used in the conflict notice. */
  entriesLabel: string;
  /**
   * Neutral explanation shown (when "none" is not confirmed and hasEntries is
   * false) because entries exist but do not count toward the Forms-page line.
   */
  uncountedNote?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(kind: "confirm" | "undo") {
    setError(null);
    startTransition(async () => {
      const res =
        kind === "confirm"
          ? await answerTaxQuestionByKey({ taxYear, key: questionKey, answer: "none" })
          : await clearTaxQuestionAnswerByKey({ taxYear, key: questionKey });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        confirmed ? "border-green-300 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {confirmed
            ? `Confirmed: ${noneLabel.toLowerCase()}. The Forms page treats this line as done.`
            : hasEntries
              ? `${entriesLabel} recorded - the Forms page treats this line as done.`
              : uncountedNote
                ? uncountedNote
                : `Not confirmed - the Forms page keeps this line open until you record an entry or confirm none.`}
        </span>
        {confirmed ? (
          <button
            type="button"
            onClick={() => run("undo")}
            disabled={isPending}
            className="rounded-md border border-green-400 px-3 py-1 text-xs hover:bg-green-100 disabled:opacity-60"
          >
            {isPending ? "Working…" : "Undo"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`${noneLabel} - confirm there is nothing to record for ${taxYear}?`)) run("confirm");
            }}
            disabled={isPending}
            className="rounded-md border border-amber-400 px-3 py-1 text-xs hover:bg-amber-100 disabled:opacity-60"
          >
            {isPending ? "Working…" : `Confirm none for ${taxYear}`}
          </button>
        )}
      </div>
      {confirmed && hasEntries && (
        <p className="mt-2 text-xs">
          You confirmed none for {taxYear} but {entriesLabel} exist - consider undoing the confirmation so the record
          stays accurate.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
