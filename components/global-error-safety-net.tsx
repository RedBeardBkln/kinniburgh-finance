"use client";

import { useEffect } from "react";

/**
 * Last-resort safety net mounted at the layout level: catches window-level
 * unhandled promise rejections and uncaught errors that escape React's tree
 * (e.g. telemetry SDKs with blocked transports firing after a page error).
 * The app's own error boundaries handle component crashes; this stops
 * third-party failures from ever reaching a white screen.
 */
export function GlobalErrorSafetyNet() {
  useEffect(() => {
    function onUnhandledRejection(e: PromiseRejectionEvent) {
      const msg = String((e.reason as Error)?.message ?? e.reason ?? "");
      // Telemetry/blocked-network rejections are expected with ad blockers
      // running; swallow them so the page stays alive.
      if (
        msg.includes("ERR_BLOCKED_BY_CLIENT") ||
        msg.includes("sentry") ||
        msg.includes("ingest.us") ||
        msg.includes("Failed to fetch")
      ) {
        e.preventDefault();
        return;
      }
      console.error("[global-safety-net] unhandled rejection:", e.reason);
    }

    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }, []);

  return null;
}