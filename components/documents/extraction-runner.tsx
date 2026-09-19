"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runDocumentExtraction } from "@/actions/documents";

interface Props {
  documentId: string;
  /**
   * auto   — start extracting as soon as this mounts (nothing has been tried).
   * manual — extraction failed/was skipped; show why and offer a button.
   * wait   — another extraction is already running; poll until it finishes.
   */
  mode: "auto" | "manual" | "wait";
  /** Re-run even though extracted data already exists (credit-card reclassification). */
  force?: boolean;
  /** Shown in manual mode above the button. */
  message?: string;
  buttonLabel?: string;
}

/**
 * Runs transaction extraction from the browser, as a real server action.
 *
 * The review page used to run extraction inside its own server render. That
 * made a plain page view a slow, side-effecting, non-idempotent AI call: it
 * was fired by Next.js link prefetching, raced itself, threw on
 * revalidatePath, and left rows stuck on "processing" if the function was
 * killed mid-render. Rendering is now side-effect free; this component is
 * the only thing that starts an extraction.
 */
export function ExtractionRunner({ documentId, mode, force = false, message, buttonLabel }: Props) {
  const router = useRouter();
  // Guards React StrictMode's double-invoked mount effect. The server-side
  // claim in runExtraction also de-duplicates, but there is no reason to fire
  // the request twice.
  const started = useRef(false);
  const [running, setRunning] = useState(mode === "auto");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (forceRun: boolean) => {
      setRunning(true);
      setError(null);
      runDocumentExtraction(documentId, { force: forceRun })
        .then((res) => {
          if (res.ok) {
            router.refresh();
          } else {
            setError(res.error);
            setRunning(false);
          }
        })
        .catch(() => {
          setError("The request failed before extraction finished. Check your connection and try again.");
          setRunning(false);
        });
    },
    [documentId, router]
  );

  useEffect(() => {
    if (mode !== "auto" || started.current) return;
    started.current = true;
    run(force);
  }, [mode, force, run]);

  // Another extraction owns the lock: just re-read the page until it lands.
  useEffect(() => {
    if (mode !== "wait") return;
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [mode, router]);

  if (running || mode === "wait") {
    return (
      <div role="status" className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {mode === "wait"
          ? "Extraction is already running for this statement — this page will update when it finishes…"
          : "Extracting transactions… this usually takes 20–60 seconds. You can leave this page open."}
      </div>
    );
  }

  return (
    <div
      role={error ? "alert" : undefined}
      className={`rounded-lg border px-4 py-3 text-sm ${
        error ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/30 text-muted-foreground"
      }`}
    >
      <p>{error ?? message}</p>
      <button
        type="button"
        onClick={() => run(true)}
        className="mt-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
      >
        {error ? "Try again" : (buttonLabel ?? "Extract transactions")}
      </button>
    </div>
  );
}
