import { describe, it, expect } from "vitest";
import {
  buildFormsPageData,
  matchDocuments,
  readinessFromFields,
  noteSaysDisregarded,
  CPA_INPUT_FORMS,
  opportunityForms,
  PLAN_FORM,
  type FormEntry,
  type FormsCatalogInput,
  type FormsDocumentInput,
  type FormsEntityInput,
  type FormsQuestionInput,
  type FormsPageData,
  type TaxDraftSummary,
} from "@/lib/tax-forms";
import { PERSONAL_FORM_PLAN } from "@/lib/tax-guidance";

const ERIC = { id: "11111111-1111-4111-8111-111111111111", name: "Eric Kinniburgh" };
const EVA = { id: "22222222-2222-4222-8222-222222222222", name: "Eva-Laura Ramirez-Wisiackas" };

const PERSONAL: FormsEntityInput = {
  id: "ent-personal",
  name: "Personal",
  slug: "personal",
  type: "personal",
  foundedDate: null,
  taxStatusNotes: null,
};
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

function doc(over: Partial<FormsDocumentInput> = {}): FormsDocumentInput {
  return {
    id: "doc-1",
    docType: "w2",
    documentName: null,
    entityId: PERSONAL.id,
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: null,
    archivedAt: null,
    subjectType: null,
    subjectUser: null,
    issuerName: null,
    ...over,
  };
}

function question(key: string, answer: unknown, skippedReason: string | null = null): FormsQuestionInput {
  return { key, answer, skippedReason };
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
    },
    taxDraft: { status: "not_computed" },
    ...over,
  };
}

function allEntries(data: FormsPageData): FormEntry[] {
  return [...data.federal, ...data.connecticut, ...data.needsCpaInput, ...data.entities.flatMap((s) => s.entries)];
}

function find(data: FormsPageData, id: string): FormEntry {
  const e = allEntries(data).find((x) => x.id === id);
  if (!e) throw new Error(`entry ${id} not found`);
  return e;
}

const draft = (method: "standard" | "itemized", se: boolean): TaxDraftSummary => ({
  status: "available",
  deductionMethod: method,
  selfEmploymentTaxPositive: se,
});

describe("catalog integrity", () => {
  it("maps every PERSONAL_FORM_PLAN form to exactly one catalog entry", () => {
    const data = buildFormsPageData(input());
    for (const form of PERSONAL_FORM_PLAN) {
      const matches = allEntries(data).filter((e) => e.planFormName === form.formName);
      expect(matches, form.formName).toHaveLength(1);
    }
  });

  it("PLAN_FORM names all exist in PERSONAL_FORM_PLAN", () => {
    const names = PERSONAL_FORM_PLAN.map((f) => f.formName);
    for (const n of Object.values(PLAN_FORM)) expect(names).toContain(n);
  });

  it("every entry has a non-empty source and reason; entries are uniquely identified", () => {
    for (const year of [2024, 2025, 2026]) {
      const data = buildFormsPageData(
        input({
          taxYear: year,
          documents: [doc({ id: "k", docType: "k1", taxYear: year })],
          questions: [question("solar_credit", "yes_unclaimed")],
          taxDraft: year === 2025 ? draft("itemized", true) : { status: "not_computed" },
        })
      );
      const entries = allEntries(data);
      for (const e of entries) {
        expect(e.source.trim(), e.id).not.toBe("");
        expect(e.reason.trim(), e.id).not.toBe("");
      }
      expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    }
  });

  it("CPA-input forms still name an existing opportunity that lists the form", () => {
    for (const f of CPA_INPUT_FORMS) {
      const forms = opportunityForms(f.opportunityKey);
      expect(forms, f.id).not.toBeNull();
      expect(forms!.some((x) => x.includes(f.formMarker)), f.id).toBe(true);
    }
  });

  it("never asserts a CPA-input form as required", () => {
    const data = buildFormsPageData(input({ taxDraft: draft("itemized", true) }));
    for (const e of data.needsCpaInput) {
      expect(e.applicability).not.toBe("required");
      expect(e.applicability).not.toBe("conditional");
    }
  });
});

