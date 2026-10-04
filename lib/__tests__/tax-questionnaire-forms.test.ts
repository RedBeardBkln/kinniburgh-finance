import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildFormsPageData,
  listQuestionnaireEntries,
  CPA_INPUT_FORMS,
  type FormEntry,
  type FormsCatalogInput,
  type FormsDocumentInput,
  type FormsEntityInput,
  type FormsPageData,
  type TaxDraftSummary,
} from "@/lib/tax-forms";
import type { QuestionnaireRowInput } from "@/lib/tax-questionnaire";
import { QUESTIONNAIRES, questionnaireById } from "@/lib/tax-questionnaire-content";

const ERIC = { id: "11111111-1111-4111-8111-111111111111", name: "Eric Kinniburgh" };
const EVA = { id: "22222222-2222-4222-8222-222222222222", name: "Eva-Laura Ramirez-Wisiackas" };

const PERSONAL: FormsEntityInput = { id: "ent-personal", name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null };
const EKC: FormsEntityInput = {
  id: "ent-ekc",
  name: "Eric Kinniburgh Consulting, LLC",
  slug: "ek-consulting",
  type: "business",
  foundedDate: null,
  taxStatusNotes: "Single-member LLC, disregarded entity — Schedule C on Eric's personal Form 1040.",
};
const SV: FormsEntityInput = {
  id: "ent-sv",
  name: "Sudden Valley Property Management, LLC",
  slug: "sudden-valley",
  type: "business",
  foundedDate: new Date("2026-02-01"),
  taxStatusNotes: null,
};
const MEZZO: FormsEntityInput = {
  id: "ent-mezzo",
  name: "Mezzo",
  slug: "mezzo",
  type: "business",
  foundedDate: null,
  taxStatusNotes: "Not yet formed/registered as of June 2026.",
};

function k1Doc(): FormsDocumentInput {
  return {
    id: "doc-k1",
    docType: "k1",
    documentName: null,
    entityId: PERSONAL.id,
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: null,
    archivedAt: null,
    subjectType: null,
    subjectUser: null,
    issuerName: null,
  };
}

function input(over: Partial<FormsCatalogInput> = {}): FormsCatalogInput {
  return {
    taxYear: 2025,
    people: [ERIC, EVA],
    entities: [PERSONAL, EKC, SV, MEZZO],
    documents: [],
    questions: [],
    personalWorkspaceExists: true,
    workspaceIds: {},
    checklists: {},
    formPlanInput: {
      documents: [],
      questions: [],
      ekConsultingPL: null,
      suddenValleyPL: null,
      ekConsultingMileageCount: 0,
      solarLoanOriginalCostCents: null,
      donationCount: 0,
      ekConsultingFixedAssetCount: 0,
      suddenValleyBuildingAssetCount: 0,
    },
    taxDraft: { status: "not_computed" },
    ...over,
  };
}

const draft = (se: boolean): TaxDraftSummary => ({ status: "available", deductionMethod: "standard", selfEmploymentTaxPositive: se });

function allEntries(data: FormsPageData): FormEntry[] {
  return [...data.federal, ...data.connecticut, ...data.needsCpaInput, ...data.entities.flatMap((s) => s.entries)];
}

const SCENARIOS: Record<string, Partial<FormsCatalogInput>> = {
  "2025 draft available, SE tax $0": { taxDraft: draft(false) },
  "2025 draft available, SE tax positive": { taxDraft: draft(true) },
  "2025 draft not computed": {},
  "2026, Sudden Valley active": { taxYear: 2026 },
  "2026, Sudden Valley classification disregarded": {
    taxYear: 2026,
    entities: [PERSONAL, EKC, { ...SV, taxStatusNotes: "Single-member LLC, disregarded entity" }, MEZZO],
  },
  "K-1 documents on file": { documents: [k1Doc()] },
  "planning answers rule out home office, dependents and EV": {
    taxYear: 2026,
    questions: [
      { key: "home_office_ekc", answer: "yes_shared", skippedReason: null },
      { key: "household_members", answer: "none", skippedReason: null },
      { key: "ev_vehicle", answer: "no", skippedReason: null },
    ],
  },
  "no Personal workspace": { personalWorkspaceExists: false },
};

