// Stripe pre-flight (plan P5, mirrors lib/invoicing/email.ts#emailPreflight). PURE: no DB, no network, no clock.
//
// Reads ONLY three environment variables, by name: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_MODE. It never returns, logs or
// echoes a value: the result carries a mode word or a static category only. Online payments are "configured" only when:
//  - STRIPE_MODE is exactly "test" or "live";
//  - the key is non-blank and is a secret or restricted key FOR THAT MODE (a live key with STRIPE_MODE=test, or the reverse, is a
//    mode mix-up and fails as "mode_mismatch");
//  - the webhook endpoint secret is non-blank (not whitespace-only) and has the endpoint-secret prefix.
// The prefix literals below are the only place they appear in the code; the secret-shape scan matches key-SHAPED strings only.

export type StripeMode = "test" | "live";

export type StripePreflight = { ok: true; mode: StripeMode } | { ok: false; category: "not_configured" | "mode_mismatch" };

export const STRIPE_ENV_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE"] as const;

const KEY_PREFIXES: Record<StripeMode, readonly string[]> = {
  test: ["sk_test_", "rk_test_"],
  live: ["sk_live_", "rk_live_"],
};
const WEBHOOK_SECRET_PREFIX = "whsec_";

export function stripePreflight(env: Readonly<Record<string, string | undefined>>): StripePreflight {
  const no = { ok: false, category: "not_configured" } as const;
  const modeRaw = env["STRIPE_MODE"] ?? "";
  if (modeRaw.trim() !== "test" && modeRaw.trim() !== "live") return no;
  const mode: StripeMode = modeRaw.trim() === "live" ? "live" : "test";
  const key = env["STRIPE_SECRET_KEY"] ?? "";
  const secret = env["STRIPE_WEBHOOK_SECRET"] ?? "";
  if (key.trim() === "" || secret.trim() === "") return no;
  if (/\s/.test(key.trim()) || /\s/.test(secret.trim())) return no;
  if (!secret.trim().startsWith(WEBHOOK_SECRET_PREFIX) || secret.trim().length <= WEBHOOK_SECRET_PREFIX.length) return no;
  const k = key.trim();
  const other: StripeMode = mode === "live" ? "test" : "live";
  if (KEY_PREFIXES[other].some((p) => k.startsWith(p))) return { ok: false, category: "mode_mismatch" };
  if (!KEY_PREFIXES[mode].some((p) => k.startsWith(p) && k.length > p.length)) return no;
  return { ok: true, mode };
}

/** The sentence the owner sees when online payments cannot be switched on (names the variables, never a value). */
export const STRIPE_NOT_CONFIGURED_MESSAGE =
  "Online payments are not set up: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_MODE (test or live) must be set in Vercel, and the key must belong to that mode.";
export const STRIPE_MODE_MISMATCH_MESSAGE =
  "Online payments are not set up: the Stripe key in STRIPE_SECRET_KEY belongs to the other mode than STRIPE_MODE. Use a key of the same mode.";
