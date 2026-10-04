import { describe, expect, it } from "vitest";
import {
  DEFERRAL_CODES,
  PREFILL_RULES,
  buildAnswerSource,
  classifyStaleness,
  combineContributions,
  computePrefillStates,
  computePrefillSuggestions,
  formatDocValue,
  prefillNodeIdsFor,
  ruleForNode,
  safeLabel,
  type PrefillInput,
  type PrefillSuggestion,
} from "@/lib/tax-prefill";
import { questionnaireById } from "@/lib/tax-questionnaire-content";
import { validateAnswerValue, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { RC_CONTEXT } from "@/lib/tax2025/answers";
import { emptyReturnAnswers } from "@/lib/tax2025/facts";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { sourced } from "@/lib/tax2025/types";

const ERIC = "user-eric";
const EVA = "user-eva";

function doc(over: Partial<RawDocument> & { id: string; docType: string; data: Record<string, unknown> }): RawDocument {
  const { data, ...rest } = over;
  return {
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { summary: "x", data },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: ERIC,
    documentName: null,
    ...rest,
  };
}

let einCounter = 0;

/** Each call gets its own employer EIN so two fixtures are never exact duplicates of each other (the engine collapses those). */
function w2doc(id: string, person: string | null, data: Record<string, unknown> = {}, over: Partial<RawDocument> = {}): RawDocument {
  einCounter += 1;
  return doc({
    id,
    docType: "w2",
    subjectType: person ? "person" : null,
    subjectUserId: person,
    data: {
      employerName: `Employer ${id}`,
      employerEIN: `10-${String(einCounter).padStart(7, "0")}`,
      wagesCents: 9_000_000,
      federalWithheldCents: 1_100_000,
      socialSecurityWagesCents: 9_000_000,
      socialSecurityWithheldCents: 558_000,
      medicareWagesCents: 9_000_000,
      medicareWithheldCents: 130_500,
      stateLines: [{ stateCode: "CT", stateWagesCents: 9_000_000, stateWithheldCents: 300_000 }],
      box12: [],
      retirementPlan: false,
      ...data,
    },
    ...over,
  });
}

function returnDoc(id: string, data: Record<string, unknown>, over: Partial<RawDocument> = {}): RawDocument {
  return doc({
    id,
    docType: "tax_return",
    taxYear: 2024,
    subjectType: "joint",
    subjectUserId: null,
    data: { formType: "1040", filingStatus: "mfj", totalTaxCents: 3_000_000, agiCents: 12_000_000, ...data },
    ...over,
  });
}

function raw(documents: RawDocument[], over: Partial<RawTy2025Inputs> = {}): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC, name: "Eric Kinniburgh" },
      { userId: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
    ],
    scheduleCOwner: { userId: ERIC, basis: "derived", note: "x" },
    documents,
    planning: {
      filingStatus: "mfj",
      householdMembers: "none",
      evVehicle: "no",
      businessMileage: "no",
      homeOfficeEligibility: "no",
      homeOfficeSqft: null,
      solarCredit: null,
      donationsNone: true,
      fixedAssetsEkcNone: true,
      retirementContributionCents: null,
      estimatedPaymentsCombinedCents: null,
    },
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
    ...over,
  };
}

function inputFor(r: RawTy2025Inputs): PrefillInput {
  const { facts } = resolveFacts(r);
  return {
    year: 2025,
    people: r.people,
    w2s: facts.income.w2s,
    w2Unusable: facts.income.w2Unusable,
    documents: r.documents,
    solarCredit: r.planning.solarCredit,
  };
}

function suggest(documents: RawDocument[], over: Partial<RawTy2025Inputs> = {}): PrefillSuggestion[] {
  return computePrefillSuggestions(inputFor(raw(documents, over)));
}

const byKey = (list: PrefillSuggestion[], key: string): PrefillSuggestion | undefined => list.find((s) => s.key === key);
const RC = "return-completeness";
const F2210 = "form-2210";
const box12 = (...e: [string, number][]) => e.map(([code, amountCents]) => ({ code, amountCents }));

