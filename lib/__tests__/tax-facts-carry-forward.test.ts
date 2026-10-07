import { describe, it, expect } from "vitest";
import { latestAsOfYear, resolveCarryForward, type CarryRow } from "@/lib/tax-facts/carry-forward";
import { groupFacts } from "@/lib/tax-facts/group";
import type { CarryPolicy, ChangeKind, FactValueKind, TaxFactRow } from "@/lib/tax-facts/types";
import { carriedFromLabel, confirmedLabel, confirmationWord, datedLabel, formatFactValue, provenanceLabel } from "@/lib/tax-facts/format";

const T = new Date("2026-10-07T16:00:00.000Z");

const row = (over: Partial<CarryRow> = {}): CarryRow => ({
  factKey: "household.filing_status",
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
  confirmedAt: T,
  ...over,
});

const keysOf = (items: { factKey: string }[]) => items.map((i) => i.factKey);

describe("policy x target year", () => {
  const cases: Array<[CarryPolicy, "carried" | "needsReconfirmation" | "askFresh"]> = [
    ["stable", "carried"],
    ["reconfirm", "needsReconfirmation"],
    ["derived", "needsReconfirmation"],
    ["year_specific", "askFresh"],
  ];
  it.each(cases)("%s fact from TY2025 lands in %s for TY2026", (carryPolicy, bucket) => {
    const r = resolveCarryForward([row({ carryPolicy })], 2026);
    for (const b of ["carried", "needsReconfirmation", "askFresh", "openItems", "alreadyConfirmedForYear"] as const) {
      expect(r[b].length).toBe(b === bucket ? 1 : 0);
    }
    const item = r[bucket][0]!;
    expect(item.fromTaxYear).toBe(2025);
    expect(item.fromVersion).toBe(1);
    expect(item.carriedLabel).toContain("TY2025");
    expect(item.provenanceLabel).toContain("TY2025");
  });

  it.each(["stable", "reconfirm", "derived", "year_specific"] as CarryPolicy[])(
    "%s fact established for the target year itself is already confirmed for the year",
    (carryPolicy) => {
      const r = resolveCarryForward([row({ carryPolicy, taxYear: 2026 })], 2026);
      expect(r.alreadyConfirmedForYear).toHaveLength(1);
      expect(r.carried.length + r.needsReconfirmation.length + r.askFresh.length + r.openItems.length).toBe(0);
    }
  );

  it.each(["stable", "reconfirm", "derived", "year_specific"] as CarryPolicy[])(
    "%s fact established for a LATER year is ignored for an earlier target",
    (carryPolicy) => {
      const r = resolveCarryForward([row({ carryPolicy, taxYear: 2026 })], 2025);
      expect(Object.values(r).flat().filter((x) => typeof x === "object")).toHaveLength(0);
    }
  );

  it("an earlier-year target sees an earlier version (as-of recall after a later version exists)", () => {
    const rows = [row({ version: 1, taxYear: 2025, valueText: "mfj" }), row({ version: 2, taxYear: 2026, valueText: "mfs", changeKind: "changed" })];
    const r2025 = resolveCarryForward(rows, 2025);
    expect(r2025.alreadyConfirmedForYear[0]?.valueText).toBe("mfj");
    const r2026 = resolveCarryForward(rows, 2026);
    expect(r2026.alreadyConfirmedForYear[0]?.valueText).toBe("mfs");
    expect(latestAsOfYear(rows, 2025).get("household.filing_status")?.valueText).toBe("mfj");
  });
});

describe("open items", () => {
  const open = (over: Partial<CarryRow> = {}) =>
    row({ factKey: "open.thing", category: "open_item", valueKind: "open_item", valueText: "Question", carryPolicy: "stable", ...over });

  it("always carry, never in carried", () => {
    for (const target of [2026, 2027, 2030]) {
      const r = resolveCarryForward([open()], target);
      expect(keysOf(r.openItems)).toEqual(["open.thing"]);
      expect(r.carried).toHaveLength(0);
    }
  });
  it("stay open even when recorded for the target year itself", () => {
    const r = resolveCarryForward([open({ taxYear: 2026 })], 2026);
    expect(r.openItems).toHaveLength(1);
    expect(r.alreadyConfirmedForYear).toHaveLength(0);
  });
  it("a resolved item is absent from then on, but still visible before", () => {
    const rows = [open(), open({ version: 2, taxYear: 2026, changeKind: "resolved" })];
    expect(resolveCarryForward(rows, 2026).openItems).toHaveLength(0);
    expect(resolveCarryForward(rows, 2027).openItems).toHaveLength(0);
    expect(resolveCarryForward(rows, 2025).openItems).toHaveLength(1);
  });
});

