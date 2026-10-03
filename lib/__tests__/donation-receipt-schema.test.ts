import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TAX_SCHEMAS,
  buildTaxExtractionPrompt,
  centsToDollarsInput,
  crossFieldWarnings,
  dollarsInputToCents,
  getTaxSchema,
  isUsableTaxExtraction,
  normalizeTaxExtraction,
  schemaTypeForDocType,
  schemaVersionFor,
  usableSignalKeys,
  validateCorrections,
} from "@/lib/tax-extraction-schema";
import { isUsableExtraction } from "@/lib/document-extraction-state";
import { buildCorrectionFields, draftFromValue } from "@/lib/tax-review-form";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";

// The Anthropic SDK is mocked exactly like doc-extract.test.ts: no real API call.
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));
import { extractDocumentOrThrow } from "@/lib/doc-extract";

const schema = getTaxSchema("donation_receipt");

const KEYS = [
  "organizationName",
  "organizationEIN",
  "giftDate",
  "cashAmountCents",
  "nonCashDescription",
  "coversMultipleGifts",
  "readsAsWrittenAcknowledgment",
  "noGoodsOrServicesStated",
  "benefitStatement",
];

const GOOD = {
  organizationName: "Connecticut Food Bank",
  organizationEIN: "06-1234567",
  giftDate: "2025-06-15",
  cashAmountCents: 25000,
  nonCashDescription: null,
  coversMultipleGifts: false,
  readsAsWrittenAcknowledgment: true,
  noGoodsOrServicesStated: true,
  benefitStatement: null,
};

describe("donation_receipt registry shape", () => {
  it("has exactly the nine specified keys with the specified kinds, groups, signal flags", () => {
    expect(schema.fields.map((f) => f.key)).toEqual(KEYS);
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
    expect(byKey.organizationName).toMatchObject({ kind: "text", group: "organization", signal: true });
    expect(byKey.organizationEIN).toMatchObject({ kind: "ein", group: "organization", signal: false });
    expect(byKey.giftDate).toMatchObject({ kind: "date", group: "gift", signal: true });
    expect(byKey.cashAmountCents).toMatchObject({ kind: "money", group: "gift", signal: true });
    expect(byKey.cashAmountCents!.signed).toBeFalsy();
    expect(byKey.nonCashDescription).toMatchObject({ kind: "text", group: "gift", signal: true, maxLen: 500 });
    expect(byKey.coversMultipleGifts).toMatchObject({ kind: "bool", group: "gift", signal: false });
    expect(byKey.readsAsWrittenAcknowledgment).toMatchObject({ kind: "bool", group: "acknowledgment", signal: false });
    expect(byKey.noGoodsOrServicesStated).toMatchObject({ kind: "bool", group: "acknowledgment", signal: false });
    expect(byKey.benefitStatement).toMatchObject({ kind: "text", group: "acknowledgment", signal: false, maxLen: 500 });
  });

  it("every field is in a declared group, AI-filled, non-legacy, feeds nothing; keys are unique; version 2", () => {
    const groups = schema.groups.map((g) => g.id);
    expect(groups).toEqual(["organization", "gift", "acknowledgment"]);
    expect(new Set(schema.fields.map((f) => f.key)).size).toBe(schema.fields.length);
    for (const f of schema.fields) {
      expect(groups).toContain(f.group);
      expect(f.aiFills).toBe(true);
      expect(f.legacy).toBe(false);
      expect(f.feeds).toEqual([]);
    }
    expect(schema.version).toBe(2);
    expect(schemaVersionFor("donation_receipt")).toBe(2);
  });

  it("has no SSN/ITIN/last-4/taxpayer-id key and no donor identity key", () => {
    for (const f of schema.fields) {
      expect(f.key).not.toMatch(/ssn|itin|taxpayerid|last4|tin$/i);
      expect(f.key).not.toMatch(/donor/i);
    }
    expect(schema.fields.some((f) => f.key === "taxYear")).toBe(false);
  });

  it("maps the raw docType to its own schema", () => {
    expect(schemaTypeForDocType("donation_receipt")).toBe("donation_receipt");
    expect(TAX_SCHEMAS.donation_receipt).toBe(schema);
  });
});

