// The business-use percentage decision (X6) through the Schedule C rule and the whole return (engine ty2025-1b.9).
// Hand-computed expectations (the plan's table) and an independent SE / QBI reference written from the printed forms.

import { describe, expect, it } from "vitest";
import { BUSINESS_USE_ACCOUNTS } from "@/lib/tax2025/business-use";
import { D, roundLine } from "@/lib/tax2025/money";
import { TY2025_ENGINE_VERSION, computeTy2025Return, duplicateEmissions } from "@/lib/tax2025/return";
import { computeScheduleC, type ScheduleCInput } from "@/lib/tax2025/rules/schedule-c";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { hasAmount, type DecidedPercent, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b, gl, owner } from "@/lib/__tests__/tax2025-fixtures";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const pct = (tenths: number): DecidedPercent => ({ percentTenths: tenths, ...WHO });
const decide = (tenths: number) => ({ businessUse: { internet_phone: pct(tenths) } });

function amt(r: Ty2025Return, k: LineKey): number | null {
  return r.lines[k]?.amount ?? null;
}
function num(r: Ty2025Return, k: LineKey): number {
  const v = amt(r, k);
  if (v === null) throw new Error(`no amount on ${k}`);
  return v;
}

const INTERNET = "Utilities:Internet & Phone";

/** fullFacts1b plus the shared account (booked 2,610.17); revenue / other expenses overridable for the profit / loss / small-profit cases. */
function facts(opts: { name?: string; cents?: number; revenueCents?: number; extra?: ReturnType<typeof gl>[]; homeOffice?: boolean } = {}): Ty2025Facts {
  const f = fullFacts1b();
  const sc = f.income.scheduleC;
  const base = sc.glLines.filter((g) => g.code !== "4000");
  sc.glLines = [gl("4000", "Services", "revenue", opts.revenueCents ?? 6_000_000), ...base.filter((g) => g.code !== "4000")];
  if (opts.cents !== 0) sc.glLines.push(gl("6100", opts.name ?? INTERNET, "expense", opts.cents ?? 261_017));
  for (const g of opts.extra ?? []) sc.glLines.push(g);
  if (opts.homeOffice) {
    sc.homeOfficeEligibility = owner("yes_exclusive");
    sc.homeOfficeSqft = owner(200);
  }
  return f;
}

// ── independent references (own arithmetic, from the printed forms) ──────────────────────────────────────────────
const SS_ROOM = 176_100 - 90_000; // 2025 wage base less Eric's W-2 Social Security wages in the fixture
function refSe(netProfit: number): { ne: number; ss: number; med: number; total: number; half: number } {
  if (netProfit <= 0) return { ne: 0, ss: 0, med: 0, total: 0, half: 0 };
  const ne = roundLine(D(netProfit).times("0.9235")).toNumber();
  const ss = roundLine(D(Math.min(ne, SS_ROOM)).times("0.124")).toNumber();
  const med = roundLine(D(ne).times("0.029")).toNumber();
  const total = ss + med;
  return { ne, ss, med, total, half: roundLine(D(total).div(2)).toNumber() };
}

describe("rounding table (Schedule C rule, unit)", () => {
  const baseInput = (glLines: ScheduleCInput["glLines"], decisions?: ScheduleCInput["businessUseDecisions"]): ScheduleCInput => ({
    glLines: [gl("4000", "Services", "revenue", 5_000_000), ...glLines],
    booksEmpty: false,
    mileage: [],
    mileageNoneConfirmed: true,
    homeOfficeEligibility: "no",
    homeOfficeSqft: null,
    fixedAssets: [],
    fixedAssetsNoneConfirmed: true,
    ...(decisions ? { businessUseDecisions: decisions } : {}),
  });
  const line25 = (cents: number, tenths: number | null, extra: ReturnType<typeof gl>[] = []): number | null => {
    const out = computeScheduleC(baseInput([gl("6100", INTERNET, "expense", cents), ...extra], tenths === null ? undefined : { internet_phone: pct(tenths) }));
    return out.result.lines.find((l) => l.key === "schc.25")?.amount?.toNumber() ?? null;
  };

  it("261,017 cents: 100% -> 2,610; 70% -> 1,827; 70.5% -> 1,840; 33.3% -> 869; 0% -> 0 (once, from cents)", () => {
    expect(line25(261_017, null)).toBe(2610);
    expect(line25(261_017, 1000)).toBe(2610);
    expect(line25(261_017, 700)).toBe(1827);
    expect(line25(261_017, 705)).toBe(1840);
    expect(line25(261_017, 333)).toBe(869);
    expect(line25(261_017, 0)).toBe(0);
  });
  it("the half-dollar edge rounds half away from zero: 1,001.00 at 50% = 500.50 -> 501", () => {
    expect(line25(100_100, 500)).toBe(501);
  });
  it("rounds ONCE on the line total: internet 1,000.30 at 50% + electricity 100.40 at 100% = 600.55 -> 601 (per account would print 600)", () => {
    expect(line25(100_030, 500, [gl("6200", "Utilities:Electricity", "expense", 10_040)])).toBe(601);
  });
  it("another utilities account on the same line stays at 100%", () => {
    expect(line25(261_017, 700, [gl("6200", "Utilities:Phone service", "expense", 120_000)])).toBe(1827 + 1200);
  });
});

