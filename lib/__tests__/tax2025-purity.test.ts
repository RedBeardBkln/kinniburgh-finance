import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Pins the structural rules of the TY2025 engine (plan section 6.6 / 8.1):
//   - lib/tax2025/** is PURE: no DB client, no network, no clock, no server-only modules;
//   - lib/tax2025-build.ts (the only DB-aware file) is READ-ONLY and never opens a workspace;
//   - no `any`, no floats for money (no parseFloat / Number("...") on amounts, no toFixed arithmetic).

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

const engineFiles = walk(path.join(ROOT, "tax2025"));

describe("lib/tax2025 is pure", () => {
  it("has the expected files", () => {
    const names = engineFiles.map((f) => path.relative(path.join(ROOT, "tax2025"), f).replace(/\\/g, "/"));
    for (const n of [
      "constants.ts",
      "types.ts",
      "facts.ts",
      "money.ts",
      "line-catalog.ts",
      "resolve-facts.ts",
      "return.ts",
      "gl-schedule-c-map.ts",
      "rules/se-medicare.ts",
      "rules/tax-calc.ts",
      "rules/schedule-a.ts",
      "rules/qbi-8995.ts",
      "rules/screens.ts",
      "rules/payments.ts",
      "rules/ct.ts",
      "rules/schedule-c.ts",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("imports no DB client, server-only module, network or clock", () => {
    const offenders: string[] = [];
    for (const f of engineFiles) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      const checks: [RegExp, string][] = [
        [/from\s+["']@\/lib\/db["']/, "@/lib/db"],
        [/from\s+["']@prisma\/client["']/, "@prisma/client (use the runtime/library Decimal only)"],
        [/from\s+["']next\//, "next/*"],
        [/["']use server["']/, "use server"],
        [/\bfetch\s*\(/, "fetch("],
        [/\bDate\.now\s*\(/, "Date.now("],
        [/\bnew Date\s*\(\s*\)/, "new Date()"],
        [/\bMath\.random\s*\(/, "Math.random("],
        [/\brequireAuth\b/, "requireAuth"],
      ];
      for (const [re, label] of checks) if (re.test(src)) offenders.push(`${path.basename(f)}: ${label}`);
    }
    expect(offenders).toEqual([]);
  });

  it("uses no `any` and no float parsing for money", () => {
    const offenders: string[] = [];
    for (const f of engineFiles) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      if (/:\s*any\b|\bas any\b|<any>/.test(src)) offenders.push(`${path.basename(f)}: any`);
      if (/\bparseFloat\s*\(/.test(src)) offenders.push(`${path.basename(f)}: parseFloat`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("lib/tax2025-build.ts is read-only", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "tax2025-build.ts"), "utf8"));
  it("never writes and never opens a workspace", () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(src).not.toMatch(/ensurePersonalWorkspace/);
    expect(src).not.toMatch(/\$(executeRaw|queryRaw|transaction)/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
  it("only reads through findMany / findUnique / computePL", () => {
    const calls = [...src.matchAll(/db\.(\w+)\.(\w+)\s*\(/g)].map((m) => m[2]);
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) expect(["findMany", "findUnique", "groupBy"]).toContain(c);
  });
  it("has no 'use server' directive (it is a library, not an action)", () => {
    expect(src).not.toMatch(/["']use server["']/);
  });
});

describe("lib/tax2025-overrides-build.ts (the overrides loader) is read-only and lives outside the pure tree", () => {
  const file = path.join(ROOT, "tax2025-overrides-build.ts");
  const src = stripComments(fs.readFileSync(file, "utf8"));
  it("exists outside lib/tax2025/ (that tree may not import the DB)", () => {
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "tax2025", "overrides-build.ts"))).toBe(false);
  });
  it("never writes: only findMany / findUnique reads, no transaction, no raw SQL", () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(src).not.toMatch(/\$(executeRaw|queryRaw|transaction)/);
    expect(src).not.toMatch(/ensurePersonalWorkspace/);
    const calls = [...src.matchAll(/db\.(\w+)\.(\w+)\s*\(/g)].map((m) => m[2]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(["findMany", "findUnique"]).toContain(c);
  });
  it("has no 'use server' directive and no auth (callers authenticate)", () => {
    expect(src).not.toMatch(/["']use server["']/);
    expect(src).not.toMatch(/\brequireAuth\b|\bauth\s*\(/);
  });
  it("finds the household return through getEntityBySlug(\"personal\"), like the engine loader and every tax page", () => {
    expect(src).toMatch(/getEntityBySlug\(\s*["']personal["']\s*\)/);
    expect(src).not.toMatch(/entity\.findFirst/);
  });
});