describe("retired", () => {
  it("is absent for the retirement year and later, present before", () => {
    const rows = [row({ carryPolicy: "stable" }), row({ version: 2, taxYear: 2027, changeKind: "retired", carryPolicy: "stable" })];
    expect(resolveCarryForward(rows, 2026).carried).toHaveLength(1);
    expect(resolveCarryForward(rows, 2027).carried).toHaveLength(0);
    expect(resolveCarryForward(rows, 2028).carried).toHaveLength(0);
  });
  it("a re-established key carries again", () => {
    const rows = [
      row({ carryPolicy: "stable" }),
      row({ version: 2, taxYear: 2026, changeKind: "retired", carryPolicy: "stable" }),
      row({ version: 3, taxYear: 2027, changeKind: "established", carryPolicy: "stable" }),
    ];
    expect(resolveCarryForward(rows, 2028).carried).toHaveLength(1);
    expect(resolveCarryForward(rows, 2026).carried).toHaveLength(0);
  });
});

describe("re-confirmation", () => {
  it("a stored reconfirmed version flips the key out of needs-reconfirmation for that year only", () => {
    const rows = [row(), row({ version: 2, taxYear: 2026, changeKind: "reconfirmed" })];
    const r26 = resolveCarryForward(rows, 2026);
    expect(r26.needsReconfirmation).toHaveLength(0);
    expect(r26.alreadyConfirmedForYear[0]?.fromVersion).toBe(2);
    const r27 = resolveCarryForward(rows, 2027);
    expect(r27.needsReconfirmation).toHaveLength(1);
    expect(r27.needsReconfirmation[0]?.fromTaxYear).toBe(2026);
  });
  it("the resolver never marks a carried or suggested fact as confirmed for the target year", () => {
    const r = resolveCarryForward([row({ carryPolicy: "stable" }), row({ factKey: "a.b", carryPolicy: "reconfirm" })], 2026);
    expect(r.alreadyConfirmedForYear).toHaveLength(0);
  });
});

describe("year_specific reference", () => {
  it("is shown for reference only and never as a carried value", () => {
    const r = resolveCarryForward([row({ carryPolicy: "year_specific", valueText: "yes", valueKind: "bool" })], 2026);
    expect(r.askFresh[0]?.referenceOnly).toBe(true);
    expect(r.askFresh[0]?.carriedLabel).toContain("reference only");
    expect(r.carried).toHaveLength(0);
  });
});

describe("nothing is invented", () => {
  it("no rows means no items; an unanswered key is absent, never a zero", () => {
    const r = resolveCarryForward([], 2026);
    expect(Object.values(r).filter(Array.isArray).flat()).toHaveLength(0);
  });
  it("a money value is carried as stored, not recomputed", () => {
    const r = resolveCarryForward([row({ factKey: "retirement.x.basis", category: "retirement", valueKind: "money_cents", valueCents: 1430000, valueText: null, carryPolicy: "derived", sourceKind: "derived" })], 2026);
    const item = r.needsReconfirmation[0]!;
    expect(item.valueCents).toBe(1430000);
    expect(item.carriedLabel).toMatch(/Opening value from the TY2025 closing figure/);
  });
});