describe("W-2 elective deferrals (def_k / defamt_k)", () => {
  it("sums codes across a person's W-2s and names both employers", () => {
    const list = suggest([
      w2doc("a", ERIC, { employerName: "Alpine Bio", box12: box12(["D", 1_200_000]) }),
      w2doc("b", ERIC, { employerName: "NUMU Food Group", box12: box12(["AA", 650_000]) }),
    ]);
    const s = byKey(list, `${RC}:w2_deferrals:eric`)!;
    expect(s.answers).toEqual([
      { nodeId: "def_eric", value: "some" },
      { nodeId: "defamt_eric", value: 1_850_000 },
    ]);
    expect(s.strength).toBe("strong");
    expect(s.basis).toBe("doc_verified");
    expect(s.docIds.sort()).toEqual(["a", "b"]);
    expect(s.chip).toContain("Alpine Bio");
    expect(s.chip).toContain("NUMU Food Group");
    expect(s.chip).toContain("AA + D");
    expect(s.chip).toContain("$18,500.00");
    expect(s.chip).toContain("verified");
  });

  it("counts D E F G H S AA BB EE, ignores W and DD, and reads lower-case codes like the engine", () => {
    const codes = ["D", "E", "F", "G", "H", "S", "AA", "BB", "EE"];
    const list = suggest([
      w2doc("a", ERIC, { box12: box12(...codes.slice(0, 4).map((c): [string, number] => [c, 10_000])) }),
      w2doc("b", ERIC, { box12: box12(...codes.slice(4).map((c): [string, number] => [c, 10_000]), ["W", 300_000], ["DD", 1_000_000]) }),
      w2doc("c", ERIC, { box12: box12(["aa", 5_000]), employerEIN: "11-1111111" }),
    ]);
    const s = byKey(list, `${RC}:w2_deferrals:eric`)!;
    expect(s.answers[1]).toEqual({ nodeId: "defamt_eric", value: 9 * 10_000 + 5_000 });
  });

  it("agrees with the engine's own deferral sum (parity with resolveFacts' cross-check)", () => {
    const docs = [
      w2doc("a", ERIC, { box12: box12(["D", 1_200_000], ["W", 300_000]) }),
      w2doc("b", ERIC, { box12: box12(["EE", 10_000], ["DD", 90_000]), employerEIN: "22-2222222" }),
    ];
    const r = raw(docs);
    const people = emptyReturnAnswers([
      { slot: "a", userId: ERIC, name: "Eric" },
      { slot: "b", userId: EVA, name: "Eva" },
    ]);
    people.people[0]!.deferralsCents = sourced(0, "answer_owner", []);
    const resolved = resolveFacts({ ...r, answers: { returnAnswers: people } });
    const conflict = resolved.conflicts.find((c) => c.factKey === "returnAnswers.a.deferrals")!;
    const engineTotal = conflict.candidates.find((c) => c.basis !== "answer_owner")!.value;
    const s = byKey(computePrefillSuggestions(inputFor(r)), `${RC}:w2_deferrals:eric`)!;
    expect(s.answers[1]!.value).toBe(engineTotal);
    // the exported set the engine uses is the same one pinned here
    expect([...DEFERRAL_CODES].sort()).toEqual(["AA", "BB", "D", "E", "EE", "F", "G", "H", "S"]);
  });

  it("suggests 'none' (weak) only when every W-2 is current-format and the sum is zero", () => {
    const none = byKey(suggest([w2doc("a", ERIC, { box12: box12(["W", 300_000]) })]), `${RC}:w2_deferrals:eric`)!;
    expect(none.answers).toEqual([{ nodeId: "def_eric", value: "none" }]);
    expect(none.strength).toBe("weak");
    expect(none.caveats.join(" ")).toContain("not proof");
    const legacy = suggest([w2doc("a", ERIC, {}, { legacyFormat: true })]);
    expect(byKey(legacy, `${RC}:w2_deferrals:eric`)).toBeUndefined();
  });

  it("is weak for an unverified or legacy-format W-2 even with a positive amount", () => {
    const un = byKey(suggest([w2doc("a", ERIC, { box12: box12(["D", 100_000]) }, { verified: false })]), `${RC}:w2_deferrals:eric`)!;
    expect(un.strength).toBe("weak");
    expect(un.basis).toBe("doc_unverified");
    expect(un.chip).toContain("unverified AI read");
    const leg = byKey(suggest([w2doc("a", ERIC, { box12: box12(["D", 100_000]) }, { legacyFormat: true })]), `${RC}:w2_deferrals:eric`)!;
    expect(leg.strength).toBe("weak");
  });

  it("shows a mixed verified / unverified selection honestly", () => {
    const s = byKey(
      suggest([w2doc("a", ERIC, { box12: box12(["D", 100_000]) }), w2doc("b", ERIC, { box12: box12(["D", 50_000]), employerEIN: "33-3333333" }, { verified: false })]),
      `${RC}:w2_deferrals:eric`
    )!;
    expect(s.strength).toBe("weak");
    expect(s.chip).toContain("1 of 2 verified");
  });
});

