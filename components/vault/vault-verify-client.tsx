"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

export function VaultVerifyClient() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function sendOtp() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/vault/send-otp", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send code");
      setSent(true);
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setSending(false);
    }
  }

  // Auto-send on mount
  useEffect(() => {
    sendOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/vault/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Verification failed");
      router.push("/vault" as Route);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 p-6">
        <div className="text-center space-y-1">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold">Vault Access</h1>
          <p className="text-sm text-muted-foreground">
            {sent
              ? "A 6-digit code has been sent to your email. It expires in 10 minutes."
              : "Sending verification code…"}
          </p>
        </div>

        <form onSubmit={verify} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Verification code</label>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-center text-2xl font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-primary"
              autoComplete="one-time-code"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={verifying || code.length < 6}
            className="w-full inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-10 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {verifying ? "Verifying…" : "Open Vault"}
          </button>
        </form>

        <div className="text-center">
          <button
            type="button"
            onClick={sendOtp}
            disabled={sending}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {sending ? "Sending…" : "Resend code"}
          </button>
        </div>
      </div>
    </div>
  );
}
