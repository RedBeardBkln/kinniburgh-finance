import { describe, expect, it } from "vitest";
import { EXTRACTABLE_DOC_TYPES, NEVER_EXTRACT_DOC_TYPES, isExtractableDocType } from "@/lib/document-extraction-state";
import { isTaxDocType } from "@/lib/document-attribution";
import { schemaTypeForDocType } from "@/lib/tax-extraction-schema";
import { RETYPE_TARGETS } from "@/lib/document-retype";

// A W-9 carries a taxpayer ID. It lives in the document vault as docType "w9" and must never reach the AI extractor, the tax engine's
// document set or the retype picker.
describe("w9 document type", () => {
  it("is never extractable, even if someone adds it to the list", () => {
    expect(NEVER_EXTRACT_DOC_TYPES).toContain("w9");
    expect(isExtractableDocType("w9")).toBe(false);
    expect((EXTRACTABLE_DOC_TYPES as readonly string[]).includes("w9")).toBe(false);
  });
  it("is not a tax document type and has no extraction schema", () => {
    expect(isTaxDocType("w9")).toBe(false);
    expect(schemaTypeForDocType("w9")).toBeNull();
  });
  it("cannot be chosen as a retype target (so a w9 cannot be turned into an extractable type either)", () => {
    expect(RETYPE_TARGETS).not.toContain("w9");
  });
});
