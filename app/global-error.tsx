"use client";

import { useEffect } from "react";

/**
 * Global client-error boundary. When a client-side exception unmounts the
 * React tree (blank page), this renders a recovery screen instead. Stale
 * deployments are the most common cause after frequent production deploys:
 * a long-lived tab holds old chunk references; the next server action or
 * router refresh receives the new build's RSC payload and the tree crashes.
 * Auto-reloads once when that signature is detected.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const msg = (error?.message ?? "").toLowerCase();
    const isStaleBuild =
      msg.includes("failed to fetch") ||
      msg.includes("loading chunk") ||
      msg.includes("loading css") ||
      msg.includes("cannot find module") ||
      msg.includes("missing client reference") ||
      msg.includes("digest") && msg.includes("server");
    if (isStaleBuild && !sessionStorage.getItem("stale-build-reloaded")) {
      sessionStorage.setItem("stale-build-reloaded", "1");
      window.location.reload();
    } else {
      sessionStorage.removeItem("stale-build-reloaded");
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#fafafa",
          color: "#111",
        }}
      >
        <div style={{ maxWidth: 480, padding: 24, textAlign: "center" }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>
            Something interrupted this page
          </h2>
          <p style={{ margin: "0 0 16px", fontSize: 14, color: "#666", lineHeight: 1.5 }}>
            Your session stayed signed in and no data was lost. This usually happens when the
            app was updated in the background while your tab was open — reloading fixes it.
          </p>
          <button
            onClick={reset}
            style={{
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 8,
              border: "1px solid #ccc",
              background: "#111",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Reload the page
          </button>
          {error?.digest && (
            <p style={{ marginTop: 16, fontSize: 11, color: "#999" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}