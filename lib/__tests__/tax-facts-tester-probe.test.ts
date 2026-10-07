import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma } from "@prisma/client";

// Tester probes for tax-facts-carry-forward-store: an independent oracle for the carry-forward resolver, a
// versioning sequence fuzz, privacy / audit probes through the real actions (db mocked at the boundary), seed edge
// cases, and a render of the real browser component over the real seed. Round 1 defects D1 (open items labelled confirmed) and D2 (decision note dropped on edit) are now ordinary passing tests; round 2 adds the cap, retired/resolved and seed-figure probes.

(globalThis as unknown as { React: typeof React }).React = React;
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

type Row = Record<string, unknown> & { id: string; entityId: string; factKey: string; version: number; archivedAt: Date | null };
const state = vi.hoisted(() => ({ rows: [] as unknown[], nextId: 1 }));
const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  entity: { findFirst: vi.fn() },
  taxFact: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { reconfirmTaxFact, retireTaxFact, seedTaxFactsTy2025, setTaxFact, setTaxFactPolicy } from "@/actions/tax-facts";
import { resolveCarryForward, latestAsOfYear, type CarryRow } from "@/lib/tax-facts/carry-forward";
import { planNextVersion, type ExistingVersion, type VersionRequest } from "@/lib/tax-facts/versioning";
import { TAX_FACTS_SEED_TY2025 } from "@/lib/tax-facts/seed-ty2025";
import { convertStoredFact } from "@/lib/tax-facts-store";
import { groupFacts } from "@/lib/tax-facts/group";
import { FactsBrowser } from "@/components/tax/facts/facts-browser";
import { findCpaWording, findFinalPackageBannedWording } from "@/lib/tax-wording";
import { containsPrivateIdentifier } from "@/lib/tax-facts/validate";
import { CARRY_POLICIES, FACT_CATEGORIES, type TaxFactRow } from "@/lib/tax-facts/types";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const rows = () => state.rows as Row[];

function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (typeof v === "object" && v !== null && "in" in v) {
      if (!(v as { in: string[] }).in.includes(r[k] as string)) return false;
    } else if (r[k] !== v) return false;
  }
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.nextId = 1;
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ name: "Eric" });
  mockDb.entity.findFirst.mockResolvedValue({ id: PERSONAL });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxFact.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    rows().filter((r) => matches(r, args.where)).sort((a, b) => b.version - a.version)
  );
  mockDb.taxFact.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    rows().filter((r) => matches(r, args.where)).sort((a, b) => b.version - a.version)[0] ?? null
  );
  mockDb.taxFact.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `fact-${state.nextId++}`, archivedAt: null, setAt: new Date(), ...args.data } as unknown as Row;
    if (rows().some((r) => r.entityId === row.entityId && r.factKey === row.factKey && r.version === row.version)) {
      throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" });
    }
    state.rows.push(row);
    return row;
  });
  mockDb.taxFact.createMany.mockImplementation(async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
    let count = 0;
    for (const d of args.data) {
      const dup = rows().some((r) => r.entityId === d.entityId && r.factKey === d.factKey && r.version === d.version);
      if (dup && args.skipDuplicates) continue;
      state.rows.push({ id: `fact-${state.nextId++}`, archivedAt: null, ...d } as unknown as Row);
      count += 1;
    }
    return { count };
  });
  mockDb.taxFact.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of rows()) {
      if (matches(r, args.where)) {
        Object.assign(r, args.data);
        count += 1;
      }
    }
    return { count };
  });
});

// ---------- deterministic PRNG ----------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function mkRow(p: Partial<CarryRow> & { factKey: string; version: number; taxYear: number }): CarryRow {
  return {
    category: "household",
    label: "L",
    valueKind: "text",
    valueCents: null,
    valueText: "v",
    carryPolicy: "reconfirm",
    changeKind: "established",
    sourceKind: "owner_statement",
    confirmedAt: new Date("2026-01-01T12:00:00Z"),
    ...p,
  };
}

// ---------- independent oracle for the resolver ----------
type Bucket = "carried" | "needs" | "open" | "fresh" | "already" | "none";
function oracle(all: CarryRow[], key: string, target: number): { bucket: Bucket; version: number | null } {
  const eligible = all.filter((r) => r.factKey === key && r.taxYear <= target);
  if (eligible.length === 0) return { bucket: "none", version: null };
  const top = eligible.reduce((a, b) => (b.version > a.version ? b : a));
  if (top.changeKind === "retired" || top.changeKind === "resolved") return { bucket: "none", version: top.version };
  if (top.valueKind === "open_item") return { bucket: "open", version: top.version };
  if (top.taxYear === target) return { bucket: "already", version: top.version };
  if (top.carryPolicy === "stable") return { bucket: "carried", version: top.version };
  if (top.carryPolicy === "year_specific") return { bucket: "fresh", version: top.version };
  return { bucket: "needs", version: top.version };
}

