import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn();
  return { default: vi.fn(() => ({ messages: { create } })) };
});

vi.mock("@/lib/db", () => ({
  db: {
    transaction: {
      findFirst: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import {
  extractDocument,
  extractDocumentOrThrow,
  parseExtractionStrict,
  parseExtractionResponse,
  classifyDocType,
  computePayoffScenarios,
} from "@/lib/doc-extract";

const mockCreate = (Anthropic as unknown as ReturnType<typeof vi.fn>)().messages.create as ReturnType<typeof vi.fn>;
const mockDb = db as unknown as { transaction: { findFirst: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.transaction.findFirst.mockResolvedValue(null);
  mockDb.transaction.createMany.mockResolvedValue({ count: 0 });
});

// ── 1. Bank statement extraction ──────────────────────────────────────────────

describe("extractDocument — bank_statement", () => {
  it("returns transactionRows from a bank statement", async () => {
    const payload = {
      docType: "bank_statement",
      summary: "TD Checking statement for May 2026. Opening balance $1,200, closing $950.",
      period: "2026-05",
      data: {
        accountMask: "4821",
        institutionName: "TD Bank",
        openingBalanceCents: 120000,
        closingBalanceCents: 95000,
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
      },
      transactionRows: [
        { date: "2026-05-03", description: "Stop & Shop", amountCents: -8432 },
        { date: "2026-05-15", description: "Payroll", amountCents: 250000 },
      ],
    };

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    const result = await extractDocument(Buffer.from("fake pdf"), "application/pdf", "bank_statement");
    expect(result.docType).toBe("bank_statement");
    expect(result.transactionRows).toHaveLength(2);
    expect(result.transactionRows![0]!.amountCents).toBe(-8432);
    expect(result.transactionRows![1]!.description).toBe("Payroll");
    expect(result.data.accountMask).toBe("4821");
  });
});

// ── 1b. Credit card statement extraction ──────────────────────────────────────

describe("extractDocument — credit_card_statement", () => {
  it("returns transactionRows with lineType surviving the round-trip, mixed charge+payment", async () => {
    const payload = {
      docType: "credit_card_statement",
      summary: "Capital One card statement for January 2025. Statement balance $842.10.",
      period: "2025-01",
      data: {
        accountMask: "7391",
        institutionName: "Capital One",
        openingBalanceCents: 0,
        closingBalanceCents: 84210,
        statementBalanceCents: 84210,
        minimumPaymentCents: 3500,
        paymentDueDate: "2025-02-10",
        periodStart: "2025-01-01",
        periodEnd: "2025-01-31",
      },
      transactionRows: [
        { date: "2025-01-05", description: "Ueni", amountCents: -12000, lineType: "charge" },
        { date: "2025-01-14", description: "CAPITAL ONE-CRCARDPMT", amountCents: 130846, lineType: "payment" },
        { date: "2025-01-20", description: "Merchant refund — Staples", amountCents: 4500, lineType: "charge" },
      ],
    };

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    const result = await extractDocument(Buffer.from("fake pdf"), "application/pdf", "credit_card_statement");
    expect(result.docType).toBe("credit_card_statement");
    expect(result.transactionRows).toHaveLength(3);
    expect(result.transactionRows![0]!.lineType).toBe("charge");
    expect(result.transactionRows![0]!.amountCents).toBe(-12000);
    expect(result.transactionRows![1]!.lineType).toBe("payment");
    expect(result.transactionRows![1]!.amountCents).toBe(130846);
    // A positive-amount merchant refund must stay "charge", not get swept
    // into the payment classification just because it's a positive amount.
    expect(result.transactionRows![2]!.lineType).toBe("charge");
    expect(result.data.statementBalanceCents).toBe(84210);
    expect(result.data.minimumPaymentCents).toBe(3500);
  });
});

// ── 2. Insurance policy extraction ────────────────────────────────────────────

describe("extractDocument — insurance_policy", () => {
  it("returns faceAmountCents and monthlyPremiumCents from a policy document", async () => {
    const payload = {
      docType: "insurance_policy",
      summary: "Northwestern Mutual whole life policy. Face amount $500,000. Monthly premium $755.",
      data: {
        policyType: "whole",
        insurer: "Northwestern Mutual",
        policyNumber: "NWM-123456",
        faceAmountCents: 50000000,
        monthlyPremiumCents: 75500,
        effectiveDate: "2018-01-01",
        expiryDate: null,
        cashValueCents: 42000,
      },
    };

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    const result = await extractDocument(Buffer.from("fake pdf"), "application/pdf", "insurance_policy");
    expect(result.docType).toBe("insurance_policy");
    expect(result.data.faceAmountCents).toBe(50000000);
    expect(result.data.monthlyPremiumCents).toBe(75500);
    expect(result.data.insurer).toBe("Northwestern Mutual");
  });
});

// ── 3. Utility bill extraction ────────────────────────────────────────────────

describe("extractDocument — utility_bill", () => {
  it("returns usageKwh and amountDueCents from a utility bill", async () => {
    const payload = {
      docType: "utility_bill",
      summary: "Eversource bill for May 2026. 842 kWh used. Amount due $127.40.",
      period: "2026-05",
      data: {
        provider: "Eversource",
        accountNumber: "x4892",
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
        amountDueCents: 12740,
        usageKwh: 842.0,
        gridCreditCents: 1500,
      },
    };

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    const result = await extractDocument(Buffer.from("fake pdf"), "application/pdf", "utility_bill");
    expect(result.docType).toBe("utility_bill");
    expect(result.data.usageKwh).toBe(842.0);
    expect(result.data.amountDueCents).toBe(12740);
    expect(result.data.gridCreditCents).toBe(1500);
  });
});

// ── 4. classifyDocType ────────────────────────────────────────────────────────

describe("classifyDocType", () => {
  it("maps known docType strings correctly", () => {
    expect(classifyDocType("bank_statement")).toBe("bank_statement");
    expect(classifyDocType("insurance_policy")).toBe("insurance_policy");
    expect(classifyDocType("policy")).toBe("insurance_policy");
    expect(classifyDocType("statement")).toBe("bank_statement");
    expect(classifyDocType("w2")).toBe("w2");
    expect(classifyDocType("unknown_type")).toBe("other");
  });

  it("classifies by filename when docType is unknown", () => {
    expect(classifyDocType("other", "TD_Bank_Statement_May2026.pdf")).toBe("bank_statement");
    expect(classifyDocType("other", "NWM_Policy_2024.pdf")).toBe("insurance_policy");
    expect(classifyDocType("other", "Eversource_May_2026.pdf")).toBe("utility_bill");
    expect(classifyDocType("other", "PennyMac_Mortgage_Statement.pdf")).toBe("mortgage_statement");
  });
});

// ── 5. computePayoffScenarios ─────────────────────────────────────────────────

describe("computePayoffScenarios", () => {
  it("reduces months-to-payoff when extra payment is added", () => {
    // $300,000 loan at 6.75%, 360 months remaining, $1,946/mo standard payment
    const principalCents = 30000000;
    const annualRate = 0.0675;
    const remainingMonths = 360;
    const monthlyPaymentCents = 194600;

    const scenarios = computePayoffScenarios(principalCents, annualRate, remainingMonths, monthlyPaymentCents);

    // Baseline (extra = $0) should be ~360 months
    const baseline = scenarios[0]!;
    expect(baseline.extraMonthlyPaymentCents).toBe(0);
    expect(baseline.monthsRemaining).toBeLessThanOrEqual(362);
    expect(baseline.monthsRemaining).toBeGreaterThanOrEqual(355);

    // Adding $1,000/mo should significantly reduce payoff time
    const withExtra = scenarios[4]!; // $1,000 extra
    expect(withExtra.extraMonthlyPaymentCents).toBe(100000);
    expect(withExtra.monthsRemaining).toBeLessThan(baseline.monthsRemaining - 60);
    expect(withExtra.totalInterestCents).toBeLessThan(baseline.totalInterestCents);
  });
});


// ── Strict extraction: failures must be failures ──────────────────────────────

describe("parseExtractionStrict", () => {
  it("parses fenced JSON", () => {
    const out = parseExtractionStrict('```json\n{"docType":"bank_statement","summary":"s","data":{}}\n```');
    expect(out.docType).toBe("bank_statement");
  });

  it("recovers JSON surrounded by prose", () => {
    const out = parseExtractionStrict('Here you go:\n{"docType":"other","summary":"s","data":{}}\nHope that helps!');
    expect(out.summary).toBe("s");
  });

  it("throws on truncated JSON instead of returning a fake success", () => {
    expect(() => parseExtractionStrict('{"docType":"credit_card_statement","transactionRows":[{"date":"2025-')).toThrow();
  });
});

describe("extractDocumentOrThrow", () => {
  const goodCard = {
    docType: "credit_card_statement",
    summary: "Card statement",
    data: { periodEnd: "2025-07-18" },
    transactionRows: [{ date: "2025-06-20", description: "USPS", amountCents: -1250, lineType: "charge" }],
  };

  it("returns a valid statement extraction", async () => {
    mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(goodCard) }] });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "credit_card_statement");
    expect(out.transactionRows).toHaveLength(1);
    expect(out.warnings).toBeUndefined();
  });

  it("gives statement extractions a larger output budget than the default", async () => {
    mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(goodCard) }] });
    await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "credit_card_statement");
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBeGreaterThan(4096);
  });

  it("throws when output was cut off at max_tokens (used to be saved as a success)", async () => {
    mockCreate.mockResolvedValue({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"docType":"credit_card' }] });
    await expect(extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "credit_card_statement")).rejects.toThrow(/cut off/);
  });

  it("throws on unparseable output", async () => {
    mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "I could not read this." }] });
    await expect(extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "bank_statement")).rejects.toThrow(/not valid JSON/);
  });

  it("throws when a statement has no transactionRows array", async () => {
    mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ docType: "bank_statement", summary: "s", data: {} }) }] });
    await expect(extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "bank_statement")).rejects.toThrow(/transactionRows/);
  });

  it("propagates API errors", async () => {
    mockCreate.mockRejectedValue(new Error("overloaded"));
    await expect(extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "bank_statement")).rejects.toThrow("overloaded");
  });

  it("throws on an unsupported file type", async () => {
    await expect(extractDocumentOrThrow(Buffer.from("x"), "text/plain", "bank_statement")).rejects.toThrow(/Unsupported/);
  });

  it("warns when the row cap is hit", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ date: "2025-06-20", description: `M${i}`, amountCents: -100, lineType: "charge" }));
    mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ...goodCard, transactionRows: rows }) }] });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "credit_card_statement");
    expect(out.warnings?.[0]).toMatch(/200 rows/);
  });

  it("legacy extractDocument still returns a stub instead of throwing (insurance/tax callers)", async () => {
    mockCreate.mockRejectedValue(new Error("boom"));
    const out = await extractDocument(Buffer.from("x"), "application/pdf", "insurance_policy");
    expect(out.summary).toBe("Extraction failed.");
  });
});

