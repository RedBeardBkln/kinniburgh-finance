import { describe, it, expect } from "vitest";
import {
  ISSUER_MAX_LENGTH,
  TAX_DOC_TYPES,
  attributionLabel,
  buildAttributionPayload,
  initialEditState,
  isTaxDocType,
  needsUnknownPersonOption,
  selectValueToSubject,
  shortPersonName,
  subjectToSelectValue,
  suggestIssuerFromExtraction,
  validateAttribution,
} from "@/lib/document-attribution";

const UID = "6f1c1f0e-8a3b-4c52-9d7e-2b1a0c9d8e7f";
const ERIC = { id: UID, name: "Eric Kinniburgh" };
const EVA = { id: "11111111-2222-4333-8444-555555555555", name: "Eva-Laura Ramirez-Wisiackas" };

describe("validateAttribution", () => {
  it("accepts person + uuid", () => {
    const r = validateAttribution({ subjectType: "person", subjectUserId: UID, issuerName: null });
    expect(r).toEqual({ ok: true, value: { subjectType: "person", subjectUserId: UID, issuerName: null } });
  });

  it("rejects person without a user id", () => {
    expect(validateAttribution({ subjectType: "person", subjectUserId: null, issuerName: null }).ok).toBe(false);
    expect(validateAttribution({ subjectType: "person", subjectUserId: undefined, issuerName: null }).ok).toBe(false);
  });

  it("rejects person with a non-uuid user id or non-string id", () => {
    expect(validateAttribution({ subjectType: "person", subjectUserId: "eric", issuerName: null }).ok).toBe(false);
    expect(validateAttribution({ subjectType: "person", subjectUserId: 42, issuerName: null }).ok).toBe(false);
  });

  it("accepts joint with no user id and rejects joint with one", () => {
    expect(validateAttribution({ subjectType: "joint", subjectUserId: null, issuerName: null })).toEqual({
      ok: true,
      value: { subjectType: "joint", subjectUserId: null, issuerName: null },
    });
    expect(validateAttribution({ subjectType: "joint", subjectUserId: UID, issuerName: null }).ok).toBe(false);
  });

  it("accepts null/undefined subjectType (Unassigned) only with no user id", () => {
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: null })).toEqual({
      ok: true,
      value: { subjectType: null, subjectUserId: null, issuerName: null },
    });
    expect(validateAttribution({ subjectType: undefined, subjectUserId: undefined, issuerName: undefined }).ok).toBe(true);
    expect(validateAttribution({ subjectType: null, subjectUserId: UID, issuerName: null }).ok).toBe(false);
  });

  it("rejects an unknown or non-string subjectType", () => {
    expect(validateAttribution({ subjectType: "eric", subjectUserId: null, issuerName: null }).ok).toBe(false);
    expect(validateAttribution({ subjectType: "", subjectUserId: null, issuerName: null }).ok).toBe(false);
    expect(validateAttribution({ subjectType: 1, subjectUserId: null, issuerName: null }).ok).toBe(false);
  });

  it("trims the issuer and maps blank to null", () => {
    const a = validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "  Alpine Bio  " });
    expect(a.ok && a.value.issuerName).toBe("Alpine Bio");
    const b = validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "   " });
    expect(b.ok && b.value.issuerName).toBeNull();
    const c = validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "" });
    expect(c.ok && c.value.issuerName).toBeNull();
  });

  it("enforces the 200-char issuer limit on the trimmed value", () => {
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "a".repeat(ISSUER_MAX_LENGTH) }).ok).toBe(true);
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "a".repeat(ISSUER_MAX_LENGTH + 1) }).ok).toBe(false);
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: `  ${"a".repeat(ISSUER_MAX_LENGTH)}  ` }).ok).toBe(true);
  });

  it("rejects control characters and non-string issuers", () => {
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "Bad\u0000Name" }).ok).toBe(false);
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: "Line\nBreak" }).ok).toBe(false);
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: 5 }).ok).toBe(false);
    expect(validateAttribution({ subjectType: null, subjectUserId: null, issuerName: {} }).ok).toBe(false);
  });

  it("keeps quotes/HTML as plain text (rendering escapes them)", () => {
    const r = validateAttribution({ subjectType: null, subjectUserId: null, issuerName: `<b>"O'Reilly"</b>` });
    expect(r.ok && r.value.issuerName).toBe(`<b>"O'Reilly"</b>`);
  });
});

