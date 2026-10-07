import { describe, it, expect } from "vitest";
import { planNextVersion, type ExistingVersion, type VersionRequest } from "@/lib/tax-facts/versioning";

const KEY = "household.filing_status";
const T0 = new Date("2026-10-07T16:00:00.000Z");
const T1 = new Date("2027-01-15T16:00:00.000Z");

const v = (over: Partial<ExistingVersion> = {}): ExistingVersion => ({
  id: "id-1",
  version: 1,
  category: "household",
  label: "Filing status",
  taxYear: 2025,
  valueKind: "choice",
  valueCents: null,
  valueText: "mfj",
  carryPolicy: "reconfirm",
  changeKind: "established",
  sourceKind: "owner_statement",
  sourceRef: "specs/12",
  confirmedAt: T0,
  archivedAt: null,
  ...over,
});

const est: VersionRequest = {
  factKey: KEY,
  changeKind: "established",
  taxYear: 2025,
  confirmedAt: T0,
  category: "household",
  label: "Filing status",
  valueKind: "choice",
  valueText: "mfj",
  carryPolicy: "reconfirm",
  sourceKind: "owner_statement",
};

function expectOk(p: ReturnType<typeof planNextVersion>) {
  if (!p.ok) throw new Error(`expected ok, got: ${p.error}`);
  return p;
}

describe("first version", () => {
  it("is version 1, established, archives nothing", () => {
    const p = expectOk(planNextVersion([], est));
    expect(p.newRow.version).toBe(1);
    expect(p.newRow.changeKind).toBe("established");
    expect(p.toArchiveIds).toEqual([]);
  });
  it("any other kind of change on a missing key is refused", () => {
    for (const changeKind of ["changed", "reconfirmed", "policy_changed", "retired", "resolved"] as const) {
      expect(planNextVersion([], { ...est, changeKind, reason: "because" }).ok).toBe(false);
    }
  });
  it("needs category, label, type, policy and source", () => {
    expect(planNextVersion([], { ...est, category: undefined }).ok).toBe(false);
    expect(planNextVersion([], { ...est, carryPolicy: undefined }).ok).toBe(false);
  });
  it("establishing an existing live key is refused", () => {
    expect(planNextVersion([v()], est).ok).toBe(false);
  });
});

describe("changed", () => {
  const change: VersionRequest = { factKey: KEY, changeKind: "changed", taxYear: 2025, confirmedAt: T1, valueText: "mfs", reason: "Filing separately now" };
  it("inserts version + 1 and archives the prior latest", () => {
    const p = expectOk(planNextVersion([v()], change));
    expect(p.newRow.version).toBe(2);
    expect(p.newRow.valueText).toBe("mfs");
    expect(p.newRow.changeKind).toBe("changed");
    expect(p.newRow.sourceKind).toBe("owner_statement");
    expect(p.toArchiveIds).toEqual(["id-1"]);
  });
  it("needs a reason", () => {
    expect(planNextVersion([v()], { ...change, reason: undefined }).ok).toBe(false);
    expect(planNextVersion([v()], { ...change, reason: "ab" }).ok).toBe(false);
  });
  it("refuses an identical value", () => {
    expect(planNextVersion([v()], { ...change, valueText: "mfj" }).ok).toBe(false);
  });
  it("allows a changed title with the same value", () => {
    const p = expectOk(planNextVersion([v()], { ...change, valueText: "mfj", newLabel: "Filing status (joint)" }));
    expect(p.newRow.label).toBe("Filing status (joint)");
  });
  it("refuses a lower tax year than the latest, allows the same or a later one", () => {
    expect(planNextVersion([v({ taxYear: 2026 })], { ...change, taxYear: 2025 }).ok).toBe(false);
    expect(planNextVersion([v({ taxYear: 2025 })], { ...change, taxYear: 2025 }).ok).toBe(true);
    expect(planNextVersion([v({ taxYear: 2025 })], { ...change, taxYear: 2026 }).ok).toBe(true);
  });
  it("validates the new value for the kind and the privacy guard", () => {
    expect(planNextVersion([v({ valueKind: "bool", valueText: "yes" })], { ...change, valueText: "maybe" }).ok).toBe(false);
    expect(planNextVersion([v({ valueKind: "text", valueText: "x" })], { ...change, valueText: "see 123-45-6789" }).ok).toBe(false);
    expect(planNextVersion([v()], { ...change, reason: "ssn 123-45-6789" }).ok).toBe(false);
  });
  it("archives every un-archived row (and only those)", () => {
    const rows = [v({ id: "a", version: 1, archivedAt: T0 }), v({ id: "b", version: 2 })];
    const p = expectOk(planNextVersion(rows, change));
    expect(p.toArchiveIds).toEqual(["b"]);
    expect(p.newRow.version).toBe(3);
  });
});

