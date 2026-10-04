import { describe, expect, it } from "vitest";
import type { Decimal } from "@prisma/client/runtime/library";
import { D } from "@/lib/tax2025/money";
import { computeForm8959, computeScheduleSe } from "@/lib/tax2025/rules/se-medicare";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}
function statusOf(r: RuleResult, key: LineKey): string | undefined {
  return r.lines.find((x) => x.key === key)?.status;
}

// Hand-computed against the Schedule SE form (f1040sse.pdf, 2025): line 4a = line 3 x 92.35%;
// line 4c < $400 stops; line 7 = $176,100; line 8a = W-2 boxes 3 + 7; line 9 = 7 - 8d (not below 0);
// line 10 = smaller of line 6 or line 9, x 12.4%; line 11 = line 6 x 2.9%; line 12 = 10 + 11;
// line 13 = line 12 x 50%. Every line rounded to whole dollars (1040 instructions rounding rule).

describe("Schedule SE (computeScheduleSe)", () => {
  it("W-2 SS wages of exactly $176,100 exhaust the base: Medicare-only (acceptance 2)", () => {
    // net $60,000: 4a = 55,410; line 9 = 0; line 10 = 0; line 11 = 55,410 x .029 = 1,606.89 -> 1,607;
    // line 12 = 1,607; line 13 = 803.5 -> 804
    const r = computeScheduleSe({ netProfit: D(60000), ssWagesAndTips: D(176100), ownerLabel: "Eric" });
    expect(r.status).toBe("computed");
    expect(amt(r, "se.4a")).toBe("55410");
    expect(amt(r, "se.9")).toBe("0");
    expect(amt(r, "se.10")).toBe("0");
    expect(amt(r, "se.11")).toBe("1607");
    expect(amt(r, "se.12")).toBe("1607");
    expect(amt(r, "se.13")).toBe("804");
    expect(amt(r, "sch2.4")).toBe("1607");
    expect(amt(r, "sch1.15")).toBe("804");
    expect(r.reasons.join(" ")).toContain("use up");
  });

  it("W-2 SS wages above the base also give Medicare-only", () => {
    const r = computeScheduleSe({ netProfit: D(60000), ssWagesAndTips: D(200000) });
    expect(amt(r, "se.9")).toBe("0");
    expect(amt(r, "se.10")).toBe("0");
    expect(amt(r, "se.12")).toBe("1607");
  });

  it("W-2 SS wages of $150,000: OASDI base is at most $26,100 (acceptance 2)", () => {
    // line 9 = 176,100 - 150,000 = 26,100; line 10 = 26,100 x .124 = 3,236.40 -> 3,236;
    // line 11 = 1,607; line 12 = 4,843; line 13 = 2,421.5 -> 2,422
    const r = computeScheduleSe({ netProfit: D(60000), ssWagesAndTips: D(150000) });
    expect(amt(r, "se.9")).toBe("26100");
    expect(amt(r, "se.10")).toBe("3236");
    expect(amt(r, "se.12")).toBe("4843");
    expect(amt(r, "se.13")).toBe("2422");
  });

  it("partial base: net $20,000 with $170,000 W-2 SS wages", () => {
    // 4a = 18,470; line 9 = 6,100; line 10 = min(18,470, 6,100) x .124 = 756.4 -> 756;
    // line 11 = 18,470 x .029 = 535.63 -> 536; line 12 = 1,292; line 13 = 646
    const r = computeScheduleSe({ netProfit: D(20000), ssWagesAndTips: D(170000) });
    expect(amt(r, "se.4a")).toBe("18470");
    expect(amt(r, "se.9")).toBe("6100");
    expect(amt(r, "se.10")).toBe("756");
    expect(amt(r, "se.11")).toBe("536");
    expect(amt(r, "se.12")).toBe("1292");
    expect(amt(r, "se.13")).toBe("646");
  });

  it("no W-2 Social Security wages: full 15.3% on net earnings", () => {
    // line 10 = 55,410 x .124 = 6,870.84 -> 6,871; line 11 = 1,607; line 12 = 8,478; line 13 = 4,239
    const r = computeScheduleSe({ netProfit: D(60000), ssWagesAndTips: D(0) });
    expect(amt(r, "se.10")).toBe("6871");
    expect(amt(r, "se.12")).toBe("8478");
    expect(amt(r, "se.13")).toBe("4239");
  });

  it("net earnings under $400 give $0 SE tax (line 4c floor)", () => {
    // net $400 -> 4a = 369.4 -> 369 < 400 -> no tax
    const r = computeScheduleSe({ netProfit: D(400), ssWagesAndTips: null });
    expect(r.status).toBe("computed");
    expect(amt(r, "se.4c")).toBe("369");
    expect(amt(r, "se.12")).toBe("0");
    expect(amt(r, "sch2.4")).toBe("0");
    expect(amt(r, "sch1.15")).toBe("0");
    expect(statusOf(r, "se.6")).toBe("not_applicable");
    // wages are not needed when the floor applies (still not a silent 0: the reason says why)
    expect(r.reasons.join(" ")).toContain("floor");
  });

  it("the $400 floor boundary uses the rounded line 4c: $433 rounds to $400 and is taxed", () => {
    // 433 x .9235 = 399.88 -> 400 (not less than 400): line 10 = 400 x .124 = 49.6 -> 50;
    // line 11 = 400 x .029 = 11.6 -> 12; line 12 = 62; line 13 = 31
    const r = computeScheduleSe({ netProfit: D(433), ssWagesAndTips: D(0) });
    expect(amt(r, "se.4c")).toBe("400");
    expect(amt(r, "se.12")).toBe("62");
    expect(amt(r, "se.13")).toBe("31");
    // $432 -> 398.95 -> 399: under the floor
    const under = computeScheduleSe({ netProfit: D(432), ssWagesAndTips: D(0) });
    expect(amt(under, "se.4c")).toBe("399");
    expect(amt(under, "se.12")).toBe("0");
  });

  it("a Schedule C loss gives $0 SE tax", () => {
    const r = computeScheduleSe({ netProfit: D(-5000), ssWagesAndTips: D(0) });
    expect(r.status).toBe("computed");
    expect(amt(r, "se.12")).toBe("0");
  });

  it("missing net profit -> missing_input on every line, never 0", () => {
    const r = computeScheduleSe({ netProfit: null, ssWagesAndTips: D(0) });
    expect(r.status).toBe("missing_input");
    expect(r.lines.every((l) => l.amount === null && l.status === "missing_input")).toBe(true);
    expect(r.inputsMissing.length).toBe(1);
  });

  it("missing W-2 SS wages with net >= $400 -> Medicare part computed, the rest missing_input", () => {
    const r = computeScheduleSe({ netProfit: D(60000), ssWagesAndTips: null, ownerLabel: "Eric" });
    expect(r.status).toBe("missing_input");
    expect(amt(r, "se.11")).toBe("1607");
    expect(amt(r, "se.10")).toBeNull();
    expect(amt(r, "se.12")).toBeNull();
    expect(amt(r, "sch2.4")).toBeNull();
    expect(r.inputsMissing[0]).toContain("Eric");
  });

  it("every emitted amount is a whole dollar", () => {
    const r = computeScheduleSe({ netProfit: D("12345.67"), ssWagesAndTips: D("111111.11") });
    for (const l of r.lines) {
      if (l.amount !== null) expect(Number.isInteger((l.amount as Decimal).toNumber())).toBe(true);
    }
  });
});