describe("W-2 workplace plan (plan_k)", () => {
  it("is yes when box 13 is checked on one of two W-2s", () => {
    const s = byKey(suggest([w2doc("a", ERIC, { retirementPlan: true }), w2doc("b", ERIC, { retirementPlan: false, employerEIN: "44-4444444" })]), `${RC}:w2_plan:eric`)!;
    expect(s.answers).toEqual([{ nodeId: "plan_eric", value: "yes" }]);
    expect(s.strength).toBe("strong");
  });

  it("is yes from a deferral code even when box 13 reads unchecked", () => {
    const s = byKey(suggest([w2doc("a", ERIC, { retirementPlan: false, box12: box12(["D", 5_000]) })]), `${RC}:w2_plan:eric`)!;
    expect(s.answers[0]!.value).toBe("yes");
  });

  it("is a weak 'no' only when every W-2 is current-format with box 13 read as unchecked", () => {
    const s = byKey(suggest([w2doc("a", ERIC, { retirementPlan: false })]), `${RC}:w2_plan:eric`)!;
    expect(s.answers[0]!.value).toBe("no");
    expect(s.strength).toBe("weak");
    expect(s.caveats.join(" ")).toContain("SEP");
    // an unread box 13 (null) or a legacy W-2 never yields "no"
    expect(byKey(suggest([w2doc("a", ERIC, { retirementPlan: undefined })]), `${RC}:w2_plan:eric`)).toBeUndefined();
    expect(byKey(suggest([w2doc("a", ERIC, { retirementPlan: false }, { legacyFormat: true })]), `${RC}:w2_plan:eric`)).toBeUndefined();
  });
});

