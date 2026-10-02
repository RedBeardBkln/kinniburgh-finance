"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fillMissingDocumentYears } from "@/actions/documents";
import { buildYearFillConfirmMessage } from "@/lib/document-year";

interface Props {
  /** Yearless documents whose stored extraction says a year (planYearFill, computed on the server). */
  count: number;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * User-initiated "fill in missing years" control. Nothing runs until the owner
 * clicks and confirms. It only sets the year on documents that have none, from
 * data already extracted: no document is re-read and no AI call is made.
 */
export function FillMissingYearsBar({ count }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function handleClick() {
    if (!window.confirm(buildYearFillConfirmMessage(count))) return;
    setMessage(null);
    setFailed(false);
    setRunning(true);
    try {
      const { updated, skippedNoYear } = await fillMissingDocumentYears();
      setMessage(
        `Filled in ${updated} ${plural(updated, "year", "years")}.` +
          (skippedNoYear > 0
            ? ` ${skippedNoYear} ${plural(skippedNoYear, "document still has", "documents still have")} no readable year.`
            : "")
      );
    } catch {
      setFailed(true);
      setMessage("Could not fill in the missing years. Please try again.");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  // Hide once nothing is left to fill, but keep a finished-run message alive
  // across the router.refresh() that drops `count` to 0.
  if (count === 0 && !message) return null;

  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {count > 0 && (
          <>
            <button
              type="button"
              onClick={() => void handleClick()}
              disabled={running}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              {running
                ? "Filling in years..."
                : `Fill in ${count} missing ${plural(count, "year", "years")} from the extracted data`}
            </button>
            {!running && !message && (
              <span className="text-xs text-muted-foreground">
                Only documents with no year are changed. No AI calls.
              </span>
            )}
          </>
        )}
      </div>
      {message && (
        <p role="status" className={`text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
