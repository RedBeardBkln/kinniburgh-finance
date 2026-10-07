// Engine ty2025-1b.7: the findings of the independent L2 recalculation, each fixed with a citation (specs/09):
//   1. Form 8995 lines 16 / 17 (the qualified business loss carryforward), lines 3 / 4 / 7 / 8 as printed, Form 8995 filed for a loss year;
//   2. Form 6251 lines 1a / 1b / 2a (the Schedule 1-A senior deduction add-back, a negative line 1b, Schedule A line 7), label of the
//      tentative minimum tax (line 9);
//   3. Schedule A line 14 adds the printed whole-dollar lines 11 + 12 + 13 (decision D3).
// Whole-return tests on synthetic households (never the real return). Rule-level examples live in tax2025-qbi-8995.test.ts,
// tax2025-screens.test.ts and tax2025-schedule-a.test.ts.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { LINE_KEYS, lineMeta } from "@/lib/tax2025/line-catalog";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { computeTy2025Return, duplicateEmissions, TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { fullFacts1b, gl, owner } from "./tax2025-fixtures";
import { readAllFields } from "./tax2025-pdf-harness";

const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;

/** fullFacts1b with Schedule C line 31 = -9,010 (revenue 21,000.00, expenses 30,010.00): a loss year, every statement answered "none". */
function lossFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.income.scheduleC.glLines = [
    gl("4000", "Services", "revenue", 2_100_000),
    gl("5010", "Office expenses:Software & apps", "expense", 1_500_000),
    gl("5020", "Insurance:Business insurance", "expense", 1_501_000),
  ];
  return f;
}

describe("engine version", () => {
  it("is ty2025-1b.11 (1b.8 plus the business-use percentage decision X6, plus the overpayment decisions X7 / X8)", () => {
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.11");
  });
});

describe("line catalog (engine ty2025-1b.7)", () => {
  it("Form 8995 lines 16 and 17 are computed lines (no longer a 'none' statement group); lines 3 and 7 still are", () => {
    expect(lineMeta("f8995.16").group).toBeUndefined();
    expect(lineMeta("f8995.17").group).toBeUndefined();
    expect(lineMeta("f8995.3").group).toBe("qbi_carryforwards");
    expect(lineMeta("f8995.7").group).toBe("qbi_carryforwards");
  });
  it("the tentative minimum tax is Form 6251 line 9 (line 8 is the foreign tax credit, line 10 the regular tax)", () => {
    expect(lineMeta("f6251.tmt").formLine).toBe("9");
    expect(LINE_KEYS).toContain("f6251.tmt");
  });
});

describe("G1: a Schedule C loss year (Form 8995 line 16)", () => {
  const facts = lossFacts();
  const ret = computeTy2025Return(facts);

  it("Schedule C is -9,010 and the QBI deduction is 0", () => {
    expect(amt(ret, "schc.31")).toBe(-9010);
    expect(amt(ret, "f8995.1i")).toBe(-9010);
    expect(amt(ret, "f8995.2")).toBe(-9010);
    expect(amt(ret, "f8995.4")).toBe(0);
    expect(amt(ret, "f8995.15")).toBe(0);
    expect(amt(ret, "f1040.13a")).toBe(0);
  });

  it("lines 3 and 7 are the stated 'none' (not_applicable 0); line 16 = -9,010 computed; line 17 = 0", () => {
    expect(st(ret, "f8995.3")).toBe("not_applicable");
    expect(st(ret, "f8995.7")).toBe("not_applicable");
    expect(amt(ret, "f8995.3")).toBe(0);
    expect(amt(ret, "f8995.16")).toBe(-9010);
    expect(st(ret, "f8995.16")).toBe("computed");
    expect(amt(ret, "f8995.17")).toBe(0);
    expect(st(ret, "f8995.17")).toBe("computed");
  });

  it("no key is emitted twice", () => {
    expect(duplicateEmissions(facts)).toEqual([]);
  });

  it("Form 8995 is required (a loss is carried to 2026), and the reason says so WITHOUT the amount (the open item states it once)", () => {
    const req = ret.formsRequired.f8995;
    expect(req?.required).toBe(true);
    expect(req?.reason).toContain("carried forward to 2026");
    expect(req?.reason).toContain("lines 16 and 17");
    expect(req?.reason).not.toMatch(/\$/);
  });

  it("the advisory open item names the amount, the line and 2026, and is not blocking", () => {
    const item = ret.openItems.find((o) => o.id === "qbi-carryforward-out");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("$9,010");
    expect(item?.message).toContain("2026");
    expect(item?.message).toContain("line 16");
    expect(item?.message).toContain("does not change your 2025 tax");
    expect(item?.lineKeys).toEqual(["f8995.16"]);
    expect(ret.openItems.filter((o) => o.severity === "blocking")).toEqual([]);
  });

  it("the carryforward has no 2025 tax effect: 13a is 0 and taxable income is AGI minus the deductions only", () => {
    const agi = amt(ret, "f1040.11b") ?? NaN;
    const ded = amt(ret, "f1040.12e") ?? NaN;
    const s1a = amt(ret, "f1040.13b") ?? NaN;
    expect(amt(ret, "f1040.13a")).toBe(0);
    expect(amt(ret, "f1040.15")).toBe(Math.max(0, agi - ded - s1a));
    expect(amt(ret, "f1040.14")).toBe(ded + s1a);
  });

  it("the review sheet's QBI card tells the owner the 2026 carryforward amount exactly once", () => {
    const text = buildCardConclusions(ret)["qbi-deduction"]?.text ?? "";
    expect(text).toContain("Form 8995 required");
    expect(text).toContain("carried forward to 2026");
    expect(text).toContain("Amount carried to 2026: $9,010 (Form 8995 line 16)");
    expect(text.split("$9,010")).toHaveLength(2);
    expect(text.split("2026")).toHaveLength(3); // the reason and the amount clause: each names 2026 once, no third statement
  });
});

