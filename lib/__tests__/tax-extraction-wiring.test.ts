import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  extractionBasisGaps,
  resolvePersonalTaxComputeInput,
  sum1099InterestIncome,
  sumItemizedDocInputs,
  sumW2Documents,
  toComputeDocument,
  type ComputeDocumentRow,
  type RawPersonalTaxComputeInput,
} from "@/lib/tax-compute-build";
import { computePersonalTaxReturn } from "@/lib/tax-compute";
import { serializeTaxComputeResult } from "@/lib/tax-compute-display";
import {
  AWAITING_VERIFICATION_STATUS,
  buildModelDocLine,
  isIdentifierKey,
  resolveTaxDocForCompute,
  stripForModel,
  TAX_EXTRACTION_POLICY,
} from "@/lib/tax-extraction-policy";
import { computePersonalFormPlan, computePersonalFormPlanBasis } from "@/lib/tax-form-plan";

// Pass 3 (document-extraction-status-and-review): the Forms / compute loaders read
// EFFECTIVE extraction values (verified-else-AI, labelled). These tests pin down
//   1. the safety property: legacy-shaped documents (the 8 live tax docs have no
//      schemaVersion and none of the new keys) produce EXACTLY the same TY2025
//      draft numbers as before pass 3, and
//   2. each deliberate number-changing switch, and the labelling around it.
// Everything is pure / mocked: no DB, no extraction.

// ── Legacy-shaped fixtures (key shapes copied from the live 2026-10-02 query; values synthetic) ──

const NO_CORRECTIONS = { extractionCorrections: null, extractionConfirmedAt: null };

const legacyW2Eric: ComputeDocumentRow = {
  id: "w2-eric",
  docType: "w2",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: {
    docType: "w2",
    summary: "W-2 Rippling PEO",
    data: {
      taxYear: 2025,
      employerName: "Rippling PEO",
      employerEIN: "12-3456789",
      wagesCents: 18616026,
      federalWithheldCents: 4095831,
      stateWithheldCents: 1112390,
      socialSecurityWagesCents: 17600000,
      medicareWagesCents: 18616026,
    },
  },
  ...NO_CORRECTIONS,
};
const legacyW2Eva: ComputeDocumentRow = {
  id: "w2-eva",
  docType: "w2",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: {
    docType: "w2",
    summary: "W-2 Seacoast",
    data: {
      taxYear: 2025,
      employerName: "Seacoast Mushrooms",
      employerEIN: "98-7654321",
      wagesCents: 4330900,
      federalWithheldCents: 420203,
      stateWithheldCents: 194513,
      socialSecurityWagesCents: 4330900,
      medicareWagesCents: 4330900,
    },
  },
  ...NO_CORRECTIONS,
};
const legacy1099Int: ComputeDocumentRow = {
  id: "1099-td",
  docType: "1099",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: {
    docType: "1099",
    summary: "1099-INT TD Bank",
    data: {
      taxYear: 2025,
      formVariant: "1099-INT",
      payerName: "TD Bank",
      payerEIN: "22-1234567",
      amountCents: 112432,
      federalWithheldCents: 1500,
    },
  },
  ...NO_CORRECTIONS,
};
const legacy1099Div: ComputeDocumentRow = {
  id: "1099-rh",
  docType: "1099",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: {
    docType: "1099",
    summary: "Robinhood consolidated",
    data: {
      taxYear: 2025,
      formVariant: "1099-DIV",
      payerName: "Robinhood",
      payerEIN: null,
      amountCents: 358,
      federalWithheldCents: null,
    },
  },
  ...NO_CORRECTIONS,
};
// The live 1098 is stored with the mortgage-STATEMENT shape (five other keys null).
const legacy1098: ComputeDocumentRow = {
  id: "1098-pennymac",
  docType: "mortgage_interest",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: {
    docType: "mortgage_statement",
    summary: "PennyMac 1098",
    data: {
      servicerName: "PennyMac",
      loanNumber: "1234",
      principalBalanceCents: 37787263,
      interestCents: 1888269,
      propertyAddress: "27 Old Barry Rd",
      interestRate: null,
      monthlyPaymentCents: null,
      escrowBalanceCents: null,
      nextPaymentDate: null,
      principalCents: null,
    },
  },
  ...NO_CORRECTIONS,
};
// A legacy "other"-shaped property tax bill: data is always {}.
const legacyPropertyTax: ComputeDocumentRow = {
  id: "pt-legacy",
  docType: "property_tax",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: { docType: "other", summary: "Property tax bill", data: {} },
  ...NO_CORRECTIONS,
};
const legacyBankStatement: ComputeDocumentRow = {
  id: "bs-1",
  docType: "bank_statement",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: { docType: "bank_statement", summary: "Jan", data: { endingBalanceCents: 1 } },
  ...NO_CORRECTIONS,
};

