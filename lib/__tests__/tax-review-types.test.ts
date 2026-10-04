import { describe, expect, it } from "vitest";
import {
  atLeast,
  countBySeverity,
  dedupeFindings,
  evidenceHashOf,
  FindingError,
  findingKey,
  findingSchema,
  isGatingSeverity,
  makeFinding,
  sortFindings,
  type FindingDraft,
} from "@/lib/tax-review/types";

const base: FindingDraft = {
  layer: "L1",
  check: "L1.F1.f1040.9",
  severity: "blocker",
  area: "tax",
  formKey: "f1040",
  lineKey: "f1040.9",
  message: "Form 1040 line 9 does not equal the sum of its parts.",
  evidence: [
    { ref: "f1040.9", amount: 181500, status: "computed" },
    { ref: "f1040.1z", amount: 130000, status: "computed" },
  ],
  recommendedAction: "Fix the return.",
  acceptable: false,
};

describe("makeFinding", () => {
  it("builds a valid finding with a stable key and an evidence hash", () => {
    const f = makeFinding(base);
    expect(findingSchema.safeParse(f).success).toBe(true);
    expect(f.key).toMatch(/^[0-9a-f]{16}$/);
    expect(f.evidenceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(f.origin).toBe("deterministic");
    expect(f.citation.sourceStatus).toBe("not_applicable");
  });
  it("the key does not depend on the numbers or the wording, only on layer/check/form/line/tag", () => {
    const a = makeFinding(base);
    const b = makeFinding({ ...base, message: "Other words.", evidence: [{ ref: "f1040.9", amount: 1, status: "computed" }] });
    expect(a.key).toBe(b.key);
    expect(a.evidenceHash).not.toBe(b.evidenceHash);
    expect(makeFinding({ ...base, ruleTag: "doc-1" }).key).not.toBe(a.key);
    expect(findingKey({ layer: "L1", check: base.check, formKey: "f1040", lineKey: "f1040.9" })).toBe(a.key);
  });
  it("the evidence hash ignores order and notes", () => {
    const ev = base.evidence ?? [];
    expect(evidenceHashOf(ev)).toBe(evidenceHashOf([...ev].reverse()));
    expect(evidenceHashOf(ev)).toBe(evidenceHashOf(ev.map((e) => ({ ...e, note: "x" }))));
  });
  it("rejects an unknown line key and an unknown evidence reference", () => {
    expect(() => makeFinding({ ...base, lineKey: "f1040.999" as never })).toThrow(FindingError);
    expect(() => makeFinding({ ...base, evidence: [{ ref: "f1040.999", amount: 1, status: "computed" }] })).toThrow(FindingError);
    expect(() => makeFinding({ ...base, evidence: [{ ref: "nonsense:1", amount: 1, status: "x" }] })).toThrow(FindingError);
    expect(() => makeFinding({ ...base, evidence: [{ ref: "doc:abc", amount: 1.5, status: "x" }] })).toThrow(FindingError);
  });
  it("accepts namespaced evidence refs", () => {
    const f = makeFinding({ ...base, evidence: [{ ref: "doc:abc", amount: 5, status: "used" }, { ref: "pdf:f1040:f1_47", amount: 5, status: "printed" }] });
    expect(f.evidence).toHaveLength(2);
  });
  it("rejects SSN-like, EIN-like and long digit text anywhere in the finding", () => {
    expect(() => makeFinding({ ...base, message: "id 123-45-6789" })).toThrow(FindingError);
    expect(() => makeFinding({ ...base, recommendedAction: "employer 12-3456789" })).toThrow(FindingError);
    expect(() => makeFinding({ ...base, evidence: [{ ref: "doc:1", amount: 1, status: "x", note: "acct 1234567890" }] })).toThrow(FindingError);
    expect(() => makeFinding({ ...base, citation: { sources: [{ kind: "form_text", id: "x", quote: "123456789" }], sourceStatus: "verified" } })).toThrow(FindingError);
  });
  it("the error never echoes the offending text", () => {
    try {
      makeFinding({ ...base, message: "id 123-45-6789" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("123-45");
    }
  });
  it("an LLM finding can never be a non-acceptable invariant", () => {
    expect(() => makeFinding({ ...base, origin: "llm", acceptable: false })).toThrow(FindingError);
    expect(makeFinding({ ...base, origin: "llm", acceptable: true, pass: "income", layer: "L3" }).pass).toBe("income");
  });
  it("rejects over-long text", () => {
    expect(() => makeFinding({ ...base, message: "x".repeat(2000) })).toThrow(FindingError);
  });
});

describe("severity helpers", () => {
  it("orders blocker > high > medium > low > info", () => {
    expect(atLeast("blocker", "medium")).toBe(true);
    expect(atLeast("medium", "medium")).toBe(true);
    expect(atLeast("low", "medium")).toBe(false);
    expect(isGatingSeverity("high")).toBe(true);
    expect(isGatingSeverity("medium")).toBe(false);
  });
  it("sorts most serious first and counts every severity", () => {
    const a = makeFinding({ ...base, check: "a", severity: "low", acceptable: true });
    const b = makeFinding({ ...base, check: "b", severity: "blocker" });
    const c = makeFinding({ ...base, check: "c", severity: "medium", acceptable: true });
    expect(sortFindings([a, b, c]).map((f) => f.check)).toEqual(["b", "c", "a"]);
    expect(countBySeverity([a, b, c])).toEqual({ blocker: 1, high: 0, medium: 1, low: 1, info: 0 });
  });
  it("collapses duplicate keys to the more serious finding", () => {
    const hi = makeFinding({ ...base, severity: "blocker" });
    const lo = makeFinding({ ...base, severity: "low", acceptable: true });
    expect(dedupeFindings([lo, hi])).toEqual([hi]);
  });
});