describe("person matching and candidate lists", () => {
  it("never counts an unassigned / joint / other-person W-2; lists the unassigned one and downgrades to weak", () => {
    const list = suggest([
      w2doc("mine", ERIC, { box12: box12(["D", 100_000]) }),
      w2doc("loose", null, { box12: box12(["D", 999_000]), employerEIN: "55-5555555" }),
      w2doc("joint", null, { employerEIN: "66-6666666" }, { subjectType: "joint", subjectUserId: null }),
      w2doc("eva", EVA, { box12: box12(["D", 888_000]), employerEIN: "77-7777777" }),
    ]);
    const s = byKey(list, `${RC}:w2_deferrals:eric`)!;
    expect(s.answers[1]).toEqual({ nodeId: "defamt_eric", value: 100_000 });
    expect(s.strength).toBe("weak");
    expect(s.caveats.join(" ")).toContain("not assigned to a person");
    const listed = s.candidates.map((c) => [c.docId, c.selectable, c.exclusion]);
    expect(listed).toContainEqual(["mine", true, null]);
    expect(listed).toContainEqual(["loose", false, "unassigned"]);
    expect(listed).toContainEqual(["joint", false, "unassigned"]);
    expect(listed.map((x) => x[0])).not.toContain("eva");
    expect(byKey(list, `${RC}:w2_deferrals:eva`)!.answers[1]!.value).toBe(888_000);
  });

  it("makes no per-person suggestion when two household users match a first name", () => {
    const r = raw([w2doc("a", ERIC, { box12: box12(["D", 1_000]) })], {
      people: [
        { userId: ERIC, name: "Eric Kinniburgh" },
        { userId: "user-eric2", name: "Eric Other" },
        { userId: EVA, name: "Eva" },
      ],
    });
    expect(computePrefillSuggestions(inputFor(r)).filter((s) => s.person === "eric")).toEqual([]);
  });

  it("counts an exact duplicate once and lists the copy as a duplicate without downgrading", () => {
    const a = w2doc("a", ERIC, { box12: box12(["D", 100_000]), employerEIN: "12-3456789" });
    const b = w2doc("b", ERIC, { box12: box12(["D", 100_000]), employerEIN: "12-3456789" });
    const s = byKey(suggest([a, b]), `${RC}:w2_deferrals:eric`)!;
    expect(s.answers[1]!.value).toBe(100_000);
    expect(s.candidates.filter((c) => c.selectable)).toHaveLength(1);
    expect(s.candidates.find((c) => c.exclusion === "duplicate")?.reason).toContain("duplicate");
    expect(s.strength).toBe("strong");
  });

  it("lists an unreadable or unfinished W-2 and keeps the suggestion weak", () => {
    const s1 = byKey(
      suggest([w2doc("a", ERIC, { box12: box12(["D", 100_000]) }), w2doc("bad", ERIC, { wagesCents: undefined, employerEIN: "88-8888888" })]),
      `${RC}:w2_deferrals:eric`
    )!;
    expect(s1.candidates.find((c) => c.docId === "bad")?.exclusion).toBe("unreadable");
    expect(s1.strength).toBe("weak");
    const s2 = byKey(
      suggest([w2doc("a", ERIC, { box12: box12(["D", 100_000]) }), w2doc("pending", ERIC, {}, { extractionStatus: "pending" })]),
      `${RC}:w2_deferrals:eric`
    )!;
    expect(s2.candidates.find((c) => c.docId === "pending")?.exclusion).toBe("not_extracted");
    expect(s2.strength).toBe("weak");
  });

  it("gives no suggestion from the absence of documents, for another year, or for a different tax year's W-2", () => {
    expect(suggest([])).toEqual([]);
    expect(suggest([w2doc("old", ERIC, { box12: box12(["D", 100_000]) }, { taxYear: 2024 })])).toEqual([]);
    expect(computePrefillSuggestions({ ...inputFor(raw([w2doc("a", ERIC, { box12: box12(["D", 1_000]) })])), year: 2024 })).toEqual([]);
  });
});

