// resolveFacts: the 1099 sales summary -> facts.income.brokerSales, and the open items for a summary that was
// never read (schedule-d-capture). Document data goes through resolveTaxDocForCompute exactly like the loader does.
import { describe, expect, it } from "vitest";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { parseTy2025Facts } from "@/lib/tax2025/facts";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { normalizeTaxExtraction } from "@/lib/tax-extraction-schema";
import { ERIC_ID, EVA_ID } from "@/lib/__tests__/tax2025-fixtures";
import { ROBINHOOD_2025_RAW } from "@/lib/__tests__/broker-summary-fixtures";

function raw(documents: RawDocument[]): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric" },
      { userId: EVA_ID, name: "Eva" },
    ],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name matches the entity name" },
    documents,
    planning: {
      filingStatus: "mfj",
      householdMembers: "none",
      evVehicle: "no",
      businessMileage: "no",
      homeOfficeEligibility: "no",
      homeOfficeSqft: null,
      solarCredit: null,
      donationsNone: true,
      fixedAssetsEkcNone: true,
      retirementContributionCents: null,
      estimatedPaymentsCombinedCents: null,
    },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}

/** A 1099 Document row as the loader hands it to the resolver: stored extraction + corrections -> effective data. */
function doc1099(id: string, extractionData: unknown, over: { corrections?: unknown; verified?: boolean; legacy?: boolean } = {}): RawDocument {
  const resolved = resolveTaxDocForCompute({
    docType: "1099",
    extractionStatus: "complete",
    extractionData,
    extractionCorrections: over.corrections ?? null,
    extractionConfirmedAt: over.verified === false ? null : new Date("2026-10-02T00:00:00Z"),
  });
  return {
    id,
    docType: "1099",
    taxYear: 2025,
    extractionStatus: resolved.extractionStatus,
    extractionData: resolved.extractionData,
    verified: resolved.verified,
    legacyFormat: resolved.legacyFormat,
    subjectType: "person",
    subjectUserId: ERIC_ID,
    documentName: null,
  };
}

const NEW_READ = normalizeTaxExtraction("1099", {
  ...ROBINHOOD_2025_RAW,
  data: {
    ...ROBINHOOD_2025_RAW.data,
    div_box1aCents: 238,
    div_box1bCents: 200,
    div_box2aCents: 0,
    int_box1Cents: 120,
    // the raw 1099-B boxes an older read may also have left in otherBoxes
    otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2287399 }],
  },
});

// The older read of the same document: variantsPresent mentions a 1099-B, bSummary was never read.
const OLD_READ = {
  docType: "1099",
  summary: "Consolidated 1099",
  data: {
    taxYear: 2025,
    formVariant: "consolidated",
    variantsPresent: ["1099-DIV", "1099-B"],
    payerName: "Robinhood Markets, Inc.",
    div_box1aCents: 238,
    div_box1bCents: 200,
    div_box2aCents: 0,
    int_box1Cents: 120,
    federalWithheldCents: 0,
    otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2287399 }],
  },
};

describe("resolveFacts: a 1099 whose sales summary was read", () => {
  const { facts, openItems } = resolveFacts(raw([doc1099("rh", NEW_READ)]));

  it("exposes one brokerSales entry per document with the category rows as read (integer cents, no sums)", () => {
    expect(facts.income.brokerSales).toHaveLength(1);
    const b = facts.income.brokerSales[0]!;
    expect(b).toMatchObject({ docId: "rh", summaryRead: true, signalled1099B: true, forms1099DaPresent: false, sec1256AggregateCents: 0, basis: "doc_verified", legacyFormat: false });
    expect(b.rows).toEqual([
      { form: "1099-B", box: "A", proceedsCents: 587231, costCents: 528550, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 599, gainLossCents: 59280 },
      { form: "1099-B", box: "D", proceedsCents: 1700168, costCents: 1203728, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 496440 },
    ]);
    expect(b.refs[0]).toMatchObject({ kind: "document", id: "rh" });
  });

  it("the old 1099-B otherBoxes of that document no longer feed other-income-boxes, and nothing asks for a re-read", () => {
    expect(facts.income.otherIncomeBoxes).toEqual([]);
    expect(openItems.some((o) => o.id === "other-income-boxes")).toBe(false);
    expect(openItems.some((o) => o.id.startsWith("broker-"))).toBe(false);
  });

  it("the interest and dividend reads of the same document are unchanged", () => {
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 120 });
    expect(facts.income.dividends[0]).toMatchObject({ box1aCents: 238, box1bCents: 200, box2aCents: 0 });
  });

  it("the facts object still validates against the zod schema", () => {
    expect(() => parseTy2025Facts(facts)).not.toThrow();
  });
});

