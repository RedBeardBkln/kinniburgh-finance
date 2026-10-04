import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  applyOverrides,
  checkLineOverrideAgainstBase,
  DECISION_KEYS,
  DECISION_REGISTRY,
  decisionsFromOverrides,
  formatDollars,
  formatOverrideDate,
  formatOverrideNote,
  isAckableStatus,
  lineSnapshot,
  OVERRIDE_MAX_ABS_CENTS,
  parseOverrideRow,
  ruleSnapshot,
  selectActiveOverrides,
  validateLineOverrideCents,
  type ComputedSnapshot,
  type OverrideRow,
} from "@/lib/tax2025/overrides";
import { downstreamOf, LINE_FLOW } from "@/lib/tax2025/line-flow";
import {
  LINE_KEYS,
  type Headline,
  type HeadlineAmount,
  type LineKey,
  type OpenItem,
  type ReturnLine,
  type RuleDecision,
  type RuleResult,
  type RuleStatus,
  type Ty2025Return,
} from "@/lib/tax2025/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function line(key: LineKey, amount: number | null, status: RuleStatus = "computed", extra: Partial<ReturnLine> = {}): ReturnLine {
  const [prefix = "", id = ""] = key.split(".");
  return {
    key,
    form: prefix === "f1040" ? "Form 1040" : prefix === "sch1" ? "Schedule 1" : prefix === "se" ? "Schedule SE" : prefix,
    formLine: id,
    label: `Label of ${key}`,
    status,
    amount,
    exact: amount === null ? null : String(amount),
    reason: null,
    ruleId: "rule-x",
    citations: [],
    refs: [],
    ...extra,
  };
}

const HA = (status: RuleStatus = "computed", amount: number | null = 0): HeadlineAmount => ({ status, amount, reason: null });

function headline(blockingItemCount: number, complete = false): Headline {
  return {
    complete,
    federal: { agi: HA(), taxableIncome: HA(), totalTax: HA(), totalPayments: HA(), balance: HA() },
    connecticut: { ctAgi: HA(), tax: HA(), totalPayments: HA(), balance: HA() },
    blockingItemCount,
    unverifiedDocumentCount: 0,
    derivedInputCount: 0,
    undecidedDecisionCount: 0,
    caveats: [],
    provisional: null,
  };
}

function rule(ruleId: string, status: RuleStatus, keys: LineKey[]): RuleResult {
  return {
    ruleId,
    form: "Form X",
    status,
    lines: keys.map((k) => ({ key: k, label: k, formLine: k, amount: new Decimal(1) })),
    reasons: [],
    citations: [],
    inputsUsed: [],
    inputsMissing: [],
  };
}

function item(id: string, severity: OpenItem["severity"], lineKeys: LineKey[] = []): OpenItem {
  return { id, severity, message: `msg ${id}`, action: "do it", lineKeys, refs: [] };
}

function decisions(): RuleDecision[] {
  return [
    { id: "X1", label: "Home office", chosen: "simplified", status: "default_undecided" },
    { id: "X3", label: "QBI form", chosen: "8995", status: "default_undecided" },
  ];
}

function baseReturn(over: Partial<Ty2025Return> = {}): Ty2025Return {
  const lines: Partial<Record<LineKey, ReturnLine>> = {
    "sch1.3": line("sch1.3", 12345),
    "sch1.10": line("sch1.10", 12345),
    "f1040.8": line("f1040.8", 12345),
    "f1040.9": line("f1040.9", 90000),
    "f1040.11a": line("f1040.11a", 80000),
    "sch1.13": line("sch1.13", null, "missing_input"),
    "scha.17": line("scha.17", null, "needs_cpa_judgment"),
    "f1040.37": line("f1040.37", null, "not_yet_computed"),
    "sch3.1": line("sch3.1", 0, "not_applicable"),
  };
  return {
    engineVersion: "test-v1",
    taxYear: 2025,
    filingStatus: "mfj",
    lines,
    results: [rule("schedule-a", "needs_cpa_judgment", ["scha.17"]), rule("hsa", "missing_input", ["sch1.13"]), rule("tax-calc", "computed", ["f1040.9"])],
    conflicts: [],
    openItems: [
      item("schedule-a:judgment", "blocking", ["scha.17"]),
      item("hsa-missing", "blocking", ["sch1.13"]),
      item("multi", "blocking", ["scha.17", "sch1.13"]),
      item("no-lines", "blocking"),
      item("adv", "advisory", ["scha.17"]),
    ],
    decisions: decisions(),
    headline: headline(4),
    citations: [],
    scheduleC: null,
    scheduleD: null,
    formsRequired: {},
    attestations: {
      digitalAssets: { value: false, status: "answered", where: "Form 1040 page 1, digital assets question", refs: [] },
      foreignAccounts: { value: false, status: "answered", where: "Schedule B Part III, foreign accounts and trusts", refs: [] },
    },
    ...over,
  };
}

