// Fixtures for the 1099-B sales summary capture (schedule-d-capture).
//
// 1. OLD_SHAPE_RESPONSES: raw model responses in the shape of the 1099 prompt BEFORE `bSummary`
//    existed (no bSummary / sec1256 / totals keys). The differential test normalizes each one with the
//    current registry and compares every pre-existing key with GOLDEN_OLD_NORMALIZED, which was produced
//    by the registry at commit d016753 (before this change). A new key may only ADD null values.
// 2. ROBINHOOD_2025_*: the shape of the owner's real Robinhood 2025 consolidated 1099 sales summary
//    (read-only look at the PDF, 2026-10-04): Short A, Long D with a wash sale, zero B / E, Section 1256
//    all zero. Amounts are integer cents. NO account numbers, names of securities or taxpayer ids.

export interface OldShapeCase {
  name: string;
  raw: unknown;
}

export const OLD_SHAPE_RESPONSES: OldShapeCase[] = [
  {
    name: "single 1099-INT",
    raw: {
      docType: "1099",
      summary: "1099-INT from a bank.",
      data: {
        taxYear: 2025,
        formVariant: "1099-INT",
        variantsPresent: ["1099-INT"],
        payerName: "TD Bank",
        payerEIN: "22-1234567",
        amountCents: 112432,
        federalWithheldCents: 0,
        int_box1Cents: 112432,
        int_box3Cents: 0,
        otherBoxes: [],
        stateLines: [],
      },
    },
  },
  {
    name: "consolidated, old read with 1099-B boxes in otherBoxes",
    raw: {
      docType: "1099",
      summary: "Consolidated 1099.",
      data: {
        taxYear: 2025,
        formVariant: "Consolidated",
        variantsPresent: ["1099-int", "1099-DIV", "1099-B", "1099-DIV", "bogus"],
        payerName: "Robinhood Markets",
        payerEIN: "46-4136152",
        amountCents: 358,
        federalWithheldCents: 0,
        int_box1Cents: 120,
        div_box1aCents: 238,
        div_box1bCents: 200,
        div_box2aCents: 0,
        otherBoxes: [
          { variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2287399 },
          { variant: "1099-B", box: "1e", label: "Cost or other basis", amountCents: 1732278 },
        ],
        stateLines: [{ stateCode: "ct", statePayerId: "123", stateIncomeCents: 100, stateWithheldCents: 5 }],
      },
    },
  },
  {
    name: "junk values, unknown keys, SSN-shaped text, caps",
    raw: {
      docType: "1099",
      summary: "Summary with 123-45-6789 in it.",
      data: {
        taxYear: "2025",
        formVariant: "weird",
        payerName: "Payer 123-45-6789",
        payerEIN: "123456789",
        amountCents: 12.5,
        federalWithheldCents: "500",
        nec_box1Cents: -5,
        misc_box3Cents: "abc",
        notAField: 7,
        otherBoxes: Array.from({ length: 25 }, (_, i) => ({ variant: "1099-R", box: String(i), label: "x", amountCents: i })),
        stateLines: [{ stateCode: "NY" }, { stateCode: null, stateIncomeCents: null }, "not a row"],
      },
    },
  },
  {
    name: "empty data",
    raw: { docType: "1099", summary: "", data: {} },
  },
  {
    name: "unparseable",
    raw: "not an object",
  },
];

/** Keys the sales-summary capture adds to the 1099 schema. */
export const NEW_1099_KEYS = ["bSummary", "sec1256AggregateCents", "bSummaryTotalProceedsCents", "bSummaryTotalGainCents"] as const;

// ── Robinhood 2025 (real shape) ───────────────────────────────────────────────

/**
 * What the model returns for the owner's Robinhood consolidated 1099 once the prompt asks for the sales summary:
 * Short A 5,872.31 / 5,285.50 / 0 / 5.99 / net 592.80 (summary-table net gain; see the cross-check test for the add-back note),
 * Long D 17,001.68 / 12,037.28 / 0 / 0 / net 4,964.40; zero categories are left out.
 */
export const ROBINHOOD_2025_ROWS = [
  {
    form: "1099-B",
    box: "A",
    proceedsCents: 587231,
    costCents: 528550,
    accruedMarketDiscountCents: 0,
    washSaleLossDisallowedCents: 599,
    gainLossCents: 59280,
  },
  {
    form: "1099-B",
    box: "D",
    proceedsCents: 1700168,
    costCents: 1203728,
    accruedMarketDiscountCents: 0,
    washSaleLossDisallowedCents: 0,
    gainLossCents: 496440,
  },
] as const;

export const ROBINHOOD_2025_RAW = {
  docType: "1099",
  summary: "Robinhood consolidated 1099 for 2025.",
  data: {
    taxYear: 2025,
    formVariant: "consolidated",
    variantsPresent: ["1099-DIV", "1099-B"],
    payerName: "Robinhood Markets, Inc.",
    bSummary: ROBINHOOD_2025_ROWS.map((r) => ({ ...r })),
    sec1256AggregateCents: 0,
    bSummaryTotalProceedsCents: null,
    bSummaryTotalGainCents: null,
  },
};