// Hand-computed against Form 8959 (2025 instructions): Part I line 7 = 0.9% of (wages - $250,000 MFJ);
// Part III line 11 = threshold - wages (not below 0), line 12 = SE earnings - line 11, line 13 = 0.9%;
// Part IV line 18 = 7 + 13 (to Schedule 2 line 11); Part V line 22 = box 6 - 1.45% x wages (not below 0),
// line 24 to 1040 line 25c. Required if any W-2 box 5 > $200,000 or wages + SE > $250,000.

describe("Form 8959 (computeForm8959)", () => {
  it("not required below the thresholds: not_applicable zeros with a reason (not silent)", () => {
    const r = computeForm8959({ medicareWages: D(130000), largestBox5: D(90000), medicareWithheld: D(1885), seNetEarnings: D(0) });
    expect(r.status).toBe("not_applicable");
    expect(amt(r, "sch2.11")).toBe("0");
    expect(amt(r, "f1040.25c")).toBe("0");
    expect(statusOf(r, "f1040.25c")).toBe("not_applicable");
    expect(r.reasons[0]).toContain("not required");
  });

  it("wages $340,000 MFJ (largest $300,000): tax $810; Part V credit = box 6 - 1.45% x wages = $900", () => {
    // Eric W-2: box 5 300,000, box 6 = 4,350 + 900 = 5,250; Eva: box 5 40,000, box 6 580.
    // line 7 = (340,000 - 250,000) x .9% = 810; line 21 = 340,000 x 1.45% = 4,930; line 22 = 5,830 - 4,930 = 900
    const r = computeForm8959({ medicareWages: D(340000), largestBox5: D(300000), medicareWithheld: D(5830), seNetEarnings: D(0) });
    expect(r.status).toBe("computed");
    expect(amt(r, "f8959.7")).toBe("810");
    expect(amt(r, "f8959.13")).toBe("0");
    expect(amt(r, "f8959.18")).toBe("810");
    expect(amt(r, "sch2.11")).toBe("810");
    expect(amt(r, "f8959.22")).toBe("900");
    expect(amt(r, "f1040.25c")).toBe("900");
  });

  it("SE earnings are measured above the threshold LEFT after wages (Part III)", () => {
    // wages 340,000 -> line 11 = max(0, 250,000 - 340,000) = 0; line 12 = 55,410; line 13 = 498.69 -> 499;
    // line 18 = 810 + 499 = 1,309
    const r = computeForm8959({ medicareWages: D(340000), largestBox5: D(300000), medicareWithheld: D(5830), seNetEarnings: D(55410) });
    expect(amt(r, "f8959.13")).toBe("499");
    expect(amt(r, "f8959.18")).toBe("1309");
  });

  it("wages $200,000 + SE $100,000: Part III uses the $50,000 of threshold left", () => {
    // line 7 = 0; line 11 = 250,000 - 200,000 = 50,000; line 12 = 100,000 - 50,000 = 50,000; line 13 = 450;
    // required because wages + SE = 300,000 > 250,000. Part V: box 6 2,900 - 1.45% x 200,000 (2,900) = 0
    const r = computeForm8959({ medicareWages: D(200000), largestBox5: D(200000), medicareWithheld: D(2900), seNetEarnings: D(100000) });
    expect(amt(r, "f8959.7")).toBe("0");
    expect(amt(r, "f8959.13")).toBe("450");
    expect(amt(r, "sch2.11")).toBe("450");
    expect(amt(r, "f1040.25c")).toBe("0");
  });

  it("wages + SE exactly at $250,000 is NOT required (strictly over); one dollar more is", () => {
    const at = computeForm8959({ medicareWages: D(200000), largestBox5: D(200000), medicareWithheld: D(2900), seNetEarnings: D(50000) });
    expect(at.status).toBe("not_applicable");
    const over = computeForm8959({ medicareWages: D(200000), largestBox5: D(200000), medicareWithheld: D(2900), seNetEarnings: D(50001) });
    expect(over.status).toBe("computed");
    expect(amt(over, "f8959.13")).toBe("0"); // (50,001 - 50,000) x .9% = 0.009 -> 0
  });

  it("one W-2 with box 5 over $200,000 makes the form required even if combined wages are lower per threshold logic", () => {
    const r = computeForm8959({ medicareWages: D(200001), largestBox5: D(200001), medicareWithheld: D("2900.01"), seNetEarnings: D(0) });
    expect(r.status).not.toBe("not_applicable");
    expect(r.reasons[0]).toContain("required");
  });

  it("missing Medicare wages -> missing_input, no amounts", () => {
    const r = computeForm8959({ medicareWages: null, largestBox5: null, medicareWithheld: null, seNetEarnings: D(0) });
    expect(r.status).toBe("missing_input");
    expect(r.lines.every((l) => l.amount === null)).toBe(true);
  });

  it("missing box 6 -> tax lines computed, Part V / 25c missing_input", () => {
    const r = computeForm8959({ medicareWages: D(340000), largestBox5: D(300000), medicareWithheld: null, seNetEarnings: D(0) });
    expect(amt(r, "sch2.11")).toBe("810");
    expect(amt(r, "f1040.25c")).toBeNull();
    expect(statusOf(r, "f1040.25c")).toBe("missing_input");
  });

  it("missing SE net earnings -> Part III / total missing_input", () => {
    const r = computeForm8959({ medicareWages: D(340000), largestBox5: D(300000), medicareWithheld: D(5830), seNetEarnings: null });
    expect(amt(r, "f8959.7")).toBe("810");
    expect(amt(r, "sch2.11")).toBeNull();
    expect(r.status).toBe("missing_input");
  });
});