let rowSeq = 0;
function row(over: Partial<OverrideRow> & Pick<OverrideRow, "targetKind" | "targetKey">): OverrideRow {
  rowSeq += 1;
  const isLine = over.targetKind === "line";
  const isDecision = over.targetKind === "decision";
  return {
    id: `00000000-0000-4000-8000-${String(rowSeq).padStart(12, "0")}`,
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

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ── Line pins ─────────────────────────────────────────────────────────────────

describe("applyOverrides: line pin", () => {
  it("shows the override as effective, keeps the base value, and never mutates the (frozen) input", () => {
    const base = deepFreeze(baseReturn());
    const rows = deepFreeze([row({ targetKind: "line", targetKey: "sch1.3" })]);
    const eff = applyOverrides(base, rows);

    const l = eff.lines["sch1.3"];
    expect(l?.effective).toEqual({ amount: 13000, status: "overridden" });
    expect(l?.base.amount).toBe(12345);
    expect(l?.base.status).toBe("computed");
    expect(l?.override?.was).toEqual({ status: "computed", amount: 12345 });
    expect(l?.override?.nowAmount).toBe(13000);
    expect(l?.stale).toBeUndefined();
    // untouched lines are mirrored
    expect(eff.lines["f1040.9"]?.effective).toEqual({ amount: 90000, status: "computed" });
    // the engine result is untouched and `results` is never carried over
    expect(base.lines["sch1.3"]?.amount).toBe(12345);
    expect("results" in eff).toBe(false);
    // the output does not alias the input
    expect(eff.lines["sch1.3"]?.base).not.toBe(base.lines["sch1.3"]);
    expect(eff.openItems).not.toBe(base.openItems);
    expect(eff.totalsNotRecomputed).toBe(true);
  });

  it("without overrides the effective view equals the base and totals are not flagged", () => {
    const base = baseReturn();
    const eff = applyOverrides(base, []);
    expect(eff.totalsNotRecomputed).toBe(false);
    expect(eff.openItems).toEqual(base.openItems);
    expect(eff.headline).toEqual(base.headline);
    expect(eff.stale).toEqual([]);
    for (const [k, l] of Object.entries(base.lines)) {
      expect(eff.lines[k as LineKey]?.effective).toEqual({ amount: l?.amount, status: l?.status });
    }
  });

  it("can pin a line that is missing / not yet computed / not applicable, displayed 'was: <status>'", () => {
    const rows = [
      row({ targetKind: "line", targetKey: "sch1.13", computedSnapshot: { status: "missing_input", cents: null } }),
      row({ targetKind: "line", targetKey: "f1040.37", computedSnapshot: { status: "not_yet_computed", cents: null } }),
      row({ targetKind: "line", targetKey: "sch3.1", valueCents: 50_000, computedSnapshot: { status: "not_applicable", cents: 0 } }),
    ];
    const eff = applyOverrides(baseReturn(), rows);
    expect(eff.lines["sch1.13"]?.effective.status).toBe("overridden");
    expect(eff.stale).toEqual([]);
    expect(eff.applied.lines.map((l) => l.wasBlocked).sort()).toEqual([false, true, true]);
    const notes = eff.applied.lines.map(formatOverrideNote);
    expect(notes.some((n) => n.includes("was missing input, now $13,000"))).toBe(true);
    expect(notes.some((n) => n.includes("was not yet computed"))).toBe(true);
    expect(notes.some((n) => n.includes("was not applicable, now $500"))).toBe(true);
  });

  it("copies the headline and leaves its totals alone (only the blocking count adjusts)", () => {
    const base = deepFreeze(baseReturn());
    const eff = applyOverrides(base, [row({ targetKind: "line", targetKey: "sch1.3" })]);
    expect(eff.headline).not.toBe(base.headline);
    expect(eff.headline.federal).toEqual(base.headline.federal);
    expect(eff.headline.blockingItemCount).toBe(4);
  });
});

// ── Stale ─────────────────────────────────────────────────────────────────────

describe("applyOverrides: stale detection", () => {
  it("flags a changed computed value, still applies the override, and raises a blocking item", () => {
    const base = baseReturn();
    const rows = [row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: { status: "computed", cents: 1_000_000 } })];
    const eff = applyOverrides(base, rows);
    expect(eff.lines["sch1.3"]?.effective).toEqual({ amount: 13000, status: "overridden" });
    expect(eff.lines["sch1.3"]?.stale).toMatchObject({ was: "$10,000", now: "$12,345" });
    expect(eff.stale).toHaveLength(1);
    const blocking = eff.openItems.find((i) => i.id === "override-stale:line:sch1.3");
    expect(blocking?.severity).toBe("blocking");
    expect(blocking?.message).toBe(
      "Override on Schedule 1 line 3 may be out of date: computed value changed from $10,000 to $12,345 after it was set. Re-confirm or clear."
    );
    expect(eff.headline.blockingItemCount).toBe(5);
  });

  it("flags a changed status (computed -> missing)", () => {
    const base = baseReturn();
    base.lines["sch1.3"] = line("sch1.3", null, "missing_input");
    const eff = applyOverrides(base, [row({ targetKind: "line", targetKey: "sch1.3" })]);
    expect(eff.lines["sch1.3"]?.stale).toMatchObject({ was: "$12,345", now: "missing input" });
  });

  it("an engine-version change ALONE (value unchanged) is an advisory item, never a blocking stale (D3)", () => {
    const snap = (engineVersion?: string): ComputedSnapshot =>
      engineVersion === undefined ? { status: "computed", cents: 1_234_500 } : { status: "computed", cents: 1_234_500, engineVersion };
    const base = baseReturn(); // engineVersion "test-v1"
    const changed = applyOverrides(base, [row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: snap("v0") })]);
    expect(changed.lines["sch1.3"]?.stale).toBeUndefined();
    expect(changed.lines["sch1.3"]?.effective).toEqual({ amount: 13000, status: "overridden" });
    expect(changed.stale).toEqual([]);
    expect(changed.engineChanged).toHaveLength(1);
    expect(changed.engineChanged[0]).toMatchObject({ targetKey: "sch1.3", was: "engine v0", now: "engine test-v1" });
    const adv = changed.openItems.find((i) => i.id === "override-engine:line:sch1.3");
    expect(adv?.severity).toBe("advisory");
    expect(changed.headline.blockingItemCount).toBe(base.headline.blockingItemCount); // blocking count unchanged
    // same version, unknown snapshot version, and an explicit option all behave
    expect(applyOverrides(base, [row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: snap("test-v1") })]).engineChanged).toEqual([]);
    expect(applyOverrides(base, [row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: snap() })]).engineChanged).toEqual([]);
    expect(applyOverrides(base, [row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: snap("v0") })], { engineVersion: "v0" }).engineChanged).toEqual([]);
  });

  it("a changed base value is blocking +1 even when the engine version also changed", () => {
    const base = baseReturn();
    const eff = applyOverrides(base, [
      row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: { status: "computed", cents: 1_000_000, engineVersion: "v0" } }),
    ]);
    expect(eff.stale).toHaveLength(1);
    expect(eff.engineChanged).toEqual([]); // the value change is the (blocking) finding
    expect(eff.headline.blockingItemCount).toBe(base.headline.blockingItemCount + 1);
  });

  it("lineSnapshot / ruleSnapshot produce what the stale check compares", () => {
    expect(lineSnapshot(line("sch1.3", 12345))).toEqual({ status: "computed", cents: 1_234_500 });
    expect(lineSnapshot(line("sch1.3", null, "missing_input"), "v9")).toEqual({ status: "missing_input", cents: null, engineVersion: "v9" });
    expect(ruleSnapshot("needs_cpa_judgment")).toEqual({ status: "needs_cpa_judgment", cents: null });
  });
});

