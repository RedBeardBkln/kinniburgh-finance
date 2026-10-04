import { describe, it, expect } from "vitest";
import {
  RETYPABLE_FROM,
  RETYPE_TARGETS,
  RETYPE_TARGET_OPTIONS,
  VERIFIED_RETYPE_ERROR,
  isPlaceholderName,
  isRetypableFrom,
  retypeBlockReason,
  retypeTargetLabel,
} from "@/lib/document-retype";
import { isExtractableDocType } from "@/lib/document-extraction-state";
import { mimeTypeForFileKey } from "@/lib/document-upload";

describe("retype targets", () => {
  it("are exactly the owner-chosen tax-ish types, with donation_receipt and retirement_contribution included", () => {
    expect([...RETYPE_TARGETS]).toEqual([
      "w2",
      "1099",
      "k1",
      "mortgage_interest",
      "property_tax",
      "donation_receipt",
      "retirement_contribution",
      "tax_return",
      "extension",
      "other",
    ]);
    expect([...RETYPABLE_FROM]).toEqual([...RETYPE_TARGETS]);
  });

  it("derive from one list with a user-facing label for each", () => {
    expect(RETYPE_TARGET_OPTIONS.map((o) => o.value)).toEqual([...RETYPE_TARGETS]);
    expect(retypeTargetLabel("donation_receipt")).toBe("Donation receipt / acknowledgment");
    for (const o of RETYPE_TARGET_OPTIONS) expect(o.label.length).toBeGreaterThan(2);
  });

  it("statements, policies and bills are not retypable from here", () => {
    for (const t of ["bank_statement", "statement", "credit_card_statement", "mortgage_statement", "insurance_policy", "policy", "utility_bill"]) {
      expect(isRetypableFrom(t), t).toBe(false);
      expect(RETYPE_TARGETS).not.toContain(t);
    }
    expect(isRetypableFrom("other")).toBe(true);
  });
});

describe("retypeBlockReason", () => {
  it("allows other -> donation_receipt", () => {
    expect(retypeBlockReason({ currentDocType: "other", nextDocType: "donation_receipt", verified: false })).toBeNull();
  });

  it("a verified document must be un-verified first, with the exact existing text", () => {
    expect(VERIFIED_RETYPE_ERROR).toBe("This document is verified. Un-verify it before changing its type.");
    expect(retypeBlockReason({ currentDocType: "w2", nextDocType: "other", verified: true })).toBe(VERIFIED_RETYPE_ERROR);
  });

  it("a verified document asked for the same type is not an error", () => {
    expect(retypeBlockReason({ currentDocType: "w2", nextDocType: "w2", verified: true })).toBeNull();
  });

  it("refuses a type that is not a target and a document that is not retypable", () => {
    expect(retypeBlockReason({ currentDocType: "other", nextDocType: "bank_statement", verified: false })).toMatch(/cannot be chosen/);
    expect(retypeBlockReason({ currentDocType: "bank_statement", nextDocType: "other", verified: false })).toMatch(/cannot have its type changed/);
  });

  it("the donation_receipt target is extractable (the control then offers the AI read)", () => {
    expect(isExtractableDocType("donation_receipt")).toBe(true);
    expect(isExtractableDocType("other")).toBe(false);
    expect(isExtractableDocType("extension")).toBe(false);
  });
});

describe("isPlaceholderName", () => {
  it("null, blank, the type label and the generated 'Label (year)' are placeholders", () => {
    expect(isPlaceholderName(null, "other", null)).toBe(true);
    expect(isPlaceholderName("  ", "other", null)).toBe(true);
    expect(isPlaceholderName("Document", "other", null)).toBe(true);
    expect(isPlaceholderName("Document (2025)", "other", 2025)).toBe(true);
    expect(isPlaceholderName("W-2 (2025)", "w2", 2025)).toBe(true);
    expect(isPlaceholderName("Donation Receipt", "donation_receipt", null)).toBe(true);
  });

  it("a name the owner typed, or one generated from extracted data, is not", () => {
    expect(isPlaceholderName("Church letter", "other", null)).toBe(false);
    expect(isPlaceholderName("W-2 — Acme (2025)", "w2", 2025)).toBe(false);
    expect(isPlaceholderName("Document (2024)", "other", 2025)).toBe(false);
  });
});

describe("mimeTypeForFileKey (extraction media type from the stored key)", () => {
  it.each([
    ["documents/e/d.pdf", "application/pdf"],
    ["taxes/e/d.pdf", "application/pdf"],
    ["documents/e/d.jpeg", "image/jpeg"],
    ["documents/e/d.jpg", "image/jpeg"],
    ["documents/e/d.png", "image/png"],
    ["documents/e/d.webp", "image/webp"],
    ["documents/e/D.PNG", "image/png"],
  ])("%s -> %s", (key, mime) => {
    expect(mimeTypeForFileKey(key)).toBe(mime);
  });

  it("keeps the previous image/jpeg default for anything unrecognised", () => {
    expect(mimeTypeForFileKey("documents/e/d")).toBe("image/jpeg");
    expect(mimeTypeForFileKey("documents/e/d.tiff")).toBe("image/jpeg");
    expect(mimeTypeForFileKey("")).toBe("image/jpeg");
  });
});
