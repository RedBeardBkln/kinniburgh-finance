// The overpayment decisions X7 / X8 in the review layers: L1 (the printed split adds up; an undecided decision still gates), L2 (the oracle
// restates the split independently and matches the engine; a hand-mutated engine is caught), and the AI payload (neutral decision ids, no
// registry key text).

import { vi } from "vitest";
vi.setConfig({ testTimeout: 240000 });
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DECISION_CHECK, isGatingFinding } from "@/lib/tax-review/gate";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { unresolvedChoicesCheck } from "@/lib/tax-review/l1/engine-state";
import { L1_CHECKS } from "@/lib/tax-review/l1/run-l1";
import { sourceTieoutCheck } from "@/lib/tax-review/l1/source-tieout";
import { oracleLedger, runL2, type L2Input } from "@/lib/tax-review/l2";
import { decisionsOf } from "@/lib/tax-review/l2/engine-view";
import { overpaymentOfText, overpaymentSplitOf } from "@/lib/tax-review/l2/money";
import { neutralTarget } from "@/lib/tax-review/llm/owner-statements";
import { buildRegister } from "@/lib/tax-review/llm/register";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { DecidedOverpayment, Ty2025Decisions, Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b } from "./tax2025-fixtures";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const refund = (): DecidedOverpayment => ({ chosen: "refund_all", ...WHO });
const applyAll = (): DecidedOverpayment => ({ chosen: "apply_all", ...WHO });
const applyAmount = (n: number): DecidedOverpayment => ({ chosen: "apply_amount", appliedDollars: n, ...WHO });

function overFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.income.w2s[0]!.fedWithheldCents = (f.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
  f.income.w2s[0]!.ctWithheldCents = (f.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
  return f;
}

function ctxOf(decisions: Ty2025Decisions, mutate?: (ret: Ty2025Return) => void, f: Ty2025Facts = overFacts()): L1Context {
  const ret = computeTy2025Return(f, decisions);
  mutate?.(ret);
  const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Test" });
  return { ret, view, facts: f, raw: null } as unknown as L1Context;
}

const splitFindings = async (ctx: L1Context) => (await sourceTieoutCheck.run(ctx)).filter((x) => x.check.startsWith("L1.C1.refund-split"));

describe("L1.C1 refund split: what is printed adds up", () => {
  it("a consistent return has no finding: undecided, refund all, apply all, a stated amount, both decisions", async () => {
    for (const d of [{}, { federalOverpayment: refund() }, { ctOverpayment: refund() }, { federalOverpayment: applyAll(), ctOverpayment: applyAll() }, { federalOverpayment: applyAmount(5000), ctOverpayment: applyAmount(400) }]) {
      expect(await splitFindings(ctxOf(d)), JSON.stringify(d)).toEqual([]);
    }
  });
  it("a balance-due return has nothing to check", async () => {
    expect(await splitFindings(ctxOf({}, undefined, fullFacts1b()))).toEqual([]);
  });
  it("an engine that printed 35a = 0 under refund all (a hand-mutated line) is a blocker naming the numbers and the instruction", async () => {
    const O = computeTy2025Return(overFacts(), {}).lines["f1040.34"]?.amount ?? -1;
    const ctx = ctxOf({ federalOverpayment: refund() }, (ret) => {
      const l = ret.lines["f1040.35a"];
      if (l) l.amount = 0;
    });
    const found = await splitFindings(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: "L1.C1.refund-split-federal", severity: "blocker", acceptable: false, lineKey: "f1040.35a", ruleTag: "X7" });
    expect(found[0]?.message).toContain("must equal line 34");
    expect(found[0]?.message).toContain(`$${O.toLocaleString("en-US")}`);
    expect(found[0]?.citation.sourceStatus).toBe("verified");
    expect(found[0]?.citation.sources[0]).toMatchObject({ kind: "source_pack", id: "i1040gi", quote: "Lines 35a, 36, and 38 must equal line 34." });
    expect(isGatingFinding(found[0]!)).toBe(true);
  });
  it("the same for Connecticut: line 25 + line 23 must equal line 22", async () => {
    const ctx = ctxOf({ ctOverpayment: applyAmount(400) }, (ret) => {
      const l = ret.lines["ct1040.25"];
      if (l) l.amount = (l.amount ?? 0) + 7;
    });
    const found = await splitFindings(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: "L1.C1.refund-split-ct", severity: "blocker", acceptable: false, lineKey: "ct1040.25", ruleTag: "X8" });
    expect(found[0]?.citation.sources[0]).toMatchObject({ kind: "source_pack", id: "ct1040i" });
  });
  it("an undecided decision raises no split finding (L1.D2 gates it instead), even if a line were mutated", async () => {
    const ctx = ctxOf({}, (ret) => {
      const l = ret.lines["f1040.35a"];
      if (l) l.amount = 5;
    });
    expect(await splitFindings(ctx)).toEqual([]);
  });
  it("the check list is unchanged (the findings live inside L1.C1)", () => {
    expect(L1_CHECKS.map((c) => c.id)).toContain("L1.C1");
    expect(L1_CHECKS.some((c) => c.id.includes("refund"))).toBe(false);
  });
});

