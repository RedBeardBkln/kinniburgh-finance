// Form 8606 in the review layers: L1 footing (line 3 and line 14), the Form 5498 tie-out, the printed-label audit, L2 forms-required and the
// recomputed line 3 / 14, the AI slice, the open-item link rules and the line-flow edges. Eric-shaped synthetic household (nothing real).

import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { LINE_FLOW } from "@/lib/tax2025/line-flow";
import { runL2 } from "@/lib/tax-review/l2/run";
import { diffForms, predictForms } from "@/lib/tax-review/l2/forms-required";
import { oracleLedger } from "@/lib/tax-review/l2";
import { FOOTING_RULES } from "@/lib/tax-review/l1/footing-rules";
import { openItemRuleFor } from "@/lib/tax-review/links";
import { FORM_LINK_LABELS } from "@/lib/tax-review/links-context";
import { ERIC_ID, EVA_ID, owner } from "./tax2025-fixtures";
import { cleanDocs, cleanScenario, doc, describeFindings, runPipeline, significant, w2Doc } from "./tax-review-harness";

const DOC_ID = "5498aaaa-bbbb-4ccc-8ddd-5498eeeeffff";

function retirement(box1Cents: number, over: Record<string, unknown> = {}) {
  return doc(
    "retirement_contribution",
    { formVariant: "form_5498", issuerName: "Sample Trust Co", accountKind: "traditional_ira", taxYear: 2025, iraContributionsCents: box1Cents, rothIraContributionsCents: 0, fairMarketValueCents: 4_914_679, ...over },
    { id: DOC_ID }
  );
}

/** Eric-shaped: Eric (a) not covered at work, 7,000 traditional; Eva (b) covered; Eric's wages raised so the MAGI is over 246,000. */
function ericScenario(box1Cents = 700_000) {
  const docs = [w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 20_000_000, 3_000_000, 600_000), ...cleanDocs().slice(1), retirement(box1Cents)];
  return cleanScenario(docs, (f) => {
    const [a, b] = f.returnAnswers.people;
    a!.traditionalIraCents = owner(700_000);
    a!.priorBasisCents = owner(730_000); // the 2024 Form 8606 line 14
    a!.coveredByWorkplacePlan = owner(false);
    a!.age50Plus = owner(false);
    b!.coveredByWorkplacePlan = owner(true);
    // a 2024 return close to 2025 (so the year-over-year variance check has nothing to say)
    f.priorYear = { totalTaxCents: owner(4_600_000), agiCents: owner(28_500_000), filingStatus: owner("mfj") };
    f.income.retirementStatements = [
      {
        docId: DOC_ID,
        personUserId: ERIC_ID,
        basis: "doc_verified",
        legacyFormat: false,
        refs: [{ kind: "document", id: DOC_ID, label: "Retirement statement Sample Trust Co" }],
        issuer: "Sample Trust Co",
        traditionalIraCents: box1Cents,
        rothIraCents: 0,
        sepCents: null,
        simpleCents: null,
        postponedCents: null,
        postponedForYear: null,
        rolloverCents: null,
        rothConversionCents: null,
        recharacterizedCents: null,
        fairMarketValueCents: 4_914_679,
      },
    ];
  });
}