// ── Tax schemas: classification, prompts, normalization, output budget ────────

describe("classifyDocType - tax shapes", () => {
  it("maps mortgage_interest to the annual 1098 shape, not the monthly mortgage statement", () => {
    expect(classifyDocType("mortgage_interest")).toBe("form_1098");
    expect(classifyDocType("form_1098")).toBe("form_1098");
    expect(classifyDocType("mortgage_statement")).toBe("mortgage_statement");
  });
  it("maps property_tax to its own shape (it used to fall through to other)", () => {
    expect(classifyDocType("property_tax")).toBe("property_tax");
    expect(classifyDocType("property_tax", "bill.pdf")).toBe("property_tax");
  });
  it("leaves the other tax types unchanged", () => {
    for (const t of ["w2", "1099", "k1", "tax_return"]) expect(classifyDocType(t)).toBe(t);
  });
});

describe("extractDocumentOrThrow - tax documents are normalized", () => {
  const reply = (payload: unknown) =>
    mockCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(payload) }] });

  it("stamps schemaVersion, drops unknown keys and scrubs SSN-shaped text (summary and fields)", async () => {
    reply({
      docType: "w2",
      summary: "W-2 for Pat, SSN 123-45-6789.",
      data: {
        taxYear: 2025,
        employerName: "Acme",
        employerEIN: "12-3456789",
        wagesCents: 5000000,
        federalWithheldCents: 800000,
        employeeSSN: "123-45-6789",
        stateLines: [{ stateCode: "ct", stateEmployerId: "987654321", stateWagesCents: 5000000, stateWithheldCents: 150000 }],
      },
    });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "w2");
    expect(out.schemaVersion).toBe(2);
    expect(out.docType).toBe("w2");
    expect(out.data).not.toHaveProperty("employeeSSN");
    expect(JSON.stringify(out)).not.toMatch(/\b\d{3}-?\d{2}-?\d{4}\b/);
    expect(out.data.wagesCents).toBe(5000000);
    expect(out.data.stateWithheldCents).toBe(150000); // legacy flat key derived from the CT line
    expect(out.warnings).toContain("removed text that looked like an SSN");
  });

  it("1098 uses the form_1098 prompt and stamps docType/schemaVersion", async () => {
    reply({ docType: "form_1098", summary: "1098", data: { interestCents: 1888269, principalBalanceCents: 37787263 } });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "form_1098");
    expect(out.docType).toBe("form_1098");
    expect(out.schemaVersion).toBe(2);
    const system = mockCreate.mock.calls[0]![0].system as string;
    expect(system).toMatch(/Form 1098/);
    expect(system).toContain("interestCents");
    expect(system).not.toContain("monthlyPaymentCents");
  });

  it("property tax: the AI-supplied paidInTaxYearCents is discarded", async () => {
    reply({ docType: "property_tax", summary: "bill", data: { totalTaxBilledCents: 600000, paidInTaxYearCents: 600000 } });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "property_tax");
    expect(out.data.paidInTaxYearCents).toBeNull();
    expect(out.data.totalTaxBilledCents).toBe(600000);
  });

  it("gives 1099 / K-1 / property tax a bigger output budget; W-2 and 1098 keep 4096", async () => {
    reply({ docType: "1099", summary: "", data: {} });
    for (const [type, expected] of [
      ["1099", 8192],
      ["k1", 8192],
      ["property_tax", 8192],
      ["w2", 4096],
      ["form_1098", 4096],
      ["tax_return", 4096],
    ] as const) {
      mockCreate.mockClear();
      reply({ docType: type, summary: "", data: {} });
      await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", type);
      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(expected);
    }
  });

  it("an under-sized response is a failure, not a silent truncation", async () => {
    mockCreate.mockResolvedValue({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"docType":"1099"' }] });
    await expect(extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "1099")).rejects.toThrow(/cut off/);
  });

  it("non-tax types are returned as parsed (no normalization side effects)", async () => {
    reply({ docType: "insurance_policy", summary: "policy 123-45-6789", data: { insurer: "NWM", extra: 1 } });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "insurance_policy");
    expect(out.schemaVersion).toBeUndefined();
    expect(out.data.extra).toBe(1);
  });
});

describe("extractDocument (lenient) - tax documents are normalized too", () => {
  it("normalizes a parsed tax response but leaves the parse-failure stub recognisable", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ docType: "w2", summary: "s", data: { wagesCents: 100, junk: 1 } }) }],
    });
    const ok = await extractDocument(Buffer.from("x"), "application/pdf", "w2");
    expect(ok.schemaVersion).toBe(2);
    expect(ok.data).not.toHaveProperty("junk");

    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "not json at all" }] });
    const stub = await extractDocument(Buffer.from("x"), "application/pdf", "w2");
    expect(stub.summary).toBe("Could not parse extraction response.");
    expect(stub.schemaVersion).toBeUndefined();
  });
});