describe("L1.D2 default-decision gate covers X7 / X8", () => {
  it("an undecided X7 and X8 each raise a gating L1.D2.decision finding; decided ones raise none", async () => {
    const undecided = await unresolvedChoicesCheck.run(ctxOf({}));
    const ids = undecided.filter((x) => x.check === DEFAULT_DECISION_CHECK).map((x) => x.ruleTag);
    expect(ids).toContain("X7");
    expect(ids).toContain("X8");
    const decided = await unresolvedChoicesCheck.run(ctxOf({ federalOverpayment: refund(), ctOverpayment: refund() }));
    expect(decided.filter((x) => x.check === DEFAULT_DECISION_CHECK && (x.ruleTag === "X7" || x.ruleTag === "X8"))).toEqual([]);
  });
});

// ── L2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function inputOf(decisions: Ty2025Decisions, f: Ty2025Facts = overFacts()): L2Input {
  const ret = computeTy2025Return(f, decisions);
  return { ret, effective: applyOverrides(ret, []), facts: f };
}

describe("L2 reads the choice text itself", () => {
  it("overpaymentOfText: the three forms, 'no_election' / nothing = none, anything else unreadable (never a guess)", () => {
    expect(overpaymentOfText("refund_all")).toEqual({ kind: "refund_all" });
    expect(overpaymentOfText("apply_all")).toEqual({ kind: "apply_all" });
    expect(overpaymentOfText("apply_amount:5000")).toEqual({ kind: "apply_amount", dollars: 5000 });
    expect(overpaymentOfText("no_election")).toEqual({ kind: "none" });
    expect(overpaymentOfText(undefined)).toEqual({ kind: "none" });
    for (const bad of ["apply_amount", "apply_amount:0", "apply_amount:-5", "apply_amount:1.5", "simplified", "70%", ""]) expect(overpaymentOfText(bad), bad).toEqual({ kind: "unreadable" });
  });
  it("overpaymentSplitOf: the hand table; null for no decision and for an amount above what is available", () => {
    expect(overpaymentSplitOf(16054, { kind: "refund_all" })).toEqual([16054, 0]);
    expect(overpaymentSplitOf(16054, { kind: "apply_all" })).toEqual([0, 16054]);
    expect(overpaymentSplitOf(16054, { kind: "apply_amount", dollars: 5000 })).toEqual([11054, 5000]);
    expect(overpaymentSplitOf(904, { kind: "apply_amount", dollars: 905 })).toBeNull();
    expect(overpaymentSplitOf(904, { kind: "none" })).toBeNull();
  });
  it("decisionsOf reads X7 / X8 from the engine decisions and does not mistake them for a percentage (X6 reader)", () => {
    const d = decisionsOf(computeTy2025Return(overFacts(), { federalOverpayment: applyAmount(5000), ctOverpayment: refund() }), null);
    expect(d.federalOverpayment).toEqual({ kind: "apply_amount", dollars: 5000 });
    expect(d.ctOverpayment).toEqual({ kind: "refund_all" });
    expect(d.businessUse).toEqual({});
    const u = decisionsOf(computeTy2025Return(overFacts(), {}), null);
    expect(u.federalOverpayment).toEqual({ kind: "none" });
    expect(u.ctOverpayment).toEqual({ kind: "none" });
  });
});

describe("L2 matches the engine on the overpayment lines (zero mismatches)", () => {
  const cases: [string, Ty2025Decisions][] = [
    ["undecided", {}],
    ["refund all, both", { federalOverpayment: refund(), ctOverpayment: refund() }],
    ["apply all, both", { federalOverpayment: applyAll(), ctOverpayment: applyAll() }],
    ["a stated amount", { federalOverpayment: applyAmount(5000), ctOverpayment: applyAmount(400) }],
    ["only X7 decided", { federalOverpayment: refund() }],
    ["only X8 decided", { ctOverpayment: refund() }],
  ];
  for (const [name, d] of cases) {
    it(`${name}: runL2 finds nothing and the oracle's lines equal the engine's`, () => {
      const input = inputOf(d);
      const r = runL2(input);
      expect(r.status, r.reason ?? "").toBe("ran");
      expect(r.summary.mismatchCount).toBe(0);
      expect(r.findings.filter((f) => f.check !== "L2.coverage")).toEqual([]);
      const ledger = oracleLedger(input);
      const has = (k: string) => ledger.lines.has(k);
      // the oracle only restates a line once a decision is recorded (an undecided line is blank on the return)
      expect(has("f1040.35a")).toBe(d.federalOverpayment !== undefined);
      expect(has("ct1040.25")).toBe(d.ctOverpayment !== undefined);
      for (const k of ["f1040.35a", "f1040.36", "ct1040.23", "ct1040.25"] as const) {
        if (has(k)) expect(ledger.get(k), k).toBe(input.ret.lines[k]?.amount);
      }
    });
  }
  it("no overpayment: the oracle puts 0 on the four lines and matches the engine's not-applicable lines", () => {
    const input = inputOf({ federalOverpayment: refund() }, fullFacts1b());
    const ledger = oracleLedger(input);
    for (const k of ["f1040.35a", "f1040.36", "ct1040.23", "ct1040.25"]) expect(ledger.get(k), k).toBe(0);
    expect(runL2(input).summary.mismatchCount).toBe(0);
  });
});

