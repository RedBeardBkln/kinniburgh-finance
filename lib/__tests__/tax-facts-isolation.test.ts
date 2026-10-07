import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { OWNER_STATEMENTS_VERSION } from "@/lib/tax-review/llm/owner-statements";
import { FINGERPRINT_PART_NAMES } from "@/lib/tax-review/fingerprint";

// The tax facts store must not touch the TY2025 return: the engine, the fingerprint, the AI reviewer and the approval
// flow never read it, and it never imports them (tax-facts-carry-forward-store plan, risk R1). Pure source-reading tests.

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".claude" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("the TY2025 return never reads the facts store", () => {
  const files = ["lib", "actions", "app", "components"].flatMap((d) => walk(join(ROOT, d))).map(rel);
  const protectedFile = (f: string) =>
    f.startsWith("lib/tax2025/") ||
    f.startsWith("lib/tax-review/") ||
    /^lib\/tax2025-[^/]*\.ts$/.test(f) ||
    /^lib\/tax-review-[^/]*\.ts$/.test(f) ||
    /^actions\/tax-review[^/]*\.ts$/.test(f) ||
    /^actions\/tax-return[^/]*\.ts$/.test(f) ||
    f.startsWith("app/api/tax/forms/") ||
    f === "lib/tax-compute.ts";

  it("sees the protected trees (the scan is not vacuous)", () => {
    expect(files.filter(protectedFile).length).toBeGreaterThan(50);
  });

  it("no protected file mentions tax-facts or taxFact", () => {
    for (const f of files.filter(protectedFile)) {
      const src = read(join(ROOT, f));
      expect(/tax-facts|taxFact|TaxFact/.test(src), f).toBe(false);
    }
  });

  it("the read-only TY2025 build does not name TaxFact", () => {
    expect(read(join(ROOT, "lib/tax2025-build.ts"))).not.toMatch(/TaxFact|taxFact/);
  });
});

describe("the store never imports the review, the engine or the AI statements", () => {
  const storeFiles = [
    ...walk(join(ROOT, "lib/tax-facts")),
    join(ROOT, "lib/tax-facts-store.ts"),
    join(ROOT, "actions/tax-facts.ts"),
    ...walk(join(ROOT, "components/tax/facts")),
    join(ROOT, "app/tax/facts/page.tsx"),
  ];

  it("finds the store files", () => {
    expect(storeFiles.length).toBeGreaterThanOrEqual(12);
  });

  it("imports nothing from lib/tax2025/**, lib/tax-review/** (other than the outgoing-text guard) or the owner statements", () => {
    for (const p of storeFiles) {
      const src = read(p);
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec.includes("owner-statements"), `${rel(p)} imports ${spec}`).toBe(false);
        expect(spec.startsWith("@/lib/tax2025"), `${rel(p)} imports ${spec}`).toBe(false);
        expect(/^@\/lib\/tax-review-/.test(spec), `${rel(p)} imports ${spec}`).toBe(false);
        if (spec.startsWith("@/lib/tax-review/")) {
          expect(spec, `${rel(p)} imports ${spec}`).toBe("@/lib/tax-review/redact");
        }
        expect(/@\/actions\/tax-(review|return)/.test(spec), `${rel(p)} imports ${spec}`).toBe(false);
      }
    }
  });
});

describe("approved-return inputs are unchanged", () => {
  it("OWNER_STATEMENTS_VERSION is still 5", () => {
    expect(OWNER_STATEMENTS_VERSION).toBe(5);
  });

  it("the fingerprint still has exactly the nine parts, none of them the facts store", () => {
    expect([...FINGERPRINT_PART_NAMES]).toEqual([
      "engine",
      "view",
      "answers",
      "header",
      "facts",
      "documents",
      "questionnaires",
      "overrides",
      "decisions",
    ]);
  });
});

describe("append-only: no delete, deleteMany or upsert on taxFact anywhere", () => {
  const files = ["lib", "actions", "app", "components", "scripts"]
    .flatMap((d) => {
      try {
        return walk(join(ROOT, d));
      } catch {
        return [];
      }
    })
    .filter((p) => !p.includes(`${sep}__tests__${sep}`));

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("has no destructive or upsert call on the taxFact delegate", () => {
    for (const p of files) {
      const src = read(p);
      expect(/taxFact\s*\.\s*(delete|deleteMany|upsert)\b/.test(src), rel(p)).toBe(false);
    }
  });

  it("the only update the actions make is archivedAt on a superseded version, and the only bulk insert is the seed", () => {
    const src = read(join(ROOT, "actions/tax-facts.ts"));
    const updates = [...src.matchAll(/taxFact\.(update|updateMany)\(\{[\s\S]*?\}\);/g)];
    expect(updates).toHaveLength(1);
    expect(updates[0]![0]).toMatch(/data:\s*\{\s*archivedAt:\s*now,\s*archivedById:\s*author\.id\s*\}/);
    expect([...src.matchAll(/taxFact\.createMany\(/g)]).toHaveLength(1);
    expect(src).toMatch(/skipDuplicates:\s*true/);
  });

  it("the read side only reads", () => {
    const src = read(join(ROOT, "lib/tax-facts-store.ts"));
    expect(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/.test(src)).toBe(false);
  });
});

describe("migration SQL is additive", () => {
  const sql = read(join(ROOT, "prisma/migrations/20261010000000_tax_facts/migration.sql"));
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  it("creates exactly one table with its two indexes and three foreign keys", () => {
    expect([...code.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect(code).toContain('CREATE TABLE "TaxFact"');
    expect([...code.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(2);
    expect([...code.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(3);
  });

  it("touches no other table: every ALTER names TaxFact, and there is no DROP, UPDATE statement, INSERT or DELETE", () => {
    const alters = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(alters.length).toBe(3);
    expect(alters.every((t) => t === "TaxFact")).toBe(true);
    expect(/\bDROP\b|\bINSERT\b|\bDELETE FROM\b|^\s*UPDATE\b|\bTRUNCATE\b/im.test(code)).toBe(false);
  });
});