describe("suggestIssuerFromExtraction", () => {
  const shaped = (data: Record<string, unknown>) => ({ docType: "other", summary: "ok", data });

  it("w2 -> employerName", () => {
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: "RIPPLING PEO 1, INC." }))).toBe("RIPPLING PEO 1, INC.");
  });
  it("1099 -> payerName", () => {
    expect(suggestIssuerFromExtraction("1099", shaped({ payerName: "Robinhood" }))).toBe("Robinhood");
  });
  it("k1 -> entityName", () => {
    expect(suggestIssuerFromExtraction("k1", shaped({ entityName: "Acme Partners LP" }))).toBe("Acme Partners LP");
  });
  it("mortgage_interest and mortgage_statement -> servicerName", () => {
    expect(suggestIssuerFromExtraction("mortgage_interest", shaped({ servicerName: "Pennymac" }))).toBe("Pennymac");
    expect(suggestIssuerFromExtraction("mortgage_statement", shaped({ servicerName: "Pennymac" }))).toBe("Pennymac");
  });
  it("returns null for every unmapped type even when a name-like key exists", () => {
    for (const t of ["tax_return", "property_tax", "bank_statement", "other", "extension", "utility_bill", "unknown"]) {
      expect(
        suggestIssuerFromExtraction(t, shaped({ taxpayerName: "X", employerName: "X", payerName: "X", servicerName: "X", entityName: "X" }))
      ).toBeNull();
    }
  });
  it("trims and caps at 200 chars", () => {
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: "  Seacoast  " }))).toBe("Seacoast");
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: "a".repeat(300) }))?.length).toBe(ISSUER_MAX_LENGTH);
  });
  it("returns null for blank, whitespace, numeric, or missing values", () => {
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: "" }))).toBeNull();
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: "   " }))).toBeNull();
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: 123 }))).toBeNull();
    expect(suggestIssuerFromExtraction("w2", shaped({ employerName: null }))).toBeNull();
    expect(suggestIssuerFromExtraction("w2", shaped({}))).toBeNull();
  });
  it("returns null for missing/odd extractionData", () => {
    expect(suggestIssuerFromExtraction("w2", null)).toBeNull();
    expect(suggestIssuerFromExtraction("w2", undefined)).toBeNull();
    expect(suggestIssuerFromExtraction("w2", "string")).toBeNull();
    expect(suggestIssuerFromExtraction("w2", [])).toBeNull();
    expect(suggestIssuerFromExtraction("w2", { docType: "w2", summary: "x" })).toBeNull();
    expect(suggestIssuerFromExtraction("w2", { docType: "w2", summary: "x", data: [] })).toBeNull();
  });
  it("returns null for the parse-failure stub", () => {
    expect(
      suggestIssuerFromExtraction("w2", {
        docType: "other",
        summary: "Could not parse extraction response.",
        data: { raw: "garbled", employerName: "ignored" },
      })
    ).toBeNull();
  });
});

describe("labels", () => {
  it("shortPersonName takes the first token", () => {
    expect(shortPersonName("Eric Kinniburgh")).toBe("Eric");
    expect(shortPersonName("Eva-Laura Ramirez-Wisiackas")).toBe("Eva-Laura");
    expect(shortPersonName("  Cher ")).toBe("Cher");
    expect(shortPersonName("")).toBe("Unknown");
  });

  it("labels a person, joint (2 users), and unassigned", () => {
    const people = [ERIC, EVA];
    expect(attributionLabel({ subjectType: "person", subjectUser: ERIC }, people)).toEqual({ label: "Eric", assigned: true });
    expect(attributionLabel({ subjectType: "person", subjectUser: EVA }, people)).toEqual({ label: "Eva-Laura", assigned: true });
    expect(attributionLabel({ subjectType: "joint", subjectUser: null }, people)).toEqual({
      label: "Joint (Eric & Eva-Laura)",
      assigned: true,
    });
    expect(attributionLabel({ subjectType: null, subjectUser: null }, people)).toEqual({ label: "Unassigned", assigned: false });
  });

  it("joint falls back to plain 'Joint' with one or zero users", () => {
    expect(attributionLabel({ subjectType: "joint", subjectUser: null }, [ERIC]).label).toBe("Joint");
    expect(attributionLabel({ subjectType: "joint", subjectUser: null }, []).label).toBe("Joint");
  });

  it("a person whose user vanished renders as Unassigned", () => {
    expect(attributionLabel({ subjectType: "person", subjectUser: null }, [ERIC, EVA])).toEqual({
      label: "Unassigned",
      assigned: false,
    });
  });
});

