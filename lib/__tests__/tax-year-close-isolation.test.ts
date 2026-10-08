import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { OWNER_STATEMENTS_VERSION } from "@/lib/tax-review/llm/owner-statements";
import { FINGERPRINT_PART_NAMES } from "@/lib/tax-review/fingerprint";
import { TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";

// Closing a year must not touch the TY2025 return: the engine, the fingerprint, the PDF routes, the AI reviewer and the approval
// readers never read it and never import it, the close table is insert-only, and the close code never touches the per-entity
// workspace label. Pure source-reading tests (tax-carry-screen-and-year-close plan, risk R1).

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".claude" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const CLOSE_CODE = [
  ...walk(join(ROOT, "lib/tax-year-close")),
  join(ROOT, "lib/tax-year-close-store.ts"),
  join(ROOT, "lib/tax-year-close-owner.ts"),
  join(ROOT, "lib/tax-facts-carry-guard.ts"),
  join(ROOT, "actions/tax-year-close.ts"),
];
const MENTION = /TaxYearClose|taxYearClose|tax-year-close|tax-facts-carry-guard|YearStatusNotice|YearCloseCard|year-close-card|year-status-notice|year-state-badge/;

describe("the TY2025 return never reads the close state", () => {
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

  it("sees the protected trees plus the approval readers (the scan is not vacuous)", () => {
    expect(files.filter(protectedFile).length).toBeGreaterThan(50);
    expect(files).toContain("lib/tax2025-pdf-approval.ts");
    expect(files).toContain("lib/tax-review-approval-facts.ts");
  });

  it("no protected file, PDF route or approval reader mentions the close module, table or components", () => {
    for (const f of files.filter(protectedFile)) {
      expect(MENTION.test(read(join(ROOT, f))), f).toBe(false);
    }
  });

  it("no route handler under app/api imports the close actions or store", () => {
    for (const f of files.filter((x) => x.startsWith("app/api/"))) {
      expect(MENTION.test(read(join(ROOT, f))), f).toBe(false);
    }
  });

  it("the only file that imports anything from the review tree is the owner resolver, and only the pure approver rule", () => {
    const importers = CLOSE_CODE.filter((p) => /from\s+"@\/lib\/(tax-review|tax2025)/.test(read(p))).map(rel);
    expect(importers).toEqual(["lib/tax-year-close/closer.ts"]);
    const imports = [...read(join(ROOT, "lib/tax-year-close/closer.ts")).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/tax-review/approver"]);
  });

  it("the facts store and its write guard do not import the review or engine trees, directly or through the close store", () => {
    for (const f of ["lib/tax-facts-carry-guard.ts", "lib/tax-year-close-store.ts", "lib/tax-facts-store.ts", "actions/tax-facts.ts", "actions/tax-facts-carry.ts"]) {
      for (const spec of [...read(join(ROOT, f)).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!)) {
        expect(spec.startsWith("@/lib/tax-review"), `${f} imports ${spec}`).toBe(false);
        expect(spec.startsWith("@/lib/tax2025"), `${f} imports ${spec}`).toBe(false);
        expect(spec, `${f} imports ${spec}`).not.toBe("@/lib/tax-year-close/closer");
        expect(spec, `${f} imports ${spec}`).not.toBe("@/lib/tax-year-close-owner");
      }
    }
  });
});

describe("insert-only", () => {
  it("scans the close code", () => {
    expect(CLOSE_CODE.length).toBeGreaterThanOrEqual(10);
  });

  it("no update, updateMany, upsert, delete, deleteMany or raw SQL on the close table anywhere", () => {
    const all = ["lib", "actions", "app", "components", "scripts"]
      .flatMap((d) => {
        try {
          return walk(join(ROOT, d));
        } catch {
          return [];
        }
      })
      .filter((p) => !p.includes(`${sep}__tests__${sep}`));
    expect(all.length).toBeGreaterThan(300);
    for (const p of all) {
      expect(/taxYearCloseEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(read(p)), rel(p)).toBe(false);
    }
    for (const p of CLOSE_CODE) {
      expect(/\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/.test(read(p)), rel(p)).toBe(false);
    }
  });

  it("the store's only writes are one create of an event and one audit row, inside one transaction", () => {
    const src = read(join(ROOT, "lib/tax-year-close-store.ts"));
    expect([...src.matchAll(/taxYearCloseEvent\.create\(/g)]).toHaveLength(1);
    expect([...src.matchAll(/auditLog\.create\(/g)]).toHaveLength(1);
    expect([...src.matchAll(/\$transaction\(/g)]).toHaveLength(1);
    expect(/\.(update|updateMany|upsert|delete|deleteMany)\(/.test(src)).toBe(false);
  });
});

describe("the per-entity workspace label is untouched", () => {
  it("no close code mentions the workspace model, its status or filedAt", () => {
    for (const p of CLOSE_CODE) {
      const src = read(p);
      expect(/taxWorkspace|TaxWorkspace|filedAt/.test(src), rel(p)).toBe(false);
    }
  });

  it("updateWorkspace and the deadline actions are unchanged by this feature (they do not mention the close table)", () => {
    for (const f of ["actions/tax.ts", "actions/tax-deadlines.ts", "actions/tax-planning.ts"]) {
      expect(MENTION.test(read(join(ROOT, f))), f).toBe(false);
    }
  });

  it("no existing tax server action gained a closed-year check (soft guard only; the carry writers are the exception)", () => {
    const actions = readdirSync(join(ROOT, "actions")).filter((f) => /^tax.*\.ts$/.test(f) && !["tax-year-close.ts", "tax-facts.ts", "tax-facts-carry.ts"].includes(f));
    expect(actions.length).toBeGreaterThan(5);
    for (const f of actions) expect(MENTION.test(read(join(ROOT, "actions", f))), f).toBe(false);
  });
});

describe("approved-return inputs are unchanged", () => {
  it("OWNER_STATEMENTS_VERSION is still 5, the fingerprint has the nine parts and the engine version is the pinned literal", () => {
    expect(OWNER_STATEMENTS_VERSION).toBe(5);
    expect([...FINGERPRINT_PART_NAMES]).toEqual([
      "engine", "view", "answers", "header", "facts", "documents", "questionnaires", "overrides", "decisions",
    ]);
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.11");
  });

  it("the fingerprint source does not read the close table (nor any workspace status)", () => {
    const src = read(join(ROOT, "lib/tax-review/fingerprint.ts"));
    expect(MENTION.test(src)).toBe(false);
    expect(/filedAt/.test(src)).toBe(false);
  });
});

describe("auth gates and wording", () => {
  it("the new actions start with requireAuth() and the pages that carry the controls check the session", () => {
    const src = read(join(ROOT, "actions/tax-year-close.ts"));
    for (const name of ["closeTaxYear", "reopenTaxYear"]) {
      const open = src.indexOf("{\n", src.indexOf(`export async function ${name}`)) + 2;
      expect(src.slice(open, open + 60).trimStart().startsWith("const user = await requireAuth();"), name).toBe(true);
    }
    const hub = read(join(ROOT, "app/tax/forms/[year]/page.tsx"));
    expect(hub.indexOf("redirect(\"/login\")")).toBeLessThan(hub.indexOf("<YearCloseCard"));
  });

  it("nothing in the print/package/PDF vocabulary mentions the close state", () => {
    const wording = read(join(ROOT, "lib/tax-wording.ts"));
    expect(MENTION.test(wording)).toBe(false);
  });
});

describe("migration SQL is additive", () => {
  const sql = read(join(ROOT, "prisma/migrations/20261011000000_tax_year_close_events/migration.sql"));
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  it("creates exactly one table with its two indexes and two foreign keys", () => {
    expect([...code.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect(code).toContain('CREATE TABLE "TaxYearCloseEvent"');
    expect([...code.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(2);
    expect(code).toContain('CREATE UNIQUE INDEX "TaxYearCloseEvent_entityId_taxYear_seq_key"');
    expect([...code.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(2);
  });

  it("touches no other table: every ALTER names the new table, and there is no DROP, UPDATE, INSERT, DELETE or TRUNCATE", () => {
    const alters = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(alters).toHaveLength(2);
    expect(alters.every((t) => t === "TaxYearCloseEvent")).toBe(true);
    expect(/\bDROP\b|\bINSERT\b|\bDELETE FROM\b|^\s*UPDATE\b|\bTRUNCATE\b/im.test(code)).toBe(false);
    expect(code).toContain('REFERENCES "Entity"("id") ON DELETE RESTRICT');
    expect(code).toContain('REFERENCES "User"("id") ON DELETE SET NULL');
  });

  it("has no confirmation-number column and the schema model matches the SQL columns", () => {
    expect(code).not.toMatch(/confirm/i);
    const schema = read(join(ROOT, "prisma/schema.prisma"));
    const model = schema.slice(schema.indexOf("model TaxYearCloseEvent {"));
    const body = model.slice(0, model.indexOf("\n}"));
    for (const col of ["id", "entityId", "taxYear", "seq", "kind", "filedOn", "note", "byId", "byName", "at", "createdAt"]) {
      expect(code, col).toContain(`"${col}"`);
      expect(body, col).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(body).not.toMatch(/updatedAt|archivedAt/);
    expect(body).toContain("@@unique([entityId, taxYear, seq])");
  });
});
