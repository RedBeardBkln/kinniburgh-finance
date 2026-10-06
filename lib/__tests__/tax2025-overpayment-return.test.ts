// The overpayment decisions X7 (Form 1040 lines 35a / 36) and X8 (CT-1040 lines 23 / 25) through the whole return
// (engine ty2025-1b.10). Hand-computed tables: the overpayment is whatever lines 34 / 22 are in the fixture, so the
// expectations are RELATIVE to those lines (35a + 36 + printed 38 = 34; 25 + 23 = 22).

import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { TY2025_ENGINE_VERSION, computeTy2025Return, duplicateEmissions } from "@/lib/tax2025/return";
import { computeCtSettlement } from "@/lib/tax2025/rules/ct-settlement";
import { computeFederalOverpayment, federalPenaltyExceedsOverpayment } from "@/lib/tax2025/rules/overpayment-federal";
import { LINE_CATALOG } from "@/lib/tax2025/line-catalog";
import { hasAmount, type DecidedOverpayment, type LineKey, type Ty2025Decisions, type Ty2025Return } from "@/lib/tax2025/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { fullFacts1b } from "@/lib/__tests__/tax2025-fixtures";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const refund = (): DecidedOverpayment => ({ chosen: "refund_all", ...WHO });
const applyAll = (): DecidedOverpayment => ({ chosen: "apply_all", ...WHO });
const applyAmount = (n: number): DecidedOverpayment => ({ chosen: "apply_amount", appliedDollars: n, ...WHO });