// ── Orphans, invalid rows, races ─────────────────────────────────────────────

describe("applyOverrides: orphans, invalid rows and conflicts", () => {
  it("lists (does not apply) an override whose line no longer exists", () => {
    const eff = applyOverrides(baseReturn(), [row({ targetKind: "line", targetKey: "sch1.20" })]);
    expect(eff.orphans).toHaveLength(1);
    expect(eff.orphans[0]?.targetKey).toBe("sch1.20");
    expect(eff.applied.lines).toEqual([]);
    expect(eff.openItems.find((i) => i.id === "override-orphan:line:sch1.20")?.severity).toBe("advisory");
  });

  it("an unreadable row is reported as a BLOCKING item and never applied", () => {
    const bad = row({ targetKind: "line", targetKey: "sch1.3", valueCents: 1_300_050 });
    const eff = applyOverrides(baseReturn(), [bad]);
    expect(eff.invalid).toHaveLength(1);
    expect(eff.lines["sch1.3"]?.effective.status).toBe("computed");
    const blocking = eff.openItems.find((i) => i.id === `override-invalid:${bad.id}`);
    expect(blocking?.severity).toBe("blocking");
    expect(eff.headline.blockingItemCount).toBe(5);
    expect(parseOverrideRow(row({ targetKind: "bogus", targetKey: "x" })).ok).toBe(false);
    expect(parseOverrideRow(row({ targetKind: "line", targetKey: "sch1.3", authority: "stranger" })).ok).toBe(false);
    expect(parseOverrideRow(row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: { nope: 1 } })).ok).toBe(false);
    expect(parseOverrideRow(row({ targetKind: "decision", targetKey: "qbiForm", valueText: null })).ok).toBe(false);
  });

  it("two active rows for one target (a race): the highest version wins and an advisory item is raised", () => {
    const v1 = row({ targetKind: "line", targetKey: "sch1.3", version: 1, valueCents: 1_300_000 });
    const v2 = row({ targetKind: "line", targetKey: "sch1.3", version: 2, valueCents: 1_400_000 });
    const sel = selectActiveOverrides([v1, v2]);
    expect(sel.active).toHaveLength(1);
    expect(sel.anomalies[0]?.ids).toEqual([v2.id, v1.id]);
    const eff = applyOverrides(baseReturn(), [v1, v2]);
    expect(eff.lines["sch1.3"]?.effective.amount).toBe(14000);
    expect(eff.applied.lines[0]?.version).toBe(2);
    expect(eff.openItems.find((i) => i.id === "override-conflict:line:sch1.3")?.severity).toBe("advisory");
  });

  it("archived rows are ignored", () => {
    const archived = row({ targetKind: "line", targetKey: "sch1.3", archivedAt: new Date("2026-10-13T00:00:00Z") });
    const eff = applyOverrides(baseReturn(), [archived]);
    expect(eff.applied.lines).toEqual([]);
    expect(eff.lines["sch1.3"]?.effective.status).toBe("computed");
  });
});

