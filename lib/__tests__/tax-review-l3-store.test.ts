import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { dbAiRunStore, L3StoreError, type L3StoreDb } from "@/lib/tax-review-l3-store";
import { DuplicateEventError } from "@/lib/tax-review/llm/run";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

// The database side of the AI review (ai-return-reviewer, Phase B): insert-only, atomic, idempotent by event key.

const root = process.cwd();
const read = (...p: string[]): string => readFileSync(path.join(root, ...p), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function l3Finding(over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({ layer: "L3", check: "L3.income.other", severity: "medium", area: "income", message: "Check this line against the documents.", evidence: [{ ref: "f1040.9", amount: 100, status: "computed" }], recommendedAction: "Compare with the documents.", acceptable: true, origin: "llm", pass: "income", ...over });
}

interface Row {
  runId: string;
  eventKey: string;
  [k: string]: unknown;
}

function fakeDb(opts: { failFindings?: boolean } = {}) {
  const events: Row[] = [];
  const findings: Row[] = [];
  const ops: string[] = [];
  const db: L3StoreDb = {
    taxReviewRunEvent: {
      async createMany({ data }) {
        for (const d of data) {
          if (events.some((e) => e.runId === d.runId && e.eventKey === d.eventKey)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          events.push({ ...d, createdAt: new Date(events.length) });
        }
        ops.push("events.createMany");
        return { count: data.length };
      },
      async findMany({ where }) {
        return events.filter((e) => e.runId === where.runId) as never;
      },
    },
    taxReviewFinding: {
      async findMany({ where }) {
        return findings.filter((f) => f["runId"] === where.runId && (where.layer === undefined || f["layer"] === where.layer)) as never;
      },
      async createMany({ data }) {
        if (opts.failFindings) throw new Error("boom");
        for (const d of data) findings.push({ ...d, id: String(findings.length) } as unknown as Row);
        ops.push("findings.createMany");
        return { count: data.length };
      },
    },
    async $transaction(fn) {
      const snapshot = { e: events.length, f: findings.length };
      try {
        return await fn(db);
      } catch (err) {
        events.length = snapshot.e;
        findings.length = snapshot.f;
        throw err;
      }
    },
  };
  return { db, events, findings, ops };
}

const ev = (key: string) => ({ runId: "r1", eventKey: key, kind: "task_completed" as const, taskId: "a1", attempt: 1, data: { n: 1 } });

describe("dbAiRunStore", () => {
  it("appends events and findings in one transaction and reads them back", async () => {
    const f = fakeDb();
    const store = dbAiRunStore(f.db);
    await store.append("r1", [ev("done:a1")], [l3Finding()]);
    expect(f.events).toHaveLength(1);
    expect(f.findings).toHaveLength(1);
    expect((await store.listEvents("r1")).map((e) => e.eventKey)).toEqual(["done:a1"]);
    const back = await store.listL3Findings("r1");
    expect(back).toHaveLength(1);
    expect(back[0]?.layer).toBe("L3");
    expect(back[0]?.evidenceHash).toBe(l3Finding().evidenceHash);
  });
  it("a duplicate event key throws DuplicateEventError and writes NOTHING (the findings roll back with it)", async () => {
    const f = fakeDb();
    const store = dbAiRunStore(f.db);
    await store.append("r1", [ev("done:a1")], [l3Finding()]);
    await expect(store.append("r1", [ev("done:a1")], [l3Finding({ check: "L3.income.wrong_amount" })])).rejects.toBeInstanceOf(DuplicateEventError);
    expect(f.events).toHaveLength(1);
    expect(f.findings).toHaveLength(1);
  });
  it("findings whose key the run already has are skipped, not duplicated", async () => {
    const f = fakeDb();
    const store = dbAiRunStore(f.db);
    await store.append("r1", [ev("done:a1")], [l3Finding()]);
    await store.append("r1", [ev("done:a2")], [l3Finding(), l3Finding({ check: "L3.income.wrong_amount" })]);
    expect(f.findings).toHaveLength(2);
  });
  it("two findings with one key: the more serious one is stored (insert-only, both rows kept) and every reader sees it; the same or a lesser severity is skipped", async () => {
    const f = fakeDb();
    const store = dbAiRunStore(f.db);
    await store.append("r1", [ev("done:a1")], [l3Finding({ severity: "low", message: "A minor note about this line." })]);
    await store.append("r1", [ev("done:a2")], [l3Finding({ severity: "high", message: "A serious problem with this line." })]);
    expect(f.findings).toHaveLength(2); // insert-only: the earlier row stays
    const back = await store.listL3Findings("r1");
    expect(back).toHaveLength(1);
    expect(back[0]?.severity).toBe("high");
    expect(back[0]?.message).toMatch(/serious/);
    // a later medium (less serious than the stored high) and a repeat of the high add nothing
    await store.append("r1", [ev("done:a3")], [l3Finding({ severity: "medium", message: "A middle note about this line." }), l3Finding({ severity: "high", message: "The same serious problem again." })]);
    expect(f.findings).toHaveLength(2);
    // inside one batch the more serious of two is the one written
    const g = fakeDb();
    await dbAiRunStore(g.db).append("r1", [ev("done:a1")], [l3Finding({ severity: "low", message: "A minor note about this line." }), l3Finding({ severity: "blocker", message: "A blocking problem with this line." })]);
    expect(g.findings.map((r) => r["severity"])).toEqual(["blocker"]);
  });
  it("only valid L3 findings are stored: an L1 finding or an invalid one aborts the whole append", async () => {
    const f = fakeDb();
    const store = dbAiRunStore(f.db);
    const l1 = makeFinding({ layer: "L1", check: "L1.x", severity: "info", area: "process", message: "m for the finding", recommendedAction: "a for the finding", acceptable: true });
    await expect(store.append("r1", [ev("done:a1")], [l1])).rejects.toBeInstanceOf(L3StoreError);
    expect(f.events).toHaveLength(0);
    await expect(store.append("r1", [ev("done:a1")], [{ ...l3Finding(), severity: "nonsense" as never }])).rejects.toBeInstanceOf(L3StoreError);
    expect(f.events).toHaveLength(0);
  });
  it("a failure while writing findings rolls the events back", async () => {
    const f = fakeDb({ failFindings: true });
    const store = dbAiRunStore(f.db);
    await expect(store.append("r1", [ev("done:a1")], [l3Finding()])).rejects.toThrow("boom");
    expect(f.events).toHaveLength(0);
  });
  it("other runs' events and findings are never mixed in", async () => {
    const f = fakeDb();
    const store = dbAiRunStore(f.db);
    await store.append("r1", [ev("done:a1")], [l3Finding()]);
    await store.append("r2", [{ ...ev("done:a1"), runId: "r2" }], []);
    expect(await store.listEvents("r2")).toHaveLength(1);
    expect(await store.listL3Findings("r2")).toHaveLength(0);
  });
});

describe("the L3 store is insert-only (pinned like the review store)", () => {
  const src = strip(read("lib", "tax-review-l3-store.ts"));
  it("no update, delete, upsert, raw SQL, audit log or fetch in the store source", () => {
    for (const banned of [/\.update\(/, /\.updateMany\(/, /\.delete\(/, /\.deleteMany\(/, /\.upsert\(/, /\$executeRaw/, /\$queryRaw/, /auditLog/, /\bfetch\(/, /@anthropic-ai/]) expect(banned.test(src), String(banned)).toBe(false);
    expect(src).toMatch(/createMany/);
  });
  it("it never touches the run row, the dispositions or the approvals", () => {
    expect(src).not.toMatch(/taxReviewRun\b(?!Event)/);
    expect(src).not.toMatch(/taxReviewFindingDisposition|taxReturnApproval/);
  });
});

describe("the new migration is additive", () => {
  const sql = read("prisma", "migrations", "20261009000000_tax_review_run_events", "migration.sql");
  const body = sql.replace(/^--.*$/gm, "");
  it("only creates one table and its indexes", () => {
    expect(body).toMatch(/CREATE TABLE "TaxReviewRunEvent"/);
    expect(body).toMatch(/CREATE UNIQUE INDEX "TaxReviewRunEvent_runId_eventKey_key" ON "TaxReviewRunEvent"\("runId", "eventKey"\)/);
    for (const banned of [/\bALTER\b/i, /\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /FOREIGN KEY/i, /\bRENAME\b/i]) expect(banned.test(body), String(banned)).toBe(false);
    expect((body.match(/CREATE TABLE/g) ?? []).length).toBe(1);
  });
  it("the schema model matches and has no relation that would alter another table", () => {
    const schema = read("prisma", "schema.prisma");
    const model = /model TaxReviewRunEvent \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toMatch(/@@unique\(\[runId, eventKey\]\)/);
    expect(model).not.toMatch(/@relation/);
    expect(schema).not.toMatch(/events\s+TaxReviewRunEvent\[\]/);
  });
  it("it is ordered after the first review migration and is not the same folder", () => {
    expect("20261009000000_tax_review_run_events" > "20261008000000_tax_return_review").toBe(true);
  });
});