describe("the 2024 return (pyjoint, ut7) and Form 2210 withholding (ut1)", () => {
  it("pyjoint: one verified 2024 return -> yes for mfj, no otherwise (strong)", () => {
    const yes = byKey(suggest([returnDoc("r", {})]), `${RC}:return_filing`)!;
    expect(yes.answers).toEqual([{ nodeId: "pyjoint", value: "yes" }]);
    expect(yes.strength).toBe("strong");
    expect(yes.chip).toContain("married filing jointly");
    const no = byKey(suggest([returnDoc("r", { filingStatus: "single" })]), `${RC}:return_filing`)!;
    expect(no.answers[0]!.value).toBe("no");
    expect(no.strength).toBe("strong");
  });

  it("ut7: total tax 0 -> yes, > 0 -> no", () => {
    expect(byKey(suggest([returnDoc("r", { totalTaxCents: 0 })]), `${F2210}:return_no_tax`)!.answers[0]!.value).toBe("yes");
    expect(byKey(suggest([returnDoc("r", { totalTaxCents: 1 })]), `${F2210}:return_no_tax`)!.answers[0]!.value).toBe("no");
    expect(byKey(suggest([returnDoc("r", { totalTaxCents: undefined })]), `${F2210}:return_no_tax`)).toBeUndefined();
  });

  it("zero 2024 returns -> none; two -> the owner must pick, nothing is defaulted; other forms and years are excluded", () => {
    expect(byKey(suggest([]), `${RC}:return_filing`)).toBeUndefined();
    const two = byKey(suggest([returnDoc("r1", {}), returnDoc("r2", { filingStatus: "single" })]), `${RC}:return_filing`)!;
    expect(two.needsPick).toBe(true);
    expect(two.answers).toEqual([]);
    expect(two.docIds).toEqual([]);
    expect(combineContributions(two, ["r2"])!.answers[0]!.value).toBe("no");
    expect(combineContributions(two, ["r1", "r2"])).toBeNull();
    expect(byKey(suggest([returnDoc("r", { formType: "1065" })]), `${RC}:return_filing`)).toBeUndefined();
    expect(byKey(suggest([returnDoc("r", {}, { taxYear: 2025 })]), `${RC}:return_filing`)).toBeUndefined();
    expect(byKey(suggest([returnDoc("r", {}, { extractionStatus: "pending" })]), `${RC}:return_filing`)).toBeUndefined();
  });

  it("an unverified return is a weak suggestion", () => {
    expect(byKey(suggest([returnDoc("r", {}, { verified: false })]), `${RC}:return_filing`)!.strength).toBe("weak");
  });

  it("ut1: any W-2 with federal withholding -> yes (strong); all zero and current -> weak no; includes unassigned W-2s", () => {
    const yes = byKey(suggest([w2doc("a", ERIC, {}), w2doc("b", null, { federalWithheldCents: 0, employerEIN: "99-9999999" })]), `${F2210}:w2_withheld`)!;
    expect(yes.answers).toEqual([{ nodeId: "ut1", value: "yes" }]);
    expect(yes.strength).toBe("strong");
    expect(yes.candidates.filter((c) => c.selectable)).toHaveLength(2);
    const no = byKey(suggest([w2doc("a", ERIC, { federalWithheldCents: 0 })]), `${F2210}:w2_withheld`)!;
    expect(no.answers[0]!.value).toBe("no");
    expect(no.strength).toBe("weak");
    expect(byKey(suggest([w2doc("a", ERIC, { federalWithheldCents: 0 }, { legacyFormat: true })]), `${F2210}:w2_withheld`)).toBeUndefined();
  });

  it("solar: only the Planning answer 'claimed_already' yields a weak planning-kind suggestion", () => {
    const s = byKey(suggest([], { planning: { ...raw([]).planning, solarCredit: "claimed_already" } }), `${RC}:planning_solar`)!;
    expect(s.kind).toBe("planning");
    expect(s.answers).toEqual([{ nodeId: "g_solar_credit", value: "none" }]);
    expect(s.strength).toBe("weak");
    expect(s.basis).toBe("planning");
    expect(byKey(suggest([], { planning: { ...raw([]).planning, solarCredit: "yes_unclaimed" } }), `${RC}:planning_solar`)).toBeUndefined();
    expect(combineContributions(s, [])!.answers).toEqual(s.answers);
    expect(combineContributions(s, ["x"])).toBeNull();
  });
});