// ── Downstream flags ──────────────────────────────────────────────────────────

describe("applyOverrides: downstream (LINE_FLOW) flags", () => {
  it("flags existing downstream lines as dependent on the overridden line, and raises one advisory item", () => {
    const eff = applyOverrides(baseReturn(), [row({ targetKind: "line", targetKey: "sch1.3" })]);
    expect(eff.lines["sch1.10"]?.dependsOnOverridden).toEqual(["sch1.3"]);
    expect(eff.lines["f1040.8"]?.dependsOnOverridden).toEqual(["sch1.3"]);
    expect(eff.lines["f1040.9"]?.dependsOnOverridden).toEqual(["sch1.3"]);
    expect(eff.lines["f1040.11a"]?.dependsOnOverridden).toEqual(["sch1.3"]);
    // AGI drives the SALT cap, so Schedule A line 17 is (transitively) downstream too; so is the amount owed
    expect(eff.lines["scha.17"]?.dependsOnOverridden).toEqual(["sch1.3"]);
    expect(eff.lines["f1040.37"]?.dependsOnOverridden).toEqual(["sch1.3"]);
    // not downstream, and the overridden line itself is not a dependent
    expect(eff.lines["sch1.13"]?.dependsOnOverridden).toBeUndefined();
    expect(eff.lines["sch1.3"]?.dependsOnOverridden).toBeUndefined();
    const adv = eff.openItems.find((i) => i.id === "override-downstream:sch1.3");
    expect(adv?.severity).toBe("advisory");
    expect(adv?.lineKeys).toEqual(["f1040.11a", "f1040.37", "f1040.8", "f1040.9", "sch1.10", "scha.17"]);
    expect(adv?.message).toContain("NOT recomputed");
  });

  it("merges dependents of two overridden lines", () => {
    const eff = applyOverrides(baseReturn(), [
      row({ targetKind: "line", targetKey: "sch1.3" }),
      row({ targetKind: "line", targetKey: "sch1.13", computedSnapshot: { status: "missing_input", cents: null } }),
    ]);
    expect(eff.lines["f1040.11a"]?.dependsOnOverridden).toEqual(["sch1.13", "sch1.3"]);
  });

  it("LINE_FLOW: every key is a real LineKey, no self edges, Schedule C expense lines feed line 28, walk is cycle-safe (full guard in tax2025-line-flow.test.ts)", () => {
    const known = new Set<string>(LINE_KEYS);
    for (const [from, tos] of Object.entries(LINE_FLOW)) {
      expect(known.has(from), `source ${from}`).toBe(true);
      for (const to of tos ?? []) {
        expect(known.has(to), `${from} -> ${to}`).toBe(true);
        expect(to).not.toBe(from);
      }
    }
    expect(LINE_FLOW["schc.18"]).toEqual(["schc.28"]);
    expect(LINE_FLOW["schc.30"]).toEqual(["schc.31"]);
    expect(downstreamOf("schc.18")).toEqual(expect.arrayContaining(["schc.28", "schc.29", "schc.31", "sch1.3", "f1040.8", "f1040.9", "f1040.37"]));
    expect(downstreamOf("se.13")).toEqual(expect.arrayContaining(["sch1.15", "sch1.26", "f1040.10", "f1040.11a"]));
    const cyclic = { "f1040.8": ["f1040.9"], "f1040.9": ["f1040.8"] } as const;
    expect(downstreamOf("f1040.8", cyclic).sort()).toEqual(["f1040.9"]);
  });
});

