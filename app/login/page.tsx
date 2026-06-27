"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { checkMfaStatus } from "@/actions/auth";
import { BananaIcon } from "@/components/logo";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const justReset = searchParams.get("reset") === "1";

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const status = await checkMfaStatus(email, password);
    setLoading(false);

    if ("invalid" in status) {
      setError("Invalid email or password.");
      return;
    }

    if (status.needsMfa) {
      setNeedsTotp(true);
      return;
    }

    const result = await signIn("credentials", { email, password, redirect: false });
    if (result?.ok) {
      router.push("/");
      router.refresh();
    } else {
      setError("Sign-in failed. Please try again.");
    }
  }

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      totpCode,
      redirect: false,
    });

    setLoading(false);

    if (result?.ok) {
      router.push("/");
      router.refresh();
    } else {
      setError("Invalid code. Please try again.");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Logo mark */}
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <BananaIcon className="h-10 w-10 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Banana Stand</h1>
            <p className="text-sm text-muted-foreground">Your financial command center</p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          {justReset && (
            <div className="mb-4 rounded-lg bg-green-50 px-3 py-2.5 text-sm text-green-800">
              Password updated — sign in with your new password.
            </div>
          )}

          {!needsTotp ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="email" className="block text-sm font-medium">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="you@example.com"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="block text-sm font-medium">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 pr-16 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="text-right">
                  <Link
                    href="/forgot-password"
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
              </div>

              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "Checking…" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleTotpSubmit} className="space-y-4">
              <div className="text-center pb-2">
                <p className="text-sm font-medium">Two-factor authentication</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Enter the 6-digit code from your authenticator app.
                </p>
              </div>

              <div className="space-y-1.5">
                <input
                  id="totp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  autoFocus
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-lg border border-input bg-background px-3 py-3 text-center font-mono text-2xl tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="000000"
                />
              </div>

              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || totpCode.length < 6}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "Verifying…" : "Verify"}
              </button>

              <button
                type="button"
                onClick={() => { setNeedsTotp(false); setError(null); setTotpCode(""); }}
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                ← Back
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
