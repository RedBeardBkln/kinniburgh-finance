import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/lib/invoicing/stripe/client";

// Secret-shape scan and SDK pins for the Stripe pay link (plan S1). No env value is read here.
//  - no Stripe key- or webhook-secret-SHAPED string exists in the code, specs, data, pipeline notes, .env.example or CLAUDE.md;
//  - the `stripe` dependency is pinned to an exact version;
//  - only lib/invoicing/stripe/client.ts imports `stripe` (value or type) among app / lib / actions / components;
//  - the client pins the API version, and that constant equals the installed SDK's own version (an un-reviewed SDK bump fails here).

const root = process.cwd();
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|prisma|csv|txt|yml|yaml|html|css|example|env)$/i;
const SKIP = new Set(["node_modules", ".next", ".git", "worktrees", ".vercel", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (TEXT.test(ent.name) && statSync(join(root, rel)).size < 5_000_000) out.push(rel);
  }
  return out;
}

const KEY_SHAPE = /\b(sk|rk)_(test|live)_[A-Za-z0-9]{16,}/;
const WEBHOOK_SHAPE = /\bwhsec_[A-Za-z0-9]{16,}/;

describe("no Stripe secret-shaped string is in the repository", () => {
  const files = [...["app", "lib", "actions", "components", "prisma", "scripts", "specs", "data", ".claude/pipeline", ".claude/agent-memory"].flatMap((d) => walk(d)), ".env.example", "CLAUDE.md", "package.json", "next.config.ts", "middleware.ts"].filter((f) =>
    existsSync(join(root, f))
  );
  it("there are files to scan", () => expect(files.length).toBeGreaterThan(200));
  it("no key-shaped or webhook-secret-shaped value", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      if (KEY_SHAPE.test(src) || WEBHOOK_SHAPE.test(src)) hits.push(f);
    }
    expect(hits).toEqual([]);
  }, 120_000);
});

describe("the stripe SDK", () => {
  it("is pinned to an exact version (no range)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.stripe).toBe("23.0.1");
  });

  it("is imported only by lib/invoicing/stripe/client.ts", () => {
    const users = ["app", "lib", "actions", "components"]
      .flatMap((d) => walk(d))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("/__tests__/"))
      .filter((f) => /from\s+["']stripe(?:\/[^"']*)?["']|require\(\s*["']stripe["']\s*\)|import\(\s*["']stripe["']\s*\)/.test(readFileSync(join(root, f), "utf8")));
    expect(users).toEqual(["lib/invoicing/stripe/client.ts"]);
  });

  it("the client pins apiVersion from a constant equal to the installed SDK's own API version", () => {
    const src = readFileSync(join(root, "lib/invoicing/stripe/client.ts"), "utf8");
    expect(src).toMatch(/export const STRIPE_API_VERSION = "2026-09-30\.endive" as const;/);
    expect(src).toMatch(/apiVersion: STRIPE_API_VERSION/);
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
  });

  it("the webhook signature is verified with the SDK's default tolerance (no tolerance argument is passed)", () => {
    const src = readFileSync(join(root, "lib/invoicing/stripe/client.ts"), "utf8");
    expect(src).toMatch(/Stripe\.webhooks\.constructEvent\(raw, signature, secret\)/);
  });
});
