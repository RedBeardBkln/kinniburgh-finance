import { describe, it, expect } from "vitest";
import { readCorrectionEntries, resolveEffectiveExtraction } from "@/lib/extraction-effective";

const AI = {
  docType: "w2",
  schemaVersion: 2,
  summary: "W-2",
  data: { taxYear: 2025, wagesCents: 5000000, federalWithheldCents: 800000, employerName: "Acme" },
};

function overlay(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = { value: v, aiValue: "x", correctedAt: "2026-10-02T00:00:00.000Z", correctedById: "u" };
  }
  return { version: 1, fields: out, events: [] };
}

function dataOf(extractionData: unknown): Record<string, unknown> {
  return (extractionData as { data: Record<string, unknown> }).data;
}

describe("resolveEffectiveExtraction", () => {
  it("returns the AI data untouched when there are no corrections", () => {
    const r = resolveEffectiveExtraction({
      docType: "w2",
      extractionData: AI,
      extractionCorrections: null,
      extractionConfirmedAt: null,
    });
    expect(r.extractionData).toEqual(AI);
    expect(r.correctedKeys).toEqual([]);
    expect(r.verified).toBe(false);
    expect(r.schemaVersion).toBe(2);
  });

  it("a correction wins over the AI value, and a corrected null overrides it", () => {
    const r = resolveEffectiveExtraction({
      docType: "w2",
      extractionData: AI,
      extractionCorrections: overlay({ wagesCents: 5100000, federalWithheldCents: null }),
      extractionConfirmedAt: new Date("2026-10-02T00:00:00Z"),
    });
    const data = dataOf(r.extractionData);
    expect(data.wagesCents).toBe(5100000);
    expect(data.federalWithheldCents).toBeNull();
    expect(data.employerName).toBe("Acme");
    expect(r.correctedKeys.sort()).toEqual(["federalWithheldCents", "wagesCents"]);
    expect(r.verified).toBe(true);
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(AI);
    resolveEffectiveExtraction({
      docType: "w2",
      extractionData: AI,
      extractionCorrections: overlay({ wagesCents: 1 }),
      extractionConfirmedAt: null,
    });
    expect(JSON.stringify(AI)).toBe(snapshot);
  });

  it("ignores overlay keys that are not in the document's current schema (inert after a retype)", () => {
    const r = resolveEffectiveExtraction({
      docType: "w2",
      extractionData: AI,
      extractionCorrections: overlay({ interestCents: 99, wagesCents: 7 }),
      extractionConfirmedAt: null,
    });
    expect(dataOf(r.extractionData)).not.toHaveProperty("interestCents");
    expect(r.correctedKeys).toEqual(["wagesCents"]);
  });

  it("never throws on malformed JSON and returns the AI data", () => {
    const junk: unknown[] = [
      "x",
      5,
      [],
      { fields: "nope" },
      { fields: { wagesCents: "not-an-entry" } },
      { fields: { wagesCents: {} } },
    ];
    for (const corrections of junk) {
      const r = resolveEffectiveExtraction({
        docType: "w2",
        extractionData: AI,
        extractionCorrections: corrections,
        extractionConfirmedAt: null,
      });
      expect(dataOf(r.extractionData).wagesCents).toBe(5000000);
    }
    expect(
      resolveEffectiveExtraction({
        docType: "w2",
        extractionData: "garbage",
        extractionCorrections: null,
        extractionConfirmedAt: null,
      }).extractionData
    ).toBe("garbage");
    expect(
      resolveEffectiveExtraction({
        docType: "w2",
        extractionData: null,
        extractionCorrections: overlay({ wagesCents: 1 }),
        extractionConfirmedAt: null,
      }).extractionData
    ).toBeNull();
  });

  it("schemaVersion is 1 for a legacy extraction (absent), and non-tax docs are passed through", () => {
    const legacy = { docType: "w2", summary: "", data: { wagesCents: 5 } };
    expect(
      resolveEffectiveExtraction({
        docType: "w2",
        extractionData: legacy,
        extractionCorrections: null,
        extractionConfirmedAt: null,
      }).schemaVersion
    ).toBe(1);
    const policy = { docType: "insurance_policy", summary: "", data: { insurer: "x" } };
    const r = resolveEffectiveExtraction({
      docType: "insurance_policy",
      extractionData: policy,
      extractionCorrections: overlay({ insurer: "y" }),
      extractionConfirmedAt: null,
    });
    expect(r.extractionData).toBe(policy);
    expect(r.correctedKeys).toEqual([]);
  });

  it("keeps the legacy flat stateWithheldCents consistent with corrected stateLines (CT only)", () => {
    const withLines = {
      ...AI,
      data: {
        ...AI.data,
        stateLines: [{ stateCode: "CT", stateWithheldCents: 100 }],
        stateWithheldCents: 100,
      },
    };
    const r = resolveEffectiveExtraction({
      docType: "w2",
      extractionData: withLines,
      extractionCorrections: overlay({
        stateLines: [
          { stateCode: "CT", stateWithheldCents: 250 },
          { stateCode: "NY", stateWithheldCents: 999 },
        ],
      }),
      extractionConfirmedAt: null,
    });
    expect(dataOf(r.extractionData).stateWithheldCents).toBe(250);
  });

  it("an older document with only the flat stateWithheldCents is left exactly as it was", () => {
    const legacy = { docType: "w2", summary: "", data: { wagesCents: 5, stateWithheldCents: 77 } };
    const r = resolveEffectiveExtraction({
      docType: "w2",
      extractionData: legacy,
      extractionCorrections: overlay({ wagesCents: 6 }),
      extractionConfirmedAt: null,
    });
    expect(dataOf(r.extractionData)).toEqual({ wagesCents: 6, stateWithheldCents: 77 });
  });

  it("an owner-corrected legacy stateWithheldCents wins over the derived one", () => {
    const withLines = { ...AI, data: { ...AI.data, stateLines: [{ stateCode: "CT", stateWithheldCents: 100 }] } };
    const r = resolveEffectiveExtraction({
      docType: "w2",
      extractionData: withLines,
      extractionCorrections: overlay({ stateWithheldCents: 5 }),
      extractionConfirmedAt: null,
    });
    expect(dataOf(r.extractionData).stateWithheldCents).toBe(5);
  });

  it("mortgage_interest corrections resolve against the 1098 schema", () => {
    const r = resolveEffectiveExtraction({
      docType: "mortgage_interest",
      extractionData: { docType: "form_1098", schemaVersion: 2, summary: "", data: { interestCents: 1 } },
      extractionCorrections: overlay({ interestCents: 2 }),
      extractionConfirmedAt: null,
    });
    expect(dataOf(r.extractionData).interestCents).toBe(2);
  });
});

describe("readCorrectionEntries", () => {
  it("returns value and aiValue for keys in the current schema only", () => {
    const out = readCorrectionEntries("w2", {
      version: 1,
      fields: {
        wagesCents: { value: 2, aiValue: 1, correctedAt: "x", correctedById: "u" },
        notInSchema: { value: 1, aiValue: 1 },
        broken: "x",
      },
      events: [],
    });
    expect(out).toEqual({ wagesCents: { value: 2, aiValue: 1 } });
    expect(readCorrectionEntries("other", { fields: { a: { value: 1 } } })).toEqual({});
    expect(readCorrectionEntries("w2", null)).toEqual({});
  });
});
