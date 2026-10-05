import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  getRunWithFindings,
  insertApproval,
  insertDisposition,
  insertReviewRun,
  latestRun,
  listDispositions,
  ReviewStoreError,
  type ApprovalDbRow,
  type DispositionDbRow,
  type FindingRow,
  type ReviewStoreDb,
  type RunRow,
} from "@/lib/tax-review-store";
import { findCurrentApproval as findCurrent } from "@/lib/tax-review-approval-facts";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

const FP = "a".repeat(64);
const FP2 = "b".repeat(64);
const ENTITY = "entity-1";

function finding(check = "L1.F1.f1040.9", over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({
    layer: "L1",
    check,
    severity: "blocker",
    area: "tax",
    formKey: "f1040",
    lineKey: "f1040.9",
    message: "Total income does not equal the sum of its parts.",
    evidence: [{ ref: "f1040.9", amount: 100, status: "computed" }],
    recommendedAction: "Fix the return.",
    acceptable: false,
    ...over,
  });
}

/** An in-memory fake exposing exactly the calls the store makes. */
function fakeDb() {
  const runs: RunRow[] = [];
  const findings: FindingRow[] = [];
  const dispositions: DispositionDbRow[] = [];
  const approvals: ApprovalDbRow[] = [];
  let n = 0;
  const id = () => `id-${(n += 1)}`;
  const clock = () => new Date(Date.UTC(2026, 9, 5, 12, 0, n));
  const tx = {
    taxReviewRun: {
      create: vi.fn(async ({ data }: { data: Omit<RunRow, "id" | "startedAt"> }) => {
        const row: RunRow = { ...data, id: id(), startedAt: clock() };
        runs.push(row);
        return row;
      }),
    },
    taxReviewFinding: {
      createMany: vi.fn(async ({ data }: { data: Omit<FindingRow, "id">[] }) => {
        for (const d of data) findings.push({ ...d, id: id() });
        return { count: data.length };
      }),
    },
  };
  const store: ReviewStoreDb = {
    taxReviewRun: {
      ...tx.taxReviewRun,
      findMany: vi.fn(async ({ where, take }: { where: { taxYear: number; entityId: string }; take?: number }) =>
        runs.filter((r) => r.taxYear === where.taxYear && r.entityId === where.entityId).reverse().slice(0, take ?? 100)
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; entityId?: string } }) => runs.find((r) => r.id === where.id && (where.entityId === undefined || r.entityId === where.entityId)) ?? null),
    },
    taxReviewFinding: {
      ...tx.taxReviewFinding,
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) => findings.filter((f) => f.runId === where.runId)),
    },
    taxReviewFindingDisposition: {
      create: vi.fn(async ({ data }: { data: Omit<DispositionDbRow, "id" | "at"> }) => {
        const row: DispositionDbRow = { ...data, id: id(), at: clock() };
        dispositions.push(row);
        return row;
      }),
      findMany: vi.fn(async () => [...dispositions]),
    },
    taxReturnApproval: {
      create: vi.fn(async ({ data }: { data: Omit<ApprovalDbRow, "id" | "at"> }) => {
        const row: ApprovalDbRow = { ...data, id: id(), at: clock() };
        approvals.push(row);
        return row;
      }),
      findMany: vi.fn(async () => [...approvals]),
    },
    $transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return { store, runs, findings, dispositions, approvals, tx };
}

const runInput = (findings: Finding[]) => ({
  taxYear: 2025,
  entityId: ENTITY,
  fingerprint: FP,
  engineVersion: "ty2025-test",
  startedById: "user-1",
  startedByName: "Eric Kinniburgh",
  config: { fingerprintVersion: 2 },
  l1Summary: { counts: {} },
  l2Summary: { status: "not_run", coverage: [] },
  findings,
});