const LEGACY_ROWS = [
  legacyW2Eric,
  legacyW2Eva,
  legacy1099Int,
  legacy1099Div,
  legacy1098,
  legacyPropertyTax,
  legacyBankStatement,
];

function raw(documents: ReturnType<typeof toComputeDocument>[]): RawPersonalTaxComputeInput {
  return {
    taxYear: 2025,
    personalDocuments: documents,
    paystubs: [],
    taxQuestions: [
      { key: "estimated_taxes_2025", answer: "Yes", skippedReason: null },
      { key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null },
    ],
    mileageEntries: [],
    ekConsultingGlIncomeTotal: new Decimal(50000),
    ekConsultingGlExpenseTotal: new Decimal(10000),
  };
}

/** What the resolvers received BEFORE pass 3: the raw stored row, no effective-data step, no provenance. */
function preRows(rows: ComputeDocumentRow[]) {
  return rows.map((r) => ({
    id: r.id,
    docType: r.docType,
    taxYear: r.taxYear,
    extractionStatus: r.extractionStatus,
    extractionData: r.extractionData,
  }));
}

// ── 1. Legacy-shaped documents: numbers unchanged ─────────────────────────────

describe("legacy-shaped documents through the loader boundary (regression: numbers unchanged)", () => {
  it("effective data handed to the resolvers is deep-equal to the stored legacy data", () => {
    for (const row of LEGACY_ROWS) {
      const doc = toComputeDocument(row);
      expect(doc.extractionData, row.id).toEqual(row.extractionData);
      expect(doc.extractionStatus, row.id).toBe("complete");
    }
  });

  it("legacy W-2 / 1099 / 1098 rows are flagged older-format and unverified; bank statements are untouched", () => {
    const byId = Object.fromEntries(LEGACY_ROWS.map((r) => [r.id, toComputeDocument(r)]));
    for (const id of ["w2-eric", "w2-eva", "1099-td", "1099-rh", "1098-pennymac", "pt-legacy"]) {
      expect(byId[id]?.legacyFormat, id).toBe(true);
      expect(byId[id]?.verified, id).toBe(false);
    }
    expect(byId["bs-1"]?.legacyFormat).toBe(false);
  });

  it("wages, withholding, interest, mortgage interest and property tax are exactly the pre-pass-3 values", () => {
    const resolved = resolvePersonalTaxComputeInput(raw(LEGACY_ROWS.map((r) => toComputeDocument(r))));
    const input = resolved.input;
    expect(input.wages.toString()).toBe(new Decimal(18616026 + 4330900).div(100).toString());
    expect(input.medicareWages.toString()).toBe(new Decimal(18616026 + 4330900).div(100).toString());
    // only the 1099-INT interest counts; the Robinhood DIV doc stays excluded
    expect(input.interestIncome.toString()).toBe(new Decimal(112432).div(100).toString());
    expect(input.federalWithholdingCents).toBe(4095831 + 420203 + 1500);
    expect(input.ctWithholdingCents).toBe(1112390 + 194513);
    expect(input.ctIncomeTaxWithheldCents).toBe(1112390 + 194513);
    expect(input.mortgageInterestCents).toBe(1888269);
    expect(input.propertyTaxCents).toBe(0); // legacy bill has no paidInTaxYearCents
  });

  it("the full TY2025 draft is identical to what the pre-pass-3 wiring produced (golden)", () => {
    const viaLoader = resolvePersonalTaxComputeInput(raw(LEGACY_ROWS.map((r) => toComputeDocument(r))));
    // Pre-pass-3 wiring: raw rows, no provenance. The resolvers' legacy paths are the
    // same code, so equality of the serialized draft proves the loader step is neutral.
    const pre = resolvePersonalTaxComputeInput(
      raw(preRows(LEGACY_ROWS) as ReturnType<typeof toComputeDocument>[])
    );
    expect(JSON.stringify(serializeTaxComputeResult(computePersonalTaxReturn(viaLoader.input)))).toBe(
      JSON.stringify(serializeTaxComputeResult(computePersonalTaxReturn(pre.input)))
    );
    // Same inputs field by field (Decimal compared by string).
    for (const key of Object.keys(pre.input) as (keyof typeof pre.input)[]) {
      expect(String(viaLoader.input[key]), String(key)).toBe(String(pre.input[key]));
    }
  });

  it("the only difference for legacy docs is ADDED labelling gap notes (unverified + older format), never a number", () => {
    const viaLoader = resolvePersonalTaxComputeInput(raw(LEGACY_ROWS.map((r) => toComputeDocument(r))));
    const pre = resolvePersonalTaxComputeInput(
      raw(preRows(LEGACY_ROWS) as ReturnType<typeof toComputeDocument>[])
    );
    // Every pre-existing note except the reworded property-tax one is still present.
    const preText = pre.buildGaps.filter((g) => !g.includes("property_tax"));
    for (const g of preText) expect(viaLoader.buildGaps).toContain(g);
    // (A document with no provenance flag already counted as unverified, so those notes
    // exist on both sides; the older-format notes are what the loader boundary adds.)
    expect(viaLoader.buildGaps.join("\n")).toContain("unverified AI extractions");
    const added = viaLoader.buildGaps.filter((g) => !pre.buildGaps.includes(g));
    const joined = added.join("\n");
    expect(joined).toContain("older extraction format");
    expect(joined).toContain("Rippling PEO");
    expect(joined).toContain("TD Bank");
    expect(joined).toContain("PennyMac");
  });

  it("Forms readiness for legacy docs: same haveData as before for every line except the property-tax-dependent ones", () => {
    const docs = LEGACY_ROWS.filter((r) => r.docType !== "bank_statement").map((r) => {
      const t = resolveTaxDocForCompute(r);
      return {
        docType: r.docType,
        extractionStatus: t.extractionStatus,
        extractionData: t.extractionData,
        verified: t.verified,
      };
    });
    const oldDocs = LEGACY_ROWS.filter((r) => r.docType !== "bank_statement").map((r) => ({
      docType: r.docType,
      extractionStatus: r.extractionStatus,
      extractionData: r.extractionData,
    }));
    const base = {
      questions: [],
      ekConsultingPL: null,
      suddenValleyPL: null,
      ekConsultingMileageCount: 0,
      solarLoanOriginalCostCents: null,
      donationCount: 0,
      ekConsultingFixedAssetCount: 0,
      suddenValleyBuildingAssetCount: 0,
    };
    const a = computePersonalFormPlan({ ...base, documents: docs }).flatMap((f) => f.fields);
    const b = computePersonalFormPlan({ ...base, documents: oldDocs }).flatMap((f) => f.fields);
    expect(a).toEqual(b); // loader boundary is neutral for the readiness plan
    const basis = computePersonalFormPlanBasis({ ...base, documents: docs });
    expect(basis["Wages (line 1a)"]).toBe("unverified");
    expect(basis["Interest income (line 2b)"]).toBe("unverified");
    // legacy bill has no paid amount -> property-tax lines are missing (deliberate switch 1)
    expect(basis["State/local taxes (line 5e)"]).toBe("missing");
  });
});

