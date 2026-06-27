"use client";

import { useEffect, useState, useTransition } from "react";
import { signOut } from "next-auth/react";
import { generateTotpSetup, verifyTotpSetup } from "@/actions/auth";

export default function Setup2faPage() {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    generateTotpSetup().then(({ qrDataUrl, secret }) => {
      setQrDataUrl(qrDataUrl);
      setSecret(secret);
    });
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await verifyTotpSetup(code);
      if (result.success) {
        setDone(true);
        setTimeout(() => signOut({ redirectTo: "/login" }), 2000);
      } else {
        setError("Incorrect code — check your authenticator app and try again.");
      }
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Set up two-factor authentication</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scan the QR code with Google Authenticator, Authy, or any TOTP app.
          </p>
        </div>

        {done ? (
          <div className="rounded-md bg-green-50 px-4 py-3 text-center text-sm text-green-800">
            2FA enabled — signing you out to re-authenticate…
          </div>
        ) : (
          <>
            <div className="flex justify-center">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="2FA QR code" className="h-48 w-48 rounded-md border" />
              ) : (
                <div className="h-48 w-48 animate-pulse rounded-md bg-muted" />
              )}
            </div>

            {secret && (
              <div className="space-y-1 text-center">
                <p className="text-xs text-muted-foreground">
                  Can&apos;t scan? Enter this key manually:
                </p>
                <p className="font-mono text-sm tracking-widest break-all">{secret}</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="code" className="block text-sm font-medium">
                  Enter the 6-digit code from your app
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-center font-mono text-lg tracking-widest ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <button
                type="submit"
                disabled={isPending || code.length !== 6}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isPending ? "Verifying…" : "Enable 2FA"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