describe("append-only store (source pin)", () => {
  const source = readFileSync(path.join(process.cwd(), "lib", "tax-review-store.ts"), "utf8");
  it("never updates, deletes or upserts a row and never uses raw SQL", () => {
    // Strip comments so the explanation of the rule does not trip the pin.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const call of [".update(", ".updateMany(", ".delete(", ".deleteMany(", ".upsert(", "$executeRaw", "$queryRaw", "$queryRawUnsafe", "$executeRawUnsafe"]) {
      expect(code.includes(call), `the store must not call ${call}`).toBe(false);
    }
  });
  it("only declares create / createMany / findMany / findFirst on the review tables", () => {
    const decl = source.slice(source.indexOf("export interface ReviewStoreTx"), source.indexOf("function defaultDb"));
    const methods = [...decl.matchAll(/^\s+(\w+)\(args/gm)].map((m) => m[1]);
    expect([...new Set(methods)].sort()).toEqual(["create", "createMany", "findFirst", "findMany"]);
  });
  it("does not import the audit log (reasons are never audited)", () => {
    expect(source).not.toMatch(/auditLog/);
  });
});

describe("insertReviewRun", () => {
  it("stores the run and every finding in one transaction", async () => {
    const f = fakeDb();
    const res = await insertReviewRun(runInput([finding("L1.F1.a"), finding("L1.F1.b")]), f.store);
    expect(res.findingCount).toBe(2);
    expect(f.runs).toHaveLength(1);
    expect(f.findings.map((x) => x.runId)).toEqual([res.runId, res.runId]);
    const loaded = await getRunWithFindings(res.runId, ENTITY, f.store);
    expect(loaded?.findings.map((x) => x.check).sort()).toEqual(["L1.F1.a", "L1.F1.b"]);
    expect((await latestRun(2025, ENTITY, f.store))?.id).toBe(res.runId);
  });
  it("a run holding two rows with one key (an AI review stored a later, more serious one) is read back with the more severe one only", async () => {
    const f = fakeDb();
    const res = await insertReviewRun(runInput([finding("L1.F1.a")]), f.store);
    const low = finding("L1.F1.a", { severity: "low", message: "A minor note about this line." });
    const high = finding("L1.F1.a", { severity: "high", message: "A serious problem with this line." });
    f.findings.splice(0, f.findings.length, { ...f.findings[0]!, ...{ severity: low.severity, message: low.message } }, { ...f.findings[0]!, id: "later", severity: high.severity, message: high.message });
    const loaded = await getRunWithFindings(res.runId, ENTITY, f.store);
    expect(loaded?.findings).toHaveLength(1);
    expect(loaded?.findings[0]?.severity).toBe("high");
  });
  it("refuses a fingerprint that is not 64 hex and a duplicate key", async () => {
    const f = fakeDb();
    await expect(insertReviewRun({ ...runInput([]), fingerprint: "abc" }, f.store)).rejects.toThrow(ReviewStoreError);
    await expect(insertReviewRun(runInput([finding("L1.F1.a"), finding("L1.F1.a")]), f.store)).rejects.toThrow(/duplicate finding key/);
    expect(f.runs).toHaveLength(0);
  });
  it("a finding with SSN-like text can not be built, so it can never be stored", () => {
    expect(() => finding("L1.F1.x", { message: "Payer 123-45-6789 mismatch" })).toThrow();
    expect(() => finding("L1.F1.x", { message: "Account 1234567890 mismatch" })).toThrow();
  });
  it("re-validates at the storage boundary (a hand-built invalid finding is refused)", async () => {
    const f = fakeDb();
    const bad = { ...finding("L1.F1.a"), severity: "catastrophic" } as unknown as Finding;
    await expect(insertReviewRun(runInput([bad]), f.store)).rejects.toThrow(/not valid/);
  });
  it("a run with no findings still stores the run", async () => {
    const f = fakeDb();
    const res = await insertReviewRun(runInput([]), f.store);
    expect(res.findingCount).toBe(0);
    expect(f.tx.taxReviewFinding.createMany).not.toHaveBeenCalled();
  });
});

