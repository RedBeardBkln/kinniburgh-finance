import { describe, it, expect } from "vitest";
import {
  ALREADY_UP_TO_DATE_ERROR,
  CURRENT_SCHEMA_VERSION,
  EXPANDED_SCHEMA_DOC_TYPES,
  EXTRACTABLE_DOC_TYPES,
  EXTRACTION_ERROR_MAX_LENGTH,
  MAX_BULK_EXTRACT,
  describeDocumentRow,
  buildExtractionOverview,
  describeExtraction,
  isCurrentSchema,
  isExtractableDocType,
  isUsableExtraction,
  meetsExtractionExpectation,
  planBulkExtraction,
  sanitizeExtractionError,
  type DescribeExtractionInput,
} from "@/lib/document-extraction-state";
import { STALE_PROCESSING_MS } from "@/lib/statement-import";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const FRESH = new Date(NOW - 60_000);
const STALE = new Date(NOW - STALE_PROCESSING_MS - 1000);

// Current-format (schemaVersion 2) W-2 and the legacy (no schemaVersion) shape the
// 8 live documents were extracted with.
const W2_DATA = {
  docType: "w2",
  schemaVersion: 2,
  summary: "W-2",
  data: { taxYear: 2025, employerName: "Acme", wagesCents: 5000000, federalWithheldCents: 800000 },
};
const LEGACY_W2 = {
  docType: "w2",
  summary: "W-2",
  data: { taxYear: 2025, employerName: "Acme", wagesCents: 5000000, federalWithheldCents: 800000 },
};
const STATEMENT_DATA = {
  docType: "bank_statement",
  summary: "stmt",
  data: { openingBalanceCents: 100 },
  transactionRows: [{ date: "2026-01-01", description: "x", amountCents: -100 }],
};
const PARSE_STUB = { docType: "other", summary: "Could not parse extraction response.", data: { raw: "oops" } };
const FAILED_STUB = { docType: "w2", summary: "Extraction failed.", data: {} };
const ALL_NULL_W2 = {
  docType: "w2",
  summary: "W-2",
  data: { taxYear: 2025, employerName: "Acme", wagesCents: null, federalWithheldCents: null },
};

function input(over: Partial<DescribeExtractionInput> = {}): DescribeExtractionInput {
  return {
    docType: "w2",
    extractionStatus: "complete",
    updatedAt: FRESH,
    extractionData: W2_DATA,
    extractionConfirmedAt: null,
    correctionCount: 0,
    extractionError: null,
    ...over,
  };
}

describe("isExtractableDocType", () => {
  it("accepts every type with a schema", () => {
    for (const t of EXTRACTABLE_DOC_TYPES) expect(isExtractableDocType(t)).toBe(true);
  });
  it("rejects extension and other (no schema)", () => {
    expect(isExtractableDocType("extension")).toBe(false);
    expect(isExtractableDocType("other")).toBe(false);
    expect(isExtractableDocType("anything_else")).toBe(false);
  });
});

describe("isUsableExtraction", () => {
  it("requires a money signal for tax forms (all-null is not usable)", () => {
    expect(isUsableExtraction("w2", W2_DATA)).toBe(true);
    expect(isUsableExtraction("w2", ALL_NULL_W2)).toBe(false);
  });
  it("rejects the parse-failure stub and the empty stub", () => {
    expect(isUsableExtraction("w2", PARSE_STUB)).toBe(false);
    expect(isUsableExtraction("w2", FAILED_STUB)).toBe(false);
    expect(isUsableExtraction("bank_statement", FAILED_STUB)).toBe(false);
  });
  it("accepts a live-shaped 1098 stored with the statement shape", () => {
    expect(
      isUsableExtraction("mortgage_interest", {
        docType: "mortgage_statement",
        summary: "1098",
        data: { interestCents: 1888269, principalBalanceCents: 37787263, loanNumber: null },
      })
    ).toBe(true);
  });
  it("accepts a consolidated 1099 with only the legacy amountCents", () => {
    expect(
      isUsableExtraction("1099", { docType: "1099", summary: "", data: { formVariant: "1099-DIV", amountCents: 358 } })
    ).toBe(true);
  });
  it("counts transactionRows for statements and plain data for non-tax types", () => {
    expect(isUsableExtraction("bank_statement", STATEMENT_DATA)).toBe(true);
    expect(isUsableExtraction("utility_bill", { docType: "utility_bill", summary: "", data: { provider: "x" } })).toBe(true);
  });
  it("handles null / non-object input", () => {
    expect(isUsableExtraction("w2", null)).toBe(false);
    expect(isUsableExtraction("w2", "nope")).toBe(false);
    expect(isUsableExtraction("w2", [])).toBe(false);
  });
});

