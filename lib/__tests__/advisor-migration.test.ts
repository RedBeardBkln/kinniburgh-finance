import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The assistant's migration is additive: four new tables and nothing else (advisor-ai-chatbot plan section 6). Pure source-reading tests.

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const sql = read("prisma/migrations/20261012000000_advisor_assistant/migration.sql");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const schema = read("prisma/schema.prisma");

const TABLES = ["AdvisorConversation", "AdvisorMessage", "AdvisorMemory", "AdvisorUsage"] as const;

function modelBody(name: string): string {
  const m = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (m === null) throw new Error(`model ${name} not found`);
  return m[1]!;
}

/** Scalar column names of a Prisma model (relation fields and @@ lines excluded). */
function schemaColumns(name: string): string[] {
  const cols: string[] = [];
  for (const raw of modelBody(name).split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "" || line.startsWith("@@")) continue;
    const [field, type] = line.split(/\s+/);
    if (field === undefined || type === undefined) continue;
    if (/^(String|Int|Boolean|DateTime|Json)\??$/.test(type)) cols.push(field);
  }
  return cols;
}

function sqlColumns(table: string): string[] {
  const m = new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(code);
  if (m === null) throw new Error(`table ${table} not in migration`);
  return [...m[1]!.matchAll(/^\s+"(\w+)" /gm)].map((x) => x[1]!);
}

describe("migration 20261012000000_advisor_assistant", () => {
  it("creates exactly the four new tables", () => {
    expect([...code.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual([...TABLES]);
  });

  it("touches no other table: every ALTER names a new table; no DROP, INSERT, DELETE, UPDATE or TRUNCATE", () => {
    const alters = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]!);
    expect(alters.length).toBe(4);
    expect(alters.every((t) => (TABLES as readonly string[]).includes(t))).toBe(true);
    expect(/\bDROP\b|\bINSERT\b|\bDELETE FROM\b|^\s*UPDATE\b|\bTRUNCATE\b|\bALTER TABLE "User"/im.test(code)).toBe(false);
  });

  it("every schema model column is in the SQL table and vice versa", () => {
    for (const t of TABLES) expect(sqlColumns(t).sort(), t).toEqual(schemaColumns(t).sort());
  });

  it("has the unique (conversationId, seq) index that makes two racing sends safe", () => {
    expect(code).toContain('CREATE UNIQUE INDEX "AdvisorMessage_conversationId_seq_key" ON "AdvisorMessage"("conversationId", "seq")');
  });

  it("messages and usage rows are insert-only: no updatedAt / archivedAt column", () => {
    for (const t of ["AdvisorMessage", "AdvisorUsage"]) {
      expect(sqlColumns(t)).not.toContain("updatedAt");
      expect(sqlColumns(t)).not.toContain("archivedAt");
    }
  });

  it("has no column that could hold a secret, a token, a file key or an identifier", () => {
    for (const t of TABLES) {
      for (const c of sqlColumns(t).filter((x) => !/Tokens$/.test(x))) expect(/password|token|secret|cursor|hash|fileKey|ssn|ein|account/i.test(c), `${t}.${c}`).toBe(false);
    }
  });

  it("restricts deletes of users and conversations (nothing cascades away tax-adjacent history)", () => {
    expect(code).not.toMatch(/ON DELETE CASCADE/);
    expect(code).toMatch(/AdvisorConversation_userId_fkey[^;]*ON DELETE RESTRICT/);
    expect(code).toMatch(/AdvisorMessage_conversationId_fkey[^;]*ON DELETE RESTRICT/);
    expect(code).toMatch(/AdvisorMemory_createdById_fkey[^;]*ON DELETE SET NULL/);
  });

  it("states in its header that it is additive and needs the owner's OK", () => {
    expect(sql.split("\n").slice(0, 12).join("\n")).toMatch(/Additive only/);
    expect(sql).toMatch(/needs the owner's explicit OK/);
  });
});