// ── 2. Corrections / verification flow through the loader ─────────────────────

describe("effective values: corrections and verification", () => {
  const confirmedAt = new Date("2026-10-02T12:00:00Z");

  it("an owner correction overrides the AI value, including a corrected null; the AI value is not mutated", () => {
    const row: ComputeDocumentRow = {
      ...legacyW2Eric,
      extractionCorrections: {
        version: 1,
        fields: {
          wagesCents: { value: 19000000, aiValue: 18616026, correctedAt: "x", correctedById: "u" },
          federalWithheldCents: { value: null, aiValue: 4095831, correctedAt: "x", correctedById: "u" },
        },
        events: [],
      },
      extractionConfirmedAt: confirmedAt,
    };
    const before = JSON.stringify(row.extractionData);
    const doc = toComputeDocument(row);
    const sum = sumW2Documents([doc], 2025);
    expect(sum.wagesCents).toBe(19000000);
    expect(sum.federalWithheldCents).toBe(0); // corrected to blank
    expect(doc.verified).toBe(true);
    expect(JSON.stringify(row.extractionData)).toBe(before);
  });

  it("a verified doc produces no 'unverified' note; an unverified one does", () => {
    const verifiedRow: ComputeDocumentRow = { ...legacyW2Eric, extractionConfirmedAt: confirmedAt };
    const verified = resolvePersonalTaxComputeInput(raw([toComputeDocument(verifiedRow)]));
    expect(verified.buildGaps.some((g) => g.includes("unverified AI extractions"))).toBe(false);
    const unverified = resolvePersonalTaxComputeInput(raw([toComputeDocument(legacyW2Eric)]));
    expect(unverified.buildGaps.some((g) => g.includes("1 of 1 W-2 document(s)") && g.includes("Rippling PEO"))).toBe(
      true
    );
  });

  it("a verified, current-schema document produces no labelling notes at all", () => {
    const current: ComputeDocumentRow = {
      id: "w2-current",
      docType: "w2",
      taxYear: 2025,
      extractionStatus: "complete",
      extractionData: {
        schemaVersion: 2,
        docType: "w2",
        summary: "W-2",
        data: {
          employerName: "Acme",
          wagesCents: 5000000,
          federalWithheldCents: 500000,
          medicareWagesCents: 5000000,
          stateLines: [{ stateCode: "CT", stateWithheldCents: 200000 }],
        },
      },
      extractionCorrections: null,
      extractionConfirmedAt: confirmedAt,
    };
    const sum = sumW2Documents([toComputeDocument(current)], 2025);
    expect(extractionBasisGaps(sum, sum1099InterestIncome([], 2025), sumItemizedDocInputs([], 2025))).toEqual([]);
  });

  it("the policy constant defaults to verified-else-AI", () => {
    expect(TAX_EXTRACTION_POLICY).toBe("verified_else_ai");
  });
});

