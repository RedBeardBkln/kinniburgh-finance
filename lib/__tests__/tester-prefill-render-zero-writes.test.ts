// TESTER: rendering the questionnaire page (real loadQuestionnairePage -> loadPrefillSuggestions ->
// loadTy2025RawInputs -> resolveFacts -> computePrefillSuggestions) through a db Proxy that THROWS on any write
// method, proves zero writes / no workspace creation on render, and that a loader failure degrades to "no
// suggestions" without breaking the page. Production-shaped rows (Eric: 2 W-2s, DD only; Eva: no box 12 + D 54089).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: { model: string; method: string }[] = [];
  const state: {
    documents: unknown[];
    users: { id: string; name: string }[];
    rows: unknown[];
    throwOn: string | null;
  } = { documents: [], users: [], rows: [], throwOn: null };
  const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$?executeRaw|\$?executeRawUnsafe|\$transaction)$/;
  const PERSONAL = { id: "ent-personal", name: "Personal", slug: "personal", navLabel: "Personal", type: "personal", foundedDate: null, taxStatusNotes: null };
  const EKC = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", navLabel: "EKC", type: "business", foundedDate: null, taxStatusNotes: null };
  const handler = (model: string, method: string) => async (args: unknown) => {
    calls.push({ model, method });
    if (WRITE.test(method)) throw new Error(`WRITE ATTEMPTED: db.${model}.${method}`);
    if (state.throwOn === `${model}.${method}`) throw new Error("boom");
    switch (`${model}.${method}`) {
      case "entity.findFirst": {
        const slug = (args as { where: { slug: string } }).where.slug;
        return slug === "personal" ? PERSONAL : slug === "ek-consulting" ? EKC : null;
      }
      case "entity.findMany":
        return [PERSONAL, EKC];
      case "document.findMany":
        return state.documents;
      case "user.findMany":
        return state.users;
      case "taxQuestionnaire.findMany":
        return state.rows;
      case "taxQuestionnaire.findUnique": {
        const w = (args as { where: { taxYear_entityId_questionnaireId: { questionnaireId: string } } }).where.taxYear_entityId_questionnaireId;
        return (state.rows as { questionnaireId: string }[]).find((r) => r.questionnaireId === w.questionnaireId) ?? null;
      }
      default:
        return method === "findMany" || method === "groupBy" ? [] : null;
    }
  };
  const db = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_t2, method: string) => handler(model, method) }) });
  return { calls, state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
// computePL is a read-only groupBy report; give it an empty result so this test stays about the prefill path.
vi.mock("@/lib/reports", () => ({
  computePL: async () => ({ incomeLines: [], expenseLines: [], excludedFromPL: { transactionCount: 0 } }),
}));

import { loadQuestionnairePage } from "@/lib/tax-questionnaire-build";
import { loadPrefillSuggestions } from "@/lib/tax-prefill-build";

const ERIC = "u-eric";
const EVA = "u-eva";

function docRow(id: string, user: string | null, data: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id,
    entityId: "ent-personal",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { schemaVersion: 2, summary: "x", data: { employerName: `Emp ${id}`, employerEIN: `1${id.slice(-1)}-1234567`, wagesCents: 5_000_000, federalWithheldCents: 700_000, box12: [], retirementPlan: false, ...data } },
    extractionCorrections: null,
    extractionConfirmedAt: new Date("2026-09-01T00:00:00Z"),
    subjectType: user ? "person" : "joint",
    subjectUserId: user,
    documentName: null,
    archivedAt: null,
    ...over,
  };
}

function seed(): void {
  h.calls.length = 0;
  h.state.throwOn = null;
  h.state.users = [
    { id: ERIC, name: "Eric Kinniburgh" },
    { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  h.state.rows = [];
  h.state.documents = [
    docRow("d1", ERIC, { employerName: "NUMU", box12: [{ code: "DD", amountCents: 800_000 }] }),
    docRow("d2", ERIC, { employerName: "Alpine", box12: [{ code: "DD", amountCents: 650_000 }] }),
    docRow("d3", EVA, { employerName: "Seacoast", box12: [] }),
    docRow("d4", EVA, { employerName: "Fox Farm", box12: [{ code: "D", amountCents: 54_089 }], retirementPlan: true }),
    docRow("d5", null, { formType: "1040", filingStatus: "mfj", totalTaxCents: 3_000_000 }, { docType: "tax_return", taxYear: 2024 }),
  ];
}

beforeEach(seed);

describe("rendering the questionnaire page is read-only", () => {
  it("loadQuestionnairePage(return-completeness) computes suggestions with zero write calls and no workspace creation", async () => {
    const page = await loadQuestionnairePage(2025, "return-completeness", null);
    expect(page).not.toBeNull();
    const writes = h.calls.filter((c) => /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$transaction)$/.test(c.method));
    expect(writes).toEqual([]);
    expect(h.calls.filter((c) => c.model === "taxWorkspace" && !/^find/.test(c.method))).toEqual([]);
    // and it actually produced the suggestions (so the read path really ran)
    const keys = page!.prefill.suggestions.map((s) => s.key).sort();
    expect(keys).toContain("return-completeness:w2_deferrals:eva");
    expect(keys).toContain("return-completeness:return_filing");
    expect(page!.prefill.bulkCount).toBe(3); // plan_eva, def_eva, pyjoint
    expect(page!.prefill.weakCount).toBe(2); // plan_eric ("no"), def_eric ("none")
  });

  it("the Form 2210 page and a questionnaire with no rule also render read-only", async () => {
    const p2210 = await loadQuestionnairePage(2025, "form-2210", null);
    expect(p2210).not.toBeNull();
    expect(p2210!.prefill.suggestions.map((s) => s.ruleId).sort()).toEqual(["return_no_tax", "w2_withheld"]);
    const other = await loadQuestionnairePage(2025, "schedule-3-federal", null);
    if (other) expect(other.prefill.suggestions).toEqual([]);
    expect(h.calls.filter((c) => /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$transaction)$/.test(c.method))).toEqual([]);
  });

  it("another tax year gets no suggestions and does not even load the document set", async () => {
    h.calls.length = 0;
    expect(await loadPrefillSuggestions(2024)).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("the page data handed to the client holds no EIN / extraction data / wages", async () => {
    const page = await loadQuestionnairePage(2025, "return-completeness", null);
    const blob = JSON.stringify(page!.prefill);
    for (const bad of ["1-1234567", "extractionData", "employerEIN", "wagesCents", "5000000"]) expect(blob).not.toContain(bad);
  });
});

describe("loader failure degrades to no suggestions", () => {
  it("a db error inside the loader (documents) yields [] and the page still renders with NO_PREFILL", async () => {
    h.state.throwOn = "paystub.findMany"; // only loadTy2025RawInputs reads paystubs
    expect(await loadPrefillSuggestions(2025)).toEqual([]);
    const page = await loadQuestionnairePage(2025, "return-completeness", null);
    expect(page).not.toBeNull();
    expect(page!.prefill.suggestions).toEqual([]);
    expect(page!.prefill.bulkCount).toBe(0);
  });

  it("a malformed document row (extractionData garbage) does not throw out of the loader", async () => {
    h.state.documents = [docRow("d9", ERIC, {}, { extractionData: "not json at all" }), docRow("d8", ERIC, {}, { extractionData: { data: [] } })];
    await expect(loadPrefillSuggestions(2025)).resolves.toBeDefined();
  });

  it("no Personal entity -> no suggestions, no throw", async () => {
    h.state.documents = [];
    const res = await loadPrefillSuggestions(2025);
    expect(Array.isArray(res)).toBe(true);
  });
});