describe("resolveCarryForward vs an independent oracle (fuzz)", () => {
  it("matches the oracle on 400 random histories across target years 2024..2028", () => {
    const rand = rng(20261007);
    const changeKinds = ["established", "changed", "reconfirmed", "policy_changed", "retired", "resolved"] as const;
    for (let iter = 0; iter < 400; iter++) {
      const all: CarryRow[] = [];
      const keys = ["a.one", "a.two", "b.three", "c.four"];
      for (const key of keys) {
        const n = Math.floor(rand() * 5);
        let year = 2024 + Math.floor(rand() * 3);
        const isOpen = rand() < 0.25;
        for (let v = 1; v <= n; v++) {
          year += Math.floor(rand() * 2);
          all.push(
            mkRow({
              factKey: key,
              version: v,
              taxYear: year,
              category: isOpen ? "open_item" : FACT_CATEGORIES[Math.floor(rand() * 8)]!,
              valueKind: isOpen ? "open_item" : "text",
              carryPolicy: CARRY_POLICIES[Math.floor(rand() * 4)]!,
              changeKind: changeKinds[Math.floor(rand() * changeKinds.length)]!,
            })
          );
        }
      }
      // shuffle input order: the resolver must not depend on it
      const shuffled = [...all].sort(() => rand() - 0.5);
      const snapshot = JSON.stringify(shuffled);
      for (let target = 2024; target <= 2028; target++) {
        const res = resolveCarryForward(shuffled, target);
        const got = new Map<string, { bucket: Bucket; version: number }>();
        const put = (items: typeof res.carried, bucket: Bucket) =>
          items.forEach((i) => {
            expect(got.has(i.factKey), `dup ${i.factKey}`).toBe(false);
            got.set(i.factKey, { bucket, version: i.fromVersion });
          });
        put(res.carried, "carried");
        put(res.needsReconfirmation, "needs");
        put(res.openItems, "open");
        put(res.askFresh, "fresh");
        put(res.alreadyConfirmedForYear, "already");
        for (const key of keys) {
          const exp = oracle(all, key, target);
          const act = got.get(key);
          if (exp.bucket === "none") expect(act, `${key}@${target} should be absent`).toBeUndefined();
          else expect(act, `${key}@${target}`).toEqual({ bucket: exp.bucket, version: exp.version });
        }
        // ask-fresh items are reference-only, nothing else is
        expect(res.askFresh.every((i) => i.referenceOnly)).toBe(true);
        for (const list of [res.carried, res.needsReconfirmation, res.openItems, res.alreadyConfirmedForYear]) {
          expect(list.every((i) => !i.referenceOnly)).toBe(true);
        }
        // every item says which year it came from
        for (const i of [...res.carried, ...res.needsReconfirmation, ...res.askFresh]) {
          expect(i.carriedLabel).toContain(`TY${i.fromTaxYear}`);
          expect(i.provenanceLabel).toContain(`TY${i.fromTaxYear}`);
          expect(i.fromTaxYear).toBeLessThan(target);
        }
      }
      expect(JSON.stringify(shuffled)).toBe(snapshot);
    }
  });

  it("year_specific never appears in carried or needs-reconfirmation, whatever the year", () => {
    const r = [mkRow({ factKey: "x.y", version: 1, taxYear: 2025, carryPolicy: "year_specific" })];
    for (const t of [2025, 2026, 2030]) {
      const res = resolveCarryForward(r, t);
      expect(res.carried).toHaveLength(0);
      expect(res.needsReconfirmation).toHaveLength(0);
    }
    expect(resolveCarryForward(r, 2026).askFresh).toHaveLength(1);
    expect(resolveCarryForward(r, 2025).alreadyConfirmedForYear).toHaveLength(1);
    expect(resolveCarryForward(r, 2024).askFresh).toHaveLength(0);
  });

  it("empty store and a key with no row yield empty buckets (no synthesised zero)", () => {
    const res = resolveCarryForward([], 2026);
    expect(Object.values(res).filter(Array.isArray).flat()).toHaveLength(0);
    expect(latestAsOfYear([], 2026).size).toBe(0);
  });

  it("a money fact stays in cents and a carried derived value is not recomputed", () => {
    const r = [mkRow({ factKey: "r.ira_basis", version: 1, taxYear: 2025, valueKind: "money_cents", valueCents: 1_430_000, valueText: null, carryPolicy: "derived" })];
    const res = resolveCarryForward(r, 2026);
    expect(res.needsReconfirmation[0]?.valueCents).toBe(1_430_000);
    expect(res.carried).toHaveLength(0);
  });
});