// ── 3. Policy: verified_only drops unverified documents, and says so ──────────

describe("TAX_EXTRACTION_POLICY = verified_only (the one-constant flip)", () => {
  const confirmedAt = new Date("2026-10-02T12:00:00Z");

  it("hands unverified tax docs to the resolvers with a status they never accept; verified ones unchanged", () => {
    const un = resolveTaxDocForCompute(legacyW2Eric, "verified_only");
    expect(un.excludedByPolicy).toBe(true);
    expect(un.extractionStatus).toBe(AWAITING_VERIFICATION_STATUS);
    const ver = resolveTaxDocForCompute({ ...legacyW2Eric, extractionConfirmedAt: confirmedAt }, "verified_only");
    expect(ver.excludedByPolicy).toBe(false);
    expect(ver.extractionStatus).toBe("complete");
    // non-tax docs (bank statements) are never policy-excluded
    expect(resolveTaxDocForCompute(legacyBankStatement, "verified_only").excludedByPolicy).toBe(false);
  });

  it("numbers drop to only the verified docs and a gap note names each left-out document", () => {
    const rows: ComputeDocumentRow[] = [{ ...legacyW2Eric, extractionConfirmedAt: confirmedAt }, legacyW2Eva];
    const resolved = resolvePersonalTaxComputeInput(raw(rows.map((r) => toComputeDocument(r, "verified_only"))));
    expect(resolved.input.wages.toString()).toBe(new Decimal(18616026).div(100).toString());
    expect(resolved.buildGaps.some((g) => g.includes("w2-eva") && g.includes("verified-only"))).toBe(true);
    expect(resolved.buildGaps.some((g) => g.includes("w2-eric") && g.includes("verified-only"))).toBe(false);
    // and under verified_else_ai both are used
    const both = resolvePersonalTaxComputeInput(raw(rows.map((r) => toComputeDocument(r, "verified_else_ai"))));
    expect(both.input.wages.toString()).toBe(new Decimal(18616026 + 4330900).div(100).toString());
  });

  it("Forms readiness: an unverified doc is simply missing under verified_only", () => {
    const t = resolveTaxDocForCompute(legacyW2Eric, "verified_only");
    const basis = computePersonalFormPlanBasis({
      documents: [
        { docType: "w2", extractionStatus: t.extractionStatus, extractionData: t.extractionData, verified: t.verified },
      ],
      questions: [],
      ekConsultingPL: null,
      suddenValleyPL: null,
      ekConsultingMileageCount: 0,
      solarLoanOriginalCostCents: null,
      donationCount: 0,
      ekConsultingFixedAssetCount: 0,
      suddenValleyBuildingAssetCount: 0,
    });
    expect(basis["Wages (line 1a)"]).toBe("missing");
  });
});

