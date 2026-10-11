import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard (utility-usage-upload, seasonal energy step 3). The uploaded usage rows are owner data that is only
// ever inserted or archived, so:
//  1. only the loader and the store touch the UtilityUsage table; the loader never writes; nothing deletes or upserts;
//  2. the parser, the usage model and the form rules are pure; the client leaves import only types from them;
//  3. the migration is purely additive (one new table);
//  4. the screens and engines that must not change never import the new modules;
//  5. the seasonal loader reads usage in an isolated try/catch so a usage failure never drops the payments-based estimates.

const root = process.cwd();
const cache = new Map<string, string>();
const read = (rel: string) => {
  let src = cache.get(rel);
  if (src === undefined) {
    src = readFileSync(join(root, rel), "utf8");
    cache.set(rel, src);
  }
  return src;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "__tests__") continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel);
  }
  return out;
}
const SOURCE_FILES = ["app", "lib", "actions", "components"].flatMap((d) => walk(d));
const noComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

const NEW_FILES = [
  "lib/utility-usage-parse.ts",
  "lib/utility-usage-form.ts",
  "lib/utility-usage-build.ts",
  "lib/utility-usage-store.ts",
  "lib/seasonal-energy-usage.ts",
  "actions/utility-usage.ts",
  "components/forecast/usage-history.tsx",
  "components/forecast/usage-upload-form.tsx",
  "components/forecast/usage-archive-button.tsx",
  "prisma/migrations/20261013000000_utility_usage/migration.sql",
];
const CLIENT_LEAVES = ["components/forecast/usage-upload-form.tsx", "components/forecast/usage-archive-button.tsx"];

describe("the new files exist", () => {
  it.each(NEW_FILES)("%s", (f) => expect(existsSync(join(root, f))).toBe(true));
});

