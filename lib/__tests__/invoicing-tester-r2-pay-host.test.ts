import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";
import { parseInvoicePublicBaseUrl, invoicePayHost, isPayHostPath } from "@/lib/invoicing/public-base-url";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";
import { buildInvoiceEmail } from "@/lib/invoicing/email";

// Tester round 2 (stripe-ach-pending-hide-pay, owner scope additions 2 and 3): edge cases beyond the Coder's tests.

const KEYS = ["INVOICE_PUBLIC_BASE_URL", "STRIPE_MODE"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.INVOICE_PUBLIC_BASE_URL = "https://pay.example.test";
  process.env.STRIPE_MODE = "live";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const matcher = new RegExp("^" + config.matcher[0]! + "$");
const isNext = (r: Response) => r.headers.get("x-middleware-next") === "1";

describe("pay host: path tricks never reach a non-invoice route", () => {
  it.each([
    ["/i/../login", 404],
    ["/i/%2e%2e/login", 404],
    ["/i%2f..%2flogin", 404],
    ["//login", 404],
    ["/I/abc", 404],
    ["/i;/login", 404],
    ["/API/auth/session", 404],
    ["/api/authx", 404],
    ["/api/favicon/x", 404],
    ["/api/logo.png", 404],
    ["/i", 200],
  ])("%s -> %i", (p, status) => {
    const res = middleware(new NextRequest("https://pay.example.test" + p, { headers: { cookie: "authjs.session-token=a" } }));
    expect(res.status).toBe(status);
    expect(res.headers.get("location")).toBeNull();
  });

  it("forwarded / host headers on the request object cannot make the pay host look like the main host or vice versa", () => {
    const onPay = middleware(new NextRequest("https://pay.example.test/login", { headers: { host: "finance.example.test", "x-forwarded-host": "finance.example.test" } }));
    expect(onPay.status).toBe(404);
    const onMain = middleware(new NextRequest("https://finance.example.test/dashboard", { headers: { host: "pay.example.test", "x-forwarded-host": "pay.example.test" } }));
    expect(onMain.status).toBe(307); // the session gate, unchanged
  });

  it("the pay-host rule never lets an unauthenticated request past the gate: every non-public path is 404 or a login redirect on any host", () => {
    const paths = ["/", "/dashboard", "/business/ek/invoices", "/api/invoicing/x/pdf", "/tax/forms", "/advisor", "/api/advisor/chat"];
    for (const host of ["https://pay.example.test", "https://finance.example.test", "https://PAY.example.test:443"]) {
      for (const p of paths) {
        const res = middleware(new NextRequest(host + p));
        expect(isNext(res), `${host}${p}`).toBe(false);
      }
    }
  });
});

describe("non-pay hosts: NextAuth routes", () => {
  it("every /api/auth/** route is matched by the middleware and passes untouched, GET and POST, with or without a cookie", () => {
    for (const p of ["/api/auth", "/api/auth/session", "/api/auth/csrf", "/api/auth/providers", "/api/auth/signin/credentials", "/api/auth/callback/credentials", "/api/auth/signout", "/api/auth/error"]) {
      expect(matcher.test(p), p).toBe(true);
      for (const method of ["GET", "POST"]) {
        for (const cookie of [undefined, "authjs.session-token=a"]) {
          const res = middleware(new NextRequest("https://finance.example.test" + p, { method, headers: cookie ? { cookie } : {} }));
          expect(isNext(res), `${method} ${p}`).toBe(true);
          expect([...res.headers.keys()].sort(), p).toEqual(["x-middleware-next"]);
        }
      }
    }
  });
});

describe("validator edge cases", () => {
  it.each([
    ["https://pay.example.com:443", "https://pay.example.com"],
    ["https://pay.example.com:8443/", "https://pay.example.com:8443"],
    ["https://Pay.Example.COM", "https://pay.example.com"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    [" https://pay.example.com/\n", "https://pay.example.com"],
  ])("accepts %j as %s", (raw, origin) => {
    expect(parseInvoicePublicBaseUrl(raw, "live")).toBe(origin);
  });

  it.each([
    "https://pay.example.com//", "https://pay.example.com/.", "https://pay.example.com/%2e", "https://@pay.example.com", "https://u@pay.example.com",
    "https://pay.example.com:99999", "https://pay.example.com\\", "https://pay .example.com", "ftp://pay.example.com", "https://", "pay.example.com",
    "https://localhost", "http://a.localhost", "http://[::1]:3000",
  ])("refuses %j in live mode", (raw) => {
    expect(parseInvoicePublicBaseUrl(raw, "live")).toBeNull();
  });

  it("STRIPE_MODE is compared exactly in the middleware (a wrong-case mode is not test mode)", () => {
    expect(invoicePayHost("http://localhost:3000", "TEST")).toBeNull();
    expect(invoicePayHost("http://localhost:3000", "test")).toBe("localhost:3000");
  });

  it("isPayHostPath is exact", () => {
    expect(["/i", "/i/", "/i/x", "/api/favicon", "/api/logo"].every(isPayHostPath)).toBe(true);
    expect(["/ix", "/I/x", "/api/favicon/", "/api/logo/x", "/", "/invoices"].some(isPayHostPath)).toBe(false);
  });

  it("an invalid value never falls back to NEXTAUTH_URL and the result never carries the value", () => {
    for (const v of ["http://pay.example.com", "https://pay.example.com/x", "nonsense-value", "https://localhost", "https://pay.example.com?a=1"]) {
      const e = payEnvironment({ NEXTAUTH_URL: "https://finance.example.test", INVOICE_PUBLIC_BASE_URL: v });
      expect(e.baseUrl, v).toBeNull();
      expect(e.baseUrlProblem).toBe("invoice_public_base_url_invalid");
      expect(JSON.stringify(e)).not.toContain("pay.example.com");
      expect(JSON.stringify(e)).not.toContain("nonsense-value");
    }
  });
});

describe("e-mail button: no HTML injection through the URL", () => {
  const base = { displayNumber: "3100", businessName: "LaunchTime", totalText: "$10.00", balanceText: "$10.00", dueText: "Due Nov 1, 2026", footerText: "LaunchTime" };
  it.each([
    "https://pay.example.com/i/a&b=<x>",
    'https://pay.example.com/i/a"onmouseover=alert(1)',
    "https://pay.example.com/i/a'x",
    "https://pay.example.com/i/a></a><script>alert(1)</script>",
    "javascript:alert(1)",
    "https://pay.example.com/i/a&quot;onx=1",
  ])("%s", (u) => {
    const m = buildInvoiceEmail({ ...base, payUrl: u });
    const tags = m.html.match(/<[a-z!/][^>]*>/gi) ?? [];
    expect(tags.filter((t) => /<\/?(script|img)\b|\son\w+=/i.test(t))).toEqual([]);
    expect(m.html.replace(/<[^>]*>/g, "")).not.toContain("pay.example.com");
    expect((m.html.match(/<a\b/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("an & in the URL is escaped once in the href and the URL text appears only there", () => {
    const m = buildInvoiceEmail({ ...base, payUrl: "https://pay.example.com/i/Ab-_x&y" });
    expect(m.html.split("pay.example.com").length - 1).toBe(1);
    expect(m.html).toContain('href="https://pay.example.com/i/Ab-_x&amp;y"');
    expect(m.text).toContain("View and pay online: https://pay.example.com/i/Ab-_x&y");
  });
});
