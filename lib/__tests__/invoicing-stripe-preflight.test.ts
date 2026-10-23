import { describe, expect, it } from "vitest";
import { stripePreflight } from "@/lib/invoicing/stripe/preflight";

// Stripe pre-flight (plan P5). Every value here is an obviously fake string built at run time, so the secret-shape scan never sees a
// key-shaped literal in this file.
const fake = (prefix: string) => prefix + "x".repeat(24);
const SK_TEST = fake("sk_" + "test_");
const RK_TEST = fake("rk_" + "test_");
const SK_LIVE = fake("sk_" + "live_");
const RK_LIVE = fake("rk_" + "live_");
const WH = fake("whsec" + "_");

const env = (over: Record<string, string | undefined>) => ({ STRIPE_SECRET_KEY: SK_TEST, STRIPE_WEBHOOK_SECRET: WH, STRIPE_MODE: "test", ...over });

describe("stripePreflight", () => {
  it("accepts test and live combinations with a key of the same mode (secret or restricted)", () => {
    expect(stripePreflight(env({}))).toEqual({ ok: true, mode: "test" });
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: RK_TEST }))).toEqual({ ok: true, mode: "test" });
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_MODE: "live" }))).toEqual({ ok: true, mode: "live" });
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: RK_LIVE, STRIPE_MODE: "live" }))).toEqual({ ok: true, mode: "live" });
  });

  it("refuses a missing, blank or whitespace-only key or webhook secret", () => {
    for (const k of [undefined, "", "   ", "\t"]) {
      expect(stripePreflight(env({ STRIPE_SECRET_KEY: k }))).toEqual({ ok: false, category: "not_configured" });
      expect(stripePreflight(env({ STRIPE_WEBHOOK_SECRET: k }))).toEqual({ ok: false, category: "not_configured" });
    }
  });

  it("refuses an unknown or missing mode", () => {
    for (const m of [undefined, "", "Test", "LIVE", "prod", "sandbox"]) expect(stripePreflight(env({ STRIPE_MODE: m }))).toEqual({ ok: false, category: "not_configured" });
  });

  it("a key of the other mode is a mode mix-up", () => {
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: RK_LIVE, STRIPE_MODE: "test" }))).toEqual({ ok: false, category: "mode_mismatch" });
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_MODE: "test" }))).toEqual({ ok: false, category: "mode_mismatch" });
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: SK_TEST, STRIPE_MODE: "live" }))).toEqual({ ok: false, category: "mode_mismatch" });
  });

  it("refuses a key that is not a Stripe secret or restricted key, and a webhook secret without the endpoint-secret prefix", () => {
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: fake("pk_" + "test_") }))).toEqual({ ok: false, category: "not_configured" });
    expect(stripePreflight(env({ STRIPE_SECRET_KEY: "sk_" + "test_" }))).toEqual({ ok: false, category: "not_configured" });
    expect(stripePreflight(env({ STRIPE_WEBHOOK_SECRET: "x".repeat(30) }))).toEqual({ ok: false, category: "not_configured" });
    expect(stripePreflight(env({ STRIPE_WEBHOOK_SECRET: "whsec" + "_" }))).toEqual({ ok: false, category: "not_configured" });
    expect(stripePreflight(env({ STRIPE_WEBHOOK_SECRET: `${WH} extra` }))).toEqual({ ok: false, category: "not_configured" });
  });

  it("never returns any input value", () => {
    const inputs = [env({}), env({ STRIPE_MODE: "live" }), env({ STRIPE_SECRET_KEY: "" }), env({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_MODE: "live" })];
    for (const e of inputs) {
      const out = JSON.stringify(stripePreflight(e));
      for (const v of [SK_TEST, SK_LIVE, WH, "x".repeat(24)]) expect(out).not.toContain(v);
    }
  });

  it("reads only the three Stripe variables (other env is ignored)", () => {
    expect(stripePreflight({ ...env({}), RESEND_API_KEY: "x", NEXTAUTH_URL: "https://a.example" })).toEqual({ ok: true, mode: "test" });
  });
});
