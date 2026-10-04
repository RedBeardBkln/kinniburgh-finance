import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  affectedLines,
  applyOverrides,
  authorityLabel,
  checkLineOverrideAgainstBase,
  decisionsFromOverrides,
  formatOverrideNote,
  HEADLINE_ROW_IDS,
  HEADLINE_ROWS,
  lineSnapshot,
  ruleSnapshot,
  type ComputedSnapshot,
  type OverrideRow,
} from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import {
  LINE_KEYS,
  type Headline,
  type HeadlineAmount,
  type LineKey,
  type OpenItem,
  type ReturnLine,
  type RuleResult,
  type RuleStatus,
  type Ty2025Return,
} from "@/lib/tax2025/types";
import { emptyFacts, fullFacts1b } from "./tax2025-fixtures";

// D1-D4 semantics against a REAL computed return (open-item ids are the engine's own:
// rule:<ruleId>, none:<group>, attest:*), plus the pure helpers the sheet and dialog use.

let rowSeq = 0;
function row(over: Partial<OverrideRow> & Pick<OverrideRow, "targetKind" | "targetKey">): OverrideRow {
  rowSeq += 1;
  const isLine = over.targetKind === "line";
  const isDecision = over.targetKind === "decision";
  return {
    id: `00000000-0000-4000-8000-${String(5000 + rowSeq).padStart(12, "0")}`,
    taxYear: 2025,
    version: 1,
    valueKind: isLine ? "money_cents" : isDecision ? "choice" : "ack",
    valueCents: isLine ? 1_300_000 : null,
    valueText: isDecision ? "actual" : null,
    computedSnapshot: { status: "computed", cents: 1_234_500 } satisfies ComputedSnapshot,
    authority: "cpa",
    reason: "CPA said so",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-12T02:30:00Z"),
    archivedAt: null,
    ...over,
  };
}

function realRow(ret: Ty2025Return, key: LineKey, valueCents: number, over: Partial<OverrideRow> = {}): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error(`fixture has no line ${key}`);
  return row({ targetKind: "line", targetKey: key, valueCents, computedSnapshot: lineSnapshot(l, ret.engineVersion), ...over });
}

function line(key: LineKey, amount: number | null, status: RuleStatus = "computed"): ReturnLine {
  const [prefix = "", id = ""] = key.split(".");
  return { key, form: prefix, formLine: id, label: `Label ${key}`, status, amount, exact: null, reason: null, ruleId: "r", citations: [], refs: [] };
}

const HA = (): HeadlineAmount => ({ status: "computed", amount: 0, reason: null });
function headline(blocking: number): Headline {
  return {
    complete: false,
    federal: { agi: HA(), taxableIncome: HA(), totalTax: HA(), totalPayments: HA(), balance: HA() },
    connecticut: { ctAgi: HA(), tax: HA(), totalPayments: HA(), balance: HA() },
    blockingItemCount: blocking,
    unverifiedDocumentCount: 0,
    derivedInputCount: 0,
    undecidedDecisionCount: 0,
    caveats: [],
    provisional: null,
  };
}
function item(id: string, severity: OpenItem["severity"], lineKeys: LineKey[] = []): OpenItem {
  return { id, severity, message: `m ${id}`, action: "a", lineKeys, refs: [] };
}
function rule(ruleId: string, status: RuleStatus, keys: LineKey[]): RuleResult {
  return {
    ruleId,
    form: "F",
    status,
    lines: keys.map((k) => ({ key: k, label: k, formLine: k, amount: new Decimal(1) })),
    reasons: [],
    citations: [],
    inputsUsed: [],
    inputsMissing: [],
  };
}
function smallReturn(over: Partial<Ty2025Return> = {}): Ty2025Return {
  return {
    engineVersion: "test-v1",
    taxYear: 2025,
    filingStatus: "mfj",
    lines: { "sch1.3": line("sch1.3", 12345), "sch1.10": line("sch1.10", 12345), "f1040.11a": line("f1040.11a", 80000), "f1040.37": line("f1040.37", 10) },
    results: [rule("tax", "computed", ["sch1.3"])],
    conflicts: [],
    openItems: [item("x", "blocking")],
    decisions: [{ id: "X3", label: "QBI form", chosen: "8995", status: "default_undecided" }],
    headline: headline(1),
    citations: [],
    scheduleC: null,
    scheduleD: null,
    formsRequired: {},
    attestations: {
      digitalAssets: { value: false, status: "answered", where: "w", refs: [] },
      foreignAccounts: { value: false, status: "answered", where: "w", refs: [] },
    },
    ...over,
  };
}

