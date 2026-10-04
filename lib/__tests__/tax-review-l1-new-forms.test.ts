import { describe, expect, it } from "vitest";
import { evaluateRule, footingCoverageDrift } from "@/lib/tax-review/l1/footing";
import { FOOTING_RULES } from "@/lib/tax-review/l1/footing-rules";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import type { PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";
import { EVA_ID, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

// The footing / link rules of the two forms the Schedule 1-A / Form 8960 merge added (ai-return-reviewer integration): they are
// evaluated on REAL engine output (Eva's tips and overtime for Schedule 1-A; investment income with the NIIT for Form 8960), the
// lines the form says to skip are skipped and not reported as a mismatch, and every rule fails when its total is moved.

function facts() {
  const f = fullFacts1b();
  f.returnAnswers.magiExclusionsNone = owner(true);
  const eva = f.returnAnswers.people.find((p) => p.userId === EVA_ID)!;
  eva.tipsChoice = owner("some");
  eva.tipsCents = owner(454_580);
  eva.overtimeChoice = owner("premium");
  eva.overtimeCents = owner(240_800);
  eva.validSsn = owner(true);
  f.income.w2s = f.income.w2s.map((x) => (x.personUserId === EVA_ID ? { ...x, socialSecurityTipsCents: 454_580 } : x));
  // AGI over the Form 8960 threshold, itemizing (so line 9b, the state income tax allocation, is not zero)
  const eric = f.income.w2s.find((x) => x.personUserId !== EVA_ID)!;
  eric.wagesCents = (eric.wagesCents ?? 0) + 10_000_000;
  eric.socialSecurityWagesCents = (eric.socialSecurityWagesCents ?? 0) + 10_000_000;
  eric.medicareWagesCents = (eric.medicareWagesCents ?? 0) + 10_000_000;
  f.deductions.mortgages[0]!.interestCents = 4_000_000;
  return f;
}

function viewOf(): PdfReturnView {
  const f = facts();
  const ret = computeTy2025Return(f);
  return toPdfReturnView(ret, f, { generatedAt: "2026-10-04T12:00:00.000Z", generatedBy: "Test", ekcName: "Sample Consulting, LLC" });
}

/** The rule evaluator reads only the view and which forms are filed (formsRequired); nothing else of the context. */
function ctxOf(view: PdfReturnView): L1Context {
  return { view, packet: { files: [], forms: [], openItems: [], continuations: [] } } as unknown as L1Context;
}

function withLines(view: PdfReturnView, mutate: (lines: Partial<Record<string, PdfLine>>) => void): PdfReturnView {
  const v = structuredClone(view);
  mutate(v.lines as Partial<Record<string, PdfLine>>);
  return v;
}

const NEW_RULES = FOOTING_RULES.filter((r) => r.form === "f1040s1a" || r.form === "f8960");

describe("Schedule 1-A and Form 8960 footing rules", () => {
  const view = viewOf();
  const ctx = ctxOf(view);

  it("both forms are required on this return, and a map for each exists", () => {
    expect(view.formsRequired?.sch1a?.required).toBe(true);
    expect(view.formsRequired?.f8960?.required).toBe(true);
    expect(FORM_MAPS.some((m) => m.formId === "f1040s1a")).toBe(true);
    expect(FORM_MAPS.some((m) => m.formId === "f8960")).toBe(true);
    expect(footingCoverageDrift(FORM_MAPS.map((m) => m.formId))).toEqual([]);
  });

  it("every rule of the two forms holds or is skipped on the engine's own output (no mismatch, nothing unproven)", () => {
    expect(NEW_RULES.length).toBeGreaterThanOrEqual(24);
    const bad = NEW_RULES.map((r) => ({ id: r.id, o: evaluateRule(ctx, r) })).filter((x) => x.o.status === "mismatch" || x.o.status === "unproven");
    expect(bad).toEqual([]);
  });

  it("the lines the form says to skip (10-12, 18-20, 27-29, 33-34 of Schedule 1-A) are skipped, never a footing mismatch", () => {
    for (const id of ["sch1a.10", "sch1a.18", "sch1a.27", "sch1a.33"]) {
      const rule = FOOTING_RULES.find((r) => r.id === id);
      expect(rule?.skipWhenNotApplicable, id).toBe(true);
      expect(evaluateRule(ctx, rule!), id).toEqual({ status: "skipped", why: "the form says to skip this line" });
    }
    // lines 13, 21, 30 are carried with the skipped line as zero and still foot
    for (const id of ["sch1a.13", "sch1a.21", "sch1a.30"]) expect(evaluateRule(ctx, FOOTING_RULES.find((r) => r.id === id)!).status, id).toBe("ok");
  });

  it("a line printed blank although the test says it must be filled is a mismatch, not a skip", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "sch1a.10")!;
    // MAGI over the threshold (line 8 400,000 vs line 9 300,000) but line 10 still printed as skipped
    const v = withLines(view, (lines) => {
      const l8 = lines["sch1a.8"];
      if (l8) l8.amount = 400_000;
    });
    const o = evaluateRule(ctxOf(v), rule);
    expect(o.status).toBe("mismatch");
    if (o.status === "mismatch") expect(o.expected).toBe(100_000);
  });

  it("the phase-out line of a computed phase-out is checked: line 10 = line 8 - line 9", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "sch1a.10")!;
    const v = withLines(view, (lines) => {
      const l8 = lines["sch1a.8"];
      const l10 = lines["sch1a.10"];
      if (l8) l8.amount = 301_000;
      if (l10) {
        l10.status = "computed";
        l10.amount = 1_000;
      }
    });
    expect(evaluateRule(ctxOf(v), rule).status).toBe("ok");
    const v2 = withLines(v, (lines) => {
      const l10 = lines["sch1a.10"];
      if (l10) l10.amount = 2_000;
    });
    expect(evaluateRule(ctxOf(v2), rule).status).toBe("mismatch");
  });

  it("every rule that is evaluated fails when its total is moved by one dollar (the rules are not vacuous)", () => {
    let mutated = 0;
    for (const rule of NEW_RULES) {
      if (evaluateRule(ctx, rule).status !== "ok") continue;
      const broken = withLines(view, (lines) => {
        const l = lines[rule.total];
        if (l?.amount !== null && l?.amount !== undefined) l.amount += 1;
      });
      expect(evaluateRule(ctxOf(broken), rule).status, rule.id).toBe("mismatch");
      mutated += 1;
    }
    expect(mutated).toBeGreaterThanOrEqual(15);
  });

  it("line 16 of Form 8960 is the smaller of lines 12 and 15 (a form that prints the larger one is caught)", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "f8960.16")!;
    expect(rule.combine).toBe("min");
    const n12 = view.lines["f8960.nii"]?.amount ?? 0;
    const n15 = view.lines["f8960.15"]?.amount ?? 0;
    expect(evaluateRule(ctx, rule).status).toBe("ok");
    const v = withLines(view, (lines) => {
      const l16 = lines["f8960.16"];
      if (l16) l16.amount = Math.max(n12, n15) + (n12 === n15 ? 1 : 0);
    });
    expect(evaluateRule(ctxOf(v), rule).status).toBe("mismatch");
  });

  it("Schedule 2 line 12 carries Form 8960 line 17 (the link rule from the Schedule 2 side)", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "sch2.12")!;
    expect(evaluateRule(ctx, rule).status).toBe("ok");
  });
});