// ---------- versioning sequence fuzz ----------
function asExisting(r: TaxFactRow): ExistingVersion {
  return r;
}

describe("planNextVersion sequence fuzz", () => {
  it("any accepted sequence keeps versions consecutive, years non-decreasing, one un-archived row, nothing mutated", () => {
    const rand = rng(77);
    for (let iter = 0; iter < 300; iter++) {
      const history: TaxFactRow[] = [];
      const base: VersionRequest = {
        factKey: "fuzz.key",
        changeKind: "established",
        taxYear: 2025,
        confirmedAt: new Date("2026-10-07T12:00:00Z"),
        category: "household",
        label: "Fuzz",
        valueKind: "text",
        valueText: "alpha",
        carryPolicy: "reconfirm",
        sourceKind: "owner_statement",
      };
      let counter = 0;
      for (let step = 0; step < 12; step++) {
        const kinds = ["established", "changed", "reconfirmed", "policy_changed", "retired"] as const;
        const kind = history.length === 0 ? "established" : kinds[Math.floor(rand() * kinds.length)]!;
        const year = 2023 + Math.floor(rand() * 6);
        const req: VersionRequest =
          kind === "established"
            ? { ...base, taxYear: year }
            : kind === "changed"
              ? { factKey: "fuzz.key", changeKind: "changed", taxYear: year, confirmedAt: base.confirmedAt, valueText: `val${counter++}`, reason: "because" }
              : kind === "reconfirmed"
                ? { factKey: "fuzz.key", changeKind: "reconfirmed", taxYear: year, confirmedAt: base.confirmedAt }
                : kind === "policy_changed"
                  ? { factKey: "fuzz.key", changeKind: "policy_changed", taxYear: 0, confirmedAt: base.confirmedAt, newCarryPolicy: CARRY_POLICIES[Math.floor(rand() * 4)]! }
                  : { factKey: "fuzz.key", changeKind: "retired", taxYear: year, confirmedAt: base.confirmedAt, reason: "gone" };
        const before = JSON.stringify(history);
        const plan = planNextVersion(history.map(asExisting), req);
        expect(JSON.stringify(history)).toBe(before);
        if (!plan.ok) continue;
        const unarchived = history.filter((h) => h.archivedAt === null).map((h) => h.id);
        expect(plan.toArchiveIds.sort()).toEqual(unarchived.sort());
        for (const h of history) if (plan.toArchiveIds.includes(h.id)) h.archivedAt = new Date();
        const latest = history[history.length - 1];
        expect(plan.newRow.version).toBe((latest?.version ?? 0) + 1);
        if (latest) expect(plan.newRow.taxYear).toBeGreaterThanOrEqual(latest.taxYear);
        history.push({ ...plan.newRow, id: `h${history.length}`, setByName: "x", setAt: new Date(), archivedAt: null });
        expect(history.filter((h) => h.archivedAt === null)).toHaveLength(1);
        // resolver must agree with "as of" semantics at every year
        for (const target of [2023, 2025, 2027, 2030]) {
          const o = oracle(history, "fuzz.key", target);
          const res = resolveCarryForward(history, target);
          const all = [...res.carried, ...res.needsReconfirmation, ...res.openItems, ...res.askFresh, ...res.alreadyConfirmedForYear];
          if (o.bucket === "none") expect(all).toHaveLength(0);
          else expect(all[0]?.fromVersion).toBe(o.version);
        }
      }
    }
  });

  it("retired then re-established then as-of recall: TY2025 still shows the old value, TY2027 the new one", () => {
    const t = new Date("2026-10-07T12:00:00Z");
    const v1 = planNextVersion([], { factKey: "k.a", changeKind: "established", taxYear: 2025, confirmedAt: t, category: "household", label: "A", valueKind: "text", valueText: "one", carryPolicy: "stable", sourceKind: "owner_statement" });
    if (!v1.ok) throw new Error(v1.error);
    const r1: TaxFactRow = { ...v1.newRow, id: "1", setByName: "e", setAt: t, archivedAt: new Date() };
    const v2 = planNextVersion([r1], { factKey: "k.a", changeKind: "retired", taxYear: 2026, confirmedAt: t, reason: "no longer" });
    if (!v2.ok) throw new Error(v2.error);
    const r2: TaxFactRow = { ...v2.newRow, id: "2", setByName: "e", setAt: t, archivedAt: new Date() };
    const v3 = planNextVersion([r1, r2], { factKey: "k.a", changeKind: "established", taxYear: 2027, confirmedAt: t, category: "household", label: "A", valueKind: "text", valueText: "two", carryPolicy: "stable", sourceKind: "owner_statement" });
    if (!v3.ok) throw new Error(v3.error);
    const r3: TaxFactRow = { ...v3.newRow, id: "3", setByName: "e", setAt: t, archivedAt: null };
    const all = [r1, r2, r3];
    expect(latestAsOfYear(all, 2025).get("k.a")?.valueText).toBe("one");
    expect(latestAsOfYear(all, 2026).get("k.a")?.changeKind).toBe("retired");
    expect(latestAsOfYear(all, 2027).get("k.a")?.valueText).toBe("two");
    expect(resolveCarryForward(all, 2026).carried).toHaveLength(0);
    expect(resolveCarryForward(all, 2028).carried[0]?.valueText).toBe("two");
  });
});