describe("G2: the packet contains Form 8995 with the loss in the printed parentheses", () => {
  const OPTS = { generatedAt: "2026-10-04T16:00:00.000Z", generatedBy: "Test User" } as const;
  const P = "topmostSubform[0].Page1[0].";

  it("Form 8995 is in the packet; line 1i / 2 read -9,010, 4 and 15 read 0, line 16 reads 9,010 (magnitude, the form prints the parentheses), 17 is blank", async () => {
    const facts = lossFacts();
    const ret = computeTy2025Return(facts);
    const view = toPdfReturnView(ret, facts, OPTS);
    const packet = await buildPacket(view, { maps: FORM_MAPS, stamp: false });
    const file = packet.files.find((f) => f.formId === "f8995");
    expect(file, "Form 8995 is in the zip").toBeDefined();
    const entry = packet.forms.find((f) => f.formId === "f8995");
    expect(entry?.included).toBe(true);
    expect(entry?.reason).toContain("carried forward to 2026");
    const f = await readAllFields(file!.bytes);
    expect(f.get(`${P}Table[0].Row1i[0].f1_05[0]`)).toBe("-9,010");
    expect(f.get(`${P}Line2_ReadOrder[0].f1_18[0]`)).toBe("-9,010");
    expect(f.get(`${P}f1_19[0]`)).toBe(""); // line 3, none
    expect(f.get(`${P}f1_20[0]`)).toBe("0"); // line 4
    expect(f.get(`${P}f1_21[0]`)).toBe(""); // line 5, computed zero
    expect(f.get(`${P}f1_31[0]`)).toBe("0"); // line 15
    expect(f.get(`${P}f1_32[0]`)).toBe("9,010"); // line 16
    expect(f.get(`${P}f1_33[0]`)).toBe(""); // line 17
    // identification stays blank by design
    expect(f.get(`${P}f1_02[0]`)).toBe("");
    expect(f.get(`${P}Table[0].Row1i[0].f1_04[0]`)).toBe("");
  });

  it("the cover lists the carryforward open item and the Form 8995 reason", async () => {
    const facts = lossFacts();
    const ret = computeTy2025Return(facts);
    const view = toPdfReturnView(ret, facts, OPTS);
    const packet = await buildPacket(view, { maps: FORM_MAPS, stamp: false });
    const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: [], stamp: false });
    const text = model.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");
    expect(text).toContain("A qualified business loss of $9,010 carries forward to 2026");
    expect(text).toContain("carried forward to 2026");
    // the amount is stated once on the cover: in the open item, not again in the "Forms in this packet" reason
    expect(text.split("\n").filter((l) => l.includes("2026") && l.includes("$9,010"))).toHaveLength(1);
    expect(text.split("carried forward to 2026")).toHaveLength(2); // the forms reason names the fact once, without the amount
  });
});

