// Fixes after the tester's report on form-8606: the AI (L3) payload sees the Form 5498 as used and names / reads Form 8606; the L1 5498 tie-out skips another
// form year and counts a duplicate upload once; the IRA stop reasons carry no CPA wording onto Form 8606 line 1; large amounts read with thousands separators.
// Eric-shaped synthetic household (nothing real). Mock-free, no DB, no network.

import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import { buildReviewPayload, formName, packetManifestOf, serializePayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { TASKS } from "@/lib/tax-review/llm/tasks";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { uniqueDocs, docSignature } from "@/lib/tax-review/l1/source-docs";
import { answered, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeIraDeduction } from "@/lib/tax2025/rules/ira-deduction";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { resolveFacts, type RawDocument } from "@/lib/tax2025/resolve-facts";
import { ERIC_ID, EVA_ID, owner } from "./tax2025-fixtures";
import { buildPipeline, cleanDocs, cleanScenario, doc, runPipeline, w2Doc } from "./tax-review-harness";

const PEOPLE = [
  { userId: ERIC_ID, name: "Eric Sample" },
  { userId: EVA_ID, name: "Eva Sample" },
];
const DOC_ID = "5498aaaa-bbbb-4ccc-8ddd-5498eeee0009";

function statement(id: string, person: string, data: Record<string, unknown> = {}): RawDocument {
  return doc("retirement_contribution", { formVariant: "form_5498", issuerName: "Sample Trust Co", accountKind: "traditional_ira", taxYear: 2025, iraContributionsCents: 700_000, fairMarketValueCents: 4_914_679, ...data }, { id, subjectType: "person", subjectUserId: person });
}

/** Eric-shaped scenario with a verified Form 5498 for the person; 2024 Form 8606 line 14 = 7,300. */
function ericScenario(extraDocs: RawDocument[] = []) {
  const docs = [w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 20_000_000, 3_000_000, 600_000), ...cleanDocs().slice(1), statement(DOC_ID, ERIC_ID), ...extraDocs];
  return cleanScenario(docs, (f) => {
    const [a, b] = f.returnAnswers.people;
    a!.traditionalIraCents = owner(700_000);
    a!.priorBasisCents = owner(730_000);
    a!.coveredByWorkplacePlan = owner(false);
    a!.age50Plus = owner(false);
    b!.coveredByWorkplacePlan = owner(true);
    f.priorYear = { totalTaxCents: owner(4_600_000), agiCents: owner(28_500_000), filingStatus: owner("mfj") };
    f.income.retirementStatements = [
      {
        docId: DOC_ID,
        personUserId: ERIC_ID,
        basis: "doc_verified",
        legacyFormat: false,
        refs: [{ kind: "document", id: DOC_ID, label: "Retirement statement" }],
        issuer: "Sample Trust Co",
        traditionalIraCents: 700_000,
        rothIraCents: null,
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

async function payloadOf(): Promise<ReviewPayload> {
  const p = await buildPipeline(ericScenario());
  const bindings = bindFiles(p.ctx, await readPacketFiles(p.ctx.packet.files));
  return buildReviewPayload(
    {
      ret: p.ret,
      view: p.ctx.view,
      facts: p.ctx.facts,
      documents: (p.ctx.raw?.documents ?? []).map((x) => ({ id: x.id, docType: x.docType, taxYear: x.taxYear, verified: x.verified, extractionStatus: x.extractionStatus, subjectType: x.subjectType, subjectUserId: x.subjectUserId })),
      bindings,
      l1Findings: [],
      entityLabels: [],
    },
    PEOPLE
  );
}

describe("L3 payload: the Form 5498 is used, Form 8606 is named and read", () => {
  it("the retirement statement row says it is used (retirement_statement), so the model is not told it feeds no line", async () => {
    const payload = await payloadOf();
    const row = payload.documents.find((x) => x.type === "retirement_contribution");
    expect(row?.usedBy).toEqual(["retirement_statement"]);
    expect(row?.notUsedReason).toBeNull();
  });

  it("the packet manifest names Form 8606 (not the raw id) and counts its copy", async () => {
    const payload = await payloadOf();
    expect(formName("f8606")).toBe("Form 8606");
    expect(payload.meta.packetManifest).toContain("Form 8606");
    expect(payload.meta.packetManifest).not.toMatch(/f8606/);
  });

  it("the engine form name is used for a form the engine decided is not needed (no raw id in the manifest)", async () => {
    const s = cleanScenario(cleanDocs(), (f) => {
      f.returnAnswers.people[0]!.traditionalIraCents = owner(0);
    });
    const p = await buildPipeline(s);
    expect(p.ret.formsRequired.f8606?.required).toBe(false);
    const manifest = packetManifestOf(bindFiles(p.ctx, await readPacketFiles(p.ctx.packet.files)), p.ret);
    expect(manifest).toContain("Form 8606 (");
    expect(manifest).not.toMatch(/f8606/);
  });

  it("task c1 reads the printed Form 8606 (by its file id) and its engine lines (taxpayer A and B labels)", async () => {
    const payload = await payloadOf();
    const c1 = TASKS.find((t) => t.id === "c1")!;
    const slice = c1.slice(payload, { priorFindings: [], register: [] }) as { forms: Array<{ formId: string }>; lines: Array<{ key: string; form: string }> };
    expect(slice.forms.map((f) => f.formId)).toContain("f8606");
    const keys = slice.lines.map((l) => l.key);
    expect(keys).toEqual(expect.arrayContaining(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"]));
    // the other form tasks do not also read it
    for (const id of ["c2", "c3"]) {
      const other = TASKS.find((t) => t.id === id)!.slice(payload, { priorFindings: [], register: [] }) as { forms: Array<{ formId: string }> };
      expect(other.forms.map((f) => f.formId), id).not.toContain("f8606");
    }
  });

  it("privacy: the serialized payload has no raw document id, name or number from the Form 8606 / 5498 rows", async () => {
    const payload = await payloadOf();
    const s = serializePayload(payload, PEOPLE, { entities: [], addresses: [] });
    expect(s.json).not.toContain(DOC_ID);
    expect(s.json).not.toMatch(/Eric Sample|Eva Sample/);
    expect(s.json).toContain("5498aaaa");
    expect(s.json).toContain("retirement_statement");
  });
});

describe("L1 5498 tie-out: form year and duplicates", () => {
  const tie = async (docs: RawDocument[]) => {
    const { result } = await runPipeline(ericScenario(docs));
    return result.findings.filter((f) => f.check === "L1.C1.ira-traditional");
  };

  it("the same 5498 uploaded twice is one form: no 14,000-versus-7,000 finding", async () => {
    expect(await tie([statement("5498aaaa-bbbb-4ccc-8ddd-5498eeee0010", ERIC_ID)])).toEqual([]);
  });

  it("a second, different 5498 for the same person (another custodian) is still added: 7,000 + 3,000 against the answer 7,000 is a finding", async () => {
    const hit = await tie([statement("5498aaaa-bbbb-4ccc-8ddd-5498eeee0011", ERIC_ID, { issuerName: "Other Trust", iraContributionsCents: 300_000, fairMarketValueCents: 100_000 })]);
    expect(hit.map((f) => f.message).join(" ")).toContain("$10,000");
  });

  it("a 5498 whose form year is 2024 is ignored even when the document year says 2025", async () => {
    expect(await tie([statement("5498aaaa-bbbb-4ccc-8ddd-5498eeee0012", ERIC_ID, { taxYear: 2024, iraContributionsCents: 300_000, issuerName: "Old Trust" })])).toEqual([]);
  });

  it("two people with identical forms are two forms (the person is part of the signature)", () => {
    const a = statement("d-a", ERIC_ID);
    const b = statement("d-b", EVA_ID);
    expect(docSignature(a)).not.toEqual(docSignature(b));
    expect(uniqueDocs([a, b], "retirement_contribution").map((d) => d.id)).toEqual(["d-a", "d-b"]);
    expect(uniqueDocs([a, statement("d-c", ERIC_ID)], "retirement_contribution").map((d) => d.id)).toEqual(["d-a"]);
  });

  it("a statement that states no amount has no signature (never merged)", () => {
    expect(docSignature(doc("retirement_contribution", { issuerName: "X" }))).toBeNull();
  });
});

describe("the fact resolver counts one Form 5498 once", () => {
  it("two identical uploads: one statement fact, one blocking 'exact duplicates' item, no conflict with the owner's 7,000", () => {
    const raw = {
      taxYear: 2025,
      documents: [statement("dup-1", ERIC_ID), statement("dup-2", ERIC_ID)],
    };
    const base = ericScenario();
    const r = resolveFacts({ ...(base.raw as object), ...raw } as Parameters<typeof resolveFacts>[0]);
    expect(r.facts.income.retirementStatements?.length).toBe(1);
    expect(r.openItems.some((o) => o.id.startsWith("doc-duplicate:retirement_contribution:") && o.severity === "blocking")).toBe(true);
  });
});

describe("wording on Form 8606 line 1: the IRA stops say 'you decide', never the CPA", () => {
  const person = (over: Record<string, unknown> = {}) => ({ slot: "a" as const, name: "Eric", traditional: answered(D(7000)), roth: answered(D(0)), age50Plus: answered(false), covered: answered(false), compensation: D(100000), ...over });
  const eva = { slot: "b" as const, name: "Eva", traditional: answered(D(0)), roth: answered(D(0)), age50Plus: answered(false), covered: answered(true), compensation: D(100000) };

  it("not sure about an answer, over the yearly limit, excess contribution, Social Security statement: no CPA in any reason", () => {
    const cases = [
      computeIraDeduction({ people: [person({ age50Plus: UNSURE }), eva], magi: D(270980), noSocialSecurityBenefits: true }),
      computeIraDeduction({ people: [person({ traditional: answered(D(7500)) }), eva], magi: D(270980), noSocialSecurityBenefits: true }),
      computeIraDeduction({ people: [person({ compensation: D(3000) }), eva], magi: D(270980), noSocialSecurityBenefits: true }),
      computeIraDeduction({ people: [person(), eva], magi: D(270980), noSocialSecurityBenefits: false }),
      computeIraDeduction({ people: [person(), eva], magi: null, noSocialSecurityBenefits: true }),
    ];
    for (const r of cases) {
      for (const l of r.lines) expect(l.reason ?? "", l.key).not.toMatch(/CPA/);
      for (const x of r.reasons) expect(x).not.toMatch(/CPA/);
    }
    expect(cases[0]!.lines.find((l) => l.key === "ira.a.nd")?.reason).toContain("you decide");
    expect(cases[1]!.lines.find((l) => l.key === "ira.a.nd")?.reason).toContain("Form 5329");
  });

  it("through the whole return: f8606a.1 and the open items of an unsure IRA answer carry no CPA", () => {
    const s = ericScenario();
    s.facts.returnAnswers.people[0]!.age50Plus = { value: null, basis: "answer_owner", refs: [] };
    const ret = computeTy2025Return(s.facts);
    expect(ret.lines["f8606a.1"]?.status).not.toBe("computed");
    expect(ret.lines["f8606a.1"]?.reason ?? "").not.toMatch(/CPA/);
    for (const o of ret.openItems.filter((x) => /ira|8606/.test(x.id))) expect(o.message, o.id).not.toMatch(/CPA/);
  });
});

describe("amounts in the new advisory read with thousands separators", () => {
  it("a Roth conversion of 10,000.00 on the statement reads '$10,000.00', 1,234,567.89 reads '$1,234,567.89'", () => {
    const base = ericScenario();
    const raw = { ...(base.raw as object), taxYear: 2025, documents: [statement("big-1", ERIC_ID, { rothConversionCents: 1_000_000, recharacterizedContributionsCents: 123_456_789 })] };
    const r = resolveFacts(raw as Parameters<typeof resolveFacts>[0]);
    const item = r.openItems.find((o) => o.id === "retirement-doc-ira-event:big-1");
    expect(item?.message).toContain("$10,000.00");
    expect(item?.message).toContain("$1,234,567.89");
    expect(item?.message).not.toMatch(/\$\d{4,}\./);
  });
});