describe("resolveFacts: a 1099 with a 1099-B signal but no sales summary (older read)", () => {
  const { facts, openItems } = resolveFacts(raw([doc1099("rh", { ...OLD_READ, schemaVersion: 2 })]));

  it("is kept with summaryRead false and raises the blocking re-read item", () => {
    const b = facts.income.brokerSales[0]!;
    expect(b).toMatchObject({ docId: "rh", summaryRead: false, signalled1099B: true, rows: [] });
    const item = openItems.find((o) => o.id === "broker-summary-unread:rh")!;
    expect(item.severity).toBe("blocking");
    expect(item.message).toMatch(/sales summary \(totals by Form 8949 category\) has not been read/);
    expect(item.action).toMatch(/Re-read this document with the new fields/);
    expect(item.refs[0]).toMatchObject({ kind: "document", id: "rh" });
  });

  it("the raw 1099-B boxes still reach other-income-boxes (unchanged behaviour for an unread document)", () => {
    expect(facts.income.otherIncomeBoxes).toEqual([expect.objectContaining({ variant: "1099-B", amountCents: 2287399 })]);
    expect(openItems.find((o) => o.id === "other-income-boxes")?.severity).toBe("blocking");
  });
});

describe("resolveFacts: the three states in one household", () => {
  it("interest-only 1099 -> nothing; unread 1099-B -> re-read; read summary with no sales ([]) -> no item", () => {
    const interest = doc1099("td", { docType: "1099", schemaVersion: 2, summary: "x", data: { formVariant: "1099-INT", variantsPresent: ["1099-INT"], int_box1Cents: 112432, federalWithheldCents: 0 } });
    const noSales = doc1099("ns", { docType: "1099", schemaVersion: 2, summary: "x", data: { formVariant: "1099-DIV", variantsPresent: ["1099-DIV"], div_box1aCents: 5000, bSummary: [] } });
    const { facts, openItems } = resolveFacts(raw([interest, noSales, doc1099("rh", OLD_READ)]));
    expect(facts.income.brokerSales.map((b) => [b.docId, b.summaryRead, b.signalled1099B, b.rows.length])).toEqual([
      ["ns", true, false, 0],
      ["rh", false, true, 0],
    ]);
    expect(openItems.filter((o) => o.id.startsWith("broker-summary-unread")).map((o) => o.id)).toEqual(["broker-summary-unread:rh"]);
    // no legacy-1099 regression on the unrelated documents
    expect(openItems.some((o) => o.id === "legacy-1099-withholding:td")).toBe(false);
  });
});