describe("isCurrentSchema (legacy / older-format detection)", () => {
  it("flags an expanded tax type with no schemaVersion (or a lower one) as older format", () => {
    for (const t of ["w2", "1099", "k1", "mortgage_interest", "property_tax"]) {
      expect(isCurrentSchema(t, LEGACY_W2)).toBe(false);
      expect(isCurrentSchema(t, { ...LEGACY_W2, schemaVersion: 1 })).toBe(false);
      expect(isCurrentSchema(t, W2_DATA)).toBe(true);
    }
  });
  it("the expanded set is derived from the schema registry", () => {
    expect([...EXPANDED_SCHEMA_DOC_TYPES].sort()).toEqual([
      "1099",
      "donation_receipt",
      "k1",
      "mortgage_interest",
      "property_tax",
      "w2",
    ]);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
  it("tax_return keeps its unchanged schema and non-tax types are never outdated", () => {
    expect(isCurrentSchema("tax_return", LEGACY_W2)).toBe(true);
    expect(isCurrentSchema("bank_statement", STATEMENT_DATA)).toBe(true);
    expect(isCurrentSchema("insurance_policy", null)).toBe(true);
  });
});

describe("describeExtraction - state table", () => {
  it("1. non-extractable types are N/A with no actions", () => {
    for (const docType of ["other", "extension"]) {
      const d = describeExtraction(input({ docType, extractionStatus: null, extractionData: null }), NOW);
      expect(d).toMatchObject({ kind: "na", label: "N/A", tone: "muted", actions: [] });
    }
  });

  it("2. a fresh processing row shows Processing with no actions", () => {
    const d = describeExtraction(input({ extractionStatus: "processing", extractionData: null }), NOW);
    expect(d).toMatchObject({ kind: "processing", label: "Processing...", tone: "blue", actions: [] });
  });

  it("3. skipped + not usable offers Extract anyway", () => {
    const d = describeExtraction(input({ extractionStatus: "skipped", extractionData: null }), NOW);
    expect(d).toMatchObject({ kind: "skipped", actions: ["extract_anyway"] });
  });

  it("4. failed status with no data -> Failed, Retry, persisted reason shown", () => {
    const d = describeExtraction(
      input({ extractionStatus: "failed", extractionData: null, extractionError: "Output was cut off" }),
      NOW
    );
    expect(d).toMatchObject({ kind: "failed", tone: "red", reason: "Output was cut off", actions: ["retry"] });
  });

  it("4. failed without a persisted reason gives a generic one", () => {
    const d = describeExtraction(input({ extractionStatus: "failed", extractionData: null }), NOW);
    expect(d.kind).toBe("failed");
    expect(d.reason).toBe("Extraction failed");
  });

  it("4. complete label on unusable data is Failed, not Extracted (parse stub / empty stub / all-null)", () => {
    for (const extractionData of [PARSE_STUB, FAILED_STUB, ALL_NULL_W2, null]) {
      const d = describeExtraction(input({ extractionStatus: "complete", extractionData }), NOW);
      expect(d.kind).toBe("failed");
      expect(d.reason).toBe("Marked extracted but nothing readable was saved");
      expect(d.actions).toEqual(["retry"]);
    }
  });

  it("4. a stale processing row reads as Failed / timed out with Retry", () => {
    const d = describeExtraction(input({ extractionStatus: "processing", updatedAt: STALE, extractionData: null }), NOW);
    expect(d).toMatchObject({ kind: "failed", actions: ["retry"] });
    expect(d.reason).toMatch(/timed out/i);
  });

  it("5. null / pending status with no data is Not extracted with Run", () => {
    for (const extractionStatus of [null, "pending"]) {
      const d = describeExtraction(input({ extractionStatus, extractionData: null }), NOW);
      expect(d).toMatchObject({ kind: "not_extracted", label: "Not extracted", tone: "amber", actions: ["run"] });
    }
  });

  it("8. usable tax doc, unverified (current schema) -> Extracted - needs review", () => {
    const d = describeExtraction(input(), NOW);
    expect(d).toMatchObject({
      kind: "extracted_unverified",
      label: "Extracted - needs review",
      tone: "amber",
      actions: ["review", "reextract"],
      outdated: false,
    });
    expect(d.reason).toBeUndefined();
  });

  it("7. usable tax doc in the older format -> Extracted - older format (Review + Re-extract)", () => {
    const d = describeExtraction(input({ extractionData: LEGACY_W2 }), NOW);
    expect(d).toMatchObject({
      kind: "extracted_outdated",
      label: "Extracted - older format",
      tone: "amber",
      actions: ["review", "reextract"],
      outdated: true,
    });
    expect(d.hint).toMatch(/re-extract/i);
  });

  it("6. a verified older-format doc stays Verified with an (older format) suffix", () => {
    const d = describeExtraction(input({ extractionData: LEGACY_W2, extractionConfirmedAt: new Date(NOW) }), NOW);
    expect(d).toMatchObject({ kind: "verified", label: "Verified (older format)", outdated: true });
  });

  it("the live legacy shapes (W-2, consolidated 1099, 1098 in statement shape) all read as older format", () => {
    const cases: [string, unknown][] = [
      ["w2", LEGACY_W2],
      ["1099", { docType: "1099", summary: "", data: { formVariant: "1099-DIV", amountCents: 358 } }],
      [
        "mortgage_interest",
        { docType: "mortgage_statement", summary: "", data: { interestCents: 1888269, principalBalanceCents: 37787263 } },
      ],
    ];
    for (const [docType, extractionData] of cases) {
      expect(describeExtraction(input({ docType, extractionData }), NOW).kind).toBe("extracted_outdated");
    }
  });

  it("6. verified tax doc (+ edit count)", () => {
    const verified = describeExtraction(input({ extractionConfirmedAt: new Date(NOW) }), NOW);
    expect(verified).toMatchObject({ kind: "verified", label: "Verified", tone: "green", actions: ["review", "reextract"] });
    expect(
      describeExtraction(input({ extractionConfirmedAt: new Date(NOW), correctionCount: 1 }), NOW).label
    ).toBe("Verified - 1 edit");
    expect(
      describeExtraction(input({ extractionConfirmedAt: new Date(NOW), correctionCount: 3 }), NOW).label
    ).toBe("Verified - 3 edits");
  });

  it("verified requires status complete (a stale label does not show Verified)", () => {
    const d = describeExtraction(input({ extractionConfirmedAt: new Date(NOW), extractionStatus: "failed" }), NOW);
    expect(d.kind).toBe("extracted_unverified");
  });

  it("9. verified non-tax document", () => {
    const d = describeExtraction(
      input({
        docType: "insurance_policy",
        extractionData: { docType: "insurance_policy", summary: "", data: { insurer: "NWM" } },
        extractionConfirmedAt: new Date(NOW),
      }),
      NOW
    );
    expect(d).toMatchObject({ kind: "verified", actions: ["review"] });
  });

  it("10. non-tax extracted document", () => {
    const d = describeExtraction(
      input({ docType: "utility_bill", extractionData: { docType: "utility_bill", summary: "", data: { provider: "x" } } }),
      NOW
    );
    expect(d).toMatchObject({ kind: "extracted", label: "Extracted", tone: "green", actions: ["review"] });
  });

  it("bank statements are never Verified from extractionConfirmedAt and point to the Statements page", () => {
    for (const docType of ["bank_statement", "statement"]) {
      const d = describeExtraction(
        input({ docType, extractionData: STATEMENT_DATA, extractionConfirmedAt: new Date(NOW) }),
        NOW
      );
      expect(d.kind).toBe("extracted");
      expect(d.hint).toMatch(/Statements page/);
    }
  });

  it("usable data beats a failed label: failed re-extract of a good doc is never a bare Failed", () => {
    const viaStatus = describeExtraction(input({ extractionStatus: "failed" }), NOW);
    expect(viaStatus.kind).toBe("extracted_unverified");
    expect(viaStatus.reason).toMatch(/last re-extract failed/i);
    const viaError = describeExtraction(input({ extractionError: "API overloaded" }), NOW);
    expect(viaError.kind).toBe("extracted_unverified");
    expect(viaError.reason).toBe("Last re-extract failed: API overloaded");
  });

  it("stale processing on a doc that has good data keeps it Extracted", () => {
    const d = describeExtraction(input({ extractionStatus: "processing", updatedAt: STALE }), NOW);
    expect(d.kind).toBe("extracted_unverified");
    expect(d.reason).toMatch(/last re-extract failed/i);
  });

  it("every extractable docType x every status is classified, never throws, and never offers Review without data", () => {
    const statuses: (string | null)[] = [null, "pending", "processing", "complete", "failed", "skipped"];
    for (const docType of EXTRACTABLE_DOC_TYPES) {
      for (const extractionStatus of statuses) {
        for (const extractionData of [null, PARSE_STUB, W2_DATA, STATEMENT_DATA]) {
          for (const confirmed of [null, new Date(NOW)]) {
            const d = describeExtraction(input({ docType, extractionStatus, extractionData, extractionConfirmedAt: confirmed }), NOW);
            expect(d.label.length).toBeGreaterThan(0);
            if (d.actions.includes("review")) {
              expect(isUsableExtraction(docType, extractionData)).toBe(true);
            }
            if (d.kind === "not_extracted") expect(d.actions).toEqual(["run"]);
          }
        }
      }
    }
  });
});

describe("describeDocumentRow", () => {
  it("derives the correction count from the overlay JSON", () => {
    const d = describeDocumentRow(
      {
        docType: "w2",
        extractionStatus: "complete",
        updatedAt: FRESH,
        extractionData: W2_DATA,
        extractionConfirmedAt: new Date(NOW),
        extractionCorrections: { version: 1, fields: { wagesCents: { value: 1 }, employerName: { value: "x" } }, events: [] },
        extractionError: null,
      },
      NOW
    );
    expect(d.kind).toBe("verified");
    expect(d.correctionCount).toBe(2);
  });
});

describe("meetsExtractionExpectation (server-side stale-tab guard)", () => {
  it("unextracted: only not-extracted / failed docs", () => {
    expect(meetsExtractionExpectation("unextracted", input({ extractionStatus: null, extractionData: null }), NOW)).toBe(true);
    expect(meetsExtractionExpectation("unextracted", input({ extractionStatus: "failed", extractionData: null }), NOW)).toBe(true);
    // Now extracted (another tab ran it): must not spend again.
    expect(meetsExtractionExpectation("unextracted", input(), NOW)).toBe(false);
    expect(meetsExtractionExpectation("unextracted", input({ extractionStatus: "skipped", extractionData: null }), NOW)).toBe(false);
    expect(meetsExtractionExpectation("unextracted", input({ extractionStatus: "processing", extractionData: null }), NOW)).toBe(false);
  });
  it("outdated: only unverified, uncorrected older-format docs; ALREADY_UP_TO_DATE_ERROR is a stable string", () => {
    expect(meetsExtractionExpectation("outdated", input(), NOW)).toBe(false); // current format
    expect(meetsExtractionExpectation("outdated", input({ extractionData: LEGACY_W2 }), NOW)).toBe(true);
    expect(
      meetsExtractionExpectation("outdated", input({ extractionData: LEGACY_W2, extractionConfirmedAt: new Date(NOW) }), NOW)
    ).toBe(false); // verified: never bulk-overwritten
    expect(meetsExtractionExpectation("outdated", input({ extractionData: LEGACY_W2, correctionCount: 2 }), NOW)).toBe(false);
    expect(meetsExtractionExpectation("outdated", input({ extractionData: null, extractionStatus: null }), NOW)).toBe(false);
    expect(ALREADY_UP_TO_DATE_ERROR).toBe("Skipped - already up to date");
  });
});

describe("planBulkExtraction", () => {
  const doc = (id: string, over: Partial<DescribeExtractionInput> = {}) => ({ id, ...input(over) });

  it("missing = extractable, not-extracted/failed; excludes extracted, verified, skipped, processing, N/A and statements", () => {
    const plan = planBulkExtraction(
      [
        doc("never", { extractionStatus: null, extractionData: null }),
        doc("failed", { extractionStatus: "failed", extractionData: null }),
        doc("emptyComplete", { extractionStatus: "complete", extractionData: FAILED_STUB }),
        doc("done"),
        doc("verified", { extractionConfirmedAt: new Date(NOW) }),
        doc("skipped", { extractionStatus: "skipped", extractionData: null }),
        doc("running", { extractionStatus: "processing", extractionData: null }),
        doc("na", { docType: "other", extractionStatus: null, extractionData: null }),
        doc("ext", { docType: "extension", extractionStatus: null, extractionData: null }),
        doc("stmt", { docType: "bank_statement", extractionStatus: null, extractionData: null }),
        doc("stmt2", { docType: "statement", extractionStatus: "failed", extractionData: null }),
        doc("insurance", { docType: "insurance_policy", extractionStatus: null, extractionData: null }),
      ],
      NOW
    );
    expect(plan.missing).toEqual(["never", "failed", "emptyComplete", "insurance"]);
    expect(plan.outdated).toEqual([]);
    expect(plan.needIndividual).toBe(0);
  });

  it("outdated = unverified, uncorrected older-format tax docs; verified / corrected ones are counted as needing individual re-extract", () => {
    const plan = planBulkExtraction(
      [
        doc("old1", { extractionData: LEGACY_W2 }),
        doc("old2", { docType: "1099", extractionData: { docType: "1099", summary: "", data: { amountCents: 5 } } }),
        doc("oldVerified", { extractionData: LEGACY_W2, extractionConfirmedAt: new Date(NOW) }),
        doc("oldCorrected", { extractionData: LEGACY_W2, correctionCount: 1 }),
        doc("current"),
        doc("notExtracted", { extractionStatus: null, extractionData: null }),
        doc("insurance", {
          docType: "insurance_policy",
          extractionData: { docType: "insurance_policy", summary: "", data: { insurer: "x" } },
        }),
      ],
      NOW
    );
    expect(plan.outdated).toEqual(["old1", "old2"]);
    expect(plan.needIndividual).toBe(2);
    expect(plan.missing).toEqual(["notExtracted"]);
  });

  it("a VERIFIED older-format doc whose forced re-extract died (stale processing / failed, data intact) is never in outdated", () => {
    const confirmed = new Date(NOW - 86_400_000);
    const diedStale = doc("diedStale", {
      extractionStatus: "processing",
      updatedAt: STALE,
      extractionData: LEGACY_W2,
      extractionConfirmedAt: confirmed,
    });
    const diedFailed = doc("diedFailed", {
      extractionStatus: "failed",
      extractionData: LEGACY_W2,
      extractionConfirmedAt: confirmed,
    });
    const plan = planBulkExtraction([diedStale, diedFailed], NOW);
    expect(plan.outdated).toEqual([]);
    expect(plan.needIndividual).toBe(2);
    // Client plan and server gate agree.
    expect(meetsExtractionExpectation("outdated", diedStale, NOW)).toBe(false);
    expect(meetsExtractionExpectation("outdated", diedFailed, NOW)).toBe(false);
    // The same stuck row WITHOUT a verification is a legitimate bulk candidate.
    const unverified = doc("diedUnverified", { extractionStatus: "processing", updatedAt: STALE, extractionData: LEGACY_W2 });
    expect(planBulkExtraction([unverified], NOW).outdated).toEqual(["diedUnverified"]);
    expect(meetsExtractionExpectation("outdated", unverified, NOW)).toBe(true);
  });

  it("includes a stale-processing row (dead extraction) as missing", () => {
    const plan = planBulkExtraction(
      [doc("dead", { extractionStatus: "processing", updatedAt: STALE, extractionData: null })],
      NOW
    );
    expect(plan.missing).toEqual(["dead"]);
  });

  it("the per-click cap constant is 25", () => {
    expect(MAX_BULK_EXTRACT).toBe(25);
  });
});

describe("sanitizeExtractionError", () => {
  it("keeps the message only, single line", () => {
    expect(sanitizeExtractionError(new Error("  boom\n\tbad   things "))).toBe("boom bad things");
  });
  it("caps the length", () => {
    const out = sanitizeExtractionError(new Error("x".repeat(1000)));
    expect(out.length).toBeLessThanOrEqual(EXTRACTION_ERROR_MAX_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });
  it("falls back for empty / non-error input", () => {
    expect(sanitizeExtractionError(undefined)).toBe("Extraction failed");
    expect(sanitizeExtractionError(new Error("   "))).toBe("Extraction failed");
    expect(sanitizeExtractionError("plain string")).toBe("plain string");
  });
});

describe("buildExtractionOverview", () => {
  it("returns a display per document plus the bulk plan", () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      docType: "w2",
      extractionStatus: null as string | null,
      updatedAt: FRESH,
      extractionData: null as unknown,
      extractionConfirmedAt: null,
      extractionCorrections: null,
      extractionError: null,
      ...over,
    });
    const { displayById, plan } = buildExtractionOverview(
      [
        row("a"),
        row("b", { extractionStatus: "complete", extractionData: W2_DATA }),
        row("c", { docType: "other" }),
        row("d", { extractionStatus: "complete", extractionData: LEGACY_W2 }),
      ],
      NOW
    );
    expect(displayById.a?.kind).toBe("not_extracted");
    expect(displayById.b?.kind).toBe("extracted_unverified");
    expect(displayById.c?.kind).toBe("na");
    expect(displayById.d?.kind).toBe("extracted_outdated");
    expect(plan.missing).toEqual(["a"]);
    expect(plan.outdated).toEqual(["d"]);
  });
});