describe("(a) undecided: today's numbers, flagged default, undecided", () => {
  const undecided = computeTy2025Return(facts(), {});
  // the same books with the amount on a NOT-mixed-use line 25 account: what engine 1b.8 computed for these facts
  const legacy = computeTy2025Return(facts({ name: "Utilities:Phone service" }), {});

  it("line 25 is the booked amount at 100% (2,610 for 2,610.17) and every line and status equals the 1b.8-style run", () => {
    expect(amt(undecided, "schc.25")).toBe(2610);
    for (const key of Object.keys(legacy.lines) as LineKey[]) {
      expect(undecided.lines[key]?.amount, key).toBe(legacy.lines[key]?.amount);
      expect(undecided.lines[key]?.status, key).toBe(legacy.lines[key]?.status);
      expect(undecided.lines[key]?.exact, key).toBe(legacy.lines[key]?.exact);
    }
    expect(Object.keys(undecided.lines).sort()).toEqual(Object.keys(legacy.lines).sort());
    expect(undecided.headline.federal).toEqual(legacy.headline.federal);
    expect(undecided.headline.connecticut).toEqual(legacy.headline.connecticut);
    expect(undecided.headline.complete).toBe(legacy.headline.complete);
  });
  it("X6 is a default_undecided decision with chosen '100%', an advisory open item, and one more undecided decision", () => {
    const x6 = undecided.decisions.find((d) => d.id === "X6");
    expect(x6).toMatchObject({ id: "X6", chosen: "100%", status: "default_undecided" });
    expect(x6?.label).toBe(BUSINESS_USE_ACCOUNTS[0].label);
    const item = undecided.openItems.find((o) => o.id === "decision:X6");
    expect(item?.severity).toBe("advisory");
    expect(undecided.headline.undecidedDecisionCount).toBe(legacy.headline.undecidedDecisionCount + 1);
    expect(legacy.decisions.some((d) => d.id === "X6")).toBe(false);
  });
  it("line 25 provenance names the decision (default, undecided) next to the books; nothing is called verified", () => {
    const l = undecided.lines["schc.25"];
    expect(l?.reason).toMatch(/default, undecided \(decision X6\)/);
    expect(l?.refs.some((r) => r.kind === "decision" && r.id === "X6" && /default 100% business use, undecided/.test(r.label))).toBe(true);
    expect(l?.refs.some((r) => r.kind === "gl" && r.id === "6100")).toBe(true);
    expect(l?.refs.some((r) => /verified/.test(r.label) && !/not verified/.test(r.label))).toBe(false);
  });
  it("the result is its own RuleResult with the two alternatives side by side (full is the default and in force)", () => {
    const r = undecided.results.find((x) => x.ruleId === "schedule-c-business-use:internet_phone");
    expect(r?.lines).toEqual([]);
    expect(r?.status).toBe("computed");
    expect(r?.alternatives?.map((a) => [a.id, a.isDefault, a.inForce, a.status])).toEqual([
      ["full", true, true, "computed"],
      ["recorded", false, false, "not_yet_computed"],
    ]);
    expect(r?.alternatives?.[0]?.effect?.amount?.toNumber()).toBe(2610);
    expect(undecided.results.filter((x) => x.decision !== undefined).map((x) => x.decision?.id)).toEqual(["X1", "X6"].filter((id) => undecided.decisions.some((d) => d.id === id)));
  });
  it("detail.businessUse carries the split; duplicate emissions stay empty; the engine version is 1b.11", () => {
    expect(undecided.scheduleC?.businessUse).toEqual([
      {
        decisionId: "X6",
        accountCode: "6100",
        accountName: INTERNET,
        rawCents: 261_017,
        percentTenths: 1000,
        deductibleCents: 261_017,
        personalCents: 0,
        status: "default_undecided",
        lineId: "25",
        lineAtFullDollars: 2610,
        lineDollars: 2610,
      },
    ]);
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.11");
    expect(undecided.engineVersion).toBe("ty2025-1b.11");
  });
  it("the alias name and the original chart name both resolve to the same list entry", () => {
    for (const name of [INTERNET, "Utilities:Internet & TV services", "  utilities : INTERNET & phone "]) {
      const r = computeTy2025Return(facts({ name }), decide(700));
      expect(amt(r, "schc.25"), name).toBe(1827);
      expect(r.decisions.find((d) => d.id === "X6")?.status, name).toBe("decided");
    }
  });
});

