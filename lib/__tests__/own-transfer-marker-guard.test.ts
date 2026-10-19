import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "__tests__" || name === "node_modules") continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("Transaction.ownTransferAccountId (one-sided own-transfer marker)", () => {
  it("is written only by lib/transfer-match-runner.ts", () => {
    const writers: string[] = [];
    for (const f of [...walk("lib"), ...walk("actions"), ...walk("app"), ...walk("components")]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // a write = the column inside a `data:` object (create / update / updateMany)
      if (/data:\s*\{[^}]*ownTransferAccountId/.test(src)) writers.push(f);
    }
    expect(writers).toEqual(["lib/transfer-match-runner.ts"]);
  });

  it("the migration is exactly one additive nullable TEXT column", () => {
    const sql = readFileSync(
      join(ROOT, "prisma/migrations/20261019000000_transaction_own_transfer_marker/migration.sql"),
      "utf8"
    );
    const statements = sql
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("--"))
      .join(" ")
      .trim();
    expect(statements).toBe('ALTER TABLE "Transaction" ADD COLUMN "ownTransferAccountId" TEXT;');
    expect(statements).not.toMatch(/NOT NULL|DEFAULT|UPDATE|DROP|INDEX/i);
  });

  it("the schema line matches (nullable String on Transaction)", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model Transaction {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).toMatch(/^\s+ownTransferAccountId\s+String\?\s/m);
  });
});
