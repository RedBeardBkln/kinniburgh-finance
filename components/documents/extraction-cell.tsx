"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { runDocumentExtraction } from "@/actions/documents";
import type { ExtractionDisplay, ExtractionTone } from "@/lib/document-extraction-state";

export const EXTRACTION_TONE_CLASS: Record<ExtractionTone, string> = {
  muted: "bg-muted text-muted-foreground border-border",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  red: "bg-red-50 text-red-700 border-red-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  green: "bg-green-50 text-green-700 border-green-200",
};

const REEXTRACT_CONFIRM =
  "Re-extract replaces the AI-read values with a fresh AI read (one API call). Your corrections are kept and still override it.";
const REEXTRACT_VERIFIED_NOTE =
  " This document is verified - re-extracting marks it unverified until you confirm it again.";

interface Props {
  documentId: string;
  display: ExtractionDisplay;
}

/**
 * The Extraction column cell: honest state badge + the Run / Retry /
 * Re-extract actions. Extraction only ever starts from a button click here
 * (never on render, effect or prefetch) because every run is a paid API call.
 */
export function ExtractionCell({ documentId, display }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(opts: { force: boolean; discardVerification?: boolean }) {
    setRunning(true);
    setError(null);
    try {
      const res = await runDocumentExtraction(documentId, opts);
      if (!res.ok) setError(res.error);
      router.refresh();
    } catch {
      setError("The request failed before extraction finished. Check your connection and try again.");
    } finally {
      setRunning(false);
    }
  }

  function handleReextract() {
    const verified = display.kind === "verified";
    const message = REEXTRACT_CONFIRM + (verified ? REEXTRACT_VERIFIED_NOTE : "");
    if (!window.confirm(message)) return;
    void run({ force: true, discardVerification: verified });
  }

  const has = (a: ExtractionDisplay["actions"][number]) => display.actions.includes(a);
  const buttonClass = "text-xs text-primary hover:underline disabled:opacity-60";

  return (
    <div className="space-y-1">
      <span
        title={display.hint}
        className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${EXTRACTION_TONE_CLASS[display.tone]}`}
      >
        {display.label}
      </span>
      {display.reason && <p className="text-xs text-muted-foreground">{display.reason}</p>}
      {running ? (
        <p role="status" className="text-xs text-muted-foreground">
          Extracting... 20-60s
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {has("run") && (
            <button type="button" className={buttonClass} onClick={() => void run({ force: false })}>
              Run extraction
            </button>
          )}
          {has("retry") && (
            <button type="button" className={buttonClass} onClick={() => void run({ force: true })}>
              Retry
            </button>
          )}
          {has("extract_anyway") && (
            <button type="button" className={buttonClass} onClick={() => void run({ force: true })}>
              Extract anyway
            </button>
          )}
          {has("reextract") && (
            <button type="button" className={buttonClass} onClick={handleReextract}>
              Re-extract
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {display.kind === "processing" && (
        <p className="text-xs text-muted-foreground">Refresh the page to see the result.</p>
      )}
    </div>
  );
}