describe("normalizeTaxExtraction('donation_receipt')", () => {
  it("round-trips a valid reading and stamps schemaVersion 2", () => {
    const out = normalizeTaxExtraction("donation_receipt", { summary: "Receipt", data: GOOD });
    expect(out.data).toEqual(GOOD);
    expect(out.schemaVersion).toBe(2);
    expect(out.warnings).toEqual([]);
  });

  it("drops unknown keys such as a donor name", () => {
    const out = normalizeTaxExtraction("donation_receipt", {
      summary: "",
      data: { ...GOOD, donorName: "Eric Kinniburgh", donorAddress: "1 Main St" },
    });
    expect(Object.keys(out.data).sort()).toEqual([...KEYS].sort());
    expect(JSON.stringify(out)).not.toContain("Eric Kinniburgh");
  });

  it("nulls an EIN that is not NN-NNNNNNN, with a warning", () => {
    const out = normalizeTaxExtraction("donation_receipt", { summary: "", data: { ...GOOD, organizationEIN: "061234567" } });
    expect(out.data.organizationEIN).toBeNull();
    expect(out.warnings.join(" ")).toMatch(/EIN/);
  });

  it.each([250.5, "$250.00", -100, "250.00", 1e20, NaN])("never guesses cents from %s", (bad) => {
    const out = normalizeTaxExtraction("donation_receipt", { summary: "", data: { ...GOOD, cashAmountCents: bad } });
    expect(out.data.cashAmountCents).toBeNull();
    expect(out.warnings.join(" ")).toMatch(/Cash amount/);
  });

  it("accepts a lenient whole-number string of cents and keeps 0", () => {
    const a = normalizeTaxExtraction("donation_receipt", { summary: "", data: { ...GOOD, cashAmountCents: "25000" } });
    expect(a.data.cashAmountCents).toBe(25000);
    const b = normalizeTaxExtraction("donation_receipt", { summary: "", data: { ...GOOD, cashAmountCents: 0 } });
    expect(b.data.cashAmountCents).toBe(0);
  });

  it("booleans accept only true/false (and the strings true/false); 'yes' never becomes true", () => {
    const out = normalizeTaxExtraction("donation_receipt", {
      summary: "",
      data: {
        ...GOOD,
        noGoodsOrServicesStated: "yes",
        readsAsWrittenAcknowledgment: "true",
        coversMultipleGifts: 1,
      },
    });
    expect(out.data.noGoodsOrServicesStated).toBeNull();
    expect(out.data.readsAsWrittenAcknowledgment).toBe(true);
    expect(out.data.coversMultipleGifts).toBeNull();
    const kept = normalizeTaxExtraction("donation_receipt", {
      summary: "",
      data: { ...GOOD, noGoodsOrServicesStated: false },
    });
    expect(kept.data.noGoodsOrServicesStated).toBe(false);
  });

  it("an impossible date becomes null", () => {
    for (const bad of ["2025-02-30", "June 15, 2025", "2025/06/15", 20250615]) {
      const out = normalizeTaxExtraction("donation_receipt", { summary: "", data: { ...GOOD, giftDate: bad } });
      expect(out.data.giftDate).toBeNull();
    }
  });

  it("removes SSN-shaped text from every text slot and the summary", () => {
    const out = normalizeTaxExtraction("donation_receipt", {
      summary: "Receipt for 123-45-6789",
      data: {
        ...GOOD,
        organizationName: "Food Bank 123-45-6789",
        nonCashDescription: "Coat 123456789",
        benefitStatement: "Dinner, ref 123 45 6789",
      },
    });
    expect(out.data.organizationName).toBeNull();
    expect(out.data.nonCashDescription).toBeNull();
    expect(out.data.benefitStatement).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/\d{3}[-\s]?\d{2}[-\s]?\d{4}/);
  });

  it("truncates long text at its limit", () => {
    const long = "a".repeat(900);
    const out = normalizeTaxExtraction("donation_receipt", {
      summary: "",
      data: { ...GOOD, benefitStatement: long, nonCashDescription: long },
    });
    expect((out.data.benefitStatement as string).length).toBe(500);
    expect((out.data.nonCashDescription as string).length).toBe(500);
  });

  it("missing keys become null (never defaulted)", () => {
    const out = normalizeTaxExtraction("donation_receipt", { summary: "", data: { organizationName: "X" } });
    for (const k of KEYS.filter((k) => k !== "organizationName")) expect(out.data[k]).toBeNull();
  });
});