describe("combineContributions", () => {
  const list = suggest([
    w2doc("a", ERIC, { employerName: "Alpine Bio", box12: box12(["D", 1_200_000]), employerEIN: "12-3456789" }),
    w2doc("b", ERIC, { employerName: "NUMU", box12: box12(["AA", 650_000]), employerEIN: "10-1010101" }),
    w2doc("dup", ERIC, { employerName: "Alpine Bio", box12: box12(["D", 1_200_000]), employerEIN: "12-3456789" }),
  ]);
  const s = byKey(list, `${RC}:w2_deferrals:eric`)!;

  it("recomputes the value from a subset of documents", () => {
    expect(combineContributions(s, ["a"])!.answers[1]!.value).toBe(1_200_000);
    expect(combineContributions(s, ["b"])!.answers[1]!.value).toBe(650_000);
    expect(combineContributions(s, ["a", "b"])!.docValue).toBe(1_850_000);
  });

  it("rejects an empty selection, an unknown id and a non-selectable (duplicate) document", () => {
    expect(combineContributions(s, [])).toBeNull();
    expect(combineContributions(s, ["nope"])).toBeNull();
    expect(combineContributions(s, ["dup"])).toBeNull();
  });

  it("builds the stored src from the evaluation (ids and codes only)", () => {
    const ev = combineContributions(s, ["a", "b"])!;
    expect(buildAnswerSource(s, ev, ["a", "b"])).toEqual({
      kind: "document",
      field: "w2.box12.deferrals",
      docIds: ["a", "b"],
      basis: "doc_verified",
      docValue: 1_850_000,
    });
  });
});

describe("classifyStaleness", () => {
  const docs = (over: { aCents?: number; verified?: boolean; extra?: boolean } = {}) => [
    w2doc("a", ERIC, { box12: box12(["D", over.aCents ?? 1_200_000]) }, { verified: over.verified ?? true }),
    ...(over.extra ? [w2doc("c", ERIC, { box12: box12(["D", 1_000]), employerEIN: "12-0000001" })] : []),
  ];
  const first = byKey(suggest(docs()), `${RC}:w2_deferrals:eric`)!;
  const src = buildAnswerSource(first, combineContributions(first, ["a"])!, ["a"]);

  it("current for the same documents and value, even when verification flips", () => {
    expect(classifyStaleness(src, first)).toBe("current");
    const flipped = byKey(suggest(docs({ verified: false })), `${RC}:w2_deferrals:eric`)!;
    expect(classifyStaleness(src, flipped)).toBe("current");
  });

  it("value_changed when a document was corrected", () => {
    expect(classifyStaleness(src, byKey(suggest(docs({ aCents: 1_300_000 })), `${RC}:w2_deferrals:eric`)!)).toBe("value_changed");
  });

  it("new_candidate when a new W-2 for the person appears that the answer does not include", () => {
    const grown = byKey(suggest(docs({ extra: true })), `${RC}:w2_deferrals:eric`)!;
    expect(classifyStaleness(src, grown)).toBe("new_candidate");
  });

  it("doc_gone when an accepted document is no longer usable or no suggestion exists", () => {
    expect(classifyStaleness({ ...src, docIds: ["a", "gone"] }, first)).toBe("doc_gone");
    expect(classifyStaleness(src, null)).toBe("doc_gone");
  });

  it("planning source: current / value_changed", () => {
    const solar = byKey(suggest([], { planning: { ...raw([]).planning, solarCredit: "claimed_already" } }), `${RC}:planning_solar`)!;
    const psrc = buildAnswerSource(solar, combineContributions(solar, [])!, []);
    expect(classifyStaleness(psrc, solar)).toBe("current");
    expect(classifyStaleness({ ...psrc, docValue: "other" }, solar)).toBe("value_changed");
  });
});