describe("reconfirmed", () => {
  const rc: VersionRequest = { factKey: KEY, changeKind: "reconfirmed", taxYear: 2026, confirmedAt: T1 };
  it("keeps the value, moves the tax year, reason optional", () => {
    const p = expectOk(planNextVersion([v()], rc));
    expect(p.newRow.valueText).toBe("mfj");
    expect(p.newRow.taxYear).toBe(2026);
    expect(p.newRow.changeKind).toBe("reconfirmed");
    expect(p.newRow.confirmedAt).toEqual(T1);
    expect(p.newRow.reason).toBeNull();
  });
  it("is refused for the same or an earlier year (a re-confirmation in the same year does nothing)", () => {
    expect(planNextVersion([v()], { ...rc, taxYear: 2025 }).ok).toBe(false);
    expect(planNextVersion([v()], { ...rc, taxYear: 2024 }).ok).toBe(false);
  });
  it("is refused for an open item", () => {
    const open = v({ valueKind: "open_item", category: "open_item", carryPolicy: "stable", valueText: "Question" });
    expect(planNextVersion([open], rc).ok).toBe(false);
  });
});

describe("policy_changed", () => {
  const pc: VersionRequest = { factKey: KEY, changeKind: "policy_changed", taxYear: 0, confirmedAt: T1, newCarryPolicy: "stable" };
  it("keeps the value, the tax year and the confirmation date", () => {
    const p = expectOk(planNextVersion([v()], pc));
    expect(p.newRow.carryPolicy).toBe("stable");
    expect(p.newRow.valueText).toBe("mfj");
    expect(p.newRow.taxYear).toBe(2025);
    expect(p.newRow.confirmedAt).toEqual(T0);
  });
  it("refuses the same policy and an open item", () => {
    expect(planNextVersion([v()], { ...pc, newCarryPolicy: "reconfirm" }).ok).toBe(false);
    const open = v({ valueKind: "open_item", category: "open_item", carryPolicy: "stable", valueText: "Question" });
    expect(planNextVersion([open], pc).ok).toBe(false);
  });
});

describe("retired and resolved", () => {
  it("retire needs a reason, keeps the value, is a version not a deletion", () => {
    const rt: VersionRequest = { factKey: KEY, changeKind: "retired", taxYear: 2026, confirmedAt: T1, reason: "No longer applies" };
    expect(planNextVersion([v()], { ...rt, reason: undefined }).ok).toBe(false);
    const p = expectOk(planNextVersion([v()], rt));
    expect(p.newRow.changeKind).toBe("retired");
    expect(p.newRow.valueText).toBe("mfj");
    expect(p.newRow.version).toBe(2);
    expect(p.toArchiveIds).toEqual(["id-1"]);
  });
  it("resolve works only on an open item and needs a reason", () => {
    const open = v({ valueKind: "open_item", category: "open_item", carryPolicy: "stable", valueText: "Question" });
    const rs: VersionRequest = { factKey: KEY, changeKind: "resolved", taxYear: 2026, confirmedAt: T1, reason: "Settled with the estate" };
    expect(planNextVersion([v()], rs).ok).toBe(false);
    expect(planNextVersion([open], { ...rs, reason: undefined }).ok).toBe(false);
    expect(expectOk(planNextVersion([open], rs)).newRow.changeKind).toBe("resolved");
  });
  it("retire is refused for an open item", () => {
    const open = v({ valueKind: "open_item", category: "open_item", carryPolicy: "stable", valueText: "Question" });
    expect(planNextVersion([open], { factKey: KEY, changeKind: "retired", taxYear: 2026, confirmedAt: T1, reason: "done" }).ok).toBe(false);
  });
  it("a retired key accepts only a new established version (re-introduction)", () => {
    const retired = v({ version: 2, id: "r", changeKind: "retired", taxYear: 2026 });
    const history = [v({ archivedAt: T1 }), retired];
    expect(planNextVersion(history, { factKey: KEY, changeKind: "changed", taxYear: 2027, confirmedAt: T1, valueText: "x", reason: "again" }).ok).toBe(false);
    expect(planNextVersion(history, { factKey: KEY, changeKind: "reconfirmed", taxYear: 2027, confirmedAt: T1 }).ok).toBe(false);
    expect(planNextVersion(history, { factKey: KEY, changeKind: "policy_changed", taxYear: 2027, confirmedAt: T1, newCarryPolicy: "stable" }).ok).toBe(false);
    const p = expectOk(planNextVersion(history, { ...est, taxYear: 2027, confirmedAt: T1 }));
    expect(p.newRow.version).toBe(3);
    expect(p.toArchiveIds).toEqual(["r"]);
    expect(planNextVersion(history, { ...est, taxYear: 2025 }).ok).toBe(false);
  });
});

describe("planner is pure", () => {
  it("does not mutate its inputs", () => {
    const rows = [v()];
    const before = JSON.stringify(rows);
    planNextVersion(rows, { factKey: KEY, changeKind: "changed", taxYear: 2025, confirmedAt: T1, valueText: "mfs", reason: "Filing separately" });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
