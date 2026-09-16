import { describe, it, expect } from "vitest";
import { normalizeInstitutionName } from "@/lib/institutions";

describe("normalizeInstitutionName", () => {
  it("trims leading/trailing whitespace", () => {
    expect(normalizeInstitutionName("  CorePlus Credit Union  ")).toBe("coreplus credit union");
  });

  it("collapses internal double-spaces to one", () => {
    expect(normalizeInstitutionName("CorePlus   Credit  Union")).toBe("coreplus credit union");
  });

  it("lowercases", () => {
    expect(normalizeInstitutionName("CorePlus Credit Union")).toBe("coreplus credit union");
  });

  it("handles empty string input", () => {
    expect(normalizeInstitutionName("")).toBe("");
  });

  it("handles whitespace-only input", () => {
    expect(normalizeInstitutionName("   ")).toBe("");
  });

  it("is idempotent for an already-normalized name", () => {
    const normalized = "coreplus credit union";
    expect(normalizeInstitutionName(normalized)).toBe(normalized);
  });
});
