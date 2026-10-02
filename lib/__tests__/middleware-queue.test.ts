import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// The /queue exemption must be deliberately narrow: exactly /queue and
// /queue/..., nothing else, and no other route may lose its login redirect.

function run(path: string, cookie?: string) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  return middleware(new NextRequest(`http://localhost${path}`, { headers }));
}

function isRedirectToLogin(res: Response): boolean {
  const loc = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && !!loc && new URL(loc).pathname === "/login";
}

describe("middleware /queue exemption", () => {
  it("lets /queue/<token> through with no session cookie", () => {
    const res = run("/queue/" + "a".repeat(43));
    expect(isRedirectToLogin(res)).toBe(false);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not exempt look-alike paths", () => {
    for (const p of ["/queues", "/queue-admin", "/queueX/abc", "/api/queue/abc", "/x/queue/abc"]) {
      expect(isRedirectToLogin(run(p)), p).toBe(true);
    }
  });

  it("still redirects every protected route to /login without a session", () => {
    for (const p of [
      "/transactions",
      "/transactions/some-id",
      "/tag-rules",
      "/tags",
      "/api/tags",
      "/settings",
      "/",
    ]) {
      expect(isRedirectToLogin(run(p)), p).toBe(true);
    }
  });

  it("existing public paths are unchanged", () => {
    for (const p of ["/login", "/forgot-password", "/reset-password/abc", "/privacy", "/offline", "/api/cron/notifications"]) {
      expect(isRedirectToLogin(run(p)), p).toBe(false);
    }
  });

  it("protected routes pass with a session cookie", () => {
    expect(isRedirectToLogin(run("/transactions", "authjs.session-token=abc"))).toBe(false);
  });
});
