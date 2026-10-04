import { describe, expect, it } from "vitest";
import type { AnswerSource, EffectiveAnswers } from "@/lib/tax-questionnaire";
import { parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { emptyReturnAnswers } from "@/lib/tax2025/facts";
import { resolveFacts } from "@/lib/tax2025/resolve-facts";
import { sourced } from "@/lib/tax2025/types";
import { ERIC, EVA, DOC_A, DOC_B, DOC_RET, rawInputs, returnDoc, w2doc } from "@/lib/__tests__/tax-prefill-fixtures";

// An answer accepted from a document keeps basis answer_owner (every precedence rule and ~3,100 engine
// tests are unchanged) but its leaf also carries the document refs and a note naming the source; an answer
// with no `src` produces exactly what it did before. The new `pyjoint` conflict surfaces owner vs 2024 return.

const PEOPLE = [
  { userId: "u-eric", name: "Eric Kinniburgh" },
  { userId: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
];
const AT = "2026-10-04T12:00:00.000Z";
const SRC: AnswerSource = { kind: "document", field: "w2.box12.deferrals", docIds: [DOC_A, DOC_B], basis: "doc_verified", docValue: 1_850_000 };

function eff(src?: AnswerSource): EffectiveAnswers {
  const a = (value: string | number) => ({ value, source: "questionnaire" as const, at: AT, by: "u-eric", ...(src ? { src } : {}) });
  return { def_eric: a("some"), defamt_eric: a(1_850_000) };
}

describe("parseCompletenessAnswers with a src", () => {
  it("adds document refs and a note to the leaf, with basis still answer_owner", () => {
    const leaf = parseCompletenessAnswers(eff(SRC), PEOPLE).returnAnswers.people[0]!.deferralsCents;
    expect(leaf.value).toBe(1_850_000);
    expect(leaf.basis).toBe("answer_owner");
    expect(leaf.refs.filter((r) => r.kind === "document").map((r) => r.id)).toEqual([DOC_A, DOC_B]);
    expect(leaf.refs.filter((r) => r.kind === "document").every((r) => r.label === "W-2")).toBe(true);
    expect(leaf.refs.some((r) => r.kind === "questionnaire")).toBe(true);
    expect(leaf.note).toContain("answered 2026-10-04");
    expect(leaf.note).toContain("filled from a W-2 (box 12 deferral codes), verified when accepted");
  });

  it("an answer with no src is byte-identical to the pre-change output (no document ref, plain note)", () => {
    const leaf = parseCompletenessAnswers(eff(), PEOPLE).returnAnswers.people[0]!.deferralsCents;
    expect(leaf.refs.map((r) => r.kind)).toEqual(["questionnaire"]);
    expect(leaf.note).toBe("answered 2026-10-04");
    expect(leaf.basis).toBe("answer_owner");
  });

  it("only the accepted-from-document leaves change: everything else is identical with and without src", () => {
    const withSrc = parseCompletenessAnswers(eff(SRC), PEOPLE);
    const without = parseCompletenessAnswers(eff(), PEOPLE);
    const strip = (p: ReturnType<typeof parseCompletenessAnswers>) => JSON.stringify({ ...p, returnAnswers: { ...p.returnAnswers, people: p.returnAnswers.people.map((x) => ({ ...x, deferralsCents: null })) } });
    expect(strip(withSrc)).toBe(strip(without));
    expect(withSrc.returnAnswers.people[0]!.deferralsCents.value).toBe(without.returnAnswers.people[0]!.deferralsCents.value);
  });

  it("a Planning-sourced answer cites the Planning answer, not a document", () => {
    const planningSrc: AnswerSource = { kind: "planning", field: "planning.solar_credit", docIds: [], basis: "planning", docValue: "claimed_already" };
    const e: EffectiveAnswers = { g_solar_credit: { value: "none", source: "questionnaire", at: AT, by: "u-eric", src: planningSrc } };
    const parsed = parseCompletenessAnswers(e, PEOPLE);
    expect(parsed.statedNone.solar_credit).toBe(true);
  });

  it("a gate answered 'none' from a document keeps the implied amount's provenance (still owner basis)", () => {
    const src: AnswerSource = { ...SRC, docValue: 0 };
    const e: EffectiveAnswers = { def_eric: { value: "none", source: "questionnaire", at: AT, by: "u-eric", src } };
    const leaf = parseCompletenessAnswers(e, PEOPLE).returnAnswers.people[0]!.deferralsCents;
    expect(leaf.value).toBe(0);
    expect(leaf.basis).toBe("answer_owner");
    expect(leaf.refs.filter((r) => r.kind === "document")).toHaveLength(2);
  });
});

describe("the pyjoint conflict (owner answer vs the 2024 return document)", () => {
  function conflictFor(ownerJoint: boolean | null, returnData: Record<string, unknown> | null, extraDocs = 0) {
    const docs = [
      w2doc(DOC_A, ERIC, {}),
      ...(returnData ? [returnDoc(DOC_RET, returnData)] : []),
      ...Array.from({ length: extraDocs }, (_, i) => returnDoc(`bbbbbbbb-0000-4000-8000-0000000001${i}0`, returnData ?? {})),
    ];
    const ra = emptyReturnAnswers([
      { slot: "a", userId: ERIC, name: "Eric" },
      { slot: "b", userId: EVA, name: "Eva" },
    ]);
    if (ownerJoint !== null) ra.priorYear.filedJoint = sourced(ownerJoint, "answer_owner", [{ kind: "questionnaire", id: "return-completeness.pyjoint", label: "2024 return was joint" }]);
    return resolveFacts(rawInputs(docs, { answers: { returnAnswers: ra } })).conflicts.find((c) => c.factKey === "returnAnswers.priorYear.joint");
  }

  it("is raised when the owner says joint but the 2024 return says single (and the reverse)", () => {
    const c = conflictFor(true, { filingStatus: "single" })!;
    expect(c).toBeDefined();
    expect(c.chosen).toBe("Owner answer: the 2024 return was joint");
    expect(c.candidates.map((x) => x.basis)).toEqual(["answer_owner", "doc_verified"]);
    expect(c.candidates.map((x) => x.value)).toEqual(["yes", "single"]);
    expect(c.candidates[1]!.refs.some((r) => r.kind === "document" && r.id === DOC_RET)).toBe(true);
    expect(conflictFor(false, { filingStatus: "mfj" })).toBeDefined();
  });

  it("is absent when they agree, when the owner has not answered, or when no single 2024 return was read", () => {
    expect(conflictFor(true, { filingStatus: "mfj" })).toBeUndefined();
    expect(conflictFor(false, { filingStatus: "hoh" })).toBeUndefined();
    expect(conflictFor(null, { filingStatus: "single" })).toBeUndefined();
    expect(conflictFor(true, null)).toBeUndefined();
    expect(conflictFor(true, { filingStatus: "single" }, 1)).toBeUndefined(); // two returns: nothing to compare against
  });

  it("an unverified return is labelled doc_unverified", () => {
    const ra = emptyReturnAnswers([{ slot: "a", userId: ERIC, name: "Eric" }]);
    ra.priorYear.filedJoint = sourced(true, "answer_owner", []);
    const r = resolveFacts(rawInputs([returnDoc(DOC_RET, { filingStatus: "single" }, { verified: false })], { answers: { returnAnswers: ra } }));
    expect(r.conflicts.find((c) => c.factKey === "returnAnswers.priorYear.joint")!.candidates[1]!.basis).toBe("doc_unverified");
  });
});