describe("insertDisposition", () => {
  const base = { taxYear: 2025, entityId: ENTITY, findingKey: "0123456789abcdef", evidenceHash: "fedcba9876543210", byId: "u1", byName: "Eric Kinniburgh" } as const;
  it("needs a written reason to accept and refuses SSN-like / long numbers", async () => {
    const f = fakeDb();
    await expect(insertDisposition({ ...base, action: "accepted", reason: "ok" }, f.store)).rejects.toThrow(/at least 3/);
    await expect(insertDisposition({ ...base, action: "accepted", reason: "see 123-45-6789" }, f.store)).rejects.toThrow(/SSN/);
    await expect(insertDisposition({ ...base, action: "accepted", reason: "x".repeat(501) }, f.store)).rejects.toThrow(/limited/);
    await insertDisposition({ ...base, action: "accepted", reason: "Checked against the broker statement." }, f.store);
    expect(f.dispositions).toHaveLength(1);
    expect((await listDispositions(2025, ENTITY, f.store))[0]?.action).toBe("accepted");
  });
  it("a reopen may carry no reason", async () => {
    const f = fakeDb();
    await insertDisposition({ ...base, action: "reopened", reason: "" }, f.store);
    expect(f.dispositions[0]?.action).toBe("reopened");
  });
  it("rejects a malformed key", async () => {
    const f = fakeDb();
    await expect(insertDisposition({ ...base, findingKey: "nope", action: "accepted", reason: "valid reason" }, f.store)).rejects.toThrow(/not a finding key/);
  });
});

describe("approvals", () => {
  const approved = (fp: string) => ({
    taxYear: 2025,
    entityId: ENTITY,
    kind: "approved" as const,
    runId: "run-1",
    fingerprint: fp,
    verdictSnapshot: { verdict: "passed" },
    attestationVersion: "v1",
    attestationTextHash: "h1",
    typedConfirmationHash: "h2",
    reason: null,
    approvedById: "u1",
    approvedByName: "Eric Kinniburgh",
  });
  it("an approval is current only for its own fingerprint and until it is withdrawn", async () => {
    const f = fakeDb();
    await insertReviewRun({ ...runInput([]), fingerprint: FP }, f.store); // an approval is recorded against a run of its own fingerprint
    await insertApproval(approved(FP), f.store);
    expect((await findCurrent(2025, ENTITY, FP, { store: f.store, listEvents: async () => [] }))?.kind).toBe("approved");
    expect(await findCurrent(2025, ENTITY, FP2, { store: f.store, listEvents: async () => [] })).toBeNull();
    await insertApproval({ ...approved(FP), kind: "withdrawn", reason: "Found a mistake in a W-2.", attestationVersion: null, attestationTextHash: null, typedConfirmationHash: null }, f.store);
    expect(await findCurrent(2025, ENTITY, FP, { store: f.store, listEvents: async () => [] })).toBeNull();
    expect(f.approvals).toHaveLength(2); // history is kept, nothing is deleted
  });
  it("an approval row must carry the attestation hashes, a withdrawal a reason", async () => {
    const f = fakeDb();
    await expect(insertApproval({ ...approved(FP), attestationTextHash: null }, f.store)).rejects.toThrow(/attestation/);
    await expect(insertApproval({ ...approved(FP), kind: "withdrawn", reason: "no" }, f.store)).rejects.toThrow(/reason/);
  });
});

describe("migration 20261008000000_tax_return_review", () => {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", "20261008000000_tax_return_review", "migration.sql"), "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.startsWith("--") && l.trim() !== "")
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  it("is additive: creates four new tables, their indexes and foreign keys, and touches nothing else", () => {
    const NEW = ["TaxReviewRun", "TaxReviewFinding", "TaxReviewFindingDisposition", "TaxReturnApproval"];
    expect(statements.filter((s) => s.startsWith("CREATE TABLE")).map((s) => /CREATE TABLE "(\w+)"/.exec(s)?.[1]).sort()).toEqual([...NEW].sort());
    for (const s of statements) {
      expect(/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE)/.test(s), s.slice(0, 60)).toBe(true);
      // (the referential actions "ON DELETE ..." / "ON UPDATE ..." are not statements)
      expect(/\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i.test(s.replace(/ON (DELETE|UPDATE) (SET NULL|RESTRICT|CASCADE)/g, ""))).toBe(false);
      if (s.startsWith("ALTER TABLE")) {
        const table = /ALTER TABLE "(\w+)"/.exec(s)?.[1] ?? "";
        expect(NEW).toContain(table);
        expect(s).toMatch(/ADD CONSTRAINT/);
      }
    }
  });
  it("has no hard-delete cascade onto the review tables", () => {
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });
});