const HSA_ANSWERED_ROW = (entityId: string): QuestionnaireRowInput => ({
  taxYear: 2025,
  entityId,
  questionnaireId: "form-8889",
  definitionVersion: 1,
  answers: {
    hs1: { v: "eric", at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
    hs2: { v: "family", at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
    hs3: { v: "yes", at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
    hs4: { v: ["direct"], at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
    hs5: { v: 500_000, at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
    hs7: { v: "no", at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
    hs9: { v: "no", at: "2026-10-03T14:00:00.000Z", by: ERIC.id },
  },
  note: "private",
});

describe("every needs-CPA-input card has a questionnaire", () => {
  for (const [name, over] of Object.entries(SCENARIOS)) {
    it(`${name}: all needs_cpa_input entries carry a registry questionnaire`, () => {
      const data = buildFormsPageData(input(over));
      const entries = allEntries(data);
      const needing = entries.filter((e) => e.applicability === "needs_cpa_input" || data.needsCpaInput.includes(e));
      expect(needing.length).toBeGreaterThan(0);
      for (const e of needing) {
        expect(e.questionnaire, `${name}: ${e.id}`).not.toBeNull();
        expect(questionnaireById(e.questionnaire!.questionnaireId), e.id).toBeTruthy();
      }
    });
  }

  it("covers every CPA_INPUT_FORMS id and the six fixed extras when Sudden Valley is active", () => {
    const data = buildFormsPageData(input({ taxYear: 2026 }));
    const ids = data.needsCpaInput.map((e) => e.id);
    for (const f of CPA_INPUT_FORMS) expect(ids).toContain(f.id);
    for (const extra of [
      "schedule-3-federal",
      "qbi-deduction",
      "additional-medicare-tax",
      "child-dependent-credits",
      "clean-vehicle-credit",
    ]) {
      expect(ids).toContain(extra);
    }
  });

  it("every registry questionnaire is reachable from at least one scenario (no orphan definition)", () => {
    const reachable = new Set<string>();
    for (const over of Object.values(SCENARIOS)) {
      for (const { questionnaire } of listQuestionnaireEntries(buildFormsPageData(input(over)))) {
        reachable.add(questionnaire.questionnaireId);
      }
    }
    expect([...reachable].sort()).toEqual(QUESTIONNAIRES.map((q) => q.id).sort());
  });

  it("Schedule SE gets a questionnaire only when it is needs_cpa_input", () => {
    const undecided = buildFormsPageData(input({ taxDraft: draft(false) }));
    const se1 = allEntries(undecided).find((e) => e.id === "schedule-se")!;
    expect(se1.applicability).toBe("needs_cpa_input");
    expect(se1.questionnaire?.questionnaireId).toBe("schedule-se");
    const decided = buildFormsPageData(input({ taxDraft: draft(true) }));
    const se2 = allEntries(decided).find((e) => e.id === "schedule-se")!;
    expect(se2.applicability).toBe("required");
    expect(se2.questionnaire).toBeNull();
  });

  it("entity cards: ct filing always; federal entity return only when the classification is not recorded", () => {
    const data = buildFormsPageData(input({ taxYear: 2026 }));
    const sv = data.entities.find((s) => s.slug === "sudden-valley")!;
    const ekc = data.entities.find((s) => s.slug === "ek-consulting")!;
    const svFed = sv.entries.find((e) => e.id.endsWith("-federal-entity-return"))!;
    const ekcFed = ekc.entries.find((e) => e.id.endsWith("-federal-entity-return"))!;
    expect(svFed.applicability).toBe("needs_cpa_input");
    expect(svFed.questionnaire).toMatchObject({ questionnaireId: "entity-federal-return", entityId: "ent-sv", scope: "entity" });
    expect(ekcFed.applicability).toBe("not_applicable");
    expect(ekcFed.questionnaire).toBeNull();
    for (const s of [sv, ekc]) {
      const ct = s.entries.find((e) => e.id.endsWith("-ct-entity-filing"))!;
      expect(ct.questionnaire).toMatchObject({ questionnaireId: "entity-ct-filing", entityId: s.entityId });
    }
    // Mezzo is not yet formed: only the "no filing" row, no questionnaire.
    const mezzo = data.entities.find((s) => s.slug === "mezzo")!;
    expect(mezzo.entries.every((e) => e.questionnaire === null)).toBe(true);
  });

  it("household questionnaires are scoped to the Personal entity", () => {
    const data = buildFormsPageData(input());
    for (const e of data.needsCpaInput) expect(e.questionnaire?.entityId).toBe("ent-personal");
  });

  it("with no Personal entity record there is nothing to scope a household questionnaire to", () => {
    const data = buildFormsPageData(input({ entities: [EKC] }));
    for (const e of data.needsCpaInput) expect(e.questionnaire).toBeNull();
  });
});

describe("honesty invariants: a questionnaire never changes applicability, readiness or the counters", () => {
  const strip = (data: FormsPageData) => {
    const clean = (e: FormEntry): Omit<FormEntry, "questionnaire"> => {
      const { questionnaire: _q, ...rest } = e;
      void _q;
      return rest;
    };
    return {
      federal: data.federal.map(clean),
      connecticut: data.connecticut.map(clean),
      needsCpaInput: data.needsCpaInput.map(clean),
      entities: data.entities.map((s) => ({ ...s, entries: s.entries.map(clean) })),
      summary: data.summary,
      unansweredQuestionCount: data.unansweredQuestionCount,
      attribution: data.attribution,
    };
  };

  it("answered rows leave every field of every entry (except the questionnaire block) byte-identical", () => {
    const without = buildFormsPageData(input({ taxDraft: draft(false) }));
    const withRows = buildFormsPageData(
      input({
        taxDraft: draft(false),
        questionnaireRows: [
          HSA_ANSWERED_ROW("ent-personal"),
          {
            taxYear: 2025,
            entityId: "ent-personal",
            questionnaireId: "form-8829",
            definitionVersion: 1,
            answers: { ho1: { v: "yes_exclusive", at: "2026-10-03T14:00:00.000Z", by: ERIC.id } },
            note: null,
          },
        ],
      })
    );
    expect(strip(withRows)).toEqual(strip(without));
    expect(JSON.stringify(strip(withRows))).toBe(JSON.stringify(strip(without)));
    const hsa = withRows.needsCpaInput.find((e) => e.id === "form-8889")!;
    expect(hsa.applicability).toBe("needs_cpa_input");
    expect(hsa.questionnaire?.status).toMatchObject({ kind: "answered", outcome: "applies" });
    expect(hsa.reason).toBe(without.needsCpaInput.find((e) => e.id === "form-8889")!.reason);
    expect(withRows.summary).toEqual(without.summary);
  });

  it("rows for another year or another entity are ignored", () => {
    const stray = buildFormsPageData(
      input({
        questionnaireRows: [
          { ...HSA_ANSWERED_ROW("ent-personal"), taxYear: 2024 },
          { ...HSA_ANSWERED_ROW("ent-ekc") },
        ],
      })
    );
    expect(stray.needsCpaInput.find((e) => e.id === "form-8889")!.questionnaire?.status).toEqual({ kind: "not_started" });
  });

  it("a card ruled out by a planning answer keeps its questionnaire (so it can be reopened)", () => {
    const data = buildFormsPageData(input({ ...SCENARIOS["planning answers rule out home office, dependents and EV"] }));
    for (const id of ["form-8829", "child-dependent-credits", "clean-vehicle-credit"]) {
      const e = data.needsCpaInput.find((x) => x.id === id)!;
      expect(e.applicability, id).toBe("not_applicable");
      expect(e.questionnaire, id).not.toBeNull();
    }
    // Bound answers show up in the questionnaire state: the planning answers are the same data.
    expect(data.needsCpaInput.find((x) => x.id === "child-dependent-credits")!.questionnaire!.status).toMatchObject({
      kind: "answered",
      outcome: "not_applies",
    });
  });

  it("questionnaireSummary totals match the cards that carry a questionnaire and the buckets add up", () => {
    const data = buildFormsPageData(
      input({ taxYear: 2026, questionnaireRows: [{ ...HSA_ANSWERED_ROW("ent-personal"), taxYear: 2026 }] })
    );
    const list = listQuestionnaireEntries(data);
    const q = data.questionnaireSummary;
    expect(q.total).toBe(list.length);
    expect(q.notStarted + q.inProgress + q.answered).toBe(q.total);
    expect(q.answered).toBe(1);
    expect(q.inProgress).toBe(0);
    // The four top counters are untouched by this separate summary.
    expect(data.summary.needsCpaInput).toBe(allEntries(data).filter((e) => e.applicability === "needs_cpa_input").length);
  });
});

describe("Forms strip / questionnaire page copy does not over-claim", () => {
  const read = (file: string) =>
    readFileSync(resolve(__dirname, "../../", file), "utf8").replace(/\s+/g, " ");

  it("strip says the shared Planning answers DO move the counts, and the old absolute claim is gone", () => {
    const src = read("components/tax/forms/forms-summary.tsx");
    expect(src).toContain(
      "Saving questionnaire answers does not change the counts above; the few answers shared with the Planning screen do, exactly as they do there."
    );
    expect(src).not.toContain("Answering one does not change the counts above");
    expect(src).not.toContain("the CPA decides.");
  });

  it("questionnaire page does not say nothing decides a form, and names the shared answers", () => {
    const src = read("app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx");
    expect(src).not.toContain("Nothing here decides whether a form is required");
    expect(src).toContain("you decide whether a form is required");
    expect(src).toContain("A few answers are shared with the Planning screen and are marked.");
  });

  it("applies-outcome sentences report facts and leave preparation to the CPA", () => {
    for (const d of QUESTIONNAIRES) {
      const applies = d.outcomeText.applies;
      expect(applies, d.id).toMatch(/^Owner reports /);
      expect(applies, d.id).not.toMatch(/the CPA (prepares|handles) /);
    }
    expect(questionnaireById("form-8889")!.outcomeText.applies).toContain("the CPA decides whether and how to prepare it");
    expect(questionnaireById("qbi-deduction")!.outcomeText.applies).toContain("the CPA decides whether and how to prepare it");
  });
});