describe("computePrefillStates", () => {
  const list = suggest([
    w2doc("a", ERIC, { box12: box12(["D", 1_200_000]), retirementPlan: true }),
    returnDoc("r", {}),
  ]);
  const ans = (nodeId: string, value: string | number, src?: EffectiveAnswers[string]["src"]): [string, EffectiveAnswers[string]] => [
    nodeId,
    { value, source: "questionnaire", at: "2026-10-04T12:00:00.000Z", by: "u1", ...(src ? { src } : {}) },
  ];

  it("a waiting strong suggestion is 'suggested' and bulk-eligible; weak ones are not", () => {
    const states = computePrefillStates(RC, list, {});
    expect(states.def_eric).toMatchObject({ state: "suggested", bulk: true });
    expect(states.plan_eric).toMatchObject({ state: "suggested", bulk: true });
    expect(states.pyjoint).toMatchObject({ state: "suggested", bulk: true });
    const weak = suggest([w2doc("a", ERIC, { box12: box12(["D", 1_000]) }, { verified: false })]);
    expect(computePrefillStates(RC, weak, {}).def_eric).toMatchObject({ state: "suggested", bulk: false });
  });

  it("only the questionnaire asked about is returned", () => {
    expect(Object.keys(computePrefillStates(F2210, list, {}))).toEqual(["ut1", "ut7"]);
  });

  it("the same answer typed by the owner 'agrees'; a different one 'differs'; Not sure 'differs'", () => {
    expect(computePrefillStates(RC, list, Object.fromEntries([ans("plan_eric", "yes")])).plan_eric!.state).toBe("agrees");
    expect(computePrefillStates(RC, list, Object.fromEntries([ans("plan_eric", "no")])).plan_eric).toMatchObject({ state: "differs", bulk: false });
    expect(computePrefillStates(RC, list, Object.fromEntries([ans("plan_eric", "unsure")])).plan_eric!.state).toBe("differs");
    // gate answered the same but the amount typed differently
    expect(
      computePrefillStates(RC, list, Object.fromEntries([ans("def_eric", "some"), ans("defamt_eric", 1_000_000)])).def_eric!.state
    ).toBe("differs");
    expect(computePrefillStates(RC, list, Object.fromEntries([ans("def_eric", "some")])).def_eric!.state).toBe("suggested");
  });

  it("an accepted answer is 'accepted' while the source is unchanged and 'stale' once it changes", () => {
    const s = byKey(list, `${RC}:w2_deferrals:eric`)!;
    const src = buildAnswerSource(s, combineContributions(s, ["a"])!, ["a"]);
    const effective = Object.fromEntries([ans("def_eric", "some", src), ans("defamt_eric", 1_200_000, src)]);
    expect(computePrefillStates(RC, list, effective).def_eric).toMatchObject({ state: "accepted", bulk: false });
    const changed = suggest([w2doc("a", ERIC, { box12: box12(["D", 1_500_000]) })]);
    expect(computePrefillStates(RC, changed, effective).def_eric).toMatchObject({ state: "stale", staleReason: "value_changed", acceptedDocValue: 1_200_000 });
    // owner edited the dependent amount after accepting: differs, not accepted
    const edited = Object.fromEntries([ans("def_eric", "some", src), ans("defamt_eric", 5)]);
    expect(computePrefillStates(RC, list, edited).def_eric!.state).toBe("differs");
  });

  it("an accepted answer whose source produces no suggestion any more is stale (doc_gone)", () => {
    const s = byKey(list, `${RC}:w2_plan:eric`)!;
    const src = buildAnswerSource(s, combineContributions(s, ["a"])!, ["a"]);
    const states = computePrefillStates(RC, [], Object.fromEntries([ans("plan_eric", "yes", src)]));
    expect(states.plan_eric).toMatchObject({ state: "stale", staleReason: "doc_gone", suggestionKey: null });
  });
});

