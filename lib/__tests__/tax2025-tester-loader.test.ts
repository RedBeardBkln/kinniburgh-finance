// TESTER: boundary test of lib/tax2025-build.ts (the read-only DB loader) through a mocked db object.
// Proves, without a database: it only reads, never writes, never calls ensure*Workspace, applies archivedAt: null
// on every soft-deletable model it reads, copes with absent entities / workspace / data without throwing, and
// maps document rows through resolveTaxDocForCompute (corrections overlay) before the engine sees them.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const h = vi.hoisted(() => {
  const calls: { model: string; method: string; args: unknown }[] = [];
  const state: {
    entities: Record<string, { id: string; name: string; slug: string | null; navLabel: string | null; type: string } | null>;
    documents: unknown[];
    users: { id: string; name: string | null }[];
    workspace: { id: string } | null;
    questions: unknown[];
    donations: unknown[];
    mileage: unknown[];
    assets: unknown[];
    paystubs: unknown[];
    grouped: unknown[];
    glCodes: unknown[];
    throwOn: string | null;
  } = {
    entities: {},
    documents: [],
    users: [],
    workspace: null,
    questions: [],
    donations: [],
    mileage: [],
    assets: [],
    paystubs: [],
    grouped: [],
    glCodes: [],
    throwOn: null,
  };
  const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe|\$transaction)$/;
  const handler = (model: string, method: string) => async (args: unknown) => {
    calls.push({ model, method, args });
    if (WRITE.test(method)) throw new Error(`WRITE ATTEMPTED: db.${model}.${method}`);
    if (state.throwOn === `${model}.${method}`) throw new Error("boom");
    const key = `${model}.${method}`;
    switch (key) {
      case "entity.findFirst": {
        const slug = (args as { where: { slug: string } }).where.slug;
        return state.entities[slug] ?? null;
      }
      case "document.findMany": return state.documents;
      case "paystub.findMany": return state.paystubs;
      case "taxWorkspace.findUnique": return state.workspace;
      case "user.findMany": return state.users;
      case "donation.findMany": return state.donations;
      case "taxQuestion.findMany": return state.questions;
      case "mileageEntry.findMany": return state.mileage;
      case "fixedAsset.findMany": return state.assets;
      case "transaction.groupBy": return state.grouped;
      case "glCode.findMany": return state.glCodes;
      default:
        return method === "findMany" ? [] : null;
    }
  };
  const db = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy({}, { get: (_t2, method: string) => handler(model, method) }),
    }
  );
  return { calls, state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));

import { buildTy2025Return, loadTy2025RawInputs } from "@/lib/tax2025-build";

const PERSONAL = { id: "ent-personal", name: "Personal", slug: "personal", navLabel: "Personal", type: "personal" };
const EKC = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", navLabel: "EKC", type: "llc" };

