import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// Owner scope addition 3 (2026-10-23): when INVOICE_PUBLIC_BASE_URL is set and valid, its host serves ONLY the invoice pages; every
// other path there is a plain 404 (no redirect, no login page, no main-app host). Every other host behaves exactly as before.

const PAY = "https://pay.example.test";
const MAIN = "https://finance.example.test";
const TOKEN = "Ab3_-".repeat(8) + "xyz";
const KEYS = ["INVOICE_PUBLIC_BASE_URL", "STRIPE_MODE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.INVOICE_PUBLIC_BASE_URL = PAY;
  process.env.STRIPE_MODE = "live";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function run(origin: string, path: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  return middleware(new NextRequest(`${origin}${path}`, { method: init.method ?? "GET", headers }));
}

const isNext = (res: Response) => res.headers.get("x-middleware-next") === "1";
function isLoginRedirect(res: Response): boolean {
  const loc = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && !!loc && new URL(loc).pathname === "/login";
}
async function isPlain404(res: Response): Promise<boolean> {
  return res.status === 404 && res.headers.get("location") === null && !isNext(res) && (await res.text()) === "Not Found";
}

const ALLOWED = [`/i/${TOKEN}`, `/i/${TOKEN}/pdf`, "/i/paid", "/i/cancelled", "/api/favicon", "/api/logo"];
const BLOCKED = ["/", "/login", "/forgot-password", "/api/auth/session", "/api/auth/csrf", "/api/stripe/webhook", "/api/cron/notifications", "/business/x/invoices", "/dashboard", "/queue/abc", "/api/invoicing/x/pdf", "/robots.txt", "/sw.js", "/invoices", "/ix"];

describe("on the pay host", () => {
  it("lets the invoice pages, their PDF, the return pages and the layout's icon routes through (no session needed)", () => {
    for (const p of ALLOWED) expect(isNext(run(PAY, p)), p).toBe(true);
  });

  it("lets the /i page's own server-action POST through", () => {
    const res = run(PAY, `/i/${TOKEN}`, { method: "POST", headers: { "next-action": "abc123", "content-type": "text/plain;charset=UTF-8" } });
    expect(isNext(res)).toBe(true);
  });

  it("404s everything else, with and without a session cookie, and never names the main host", async () => {
    for (const p of BLOCKED) {
      for (const cookie of [undefined, "authjs.session-token=abc", "__Secure-authjs.session-token=abc"]) {
        const res = run(PAY, p, { cookie });
        expect(await isPlain404(res), `${p} ${cookie ?? ""}`).toBe(true);
        expect(JSON.stringify([...res.headers.entries()]), p).not.toContain("finance.example.test");
      }
    }
    expect(await isPlain404(run(PAY, "/api/stripe/webhook", { method: "POST" }))).toBe(true);
    expect(await isPlain404(run(PAY, "/business/x/invoices", { method: "POST", headers: { "next-action": "abc" } }))).toBe(true);
  });

  it("matches the host case-insensitively and port-aware", async () => {
    expect(await isPlain404(run("https://PAY.Example.Test", "/login"))).toBe(true);
    expect(isLoginRedirect(run("https://pay.example.test:8443", "/dashboard"))).toBe(true); // another port = another host
    process.env.INVOICE_PUBLIC_BASE_URL = "https://pay.example.test:8443";
    expect(await isPlain404(run("https://pay.example.test:8443", "/dashboard"))).toBe(true);
    expect(isLoginRedirect(run(PAY, "/dashboard"))).toBe(true);
  });
});

describe("every other host is unchanged", () => {
  it("the main host keeps its rules: /i public, the login gate elsewhere, /api/auth untouched", () => {
    for (const p of [`/i/${TOKEN}`, `/i/${TOKEN}/pdf`, "/i/paid", "/i/cancelled", "/api/stripe/webhook", "/login"]) expect(isNext(run(MAIN, p)), p).toBe(true);
    for (const p of ["/", "/dashboard", "/business/x/invoices"]) expect(isLoginRedirect(run(MAIN, p)), p).toBe(true);
    expect(isNext(run(MAIN, "/dashboard", { cookie: "authjs.session-token=abc" }))).toBe(true);
    // NextAuth's routes now pass through the middleware but are never gated (as when the matcher excluded them)
    for (const p of ["/api/auth/session", "/api/auth/csrf", "/api/auth/callback/credentials"]) {
      expect(isNext(run(MAIN, p)), p).toBe(true);
      expect(isNext(run(MAIN, p, { method: "POST" })), p).toBe(true);
    }
  });

  it.each([
    ["unset", undefined],
    ["blank", "  "],
    ["invalid (http)", "http://pay.example.test"],
    ["invalid (path)", "https://pay.example.test/pay"],
  ])("INVOICE_PUBLIC_BASE_URL %s: no host is restricted", (_label, value) => {
    if (value === undefined) delete process.env.INVOICE_PUBLIC_BASE_URL;
    else process.env.INVOICE_PUBLIC_BASE_URL = value;
    expect(isLoginRedirect(run(PAY, "/dashboard"))).toBe(true);
    expect(isNext(run(PAY, "/login"))).toBe(true);
    expect(isNext(run(PAY, "/api/auth/session"))).toBe(true);
    expect(isNext(run(PAY, `/i/${TOKEN}`))).toBe(true);
  });

  it("the matcher no longer excludes /api/auth (so the pay host can 404 it) and still excludes the static assets", async () => {
    const { config } = await import("@/middleware");
    const src = config.matcher[0]!;
    expect(src).not.toContain("api/auth");
    for (const a of ["_next/static", "_next/image", "favicon\\.ico", "manifest\\.webmanifest", "apple-touch-icon\\.png"]) expect(src).toContain(a);
  });
});
