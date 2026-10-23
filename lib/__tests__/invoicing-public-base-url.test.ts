import { describe, it, expect } from "vitest";
import { invoicePayHost, isPayHostPath, parseInvoicePublicBaseUrl } from "@/lib/invoicing/public-base-url";
import { INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE, payBaseUrlProblemMessage, payEnvironment } from "@/lib/invoicing/stripe/pay-env";
import { payLinkSendNote, payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { buildInvoiceEmail } from "@/lib/invoicing/email";
import { ACH_PREFERRED_TEXT } from "@/lib/invoicing/constants";

// stripe-ach-pending-hide-pay round 2 (owner scope additions 2 and 3): INVOICE_PUBLIC_BASE_URL and the e-mail pay button.

const STRIPE_TEST = { STRIPE_SECRET_KEY: "sk_" + "test_" + "x".repeat(24), STRIPE_WEBHOOK_SECRET: "whsec" + "_" + "y".repeat(24), STRIPE_MODE: "test" };
const STRIPE_LIVE = { STRIPE_SECRET_KEY: "sk_" + "live_" + "x".repeat(24), STRIPE_WEBHOOK_SECRET: "whsec" + "_" + "y".repeat(24), STRIPE_MODE: "live" };

describe("parseInvoicePublicBaseUrl", () => {
  it.each([
    ["https://pay.launchtime.example", "https://pay.launchtime.example"],
    ["https://pay.launchtime.example/", "https://pay.launchtime.example"],
    ["  https://pay.launchtime.example/  ", "https://pay.launchtime.example"],
    ["https://pay.launchtime.example\n", "https://pay.launchtime.example"],
    ["https://Pay.LaunchTime.Example", "https://pay.launchtime.example"],
    ["https://pay.example.test:8443", "https://pay.example.test:8443"],
    ["https://pay.example.test:443/", "https://pay.example.test"],
  ])("accepts %j as %j (live mode)", (raw, origin) => {
    expect(parseInvoicePublicBaseUrl(raw, "live")).toBe(origin);
    expect(parseInvoicePublicBaseUrl(raw, "test")).toBe(origin);
    expect(parseInvoicePublicBaseUrl(raw, null)).toBe(origin);
  });

  it.each([
    "",
    "pay.example.test",
    "//pay.example.test",
    "http://pay.example.test",
    "ftp://pay.example.test",
    "https://pay.example.test/pay",
    "https://pay.example.test//",
    "https://pay.example.test/?",
    "https://pay.example.test?x=1",
    "https://pay.example.test#frag",
    "https://user:pw@pay.example.test",
    "https://user@pay.example.test",
    "https://pay.example .test",
    "https://pay.example\n.test",
    "https://pay.example.test/\tx",
    "https://pay.example.test\\evil",
    "https://",
    "https://:443",
  ])("refuses %j", (raw) => {
    expect(parseInvoicePublicBaseUrl(raw, "live")).toBeNull();
    expect(parseInvoicePublicBaseUrl(raw, "test")).toBeNull();
  });

  it("localhost (http or https) only in Stripe test mode", () => {
    expect(parseInvoicePublicBaseUrl("http://localhost:3000", "test")).toBe("http://localhost:3000");
    expect(parseInvoicePublicBaseUrl("https://localhost:3000/", "test")).toBe("https://localhost:3000");
    expect(parseInvoicePublicBaseUrl("http://127.0.0.1:3000", "test")).toBe("http://127.0.0.1:3000");
    for (const mode of ["live", null] as const) {
      expect(parseInvoicePublicBaseUrl("http://localhost:3000", mode)).toBeNull();
      expect(parseInvoicePublicBaseUrl("https://localhost:3000", mode)).toBeNull();
    }
  });
});

describe("payEnvironment: the single link origin", () => {
  const app = { NEXTAUTH_URL: "https://finance.example.test" };

  it("unset (or blank) INVOICE_PUBLIC_BASE_URL: NEXTAUTH_URL exactly as before", () => {
    for (const v of [undefined, "", "   "]) {
      const e = payEnvironment({ ...STRIPE_TEST, ...app, INVOICE_PUBLIC_BASE_URL: v });
      expect(e).toMatchObject({ baseUrl: "https://finance.example.test", baseUrlSource: "nextauth_url", baseUrlProblem: null });
    }
  });

  it("a valid INVOICE_PUBLIC_BASE_URL wins over NEXTAUTH_URL, trailing slash trimmed", () => {
    const e = payEnvironment({ ...STRIPE_LIVE, ...app, INVOICE_PUBLIC_BASE_URL: "https://pay.example.test/" });
    expect(e).toMatchObject({ baseUrl: "https://pay.example.test", baseUrlSource: "invoice_public_base_url", baseUrlProblem: null });
    // also without NEXTAUTH_URL, and while Stripe is not configured (links are still made for viewing)
    expect(payEnvironment({ INVOICE_PUBLIC_BASE_URL: "https://pay.example.test" }).baseUrl).toBe("https://pay.example.test");
  });

  it("an invalid INVOICE_PUBLIC_BASE_URL is NOT a silent fallback: no origin, problem named", () => {
    for (const bad of ["http://pay.example.test", "https://pay.example.test/x", "nonsense", "http://localhost:3000"]) {
      const e = payEnvironment({ ...STRIPE_LIVE, ...app, INVOICE_PUBLIC_BASE_URL: bad });
      expect(e, bad).toMatchObject({ baseUrl: null, baseUrlSource: null, baseUrlProblem: "invoice_public_base_url_invalid" });
      expect(payOnlineEligibility({ enabled: true, configured: e.configured, baseUrl: e.baseUrl, status: "issued", balanceCents: 5_000, bankPending: false })).toEqual({ ok: false, reason: "no_base_url" });
    }
  });

  it("NEXTAUTH_URL problems keep their own words", () => {
    expect(payEnvironment({ ...STRIPE_TEST }).baseUrlProblem).toBe("app_url_missing");
    expect(payEnvironment({ ...STRIPE_LIVE, NEXTAUTH_URL: "http://finance.example.test" }).baseUrlProblem).toBe("app_url_not_https");
  });

  it("the owner's messages name the variable, never its value", () => {
    const bad = "https://pay.example.test/secret-path";
    const e = payEnvironment({ ...STRIPE_TEST, ...app, INVOICE_PUBLIC_BASE_URL: bad });
    const msg = payBaseUrlProblemMessage(e.baseUrlProblem!);
    expect(msg).toBe(INVOICE_PUBLIC_BASE_URL_INVALID_MESSAGE);
    expect(msg).toMatch(/^INVOICE_PUBLIC_BASE_URL is invalid/);
    expect(msg).not.toContain("secret-path");
    expect(JSON.stringify(e)).not.toContain("secret-path");
    const elig = payOnlineEligibility({ enabled: true, configured: e.configured, baseUrl: e.baseUrl, status: "issued", balanceCents: 5_000, bankPending: false });
    expect(payLinkSendNote(true, elig, true)).toBe("Online payments are on, but INVOICE_PUBLIC_BASE_URL is invalid, so this e-mail will go without a pay link.");
    expect(payLinkSendNote(true, elig)).toBe("Online payments are on but not set up, so this e-mail will go without a pay link.");
    // only no_base_url is affected by the flag
    expect(payLinkSendNote(true, { ok: false, reason: "not_configured" }, true)).toBe("Online payments are on but not set up, so this e-mail will go without a pay link.");
  });
});

describe("invoicePayHost / isPayHostPath (middleware helpers)", () => {
  it("the host of a valid value, lower case and port-aware; unset or invalid = null", () => {
    expect(invoicePayHost("https://Pay.LaunchTime.Example/", "live")).toBe("pay.launchtime.example");
    expect(invoicePayHost("https://pay.example.test:8443", "live")).toBe("pay.example.test:8443");
    expect(invoicePayHost(undefined, "live")).toBeNull();
    expect(invoicePayHost("  ", "live")).toBeNull();
    expect(invoicePayHost("https://pay.example.test/x", "live")).toBeNull();
    expect(invoicePayHost("http://localhost:3000", "live")).toBeNull();
    expect(invoicePayHost("http://localhost:3000", "test")).toBe("localhost:3000");
    expect(invoicePayHost("http://localhost:3000", "bogus")).toBeNull();
  });

  it("only /i, /i/... and the two layout icon routes", () => {
    for (const p of ["/i", "/i/abc", "/i/abc/pdf", "/i/paid", "/i/cancelled", "/api/favicon", "/api/logo"]) expect(isPayHostPath(p), p).toBe(true);
    for (const p of ["/", "/login", "/ix", "/invoices", "/income", "/api/auth/session", "/api/stripe/webhook", "/api/logo/x", "/api/favicons", "/business/x/invoices", "/x/i/abc", "/robots.txt", "/sw.js"]) {
      expect(isPayHostPath(p), p).toBe(false);
    }
  });
});

describe("the e-mail pay button (scope addition 2)", () => {
  const base = { displayNumber: "3100", businessName: "LaunchTime Solutions", totalText: "$100.00", balanceText: "$100.00", dueText: "Due upon receipt", footerText: null };
  const URL_ = "https://pay.example.test/i/" + "A".repeat(43);

  it("HTML: one bulletproof button whose href is the only place the URL appears; ACH sentence under it", () => {
    const { html, text } = buildInvoiceEmail({ ...base, payUrl: URL_ });
    expect(html.split(URL_)).toHaveLength(2);
    expect(html).toContain(`href="${URL_}"`);
    expect(html).toMatch(/<table role="presentation"[^>]*><tr><td[^>]*bgcolor="#7A6200"[^>]*><a href="[^"]+" style="[^"]*display:inline-block[^"]*padding:12px 24px[^"]*border-radius:6px[^"]*background-color:#7A6200[^"]*color:#FFFFFF[^"]*">View and pay online<\/a><\/td><\/tr><\/table>/);
    const visible = html.replace(/<[^>]*>/g, " ");
    expect(visible).not.toMatch(/https?:|\/i\//);
    expect(html.indexOf(ACH_PREFERRED_TEXT)).toBeGreaterThan(html.indexOf("View and pay online</a>"));
    expect(html).not.toMatch(/<style|class=/);
    // the text part keeps the written-out URL
    expect(text).toContain(`View and pay online: ${URL_}\n${ACH_PREFERRED_TEXT}`);
  });

  it("the href is HTML-escaped and an unsafe URL produces no button", () => {
    const amp = "https://pay.example.test/i/abc?x=1&y=2";
    expect(buildInvoiceEmail({ ...base, payUrl: amp }).html).toContain('href="https://pay.example.test/i/abc?x=1&amp;y=2"');
    const bad = buildInvoiceEmail({ ...base, payUrl: 'javascript:alert("x")' });
    expect(bad.html).not.toContain("View and pay online");
    expect(bad).toEqual(buildInvoiceEmail(base));
  });
});