// ── 4. Deliberate switch 2: 1099 interest box 1 ───────────────────────────────

describe("1099 interest: int_box1Cents is preferred when present (switch 2)", () => {
  const doc = (data: Record<string, unknown>, id = "d"): ReturnType<typeof toComputeDocument> =>
    toComputeDocument({
      id,
      docType: "1099",
      taxYear: 2025,
      extractionStatus: "complete",
      extractionData: { schemaVersion: 2, docType: "1099", summary: "", data },
      extractionCorrections: null,
      extractionConfirmedAt: null,
    });

  it("a consolidated 1099 with int_box1Cents contributes its box 1 interest (it was excluded before)", () => {
    const r = sum1099InterestIncome([doc({ formVariant: "consolidated", payerName: "Robinhood", amountCents: 358, int_box1Cents: 1234 })], 2025);
    expect(r.interestIncomeCents).toBe(1234);
    expect(r.excludedNonInterestDocs).toHaveLength(0);
  });

  it("box 1 wins over the legacy headline amount for a 1099-INT variant, and the override is reported", () => {
    const r = sum1099InterestIncome(
      [doc({ formVariant: "1099-INT", payerName: "TD Bank", amountCents: 150000, int_box1Cents: 112432 })],
      2025
    );
    expect(r.interestIncomeCents).toBe(112432);
    expect(r.box1OverridesLegacyAmountDocs).toEqual([
      { id: "d", label: "TD Bank", box1Cents: 112432, amountCents: 150000 },
    ]);
  });

  it("box 3 (US savings bond interest) is NOT added to line 2b (plan Q3)", () => {
    const r = sum1099InterestIncome([doc({ formVariant: "1099-INT", int_box1Cents: 10000, int_box3Cents: 5000 })], 2025);
    expect(r.interestIncomeCents).toBe(10000);
  });

  it("withholding: box 4 when present; otherwise the legacy total only for a 1099-INT variant", () => {
    const withBox4 = sum1099InterestIncome(
      [doc({ formVariant: "consolidated", int_box1Cents: 100, int_box4Cents: 25, federalWithheldCents: 999 })],
      2025
    );
    expect(withBox4.federalWithheldCents).toBe(25);
    const consolidatedNoBox4 = sum1099InterestIncome(
      [doc({ formVariant: "consolidated", int_box1Cents: 100, federalWithheldCents: 999 })],
      2025
    );
    expect(consolidatedNoBox4.federalWithheldCents).toBe(0);
    const intNoBox4 = sum1099InterestIncome(
      [doc({ formVariant: "1099-INT", int_box1Cents: 100, federalWithheldCents: 40 })],
      2025
    );
    expect(intNoBox4.federalWithheldCents).toBe(40);
  });

  it("no int_box1Cents: the legacy rule is unchanged (1099-INT counts, DIV excluded)", () => {
    const r = sum1099InterestIncome(
      [doc({ formVariant: "1099-INT", amountCents: 500 }, "a"), doc({ formVariant: "1099-DIV", amountCents: 9 }, "b")],
      2025
    );
    expect(r.interestIncomeCents).toBe(500);
    expect(r.excludedNonInterestDocs.map((x) => x.id)).toEqual(["b"]);
  });

  it("an owner correction of int_box1Cents flows through the effective data", () => {
    const r = sum1099InterestIncome(
      [
        toComputeDocument({
          id: "c",
          docType: "1099",
          taxYear: 2025,
          extractionStatus: "complete",
          extractionData: { schemaVersion: 2, docType: "1099", summary: "", data: { formVariant: "1099-INT", int_box1Cents: 100 } },
          extractionCorrections: { version: 1, fields: { int_box1Cents: { value: 777, aiValue: 100 } }, events: [] },
          extractionConfirmedAt: new Date(),
        }),
      ],
      2025
    );
    expect(r.interestIncomeCents).toBe(777);
  });
});

// ── 5. Deliberate switch 3: W-2 CT withholding by state code ──────────────────

