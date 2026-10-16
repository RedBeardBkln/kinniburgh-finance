"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

// Small shared pieces of the invoicing screens (no business logic here).

export const INPUT =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
export const LABEL = "text-xs font-medium text-muted-foreground";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1 ${className ?? ""}`}>
      <span className={LABEL}>{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}

export function OkLine({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p>;
}

export type ActionOutcome = { success: true } | { error: string } | { success: true; [k: string]: unknown };

/**
 * Runs a server action inside a transition, shows its error sentence (actions return static sentences) and refreshes the page on
 * success. `run` returns true when the action succeeded.
 */
export function useRunner() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function run<T extends object>(fn: () => Promise<T>, opts: { okMessage?: string; refresh?: boolean; onSuccess?: (r: T) => void } = {}) {
    setError(null);
    setOk(null);
    startTransition(async () => {
      try {
        const r = await fn();
        if (r && typeof r === "object" && "error" in r && typeof (r as { error: unknown }).error === "string") {
          setError((r as { error: string }).error);
          return;
        }
        if (opts.okMessage) setOk(opts.okMessage);
        opts.onSuccess?.(r);
        if (opts.refresh !== false) router.refresh();
      } catch {
        setError("Something went wrong and nothing was saved. Reload the page and try again.");
      }
    });
  }
  return { pending, error, ok, run, setError, setOk };
}