describe("resolveFacts: owner corrections to the sales summary are what the engine sees", () => {
  it("a corrected row replaces the AI row (effective data, never raw extractionData)", () => {
    const corrected = [
      { form: "1099-B", box: "A", proceedsCents: 587231, costCents: 528550, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 599, gainLossCents: 59280 },
      { form: "1099-B", box: "D", proceedsCents: 1700168, costCents: 1203728, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 496440 },
      { form: "1099-B", box: "B", proceedsCents: 10000, costCents: null, accruedMarketDiscountCents: null, washSaleLossDisallowedCents: null, gainLossCents: null },
    ];
    const corrections = { version: 1, fields: { bSummary: { value: corrected, aiValue: NEW_READ.data.bSummary } }, events: [] };
    const { facts } = resolveFacts(raw([doc1099("rh", NEW_READ, { corrections })]));
    expect(facts.income.brokerSales[0]!.rows.map((r) => r.box)).toEqual(["A", "D", "B"]);
    expect(facts.income.brokerSales[0]!.rows[2]).toMatchObject({ proceedsCents: 10000, costCents: null });
  });

  it("an owner who types the rows into an old (unread) document makes the summary read, so the re-read item goes away", () => {
    const rows = [{ form: "1099-B", box: "A", proceedsCents: 100, costCents: 90, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 10 }];
    const corrections = { version: 1, fields: { bSummary: { value: rows, aiValue: null } }, events: [] };
    const { facts, openItems } = resolveFacts(raw([doc1099("rh", OLD_READ, { corrections })]));
    expect(facts.income.brokerSales[0]).toMatchObject({ summaryRead: true, rows });
    expect(openItems.some((o) => o.id.startsWith("broker-summary-unread"))).toBe(false);
    expect(openItems.some((o) => o.id === "other-income-boxes")).toBe(false);
  });

  it("an unverified read is labelled doc_unverified", () => {
    const { facts } = resolveFacts(raw([doc1099("rh", NEW_READ, { verified: false })]));
    expect(facts.income.brokerSales[0]!.basis).toBe("doc_unverified");
  });
});

describe("resolveFacts: rows that cannot be placed, 1099-DA and Section 1256", () => {
  it("a row with no form or box is kept (never defaulted) and raises a blocking item", () => {
    const data = { docType: "1099", schemaVersion: 2, summary: "x", data: { formVariant: "consolidated", variantsPresent: ["1099-B"], div_box1aCents: 1, bSummary: [{ form: "1099-B", box: null, proceedsCents: 500, costCents: 400 }] } };
    const { facts, openItems } = resolveFacts(raw([doc1099("x", data)]));
    expect(facts.income.brokerSales[0]!.rows[0]).toMatchObject({ form: "1099-B", box: null, proceedsCents: 500, gainLossCents: null });
    expect(openItems.find((o) => o.id === "broker-row-incomplete:x")?.severity).toBe("blocking");
  });

  it("a 1099-DA row sets forms1099DaPresent and stays a separate form; a non-zero Section 1256 amount is carried", () => {
    const data = {
      docType: "1099",
      schemaVersion: 2,
      summary: "x",
      data: {
        formVariant: "consolidated",
        variantsPresent: ["1099-DIV", "1099-DA"],
        div_box1aCents: 1,
        bSummary: [{ form: "1099-DA", box: "H", proceedsCents: 9000, costCents: null, accruedMarketDiscountCents: null, washSaleLossDisallowedCents: null, gainLossCents: null }],
        sec1256AggregateCents: -12345,
      },
    };
    const { facts } = resolveFacts(raw([doc1099("da", data)]));
    expect(facts.income.brokerSales[0]).toMatchObject({ forms1099DaPresent: true, signalled1099B: false, sec1256AggregateCents: -12345 });
    expect(facts.income.brokerSales[0]!.rows[0]).toMatchObject({ form: "1099-DA", box: "H" });
  });

  it("a document that only has a Section 1256 amount still gets an entry (never dropped)", () => {
    const data = { docType: "1099", schemaVersion: 2, summary: "x", data: { formVariant: "consolidated", div_box1aCents: 1, sec1256AggregateCents: 0 } };
    const { facts } = resolveFacts(raw([doc1099("s", data)]));
    expect(facts.income.brokerSales[0]).toMatchObject({ docId: "s", summaryRead: false, signalled1099B: false, sec1256AggregateCents: 0 });
  });
});