describe("output hygiene and registry", () => {
  it("a suggestion built from a W-2 holding an EIN, SSN-shaped text, address and taxpayer name carries none of them", () => {
    const docs = [
      w2doc(
        "a",
        ERIC,
        {
          employerName: "Alpine Bio 12-3456789",
          employerAddress: "100 Main Street, Hartford CT 06101",
          employeeSsn: "123-45-6789",
          taxpayerName: "Eric Q Kinniburgh",
          box12: box12(["D", 1_000]),
        },
        { documentName: "W-2 2025 123-45-6789.pdf" }
      ),
      w2doc("bad", ERIC, { wagesCents: undefined, employerEIN: "55-5555555" }, { documentName: "Scan 987-65-4321 and 1234567890" }),
      returnDoc("r", { taxpayerName: "Eric Q Kinniburgh", taxpayerSsn: "123-45-6789" }),
    ];
    const json = JSON.stringify(suggest(docs));
    for (const bad of ["12-3456789", "55-5555555", "123-45-6789", "987-65-4321", "1234567890", "Main Street", "06101", "extractionData", "Q Kinniburgh", "employerEIN"]) {
      expect(json, bad).not.toContain(bad);
    }
    expect(json).toContain("Alpine Bio");
    expect(safeLabel("A 12-3456789 B", "x")).toBe("A B");
    expect(safeLabel(null, "fallback")).toBe("fallback");
    expect(safeLabel("x".repeat(100), "f").length).toBeLessThanOrEqual(60);
  });

  it("every node id and answer value a rule can write exists in the questionnaire definition (catches wording-audit renames)", () => {
    const expectedValues: Record<string, string[]> = {
      plan_eric: ["yes", "no"],
      plan_eva: ["yes", "no"],
      def_eric: ["some", "none"],
      def_eva: ["some", "none"],
      pyjoint: ["yes", "no"],
      g_solar_credit: ["none"],
      ut1: ["yes", "no"],
      ut7: ["yes", "no"],
    };
    for (const qid of [RC, F2210]) {
      const def = questionnaireById(qid)!;
      for (const nodeId of prefillNodeIdsFor(qid)) {
        const node = def.nodes.find((n) => n.id === nodeId);
        expect(node, `${qid}.${nodeId}`).toBeDefined();
        expect(node!.binding, `${nodeId} must be unbound`).toBeUndefined();
        for (const v of expectedValues[nodeId] ?? []) expect(validateAnswerValue(node!, v, RC_CONTEXT).ok, `${nodeId}=${v}`).toBe(true);
        expect(ruleForNode(qid, nodeId)).not.toBeNull();
      }
    }
    expect(Object.keys(PREFILL_RULES).sort()).toEqual(["planning_solar", "return_filing", "return_no_tax", "w2_deferrals", "w2_plan", "w2_withheld"]);
    const amt = questionnaireById(RC)!.nodes.find((n) => n.id === "defamt_eric")!;
    expect(amt.kind).toBe("dollars");
  });

  it("strong is never produced for an unverified or legacy-format document, nor for a negative answer", () => {
    for (const verified of [true, false]) {
      for (const legacy of [true, false]) {
        for (const plan of [true, false, undefined]) {
          for (const cents of [0, 100_000]) {
            const list = suggest([w2doc("a", ERIC, { retirementPlan: plan, federalWithheldCents: cents, box12: cents ? box12(["D", cents]) : [] }, { verified, legacyFormat: legacy })]);
            for (const s of list) {
              if (s.strength !== "strong") continue;
              expect(verified && !legacy, s.key).toBe(true);
              const v = s.answers[0]!.value;
              expect(["no", "none"], s.key).not.toContain(v);
            }
          }
        }
      }
    }
  });

  it("formatDocValue renders cents as dollars and filing status as words", () => {
    expect(formatDocValue("w2_deferrals", 1_850_000)).toBe("$18,500.00");
    expect(formatDocValue("return_filing", "mfj")).toBe("married filing jointly");
    expect(formatDocValue("w2_plan", "yes")).toBe("yes");
  });

  it("is free of floats, any and clock reads", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../tax-prefill.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/:\s*any\b|as any\b/);
    expect(src).not.toMatch(/parseFloat|toFixed|Date\.now|new Date\(/);
    expect(src).not.toMatch(/from\s+["']@\/lib\/db["']|from\s+["']@\/lib\/auth["']|"use server"/);
  });
});