describe("Schedule A", () => {
  it("is required when the 2025 draft itemizes", () => {
    const e = find(buildFormsPageData(input({ taxDraft: draft("itemized", false) })), "schedule-a");
    expect(e.applicability).toBe("required");
    expect(e.confirmWithCpa).toBe(false);
  });

  it("is not needed (CPA confirm) when the 2025 draft takes the standard deduction", () => {
    const e = find(buildFormsPageData(input({ taxDraft: draft("standard", false) })), "schedule-a");
    expect(e.applicability).toBe("not_applicable");
    expect(e.confirmWithCpa).toBe(true);
  });

  it("is conditional for other years and when the draft is unavailable", () => {
    expect(find(buildFormsPageData(input({ taxYear: 2026 })), "schedule-a").applicability).toBe("conditional");
    const unavailable = find(
      buildFormsPageData(input({ taxDraft: { status: "unavailable", reason: "boom" } })),
      "schedule-a"
    );
    expect(unavailable.applicability).toBe("conditional");
    expect(unavailable.reason).toContain("boom");
  });

  it("carries the property-tax understatement note", () => {
    expect(find(buildFormsPageData(input()), "schedule-a").cpaNote).toMatch(/understated/);
  });
});

describe("Schedule SE", () => {
  it("is required when the draft's SE tax is positive", () => {
    expect(find(buildFormsPageData(input({ taxDraft: draft("standard", true) })), "schedule-se").applicability).toBe(
      "required"
    );
  });

  it("needs CPA input when drafted SE tax is zero", () => {
    expect(find(buildFormsPageData(input({ taxDraft: draft("standard", false) })), "schedule-se").applicability).toBe(
      "needs_cpa_input"
    );
  });

  it("needs CPA input (not required) for non-2025 years", () => {
    expect(find(buildFormsPageData(input({ taxYear: 2026 })), "schedule-se").applicability).toBe("needs_cpa_input");
  });

  it("is not applicable when EK Consulting is not active that year", () => {
    const lateEkc = { ...EKC, foundedDate: new Date("2027-01-01") };
    const data = buildFormsPageData(input({ entities: [PERSONAL, lateEkc, SV, MEZZO] }));
    expect(find(data, "schedule-se").applicability).toBe("not_applicable");
    expect(find(data, "schedule-c").applicability).toBe("not_applicable");
  });
});

describe("Form 5695", () => {
  const status = (qs: FormsQuestionInput[]) => find(buildFormsPageData(input({ questions: qs })), "form-5695");

  it("yes_unclaimed -> required", () => {
    expect(status([question("solar_credit", "yes_unclaimed")]).applicability).toBe("required");
  });
  it("claimed_already -> not_applicable", () => {
    expect(status([question("solar_credit", "claimed_already")]).applicability).toBe("not_applicable");
  });
  it("unsure -> conditional", () => {
    const e = status([question("solar_credit", "unsure")]);
    expect(e.applicability).toBe("conditional");
    expect(e.reason).toMatch(/Not sure/);
  });
  it("unanswered, null or skipped -> conditional, pointing at the planning question", () => {
    expect(status([]).applicability).toBe("conditional");
    expect(status([question("solar_credit", null)]).applicability).toBe("conditional");
    expect(status([question("solar_credit", "yes_unclaimed", "skipped")]).applicability).toBe("conditional");
    expect(status([]).reason).toMatch(/planning question/);
  });
});

describe("answer-excluded CPA-input forms", () => {
  it("Form 8880 is not_applicable when filing_status is mfs, else needs_cpa_input", () => {
    const mfs = find(buildFormsPageData(input({ questions: [question("filing_status", "mfs")] })), "form-8880");
    expect(mfs.applicability).toBe("not_applicable");
    const mfj = find(buildFormsPageData(input({ questions: [question("filing_status", "mfj")] })), "form-8880");
    expect(mfj.applicability).toBe("needs_cpa_input");
  });

  it("Form 8829 is not_applicable for a shared-use home office", () => {
    const e = find(buildFormsPageData(input({ questions: [question("home_office_ekc", "yes_shared")] })), "form-8829");
    expect(e.applicability).toBe("not_applicable");
    expect(find(buildFormsPageData(input({ questions: [question("home_office_ekc", "no")] })), "form-8829").applicability).toBe(
      "needs_cpa_input"
    );
  });

  it("each CPA-input form carries its originating opportunity with a risk label", () => {
    const data = buildFormsPageData(input());
    const f4562 = find(data, "form-4562");
    expect(f4562.opportunity?.key).toBe("rental_depreciation");
    expect(f4562.opportunity?.riskLabel).toBeTruthy();
  });

  it("child and EV credit rows are ruled out only by the matching answers", () => {
    expect(find(buildFormsPageData(input()), "child-dependent-credits").applicability).toBe("needs_cpa_input");
    expect(
      find(buildFormsPageData(input({ questions: [question("household_members", "none")] })), "child-dependent-credits")
        .applicability
    ).toBe("not_applicable");
    expect(
      find(buildFormsPageData(input({ questions: [question("ev_vehicle", "no")] })), "clean-vehicle-credit").applicability
    ).toBe("not_applicable");
  });

  it("does not name a form number for QBI / Additional Medicare Tax", () => {
    const data = buildFormsPageData(input());
    expect(find(data, "qbi-deduction").formName).not.toMatch(/\b(Form|Schedule)\s+\d/i);
    expect(find(data, "additional-medicare-tax").formName).not.toMatch(/\b(Form|Schedule)\s+\d/i);
  });
});