describe("D2: a value on a blocked line unblocks that line (real engine items)", () => {
  const ret = computeTy2025Return(emptyFacts());
  const baseBlocking = ret.headline.blockingItemCount;

  it("fixture sanity: the engine's own ids are rule:<ruleId> / none:<group> and name the blocked lines", () => {
    const byId = new Map(ret.openItems.map((i) => [i.id, i]));
    expect(byId.get("rule:foreign-tax-credit")?.lineKeys).toEqual(["sch3.1"]);
    expect(byId.get("rule:schedule-d")?.lineKeys).toEqual(["f1040.7a", "qdcg.3"]);
    expect(byId.get("none:solar_credit")?.lineKeys).toEqual(["sch3.5a"]);
    expect(byId.get("attest:digital")?.lineKeys).toEqual([]);
    expect(ret.lines["sch3.1"]?.status).not.toBe("computed");
  });

  it("supplying the ONE line a rule item names resolves it: the line prints, the blocking count drops by one, the item stays visible", () => {
    const eff = applyOverrides(ret, [realRow(ret, "sch3.1", 250_000)]);
    expect(eff.lines["sch3.1"]?.effective).toEqual({ amount: 2500, status: "overridden" });
    expect(eff.lines["sch3.1"]?.override?.wasBlocked).toBe(true);
    expect(eff.resolvedByOverride.map((r) => r.item.id)).toEqual(["rule:foreign-tax-credit"]);
    expect(eff.resolvedByOverride[0]?.overrideIds).toEqual([eff.applied.lines[0]?.id]);
    expect(eff.resolvedByOverride[0]?.notes[0]).toBe(formatOverrideNote(eff.applied.lines[0]!));
    expect(eff.openItems.map((i) => i.id)).not.toContain("rule:foreign-tax-credit");
    expect(eff.headline.blockingItemCount).toBe(baseBlocking - 1);
    expect(eff.openItems.filter((i) => i.severity === "blocking")).toHaveLength(eff.headline.blockingItemCount);
    // the totals are NOT recomputed: the engine's headline amounts are untouched and `complete` stays false
    expect(eff.totalsNotRecomputed).toBe(true);
    expect(eff.headline.federal).toEqual(ret.headline.federal);
    expect(eff.headline.complete).toBe(false);
  });

  it("a rule item stays blocking until EVERY line it names is supplied (partial coverage stays blocking)", () => {
    const partial = applyOverrides(ret, [realRow(ret, "f1040.7a", 0)]);
    expect(partial.resolvedByOverride).toEqual([]);
    expect(partial.openItems.map((i) => i.id)).toContain("rule:schedule-d");
    expect(partial.headline.blockingItemCount).toBe(baseBlocking);
    const both = applyOverrides(ret, [realRow(ret, "f1040.7a", 0), realRow(ret, "qdcg.3", 0)]);
    expect(both.resolvedByOverride.map((r) => r.item.id)).toEqual(["rule:schedule-d"]);
    expect(both.resolvedByOverride[0]?.overrideIds).toHaveLength(2);
    expect(both.headline.blockingItemCount).toBe(baseBlocking - 1);
  });

  it("a none:<group> item resolves the same way; an item with no lines never does", () => {
    const eff = applyOverrides(ret, [realRow(ret, "sch3.5a", 0)]);
    expect(eff.resolvedByOverride.map((r) => r.item.id)).toEqual(["none:solar_credit"]);
    expect(eff.openItems.find((i) => i.id === "attest:digital")?.severity).toBe("blocking");
  });

  it("a STALE pin clears nothing (and adds a blocking stale item)", () => {
    const stale = row({
      targetKind: "line",
      targetKey: "sch3.1",
      valueCents: 250_000,
      computedSnapshot: { status: "computed", cents: 10_000, engineVersion: ret.engineVersion },
    });
    const eff = applyOverrides(ret, [stale]);
    expect(eff.resolvedByOverride).toEqual([]);
    expect(eff.openItems.map((i) => i.id)).toContain("rule:foreign-tax-credit");
    expect(eff.headline.blockingItemCount).toBe(baseBlocking + 1);
  });

  it("a pin on a line that was COMPUTED resolves no blocking item (it was never missing)", () => {
    const full = computeTy2025Return(fullFacts1b());
    const eff = applyOverrides(full, [realRow(full, "sch1.3", 6_000_000)]);
    expect(eff.applied.lines[0]?.wasBlocked).toBe(false);
    expect(eff.resolvedByOverride).toEqual([]);
  });

  it("clearing (no rows) restores the base exactly: no marks, no resolved items, the base blocking count", () => {
    const eff = applyOverrides(ret, []);
    expect(eff.resolvedByOverride).toEqual([]);
    expect(eff.totalsNotRecomputed).toBe(false);
    expect(eff.headline.blockingItemCount).toBe(baseBlocking);
    expect(eff.openItems).toEqual(ret.openItems);
  });

  it("does not mutate a deep-frozen real return", () => {
    const frozen = computeTy2025Return(emptyFacts()); // a fresh one: the shared fixture stays unfrozen
    const deepFreeze = (o: unknown): void => {
      if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
    };
    deepFreeze(frozen);
    expect(() => applyOverrides(frozen, [realRow(ret, "sch3.1", 250_000), realRow(ret, "f1040.7a", 0)])).not.toThrow();
  });
});

