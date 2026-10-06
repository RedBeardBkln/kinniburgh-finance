// L1 for the business-use percentage decision (X6): the books -> line 25 tie-out with the percentage, the low "re-confirm the basis" finding,
// the home-office actual-method advisory, and the existing default-decision gate. The checks are run on a context built from a real engine
// return and its PDF view (no documents: the books tie-out does not need them).

import { describe, expect, it } from "vitest";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { doubleCountCheck } from "@/lib/tax-review/l1/double-count";
import { unresolvedChoicesCheck } from "@/lib/tax-review/l1/engine-state";
import { sourceTieoutCheck } from "@/lib/tax-review/l1/source-tieout";
import { L1_CHECKS } from "@/lib/tax-review/l1/run-l1";
import { DEFAULT_DECISION_CHECK, isGatingFinding } from "@/lib/tax-review/gate";
import { linkRuleFor } from "@/lib/tax-review/links";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { DecidedPercent, Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b, gl, owner } from "./tax2025-fixtures";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const pct = (tenths: number): { businessUse: Record<string, DecidedPercent> } => ({ businessUse: { internet_phone: { percentTenths: tenths, ...WHO } } });

function facts(extra: ReturnType<typeof gl>[] = [], homeOffice = false): Ty2025Facts {
  const f = fullFacts1b();
  f.income.scheduleC.glLines = [...f.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017), ...extra];
  if (homeOffice) {
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = owner(200);
  }
  return f;
}

function ctxOf(f: Ty2025Facts, decisions: Parameters<typeof computeTy2025Return>[1], mutate?: (ret: Ty2025Return) => void): L1Context {
  const ret = computeTy2025Return(f, decisions);
  mutate?.(ret);
  const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Test" });
  return { ret, view, facts: f, raw: null } as unknown as L1Context;
}

const books = async (ctx: L1Context) => (await sourceTieoutCheck.run(ctx)).filter((x) => x.check.startsWith("L1.C1.books-line") || x.check === "L1.C1.business-use-share");

describe("L1.C1 books -> Schedule C line 25 with the percentage", () => {
  it("a consistent return (undecided, 100%, 70%, 70.5%, 0%) has no tie-out finding", async () => {
    for (const d of [{}, pct(1000), pct(700), pct(705), pct(0), pct(333)]) {
      expect((await books(ctxOf(facts(), d))).filter((x) => x.check === "L1.C1.books-line25"), JSON.stringify(d)).toEqual([]);
    }
    // with another utilities account on the same line (counted at 100%, one rounding)
    expect((await books(ctxOf(facts([gl("6200", "Utilities:Phone service", "expense", 120_000)]), pct(700)))).filter((x) => x.check === "L1.C1.books-line25")).toEqual([]);
  });
  it("an engine that ignored the percentage (line 25 left at 100% while the decision says 70%) is a blocker that names both numbers", async () => {
    const f = facts();
    const at70 = computeTy2025Return(f, pct(700));
    const ctx = ctxOf(f, pct(700), (ret) => {
      const l = ret.lines["schc.25"];
      if (l) l.amount = 2610; // the printed line ignored the decision
    });
    const found = (await books(ctx)).filter((x) => x.check === "L1.C1.books-line25");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "blocker", acceptable: false, lineKey: "schc.25" });
    expect(found[0]?.message).toContain("$1,827");
    expect(found[0]?.message).toContain("$2,610");
    expect(at70.lines["schc.25"]?.amount).toBe(1827);
    expect(isGatingFinding(found[0]!)).toBe(true);
  });
  it("a pinned line 25 is left to the override check (no tie-out finding)", async () => {
    const f = facts();
    const ret = computeTy2025Return(f, pct(700));
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Test" });
    const line = view.lines["schc.25"];
    if (line) {
      line.status = "overridden";
      line.amount = 2000;
    }
    const found = (await sourceTieoutCheck.run({ ret, view, facts: f, raw: null } as unknown as L1Context)).filter((x) => x.check === "L1.C1.books-line25");
    expect(found).toEqual([]);
  });
  it("no mixed-use account booked: nothing is raised", async () => {
    const f = fullFacts1b();
    expect(await books(ctxOf(f, {}))).toEqual([]);
  });
});