// ── Rule acknowledgements ────────────────────────────────────────────────────

describe("applyOverrides: rule_ack", () => {
  const ack = (ruleId: string, status: ComputedSnapshot["status"]) =>
    row({ targetKind: "rule_ack", targetKey: ruleId, computedSnapshot: { status, cents: null } });

  it("moves the rule's blocking items out of blocking into the acknowledged list; numbers do not change", () => {
    const base = baseReturn();
    const eff = applyOverrides(base, [ack("schedule-a", "needs_cpa_judgment")]);
    const ids = eff.openItems.map((i) => i.id);
    // matched by id prefix and by "all lines belong to the rule"
    expect(ids).not.toContain("schedule-a:judgment");
    // an advisory item stays; an item spanning other rules' lines stays blocking; an item with no lines stays blocking
    expect(ids).toEqual(expect.arrayContaining(["hsa-missing", "multi", "no-lines", "adv"]));
    expect(eff.acknowledged).toHaveLength(1);
    expect(eff.acknowledged[0]?.items.map((i) => i.id)).toEqual(["schedule-a:judgment"]);
    expect(eff.headline.blockingItemCount).toBe(3);
    expect(eff.lines["scha.17"]?.effective).toEqual({ amount: null, status: "needs_cpa_judgment" });
    expect(eff.totalsNotRecomputed).toBe(false);
    expect(formatOverrideNote(eff.applied.acks[0]!)).toContain("CPA acknowledged rule schedule-a");
  });

  it("is stale (and un-blocks nothing) when the rule's status changed after it was recorded", () => {
    const eff = applyOverrides(baseReturn(), [ack("schedule-a", "missing_input")]);
    expect(eff.stale).toHaveLength(1);
    expect(eff.acknowledged).toEqual([]);
    expect(eff.openItems.map((i) => i.id)).toContain("schedule-a:judgment");
    expect(eff.headline.blockingItemCount).toBe(5);
  });

  it("is an orphan when the rule vanished, and a computed rule is not ackable", () => {
    const eff = applyOverrides(baseReturn(), [ack("gone-rule", "missing_input")]);
    expect(eff.orphans).toHaveLength(1);
    expect(isAckableStatus("computed")).toBe(false);
    expect(isAckableStatus("not_applicable")).toBe(false);
    expect(isAckableStatus("not_yet_computed")).toBe(false);
    expect(isAckableStatus("needs_cpa_rule_unverified")).toBe(true);
    expect(isAckableStatus("needs_cpa_judgment")).toBe(true);
    expect(isAckableStatus("missing_input")).toBe(true);
  });
});

