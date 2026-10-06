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
      donationCount: 0,
      ekConsultingFixedAssetCount: 0,
      suddenValleyBuildingAssetCount: 0,
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
      // Schedule E exists only for Sudden Valley, which has no 2025 activity: absent, not "not applicable".
      const expected = form.formName === PLAN_FORM.scheduleE ? 0 : 1;
      expect(matches, form.formName).toHaveLength(expected);
    }
    const data2026 = buildFormsPageData(input({ taxYear: 2026 }));
    const sched = allEntries(data2026).filter((e) => e.planFormName === PLAN_FORM.scheduleE);
    expect(sched).toHaveLength(1);
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
  it("Form 8880 stays needs_cpa_input for married filing separately too (IRS lists MFS under 'All other filers')", () => {
    const mfs = find(buildFormsPageData(input({ questions: [question("filing_status", "mfs")] })), "form-8880");
    expect(mfs.applicability).toBe("needs_cpa_input");
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
    // The rental form only exists once Sudden Valley is active (2026).
    const f4562 = find(buildFormsPageData(input({ taxYear: 2026 })), "form-4562");
    expect(f4562.opportunity?.key).toBe("rental_depreciation");
    expect(f4562.opportunity?.riskLabel).toBeTruthy();
    // A household form that always stays carries its opportunity in 2025 too.
    const f8889 = find(buildFormsPageData(input()), "form-8889");
    expect(f8889.opportunity?.key).toBe("hsa");
    expect(f8889.opportunity?.riskLabel).toBeTruthy();
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
  it("Schedule E is left off the page entirely for TY2025 (Sudden Valley formed Feb 2026)", () => {
    for (const year of [2024, 2025]) {
      const data = buildFormsPageData(input({ taxYear: year }));
      expect(data.federal.some((e) => e.id === "schedule-e"), `${year} federal`).toBe(false);
      const everyEntry = [...data.federal, ...data.connecticut, ...data.needsCpaInput, ...data.entities.flatMap((s) => s.entries)];
      expect(everyEntry.some((e) => e.id === "schedule-e"), `${year} anywhere`).toBe(false);
    }
  });

  it("nothing on the TY2025 page mentions Sudden Valley, its rental line, or Schedule E", () => {
    const data = buildFormsPageData(input({ taxYear: 2025 }));
    expect(data.entities.some((s) => s.slug === "sudden-valley")).toBe(false);
    const everyEntry = [...data.federal, ...data.connecticut, ...data.needsCpaInput, ...data.entities.flatMap((s) => s.entries)];
    // List offenders by id so a failure names the card that still mentions it.
    for (const pattern of [/Sudden Valley/i, /Rental income/i, /Schedule E/i]) {
      const offenders = everyEntry.filter((e) => pattern.test(JSON.stringify(e))).map((e) => e.id);
      expect(offenders, String(pattern)).toEqual([]);
    }
    // The summary counts only what is shown (no hidden Sudden Valley / Schedule E rows).
    const shown = everyEntry.length;
    const counted =
      data.summary.required + data.summary.conditional + data.summary.needsCpaInput + data.summary.notApplicable;
    expect(counted).toBe(shown);
  });

  it("Forms 4562 and 8582 (rental-only) are omitted for TY2025 but kept for TY2026; home office etc. always stay", () => {
    const ids = (year: number) => buildFormsPageData(input({ taxYear: year })).needsCpaInput.map((e) => e.id);
    expect(ids(2025)).not.toContain("form-4562");
    expect(ids(2025)).not.toContain("form-8582");
    expect(ids(2025)).toContain("form-8829");
    expect(ids(2026)).toContain("form-4562");
    expect(ids(2026)).toContain("form-8582");
  });

  it("Schedule E carries the 2025-renovation CPA note in Sudden Valley's first year (2026) only", () => {
    const e2026 = find(buildFormsPageData(input({ taxYear: 2026 })), "schedule-e");
    expect(e2026.cpaNote).toMatch(/2025 renovation/);
    expect(e2026.cpaNote).toMatch(/question for you or a tax professional/);
    // It frames a question for the CPA; it does not claim a deduction amount or decide the treatment.
    expect(e2026.cpaNote).not.toMatch(/\$\d/);
    // A later year is not the first year, so no note.
    const e2027 = find(buildFormsPageData(input({ taxYear: 2027 })), "schedule-e");
    expect(e2027.cpaNote).toBeNull();
  });

  it("Schedule 1 and Form 1040 keep the rental line and Sudden Valley wording for TY2026", () => {
    const data = buildFormsPageData(input({ taxYear: 2026 }));
    const f1040 = data.federal.find((e) => e.id === "form-1040");
    const sched1 = data.federal.find((e) => e.id === "schedule-1");
    expect(f1040?.fields.some((f) => /Rental income/.test(f.line))).toBe(true);
    expect(sched1?.fields.some((f) => /Rental income/.test(f.line))).toBe(true);
    expect(sched1?.reason).toMatch(/Sudden Valley/);
    expect(data.entities.some((s) => s.slug === "sudden-valley")).toBe(true);
  });

  it("Schedule E is required for TY2026 but must be confirmed with the CPA", () => {
    const e = find(buildFormsPageData(input({ taxYear: 2026 })), "schedule-e");
    expect(e.applicability).toBe("required");
    expect(e.confirmWithCpa).toBe(true);
    expect(e.reason).toMatch(/confirm with a tax professional if unsure/i);
  });

  it("drops the classification caveat only when the entity record says disregarded", () => {
    const svDisregarded = { ...SV, taxStatusNotes: "Single-member LLC, disregarded entity" };
    const e = find(buildFormsPageData(input({ taxYear: 2026, entities: [PERSONAL, EKC, svDisregarded, MEZZO] })), "schedule-e");
    expect(e.confirmWithCpa).toBe(false);
  });

  it("the Sudden Valley section flags the unconfirmed classification for 2026 and is absent for 2025", () => {
    const d2026 = buildFormsPageData(input({ taxYear: 2026 }));
    const sec = d2026.entities.find((s) => s.slug === "sudden-valley");
    expect(sec?.activeForYear).toBe(true);
    expect(sec?.reportedOn).toEqual(["Schedule E"]);
    const ret = sec?.entries.find((e) => e.id.endsWith("federal-entity-return"));
    expect(ret?.applicability).toBe("needs_cpa_input");
    expect(ret?.confirmWithCpa).toBe(true);

    const d2025 = buildFormsPageData(input({ taxYear: 2025 }));
    expect(d2025.entities.find((s) => s.slug === "sudden-valley")).toBeUndefined();
  });

  it("Mezzo (not formed) is left off the page entirely: no section, no row, no form, in any year (ai-payload-fixes)", () => {
    for (const year of [2025, 2026]) {
      const data = buildFormsPageData(input({ taxYear: year }));
      expect(data.entities.find((s) => s.slug === "mezzo")).toBeUndefined();
      expect(JSON.stringify(data)).not.toMatch(/mezzo/i);
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
          donationCount: 0,
          ekConsultingFixedAssetCount: 0,
          suddenValleyBuildingAssetCount: 0,
        },
      })
    );
    const e = find(data, "form-1040");
    expect(e.readiness).toBe("partial");
    // 8 plan lines minus "Rental income (Schedule 1)", which is Sudden Valley-only and omitted for 2025.
    expect(e.fieldsTotal).toBe(7);
    expect(e.fieldsReady).toBe(1);
    expect(e.missing).toHaveLength(6);
  });

  it("Schedule 1 readiness uses only its Form 1040 lines (rental line only once Sudden Valley is active); Schedule SE is not assessed", () => {
    const data = buildFormsPageData(input());
    expect(find(data, "schedule-1").fieldsTotal).toBe(2);
    expect(find(buildFormsPageData(input({ taxYear: 2026 })), "schedule-1").fieldsTotal).toBe(3);
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
          donationCount: 0,
          ekConsultingFixedAssetCount: 0,
          suddenValleyBuildingAssetCount: 0,
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

// ── Donation log / fixed-asset register tie-in ────────────────────────────────

describe("donation log and fixed-asset lines flow into form readiness", () => {
  const base = input().formPlanInput;
  const line = (e: ReturnType<typeof find>, name: string) => e.fields.find((f) => f.line === name);

  it("Schedule C readiness: depreciation line 13 gains data when an EK Consulting asset exists (fieldsReady +1)", () => {
    const before = find(buildFormsPageData(input({ formPlanInput: base })), "schedule-c");
    const after = find(buildFormsPageData(input({ formPlanInput: { ...base, ekConsultingFixedAssetCount: 1 } })), "schedule-c");
    expect(line(before, "Depreciation (line 13)")?.haveData).toBe(false);
    expect(line(after, "Depreciation (line 13)")?.haveData).toBe(true);
    expect(line(after, "Depreciation (line 13)")?.basis).toBe("not_document_based");
    expect(after.fieldsReady).toBe(before.fieldsReady + 1);
  });

  it("Schedule A: a donation, or a confirmed 'none', gives line 11 data; an empty log does not", () => {
    const empty = find(buildFormsPageData(input({ formPlanInput: base })), "schedule-a");
    expect(line(empty, "Gifts to charity (line 11)")?.haveData).toBe(false);
    expect(line(empty, "Gifts to charity (line 11)")?.fixes?.map((f) => f.kind)).toEqual(["donation", "confirm_none", "link"]);

    const withGift = find(buildFormsPageData(input({ formPlanInput: { ...base, donationCount: 2 } })), "schedule-a");
    expect(line(withGift, "Gifts to charity (line 11)")?.haveData).toBe(true);
    expect(line(withGift, "Gifts to charity (line 11)")?.fixes).toBeUndefined();

    const questions = [{ key: "donations_none", answer: "none", skippedReason: null }];
    const none = find(buildFormsPageData(input({ questions, formPlanInput: { ...base, questions } })), "schedule-a");
    expect(line(none, "Gifts to charity (line 11)")?.haveData).toBe(true);
  });

  it("Schedule E line 18 needs a building asset (or 'none'); entity ids reach the fixed-asset fixes", () => {
    const missing = find(buildFormsPageData(input({ taxYear: 2026, formPlanInput: base })), "schedule-e");
    const fix = line(missing, "Depreciation (line 18)")?.fixes?.[0];
    expect(fix?.kind).toBe("fixed_asset");
    if (fix?.kind === "fixed_asset") expect(fix.entityId).toBe(SV.id);
    const have = find(
      buildFormsPageData(input({ taxYear: 2026, formPlanInput: { ...base, suddenValleyBuildingAssetCount: 1 } })),
      "schedule-e"
    );
    expect(line(have, "Depreciation (line 18)")?.haveData).toBe(true);
  });

  it("Form 4562 copy no longer claims nothing is recorded, and says the CPA decides", () => {
    const f4562 = find(buildFormsPageData(input({ taxYear: 2026 })), "form-4562");
    expect(f4562.reason).not.toMatch(/no purchase price/i);
    expect(f4562.reason).toMatch(/your decision/);
    expect(f4562.reason).toMatch(/does not compute depreciation/);
  });

  it("Schedule A note says logged gifts are not in the 2025 draft's itemized total", () => {
    const a = find(buildFormsPageData(input()), "schedule-a");
    expect(a.cpaNote).toMatch(/NOT included in the 2025 draft/);
  });
});

describe("noteSaysDisregarded", () => {
  it("detects the disregarded wording, case-insensitively", () => {
    expect(noteSaysDisregarded("Single-member LLC, Disregarded entity")).toBe(true);
    expect(noteSaysDisregarded("Taxed as partnership")).toBe(false);
    expect(noteSaysDisregarded(null)).toBe(false);
  });
});

// ── Pass 3: extraction basis on the Forms page ────────────────────────────────

describe("extraction basis (verified / unverified AI / missing)", () => {
  const w2Data = { data: { wagesCents: 100000, federalWithheldCents: 20000, stateWithheldCents: 5000 } };
  const planInput = (verified: boolean) => ({
    documents: [
      { docType: "w2", extractionStatus: "complete", extractionData: w2Data, verified },
    ],
    questions: [],
    ekConsultingPL: null,
    suddenValleyPL: null,
    ekConsultingMileageCount: 0,
    solarLoanOriginalCostCents: null,
    donationCount: 0,
    ekConsultingFixedAssetCount: 0,
    suddenValleyBuildingAssetCount: 0,
  });

  it("per-field basis and per-form counts: unverified W-2 -> Form 1040 fields counted as unverified AI", () => {
    const data = buildFormsPageData(input({ formPlanInput: planInput(false) }));
    const e = find(data, "form-1040");
    expect(e.fields.find((f) => f.line === "Wages (line 1a)")?.basis).toBe("unverified");
    expect(e.fields.find((f) => f.line === "Gifts to charity (line 11)")).toBeUndefined(); // that is Schedule A
    expect(e.fieldsUnverified).toBe(2); // wages + withholding
    expect(e.fieldsVerified).toBe(0);
    expect(e.fieldsReady).toBe(2);
    expect(e.missing).toHaveLength(e.fieldsTotal - 2);
  });

  it("a verified W-2 counts as verified, and verified + unverified + other + missing partition the total", () => {
    const data = buildFormsPageData(input({ formPlanInput: planInput(true) }));
    for (const e of allEntries(data)) {
      if (e.fieldsTotal === 0) continue;
      const accounted = e.fieldsVerified + e.fieldsUnverified + e.fieldsOtherSource + e.missing.length;
      expect(accounted, e.id).toBe(e.fieldsTotal);
    }
    const e = find(data, "form-1040");
    expect(e.fieldsVerified).toBe(2);
    expect(e.fieldsUnverified).toBe(0);
    expect(find(data, "ct-1040").fields.find((f) => f.line === "CT withholding (W-2 box 17)")?.basis).toBe("verified");
  });

  it("with no data every field is missing and no counts are claimed", () => {
    const data = buildFormsPageData(input());
    const e = find(data, "form-1040");
    expect(e.fieldsVerified + e.fieldsUnverified + e.fieldsOtherSource).toBe(0);
    expect(e.fields.every((f) => f.basis === "missing")).toBe(true);
  });

  it("property-tax lines are missing for a bill with no paid amount (and Schedule 3 copy no longer claims 'uploaded and processed')", () => {
    const data = buildFormsPageData(
      input({
        formPlanInput: {
          ...planInput(true),
          documents: [{ docType: "property_tax", extractionStatus: "complete", extractionData: { data: {} }, verified: true }],
        },
      })
    );
    expect(find(data, "ct-schedule-3").fields[0]?.basis).toBe("missing");
    expect(find(data, "ct-schedule-3").reason).not.toContain("uploaded and processed");
    expect(find(data, "schedule-a").cpaNote ?? "").not.toContain("never yield a dollar amount");
    expect(find(data, "schedule-a").cpaNote ?? "").toContain("paid in the tax year");
  });

  it("input refs carry the Documents-list extraction state, verified flag and review link", () => {
    const extraction = {
      kind: "extracted_unverified" as const,
      label: "Extracted - needs review",
      tone: "amber" as const,
      actions: ["review" as const, "reextract" as const],
      outdated: false,
      correctionCount: 0,
    };
    const data = buildFormsPageData(
      input({
        documents: [
          doc({ id: "x", docType: "w2", extraction, verified: false }),
          doc({ id: "n", docType: "1099", extraction: { ...extraction, kind: "not_extracted", label: "Not extracted", actions: ["run"] } }),
        ],
      })
    );
    const refs = find(data, "form-1040").inputs;
    const x = refs.find((r) => r.id === "x");
    expect(x?.extraction?.label).toBe("Extracted - needs review");
    expect(x?.reviewHref).toBe("/documents/x/review");
    expect(x?.verified).toBe(false);
    // nothing readable yet -> no review link (a Review page would offer a paid run)
    expect(refs.find((r) => r.id === "n")?.reviewHref).toBeNull();
  });

  it("summarises this year's tax documents by extraction kind (policy included), skipping N/A and unknown ones", () => {
    const base = { tone: "muted" as const, actions: [], outdated: false, correctionCount: 0 };
    const data = buildFormsPageData(
      input({
        documents: [
          doc({ id: "1", extraction: { ...base, kind: "verified", label: "Verified" } }),
          doc({ id: "2", extraction: { ...base, kind: "extracted_outdated", label: "Extracted - older format", outdated: true } }),
          doc({ id: "3", extraction: { ...base, kind: "extracted_unverified", label: "Extracted - needs review" } }),
          doc({ id: "4", extraction: { ...base, kind: "failed", label: "Failed" } }),
          doc({ id: "5", docType: "extension", extraction: { ...base, kind: "na", label: "N/A" } }),
          doc({ id: "6", taxYear: 2024, extraction: { ...base, kind: "verified", label: "Verified" } }), // other year
          doc({ id: "7" }), // no extraction state supplied
        ],
      })
    );
    expect(data.extractionBasis).toEqual({
      policy: "verified_else_ai",
      documentCount: 4,
      verified: 1,
      unverified: 2,
      olderFormat: 1,
      noReading: 1,
    });
  });
});

// ── Donation receipts on the Forms page (donation-receipt-document-type) ───────

describe("a donation_receipt document on the Forms page", () => {
  const receipt = (over: Partial<FormsDocumentInput> = {}) =>
    doc({ id: "r1", docType: "donation_receipt", documentName: "Donation Receipt", issuerName: "Food Bank", ...over });
  const line = (e: ReturnType<typeof find>, name: string) => e.fields.find((f) => f.line === name);

  it("counts as one of the year's tax documents (attribution counts)", () => {
    const data = buildFormsPageData(input({ documents: [receipt()] }));
    expect(data.attribution).toEqual({ taxDocCount: 1, unassignedPersonCount: 1, missingIssuerCount: 0 });
  });

  it("is counted in the extraction basis like any other tax document", () => {
    const extraction = { kind: "extracted_unverified" as const, label: "x", tone: "amber" as const, actions: [], outdated: false, correctionCount: 0 };
    const data = buildFormsPageData(input({ documents: [receipt({ extraction })] }));
    expect(data.extractionBasis.documentCount).toBe(1);
    expect(data.extractionBasis.unverified).toBe(1);
  });

  it("is listed as a Schedule A source document for its year only", () => {
    const data = buildFormsPageData(input({ documents: [receipt(), receipt({ id: "r2", taxYear: 2024 })] }));
    expect(find(data, "schedule-a").inputs.map((i) => i.id)).toEqual(["r1"]);
  });

  it("never changes whether Schedule A line 11 has data (only the log or a 'none' confirmation does)", () => {
    const without = find(buildFormsPageData(input()), "schedule-a");
    const withReceipt = find(buildFormsPageData(input({ documents: [receipt()] })), "schedule-a");
    expect(line(withReceipt, "Gifts to charity (line 11)")?.haveData).toBe(false);
    expect(withReceipt.fields.map((f) => f.haveData)).toEqual(without.fields.map((f) => f.haveData));
    expect(withReceipt.fieldsReady).toBe(without.fieldsReady);
  });
});

// ── Retirement statements on the Forms page (retirement-contribution-document-type) ──

describe("a retirement_contribution document on the Forms page", () => {
  const statement = (over: Partial<FormsDocumentInput> = {}) =>
    doc({ id: "ret1", docType: "retirement_contribution", documentName: "Retirement Contributions", issuerName: "Betterment", ...over });

  it("counts as one of the year's tax documents (attribution counts)", () => {
    const data = buildFormsPageData(input({ documents: [statement()] }));
    expect(data.attribution).toEqual({ taxDocCount: 1, unassignedPersonCount: 1, missingIssuerCount: 0 });
    expect(buildFormsPageData(input({ documents: [statement({ issuerName: null })] })).attribution.missingIssuerCount).toBe(1);
  });

  it("is counted in the extraction basis like any other tax document", () => {
    const extraction = { kind: "extracted_unverified" as const, label: "x", tone: "amber" as const, actions: [], outdated: false, correctionCount: 0 };
    const data = buildFormsPageData(input({ documents: [statement({ extraction })] }));
    expect(data.extractionBasis.documentCount).toBe(1);
    expect(data.extractionBasis.unverified).toBe(1);
  });

  it("is listed as a source document on the Form 8880 card for its year only, and changes no readiness anywhere", () => {
    const withDocs = buildFormsPageData(input({ documents: [statement(), statement({ id: "ret2", taxYear: 2024 })] }));
    const without = buildFormsPageData(input());
    expect(find(withDocs, "form-8880").inputs.map((i) => i.id)).toEqual(["ret1"]);
    expect(find(without, "form-8880").inputs).toEqual([]);
    const strip = (d: FormsPageData) =>
      allEntries(d).map((e) => ({ id: e.id, applicability: e.applicability, readiness: e.readiness, fieldsReady: e.fieldsReady, fieldsTotal: e.fieldsTotal }));
    expect(strip(withDocs)).toEqual(strip(without));
  });

  it("has a Forms label", () => {
    expect(CPA_INPUT_FORMS.find((f) => f.id === "form-8880")?.inputDocTypes).toEqual(["retirement_contribution"]);
  });
});