describe("L2 catches an engine that prints the wrong split", () => {
  it("35a printed as 0 under refund all is a mismatch finding on f1040.35a", () => {
    const input = inputOf({ federalOverpayment: refund() });
    const eff = applyOverrides(input.ret, []);
    // hand-mutate the effective line (the engine's printed amount), exactly what a broken rule would produce
    const entry = eff.lines["f1040.35a"];
    if (!entry) throw new Error("line missing");
    entry.effective = { amount: 0, status: "computed" };
    const r = runL2({ ret: input.ret, effective: eff, facts: input.facts });
    expect(r.summary.mismatchCount).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.lineKey === "f1040.35a")).toBe(true);
  });
  it("CT line 25 printed as line 22 while 400 is applied is a mismatch finding on ct1040.25", () => {
    const input = inputOf({ ctOverpayment: applyAmount(400) });
    const eff = applyOverrides(input.ret, []);
    const entry = eff.lines["ct1040.25"];
    if (!entry) throw new Error("line missing");
    entry.effective = { amount: (input.ret.lines["ct1040.22"]?.amount ?? 0), status: "computed" };
    const r = runL2({ ret: input.ret, effective: eff, facts: input.facts });
    expect(r.findings.some((f) => f.lineKey === "ct1040.25")).toBe(true);
  });
  it("an unreadable recorded text makes the oracle abstain (no value, no guess)", () => {
    const input = inputOf({ federalOverpayment: refund() });
    const eff = applyOverrides(input.ret, []);
    const d = eff.decisions.find((x) => x.id === "X7");
    if (!d) throw new Error("decision missing");
    d.chosen = "something_else";
    const ledger = oracleLedger({ ret: input.ret, effective: eff, facts: input.facts });
    expect(ledger.lines.has("f1040.35a")).toBe(false);
    expect(ledger.abstentions.some((a) => a.area === "Form 1040 lines 35a and 36")).toBe(true);
  });
});

describe("L2 independence: the oracle files do not import the engine's overpayment module", () => {
  it("no l2 file imports lib/tax2025/overpayment or its rules", () => {
    const dir = path.resolve(__dirname, "..", "tax-review", "l2");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const imports = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
      expect(imports.filter((i) => /tax2025\/overpayment|tax2025\/rules\//.test(i)), f).toEqual([]);
    }
  });
});

describe("the judgments register lists X7 / X8 without inventing a dollar impact", () => {
  it("undecided: 'Needs your decision' entries; decided: 'You decided'; amountDollars is null (no 'deduction size' figure), no CPA wording", () => {
    for (const [decisions, status] of [[{}, "undecided"], [{ federalOverpayment: refund(), ctOverpayment: applyAmount(400) }, "decided"]] as const) {
      const f = overFacts();
      const ret = computeTy2025Return(f, decisions);
      const entries = buildRegister({ ret, facts: f }).filter((e) => e.id === "decision:X7" || e.id === "decision:X8");
      expect(entries.map((e) => e.id)).toEqual(["decision:X7", "decision:X8"]);
      for (const e of entries) {
        expect(e.status, e.id).toBe(status);
        expect(e.dollarImpact.amountDollars, e.id).toBeNull();
        expect(JSON.stringify(e), e.id).not.toMatch(/\bCPA\b|deduction size/);
        expect(e.alternative, e.id).not.toBeNull();
      }
    }
  });
});

// ── L3 / AI payload ──────────────────────────────────────────────────────────────────────────────────────────────

describe("the AI review payload names X7 / X8 by their decision ids", () => {
  it("neutralTarget maps the registry keys to the neutral ids; the key text never travels", () => {
    expect(neutralTarget("decision", "federalOverpayment")).toBe("X7");
    expect(neutralTarget("decision", "ctOverpayment")).toBe("X8");
    expect(neutralTarget("decision", "constructor")).toBe("decision");
  });
});