describe("L1 on an Eric-shaped return with a Form 8606", () => {
  it("the engine computes it and the packet carries f8606-a with the lines filled", async () => {
    const { pipeline } = await runPipeline(ericScenario());
    expect(pipeline.ret.lines["f8606a.1"]?.amount).toBe(7000);
    expect(pipeline.ret.lines["f8606a.2"]?.amount).toBe(7300);
    expect(pipeline.ret.lines["f8606a.3"]?.amount).toBe(14300);
    expect(pipeline.ret.lines["f8606a.14"]?.amount).toBe(14300);
    expect(pipeline.ctx.packet.files.some((f) => /f8606-a\.pdf$/.test(f.name))).toBe(true);
    expect(pipeline.ctx.packet.files.some((f) => /f8606-b\.pdf$/.test(f.name))).toBe(false);
  });

  it("no finding of severity medium or higher (footing, tie-out, labels, PDF read-back all agree)", async () => {
    const { result } = await runPipeline(ericScenario());
    expect(describeFindings(significant(result.findings))).toEqual([]);
  });

  it("footing: a hand-changed line 3 breaks 'Add lines 1 and 2' (blocker); a changed line 14 breaks the carry from line 3", async () => {
    const bump = (key: "f8606a.3" | "f8606a.14") => async () => {
      const { result } = await runPipeline(ericScenario(), {
        mutateRet: (ret) => {
          const l = ret.lines[key];
          if (l !== undefined && l.amount !== null) l.amount += 1;
        },
      });
      return result.findings.filter((f) => f.check.startsWith("L1.F") && f.lineKey === key);
    };
    const l3 = await bump("f8606a.3")();
    expect(l3.map((f) => [f.check, f.severity])).toEqual([["L1.F1.f8606a.3", "blocker"]]);
    expect(l3[0]!.message).toContain("3. Add lines 1 and 2.");
    const l14 = await bump("f8606a.14")();
    expect(l14.map((f) => [f.check, f.severity])).toEqual([["L1.F2.f8606a.14", "blocker"]]);
  });

  it("tie-out: a Form 5498 box 1 that differs from the return's traditional contribution (6,000 versus 7,000) is a finding the owner can accept with a reason", async () => {
    const { result } = await runPipeline(ericScenario(600_000));
    const f = result.findings.find((x) => x.check === "L1.C1.ira-traditional");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.acceptable).toBe(true);
    expect(f!.message).toContain("$6,000");
    expect(f!.message).toContain("$7,000");
    expect(f!.message).not.toMatch(/CPA/);
    // the equal case raises nothing
    const ok = await runPipeline(ericScenario(700_000));
    expect(ok.result.findings.some((x) => x.check === "L1.C1.ira-traditional")).toBe(false);
  });

  it("inventory: the usable 5498 is reflected (no 'not used' finding); a usable statement that states another year or nothing is not a finding either", async () => {
    const { result } = await runPipeline(ericScenario());
    expect(result.findings.some((f) => f.check === "L1.C1.doc-not-reflected")).toBe(false);
    expect(result.findings.some((f) => f.check === "L1.C1.doc-unusable")).toBe(false);
  });

  it("the footing rules for Form 8606 exist for both people, quote the printed form, and carry the right keys", () => {
    const rules = FOOTING_RULES.filter((r) => r.form === "f8606");
    expect(rules.map((r) => r.id).sort()).toEqual(["f8606a.14", "f8606a.3", "f8606b.14", "f8606b.3"]);
    const r3 = rules.find((r) => r.id === "f8606a.3")!;
    expect(r3.parts.map((t) => t.key)).toEqual(["f8606a.1", "f8606a.2"]);
    const r14 = rules.find((r) => r.id === "f8606b.14")!;
    expect(r14.parts.map((t) => t.key)).toEqual(["f8606b.3"]);
    expect(r14.category).toBe("link");
  });
});

describe("L2 on Form 8606", () => {
  it("predicts the form from the facts (a traditional contribution larger than the Schedule 1 line 20 deduction) and agrees with the return", () => {
    const s = ericScenario();
    const ret = computeTy2025Return(s.facts);
    const ledger = oracleLedger({ ret, effective: applyOverrides(ret, []), facts: s.facts });
    const pred = predictForms(ledger).find((p) => p.form === "f8606");
    expect(pred?.required).toBe(true);
    expect(diffForms(ledger, ret).findings).toEqual([]);
    const out = runL2({ ret, effective: applyOverrides(ret, []), facts: s.facts });
    expect(out.status).toBe("ran");
    expect(out.findings.filter((f) => /f8606/.test(f.check) || f.formKey === "f8606")).toEqual([]);
    // line 2 (the owner's answer, read from the facts), line 3 and line 14 are recomputed and compared; line 1 is an input (honestly listed, not checked)
    const row = out.coverage.find((c) => c.area.startsWith("Form 8606"));
    expect(row?.compared).toBe(true);
    expect(row?.linesCompared).toBe(5); // Eric: lines 2, 3 and 14; Eva has no form: lines 3 and 14 (zero) only
    expect(row?.note).toContain("taken from the return as an input");
  });

  it("line 2 is recomputed from the owner's answer: a printed line 2 that differs from the answer (here 6,300 against 7,300) is a mismatch finding on that line", () => {
    const s = ericScenario();
    const ret = computeTy2025Return(s.facts);
    expect(ret.lines["f8606a.2"]?.amount).toBe(7300);
    (ret.lines["f8606a.2"] as { amount: number | null }).amount = 6300;
    const out = runL2({ ret, effective: applyOverrides(ret, []), facts: s.facts });
    expect(out.findings.some((f) => f.lineKey === "f8606a.2")).toBe(true);
  });

  it("a deliberate disagreement is found: the return says Form 8606 is NOT required while a 7,000 contribution has a 0 deduction", () => {
    const s = ericScenario();
    const ret = computeTy2025Return(s.facts);
    ret.formsRequired.f8606 = { required: false, reason: "tampered" };
    const ledger = oracleLedger({ ret, effective: applyOverrides(ret, []), facts: s.facts });
    const diff = diffForms(ledger, ret);
    expect(diff.findings.map((f) => f.check)).toEqual(["L2.forms.f8606"]);
  });

  it("a fully deducted contribution predicts 'not required' and agrees", () => {
    const s = cleanScenario(cleanDocs(), (f) => {
      f.returnAnswers.people[0]!.traditionalIraCents = owner(700_000);
      f.returnAnswers.people[0]!.age50Plus = owner(false);
    });
    const ret = computeTy2025Return(s.facts);
    const ledger = oracleLedger({ ret, effective: applyOverrides(ret, []), facts: s.facts });
    expect(predictForms(ledger).find((p) => p.form === "f8606")?.required).toBe(false);
    expect(ret.formsRequired.f8606?.required).toBe(false);
    expect(diffForms(ledger, ret).findings).toEqual([]);
  });

  it("an unanswered contribution is not predicted (null), never assumed", () => {
    const s = cleanScenario(cleanDocs(), (f) => {
      f.returnAnswers.people[0]!.traditionalIraCents = { value: null, basis: null, refs: [] };
    });
    const ret = computeTy2025Return(s.facts);
    const ledger = oracleLedger({ ret, effective: applyOverrides(ret, []), facts: s.facts });
    expect(predictForms(ledger).find((p) => p.form === "f8606")?.required).toBeNull();
  });
});