describe("validateCorrections('donation_receipt') (strict)", () => {
  it("accepts good values and null", () => {
    const r = validateCorrections("donation_receipt", {
      organizationName: "  Food Bank ",
      cashAmountCents: 25000,
      giftDate: "2025-06-15",
      noGoodsOrServicesStated: null,
      organizationEIN: "06-1234567",
    });
    expect(r).toEqual({
      ok: true,
      fields: {
        organizationName: "Food Bank",
        cashAmountCents: 25000,
        giftDate: "2025-06-15",
        noGoodsOrServicesStated: null,
        organizationEIN: "06-1234567",
      },
    });
  });

  it.each([
    [{ cashAmountCents: 250.5 }],
    [{ cashAmountCents: "25000" }],
    [{ cashAmountCents: -1 }],
    [{ donorName: "x" }],
    [{ organizationEIN: "123456789" }],
    [{ giftDate: "2025-13-01" }],
    [{ noGoodsOrServicesStated: "true" }],
    [{ benefitStatement: "x".repeat(501) }],
    [{ organizationName: "SSN 123-45-6789" }],
  ])("rejects %j", (bad) => {
    expect(validateCorrections("donation_receipt", bad).ok).toBe(false);
  });
});

describe("usability", () => {
  it("signal keys are charity name, gift date, cash amount and non-cash description", () => {
    expect(usableSignalKeys("donation_receipt").sort()).toEqual(
      ["cashAmountCents", "giftDate", "nonCashDescription", "organizationName"].sort()
    );
  });

  it("an all-null reading is NOT usable (the run fails, never an empty review form)", () => {
    const empty = normalizeTaxExtraction("donation_receipt", { summary: "x", data: {} });
    expect(isUsableTaxExtraction("donation_receipt", empty)).toBe(false);
    expect(isUsableExtraction("donation_receipt", empty)).toBe(false);
  });

  it("a reading with only a legible charity name is usable", () => {
    const out = normalizeTaxExtraction("donation_receipt", { summary: "Receipt", data: { organizationName: "Food Bank" } });
    expect(isUsableTaxExtraction("donation_receipt", out)).toBe(true);
    expect(isUsableExtraction("donation_receipt", out)).toBe(true);
  });

  it("another type's data is not usable as a receipt (stale data after a retype)", () => {
    const w2 = { docType: "w2", summary: "W-2", data: { taxYear: 2025, employerName: "Acme", wagesCents: 100 } };
    expect(isUsableExtraction("donation_receipt", w2)).toBe(false);
  });
});

describe("prompt", () => {
  const prompt = buildTaxExtractionPrompt("donation_receipt");

  it("lists every key in the JSON template and the docType", () => {
    expect(prompt).toContain('"docType": "donation_receipt"');
    const templateKeys = [...prompt.matchAll(/"([A-Za-z0-9_]+)":/g)].map((m) => m[1]).filter((k) => k !== "docType" && k !== "summary" && k !== "data");
    expect(templateKeys.sort()).toEqual([...KEYS].sort());
  });

  it("carries the generic SSN, integer-cents, EIN and null-not-guess rules", () => {
    expect(prompt).toMatch(/never output a Social Security Number/i);
    expect(prompt).toMatch(/integer cents/i);
    expect(prompt).toMatch(/NN-NNNNNNN/);
    expect(prompt).toMatch(/Never guess/);
  });

  it.each([
    "not a tax form. Describe only what the document says",
    "Never output a dollar value for non-cash items",
    "never in cashAmountCents",
    "set coversMultipleGifts to true and leave giftDate and cashAmountCents null; do not sum amounts",
    "Do not extract the donor's name, address, account number or any donor identification",
    "noGoodsOrServicesStated: silence is null. Do not infer 'no goods or services' from the absence of a statement",
    "Use null for anything not clearly legible. Never guess.",
  ])("contains the guardrail: %s", (sentence) => {
    expect(prompt).toContain(sentence);
  });
});

describe("mocked extractDocumentOrThrow('donation_receipt') (no real API call)", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("uses the donation prompt, 4096 max_tokens, normalizes and stamps schemaVersion 2", async () => {
    mockCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            docType: "donation_receipt",
            summary: "Receipt",
            data: { ...GOOD, donorName: "Eric", cashAmountCents: "$250.00" },
          }),
        },
      ],
    });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "donation_receipt");
    const arg = mockCreate.mock.calls[0]![0];
    expect(arg.max_tokens).toBe(4096);
    expect(arg.system).toBe(buildTaxExtractionPrompt("donation_receipt"));
    expect(out.schemaVersion).toBe(2);
    expect(out.data.donorName).toBeUndefined();
    expect(out.data.cashAmountCents).toBeNull();
    expect(out.data.organizationName).toBe("Connecticut Food Bank");
  });

  it("sends a PNG as image/png (not mislabelled)", async () => {
    mockCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ docType: "donation_receipt", summary: "", data: GOOD }) }],
    });
    await extractDocumentOrThrow(Buffer.from("x"), "image/png", "donation_receipt");
    expect(mockCreate.mock.calls[0]![0].messages[0].content[0].source.media_type).toBe("image/png");
  });
});