describe("(b) decided 70% on the profit fixture: the whole chain moves consistently", () => {
  const at100 = computeTy2025Return(facts(), {});
  const at70 = computeTy2025Return(facts(), decide(700));

  it("line 25 = 1,827 and 28 / 29 / 31 move by exactly -783 / +783 / +783", () => {
    expect(num(at70, "schc.25")).toBe(1827);
    expect(num(at70, "schc.28") - num(at100, "schc.28")).toBe(-783);
    expect(num(at70, "schc.29") - num(at100, "schc.29")).toBe(783);
    expect(num(at70, "schc.31") - num(at100, "schc.31")).toBe(783);
    expect(num(at100, "schc.31")).toBe(47_390);
    expect(num(at70, "schc.31")).toBe(48_173);
  });
  it("the decision is decided with who and when, and nothing remains undecided from it", () => {
    expect(at70.decisions.find((d) => d.id === "X6")).toMatchObject({ chosen: "70%", status: "decided", decidedBy: "Eric", decidedAt: WHO.at });
    expect(at70.headline.undecidedDecisionCount).toBe(at100.headline.undecidedDecisionCount - 1);
    expect(at70.openItems.some((o) => o.id === "decision:X6")).toBe(false);
    const alts = at70.results.find((r) => r.decision?.id === "X6")?.alternatives;
    expect(alts?.map((a) => [a.id, a.inForce])).toEqual([
      ["full", false],
      ["recorded", true],
    ]);
    expect(alts?.[0]?.effect?.note).toContain("$2,610");
    expect(alts?.[1]?.effect?.note).toContain("$1,827");
    expect(alts?.[1]?.effect?.note).toContain("$783.05");
  });
  it("detail: booked 261,017 cents, 70%, deductible 182,712, personal 78,305 (booked = deductible + personal to the cent)", () => {
    const row = at70.scheduleC?.businessUse[0];
    expect(row).toMatchObject({ rawCents: 261_017, percentTenths: 700, deductibleCents: 182_712, personalCents: 78_305, status: "decided", lineAtFullDollars: 2610, lineDollars: 1827 });
    expect((row?.deductibleCents ?? 0) + (row?.personalCents ?? 0)).toBe(261_017);
  });
  it("line 25 provenance is the owner's statement, not verified by documents", () => {
    const l = at70.lines["schc.25"];
    expect(l?.refs.find((r) => r.kind === "decision")?.label).toBe("Owner decision X6: 70% business use, the owner's statement, not verified by documents");
    expect(l?.reason).toMatch(/70% business use \(decision X6, the owner's statement, not verified by documents\)/);
    expect(l?.reason).toContain("$783.05 personal and not deducted");
  });
  it("SE tax, the half deduction, QBI, Form 8960 line 4b move to the independent reference values", () => {
    for (const [r, np] of [[at100, 47_390], [at70, 48_173]] as const) {
      const ref = refSe(np);
      expect(num(r, "se.6")).toBe(ref.ne);
      expect(num(r, "se.10")).toBe(ref.ss);
      expect(num(r, "se.11")).toBe(ref.med);
      expect(num(r, "se.12")).toBe(ref.total);
      expect(num(r, "sch1.15")).toBe(ref.half);
      expect(num(r, "f8995.1i")).toBe(np - ref.half);
      expect(num(r, "f8995.5")).toBe(roundLine(D(np - ref.half).times("0.2")).toNumber());
      expect(num(r, "f8960.4b")).toBe(-np);
      expect(num(r, "sch1.3")).toBe(np);
    }
    expect(num(at70, "se.12")).toBe(6807);
    expect(num(at100, "se.12")).toBe(6696);
  });
  it("AGI, taxable income and Connecticut AGI move and nothing is left uncomputed", () => {
    expect(num(at70, "f1040.11a")).toBeGreaterThan(num(at100, "f1040.11a"));
    expect(num(at70, "ct1040.ctAgi")).toBeGreaterThan(num(at100, "ct1040.ctAgi"));
    for (const k of Object.keys(at100.lines) as LineKey[]) expect(hasAmount(at70.lines[k]?.status ?? "missing_input"), k).toBe(hasAmount(at100.lines[k]?.status ?? "missing_input"));
    expect(at70.headline.complete).toBe(at100.headline.complete);
  });
});

describe("(c)-(e) 0%, a recorded 100%, decimals", () => {
  const at100 = computeTy2025Return(facts(), {});
  it("0% is a computed $0 (not blocked, not 'not applicable'); line 31 rises by the full 2,610", () => {
    const r = computeTy2025Return(facts(), decide(0));
    const l = r.lines["schc.25"];
    expect(l?.amount).toBe(0);
    expect(l?.status).toBe("computed");
    expect(num(r, "schc.31") - num(at100, "schc.31")).toBe(2610);
    expect(r.decisions.find((d) => d.id === "X6")).toMatchObject({ chosen: "0%", status: "decided" });
    expect(r.scheduleC?.businessUse[0]).toMatchObject({ deductibleCents: 0, personalCents: 261_017 });
  });
  it("a recorded 100% gives the same numbers as the default but is decided, with only the 'full' alternative", () => {
    const r = computeTy2025Return(facts(), decide(1000));
    for (const k of Object.keys(at100.lines) as LineKey[]) {
      expect(r.lines[k]?.amount, k).toBe(at100.lines[k]?.amount);
      expect(r.lines[k]?.status, k).toBe(at100.lines[k]?.status);
    }
    expect(r.decisions.find((d) => d.id === "X6")).toMatchObject({ chosen: "100%", status: "decided" });
    expect(r.results.find((x) => x.decision?.id === "X6")?.alternatives?.map((a) => [a.id, a.inForce])).toEqual([["full", true]]);
    expect(r.headline.undecidedDecisionCount).toBe(at100.headline.undecidedDecisionCount - 1);
  });
  it("70.5% and 33.3% follow the hand table", () => {
    expect(amt(computeTy2025Return(facts(), decide(705)), "schc.25")).toBe(1840);
    expect(amt(computeTy2025Return(facts(), decide(333)), "schc.25")).toBe(869);
    expect(computeTy2025Return(facts(), decide(705)).decisions.find((d) => d.id === "X6")?.chosen).toBe("70.5%");
  });
  it("an invalid percentage handed to the engine is ignored (treated as undecided), never used", () => {
    for (const bad of [-1, 1001, 70.5, Number.NaN]) {
      const r = computeTy2025Return(facts(), decide(bad));
      expect(amt(r, "schc.25"), String(bad)).toBe(2610);
      expect(r.decisions.find((d) => d.id === "X6")?.status, String(bad)).toBe("default_undecided");
    }
  });
});

describe("(f)-(h) other accounts, no X6 when there is nothing to split", () => {
  it("another utilities account on the same line stays at 100% inside the one rounded total", () => {
    const r = computeTy2025Return(facts({ extra: [gl("6200", "Utilities:Phone service", "expense", 120_000)] }), decide(700));
    expect(amt(r, "schc.25")).toBe(1827 + 1200);
    expect(r.scheduleC?.businessUse).toHaveLength(1);
    const alt = r.results.find((x) => x.decision?.id === "X6")?.alternatives?.[0];
    expect(alt?.effect?.amount?.toNumber()).toBe(2610 + 1200);
  });
  it("no booked amount (absent or $0), or no matching account: no X6, no extra result, nothing changes", () => {
    for (const f of [facts({ cents: 0 }), facts({ cents: 0, extra: [gl("6100", INTERNET, "expense", 0)] })]) {
      const r = computeTy2025Return(f, decide(700));
      expect(r.decisions.some((d) => d.id === "X6")).toBe(false);
      expect(r.results.some((x) => x.ruleId.startsWith("schedule-c-business-use:"))).toBe(false);
      expect(r.scheduleC?.businessUse).toEqual([]);
    }
  });
  it("a sign-flipped account is a CPA call as before: no X6 and line 25 is not computed", () => {
    const f = facts({ cents: 0 });
    f.income.scheduleC.glLines.push({ ...gl("6100", INTERNET, "expense", 261_017), signedCents: 261_017 });
    const r = computeTy2025Return(f, decide(700));
    expect(r.decisions.some((d) => d.id === "X6")).toBe(false);
    expect(r.scheduleC?.needsCpa.some((n) => n.code === "6100")).toBe(true);
  });
  it("two GL codes resolving to the same entry (original name + alias) are both scaled by the one decision", () => {
    const f = facts({ cents: 0, extra: [gl("6100", INTERNET, "expense", 100_000), gl("6101", "Utilities:Internet & TV services", "expense", 100_000)] });
    const r = computeTy2025Return(f, decide(500));
    expect(amt(r, "schc.25")).toBe(1000);
    expect(r.scheduleC?.businessUse.map((b) => [b.accountCode, b.deductibleCents, b.personalCents])).toEqual([
      ["6100", 50_000, 50_000],
      ["6101", 50_000, 50_000],
    ]);
    expect(r.decisions.filter((d) => d.id === "X6")).toHaveLength(1);
  });
  it("no duplicate emissions anywhere in the return (undecided and decided)", () => {
    expect(duplicateEmissions(facts(), {})).toEqual([]);
    expect(duplicateEmissions(facts(), decide(700))).toEqual([]);
  });
});

describe("(j) downstream effects on a loss year and on a small profit that meets the home-office limit", () => {
  it("loss year: AGI moves by +783 at 70% and SE tax stays 0", () => {
    const loss100 = computeTy2025Return(facts({ revenueCents: 500_000 }), {});
    const loss70 = computeTy2025Return(facts({ revenueCents: 500_000 }), decide(700));
    expect(num(loss100, "schc.31")).toBe(-7610);
    expect(num(loss70, "schc.31")).toBe(-6827);
    expect(num(loss100, "se.12")).toBe(0);
    expect(num(loss70, "se.12")).toBe(0);
    expect(num(loss70, "f1040.11a") - num(loss100, "f1040.11a")).toBe(783);
  });
  it("simplified home-office limit (line 30 = min($5 x sq ft, line 29)) follows the percentage", () => {
    // line 29 at 100% = 13,110 - 12,610 = 500 -> line 30 = 500; at 70% line 29 = 1,283 -> line 30 = min(1,000, 1,283) = 1,000
    const f = () => facts({ revenueCents: 1_311_000, homeOffice: true });
    const a = computeTy2025Return(f(), {});
    const b = computeTy2025Return(f(), decide(700));
    expect(num(a, "schc.29")).toBe(500);
    expect(num(a, "schc.30")).toBe(500);
    expect(num(a, "schc.31")).toBe(0);
    expect(num(b, "schc.29")).toBe(1283);
    expect(num(b, "schc.30")).toBe(1000);
    expect(num(b, "schc.31")).toBe(283);
  });
  it("the reference SE tax matches the engine on a swept range of profits (guards the reference itself)", () => {
    for (const rev of [1_500_000, 3_000_000, 6_000_000, 9_000_000, 14_000_000]) {
      const r = computeTy2025Return(facts({ revenueCents: rev }), decide(700));
      expect(num(r, "se.12")).toBe(refSe(num(r, "schc.31")).total);
    }
  });
});
