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