describe("review-form field definitions (registry-driven)", () => {
  it("every field survives an unchanged draft round-trip as an empty override set that validates", () => {
    const ai = normalizeTaxExtraction("donation_receipt", { summary: "", data: GOOD });
    const drafts = Object.fromEntries(schema.fields.map((def) => [def.key, draftFromValue(def, ai.data[def.key])]));
    const visible = new Set(schema.fields.map((f) => f.key));
    const built = buildCorrectionFields("donation_receipt", drafts, ai.data, visible);
    expect(built.errors).toEqual({});
    expect(built.fields).toEqual({});
    expect(validateCorrections("donation_receipt", built.fields).ok).toBe(true);
  });

  it("a changed cash-amount draft yields integer cents; a blanked field yields null", () => {
    const ai = normalizeTaxExtraction("donation_receipt", { summary: "", data: GOOD });
    const drafts = Object.fromEntries(schema.fields.map((def) => [def.key, draftFromValue(def, ai.data[def.key])]));
    const cash = schema.fields.find((f) => f.key === "cashAmountCents")!;
    const ein = schema.fields.find((f) => f.key === "organizationEIN")!;
    drafts.cashAmountCents = { ...draftFromValue(cash, 25000), text: "300.50" };
    drafts.organizationEIN = { ...draftFromValue(ein, null), text: "" };
    const built = buildCorrectionFields("donation_receipt", drafts, ai.data, new Set(schema.fields.map((f) => f.key)));
    expect(built.errors).toEqual({});
    expect(built.fields).toEqual({ cashAmountCents: 30050, organizationEIN: null });
  });

  it("the cash amount is edited in dollars and stored as integer cents", () => {
    expect(centsToDollarsInput(25000)).toBe("250.00");
    expect(dollarsInputToCents("$250.00")).toBe(25000);
    expect(dollarsInputToCents("19.99")).toBe(1999);
  });

  it("owner corrections win over the AI value and a corrected null clears it", () => {
    const stored = { docType: "donation_receipt", summary: "", data: GOOD };
    const corrections = {
      version: 1,
      fields: {
        cashAmountCents: { value: 30000, aiValue: 25000, correctedAt: "2026-10-03T00:00:00Z", correctedById: "u" },
        organizationEIN: { value: null, aiValue: "06-1234567", correctedAt: "2026-10-03T00:00:00Z", correctedById: "u" },
      },
      events: [],
    };
    const eff = resolveEffectiveExtraction({
      docType: "donation_receipt",
      extractionData: stored,
      extractionCorrections: corrections,
      extractionConfirmedAt: null,
    });
    const data = (eff.extractionData as { data: Record<string, unknown> }).data;
    expect(data.cashAmountCents).toBe(30000);
    expect(data.organizationEIN).toBeNull();
    expect(eff.correctedKeys.sort()).toEqual(["cashAmountCents", "organizationEIN"]);
  });
});

describe("crossFieldWarnings('donation_receipt')", () => {
  const warn = (data: Record<string, unknown>, documentTaxYear: number | null = 2025) =>
    crossFieldWarnings("donation_receipt", { ...GOOD, ...data }, { documentTaxYear });

  it("is silent on a clean reading", () => {
    expect(warn({})).toEqual([]);
  });

  it("warns when the gift year differs from the filed year", () => {
    expect(warn({ giftDate: "2024-12-31" }).join(" ")).toMatch(/gift was in 2024 but this document is filed under 2025/);
    expect(warn({ giftDate: "2024-12-31" }, null)).toEqual([]);
  });

  it("warns when several gifts are listed but a single date or amount is filled in", () => {
    expect(warn({ coversMultipleGifts: true }).join(" ")).toMatch(/Several gifts/);
    expect(warn({ coversMultipleGifts: true, giftDate: null, cashAmountCents: null })).toEqual([]);
  });

  it("warns when both cash and non-cash are present", () => {
    expect(warn({ nonCashDescription: "Winter coats" }).join(" ")).toMatch(/separate gifts/);
  });

  it("warns when the no-goods answer and the benefit text disagree, and when goods are provided with no description", () => {
    expect(warn({ noGoodsOrServicesStated: true, benefitStatement: "Dinner" }).join(" ")).toMatch(/disagree/);
    expect(warn({ noGoodsOrServicesStated: false, benefitStatement: null }).join(" ")).toMatch(/no description is filled in/);
    expect(warn({ noGoodsOrServicesStated: false, benefitStatement: "Dinner" })).toEqual([]);
  });
});