describe("only the loader and the store touch the UtilityUsage table", () => {
  it("db.utilityUsage appears in exactly the two files", () => {
    const users = SOURCE_FILES.filter((f) => /\.utilityUsage\b/.test(noComments(read(f)))).sort();
    expect(users).toEqual(["lib/utility-usage-build.ts", "lib/utility-usage-store.ts"]);
  });

  it("the loader is read-only with an explicit select, a live-rows filter and no auth", () => {
    const src = noComments(read("lib/utility-usage-build.ts"));
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect(src).not.toMatch(/\binclude:/);
    expect(src).toMatch(/select:/);
    expect(src).toMatch(/archivedAt:\s*null/);
    expect(src).not.toMatch(/^"use server"/m);
    expect(src).not.toMatch(/next\/cache|revalidatePath|requireAuth|next-auth/);
  });

  it("the store never deletes or upserts, and its only update archives (archivedAt set, liveKey cleared)", () => {
    const src = noComments(read("lib/utility-usage-store.ts"));
    expect(src).not.toMatch(/\.(delete|deleteMany|upsert)\(/);
    expect(src).not.toMatch(/\.utilityUsage\.update\(/);
    const updates = [...src.matchAll(/\.utilityUsage\.updateMany\(\{[\s\S]*?\}\)\s*;/g)].map((m) => m[0]);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) {
      expect(u).toMatch(/archivedAt:\s*new Date\(\)/);
      expect(u).toMatch(/liveKey:\s*null/);
      expect(u).toMatch(/archivedAt:\s*null/); // only live rows can be archived
      expect(u).not.toMatch(/quantity|costCents|note\b|period|occurredOn/);
    }
    expect(src).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it("the actions reach the table only through the store (no direct model access, no raw SQL)", () => {
    const src = noComments(read("actions/utility-usage.ts"));
    expect(src).not.toMatch(/\.utilityUsage\b|\$executeRaw|\$queryRaw/);
    expect(src).toMatch(/from "@\/lib\/utility-usage-store"/);
  });

  it("only the actions import the store", () => {
    const users = SOURCE_FILES.filter((f) => /utility-usage-store/.test(noComments(read(f)))).sort();
    expect(users).toEqual(["actions/utility-usage.ts"]);
  });
});

describe("purity", () => {
  it.each(["lib/utility-usage-parse.ts", "lib/utility-usage-form.ts", "lib/seasonal-energy-usage.ts"])("%s has no database, clock, randomness or Next.js", (f) => {
    const src = noComments(read(f));
    expect(src).not.toMatch(/from "@\/lib\/db"|from "\.\/db"|next\/|next-auth|server-only/);
    expect(src).not.toMatch(/\bnew Date\(\)|Date\.now\(|process\.env|Math\.random/);
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it("the usage model imports only types from the seasonal model (no import cycle)", () => {
    const src = read("lib/seasonal-energy-usage.ts");
    const imports = [...src.matchAll(/^import ([^;]*?) from "(@\/lib\/seasonal-energy)";/gm)];
    expect(imports.length).toBe(1);
    expect(imports[0]![1]).toMatch(/^type \{/);
  });

  it("the action file only exports async functions and starts with the directive", () => {
    const src = read("actions/utility-usage.ts");
    expect(src.startsWith('"use server";')).toBe(true);
    const exports = src.split("\n").filter((l) => l.startsWith("export "));
    expect(exports.length).toBe(4);
    for (const e of exports) expect(e).toMatch(/^export async function /);
  });
});

describe("client leaves stay light", () => {
  it.each(CLIENT_LEAVES)("%s imports actions, React/Next, the pure form rules and TYPES only", (f) => {
    const src = read(f);
    expect(src.startsWith('"use client";')).toBe(true);
    for (const m of src.matchAll(/^import (type )?[^;]*from "([^"]+)";/gm)) {
      const [, isType, mod] = m;
      expect(mod, `${f}: ${mod}`).not.toMatch(/@prisma|lib\/db|utility-usage-(build|store)|seasonal-energy-(build|usage)$|\/budget/);
      if (/lib\/utility-usage-parse|lib\/seasonal-energy/.test(mod!)) expect(isType, `${f}: ${mod}`).toBe("type ");
    }
  });

  it("no client component anywhere imports the parser, the usage model, the loader or the store as a value", () => {
    const clients = SOURCE_FILES.filter((f) => /^["']use client["']/m.test(read(f)));
    for (const f of clients) {
      expect(read(f), f).not.toMatch(/^import (?!type)[^;]*from "@\/lib\/(utility-usage-(parse|build|store)|seasonal-energy-usage)";/m);
    }
  });
});

describe("the migration is purely additive", () => {
  const sql = read("prisma/migrations/20261013000000_utility_usage/migration.sql")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  it("creates one table, its indexes and its foreign keys, and nothing else", () => {
    expect(statements.length).toBe(5);
    expect(statements.filter((s) => /^CREATE TABLE "UtilityUsage"/.test(s))).toHaveLength(1);
    expect(statements.filter((s) => /^CREATE (UNIQUE )?INDEX "UtilityUsage_/.test(s))).toHaveLength(2);
    expect(statements.filter((s) => /^ALTER TABLE "UtilityUsage" ADD CONSTRAINT "UtilityUsage_\w+_fkey" FOREIGN KEY/.test(s))).toHaveLength(2);
  });

  it("never drops, updates, deletes, inserts or alters another table", () => {
    const withoutReferentialActions = sql.replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE|SET NULL|NO ACTION)/g, "");
    expect(withoutReferentialActions).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b|\bTRUNCATE\b|ALTER COLUMN|RENAME/i);
    for (const s of statements.filter((x) => /^ALTER TABLE/.test(x))) expect(s).toMatch(/^ALTER TABLE "UtilityUsage"/);
  });

  it("matches the schema model", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.match(/model UtilityUsage \{[\s\S]*?\n\}/)![0];
    for (const col of ["id", "entityId", "kind", "period", "occurredOn", "quantity", "unit", "costCents", "note", "source", "importBatchId", "liveKey", "createdById", "createdAt", "archivedAt", "archivedById"]) {
      expect(model, col).toMatch(new RegExp(`\\n\\s+${col}\\s`));
      expect(sql, col).toContain(`"${col}"`);
    }
    expect(model).toMatch(/liveKey\s+String\?\s+@unique/);
    expect(model).toMatch(/@db\.Decimal\(14, 3\)/);
    expect(model).toMatch(/@@index\(\[entityId, kind, period\]\)/);
    expect(model).not.toMatch(/onDelete: Cascade/);
  });
});

describe("what must not change never imports the new modules", () => {
  const PROTECTED = SOURCE_FILES.filter(
    (f) =>
      f.startsWith("app/budgets/") ||
      f.startsWith("components/budgets/") ||
      f === "actions/budgets.ts" ||
      f.startsWith("lib/tax2025/") ||
      f.startsWith("lib/tax-review/") ||
      f.startsWith("lib/tax-facts/") ||
      f.startsWith("lib/advisor/") ||
      f.startsWith("components/advisor/") ||
      f === "actions/advisor.ts"
  );
  it("Budgets, the tax engine, the review code, the tax-facts store and the advisor", () => {
    expect(PROTECTED.length).toBeGreaterThan(40);
    for (const f of PROTECTED) expect(read(f), f).not.toMatch(/utility-usage|seasonal-energy-usage|UtilityUsage/);
  });

  it("the forecast, ledger and notification consumers read the plan only (no usage module)", () => {
    for (const f of ["lib/upcoming-ledger.ts", "lib/bill-dates.ts", "lib/account-scheduled-flows.ts", "actions/envelope.ts", "lib/notifications.ts"]) {
      if (existsSync(join(root, f))) expect(read(f), f).not.toMatch(/utility-usage|seasonal-energy-usage/);
    }
  });
});

describe("the seasonal loader isolates the usage read", () => {
  const src = read("lib/seasonal-energy-build.ts");

  it("reads usage inside its own try/catch and reports a status instead of failing the load", () => {
    const at = src.indexOf("loadUtilityUsage(");
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 160), at);
    expect(before).toMatch(/try \{/);
    const after = src.slice(at, at + 700);
    expect(after).toMatch(/catch \(err\)/);
    expect(after).toMatch(/usageStatus = "failed"/);
    expect(after).not.toMatch(/throw /);
  });

  it("a usage problem never sets `failed: true` anywhere in the loader", () => {
    expect((noComments(src).match(/failed: true/g) ?? []).length).toBe(1); // the EMPTY constant, which also reports usageStatus "failed"
    expect(noComments(src)).toMatch(/usageStatus: "failed" \}/);
  });

  it("the Forecast page passes the usage status to the card and treats firewood plans as lumpy", () => {
    const page = read("app/forecast/page.tsx");
    expect(page).toMatch(/usageStatus: loaded\.usageStatus/);
    expect(page).toMatch(/lumpy: seasonalPlan\.kind !== "electric"/);
  });
});
