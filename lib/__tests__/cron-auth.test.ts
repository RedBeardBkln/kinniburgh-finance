import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

describe("isAuthorizedCronRequest", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the exact bearer header", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret-value")).toBe(true);
  });

  it("rejects missing, empty, wrong and malformed headers", () => {
    expect(isAuthorizedCronRequest(null)).toBe(false);
    expect(isAuthorizedCronRequest("")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer wrong-value")).toBe(false);
    expect(isAuthorizedCronRequest("s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("bearer s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer  s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cret-value ")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cret-valu")).toBe(false);
  });

  it("fails closed when CRON_SECRET is unset", () => {
    vi.unstubAllEnvs();
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCronRequest("Bearer undefined")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ")).toBe(false);
    expect(isAuthorizedCronRequest(null)).toBe(false);
  });

  it("fails closed when CRON_SECRET is empty", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCronRequest("Bearer ")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer undefined")).toBe(false);
  });
});

describe("every /api/cron route uses the shared check", () => {
  const root = join(process.cwd(), "app", "api", "cron");
  const routes = readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .map((d) => ({ name: d, src: readFileSync(join(root, d, "route.ts"), "utf8") }));

  it("finds the cron routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  for (const r of routes) {
    it(`${r.name} authorizes via isAuthorizedCronRequest, not an inline compare`, () => {
      expect(r.src).toContain("isAuthorizedCronRequest(");
      expect(r.src).not.toMatch(/!==\s*`Bearer \$\{process\.env\.CRON_SECRET\}`/);
    });
  }
});
