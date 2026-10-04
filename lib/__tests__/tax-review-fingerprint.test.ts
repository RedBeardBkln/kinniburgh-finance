import { describe, expect, it } from "vitest";
import {
  changedFingerprintParts,
  computeReturnFingerprint,
  describeFingerprintParts,
  FINGERPRINT_PART_NAMES,
  FINGERPRINT_VERSION,
  type FingerprintInput,
} from "@/lib/tax-review/fingerprint";

function input(): FingerprintInput {
  return {
    engineVersion: "ty2025-1b.4",
    viewFingerprint: "v".repeat(64),
    answers: { filingStatus: "mfj", digitalAssets: "no" },
    header: { householdNames: "A and B", taxpayerName: "A", spouseName: "B", ekcName: "A Consulting" },
    facts: { income: { w2s: [{ docId: "d1", wagesCents: 9_000_000 }] } },
    documents: [
      { id: "d1", docType: "w2", taxYear: 2025, extractionStatus: "complete", verified: true, legacyFormat: false, subjectType: "person", subjectUserId: "u1", extractionData: { data: { wagesCents: 9_000_000 } } },
      { id: "d2", docType: "1099", taxYear: 2025, extractionStatus: "complete", verified: false, legacyFormat: false, subjectType: "joint", subjectUserId: null, extractionData: { data: { amountCents: 50_000 } } },
    ],
    questionnaires: [{ questionnaireId: "return_completeness", definitionVersion: 3, answers: { q1: "none" } }],
    overrides: [{ id: "o1", version: 1, targetKind: "line", targetKey: "sch1.3", valueKind: "money_cents", valueCents: 100, valueText: null, authority: "owner", archivedAt: null }],
    decisions: [{ id: "X1", chosen: "simplified", status: "default_undecided" }],
  };
}

const fp = (i: FingerprintInput) => computeReturnFingerprint(i);

describe("return fingerprint v2", () => {
  it("is a 64-hex digest, deterministic, versioned", () => {
    const a = fp(input());
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fp(input()).fingerprint).toBe(a.fingerprint);
    expect(FINGERPRINT_VERSION).toBe(2);
    expect(Object.keys(a.parts).sort()).toEqual([...FINGERPRINT_PART_NAMES].sort());
  });
  it("does not depend on the order of documents, questionnaires or overrides", () => {
    const i = input();
    const j = input();
    j.documents = [...j.documents].reverse();
    expect(fp(j).fingerprint).toBe(fp(i).fingerprint);
  });
  it("keeps only digests: no value, name or document text appears in the parts", () => {
    const json = JSON.stringify(fp(input()));
    for (const leak of ["9000000", "A Consulting", "mfj", "return_completeness"]) expect(json).not.toContain(leak);
  });

  // Each mutation must change the fingerprint (S13): a review run, an approval and a clean copy are bound to it.
  const mutations: Array<[string, (i: FingerprintInput) => void, string]> = [
    ["engine version", (i) => void (i.engineVersion = "ty2025-1b.5"), "engine"],
    ["view fingerprint (a computed line)", (i) => void (i.viewFingerprint = "w".repeat(64)), "view"],
    ["an answer (filing status box)", (i) => void (i.answers = { filingStatus: "single", digitalAssets: "no" }), "answers"],
    ["an answer added", (i) => void (i.answers = { ...(i.answers as object), foreignAccounts: "no" }), "answers"],
    ["a printed name", (i) => void (i.header = { householdNames: "A and C", taxpayerName: "A", spouseName: "C", ekcName: "A Consulting" }), "header"],
    ["a fact", (i) => void (i.facts = { income: { w2s: [{ docId: "d1", wagesCents: 9_000_100 }] } }), "facts"],
    ["document verification", (i) => void (i.documents[1]!.verified = true), "documents"],
    ["an owner correction in a document's effective extraction", (i) => void (i.documents[0]!.extractionData = { data: { wagesCents: 9_000_001 } }), "documents"],
    ["a document archived (removed)", (i) => void (i.documents = i.documents.slice(0, 1)), "documents"],
    ["a document's person", (i) => void (i.documents[0]!.subjectUserId = "u2"), "documents"],
    ["a document re-extracted (status)", (i) => void (i.documents[0]!.extractionStatus = "processing"), "documents"],
    ["a questionnaire answer", (i) => void (i.questionnaires = [{ questionnaireId: "return_completeness", definitionVersion: 3, answers: { q1: "some" } }]), "questionnaires"],
    ["a questionnaire definition version", (i) => void (i.questionnaires = [{ questionnaireId: "return_completeness", definitionVersion: 4, answers: { q1: "none" } }]), "questionnaires"],
    ["an override value", (i) => void (i.overrides[0]!.valueCents = 200), "overrides"],
    ["an override cleared (archived)", (i) => void (i.overrides[0]!.archivedAt = new Date("2026-10-05T00:00:00Z")), "overrides"],
    ["an override added", (i) => void (i.overrides = [...i.overrides, { id: "o2", version: 1, targetKind: "decision", targetKey: "homeOfficeMethod", valueKind: "choice", valueCents: null, valueText: "actual", authority: "owner", archivedAt: null }]), "overrides"],
    ["a decision", (i) => void (i.decisions = [{ id: "X1", chosen: "actual", status: "decided" }]), "decisions"],
  ];
  for (const [name, mutate, part] of mutations) {
    it(`changes when ${name} changes (and names the part: ${part})`, () => {
      const before = fp(input());
      const i = input();
      mutate(i);
      const after = fp(i);
      expect(after.fingerprint).not.toBe(before.fingerprint);
      expect(changedFingerprintParts(before.parts, after.parts)).toContain(part);
    });
  }

  it("describes what changed in plain words", () => {
    expect(describeFingerprintParts(["documents", "overrides"])).toMatch(/document.*override/);
    expect(changedFingerprintParts(fp(input()).parts, fp(input()).parts)).toEqual([]);
  });
});