describe("G3: the carryforward waits for the owner's 'none' statement and for the Form 8995 limit", () => {
  it("statement not made: line 16 is not final, no open-item amount, Form 8995 is 'blocking'", () => {
    const f = lossFacts();
    delete f.statedNone.qbi_carryforwards;
    const r = computeTy2025Return(f);
    expect(st(r, "f8995.16")).toBe("not_yet_computed");
    expect(amt(r, "f8995.16")).toBeNull();
    expect(st(r, "f8995.17")).toBe("not_yet_computed");
    expect(r.openItems.some((o) => o.id === "qbi-carryforward-out")).toBe(false);
    expect(r.formsRequired.f8995?.required).toBe("blocking");
    expect(duplicateEmissions(f)).toEqual([]);
  });

  it("answered 'Yes, some': line 16 needs the CPA (the carry-in amount is not computed), no open-item amount", () => {
    const f = lossFacts();
    f.statedNone.qbi_carryforwards = owner(false);
    const r = computeTy2025Return(f);
    expect(st(r, "f8995.16")).toBe("needs_cpa_judgment");
    expect(amt(r, "f8995.16")).toBeNull();
    expect(r.openItems.some((o) => o.id === "qbi-carryforward-out")).toBe(false);
  });

  it("taxable income above $394,600: lines 16 and 17 carry the rule's blocking status (never absent, never 0)", () => {
    const f = lossFacts();
    const first = f.income.w2s[0];
    if (!first) throw new Error("fixture has no W-2");
    f.income.w2s[0] = { ...first, wagesCents: 60_000_000, medicareWagesCents: 60_000_000 };
    const r = computeTy2025Return(f);
    expect((amt(r, "f1040.11b") ?? 0) - (amt(r, "f1040.12e") ?? 0)).toBeGreaterThan(394_600);
    expect(st(r, "f1040.13a")).toBe("needs_cpa_judgment");
    expect(st(r, "f8995.16")).toBe("needs_cpa_judgment");
    expect(st(r, "f8995.17")).toBe("needs_cpa_judgment");
    expect(amt(r, "f8995.16")).toBeNull();
    expect(duplicateEmissions(f)).toEqual([]);
  });
});

describe("G4: a profit year is unchanged", () => {
  const facts = fullFacts1b();
  const ret = computeTy2025Return(facts);

  it("the deduction is claimed, line 16 and 17 are computed 0, Form 8995 is required for the deduction and no carryforward item appears", () => {
    expect(amt(ret, "f1040.13a") ?? 0).toBeGreaterThan(0);
    expect(amt(ret, "f8995.16")).toBe(0);
    expect(st(ret, "f8995.16")).toBe("computed");
    expect(amt(ret, "f8995.17")).toBe(0);
    expect(ret.formsRequired.f8995).toEqual({ required: true, reason: "A qualified business income deduction is claimed." });
    expect(ret.openItems.some((o) => o.id === "qbi-carryforward-out")).toBe(false);
  });

  it("the review sheet clause carries no carryforward sentence", () => {
    expect(buildCardConclusions(ret)["qbi-deduction"]?.text ?? "").not.toContain("carries forward");
  });

  it("a break-even Schedule C year (net 0): no deduction, no loss, so no Form 8995", () => {
    const f = fullFacts1b();
    f.income.scheduleC.glLines = [
      gl("4000", "Services", "revenue", 1_000_000),
      gl("5010", "Office expenses:Software & apps", "expense", 1_000_000),
    ];
    const r = computeTy2025Return(f);
    expect(amt(r, "schc.31")).toBe(0);
    expect(amt(r, "f1040.13a")).toBe(0);
    expect(amt(r, "f8995.16")).toBe(0);
    expect(r.formsRequired.f8995).toEqual({ required: false, reason: "No QBI deduction and no qualified business loss carryforward." });
  });
});