describe("ordering and purity", () => {
  it("orders by category then key, deterministically, whatever the input order", () => {
    const rows = [
      row({ factKey: "property.b.use", category: "property" }),
      row({ factKey: "household.z", category: "household" }),
      row({ factKey: "household.a", category: "household" }),
      row({ factKey: "decision.x1.m", category: "decision" }),
    ];
    const a = resolveCarryForward(rows, 2026).needsReconfirmation;
    const b = resolveCarryForward([...rows].reverse(), 2026).needsReconfirmation;
    expect(keysOf(a)).toEqual(["household.a", "household.z", "property.b.use", "decision.x1.m"]);
    expect(keysOf(b)).toEqual(keysOf(a));
  });
  it("never mutates its input", () => {
    const rows = [row(), row({ version: 2, taxYear: 2026, changeKind: "changed", valueText: "mfs" })];
    const before = JSON.stringify(rows);
    resolveCarryForward(rows, 2027);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("wording", () => {
  it("always names the year a carried value came from", () => {
    expect(carriedFromLabel({ taxYear: 2025, version: 3, carryPolicy: "stable" }, 2026)).toBe("From TY2025 (v3), for TY2026");
    expect(confirmedLabel({ confirmedAt: T, taxYear: 2025, version: 1 })).toBe("confirmed 2026-10-07 for TY2025 (v1)");
  });
  it("calls an owner statement not verified by documents, and says nothing about review or certification", () => {
    const text = provenanceLabel({ sourceKind: "owner_statement", valueKind: "choice", changeKind: "established", confirmedAt: T, taxYear: 2025, version: 1 });
    expect(text).toContain("not verified by documents");
    expect(text).toContain("confirmed 2026-10-07 for TY2025 (v1)");
    expect(text).not.toMatch(/CPA|certif|review|approved|verified by (?:the app|AI)/i);
  });
  it("never says an open item, a retired version or a resolved version was confirmed", () => {
    const base = { sourceKind: "owner_statement" as const, confirmedAt: T, taxYear: 2025, version: 1 };
    const open = provenanceLabel({ ...base, valueKind: "open_item", changeKind: "established" });
    expect(open).toContain("Recorded 2026-10-07 for TY2025 (v1)");
    expect(open).not.toMatch(/confirmed/i);
    const retired = provenanceLabel({ ...base, valueKind: "text", changeKind: "retired", taxYear: 2026, version: 2 });
    expect(retired).toContain("Retired 2026-10-07 from TY2026 (v2)");
    expect(retired).not.toMatch(/confirmed/i);
    const resolved = provenanceLabel({ ...base, valueKind: "open_item", changeKind: "resolved", taxYear: 2026, version: 2 });
    expect(resolved).toContain("Resolved 2026-10-07 from TY2026 (v2)");
    expect(resolved).not.toMatch(/confirmed/i);
    // a re-confirmed or changed fact still reads "confirmed"
    for (const changeKind of ["reconfirmed", "changed", "policy_changed"] as const) {
      expect(datedLabel({ ...base, valueKind: "text", changeKind })).toMatch(/^confirmed /);
    }
    expect(confirmationWord({ valueKind: "open_item", changeKind: "established" })).toBe("recorded");
    expect(confirmationWord({ valueKind: "text", changeKind: "retired" })).toBe("recorded");
    expect(confirmationWord({ valueKind: "text", changeKind: "established" })).toBe("confirmed");
  });
  it("the carry resolver's open item inherits the neutral label", () => {
    const r = resolveCarryForward([row({ factKey: "open.x", category: "open_item", valueKind: "open_item", valueText: "q", carryPolicy: "stable" })], 2026);
    expect(r.openItems).toHaveLength(1);
    expect(r.openItems[0]?.provenanceLabel).toContain("Recorded 2026-10-07 for TY2025 (v1)");
    expect(r.openItems[0]?.provenanceLabel).not.toMatch(/confirmed/i);
  });
  it("formats values without inventing one", () => {
    const base = { valueCents: null, valueText: null };
    expect(formatFactValue({ ...base, valueKind: "money_cents", valueCents: 1430000 })).toBe("$14,300");
    expect(formatFactValue({ ...base, valueKind: "money_cents", valueCents: 189450 })).toBe("$1,894.50");
    expect(formatFactValue({ ...base, valueKind: "percent", valueText: "50" })).toBe("50%");
    expect(formatFactValue({ ...base, valueKind: "bool", valueText: "yes" })).toBe("Yes");
    expect(formatFactValue({ ...base, valueKind: "choice", valueText: "refund_all" })).toBe("refund all");
    expect(formatFactValue({ ...base, valueKind: "text" })).toBe("(no value)");
    expect(formatFactValue({ ...base, valueKind: "money_cents" })).toBe("(no value)");
  });
});

describe("grouping for the page", () => {
  const full = (over: Partial<TaxFactRow>): TaxFactRow => ({
    id: `${over.factKey ?? "k"}-${over.version ?? 1}`,
    factKey: "household.filing_status",
    version: 1,
    category: "household",
    label: "Filing status",
    taxYear: 2025,
    valueKind: "choice" as FactValueKind,
    valueCents: null,
    valueText: "mfj",
    carryPolicy: "reconfirm" as CarryPolicy,
    changeKind: "established" as ChangeKind,
    sourceKind: "owner_statement",
    sourceRef: null,
    reason: null,
    confirmedAt: T,
    setByName: "Eric",
    setAt: T,
    archivedAt: null,
    ...over,
  });
  it("keeps every version in the history, newest first, and puts retired keys in their own visible group", () => {
    const rows = [
      full({ version: 1, archivedAt: T }),
      full({ version: 2, changeKind: "changed", taxYear: 2026 }),
      full({ factKey: "open.q", category: "open_item", valueKind: "open_item", version: 1 }),
      full({ factKey: "open.q", category: "open_item", valueKind: "open_item", version: 2, changeKind: "resolved" }),
    ];
    const g = groupFacts(rows);
    expect(g.active).toHaveLength(1);
    expect(g.active[0]?.groups[0]?.history.map((h) => h.version)).toEqual([2, 1]);
    expect(g.retired.map((r) => r.factKey)).toEqual(["open.q"]);
    expect(g.retired[0]?.history).toHaveLength(2);
  });
});