describe("select-value mapping", () => {
  it("round-trips unassigned / joint / person", () => {
    expect(subjectToSelectValue(null, null)).toBe("");
    expect(subjectToSelectValue("joint", null)).toBe("joint");
    expect(subjectToSelectValue("person", UID)).toBe(UID);
    expect(subjectToSelectValue("person", null)).toBe("");
    expect(selectValueToSubject("")).toEqual({ subjectType: null, subjectUserId: null });
    expect(selectValueToSubject("joint")).toEqual({ subjectType: "joint", subjectUserId: null });
    expect(selectValueToSubject(UID)).toEqual({ subjectType: "person", subjectUserId: UID });
  });
});

describe("edit-state derivation (D1 regression: stale issuer after Use)", () => {
  it("derives the initial form from the CURRENT saved props", () => {
    // Before "Use": nothing saved.
    expect(initialEditState({ subjectType: null, subjectUserId: null, issuerName: null })).toEqual({
      subjectValue: "",
      issuer: "",
    });
    // After "Use" + refresh: issuer saved -> Edit must open with it, not blank.
    expect(initialEditState({ subjectType: null, subjectUserId: null, issuerName: "RIPPLING PEO 1, INC." })).toEqual({
      subjectValue: "",
      issuer: "RIPPLING PEO 1, INC.",
    });
    expect(initialEditState({ subjectType: "person", subjectUserId: UID, issuerName: "X" })).toEqual({
      subjectValue: UID,
      issuer: "X",
    });
    expect(initialEditState({ subjectType: "joint", subjectUserId: null, issuerName: null }).subjectValue).toBe("joint");
  });

  it("saving only the person after reopening Edit preserves the saved issuer", () => {
    const state = initialEditState({ subjectType: null, subjectUserId: null, issuerName: "Alpine Bio" });
    const payload = buildAttributionPayload("doc-1", UID, state.issuer);
    expect(payload).toEqual({
      documentId: "doc-1",
      subjectType: "person",
      subjectUserId: UID,
      issuerName: "Alpine Bio",
    });
    // And the server-side normalisation keeps it.
    const v = validateAttribution(payload);
    expect(v).toEqual({ ok: true, value: { subjectType: "person", subjectUserId: UID, issuerName: "Alpine Bio" } });
  });

  it("buildAttributionPayload maps unassigned and joint", () => {
    expect(buildAttributionPayload("d", "", "")).toEqual({
      documentId: "d",
      subjectType: null,
      subjectUserId: null,
      issuerName: "",
    });
    expect(buildAttributionPayload("d", "joint", "Z")).toMatchObject({ subjectType: "joint", subjectUserId: null });
  });
});

describe("needsUnknownPersonOption (D3)", () => {
  const people = [ERIC, { id: "b0000000-0000-4000-8000-000000000002", name: "Eva-Laura Ramirez-Wisiackas" }];
  it("false for unassigned, joint, and listed people", () => {
    expect(needsUnknownPersonOption("", people)).toBe(false);
    expect(needsUnknownPersonOption("joint", people)).toBe(false);
    expect(needsUnknownPersonOption(UID, people)).toBe(false);
  });
  it("true for a person id absent from the list (incl. empty list)", () => {
    expect(needsUnknownPersonOption("c0000000-0000-4000-8000-0000000000ff", people)).toBe(true);
    expect(needsUnknownPersonOption(UID, [])).toBe(true);
  });
  it("the preserved value round-trips so Save doesn't change the person", () => {
    const missing = "c0000000-0000-4000-8000-0000000000ff";
    const { subjectValue } = initialEditState({ subjectType: "person", subjectUserId: missing, issuerName: null });
    expect(subjectValue).toBe(missing);
    expect(selectValueToSubject(subjectValue)).toEqual({ subjectType: "person", subjectUserId: missing });
  });
});

describe("tax doc types", () => {
  it("contains the household tax docTypes and excludes statements", () => {
    expect([...TAX_DOC_TYPES].sort()).toEqual(
      ["1099", "donation_receipt", "extension", "k1", "mortgage_interest", "property_tax", "tax_return", "w2"].sort()
    );
    expect(isTaxDocType("w2")).toBe(true);
    expect(isTaxDocType("bank_statement")).toBe(false);
    expect(isTaxDocType("other")).toBe(false);
  });
});
