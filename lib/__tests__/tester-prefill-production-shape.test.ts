// TESTER (independent of the Coder's tests): the prefill pipeline over the PRODUCTION-SHAPED household
//   Eric: two W-2s, box 12 code DD only, box 13 unchecked
//   Eva-Laura: W-2 with no box 12 and box 13 unchecked; W-2 with code D 54089 cents and box 13 checked
//   one 2024 federal return (married filing jointly)
// through the REAL engine (resolveFacts) -> computePrefillSuggestions -> computePrefillStates, then the engine
// interaction (no double count, owner override still raises the engine's conflicts, new pyjoint conflict).

import { describe, expect, it } from "vitest";
import { computePrefillStates, computePrefillSuggestions, type PrefillSuggestion } from "@/lib/tax-prefill";
import { effectiveAnswers, parseStoredAnswers, type StoredAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { resolveFacts, type RawAnswers, type RawDocument } from "@/lib/tax2025/resolve-facts";
import { ERIC, EVA, box12, rawInputs, returnDoc, suggestionsFor, w2doc } from "@/lib/__tests__/tax-prefill-fixtures";

const E1 = "cccccccc-0000-4000-8000-000000000001";
const E2 = "cccccccc-0000-4000-8000-000000000002";
const V1 = "cccccccc-0000-4000-8000-000000000003";
const V2 = "cccccccc-0000-4000-8000-000000000004";
const RET = "cccccccc-0000-4000-8000-000000000005";

function prodDocs(over: { eva2Verified?: boolean } = {}): RawDocument[] {
  return [
    w2doc(E1, ERIC, { employerName: "NUMU Food Group", employerEIN: "11-1111111", wagesCents: 5_000_000, box12: box12(["DD", 800_000]), retirementPlan: false }),
    w2doc(E2, ERIC, { employerName: "Alpine Bio", employerEIN: "22-2222222", wagesCents: 7_000_000, box12: box12(["DD", 650_000]), retirementPlan: false }),
    w2doc(V1, EVA, { employerName: "Seacoast Mushrooms", employerEIN: "33-3333333", wagesCents: 3_000_000, box12: [], retirementPlan: false }),
    w2doc(V2, EVA, { employerName: "Fox Farm Brewery", employerEIN: "44-4444444", wagesCents: 4_000_000, box12: box12(["D", 54_089]), retirementPlan: true }, { verified: over.eva2Verified ?? true }),
    returnDoc(RET, { filingStatus: "mfj", totalTaxCents: 3_000_000 }),
  ];
}

function byKey(s: PrefillSuggestion[], key: string): PrefillSuggestion {
  const x = s.find((q) => q.key === key);
  if (!x) throw new Error(`no suggestion ${key}; have ${s.map((q) => q.key).join(", ")}`);
  return x;
}
const vals = (s: PrefillSuggestion) => s.answers.map((a) => `${a.nodeId}=${String(a.value)}`);

describe("production-shaped household: exact suggestions", () => {
  const s = suggestionsFor(prodDocs());

  it("lists exactly the expected suggestions (no IRA/HSA/estimates/tips/age etc.)", () => {
    expect(s.map((q) => q.key).sort()).toEqual(
      [
        "return-completeness:w2_plan:eric",
        "return-completeness:w2_deferrals:eric",
        "return-completeness:w2_plan:eva",
        "return-completeness:w2_deferrals:eva",
        "return-completeness:return_filing",
        "form-2210:w2_withheld",
        "form-2210:return_no_tax",
      ].sort()
    );
  });

  it("Eric: DD is NOT a deferral -> deferrals 'none' (weak), plan 'no' (weak)", () => {
    const d = byKey(s, "return-completeness:w2_deferrals:eric");
    expect(vals(d)).toEqual(["def_eric=none"]);
    expect(d.strength).toBe("weak");
    const p = byKey(s, "return-completeness:w2_plan:eric");
    expect(vals(p)).toEqual(["plan_eric=no"]);
    expect(p.strength).toBe("weak");
  });

  it("Eva: code D 54089 cents -> some + 54089 (cents), strong; plan yes strong; only her D W-2 counted toward the amount", () => {
    const d = byKey(s, "return-completeness:w2_deferrals:eva");
    expect(vals(d)).toEqual(["def_eva=some", "defamt_eva=54089"]);
    expect(d.strength).toBe("strong");
    expect(d.docValue).toBe(54_089);
    expect(d.chip).toContain("$540.89");
    const p = byKey(s, "return-completeness:w2_plan:eva");
    expect(vals(p)).toEqual(["plan_eva=yes"]);
    expect(p.strength).toBe("strong");
    // both of Eva's W-2s are selectable and default-selected; Eric's never appear in hers
    expect(d.docIds.sort()).toEqual([V1, V2].sort());
    expect(d.candidates.map((c) => c.docId)).not.toContain(E1);
  });

  it("pyjoint from the one 2024 return (mfj -> yes, strong); ut7 (total tax > 0 -> no); ut1 (withholding > 0 -> yes)", () => {
    expect(vals(byKey(s, "return-completeness:return_filing"))).toEqual(["pyjoint=yes"]);
    expect(byKey(s, "return-completeness:return_filing").strength).toBe("strong");
    expect(vals(byKey(s, "form-2210:return_no_tax"))).toEqual(["ut7=no"]);
    expect(vals(byKey(s, "form-2210:w2_withheld"))).toEqual(["ut1=yes"]);
  });

  it("bulk-eligible set is exactly the strong, positive ones; 'no' / 'none' are never bulk", () => {
    const rc = computePrefillStates(RETURN_COMPLETENESS_ID, s, {});
    const bulk = Object.values(rc).filter((x) => x.bulk).map((x) => x.nodeId).sort();
    expect(bulk).toEqual(["def_eva", "plan_eva", "pyjoint"]);
    expect(rc.plan_eric!.bulk).toBe(false);
    expect(rc.def_eric!.bulk).toBe(false);
    const f = computePrefillStates("form-2210", s, {});
    expect(Object.values(f).filter((x) => x.bulk).map((x) => x.nodeId).sort()).toEqual(["ut1", "ut7"]);
  });

  it("an unverified Eva W-2 downgrades the positive suggestions to weak (not bulk)", () => {
    const u = suggestionsFor(prodDocs({ eva2Verified: false }));
    expect(byKey(u, "return-completeness:w2_deferrals:eva").strength).toBe("weak");
    expect(byKey(u, "return-completeness:w2_plan:eva").strength).toBe("weak");
    const st = computePrefillStates(RETURN_COMPLETENESS_ID, u, {});
    expect(st.def_eva!.bulk).toBe(false);
    expect(st.plan_eva!.bulk).toBe(false);
  });

  it("an unassigned extra W-2 downgrades both people; an unreadable one too", () => {
    const extra = w2doc("cccccccc-0000-4000-8000-0000000000aa", null, { employerName: "Orphan Co", employerEIN: "55-5555555", box12: box12(["D", 1_000]), wagesCents: 1_234_500 });
    const u = suggestionsFor([...prodDocs(), extra]);
    expect(byKey(u, "return-completeness:w2_deferrals:eva").strength).toBe("weak");
    expect(byKey(u, "return-completeness:w2_plan:eva").strength).toBe("weak");
    // the orphan is never summed into Eva's amount
    expect(byKey(u, "return-completeness:w2_deferrals:eva").docValue).toBe(54_089);
    const bad = w2doc("cccccccc-0000-4000-8000-0000000000bb", EVA, { wagesCents: null }, {});
    const u2 = suggestionsFor([...prodDocs(), bad]);
    expect(byKey(u2, "return-completeness:w2_deferrals:eva").strength).toBe("weak");
  });

  it("the 2024 return: none on file -> no pyjoint/ut7; a 2025-dated tax_return is ignored", () => {
    const noRet = suggestionsFor(prodDocs().filter((d) => d.id !== RET));
    expect(noRet.find((q) => q.ruleId === "return_filing")).toBeUndefined();
    const wrongYear = suggestionsFor([...prodDocs().filter((d) => d.id !== RET), returnDoc(RET, {}, { taxYear: 2025 })]);
    expect(wrongYear.find((q) => q.ruleId === "return_filing")).toBeUndefined();
  });

  it("codes: D E F G H S AA BB EE counted, W DD C and others not; lower-case normalised; per person only", () => {
    const eva = w2doc(V2, EVA, {
      box12: box12(["D", 100], ["e", 200], ["AA", 300], ["W", 7_000], ["DD", 9_000]),
      retirementPlan: false,
    });
    const eva2 = w2doc(V1, EVA, { box12: box12(["EE", 400], ["C", 5_000], ["BB", 500], ["S", 600]), retirementPlan: false });
    const u = suggestionsFor([eva, eva2]);
    // box12 maxItems is 4 in the extraction schema, but the engine does not cap: sum = 100+200+300 + 400+500+600
    expect(byKey(u, "return-completeness:w2_deferrals:eva").docValue).toBe(2_100);
    // W-only does not make plan "yes"
    const wOnly = suggestionsFor([w2doc(V2, EVA, { box12: box12(["W", 5_000]), retirementPlan: false })]);
    expect(vals(byKey(wOnly, "return-completeness:w2_plan:eva"))).toEqual(["plan_eva=no"]);
    expect(vals(byKey(wOnly, "return-completeness:w2_deferrals:eva"))).toEqual(["def_eva=none"]);
  });

  it("a legacy-format W-2 (retirementPlan unread) never produces a 'no' / 'none'", () => {
    const legacy = w2doc(V2, EVA, { box12: [] }, { legacyFormat: true });
    delete (legacy.extractionData as { data: Record<string, unknown> }).data.retirementPlan;
    const u = suggestionsFor([legacy]);
    expect(u.find((q) => q.key === "return-completeness:w2_deferrals:eva")).toBeUndefined();
    expect(u.find((q) => q.key === "return-completeness:w2_plan:eva")).toBeUndefined();
  });
});

// ── Engine interaction ────────────────────────────────────────────────────────

function engineAnswers(stored: StoredAnswers): RawAnswers {
  const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
  const people = rawInputs([]).people;
  const eff = effectiveAnswers(def, stored, [], RC_CONTEXT);
  const parsed = parseCompletenessAnswers(eff, people);
  return { statedNone: parsed.statedNone, returnAnswers: parsed.returnAnswers };
}

function entry(v: string | number, src?: unknown) {
  return { v, at: "2026-10-04T12:00:00.000Z", by: "u1", ...(src ? { src } : {}) };
}

const evaSrc = (docIds: string[], docValue: number) => ({ kind: "document", field: "w2.box12.deferrals", docIds, basis: "doc_verified", docValue });

describe("engine interaction (real resolveFacts)", () => {
  it("accepting Eva's document value raises NO deferral / plan conflict (document and answer agree) and does not double count", () => {
    const stored = parseStoredAnswers({
      plan_eva: entry("yes", { kind: "document", field: "w2.box13.plan", docIds: [V1, V2], basis: "doc_verified", docValue: "yes" }),
      def_eva: entry("some", evaSrc([V1, V2], 54_089)),
      defamt_eva: entry(54_089, evaSrc([V1, V2], 54_089)),
    });
    const r = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(stored) }));
    const eva = r.facts.returnAnswers.people.find((p) => p.slot === "b")!;
    expect(eva.deferralsCents.value).toBe(54_089); // exactly once, the owner answer; W-2 only cross-checks
    expect(eva.deferralsCents.basis).toBe("answer_owner");
    expect(eva.coveredByWorkplacePlan.value).toBe(true);
    expect(r.conflicts.filter((c) => c.factKey.startsWith("returnAnswers.b."))).toEqual([]);
  });

  it("real household: Planning says 401k 1393.98, W-2 code D is 540.89 -> accepting the document value raises no engine conflict (the Planning figure is not reconciled by the engine)", () => {
    const stored = parseStoredAnswers({ def_eva: entry("some", evaSrc([V1, V2], 54_089)), defamt_eva: entry(54_089, evaSrc([V1, V2], 54_089)) });
    const base = rawInputs(prodDocs(), { answers: engineAnswers(stored) });
    const r = resolveFacts({ ...base, planning: { ...base.planning, retirementContributionCents: 139_398 } });
    expect(r.conflicts.filter((c) => c.factKey.includes("deferrals") || c.factKey.includes("retirement"))).toEqual([]);
    expect(r.facts.returnAnswers.people.find((p) => p.slot === "b")!.deferralsCents.value).toBe(54_089);
  });

  it("owner override contradicting the verified W-2 still raises the engine's deferral conflict (Eva typed $1,393.98)", () => {
    // her earlier Planning answer says 401k deposits $1393.98; if she types that instead of the W-2's $540.89:
    const stored = parseStoredAnswers({ def_eva: entry("some"), defamt_eva: entry(139_398) });
    const r = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(stored) }));
    const c = r.conflicts.find((x) => x.factKey === "returnAnswers.b.deferrals");
    expect(c).toBeDefined();
    expect(c!.candidates.map((x) => Number(x.value)).sort((m, n) => m - n)).toEqual([54_089, 139_398]);
    expect(c!.chosen).toContain("owner answer");
  });

  it("override after accepting (manual save => no src) behaves exactly like a fresh owner answer: same conflict", () => {
    const withSrc = parseStoredAnswers({ def_eva: entry("some", evaSrc([V1, V2], 54_089)), defamt_eva: entry(139_398, evaSrc([V1, V2], 54_089)) });
    const without = parseStoredAnswers({ def_eva: entry("some"), defamt_eva: entry(139_398) });
    const a = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(withSrc) })).conflicts.map((c) => c.factKey);
    const b = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(without) })).conflicts.map((c) => c.factKey);
    expect(a).toEqual(b);
  });

  it("Eric accepting 'none' (0) from DD-only W-2s raises no deferral conflict; a 'plan no' vs box 13 unchecked is silent", () => {
    const stored = parseStoredAnswers({ def_eric: entry("none"), plan_eric: entry("no") });
    const r = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(stored) }));
    expect(r.conflicts.filter((c) => c.factKey.startsWith("returnAnswers.a."))).toEqual([]);
  });

  it("owner says Eric is covered (yes) against box 13 unchecked -> workplace plan conflict (not silent)", () => {
    const stored = parseStoredAnswers({ plan_eric: entry("yes") });
    const r = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(stored) }));
    expect(r.conflicts.some((c) => c.factKey === "returnAnswers.a.workplacePlan")).toBe(true);
  });

  it("new pyjoint conflict: silent when consistent, raised when the owner contradicts the 2024 return, silent with no answer / no return", () => {
    const yes = parseStoredAnswers({ pyjoint: entry("yes") });
    const no = parseStoredAnswers({ pyjoint: entry("no") });
    const keys = (st: StoredAnswers, docs = prodDocs()) => resolveFacts(rawInputs(docs, { answers: engineAnswers(st) })).conflicts.map((c) => c.factKey);
    expect(keys(yes)).not.toContain("returnAnswers.priorYear.joint");
    expect(keys(no)).toContain("returnAnswers.priorYear.joint");
    expect(keys({})).not.toContain("returnAnswers.priorYear.joint");
    expect(keys(no, prodDocs().filter((d) => d.id !== RET))).not.toContain("returnAnswers.priorYear.joint");
    const single = [...prodDocs().filter((d) => d.id !== RET), returnDoc(RET, { filingStatus: "single" })];
    expect(keys(yes, single)).toContain("returnAnswers.priorYear.joint");
    expect(keys(no, single)).not.toContain("returnAnswers.priorYear.joint");
  });

  it("two 2024 returns on file: no pyjoint conflict (ambiguous, advisory item instead)", () => {
    const two = [...prodDocs(), returnDoc("cccccccc-0000-4000-8000-0000000000cc", { filingStatus: "single" })];
    const r = resolveFacts(rawInputs(two, { answers: engineAnswers(parseStoredAnswers({ pyjoint: entry("no") })) }));
    expect(r.conflicts.map((c) => c.factKey)).not.toContain("returnAnswers.priorYear.joint");
  });

  it("src-bearing answers change nothing but the refs/note: facts values identical with and without src", () => {
    const withSrc = parseStoredAnswers({
      plan_eva: entry("yes", { kind: "document", field: "w2.box13.plan", docIds: [V1, V2], basis: "doc_verified", docValue: "yes" }),
      def_eva: entry("some", evaSrc([V1, V2], 54_089)),
      defamt_eva: entry(54_089, evaSrc([V1, V2], 54_089)),
      pyjoint: entry("yes", { kind: "document", field: "return2024.filingStatus", docIds: [RET], basis: "doc_verified", docValue: "mfj" }),
    });
    const without = parseStoredAnswers({ plan_eva: entry("yes"), def_eva: entry("some"), defamt_eva: entry(54_089), pyjoint: entry("yes") });
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "refs" || k === "note" ? undefined : x)));
    const a = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(withSrc) }));
    const b = resolveFacts(rawInputs(prodDocs(), { answers: engineAnswers(without) }));
    expect(strip(a.facts)).toEqual(strip(b.facts));
    expect(strip(a.conflicts)).toEqual(strip(b.conflicts));
    expect(strip(a.openItems)).toEqual(strip(b.openItems));
  });

  it("no EIN / SSN / employer name leaks into the refs or notes the src adds", () => {
    const withSrc = parseStoredAnswers({
      def_eva: entry("some", evaSrc([V1, V2], 54_089)),
      defamt_eva: entry(54_089, evaSrc([V1, V2], 54_089)),
    });
    const parsed = parseCompletenessAnswers(effectiveAnswers(questionnaireById(RETURN_COMPLETENESS_ID)!, withSrc, [], RC_CONTEXT), rawInputs([]).people);
    const blob = JSON.stringify(parsed);
    for (const bad of ["Fox Farm", "Seacoast", "33-3333333", "44-4444444", "Alpine", "NUMU"]) expect(blob).not.toContain(bad);
  });
});

describe("loader-shaped pipeline never exposes raw documents", () => {
  it("suggestions JSON holds no EIN, no extractionData, no wages", () => {
    const blob = JSON.stringify(computePrefillSuggestions({ year: 2025, people: rawInputs([]).people, w2s: [], w2Unusable: [], documents: prodDocs(), solarCredit: null }));
    // (w2s empty here on purpose: nothing may come from raw document data except the 2024 return fields)
    for (const bad of ["11-1111111", "22-2222222", "33-3333333", "44-4444444", "extractionData", "employerEIN", "wagesCents"]) expect(blob).not.toContain(bad);
    const full = JSON.stringify(suggestionsFor(prodDocs()));
    for (const bad of ["11-1111111", "22-2222222", "33-3333333", "44-4444444", "extractionData", "employerEIN", "wagesCents", "5000000", "7000000"]) expect(full).not.toContain(bad);
  });
});