describe("rule_ack against the engine's real rule:<ruleId> ids", () => {
  const ret = computeTy2025Return(emptyFacts());
  it("an acknowledgement of foreign-tax-credit moves the real `rule:foreign-tax-credit` item", () => {
    const result = ret.results.find((r) => r.ruleId === "foreign-tax-credit");
    expect(result).toBeDefined();
    const ack = row({
      targetKind: "rule_ack",
      targetKey: "foreign-tax-credit",
      computedSnapshot: ruleSnapshot(result!.status, ret.engineVersion),
    });
    const eff = applyOverrides(ret, [ack]);
    expect(eff.acknowledged.map((a) => a.ruleId)).toEqual(["foreign-tax-credit"]);
    expect(eff.acknowledged[0]?.items.map((i) => i.id)).toEqual(["rule:foreign-tax-credit"]);
    expect(eff.openItems.map((i) => i.id)).not.toContain("rule:foreign-tax-credit");
    expect(eff.headline.blockingItemCount).toBe(ret.headline.blockingItemCount - 1);
    expect(eff.lines["sch3.1"]?.effective).toEqual({ amount: null, status: ret.lines["sch3.1"]?.status });
  });
});

describe("headline rows and `complete` (F8)", () => {
  const full = computeTy2025Return(fullFacts1b());

  it("fixture: the complete return has a complete headline and no marks", () => {
    expect(full.headline.complete).toBe(true);
    const eff = applyOverrides(full, []);
    expect(eff.headline.complete).toBe(true);
    for (const id of HEADLINE_ROW_IDS) expect(eff.headlineRows[id]).toEqual({ overridden: false, dependsOnOverride: false, effectiveAmount: null });
  });

  it("pinning AGI marks the AGI row overridden with its value, marks the downstream rows, and forces complete=false", () => {
    const eff = applyOverrides(full, [realRow(full, "f1040.11a", 18_000_000)]);
    expect(eff.headlineRows["federal.agi"]).toEqual({ overridden: true, dependsOnOverride: false, effectiveAmount: 180_000 });
    expect(eff.headlineRows["federal.taxableIncome"]).toMatchObject({ overridden: false, dependsOnOverride: true, effectiveAmount: null });
    expect(eff.headlineRows["federal.totalTax"].dependsOnOverride).toBe(true);
    expect(eff.headlineRows["connecticut.ctAgi"].dependsOnOverride).toBe(true);
    expect(eff.totalsNotRecomputed).toBe(true);
    expect(eff.headline.complete).toBe(false);
    // the engine's own headline figure is still the engine's (the row state is what tells the reader)
    expect(eff.headline.federal.agi.amount).toBe(full.headline.federal.agi.amount);
  });

  it("the federal balance row combines the effective amounts of line 37 (owe) and line 34 (overpaid)", () => {
    const eff = applyOverrides(full, [realRow(full, "f1040.37", 5_000_000)]);
    const overpaid = full.lines["f1040.34"]?.amount ?? 0;
    expect(eff.headlineRows["federal.balance"]).toEqual({ overridden: true, dependsOnOverride: false, effectiveAmount: 50_000 - overpaid });
  });

  it("every headline row names real lines and there are exactly nine rows", () => {
    expect(HEADLINE_ROW_IDS).toHaveLength(9);
    const known = new Set<string>(LINE_KEYS);
    for (const id of HEADLINE_ROW_IDS) for (const k of HEADLINE_ROWS[id]) expect(known.has(k), `${id}: ${k}`).toBe(true);
  });
});