/** fullFacts1b with extra withholding: a federal overpayment (line 34 > 0) and a CT overpayment (line 22 > 0). */
function overFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.income.w2s[0]!.fedWithheldCents = (f.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
  f.income.w2s[0]!.ctWithheldCents = (f.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
  return f;
}
/** The same facts owing tax on both returns (no overpayment). */
const dueFacts = (): Ty2025Facts => fullFacts1b();

function amt(r: Ty2025Return, k: LineKey): number | null {
  const l = r.lines[k];
  return l !== undefined && hasAmount(l.status) ? l.amount : null;
}
function num(r: Ty2025Return, k: LineKey): number {
  const v = amt(r, k);
  if (v === null) throw new Error(`no amount on ${k}`);
  return v;
}
const OVERPAYMENT_KEYS: readonly LineKey[] = ["f1040.35a", "f1040.36", "ct1040.23", "ct1040.25"];

const undecided = computeTy2025Return(overFacts(), {});
const O = num(undecided, "f1040.34");
const C = num(undecided, "ct1040.22");

describe("the fixture really has both overpayments", () => {
  it("line 34 and CT line 22 are positive, line 38 is a computed 0", () => {
    expect(O).toBeGreaterThan(1000);
    expect(C).toBeGreaterThan(1000);
    expect(num(undecided, "f1040.38")).toBe(0);
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.10");
  });
});

describe("(a) undecided: the four lines stay blank, flagged default, undecided", () => {
  it("35a / 36 / CT 23 / CT 25 are informational not_yet_computed (no amount); the reasons name the decision and the overpayment", () => {
    for (const k of OVERPAYMENT_KEYS) {
      const l = undecided.lines[k];
      expect(l?.status, k).toBe("not_yet_computed");
      expect(l?.amount, k).toBeNull();
      expect(l?.informational, k).toBe(true);
    }
    expect(undecided.lines["f1040.35a"]?.reason).toContain(`$${O.toLocaleString("en-US")}`);
    expect(undecided.lines["f1040.35a"]?.reason).toContain("decision X7");
    expect(undecided.lines["ct1040.25"]?.reason).toContain("decision X8");
    expect(undecided.lines["ct1040.25"]?.reason).toContain("line 22 less lines 23, 24 and 24a");
    expect(undecided.lines["f1040.35a"]?.refs.some((r) => r.kind === "decision" && r.id === "X7" && /default, undecided/.test(r.label))).toBe(true);
  });
  it("X7 and X8 are default_undecided decisions ('no_election') with advisory open items, and the undecided count includes both", () => {
    const x7 = undecided.decisions.find((d) => d.id === "X7");
    const x8 = undecided.decisions.find((d) => d.id === "X8");
    expect(x7).toMatchObject({ id: "X7", chosen: "no_election", status: "default_undecided" });
    expect(x8).toMatchObject({ id: "X8", chosen: "no_election", status: "default_undecided" });
    expect(undecided.openItems.find((o) => o.id === "decision:X7")?.severity).toBe("advisory");
    expect(undecided.openItems.find((o) => o.id === "decision:X8")?.severity).toBe("advisory");
    expect(undecided.headline.undecidedDecisionCount).toBe(2);
  });
  it("nothing blocks: the headline is as complete as before, and the lines stay informational advisory items", () => {
    expect(undecided.headline.complete).toBe(true);
    expect(undecided.headline.blockingItemCount).toBe(0);
    expect(undecided.openItems.some((o) => o.id === "info:f1040.35a" && o.severity === "advisory")).toBe(true);
    expect(undecided.openItems.some((o) => o.id === "info:ct1040.25" && o.severity === "advisory")).toBe(true);
  });
  it("the alternatives sit side by side: no_election is the default and in force; no alternative carries a dollar effect", () => {
    for (const id of ["X7", "X8"] as const) {
      const r = undecided.results.find((x) => x.decision?.id === id);
      expect(r?.alternatives?.map((a) => [a.id, a.isDefault, a.inForce])).toEqual([
        ["no_election", true, true],
        ["refund_all", false, false],
        ["apply_all", false, false],
        ["apply_amount", false, false],
      ]);
      for (const a of r?.alternatives ?? []) {
        expect(a.effect?.amount, `${id} ${a.id}`).toBeNull();
        expect((a.effect?.note ?? "").length, `${id} ${a.id}`).toBeGreaterThan(10);
      }
    }
  });
});

describe("(b) refund all on both", () => {
  const ret = computeTy2025Return(overFacts(), { federalOverpayment: refund(), ctOverpayment: refund() });
  it("35a = line 34, 36 = computed 0, CT 25 = line 22, CT 23 = computed 0", () => {
    expect(num(ret, "f1040.35a")).toBe(O);
    expect(ret.lines["f1040.35a"]?.status).toBe("computed");
    expect(num(ret, "f1040.36")).toBe(0);
    expect(ret.lines["f1040.36"]?.status).toBe("computed");
    expect(num(ret, "ct1040.25")).toBe(C);
    expect(num(ret, "ct1040.23")).toBe(0);
  });
  it("both decisions are decided with who and when; the open items and counters drop", () => {
    expect(ret.decisions.find((d) => d.id === "X7")).toMatchObject({ chosen: "refund_all", status: "decided", decidedBy: "Eric", decidedAt: WHO.at });
    expect(ret.decisions.find((d) => d.id === "X8")).toMatchObject({ chosen: "refund_all", status: "decided" });
    expect(ret.headline.undecidedDecisionCount).toBe(0);
    for (const id of ["decision:X7", "decision:X8", "info:f1040.35a", "info:f1040.36", "info:ct1040.23", "info:ct1040.25"]) {
      expect(ret.openItems.some((o) => o.id === id), id).toBe(false);
    }
    expect(ret.headline.complete).toBe(true);
    expect(ret.headline.blockingItemCount).toBe(0);
  });
  it("provenance: the lines cite the decision, state the formula with dollars, and never say CPA", () => {
    const l = ret.lines["f1040.35a"];
    expect(l?.refs.some((r) => r.kind === "decision" && r.id === "X7")).toBe(true);
    expect(l?.reason).toContain(`Form 1040 line 34 $${O.toLocaleString("en-US")}`);
    expect(l?.reason).toContain("Lines 35a, 36, and 38 must equal line 34");
    expect(l?.reason).toContain("refund all");
    expect(ret.lines["ct1040.25"]?.reason).toContain("Lines 24 (CHET) and 24a (charities) are left blank");
    for (const k of OVERPAYMENT_KEYS) expect(ret.lines[k]?.reason ?? "", k).not.toMatch(/CPA/);
  });
  it("no other line moves between the undecided and the decided run (no tax, AGI, payment or refund-headline line changes)", () => {
    for (const meta of LINE_CATALOG) {
      if ((OVERPAYMENT_KEYS as readonly string[]).includes(meta.key)) continue;
      expect(ret.lines[meta.key]?.amount, meta.key).toBe(undecided.lines[meta.key]?.amount);
      expect(ret.lines[meta.key]?.status, meta.key).toBe(undecided.lines[meta.key]?.status);
    }
    expect(ret.headline.federal).toEqual(undecided.headline.federal);
    expect(ret.headline.connecticut).toEqual(undecided.headline.connecticut);
  });
  it("no line is emitted twice", () => {
    expect(duplicateEmissions(overFacts(), { federalOverpayment: refund(), ctOverpayment: refund() })).toEqual([]);
    expect(duplicateEmissions(overFacts(), {})).toEqual([]);
  });
});

describe("(c) apply all and a stated amount (hand tables)", () => {
  it("apply all: 35a = 0 (computed), 36 = line 34; CT 23 = line 22, CT 25 = 0", () => {
    const ret = computeTy2025Return(overFacts(), { federalOverpayment: applyAll(), ctOverpayment: applyAll() });
    expect([num(ret, "f1040.35a"), num(ret, "f1040.36")]).toEqual([0, O]);
    expect([num(ret, "ct1040.23"), num(ret, "ct1040.25")]).toEqual([C, 0]);
    expect(ret.lines["f1040.36"]?.reason).toContain("cannot be changed");
    expect(ret.lines["ct1040.23"]?.reason).toContain("irrevocable");
  });
  it("a stated amount: 5,000 federal and 400 CT (the live shape: 35a = O - 5,000, 36 = 5,000; CT 23 = 400, CT 25 = C - 400)", () => {
    const ret = computeTy2025Return(overFacts(), { federalOverpayment: applyAmount(5000), ctOverpayment: applyAmount(400) });
    expect([num(ret, "f1040.35a"), num(ret, "f1040.36")]).toEqual([O - 5000, 5000]);
    expect([num(ret, "ct1040.23"), num(ret, "ct1040.25")]).toEqual([400, C - 400]);
    expect(ret.decisions.find((d) => d.id === "X7")?.chosen).toBe("apply_amount:5000");
    expect(ret.decisions.find((d) => d.id === "X8")?.chosen).toBe("apply_amount:400");
    const x7 = ret.results.find((r) => r.decision?.id === "X7");
    expect(x7?.alternatives?.find((a) => a.id === "apply_amount")?.inForce).toBe(true);
    expect(x7?.alternatives?.find((a) => a.id === "apply_amount")?.status).toBe("computed");
  });
  it("sweep: 35a + 36 + the printed line 38 = line 34 for every amount up to the overpayment, and CT 25 + 23 = line 22", () => {
    const p38 = num(undecided, "f1040.38");
    for (const a of [1, 2, 99, 100, 1000, O - 1, O]) {
      const ret = computeTy2025Return(overFacts(), { federalOverpayment: applyAmount(a) });
      expect(num(ret, "f1040.35a") + num(ret, "f1040.36") + p38, `federal ${a}`).toBe(O);
      expect(num(ret, "f1040.36")).toBe(a);
    }
    for (const a of [1, 7, C - 1, C]) {
      const ret = computeTy2025Return(overFacts(), { ctOverpayment: applyAmount(a) });
      expect(num(ret, "ct1040.25") + num(ret, "ct1040.23"), `ct ${a}`).toBe(C);
    }
  });
  it("the two decisions are independent: X7 decided with X8 undecided, and the reverse", () => {
    const a = computeTy2025Return(overFacts(), { federalOverpayment: refund() });
    expect(a.lines["f1040.35a"]?.status).toBe("computed");
    expect(a.lines["ct1040.25"]?.status).toBe("not_yet_computed");
    expect(a.decisions.find((d) => d.id === "X8")?.status).toBe("default_undecided");
    expect(a.headline.undecidedDecisionCount).toBe(1);
    const b = computeTy2025Return(overFacts(), { ctOverpayment: refund() });
    expect(b.lines["f1040.35a"]?.status).toBe("not_yet_computed");
    expect(b.lines["ct1040.25"]?.status).toBe("computed");
    expect(b.decisions.find((d) => d.id === "X7")?.status).toBe("default_undecided");
  });
});

describe("(e) a recorded amount that is now more than the overpayment blocks (never prints a number that does not add up)", () => {
  const ret = computeTy2025Return(overFacts(), { federalOverpayment: applyAmount(O + 1), ctOverpayment: applyAmount(C + 1) });
  it("both lines of each decision are blocking missing_input with a 'record again' reason and a blocking open item", () => {
    for (const k of OVERPAYMENT_KEYS) {
      expect(ret.lines[k]?.status, k).toBe("missing_input");
      expect(ret.lines[k]?.amount, k).toBeNull();
      expect(ret.lines[k]?.informational, k).toBeUndefined();
    }
    expect(ret.lines["f1040.35a"]?.reason).toContain("Record decision X7 again");
    expect(ret.lines["ct1040.25"]?.reason).toContain("Record decision X8 again");
    expect(ret.openItems.find((o) => o.id === "rule:overpayment-federal")?.severity).toBe("blocking");
    expect(ret.openItems.find((o) => o.id === "rule:ct-settlement")?.severity).toBe("blocking");
    expect(ret.headline.complete).toBe(false);
    expect(ret.decisions.find((d) => d.id === "X7")?.status).toBe("decided");
  });
});

describe("(g) no overpayment: the lines are not applicable and no decision is raised", () => {
  const ret = computeTy2025Return(dueFacts(), { federalOverpayment: refund(), ctOverpayment: refund() });
  it("35a / 36 / CT 23 / CT 25 are not_applicable 0; no X7 / X8; no info items", () => {
    expect(num(ret, "f1040.34")).toBe(0);
    for (const k of OVERPAYMENT_KEYS) {
      expect(ret.lines[k]?.status, k).toBe("not_applicable");
      expect(ret.lines[k]?.amount, k).toBe(0);
    }
    expect(ret.decisions.some((d) => d.id === "X7" || d.id === "X8")).toBe(false);
    expect(ret.openItems.some((o) => /^info:(f1040.35a|f1040.36|ct1040.23|ct1040.25)$/.test(o.id))).toBe(false);
    expect(ret.openItems.some((o) => o.id === "decision:X7" || o.id === "decision:X8")).toBe(false);
  });
});

describe("(f) the line 38 penalty is taken out first (rule level)", () => {
  const fed = (line34: number, line38: number | null, d?: DecidedOverpayment) =>
    computeFederalOverpayment({ line34: D(line34), line38: line38 === null ? null : D(line38), ...(d ? { decision: d } : {}) });
  const val = (r: ReturnType<typeof fed>, k: string): number | null => r.lines.find((l) => l.key === k)?.amount?.toNumber() ?? null;

  it("refund all with a 100 penalty: 35a = O - 100, 36 = 0; a stated 5,000: 35a = O - 100 - 5,000", () => {
    const r = fed(16054, 100, refund());
    expect([val(r, "f1040.35a"), val(r, "f1040.36")]).toEqual([15954, 0]);
    const r2 = fed(16054, 100, applyAmount(5000));
    expect([val(r2, "f1040.35a"), val(r2, "f1040.36")]).toEqual([10954, 5000]);
    expect(r2.lines[0]?.reason).toContain("less line 38 $100");
  });
  it("a blank line 38 counts as 0 and says so", () => {
    const r = fed(16054, null, refund());
    expect([val(r, "f1040.35a"), val(r, "f1040.36")]).toEqual([16054, 0]);
    expect(r.lines[0]?.reason).toContain("line 38 (blank");
  });
  it("a penalty above the overpayment: 0 and 0 (the instruction says enter -0-), and the helper flags it", () => {
    const r = fed(100, 250, refund());
    expect([val(r, "f1040.35a"), val(r, "f1040.36")]).toEqual([0, 0]);
    expect(r.lines[0]?.reason).toContain("enter -0- on lines 35a and 36");
    expect(federalPenaltyExceedsOverpayment(D(100), D(250))).toBe(true);
    expect(federalPenaltyExceedsOverpayment(D(100), D(100))).toBe(false);
    expect(federalPenaltyExceedsOverpayment(D(100), null)).toBe(false);
    expect(federalPenaltyExceedsOverpayment(D(0), D(5))).toBe(false);
    // nothing can be applied when nothing is available: a stated amount blocks
    expect(fed(100, 250, applyAmount(1)).status).toBe("missing_input");
  });
  it("sweep with a penalty: 35a + 36 + 38 = 34 whenever the penalty is not above the overpayment", () => {
    for (const p of [0, 1, 50, 999]) {
      for (const a of [1, 10, 500]) {
        const r = fed(1000, p, applyAmount(a));
        if (a > 1000 - p) {
          expect(r.status).toBe("missing_input");
          continue;
        }
        expect((val(r, "f1040.35a") ?? -1) + (val(r, "f1040.36") ?? -1) + p).toBe(1000);
      }
    }
  });
  it("line 34 = 0 gives not_applicable and no decision", () => {
    const r = fed(0, 0);
    expect(r.decision).toBeUndefined();
    expect(r.lines.map((l) => l.status)).toEqual(["not_applicable", "not_applicable"]);
  });
});

describe("(h) CT line 29 still open: the refund says the interest may reduce it", () => {
  it("line 14 5,000 with no withholding and a 100 overpayment: line 29 is informational, the line 25 reason says so", () => {
    const r = computeCtSettlement({ line14: D(5000), line18: D(0), line20c: D(0), line22: D(100), line26: D(0), decision: refund() });
    expect(r.lines.find((l) => l.key === "ct1040.29")?.amount).toBeNull();
    const l25 = r.lines.find((l) => l.key === "ct1040.25");
    expect(l25?.amount?.toNumber()).toBe(100);
    expect(l25?.reason).toContain("Line 29 (interest on underpayment of estimated tax) is not estimated and may reduce the refund");
  });
  it("line 25 + line 23 = line 22 over the CT decisions", () => {
    for (const d of [refund(), applyAll(), applyAmount(30)]) {
      const r = computeCtSettlement({ line14: D(100), line18: D(100), line20c: D(0), line22: D(904), line26: D(0), decision: d });
      const l = (k: string) => r.lines.find((x) => x.key === k)?.amount?.toNumber() ?? -1;
      expect(l("ct1040.25") + l("ct1040.23")).toBe(904);
    }
  });
});

describe("the decisions go through the engine type only (no new constants, no float)", () => {
  it("Ty2025Decisions accepts the two keys", () => {
    const d: Ty2025Decisions = { federalOverpayment: refund(), ctOverpayment: applyAmount(1) };
    expect(Object.keys(d)).toEqual(["federalOverpayment", "ctOverpayment"]);
  });
});
