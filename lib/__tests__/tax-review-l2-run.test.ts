// L2: runL2 as the review runner and the gate use it: fail-closed states, the findings model, the covered / not-covered table, the $1
// tolerance, the "every compared line is live" mutation test, and the gate integration.

import { vi } from "vitest";
vi.setConfig({ testTimeout: 240000 });
import { describe, expect, it } from "vitest";
import { applyOverrides, type OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { LineKey } from "@/lib/tax2025/line-catalog";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { evaluateGate, type DispositionRow, type GateInput } from "@/lib/tax-review/gate";
import { l2SummaryOf, oracleLedger, runL2, type L2Input } from "@/lib/tax-review/l2";
import { findingSchema, type Finding } from "@/lib/tax-review/types";
import { layerStateOf } from "@/lib/tax-review/state";
import { cleanScenario, richScenario } from "./tax-review-harness";
import { emptyFacts } from "./tax2025-fixtures";
import { randomHousehold } from "./tax-review-l2-gen";

function inputOf(facts: L2Input["facts"], decisions = {}): L2Input {
  const ret = computeTy2025Return(facts, decisions);
  return { ret, effective: applyOverrides(ret, []), facts };
}

/** A copy of the return with one engine line moved by `delta` dollars (the effective view is rebuilt from the copy). */
function perturbed(input: L2Input, key: string, delta: number): L2Input {
  const line = input.ret.lines[key as LineKey];
  if (line === undefined || line.amount === null) throw new Error(`no amount on ${key}`);
  const ret: Ty2025Return = { ...input.ret, lines: { ...input.ret.lines, [key]: { ...line, amount: line.amount + delta } } };
  return { ...input, ret, effective: applyOverrides(ret, []) };
}

const nonCoverage = (fs: readonly Finding[]) => fs.filter((f) => f.check !== "L2.coverage");

describe("runL2 fails closed", () => {
  it("without an input (the Phase A call shape) it is not_run: the gate keeps L2 red", () => {
    const r = runL2();
    expect(r.status).toBe("not_run");
    expect(r.findings).toEqual([]);
    expect(r.coverage).toEqual([]);
    expect(l2SummaryOf(r).status).toBe("not_run");
  });

  it("an incomplete return (blocking items, headline not complete) is not recomputed, with the reason", () => {
    const facts = structuredClone(cleanScenario().facts);
    facts.income.w2s[0]!.wagesCents = null; // a W-2 whose box 1 was never read
    const r = runL2(inputOf(facts));
    expect(r.status).toBe("not_run");
    expect(r.reason).toMatch(/not complete/);
    // and with every fact missing the status is not even known: also not_run
    expect(runL2(inputOf(emptyFacts())).status).toBe("not_run");
    expect(r.findings).toEqual([]);
    expect(layerStateOf(l2SummaryOf(r))).toBe("not_run");
  });

  it("a filing status other than married filing jointly is not recomputed", () => {
    const s = cleanScenario();
    const input = inputOf(s.facts);
    input.facts = structuredClone(input.facts);
    input.facts.household.filingStatus = { value: "single", basis: "answer_owner", refs: [] };
    expect(runL2(input).status).toBe("not_run");
  });

  it("an exception inside the recalculation is not_run, and the reason names only the error class (no figure from the facts)", () => {
    const input = inputOf(cleanScenario().facts);
    const sc = input.ret.scheduleC!;
    const broken = { ...sc, lines: sc.lines.map((l, i) => (i === 0 ? { ...l, amountCents: 12_345_678.5 } : l)) };
    const r = runL2({ ...input, ret: { ...input.ret, scheduleC: broken } });
    expect(r.status).toBe("not_run");
    expect(r.reason).toMatch(/could not run \(RangeError\)/);
    expect(r.reason).not.toMatch(/12345678/);
  });

  it("a recorded line override means the headline is not complete, so nothing is recomputed (the gate is red anyway)", () => {
    const s = cleanScenario();
    const ret = computeTy2025Return(s.facts);
    const row: OverrideRow = {
      id: "00000000-0000-4000-8000-0000000000ee",
      taxYear: 2025,
      targetKind: "line",
      targetKey: "f1040.25a",
      version: 1,
      valueKind: "money_cents",
      valueCents: 99_000_00,
      valueText: null,
      computedSnapshot: { status: ret.lines["f1040.25a"]!.status, cents: (ret.lines["f1040.25a"]!.amount ?? 0) * 100 },
      authority: "owner",
      reason: "test",
      setByName: "Test User",
      setAt: new Date("2026-10-01T12:00:00Z"),
      archivedAt: null,
    };
    const effective = applyOverrides(ret, [row]);
    expect(effective.headline.complete).toBe(false);
    expect(runL2({ ret, effective, facts: s.facts }).status).toBe("not_run");
  });
});

describe("runL2 on a complete return", () => {
  const input = inputOf(richScenario().facts);
  const r = runL2(input);

  it("runs, agrees with the engine on the rich return, and raises only the coverage note", () => {
    expect(r.status).toBe("ran");
    expect(r.reason).toBeNull();
    expect(nonCoverage(r.findings)).toEqual([]);
    expect(r.summary.mismatchCount).toBe(0);
    expect(r.summary.linesCompared).toBeGreaterThan(350);
    expect(r.summary.linesMatched).toBe(r.summary.linesCompared);
    const note = r.findings.find((f) => f.check === "L2.coverage")!;
    expect(note.severity).toBe("info");
    expect(note.layer).toBe("L2");
  });

  it("every finding is a valid stored Finding (strict schema) and carries no SSN-like or long digit text", () => {
    for (const f of r.findings) expect(() => findingSchema.parse(f)).not.toThrow();
  });

  it("lists what was and was not recomputed: covered forms with line counts, abstentions and the standing not-covered list", () => {
    const compared = r.coverage.filter((c) => c.compared);
    const areas = compared.map((c) => c.area).join(" | ");
    for (const must of ["Form 1040", "Schedule 1 ", "Schedule 2", "Schedule 3", "Schedule A", "Schedule C", "Schedule D", "Schedule SE", "Form 8959", "Form 8960", "Form CT-1040"]) expect(areas, must).toContain(must);
    for (const c of compared) {
      expect(c.linesCompared).toBeGreaterThan(0);
      expect(c.note).toMatch(/recomputed and compared/);
    }
    const notCovered = r.coverage.filter((c) => !c.compared).map((c) => c.area).join(" | ");
    expect(notCovered).toMatch(/Fact resolution/);
    expect(notCovered).toMatch(/GL account to Schedule C/);
    expect(notCovered).toMatch(/Form 2210/);
    expect(notCovered).toMatch(/Home office actual method/);
  });

  it("the stored summary the gate reads: completed + a non-empty coverage list + mismatchCount", () => {
    const stored = l2SummaryOf(r);
    expect(stored.status).toBe("completed");
    expect(stored.mismatchCount).toBe(0);
    expect(Array.isArray(stored.coverage) && stored.coverage.length > 0).toBe(true);
    expect(layerStateOf(stored)).toBe("completed");
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
  });
});

describe("the $1 rounding tolerance", () => {
  const base = inputOf(cleanScenario().facts);

  it("an engine line $1 off is a low finding (never a blocker); $2 off is a blocker, acceptable with a reason", () => {
    const one = nonCoverage(runL2(perturbed(base, "f1040.11a", 1)).findings);
    expect(one.map((f) => [f.check, f.severity])).toEqual([["L2.diff.f1040.11a", "low"]]);
    const two = nonCoverage(runL2(perturbed(base, "f1040.11a", 2)).findings);
    expect(two.map((f) => [f.check, f.severity, f.acceptable])).toEqual([["L2.diff.f1040.11a", "blocker", true]]);
  });

  it("the finding names both figures, the line and its form, and cites the printed form line", () => {
    const [f] = nonCoverage(runL2(perturbed(base, "f1040.24", 40)).findings);
    expect(f!.message).toMatch(/Form 1040 line 24/);
    expect(f!.message).toMatch(/difference \$40/);
    expect(f!.lineKey).toBe("f1040.24");
    expect(f!.formKey).toBe("f1040");
    expect(f!.area).toBe("tax");
    expect(f!.evidence.map((e) => e.ref)).toEqual(["f1040.24", "check:l2.f1040.24"]);
    expect(f!.citation.sources[0]!.kind).toBe("form_text");
  });

  it("a line the return leaves blank where the recalculation gets money is a medium finding; blank where the recalculation gets zero is not a finding", () => {
    const ret = base.ret;
    const blank = (key: LineKey): L2Input => {
      const line = ret.lines[key]!;
      const copy: Ty2025Return = { ...ret, lines: { ...ret.lines, [key]: { ...line, status: "missing_input", amount: null } } };
      return { ...base, ret: copy, effective: applyOverrides(copy, []) };
    };
    expect(ret.lines["f1040.24"]!.amount).toBeGreaterThan(0);
    expect(nonCoverage(runL2(blank("f1040.24")).findings).find((f) => f.check === "L2.diff.f1040.24")?.severity).toBe("medium");
    expect(nonCoverage(runL2(blank("f1040.19")).findings).find((f) => f.check === "L2.diff.f1040.19")).toBeUndefined();
  });

  it("a headline row that differs is its own finding (the headline is not assumed to equal its lines)", () => {
    const ret = base.ret;
    const copy: Ty2025Return = { ...ret, headline: { ...ret.headline, federal: { ...ret.headline.federal, totalTax: { ...ret.headline.federal.totalTax, amount: (ret.headline.federal.totalTax.amount ?? 0) + 500 } } } };
    const r = runL2({ ...base, ret: copy, effective: applyOverrides(copy, []) });
    const f = nonCoverage(r.findings);
    expect(f.map((x) => [x.check, x.severity])).toEqual([["L2.diff.head.federal.totalTax", "blocker"]]);
    expect(r.summary.mismatchCount).toBe(1);
  });
});

describe("every line the oracle compares is live: moving it by $5 in the return raises a finding on exactly that line", () => {
  for (const [name, facts] of [
    ["rich Eric-shaped return", richScenario().facts],
    ["a Schedule 1-A / senior / Schedule D return", randomHousehold(3).facts],
  ] as const) {
    it(name, () => {
      const decisions = name.startsWith("rich") ? {} : randomHousehold(3).decisions;
      const input = inputOf(facts, decisions);
      expect(runL2(input).status).toBe("ran");
      const ledger = oracleLedger(input);
      const keys = [...ledger.lines.values()].filter((l) => l.source === "oracle" && l.value !== null && input.ret.lines[l.key as LineKey]?.amount !== null && input.ret.lines[l.key as LineKey] !== undefined).map((l) => l.key);
      expect(keys.length).toBeGreaterThan(300);
      const dead: string[] = [];
      for (const key of keys) {
        const r = runL2(perturbed(input, key, 5));
        const hit = r.findings.find((f) => f.check === `L2.diff.${key}`);
        if (hit === undefined || (hit.severity !== "blocker" && hit.severity !== "medium")) dead.push(key);
      }
      expect(dead).toEqual([]);
    });
  }
});

describe("gate integration", () => {
  const base = inputOf(cleanScenario().facts);
  const bad = runL2(perturbed(base, "f1040.24", 40));
  const green = (over: Partial<GateInput>): GateInput => ({
    runFingerprint: "a".repeat(64),
    currentFingerprint: "a".repeat(64),
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: layerStateOf(l2SummaryOf(bad)), coverageListed: l2SummaryOf(bad).coverage.length > 0 },
    l3: { status: "completed", adversarialCompleted: true },
    ...over,
  });
  const l2Item = (g: ReturnType<typeof evaluateGate>) => g.items.find((i) => i.id === "l2")!;

  it("a clean recalculation with its coverage list turns the L2 item green; an open blocker turns it red; accepting it with a reason turns it green again", () => {
    const clean = runL2(base);
    expect(l2Item(evaluateGate(green({ findings: clean.findings, l2: { status: "completed", coverageListed: true } }))).state).toBe("pass");
    const open = evaluateGate(green({ findings: bad.findings }));
    expect(l2Item(open).state).toBe("fail");
    expect(open.openGating.map((f) => f.check)).toEqual(["L2.diff.f1040.24"]);
    const blocker = bad.findings.find((f) => f.check === "L2.diff.f1040.24")!;
    const accepted: DispositionRow[] = [{ findingKey: blocker.key, evidenceHash: blocker.evidenceHash, action: "accepted", reason: "the recalculation misses the extra payment", at: "2026-10-06T10:00:00Z" }];
    expect(l2Item(evaluateGate(green({ findings: bad.findings, dispositions: accepted }))).state).toBe("pass");
  });

  it("an acceptance does not survive a change in the figures (a different evidence hash)", () => {
    const blocker = bad.findings.find((f) => f.check === "L2.diff.f1040.24")!;
    const other = runL2(perturbed(base, "f1040.24", 41)).findings.find((f) => f.check === "L2.diff.f1040.24")!;
    expect(other.key).toBe(blocker.key);
    expect(other.evidenceHash).not.toBe(blocker.evidenceHash);
    const accepted: DispositionRow[] = [{ findingKey: blocker.key, evidenceHash: blocker.evidenceHash, action: "accepted", reason: "ok for the old figures", at: "2026-10-06T10:00:00Z" }];
    expect(l2Item(evaluateGate(green({ findings: [other], dispositions: accepted }))).state).toBe("fail");
  });

  it("not_run keeps the gate red (no waiver) and a completed run without its coverage list is also red", () => {
    expect(l2Item(evaluateGate(green({ l2: { status: "not_run", coverageListed: false } }))).state).toBe("not_run");
    expect(l2Item(evaluateGate(green({ l2: { status: "completed", coverageListed: false } }))).state).toBe("fail");
  });
});