// ---------- privacy probes through the real actions ----------
describe("privacy guard before any db call", () => {
  const bad = [
    "123-45-6789",
    "123 45 6789",
    "123456789",
    "12-3456789",
    "ending 1234567890123",
    "date of birth 1980-02-03",
    "DOB: 02/03/1980",
    "born on March 3",
    "１２３-４５-６７８９", // full-width digits
  ];

  for (const text of bad) {
    it(`refuses ${JSON.stringify(text).slice(0, 40)} in value, label, source reference and reason with zero db access`, async () => {
      const base = { mode: "create" as const, factKey: "x.y", category: "household" as const, label: "L", valueKind: "text" as const, valueText: "ok", carryPolicy: "reconfirm" as const, taxYear: 2025 };
      const attempts = await Promise.all([
        setTaxFact({ ...base, valueText: text }),
        setTaxFact({ ...base, label: text }),
        setTaxFact({ ...base, sourceRef: text }),
        setTaxFact({ ...base, reason: text }),
        setTaxFact({ ...base, valueKind: "choice", valueText: text.toLowerCase() }),
        setTaxFact({ mode: "change", factKey: "x.y", taxYear: 2025, valueText: text, reason: "fine reason" }),
        setTaxFact({ mode: "change", factKey: "x.y", taxYear: 2025, valueText: "ok", reason: text }),
        setTaxFact({ mode: "change", factKey: "x.y", taxYear: 2025, newLabel: text, valueText: "ok", reason: "fine reason" }),
        reconfirmTaxFact({ factKey: "x.y", taxYear: 2026, reason: text }),
        setTaxFactPolicy({ factKey: "x.y", carryPolicy: "stable", reason: text }),
        retireTaxFact({ factKey: "x.y", taxYear: 2026, reason: text }),
      ]);
      for (const a of attempts) expect(a.ok).toBe(false);
      expect(mockDb.user.findUnique).not.toHaveBeenCalled();
      expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
      expect(mockDb.taxFact.findMany).not.toHaveBeenCalled();
      expect(mockDb.taxFact.findFirst).not.toHaveBeenCalled();
      expect(mockDb.taxFact.create).not.toHaveBeenCalled();
      expect(mockDb.$transaction).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
      for (const a of attempts) if (!a.ok) expect(a.error).not.toContain(text);
    });
  }

  it("the privacy refusal on a bad fact KEY (SSN-shaped) happens before the db", async () => {
    const r = await setTaxFact({ mode: "create", factKey: "ssn.123456789", category: "household", label: "L", valueKind: "text", valueText: "ok", carryPolicy: "reconfirm", taxYear: 2025 });
    expect(r.ok).toBe(false);
    expect(mockDb.taxFact.create).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("accepts the normal money / date-ish text the seed uses", () => {
    for (const t of ["1,894.50", "14,300", "March 2019", "Formed February 2026", "90% joint tenancy"]) {
      expect(containsPrivateIdentifier(t), t).toBe(false);
    }
  });
});

// ---------- audit rows carry no values ----------
describe("AuditLog payloads never carry label, value, reason or seed text", () => {
  it("every action's audit row holds only the eight allowed keys and none of the marker strings", async () => {
    const M = { label: "LABELMARKER", value: "VALUEMARKER", reason: "REASONMARKER", ref: "REFMARKER", reason2: "REASONTWO" };
    expect(await setTaxFact({ mode: "create", factKey: "m.one", category: "household", label: M.label, valueKind: "text", valueText: M.value, carryPolicy: "reconfirm", taxYear: 2025, sourceRef: M.ref, reason: M.reason })).toMatchObject({ ok: true });
    expect(await setTaxFact({ mode: "change", factKey: "m.one", taxYear: 2025, valueText: `${M.value}2`, reason: M.reason2, newLabel: `${M.label}2` })).toMatchObject({ ok: true });
    expect(await reconfirmTaxFact({ factKey: "m.one", taxYear: 2026, reason: M.reason })).toMatchObject({ ok: true });
    expect(await setTaxFactPolicy({ factKey: "m.one", carryPolicy: "stable", reason: M.reason })).toMatchObject({ ok: true });
    expect(await retireTaxFact({ factKey: "m.one", taxYear: 2027, reason: M.reason2 })).toMatchObject({ ok: true });
    expect(await seedTaxFactsTy2025()).toMatchObject({ ok: true });
    const calls = mockDb.auditLog.create.mock.calls as Array<[{ data: { changeType: string; before: unknown; after: unknown } }]>;
    expect(calls).toHaveLength(6);
    const text = JSON.stringify(calls);
    for (const m of Object.values(M)) expect(text).not.toContain(m);
    for (const seed of TAX_FACTS_SEED_TY2025) {
      if (seed.valueText && seed.valueText.length > 12) expect(text).not.toContain(seed.valueText);
      expect(text).not.toContain(seed.label);
    }
    const allowed = ["id", "version", "factKey", "category", "carryPolicy", "changeKind", "taxYear", "valueKind"].sort();
    for (const [c] of calls.slice(0, 5)) {
      for (const side of [c.data.before, c.data.after]) {
        if (side && typeof side === "object" && "id" in (side as object)) expect(Object.keys(side as object).sort()).toEqual(allowed);
      }
    }
    expect(Object.keys(calls[5]![0].data.after as object).sort()).toEqual(["inserted", "seedVersion", "total"]);
  });
});

// ---------- seed probes ----------
describe("seed probes", () => {
  it("every seed row survives a database round trip and can be re-confirmed, policy-changed, changed and retired/resolved", () => {
    for (const s of TAX_FACTS_SEED_TY2025) {
      const stored = {
        id: "x", entityId: PERSONAL, factKey: s.factKey, version: 1, category: s.category, label: s.label, taxYear: s.taxYear,
        valueKind: s.valueKind, valueCents: s.valueCents ?? null, valueText: s.valueText ?? null, carryPolicy: s.carryPolicy,
        changeKind: "established", sourceKind: s.sourceKind, sourceRef: s.sourceRef, reason: s.reason ?? null,
        confirmedAt: new Date(), setById: null, setByName: "e", setAt: new Date(), archivedAt: null, archivedById: null,
        createdAt: new Date(), updatedAt: new Date(),
      };
      const row = convertStoredFact(stored);
      expect(row, s.factKey).not.toBeNull();
      const t = new Date();
      if (s.valueKind === "open_item") {
        expect(planNextVersion([row!], { factKey: s.factKey, changeKind: "resolved", taxYear: 2026, confirmedAt: t, reason: "settled" }).ok, s.factKey).toBe(true);
        expect(planNextVersion([row!], { factKey: s.factKey, changeKind: "reconfirmed", taxYear: 2026, confirmedAt: t }).ok, s.factKey).toBe(false);
      } else {
        expect(planNextVersion([row!], { factKey: s.factKey, changeKind: "reconfirmed", taxYear: 2026, confirmedAt: t }).ok, s.factKey).toBe(s.taxYear < 2026);
        expect(planNextVersion([row!], { factKey: s.factKey, changeKind: "retired", taxYear: 2026, confirmedAt: t, reason: "gone" }).ok, s.factKey).toBe(true);
        const other = s.carryPolicy === "stable" ? "reconfirm" : "stable";
        expect(planNextVersion([row!], { factKey: s.factKey, changeKind: "policy_changed", taxYear: 0, confirmedAt: t, newCarryPolicy: other }).ok, s.factKey).toBe(true);
      }
    }
  });

  it("resolving the real seed for TY2026: buckets match policy, 7 open items, derived basis needs re-confirmation, nothing year_specific carried", () => {
    const seedRows: CarryRow[] = TAX_FACTS_SEED_TY2025.map((s) => ({
      factKey: s.factKey, version: 1, category: s.category, label: s.label, taxYear: s.taxYear, valueKind: s.valueKind,
      valueCents: s.valueCents ?? null, valueText: s.valueText ?? null, carryPolicy: s.carryPolicy, changeKind: "established",
      sourceKind: s.sourceKind, confirmedAt: new Date("2026-10-07T16:00:00Z"),
    }));
    const r = resolveCarryForward(seedRows, 2026);
    expect(r.openItems).toHaveLength(7);
    expect(r.carried.every((i) => i.carryPolicy === "stable")).toBe(true);
    expect(r.needsReconfirmation.every((i) => i.carryPolicy === "reconfirm" || i.carryPolicy === "derived")).toBe(true);
    expect(r.askFresh.every((i) => i.carryPolicy === "year_specific" && i.referenceOnly)).toBe(true);
    expect(r.needsReconfirmation.find((i) => i.factKey === "retirement.taxpayer_m.ira_basis_end")?.valueCents).toBe(1_430_000);
    expect(r.alreadyConfirmedForYear.map((i) => i.factKey)).toEqual(["business.sudden_valley.formed"]);
    const total = r.carried.length + r.needsReconfirmation.length + r.openItems.length + r.askFresh.length + r.alreadyConfirmedForYear.length;
    expect(total).toBe(TAX_FACTS_SEED_TY2025.length);
    // TY2025 view: sudden_valley (2026) is absent, everything else already confirmed or open
    const r25 = resolveCarryForward(seedRows, 2025);
    expect(r25.carried.length + r25.needsReconfirmation.length + r25.askFresh.length).toBe(0);
    expect(r25.alreadyConfirmedForYear).toHaveLength(TAX_FACTS_SEED_TY2025.length - 7 - 1);
  });

  it("seed never resurrects a retired key or overwrites an edited one, and a partial table only gets the missing keys", async () => {
    await seedTaxFactsTy2025();
    const total = TAX_FACTS_SEED_TY2025.length;
    expect(rows()).toHaveLength(total);
    await setTaxFact({ mode: "change", factKey: "decision.x6.internet_phone_business_pct", taxYear: 2025, valueText: "60", reason: "corrected" });
    await retireTaxFact({ factKey: "household.filing_status", taxYear: 2026, reason: "changed status" });
    expect(await seedTaxFactsTy2025()).toMatchObject({ ok: true, inserted: 0, alreadyPresent: total });
    expect(rows()).toHaveLength(total + 2);
    expect(rows().filter((r) => r.factKey === "household.filing_status" && r.archivedAt === null).map((r) => r.changeKind)).toEqual(["retired"]);
    // drop 3 keys entirely: only those come back, version 1
    state.rows = rows().filter((r) => !["household.preparer", "estate.has_own_ein", "business.mezzo.status"].includes(r.factKey));
    const res = await seedTaxFactsTy2025();
    expect(res).toMatchObject({ ok: true, inserted: 3 });
    expect(rows().filter((r) => r.factKey === "decision.x6.internet_phone_business_pct")).toHaveLength(2);
  });

  it("two parallel seeds insert each key once", async () => {
    await Promise.all([seedTaxFactsTy2025(), seedTaxFactsTy2025()]);
    const keys = rows().map((r) => `${r.factKey}#${r.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("an unauthenticated session id with no user record is refused without a write", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    expect(await seedTaxFactsTy2025()).toMatchObject({ ok: false });
    expect(mockDb.taxFact.createMany).not.toHaveBeenCalled();
  });
});

// ---------- rendered component over the real seed ----------
describe("FactsBrowser rendered over the real seed", () => {
  function seedRows(): TaxFactRow[] {
    return TAX_FACTS_SEED_TY2025.map((s, i) => ({
      id: `s${i}`, factKey: s.factKey, version: 1, category: s.category, label: s.label, taxYear: s.taxYear, valueKind: s.valueKind,
      valueCents: s.valueCents ?? null, valueText: s.valueText ?? null, carryPolicy: s.carryPolicy, changeKind: "established",
      sourceKind: s.sourceKind, sourceRef: s.sourceRef, reason: s.reason ?? null, confirmedAt: new Date("2026-10-07T16:00:00Z"),
      setByName: "Eric", setAt: new Date("2026-10-08T12:00:00Z"), archivedAt: null,
    }));
  }
  const html = () => renderToStaticMarkup(createElement(FactsBrowser, { grouped: groupFacts(seedRows()) }));

  it("renders every fact label, the history, provenance, and nothing claims CPA / verification / certification", () => {
    const out = html();
    for (const s of TAX_FACTS_SEED_TY2025) expect(out).toContain(s.label.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    expect(out).toContain("History (1 version)");
    expect(out).toContain("Owner statement, not verified by documents");
    expect(out).toContain("Recorded copy for recall");
    const text = out.replace(/<[^>]+>/g, " ");
    expect(findCpaWording(text)).toEqual([]);
    void findFinalPackageBannedWording; // the final-package list does not apply to this owner page
    expect(/certif|professionally reviewed|approved by|AI|Claude/.test(text.replace(/\bAIR\b/g, ""))).toBe(false);
  });

  it("open items are not labelled 'confirmed' (their own heading says they are never marked confirmed)", () => {
    const out = html();
    const start = out.indexOf("Open items (7)");
    expect(start).toBeGreaterThan(-1);
    const section = out.slice(start).replace(/<[^>]+>/g, " ");
    expect(/confirmed 2026-10-07/.test(section.replace("never marked confirmed", ""))).toBe(false);
    expect(section).toContain("Recorded 2026-10-07 for TY2025 (v1)");
  });
});

// ---------- defect probe: editing a decision fact drops its recall-only note ----------
describe("decision facts keep the 'recall only' provenance after an edit", () => {
  it("an edited decision fact still shows the recall-only note (R9 mitigation; keyed on category, not source kind)", () => {
    const t = new Date("2026-10-07T12:00:00Z");
    const v1: TaxFactRow = {
      id: "1", factKey: "decision.x1.home_office_method", version: 1, category: "decision", label: "X1", taxYear: 2025, valueKind: "choice",
      valueCents: null, valueText: "simplified", carryPolicy: "reconfirm", changeKind: "established", sourceKind: "decision", sourceRef: "r",
      reason: null, confirmedAt: t, setByName: "e", setAt: t, archivedAt: null,
    };
    const plan = planNextVersion([v1], { factKey: v1.factKey, changeKind: "changed", taxYear: 2026, confirmedAt: t, valueText: "actual", reason: "now profitable" });
    if (!plan.ok) throw new Error(plan.error);
    // an edit is the owner's own statement, so the source kind changes; the note must not depend on it
    expect(plan.newRow.sourceKind).toBe("owner_statement");
    const edited: TaxFactRow = { ...v1, ...plan.newRow, id: "2", setByName: "e", setAt: t, archivedAt: null };
    const out = renderToStaticMarkup(createElement(FactsBrowser, { grouped: groupFacts([{ ...v1, archivedAt: t }, edited]) }));
    expect(out).toContain("Recorded copy for recall");
  });
});

// ---------- seed policy classification pin (plan Q1 defaults; a mutation turning every year_specific into stable survived the coder tests) ----------
describe("seed carry-policy classification is pinned per key", () => {
  const keysWith = (p: string) => TAX_FACTS_SEED_TY2025.filter((s) => s.carryPolicy === p).map((s) => s.factKey).sort();
  it("year_specific", () => {
    expect(keysWith("year_specific")).toEqual(
      [
        "business.ekc.depreciable_items",
        "business.ekc.mileage",
        "business.ekc.software_expenses_all_llc",
        "estate.bond_interest_2025_reporting_decision",
        "retirement.taxpayer_m.ira_2025_contribution",
      ].sort()
    );
  });
  it("derived", () => {
    expect(keysWith("derived")).toEqual(["retirement.taxpayer_m.ira_basis_end"]);
  });
  it("stable (historical or structurally permanent only; open items hold the placeholder)", () => {
    const stable = TAX_FACTS_SEED_TY2025.filter((s) => s.carryPolicy === "stable" && s.valueKind !== "open_item").map((s) => s.factKey).sort();
    expect(stable).toEqual(
      [
        "business.sudden_valley.formed",
        "estate.executor_and_sole_beneficiary",
        "estate.form_1041_2024_filed",
        "estate.has_own_ein",
        "estate.no_final_2024_form_1040_for_mother",
        "property.arbor_rd_56.deed_not_gift",
        "property.arbor_rd_56.ownership",
        "property.arbor_rd_56.renovations_capitalized",
        "property.old_barry_rd_27.mortgage_purpose",
        "property.old_barry_rd_27.solar",
      ].sort()
    );
  });
  it("the five decisions are all re-confirm (never silently carried)", () => {
    const d = TAX_FACTS_SEED_TY2025.filter((s) => s.category === "decision");
    expect(d).toHaveLength(5);
    expect(d.every((s) => s.carryPolicy === "reconfirm")).toBe(true);
  });
});

// ---------- round 2 probes (tester): INT cap through the actions, neutral retired / resolved cards, seed vs spec 12 ----------
describe("round 2: valueCents cap through the real actions (S2)", () => {
  const money = { mode: "create" as const, factKey: "retirement.x.amount", category: "retirement" as const, label: "Amount", valueKind: "money_cents" as const, carryPolicy: "derived" as const, taxYear: 2025 };

  it("refuses 2,147,483,648 cents (either sign) on create and on change with a plain error, no throw, nothing written, no audit row", async () => {
    for (const cents of [2_147_483_648, -2_147_483_648, 100_000_000_000]) {
      const r = await setTaxFact({ ...money, valueCents: cents });
      expect(r.ok).toBe(false);
    }
    expect(rows().length).toBe(0);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();

    const ok = await setTaxFact({ ...money, valueCents: 2_147_483_647 });
    expect(ok.ok).toBe(true);
    expect(rows().length).toBe(1);
    const audits = mockDb.auditLog.create.mock.calls.length;

    for (const cents of [2_147_483_648, -2_147_483_648]) {
      const r = await setTaxFact({ mode: "change", factKey: money.factKey, taxYear: 2026, valueCents: cents, reason: "bigger than the column" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/2147483648|2,147,483,648/);
    }
    expect(rows().length).toBe(1);
    expect(rows()[0]?.archivedAt).toBeNull();
    expect(mockDb.auditLog.create.mock.calls.length).toBe(audits);
    const big = await setTaxFact({ mode: "change", factKey: money.factKey, taxYear: 2026, valueCents: -2_147_483_647, reason: "boundary ok" });
    expect(big.ok).toBe(true);
  });
});

describe("round 2: retired and resolved cards never say 'confirmed' about the retirement (B2)", () => {
  const t = new Date("2026-10-07T12:00:00Z");
  const base = (o: Partial<TaxFactRow>): TaxFactRow => ({
    id: "x", factKey: "k.one", version: 1, category: "household", label: "Thing", taxYear: 2025, valueKind: "text",
    valueCents: null, valueText: "val", carryPolicy: "reconfirm", changeKind: "established", sourceKind: "owner_statement",
    sourceRef: null, reason: null, confirmedAt: t, setByName: "Eric", setAt: t, archivedAt: null, ...o,
  });

  it("a retired fact and a resolved open item render 'Retired' / 'Resolved' and 'recorded', and the only 'confirmed' left is the established version's own history", () => {
    const retiredV1 = base({ id: "a1", archivedAt: t });
    const retiredV2 = base({ id: "a2", version: 2, taxYear: 2026, changeKind: "retired", reason: "no longer true" });
    const openV1 = base({ id: "b1", factKey: "open.q", category: "open_item", valueKind: "open_item", label: "Q", archivedAt: t });
    const openV2 = base({ id: "b2", factKey: "open.q", category: "open_item", valueKind: "open_item", label: "Q", version: 2, taxYear: 2026, changeKind: "resolved", reason: "filed" });
    const out = renderToStaticMarkup(createElement(FactsBrowser, { grouped: groupFacts([retiredV1, retiredV2, openV1, openV2]) }));
    const text = out.replace(/<[^>]+>/g, " ");
    expect(text).toContain("Retired 2026-10-07 from TY2026 (v2)");
    expect(text).toContain("Resolved 2026-10-07 from TY2026 (v2)");
    expect(text).not.toContain("confirmed 2026-10-07 for TY2026");
    // history lines of the retire / resolve versions say recorded
    expect(text).toMatch(/Retired for TY2026[^;]*Re-confirm; recorded 2026-10-07/);
    expect(text).toMatch(/Resolved for TY2026[^;]*[A-Za-z-]+; recorded 2026-10-07/);
  });

  it("an edited decision, a policy change on a decision and a retired decision all keep the recall-only note", () => {
    const d1 = base({ id: "d1", factKey: "decision.x1.home_office_method", category: "decision", valueKind: "choice", valueText: "simplified", sourceKind: "decision", archivedAt: t });
    const d2 = base({ id: "d2", factKey: "decision.x1.home_office_method", category: "decision", valueKind: "choice", valueText: "simplified", sourceKind: "decision", version: 2, changeKind: "policy_changed", carryPolicy: "stable" });
    const out = renderToStaticMarkup(createElement(FactsBrowser, { grouped: groupFacts([d1, d2]) }));
    expect(out).toContain("Recorded copy for recall");
    const d3 = { ...d2, id: "d3", version: 3, changeKind: "retired" as const, taxYear: 2026 };
    const out2 = renderToStaticMarkup(createElement(FactsBrowser, { grouped: groupFacts([d1, { ...d2, archivedAt: t }, d3]) }));
    expect(out2).toContain("Recorded copy for recall");
  });
});

describe("round 2: no document-held figure anywhere in the seed (B1, independent of the coder's list)", () => {
  it("scans label, value, reason, sourceRef and anchors of all entries for every dollar figure in spec 12 except the two allowed ones", async () => {
    const { readFileSync } = await import("node:fs");
    const spec = readFileSync("specs/12-owner-confirmed-facts-ty2025.md", "utf8");
    const figures = new Set<string>();
    for (const m of spec.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}|\d{4,}/g)) figures.add(m[0]);
    for (const f of ["2025", "2024", "2026", "2019", "2022", "1041", "1040", "1098", "5498", "8606", "8949", "8815", "8829", "2021", "1099", "5695", "8960"]) figures.delete(f);
    const allowed = new Set(["14,300", "90,000"]);
    expect(figures.size).toBeGreaterThan(20);
    for (const s of TAX_FACTS_SEED_TY2025) {
      const text = [s.label, s.valueText ?? "", s.sourceRef, s.reason ?? "", s.specAnchor, ...(s.moreAnchors ?? [])].join(" | ");
      for (const f of figures) {
        if (allowed.has(f)) continue;
        // a figure appearing only as part of a longer number or a form number is not a document figure: require a word-ish boundary
        const re = new RegExp(`(^|[^0-9,.])${f.replace(/[.,]/g, (c) => `\\${c}`)}($|[^0-9])`);
        expect(re.test(text), `${s.factKey} contains ${f}`).toBe(false);
      }
      if (s.valueCents !== undefined) expect(s.factKey).toBe("retirement.taxpayer_m.ira_basis_end");
    }
  });
});
