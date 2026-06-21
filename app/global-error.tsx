"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "monospace", padding: "2rem", maxWidth: "800px" }}>
        <h1 style={{ color: "#dc2626" }}>Server Error</h1>
        <p><strong>Message:</strong> {error.message}</p>
        {error.digest && <p><strong>Digest:</strong> {error.digest}</p>}
        <pre style={{ background: "#f3f4f6", padding: "1rem", overflow: "auto", fontSize: "0.8rem" }}>
          {error.stack}
        </pre>
        <button onClick={reset} style={{ marginTop: "1rem", padding: "0.5rem 1rem" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
