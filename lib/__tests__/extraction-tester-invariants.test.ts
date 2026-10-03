import { describe, it, expect } from "vitest";
import {
  EXTRACTABLE_DOC_TYPES,
  MAX_BULK_EXTRACT,
  describeExtraction,
  meetsExtractionExpectation,
  planBulkExtraction,
  type DescribeExtractionInput,
} from "@/lib/document-extraction-state";
import { STALE_PROCESSING_MS } from "@/lib/statement-import";
import { buildCorrectionFields, draftFromValue } from "@/lib/tax-review-form";
import {
  getTaxSchema,
  normalizeTaxExtraction,
  schemaTypeForDocType,
  validateCorrections,
} from "@/lib/tax-extraction-schema";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";

// Tester-added invariants (document-extraction-status-and-review). Pure; no DB, no SDK.
// They cross-check modules that the Coder tested one at a time:
//   - the CLIENT bulk plan and the SERVER expect-guard must agree (otherwise the bulk bar
//     lists documents the server then refuses, or worse, the reverse),
//   - Confirm-with-no-edit on a legacy-shaped document (the 8 live tax docs) must not
//     create any correction (a spurious "blank" correction would silently change numbers),
//   - the SSN scrub holds across every free-text slot of every tax schema.

const NOW = Date.parse("2026-10-02T12:00:00Z");
const FRESH = new Date(NOW - 60_000);
const STALE = new Date(NOW - STALE_PROCESSING_MS - 1000);

// Key shapes copied from the live 2026-10-02 read-only query (values synthetic).
const LIVE_SHAPES = {
  w2: {
    docType: "w2",
    summary: "W-2",
    data: {
      taxYear: 2025,
      wagesCents: 1000000,
      employerEIN: "12-3456789",
      employerName: "Acme PEO 1, INC.",
      medicareWagesCents: 1000000,
      stateWithheldCents: 50000,
      federalWithheldCents: 120000,
      socialSecurityWagesCents: 1000000,
    },
  },
  "1099": {
    docType: "1099",
    summary: "1099-INT",
    data: {
      taxYear: 2025,
      payerEIN: "98-7654321",
      payerName: "Some Bank, N.A.",
      amountCents: 12345,
      formVariant: "1099-INT",
      federalWithheldCents: 0,
    },
  },
  mortgage_interest: {
    docType: "mortgage_statement",
    period: "2025",
    summary: "1098",
    data: {
      loanNumber: "1234",
      interestRate: null,
      servicerName: "Loan Servicer, LLC",
      interestCents: 1888269,
      principalCents: null,
      nextPaymentDate: null,
      propertyAddress: "27 Old Barry Rd",
      escrowBalanceCents: null,
      monthlyPaymentCents: null,
      principalBalanceCents: 37787263,
    },
  },
} as const;

describe("live legacy shapes: Confirm-with-no-edit creates no correction", () => {
  for (const [docType, ai] of Object.entries(LIVE_SHAPES)) {
    it(`${docType}: unchanged drafts build an empty override set that validates`, () => {
      const schemaType = schemaTypeForDocType(docType);
      expect(schemaType).not.toBeNull();
      const schema = getTaxSchema(schemaType!);
      const drafts = Object.fromEntries(schema.fields.map((def) => [def.key, draftFromValue(def, ai.data[def.key as keyof typeof ai.data])]));
      const visible = new Set(schema.fields.map((f) => f.key));
      const built = buildCorrectionFields(schemaType!, drafts, ai.data, visible);
      expect(built.errors).toEqual({});
      expect(built.fields).toEqual({});
      expect(validateCorrections(schemaType!, built.fields)).toEqual({ ok: true, fields: {} });
    });

    it(`${docType}: effective data for an uncorrected legacy document is deep-equal to the stored data`, () => {
      const resolved = resolveTaxDocForCompute({
        docType,
        extractionStatus: "complete",
        extractionData: ai,
        extractionCorrections: null,
        extractionConfirmedAt: null,
      });
      expect(resolved.extractionData).toEqual(ai);
      expect(resolved.legacyFormat).toBe(true);
      expect(resolved.verified).toBe(false);
    });
  }
});

// ── client bulk plan <-> server expect guard agreement ─────────────────────────

const DATA_VARIANTS: Record<string, unknown> = {
  none: null,
  stub: { docType: "other", summary: "Could not parse extraction response.", data: { raw: "x" } },
  failedStub: { docType: "w2", summary: "Extraction failed.", data: {} },
  allNull: { docType: "w2", summary: "s", data: { wagesCents: null, federalWithheldCents: null, interestCents: null, amountCents: null } },
  legacy: { docType: "w2", summary: "s", data: { wagesCents: 100, federalWithheldCents: 10, amountCents: 5, interestCents: 7, formVariant: "1099-INT", totalTaxBilledCents: 9, ordinaryIncomeCents: 3 } },
  current: { docType: "w2", schemaVersion: 2, summary: "s", data: { wagesCents: 100, federalWithheldCents: 10, amountCents: 5, interestCents: 7, formVariant: "1099-INT", totalTaxBilledCents: 9, ordinaryIncomeCents: 3 } },
  statement: { docType: "bank_statement", summary: "s", data: { openingBalanceCents: 1 }, transactionRows: [{ a: 1 }] },
};