describe("W-2 CT withholding filters on stateCode once state lines exist (switch 3)", () => {
  const w2 = (data: Record<string, unknown>) =>
    toComputeDocument({
      id: "w",
      docType: "w2",
      taxYear: 2025,
      extractionStatus: "complete",
      extractionData: { schemaVersion: 2, docType: "w2", summary: "", data: { employerName: "Acme", wagesCents: 1000000, ...data } },
      extractionCorrections: null,
      extractionConfirmedAt: null,
    });

  it("only CT lines are summed; other states and unreadable codes are excluded and reported", () => {
    const sum = sumW2Documents(
      [
        w2({
          stateLines: [
            { stateCode: "CT", stateWithheldCents: 30000 },
            { stateCode: "NY", stateWithheldCents: 10000 },
            { stateCode: null, stateWithheldCents: 5000 },
          ],
        }),
      ],
      2025
    );
    expect(sum.ctWithheldCents).toBe(30000);
    expect(sum.nonCtStateLineDocs).toEqual([{ id: "w", label: "Acme", lineCount: 2, withheldCents: 15000 }]);
  });

  it("state lines with no CT line give $0 CT withholding (not the whole box 17)", () => {
    const sum = sumW2Documents([w2({ stateLines: [{ stateCode: "NY", stateWithheldCents: 10000 }] })], 2025);
    expect(sum.ctWithheldCents).toBe(0);
  });

  it("state lines win over a stale flat stateWithheldCents", () => {
    const sum = sumW2Documents(
      [w2({ stateWithheldCents: 99999, stateLines: [{ stateCode: "CT", stateWithheldCents: 1111 }] })],
      2025
    );
    expect(sum.ctWithheldCents).toBe(1111);
  });

  it("legacy documents (no state lines) keep the assumption: flat stateWithheldCents is CT", () => {
    const sum = sumW2Documents([w2({ stateWithheldCents: 77777 })], 2025);
    expect(sum.ctWithheldCents).toBe(77777);
    expect(sum.nonCtStateLineDocs).toEqual([]);
  });

  it("a non-CT note reaches buildGaps", () => {
    const resolved = resolvePersonalTaxComputeInput(
      raw([w2({ stateLines: [{ stateCode: "NY", stateWithheldCents: 10000 }] })])
    );
    expect(resolved.buildGaps.some((g) => g.includes("not Connecticut") && g.includes("Acme"))).toBe(true);
  });
});

// ── 6. Deliberate switch 1 end to end: property tax ───────────────────────────

describe("property tax paid-in-year reaches the draft input (switch 1)", () => {
  it("an owner-entered paidInTaxYearCents becomes propertyTaxCents; a bill alone stays $0", () => {
    const withPaid = toComputeDocument({
      id: "pt",
      docType: "property_tax",
      taxYear: 2025,
      extractionStatus: "complete",
      extractionData: { schemaVersion: 2, docType: "property_tax", summary: "", data: { totalTaxBilledCents: 900000, paidInTaxYearCents: null } },
      extractionCorrections: { version: 1, fields: { paidInTaxYearCents: { value: 450000, aiValue: null } }, events: [] },
      extractionConfirmedAt: new Date(),
    });
    expect(resolvePersonalTaxComputeInput(raw([withPaid])).input.propertyTaxCents).toBe(450000);
    const billOnly = toComputeDocument({
      id: "pt2",
      docType: "property_tax",
      taxYear: 2025,
      extractionStatus: "complete",
      extractionData: { schemaVersion: 2, docType: "property_tax", summary: "", data: { totalTaxBilledCents: 900000, paidInTaxYearCents: null } },
      extractionCorrections: null,
      extractionConfirmedAt: null,
    });
    expect(resolvePersonalTaxComputeInput(raw([billOnly])).input.propertyTaxCents).toBe(0);
  });
});

// ── 7. generateTaxReview: effective data, no EIN-like keys ────────────────────