describe("Sudden Valley and Mezzo", () => {
  it("Schedule E is not_applicable for TY2025 (formed Feb 2026)", () => {
    const e = find(buildFormsPageData(input({ taxYear: 2025 })), "schedule-e");
    expect(e.applicability).toBe("not_applicable");
    expect(e.inputs).toEqual([]);
  });

  it("Schedule E is required for TY2026 but must be confirmed with the CPA", () => {
    const e = find(buildFormsPageData(input({ taxYear: 2026 })), "schedule-e");
    expect(e.applicability).toBe("required");
    expect(e.confirmWithCpa).toBe(true);
    expect(e.reason).toMatch(/confirm with CPA/i);
  });

  it("drops the classification caveat only when the entity record says disregarded", () => {
    const svDisregarded = { ...SV, taxStatusNotes: "Single-member LLC, disregarded entity" };
    const e = find(buildFormsPageData(input({ taxYear: 2026, entities: [PERSONAL, EKC, svDisregarded, MEZZO] })), "schedule-e");
    expect(e.confirmWithCpa).toBe(false);
  });

  it("the Sudden Valley section flags the unconfirmed classification for 2026 and has no filing for 2025", () => {
    const d2026 = buildFormsPageData(input({ taxYear: 2026 }));
    const sec = d2026.entities.find((s) => s.slug === "sudden-valley");
    expect(sec?.activeForYear).toBe(true);
    expect(sec?.reportedOn).toEqual(["Schedule E"]);
    const ret = sec?.entries.find((e) => e.id.endsWith("federal-entity-return"));
    expect(ret?.applicability).toBe("needs_cpa_input");
    expect(ret?.confirmWithCpa).toBe(true);

    const d2025 = buildFormsPageData(input({ taxYear: 2025 }));
    const sec25 = d2025.entities.find((s) => s.slug === "sudden-valley");
    expect(sec25?.activeForYear).toBe(false);
    expect(sec25?.entries.map((e) => e.applicability)).toEqual(["not_applicable"]);
  });

  it("Mezzo never gets a form — only a not-applicable 'not yet formed' row", () => {
    for (const year of [2025, 2026]) {
      const sec = buildFormsPageData(input({ taxYear: year })).entities.find((s) => s.slug === "mezzo");
      expect(sec?.activeForYear).toBe(false);
      expect(sec?.entries).toHaveLength(1);
      expect(sec?.entries[0]?.applicability).toBe("not_applicable");
      expect(sec?.entries[0]?.reason).toMatch(/not yet formed/i);
      expect(sec?.reportedOn).toEqual([]);
    }
  });

  it("EK Consulting is a disregarded entity: no separate return, reported on Schedule C/SE", () => {
    const sec = buildFormsPageData(input()).entities.find((s) => s.slug === "ek-consulting");
    expect(sec?.reportedOn).toEqual(["Schedule C", "Schedule SE"]);
    const ret = sec?.entries.find((e) => e.id.endsWith("federal-entity-return"));
    expect(ret?.applicability).toBe("not_applicable");
    expect(sec?.entries.some((e) => e.jurisdiction === "ct" && e.applicability === "needs_cpa_input")).toBe(true);
  });

  it("passes checklist progress and workspace link through to the entity section", () => {
    const data = buildFormsPageData(
      input({ workspaceIds: { [EKC.id]: "ws-1" }, checklists: { [EKC.id]: { completed: 3, total: 13 } } })
    );
    const sec = data.entities.find((s) => s.slug === "ek-consulting");
    expect(sec?.checklist).toEqual({ completed: 3, total: 13 });
    expect(sec?.workspaceHref).toBe("/tax/ws-1");
  });
});