function* sweep(): Generator<DescribeExtractionInput & { id: string }> {
  let n = 0;
  const types = [...EXTRACTABLE_DOC_TYPES, "extension", "other", "paystub"];
  for (const docType of types)
    for (const extractionStatus of [null, "pending", "processing", "complete", "failed", "skipped"])
      for (const updatedAt of [FRESH, STALE])
        for (const dataKey of Object.keys(DATA_VARIANTS))
          for (const confirmed of [false, true])
            for (const correctionCount of [0, 2])
              for (const extractionError of [null, "boom"]) {
                yield {
                  id: `d${n++}`,
                  docType,
                  extractionStatus,
                  updatedAt,
                  extractionData: DATA_VARIANTS[dataKey],
                  extractionConfirmedAt: confirmed ? new Date(NOW) : null,
                  correctionCount,
                  extractionError,
                };
              }
}

describe("bulk plan vs server-side expect guard (full state sweep)", () => {
  const all = [...sweep()];

  it("sweep is large enough to be meaningful", () => {
    expect(all.length).toBeGreaterThan(5000);
  });

  it("every document the plan lists is accepted by the server guard for that mode", () => {
    const plan = planBulkExtraction(all, NOW);
    const byId = new Map(all.map((d) => [d.id, d]));
    for (const id of plan.missing) expect(meetsExtractionExpectation("unextracted", byId.get(id)!, NOW)).toBe(true);
    for (const id of plan.outdated) expect(meetsExtractionExpectation("outdated", byId.get(id)!, NOW)).toBe(true);
  });

  it("the plan never lists a verified, hand-corrected (outdated mode), statement, N/A or processing document", () => {
    const plan = planBulkExtraction(all, NOW);
    const byId = new Map(all.map((d) => [d.id, d]));
    for (const id of plan.missing) {
      const d = byId.get(id)!;
      const display = describeExtraction(d, NOW);
      expect(["not_extracted", "failed"]).toContain(display.kind);
      expect(["bank_statement", "statement", "extension", "other", "paystub"]).not.toContain(d.docType);
    }
    for (const id of plan.outdated) {
      const d = byId.get(id)!;
      // A confirmation only counts while the AI run is complete. (A verified document whose
      // in-flight re-extract died keeps extractionConfirmedAt with a non-complete status; the
      // plan may list it, and runExtraction's own verified gate then refuses it with no API call.)
      if (d.extractionStatus === "complete") expect(d.extractionConfirmedAt).toBeNull();
      expect(d.correctionCount).toBe(0);
      expect(describeExtraction(d, NOW).kind).toBe("extracted_outdated");
    }
  });

  it("the server guard refuses every verified or corrected document in outdated mode, and every document with usable data in unextracted mode", () => {
    for (const d of all) {
      const display = describeExtraction(d, NOW);
      if (meetsExtractionExpectation("outdated", d, NOW)) {
        if (d.extractionStatus === "complete") expect(d.extractionConfirmedAt).toBeNull();
        expect(d.correctionCount).toBe(0);
      }
      if (meetsExtractionExpectation("unextracted", d, NOW)) {
        expect(["not_extracted", "failed"]).toContain(display.kind);
      }
    }
  });

  it("bank statements are never Verified, whatever the stored confirmation says", () => {
    for (const d of all) {
      if (d.docType !== "bank_statement" && d.docType !== "statement") continue;
      expect(describeExtraction(d, NOW).kind).not.toBe("verified");
    }
  });

  it("a Review action is only ever offered when usable data exists (never for not_extracted / failed / na / processing)", () => {
    for (const d of all) {
      const display = describeExtraction(d, NOW);
      if (["not_extracted", "failed", "na", "processing", "skipped"].includes(display.kind)) {
        expect(display.actions).not.toContain("review");
        expect(display.actions).not.toContain("reextract");
      }
      // Only a never-run row offers a plain Run.
      if (display.actions.includes("run")) expect(display.kind).toBe("not_extracted");
      if (display.actions.includes("retry")) expect(display.kind).toBe("failed");
    }
  });

  it("the cap constant the bulk bar advertises is 25", () => {
    expect(MAX_BULK_EXTRACT).toBe(25);
  });
});

// ── SSN scrub across every free-text slot of every tax schema ──────────────────

describe("SSN-shaped text is removed from every text slot of every tax schema", () => {
  const SSN_FORMS = ["123-45-6789", "123456789", "SSN 123-45-6789 on file", "123-45-6789."];

  for (const schemaType of ["w2", "1099", "form_1098", "property_tax", "k1", "tax_return", "donation_receipt"] as const) {
    it(`${schemaType}: top-level text fields, list-row text columns and summary`, () => {
      const schema = getTaxSchema(schemaType);
      for (const ssn of SSN_FORMS) {
        const data: Record<string, unknown> = {};
        for (const def of schema.fields) {
          if (def.kind === "text") data[def.key] = `Name ${ssn}`;
          if (def.kind === "list") {
            data[def.key] = [
              Object.fromEntries((def.itemFields ?? []).map((i) => [i.key, i.kind === "text" ? `x ${ssn}` : i.kind === "money" ? 100 : null])),
            ];
          }
        }
        const out = normalizeTaxExtraction(schemaType, { summary: `Return for ${ssn}`, data });
        expect(JSON.stringify(out)).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
        for (const def of schema.fields) {
          if (def.kind === "text") expect(out.data[def.key]).toBeNull();
        }
      }
    });
  }

  it("a registry key whose name suggests an SSN/ITIN/last-4 does not exist in any schema", () => {
    for (const schemaType of ["w2", "1099", "form_1098", "property_tax", "k1", "tax_return", "donation_receipt"] as const) {
      for (const def of getTaxSchema(schemaType).fields) {
        expect(def.key).not.toMatch(/ssn|itin|socialSecurityNumber|taxpayerId|last4|tin$/i);
        for (const item of def.itemFields ?? []) expect(item.key).not.toMatch(/ssn|itin|socialSecurityNumber|last4|tin$/i);
      }
    }
  });
});