// ── Decisions ─────────────────────────────────────────────────────────────────

describe("decisions", () => {
  it("decisionsFromOverrides feeds only active decision rows, as { chosen, by, at }", () => {
    const d = decisionsFromOverrides([
      row({ targetKind: "decision", targetKey: "homeOfficeMethod", valueText: "actual" }),
      row({ targetKind: "decision", targetKey: "qbiForm", valueText: "8995a", archivedAt: new Date() }),
      row({ targetKind: "line", targetKey: "sch1.3" }),
    ]);
    expect(d).toEqual({ homeOfficeMethod: { chosen: "actual", by: "Eric Kinniburgh", at: "2026-10-12T02:30:00.000Z" } });
  });

  it("no rows -> no decisions (the engine falls back to its conservative default)", () => {
    expect(decisionsFromOverrides([])).toEqual({});
  });

  it("ignores a choice that is not in the registry and an unknown decision key", () => {
    const d = decisionsFromOverrides([
      row({ targetKind: "decision", targetKey: "homeOfficeMethod", valueText: "weird" }),
      row({ targetKind: "decision", targetKey: "nonsense", valueText: "actual" }),
    ]);
    expect(d).toEqual({});
  });

  it("covers all four engine decisions and keeps the highest version", () => {
    expect([...DECISION_KEYS].sort()).toEqual(["arborRoadPropertyTax", "depreciationElection", "homeOfficeMethod", "qbiForm"]);
    expect(DECISION_REGISTRY.qbiForm.decisionId).toBe("X3");
    const d = decisionsFromOverrides([
      row({ targetKind: "decision", targetKey: "depreciationElection", valueText: "bonus", version: 1 }),
      row({ targetKind: "decision", targetKey: "depreciationElection", valueText: "section_179", version: 2 }),
    ]);
    expect(d.depreciationElection?.chosen).toBe("section_179");
  });

  it("applyOverrides attaches the decision override when the base reflects it, and says so when it does not", () => {
    const reflected = baseReturn({
      decisions: [
        { id: "X1", label: "Home office", chosen: "actual", status: "decided", decidedBy: "Eric Kinniburgh", decidedAt: "2026-10-12T02:30:00.000Z" },
        { id: "X3", label: "QBI form", chosen: "8995", status: "default_undecided" },
      ],
    });
    const rows = [row({ targetKind: "decision", targetKey: "homeOfficeMethod", valueText: "actual" })];
    const ok = applyOverrides(reflected, rows);
    expect(ok.decisions[0]?.override?.choice).toBe("actual");
    expect(ok.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
    expect(formatOverrideNote(ok.applied.decisions[0]!)).toContain("Home office method (EK Consulting) set to actual");

    // the base was computed WITHOUT feeding the decision: not silently accepted
    const notFed = applyOverrides(baseReturn(), rows);
    const item = notFed.openItems.find((i) => i.id === "override-decision-not-reflected:homeOfficeMethod");
    expect(item?.severity).toBe("blocking");

    const orphan = applyOverrides(baseReturn({ decisions: [] }), rows);
    expect(orphan.orphans).toHaveLength(1);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("override value validation", () => {
  it("accepts whole dollars (including negative and zero) within the bound", () => {
    expect(validateLineOverrideCents(0).ok).toBe(true);
    expect(validateLineOverrideCents(1_300_000).ok).toBe(true);
    expect(validateLineOverrideCents(-50_000).ok).toBe(true);
    expect(validateLineOverrideCents(OVERRIDE_MAX_ABS_CENTS).ok).toBe(true);
    expect(OVERRIDE_MAX_ABS_CENTS).toBe(2_100_000_000);
  });

  it("rejects cents, non-integers and values past $21,000,000", () => {
    expect(validateLineOverrideCents(1_300_050).ok).toBe(false);
    expect(validateLineOverrideCents(1.5).ok).toBe(false);
    expect(validateLineOverrideCents(Number.NaN).ok).toBe(false);
    expect(validateLineOverrideCents(OVERRIDE_MAX_ABS_CENTS + 100).ok).toBe(false);
    expect(validateLineOverrideCents(-(OVERRIDE_MAX_ABS_CENTS + 100)).ok).toBe(false);
  });

  it("rejects a value equal to the computed one and a line the engine does not emit", () => {
    const sch1 = line("sch1.3", 12345);
    const equal = checkLineOverrideAgainstBase(1_234_500, sch1);
    expect(equal).toEqual({ ok: false, error: "No change: the override equals the computed value." });
    expect(checkLineOverrideAgainstBase(1_300_000, sch1)).toEqual({ ok: true });
    expect(checkLineOverrideAgainstBase(1_300_000, undefined).ok).toBe(false);
    // not applicable shows 0: an override of 0 is no change, anything else is allowed
    const na = line("sch3.1", 0, "not_applicable");
    expect(checkLineOverrideAgainstBase(0, na).ok).toBe(false);
    expect(checkLineOverrideAgainstBase(10_000, na).ok).toBe(true);
    // a missing line has no computed value to equal
    expect(checkLineOverrideAgainstBase(0, line("sch1.13", null, "missing_input")).ok).toBe(true);
  });
});

// ── Note formatting ──────────────────────────────────────────────────────────

describe("formatOverrideNote", () => {
  it("matches the documented wording, with the date in America/New_York", () => {
    const eff = applyOverrides(baseReturn(), [
      row({ targetKind: "line", targetKey: "sch1.3", reason: "Per CPA call", setAt: new Date("2026-10-12T02:30:00Z") }),
    ]);
    // 02:30Z on Oct 12 is 22:30 on Oct 11 in New York (EDT, UTC-4)
    expect(formatOverrideNote(eff.applied.lines[0]!)).toBe(
      "CPA override: was $12,345 computed, now $13,000, by Eric Kinniburgh (per CPA) on 2026-10-11, reason: Per CPA call"
    );
  });

  it("labels an owner-authority override as such and handles negative dollars", () => {
    const eff = applyOverrides(baseReturn(), [
      row({ targetKind: "line", targetKey: "sch1.3", authority: "owner", valueCents: -50_000 }),
    ]);
    expect(formatOverrideNote(eff.applied.lines[0]!)).toContain("Owner override: was $12,345 computed, now -$500, by Eric Kinniburgh (owner)");
  });

  it("formatOverrideDate: winter (EST) and an unparseable value", () => {
    expect(formatOverrideDate("2026-01-15T04:30:00.000Z")).toBe("2026-01-14");
    expect(formatOverrideDate("2026-07-04T12:00:00.000Z")).toBe("2026-07-04");
    expect(formatOverrideDate("not a date")).toBe("not a date");
    expect(formatDollars(1234567)).toBe("$1,234,567");
  });
});