describe("buildModelDocLine (what generateTaxReview sends to the model)", () => {
  it("never includes EIN-like or other identifier keys, even nested, and drops nulls", () => {
    const line = buildModelDocLine(legacyW2Eric);
    expect(line).not.toContain("employerEIN");
    expect(line).not.toContain("12-3456789");
    expect(line).toContain("wagesCents");
    const nested = stripForModel({
      payerEIN: "22-1234567",
      statePayerId: "x",
      keep: 1,
      nothing: null,
      stateLines: [{ stateCode: "CT", stateEmployerId: "9", stateWithheldCents: 5 }],
      parcelId: "abc",
      loanNumber: "1234",
    });
    expect(nested).toEqual({ keep: 1, stateLines: [{ stateCode: "CT", stateWithheldCents: 5 }] });
  });

  it("identifier-key detection catches the registry's EIN keys and not ordinary keys", () => {
    for (const k of ["employerEIN", "payerEIN", "entityEIN", "recipientTIN", "ssn", "taxpayerSSN", "stateEmployerId", "parcelId", "loanNumber"]) {
      expect(isIdentifierKey(k), k).toBe(true);
    }
    for (const k of ["wagesCents", "federalWithheldCents", "taxYear", "payerName", "formVariant", "origination"]) {
      expect(isIdentifierKey(k), k).toBe(false);
    }
  });

  it("uses EFFECTIVE values and labels the basis", () => {
    const corrected: ComputeDocumentRow = {
      ...legacyW2Eric,
      extractionCorrections: { version: 1, fields: { wagesCents: { value: 123456, aiValue: 18616026 } }, events: [] },
      extractionConfirmedAt: new Date(),
    };
    const line = buildModelDocLine(corrected);
    expect(line).toContain("123456");
    expect(line).not.toContain('"wagesCents":18616026');
    expect(line).toContain('"wagesCents":123456');
    expect(line).toContain("verified by the owner");
    expect(line).toContain("older extraction format");
    expect(buildModelDocLine(legacyW2Eva)).toContain("unverified AI extraction");
  });

  it("does not label non-tax documents, handles missing extraction, and withholds unverified values in verified_only", () => {
    expect(buildModelDocLine(legacyBankStatement)).not.toContain("unverified");
    expect(buildModelDocLine({ docType: "w2", extractionStatus: null, extractionData: null })).toBe(
      "- w2: uploaded (not extracted)"
    );
    const withheld = buildModelDocLine(legacyW2Eric, "verified_only");
    expect(withheld).toContain("withheld");
    expect(withheld).not.toContain("wagesCents");
  });
});

// ── 7. A re-extract that never finished must not drop a good doc out of the draft ──