describe("Schedule 1 and CT", () => {
  it("Schedule 1 is required when EKC or SV applies, conditional when neither does", () => {
    expect(find(buildFormsPageData(input()), "schedule-1").applicability).toBe("required");
    const lateEkc = { ...EKC, foundedDate: new Date("2030-01-01") };
    const none = buildFormsPageData(input({ entities: [PERSONAL, lateEkc, SV, MEZZO] }));
    expect(find(none, "schedule-1").applicability).toBe("conditional");
  });

  it("CT-1040 is required; CT Schedule 3 is conditional with only the property-tax field", () => {
    const data = buildFormsPageData(input());
    expect(find(data, "ct-1040").applicability).toBe("required");
    const s3 = find(data, "ct-schedule-3");
    expect(s3.applicability).toBe("conditional");
    expect(s3.fieldsTotal).toBe(1);
  });
});

describe("document matching", () => {
  const docs = [
    doc({ id: "a", docType: "w2", taxYear: 2025 }),
    doc({ id: "b", docType: "w2", taxYear: 2026 }),
    doc({ id: "c", docType: "w2", taxYear: null }),
    doc({ id: "d", docType: "w2", taxYear: 2025, archivedAt: new Date("2026-01-01") }),
    doc({ id: "e", docType: "1099", taxYear: 2025, entityId: EKC.id }),
    doc({ id: "f", docType: "tax_return", taxYear: 2023 }),
    doc({ id: "g", docType: "tax_return", taxYear: 2025 }),
  ];

  it("matches by docType + entity + year, excluding archived and null-year documents", () => {
    const ids = matchDocuments(docs, { taxYear: 2025, docTypes: ["w2"], entityIds: [PERSONAL.id] }).map((d) => d.id);
    expect(ids).toEqual(["a"]);
  });

  it("filters by entity and allows any entity when omitted", () => {
    expect(matchDocuments(docs, { taxYear: 2025, docTypes: ["1099"], entityIds: [PERSONAL.id] })).toEqual([]);
    expect(matchDocuments(docs, { taxYear: 2025, docTypes: ["1099"] }).map((d) => d.id)).toEqual(["e"]);
  });

  it("priorYear matches only strictly earlier tax years", () => {
    expect(matchDocuments(docs, { taxYear: 2025, docTypes: ["tax_return"], priorYear: true }).map((d) => d.id)).toEqual([
      "f",
    ]);
  });

  it("archived documents never appear as form inputs", () => {
    const data = buildFormsPageData(input({ documents: docs }));
    const ids = find(data, "form-1040").inputs.map((i) => i.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("d");
    expect(ids).toContain("f"); // prior-year return reference
    expect(ids).not.toContain("g"); // same-year return is not a "prior-year" reference
    expect(ids).not.toContain("e"); // EKC 1099 does not feed the personal 1040 inputs
    expect(find(data, "schedule-c").inputs.map((i) => i.id)).toContain("e");
  });

  it("document links open /documents on the Taxes tab (bucket=taxes)", () => {
    const data = buildFormsPageData(input({ documents: [doc({ id: "x", docType: "w2" })] }));
    const ref = find(data, "form-1040").inputs.find((i) => i.id === "x");
    expect(ref?.href.startsWith("/documents?bucket=taxes&")).toBe(true);
  });

  it("includes failed-extraction docs as inputs but not as extraction-complete", () => {
    const data = buildFormsPageData(
      input({ documents: [doc({ id: "x", docType: "w2", extractionStatus: "failed" })] })
    );
    const ref = find(data, "form-1040").inputs.find((i) => i.id === "x");
    expect(ref).toBeDefined();
    expect(ref?.extractionComplete).toBe(false);
  });

  it("shows person/issuer, suggesting the extraction issuer only when none is stored", () => {
    const extraction = { summary: "ok", data: { employerName: "ALPINE BIO, INC." } };
    const data = buildFormsPageData(
      input({
        documents: [
          doc({ id: "p", extractionData: extraction, subjectType: "person", subjectUser: ERIC }),
          doc({ id: "q", extractionData: extraction, issuerName: "Alpine Bio", subjectType: "joint" }),
          doc({ id: "r", extractionData: null }),
        ],
      })
    );
    const inputs = find(data, "form-1040").inputs;
    const p = inputs.find((i) => i.id === "p");
    expect(p).toMatchObject({ personLabel: "Eric", personAssigned: true, issuer: "ALPINE BIO, INC.", issuerIsSuggestion: true });
    const q = inputs.find((i) => i.id === "q");
    expect(q).toMatchObject({ personLabel: "Joint (Eric & Eva-Laura)", issuer: "Alpine Bio", issuerIsSuggestion: false });
    const r = inputs.find((i) => i.id === "r");
    expect(r).toMatchObject({ personLabel: "Unassigned", personAssigned: false, issuer: null });
  });
});

describe("K-1 row", () => {
  it("appears only when a k1 document exists for the year", () => {
    expect(allEntries(buildFormsPageData(input())).some((e) => e.id === "k1-handling")).toBe(false);
    const withK1 = buildFormsPageData(input({ documents: [doc({ id: "k", docType: "k1" })] }));
    const e = find(withK1, "k1-handling");
    expect(e.applicability).toBe("needs_cpa_input");
    expect(e.inputs.map((i) => i.id)).toEqual(["k"]);
    // wrong year -> no row
    const otherYear = buildFormsPageData(input({ documents: [doc({ id: "k", docType: "k1", taxYear: 2024 })] }));
    expect(allEntries(otherYear).some((x) => x.id === "k1-handling")).toBe(false);
  });
});

describe("readiness", () => {
  const field = (haveData: boolean) => ({ line: "l", source: "s", haveData });

  it("thresholds: none -> missing, some -> partial, all -> ready, no fields -> not_assessed", () => {
    expect(readinessFromFields([field(false), field(false)]).readiness).toBe("missing");
    expect(readinessFromFields([field(true), field(false)])).toEqual({ readiness: "partial", fieldsReady: 1, fieldsTotal: 2 });
    expect(readinessFromFields([field(true), field(true)]).readiness).toBe("ready");
    expect(readinessFromFields([]).readiness).toBe("not_assessed");
  });

  it("derives Form 1040 readiness from the existing form plan (W-2 wages present -> partial)", () => {
    const data = buildFormsPageData(
      input({
        formPlanInput: {
          documents: [
            {
              docType: "w2",
              extractionStatus: "complete",
              extractionData: { data: { wagesCents: 100000 } },
            },
          ],
          questions: [],
          ekConsultingPL: null,
          suddenValleyPL: null,
          ekConsultingMileageCount: 0,
          solarLoanOriginalCostCents: null,
        },
      })
    );
    const e = find(data, "form-1040");
    expect(e.readiness).toBe("partial");
    expect(e.fieldsTotal).toBe(8);
    expect(e.fieldsReady).toBe(1);
    expect(e.missing).toHaveLength(7);
  });

  it("Schedule 1 readiness uses only its three Form 1040 lines; Schedule SE is not assessed", () => {
    const data = buildFormsPageData(input());
    expect(find(data, "schedule-1").fieldsTotal).toBe(3);
    expect(find(data, "schedule-se").readiness).toBe("not_assessed");
  });

  it("Form 5695 becomes ready once the solar loan cost is known", () => {
    const data = buildFormsPageData(
      input({
        formPlanInput: {
          documents: [],
          questions: [],
          ekConsultingPL: null,
          suddenValleyPL: null,
          ekConsultingMileageCount: 0,
          solarLoanOriginalCostCents: 2_000_000,
        },
      })
    );
    expect(find(data, "form-5695").readiness).toBe("ready");
  });
});

describe("summary and attribution counts", () => {
  it("counts unassigned persons and missing issuers among this year's tax documents only", () => {
    const data = buildFormsPageData(
      input({
        documents: [
          doc({ id: "1", subjectType: "person", subjectUser: ERIC, issuerName: "Acme" }),
          doc({ id: "2", subjectType: null }),
          doc({ id: "3", docType: "bank_statement", entityId: EKC.id }), // not a tax doc type
          doc({ id: "4", taxYear: 2024 }), // other year
          doc({ id: "5", archivedAt: new Date("2026-01-01") }),
        ],
      })
    );
    expect(data.attribution).toEqual({ taxDocCount: 2, unassignedPersonCount: 1, missingIssuerCount: 1 });
  });

  it("summary counts add up to every entry", () => {
    const data = buildFormsPageData(input({ taxYear: 2026 }));
    const s = data.summary;
    expect(s.required + s.conditional + s.needsCpaInput + s.notApplicable).toBe(allEntries(data).length);
  });

  it("counts unanswered planning questions", () => {
    const data = buildFormsPageData(input({ questions: [question("a", null), question("b", "x")] }));
    expect(data.unansweredQuestionCount).toBe(1);
  });
});

describe("noteSaysDisregarded", () => {
  it("detects the disregarded wording, case-insensitively", () => {
    expect(noteSaysDisregarded("Single-member LLC, Disregarded entity")).toBe(true);
    expect(noteSaysDisregarded("Taxed as partnership")).toBe(false);
    expect(noteSaysDisregarded(null)).toBe(false);
  });
});