describe("decisions carry who/when into the engine and the effective view", () => {
  it("decisionsFromOverrides feeds by/at; the effective decision shows them and the override note", () => {
    const rows = [row({ targetKind: "decision", targetKey: "qbiForm", valueText: "8995a" })];
    expect(decisionsFromOverrides(rows).qbiForm).toEqual({ chosen: "8995a", by: "Eric Kinniburgh", at: "2026-10-12T02:30:00.000Z" });
    const base = smallReturn({
      decisions: [{ id: "X3", label: "QBI form", chosen: "8995a", status: "decided", decidedBy: "Eric Kinniburgh", decidedAt: "2026-10-12T02:30:00.000Z" }],
    });
    const eff = applyOverrides(base, rows);
    const x3 = eff.decisions.find((d) => d.id === "X3");
    expect(x3).toMatchObject({ status: "decided", decidedBy: "Eric Kinniburgh", decidedAt: "2026-10-12T02:30:00.000Z" });
    expect(x3?.override?.choice).toBe("8995a");
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
    expect(eff.totalsNotRecomputed).toBe(false);
  });

  it("the 'not reflected' blocker fires when the base was computed without the decision", () => {
    const eff = applyOverrides(smallReturn(), [row({ targetKind: "decision", targetKey: "qbiForm", valueText: "8995a" })]);
    expect(eff.openItems.find((i) => i.id === "override-decision-not-reflected:qbiForm")?.severity).toBe("blocking");
  });

  it("an engine-version change on a decision is advisory only", () => {
    const base = smallReturn({
      decisions: [{ id: "X3", label: "QBI form", chosen: "8995a", status: "decided", decidedBy: "E", decidedAt: "2026-10-12T02:30:00.000Z" }],
    });
    const eff = applyOverrides(base, [
      row({ targetKind: "decision", targetKey: "qbiForm", valueText: "8995a", computedSnapshot: { status: "default_undecided", cents: null, engineVersion: "v0" } }),
    ]);
    expect(eff.stale).toEqual([]);
    expect(eff.engineChanged).toHaveLength(1);
    expect(eff.headline.blockingItemCount).toBe(base.headline.blockingItemCount);
  });
});

describe("affectedLines and labels", () => {
  it("affectedLines lists what a pin does NOT recompute, restricted to lines on the return", () => {
    expect(affectedLines("sch1.3", smallReturn().lines)).toEqual(["f1040.11a", "f1040.37", "sch1.10"]);
  });
  it("authority labels are the plain words used in the UI", () => {
    expect(authorityLabel("cpa")).toBe("Advisor (recorded earlier)");
    expect(authorityLabel("owner")).toBe("Owner (Eric/Eva)");
  });
});

describe("whole-dollar money in the pure layer", () => {
  it("snapshot cents come from Decimal, never Math.round (negative and large values)", () => {
    expect(lineSnapshot(line("sch1.3", -500)).cents).toBe(-50_000);
    expect(lineSnapshot(line("sch1.3", 21_000_000)).cents).toBe(2_100_000_000);
    expect(checkLineOverrideAgainstBase(-50_000, line("sch1.3", -500))).toEqual({ ok: false, error: "No change: the override equals the computed value." });
  });
});