describe("unfinished re-extract (status stuck processing/failed, stored data still usable)", () => {
  const confirmedAt = new Date("2026-10-02T12:00:00Z");

  it("a stuck row with usable data is used as complete, flagged, and its numbers stay in the draft", () => {
    for (const status of ["processing", "failed"]) {
      const stuck: ComputeDocumentRow = { ...legacyW2Eric, extractionStatus: status };
      const t = resolveTaxDocForCompute(stuck);
      expect(t.extractionStatus, status).toBe("complete");
      expect(t.reextractIncomplete, status).toBe(true);
      expect(t.extractionData, status).toEqual(legacyW2Eric.extractionData);

      const withStuck = resolvePersonalTaxComputeInput(raw([toComputeDocument(stuck), toComputeDocument(legacyW2Eva)]));
      const without = resolvePersonalTaxComputeInput(raw([toComputeDocument(legacyW2Eric), toComputeDocument(legacyW2Eva)]));
      // numbers identical to the same doc sitting at "complete"
      for (const key of Object.keys(without.input) as (keyof typeof without.input)[]) {
        expect(String(withStuck.input[key]), `${status}:${String(key)}`).toBe(String(without.input[key]));
      }
      expect(withStuck.input.wages.toString()).toBe(new Decimal(18616026 + 4330900).div(100).toString());
      // ...plus a gap note saying the last re-extract did not finish
      const note = withStuck.buildGaps.filter((g) => g.includes("last re-extract did not finish"));
      expect(note, status).toHaveLength(1);
      expect(note[0]).toContain("w2-eric");
      expect(without.buildGaps.some((g) => g.includes("did not finish"))).toBe(false);
    }
  });

  it("is treated as unverified even if a verification timestamp is present (conservative)", () => {
    const t = resolveTaxDocForCompute({ ...legacyW2Eric, extractionStatus: "processing", extractionConfirmedAt: confirmedAt });
    expect(t.verified).toBe(false);
    expect(t.reextractIncomplete).toBe(true);
  });

  it("Forms readiness plan keeps the doc's lines (status handed on is complete)", () => {
    const t = resolveTaxDocForCompute({ ...legacyW2Eric, extractionStatus: "processing" });
    const base = {
      questions: [],
      ekConsultingPL: null,
      suddenValleyPL: null,
      ekConsultingMileageCount: 0,
      solarLoanOriginalCostCents: null,
      donationCount: 0,
      ekConsultingFixedAssetCount: 0,
      suddenValleyBuildingAssetCount: 0,
    };
    const stuck = computePersonalFormPlan({
      ...base,
      documents: [{ docType: "w2", extractionStatus: t.extractionStatus, extractionData: t.extractionData, verified: t.verified }],
    }).flatMap((f) => f.fields);
    const done = computePersonalFormPlan({
      ...base,
      documents: [{ docType: "w2", extractionStatus: "complete", extractionData: legacyW2Eric.extractionData, verified: false }],
    }).flatMap((f) => f.fields);
    expect(stuck).toEqual(done);
  });

  it("is NOT used when the stored data is unusable (first extraction in flight, parse stub, all-null read)", () => {
    const rows: ComputeDocumentRow[] = [
      { ...legacyW2Eric, extractionStatus: "processing", extractionData: null },
      { ...legacyW2Eric, extractionStatus: "failed", extractionData: { docType: "other", summary: "Extraction failed.", data: {} } },
      {
        ...legacyW2Eric,
        extractionStatus: "processing",
        extractionData: { docType: "w2", summary: "W-2", data: { taxYear: 2025, wagesCents: null, federalWithheldCents: null } },
      },
    ];
    for (const r of rows) {
      const t = resolveTaxDocForCompute(r);
      expect(t.reextractIncomplete).toBe(false);
      expect(t.extractionStatus).toBe(r.extractionStatus);
    }
  });

  it("never touches a doc whose status is complete, null, pending or skipped, nor non-tax docs", () => {
    for (const status of ["complete", null, "pending", "skipped"]) {
      const t = resolveTaxDocForCompute({ ...legacyW2Eric, extractionStatus: status });
      expect(t.reextractIncomplete, String(status)).toBe(false);
      expect(t.extractionStatus, String(status)).toBe(status);
    }
    const bs = resolveTaxDocForCompute({ ...legacyBankStatement, extractionStatus: "processing" });
    expect(bs.reextractIncomplete).toBe(false);
    expect(bs.extractionStatus).toBe("processing");
  });

  it("verified_only policy: a stuck unverified doc is excluded like any unverified doc (and says so)", () => {
    const t = resolveTaxDocForCompute({ ...legacyW2Eric, extractionStatus: "processing" }, "verified_only");
    expect(t.excludedByPolicy).toBe(true);
    expect(t.extractionStatus).toBe(AWAITING_VERIFICATION_STATUS);
  });

  it("the model prompt line labels it", () => {
    expect(buildModelDocLine({ ...legacyW2Eric, extractionStatus: "processing" })).toContain(
      "last re-extract did not finish"
    );
    expect(buildModelDocLine(legacyW2Eric)).not.toContain("did not finish");
  });

  it("REGRESSION: the 8 legacy-shaped docs (all status complete) serialize to exactly the same draft, with no 'did not finish' note", () => {
    const eight = [
      legacyW2Eric,
      legacyW2Eva,
      { ...legacyW2Eva, id: "w2-3" },
      { ...legacyW2Eric, id: "w2-4" },
      legacy1099Int,
      legacy1099Div,
      { ...legacy1099Int, id: "1099-3" },
      legacy1098,
    ] satisfies ComputeDocumentRow[];
    const viaLoader = resolvePersonalTaxComputeInput(raw(eight.map((r) => toComputeDocument(r))));
    const pre = resolvePersonalTaxComputeInput(raw(preRows(eight) as ReturnType<typeof toComputeDocument>[]));
    expect(JSON.stringify(serializeTaxComputeResult(computePersonalTaxReturn(viaLoader.input)))).toBe(
      JSON.stringify(serializeTaxComputeResult(computePersonalTaxReturn(pre.input)))
    );
    for (const key of Object.keys(pre.input) as (keyof typeof pre.input)[]) {
      expect(String(viaLoader.input[key]), String(key)).toBe(String(pre.input[key]));
    }
    expect(viaLoader.buildGaps.some((g) => g.includes("did not finish"))).toBe(false);
    for (const r of eight) {
      const t = resolveTaxDocForCompute(r);
      expect(t.reextractIncomplete, r.id).toBe(false);
      expect(t.extractionStatus, r.id).toBe("complete");
      expect(t.extractionData, r.id).toEqual(r.extractionData);
    }
  });
});