describe("G5: Form 6251 through the whole return", () => {
  /** Both spouses born before January 2, 1961 with a valid SSN: the senior deduction is claimed on Schedule 1-A line 37. */
  function seniorFacts(): Ty2025Facts {
    const f = fullFacts1b();
    f.returnAnswers.magiExclusionsNone = owner(true);
    for (const p of f.returnAnswers.people) {
      p.bornBefore1961 = owner(true);
      p.validSsn = owner(true);
    }
    return f;
  }

  it("a senior household: line 37 is added back, AMTI = line 1b + line 2a (hand-computed from the engine's own lines)", () => {
    const r = computeTy2025Return(seniorFacts());
    const s37 = amt(r, "sch1a.37") ?? NaN;
    expect(s37).toBeGreaterThan(0);
    const l1a = (amt(r, "f1040.14") ?? NaN) - s37;
    const l1b = (amt(r, "f1040.11b") ?? NaN) - l1a;
    // not itemizing: line 2a is the standard deduction, Form 1040 line 12e
    expect(amt(r, "scha.17") ?? 0).toBeLessThan(amt(r, "f1040.12e") ?? 0);
    expect(amt(r, "f6251.amti")).toBe(l1b + (amt(r, "f1040.12e") ?? NaN));
    // the old screen (taxable income + add-back) would have been lower by exactly line 37
    expect(amt(r, "f6251.amti")).toBe((amt(r, "f1040.15") ?? NaN) + (amt(r, "f1040.12e") ?? NaN) + s37);
    expect(amt(r, "sch2.2")).toBe(0);
  });

  it("without a senior deduction the screen is the old figure: AMTI = taxable income + line 12e", () => {
    const r = computeTy2025Return(fullFacts1b());
    expect(amt(r, "sch1a.37")).toBe(0);
    expect(amt(r, "f6251.amti")).toBe((amt(r, "f1040.15") ?? NaN) + (amt(r, "f1040.12e") ?? NaN));
    expect(amt(r, "sch2.2")).toBe(0);
    expect(r.formsRequired.f6251?.required).toBe(false);
  });

  it("a stated Schedule 1-A total above 0 has no line 37: the AMT screen says so instead of guessing; a stated 0 is fine", () => {
    const stated = fullFacts1b();
    stated.adjustments.sch1a = owner(700_000);
    const r = computeTy2025Return(stated);
    expect(st(r, "f6251.amti")).toBe("missing_input");
    expect(r.lines["f6251.amti"]?.reason ?? "").toContain("Schedule 1-A line 37");
    const zero = fullFacts1b();
    zero.adjustments.sch1a = owner(0);
    const z = computeTy2025Return(zero);
    expect(st(z, "f6251.amti")).toBe("computed");
  });

  it("the return passes Schedule A line 7 (not 5e) as the itemized add-back, and Form 1040 lines 11b / 14 and Schedule 1-A line 37", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "tax2025", "return.ts"), "utf8").replace(/\r\n/g, "\n");
    const call = src.slice(src.indexOf("computeAmtScreen({"), src.indexOf("A.register(amtScreen"));
    expect(call).toContain('scheduleATaxes: A.num("scha.7")');
    expect(call).toContain('agi: A.num("f1040.11b")');
    expect(call).toContain('deductionsLine14: A.num("f1040.14")');
    expect(call).not.toContain("scha.5e");
  });

  it("an itemizing household's AMTI adds back Schedule A line 7", () => {
    const f = fullFacts1b();
    const m = f.deductions.mortgages[0];
    if (!m) throw new Error("fixture has no mortgage");
    m.interestCents = 3_000_000;
    const r = computeTy2025Return(f);
    expect(amt(r, "scha.17") ?? 0).toBeGreaterThan(amt(r, "std.total") ?? 0);
    const l1b = (amt(r, "f1040.11b") ?? NaN) - ((amt(r, "f1040.14") ?? NaN) - (amt(r, "sch1a.37") ?? 0));
    expect(amt(r, "f6251.amti")).toBe(l1b + (amt(r, "scha.7") ?? NaN));
  });
});

describe("Schedule A line 14 through the return (decision D3: the printed lines add)", () => {
  it("line 14 = line 11 + line 12 for a log with cents", () => {
    const f = fullFacts1b();
    f.deductions.noDonationsConfirmed = owner(false);
    f.deductions.donations = [
      { id: "d1", dateIso: "2025-03-01", recipient: "Charity A", kind: "cash", amountCents: 10_040, substantiation: "written_acknowledgment", receiptDocumentId: "r1" },
      { id: "d2", dateIso: "2025-04-01", recipient: "Charity B", kind: "noncash", amountCents: 20_040, substantiation: "written_acknowledgment", receiptDocumentId: "r2" },
    ];
    const r = computeTy2025Return(f);
    expect(amt(r, "scha.11")).toBe(100);
    expect(amt(r, "scha.12")).toBe(200);
    expect(amt(r, "scha.14")).toBe(300);
  });
});
