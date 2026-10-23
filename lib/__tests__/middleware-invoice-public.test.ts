import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// The /i (client invoice link) and /api/stripe/webhook exemptions must be deliberately narrow: exactly /i, /i/... and the one webhook
// path, nothing else, and no other route may lose its login redirect.

function run(path: string, cookie?: string) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  return middleware(new NextRequest(`http://localhost${path}`, { headers }));
}

function isRedirectToLogin(res: Response): boolean {
  const loc = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && !!loc && new URL(loc).pathname === "/login";
}

const TOKEN = "Ab3_-".repeat(8) + "xyz";

describe("middleware /i and Stripe webhook exemptions", () => {
  it("lets the client's link, its PDF, the static return pages and the webhook through without a session cookie", () => {
    expect(TOKEN).toHaveLength(43);
    for (const p of [`/i/${TOKEN}`, `/i/${TOKEN}/pdf`, "/i/paid", "/i/cancelled", "/api/stripe/webhook"]) {
      const res = run(p);
      expect(isRedirectToLogin(res), p).toBe(false);
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
    }
  });

  it("does not exempt look-alike paths", () => {
    for (const p of ["/invoices", "/income", "/insurance", "/i-x", "/ix/abc", "/api/stripe", "/api/stripe/other", "/api/stripe/webhookx", "/api/stripe/webhook-x", "/business/ek-consulting/invoices", "/api/invoicing/x/pdf", "/x/i/abc"]) {
      expect(isRedirectToLogin(run(p)), p).toBe(true);
    }
  });

  it("the owner's invoicing pages still need a session", () => {
    expect(isRedirectToLogin(run("/business/ek-consulting/invoicing/payments-online"))).toBe(true);
    expect(isRedirectToLogin(run("/business/ek-consulting/invoices", "authjs.session-token=abc"))).toBe(false);
  });
});