describe("L1.C1 low finding for a share below 100%", () => {
  it("is raised for a decided share below 100%: low, non-gating, acceptable, names the personal portion and the decision", async () => {
    const found = (await books(ctxOf(facts(), pct(700)))).filter((x) => x.check === "L1.C1.business-use-share");
    expect(found).toHaveLength(1);
    const f = found[0]!;
    expect(f).toMatchObject({ severity: "low", acceptable: true, ruleTag: "X6", lineKey: "schc.25" });
    expect(f.message).toContain("Business-use share 70% (decision X6): $783.05");
    expect(f.message).toContain("no document supports it");
    expect(f.recommendedAction).toContain("first phone line");
    expect(f.evidence.some((e) => e.ref === "check:decision.X6")).toBe(true);
    expect(isGatingFinding(f)).toBe(false);
  });
  it("is not raised at 100%, undecided, or without a personal portion", async () => {
    for (const d of [{}, pct(1000)]) expect((await books(ctxOf(facts(), d))).filter((x) => x.check === "L1.C1.business-use-share"), JSON.stringify(d)).toEqual([]);
  });
});

describe("L1.C2 home office actual method next to a shared account", () => {
  const run = async (f: Ty2025Facts, decisions: Parameters<typeof computeTy2025Return>[1]) => (await doubleCountCheck.run(ctxOf(f, decisions))).filter((x) => x.check === "L1.C2.business-use-home-office");
  it("a medium, acceptable finding when X1 is the actual method and a shared account is booked", async () => {
    const found = await run(facts([], true), { homeOfficeMethod: { chosen: "actual", ...WHO }, ...pct(700) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "medium", acceptable: true });
    expect(found[0]?.message).toContain("Form 8829");
    expect(isGatingFinding(found[0]!)).toBe(false);
  });
  it("not raised with the simplified method, or without a shared account", async () => {
    expect(await run(facts([], true), { homeOfficeMethod: { chosen: "simplified", ...WHO } })).toEqual([]);
    expect(await run(facts([], true), {})).toEqual([]);
    const noShared = fullFacts1b();
    noShared.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    noShared.income.scheduleC.homeOfficeSqft = owner(200);
    expect(await run(noShared, { homeOfficeMethod: { chosen: "actual", ...WHO } })).toEqual([]);
  });
});

describe("the default-decision gate for X6", () => {
  const d2 = async (decisions: Parameters<typeof computeTy2025Return>[1]) => (await unresolvedChoicesCheck.run(ctxOf(facts(), decisions))).filter((x) => x.check === "L1.D2.decision" && x.ruleTag === "X6");
  it("an undecided X6 is a medium, acceptable finding that isGatingFinding treats as gating", async () => {
    const found = await d2({});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "medium", acceptable: true });
    expect(found[0]?.check.startsWith(DEFAULT_DECISION_CHECK)).toBe(true);
    expect(isGatingFinding(found[0]!)).toBe(true);
    expect(found[0]?.message).toContain("X6");
    expect(found[0]?.message).toContain("100%");
  });
  it("recording the decision (any percentage, including 100) removes the finding", async () => {
    for (const t of [1000, 700, 0]) expect(await d2(pct(t)), String(t)).toEqual([]);
  });
});

describe("check wiring", () => {
  it("L1_CHECKS is unchanged: the new findings live inside the existing checks", () => {
    expect(L1_CHECKS.map((c) => c.id)).toEqual(["L1.F1", "L1.F2", "L1.F3", "L1.B1", "L1.B2", "L1.B3", "L1.B4", "L1.B5", "L1.B6", "L1.X1", "L1.C1", "L1.C2", "L1.D1", "L1.D2", "L1.D3", "L1.D4", "L1.D5", "L1.E1", "L1.E2", "L1.G1", "L1.G2"]);
  });
  it("every new check id resolves to an explicit link rule", () => {
    for (const id of ["L1.C1.books-line25", "L1.C1.business-use-share", "L1.C2.business-use-home-office"]) expect(linkRuleFor(id).explicit, id).toBe(true);
  });
});