function reset(): void {
  h.calls.length = 0;
  h.state.entities = { personal: PERSONAL, "ek-consulting": EKC };
  h.state.documents = [];
  h.state.users = [
    { id: "u-eric", name: "Eric Kinniburgh" },
    { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  h.state.workspace = null;
  h.state.questions = [];
  h.state.donations = [];
  h.state.mileage = [];
  h.state.assets = [];
  h.state.paystubs = [];
  h.state.grouped = [];
  h.state.glCodes = [];
  h.state.throwOn = null;
}

function doc(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "d1",
    entityId: "ent-personal",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: null,
    extractionCorrections: null,
    extractionConfirmedAt: null,
    subjectType: "person",
    subjectUserId: "u-eric",
    documentName: "W-2",
    archivedAt: null,
    ...over,
  };
}

beforeEach(reset);

describe("lib/tax2025-build.ts through a mocked db", () => {
  it("absent data everywhere: no throw, no writes, an incomplete return with explicit statuses", async () => {
    const out = await buildTy2025Return(2025);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.ret.headline.complete).toBe(false);
    expect(out.ret.headline.federal.totalTax.amount).toBeNull();
    expect(out.ret.headline.federal.totalTax.reason).toBeTruthy();
    expect(h.calls.every((c) => /^find|groupBy$/.test(c.method))).toBe(true);
  });

  it("no personal entity: returns an error object, not a throw, and reads nothing else", async () => {
    h.state.entities = {};
    const out = await loadTy2025RawInputs(2025);
    expect(out).toEqual({ error: "Personal entity not found" });
    expect(h.calls.length).toBe(1);
  });

  it("no EK Consulting entity: loads with empty books (booksEmpty true, no Schedule C), no throw", async () => {
    h.state.entities = { personal: PERSONAL };
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    expect(out.raw.ekc.booksEmpty).toBe(true);
    expect(out.raw.scheduleCOwner).toBeNull();
    expect(out.ret.lines["schc.31"]?.status).toBe("missing_input");
    expect(h.calls.some((c) => c.model === "mileageEntry")).toBe(false);
  });

  it("every soft-deletable read carries archivedAt: null and the tax-year window; reads are entity-scoped", async () => {
    await buildTy2025Return(2025);
    const need = ["document", "paystub", "donation", "mileageEntry", "fixedAsset"];
    for (const m of need) {
      const c = h.calls.find((x) => x.model === m);
      expect(c, `${m} read`).toBeDefined();
      const where = (c!.args as { where: Record<string, unknown> }).where;
      expect(where.archivedAt, `${m}.archivedAt`).toBeNull();
      expect(where.entityId, `${m}.entityId`).toBeDefined();
    }
    const don = h.calls.find((x) => x.model === "donation")!.args as { where: { date: { gte: Date; lt: Date } } };
    expect(don.where.date.gte.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(don.where.date.lt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const grp = h.calls.find((x) => x.model === "transaction")!.args as { where: { archivedAt: null; transferPairId: null; postedAt: { gte: Date; lte: Date } } };
    expect(grp.where.archivedAt).toBeNull();
    expect(grp.where.postedAt.gte.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(grp.where.postedAt.lte.toISOString()).toBe("2025-12-31T23:59:59.000Z");
    // never touches a workspace-creating path
    expect(h.calls.some((c) => c.model === "taxWorkspace" && c.method !== "findUnique")).toBe(false);
  });

  it("documents reach the engine through resolveTaxDocForCompute: an owner correction overlays the AI read and marks the doc verified", async () => {
    h.state.documents = [
      doc({
        id: "w2-a",
        extractionData: { schemaVersion: 2, data: { wagesCents: 5_000_000, federalWithheldCents: 400_000, employerName: "Alpha", socialSecurityWagesCents: 5_000_000, socialSecurityWithheldCents: 310_000, medicareWagesCents: 5_000_000, medicareWithheldCents: 72_500, stateLines: [] } },
        extractionCorrections: { fields: { wagesCents: { value: 5_500_000, aiValue: 5_000_000 } } },
        extractionConfirmedAt: new Date("2026-09-01T00:00:00Z"),
      }),
    ];
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    const w = out.facts.income.w2s.find((x) => x.docId === "w2-a");
    expect(w, "W-2 reached facts").toBeDefined();
    // Raw AI extractionData must never be read directly: the corrected figure wins.
    expect(w!.wagesCents).toBe(5_500_000);
    expect(w!.basis).toBe("doc_verified");
    expect(w!.personUserId).toBe("u-eric");
  });

  it("an unconfirmed AI read is used but labelled doc_unverified and raises an advisory item", async () => {
    h.state.documents = [
      doc({ id: "w2-b", subjectUserId: "u-eva", extractionData: { schemaVersion: 2, data: { wagesCents: 3_000_000, employerName: "Beta", stateLines: [] } } }),
    ];
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    const w = out.facts.income.w2s[0]!;
    expect(w.basis).toBe("doc_unverified");
    expect(out.resolved.openItems.some((o) => o.id === "doc-unverified:w2-b")).toBe(true);
  });

  it("a W-2 with no person assigned is blocking, never silently attributed", async () => {
    h.state.documents = [doc({ id: "w2-c", subjectType: "joint", subjectUserId: null, extractionData: { schemaVersion: 2, data: { wagesCents: 1_000_000, stateLines: [] } } })];
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    expect(out.resolved.openItems.find((o) => o.id === "w2-no-person:w2-c")?.severity).toBe("blocking");
    expect(out.ret.lines["sch3.11"]?.status).not.toBe("computed");
  });

  it("documents of another tax year and unfinished (pending, no data) extractions are not counted; a failed RE-extract that still holds usable data is used but labelled unverified", async () => {
    h.state.documents = [
      doc({ id: "old", taxYear: 2024, extractionData: { schemaVersion: 2, data: { wagesCents: 9_999_999, stateLines: [] } } }),
      doc({ id: "pending", extractionStatus: "pending", extractionData: null }),
      doc({ id: "failed", extractionStatus: "failed", extractionData: { schemaVersion: 2, data: { wagesCents: 8_888_888, stateLines: [] } } }),
    ];
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    expect(out.facts.income.w2s.map((w) => w.docId)).toEqual(["failed"]);
    expect(out.facts.income.w2s[0]!.basis).toBe("doc_unverified");
  });

  it("EK Consulting P&L: totals come in as integer cents from computePL (abs), mapped by GL name, meals 50%", async () => {
    h.state.grouped = [
      { glCodeId: "g1", _sum: { amount: new Decimal("90000.00") }, _count: { _all: 12 } },
      { glCodeId: "g2", _sum: { amount: new Decimal("-1000.00") }, _count: { _all: 3 } },
      { glCodeId: "g3", _sum: { amount: new Decimal("-250.25") }, _count: { _all: 2 } },
    ];
    h.state.glCodes = [
      { id: "g1", code: "4000", name: "Services", type: "revenue" },
      { id: "g2", code: "6000", name: "Office expenses:Software & apps", type: "expense" },
      { id: "g3", code: "6100", name: "Meals", type: "expense" },
    ];
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    expect(out.facts.income.scheduleC.glLines.map((l) => [l.name, l.totalCents])).toEqual([
      ["Services", 9_000_000],
      ["Office expenses:Software & apps", 100_000],
      ["Meals", 25_025],
    ]);
    expect(out.ret.lines["schc.1"]?.amount).toBe(90000);
    expect(out.ret.lines["schc.24b"]?.amount).toBe(125); // 250.25 x 50% = 125.125 -> 125
    expect(out.ret.lines["schc.18"]?.amount).toBe(1000);
  });

  it("a thrown DB error propagates (the loader does not swallow or fabricate data)", async () => {
    h.state.throwOn = "document.findMany";
    await expect(buildTy2025Return(2025)).rejects.toThrow("boom");
  });
});