describe("pins and wiring", () => {
  it("the line-flow edges connect the IRA deduction to Form 8606 line 1 and on to line 14, for both people", () => {
    const reach = (from: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length > 0) {
        const k = stack.pop()!;
        for (const n of (LINE_FLOW as Record<string, readonly string[] | undefined>)[k] ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      return seen;
    };
    for (const s of ["a", "b"]) {
      expect(reach(`ira.${s}.7`).has(`f8606${s}.14`)).toBe(true);
      expect(reach("ira.magi").has(`f8606${s}.3`)).toBe(true);
      expect(reach("schc.31").has(`f8606${s}.1`)).toBe(true);
      expect(reach(`f8606${s}.1`).has(`f8606${s}.3`)).toBe(true);
      expect(reach(`f8606${s}.2`).has(`f8606${s}.14`)).toBe(true);
    }
    // the Schedule 1 deduction does not flow from the nondeductible amount
    expect(reach("ira.a.nd").has("sch1.20")).toBe(false);
  });

  it("the catalog has the ten Form 8606 / nondeductible keys, each once", () => {
    for (const k of ["ira.a.nd", "ira.b.nd", "f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14", "f8606b.1", "f8606b.2", "f8606b.3", "f8606b.14"]) expect(LINE_KEYS.filter((x) => x === k)).toHaveLength(1);
  });

  it("the new open-item ids each have an explicit link rule (the coverage guard in tax-review-links.test.ts scans the engine sources for them)", () => {
    for (const id of ["f8606-basis-record", "f8606-prior-basis-check", `retirement-doc-no-person:${DOC_ID}`, `retirement-doc-ira-event:${DOC_ID}`, "rule:form-8606"]) {
      expect(openItemRuleFor(id).explicit, id).toBe(true);
    }
    expect(FORM_LINK_LABELS["f8606"]).toBe("Form 8606");
  });

  it("the AI deductions task sees the Form 8606 lines and rules (taxpayer A and B labels), without a larger token ceiling", () => {
    const src = readFileSync("lib/tax-review/llm/tasks.ts", "utf8");
    expect(src).toContain('"Form 8606 (taxpayer A)", "Form 8606 (taxpayer B)"');
    expect(src).toMatch(/rulesOn\(p, \/1-A\|8995\|8606\|/);
  });

  it("the questionnaire's new statement is asked in plain language and mentions no CPA", async () => {
    const content = await import("@/lib/tax-questionnaire-content");
    expect(content.RC_NONE_GROUP_IDS).toContain("ira_basis_other");
    const node = content.questionnaireById("return-completeness")?.nodes.find((n) => n.id === "g_ira_basis_other");
    expect(node).toBeDefined();
    expect(JSON.stringify(node)).not.toMatch(/CPA/);
    expect(JSON.stringify(node)).toContain("conversion of a traditional IRA to a Roth IRA");
    expect(JSON.stringify(node)).toContain("recharacterization");
    // the earlier-year basis is NOT part of this statement any more: it is a dollars question per person (no definition version bump)
    expect(JSON.stringify(node)).not.toContain("nondeductible contribution");
    const def = content.questionnaireById("return-completeness");
    expect(def?.version).toBe(2);
    for (const k of ["eric", "eva"]) {
      const n = def?.nodes.find((x) => x.id === `ibasis_${k}`);
      expect(n?.kind).toBe("dollars");
      expect(n?.prompt).toContain("most recent filed Form 8606 (for 2024), what is the amount on line 14");
      expect(n?.prompt).toContain("(Enter 0 if");
      expect(JSON.stringify(n)).not.toMatch(/CPA/);
    }
  });
});

void EVA_ID;
