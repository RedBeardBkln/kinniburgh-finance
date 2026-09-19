import { describe, it, expect } from "vitest";
import {
  defaultImportSelection,
  formatFieldLabel,
  isWithinPlaidCoverage,
  needsCreditCardReclassification,
  normalizeBalanceCents,
} from "@/lib/statement-review";

describe("defaultImportSelection", () => {
  it("excludes payment rows by default", () => {
    const rows = [
      { date: "2025-01-10", lineType: "charge" as const },
      { date: "2025-01-14", lineType: "payment" as const },
      { date: "2025-01-20", lineType: "charge" as const },
    ];
    expect(defaultImportSelection(rows, null)).toEqual([0, 2]);
  });

  it("excludes rows on/after the Plaid coverage start date", () => {
    const rows = [
      { date: "2026-03-30", lineType: "charge" as const },
      { date: "2026-04-02", lineType: "charge" as const },
      { date: "2026-04-15", lineType: "charge" as const },
    ];
    expect(defaultImportSelection(rows, "2026-04-02")).toEqual([0]);
  });

  it("includes everything else (no payment tag, no Plaid overlap)", () => {
    const rows = [
      { date: "2025-01-10", lineType: "charge" as const },
      { date: "2025-02-11" },
    ];
    expect(defaultImportSelection(rows, null)).toEqual([0, 1]);
  });

  it("treats an undefined lineType as a charge (included)", () => {
    const rows = [{ date: "2025-06-01" }];
    expect(defaultImportSelection(rows, null)).toEqual([0]);
  });
});

describe("isWithinPlaidCoverage", () => {
  it("treats the exact coverage-start date as covered", () => {
    expect(isWithinPlaidCoverage("2026-04-02", "2026-04-02")).toBe(true);
  });

  it("treats the day before coverage start as not covered", () => {
    expect(isWithinPlaidCoverage("2026-04-01", "2026-04-02")).toBe(false);
  });

  it("never matches when coverage start is null", () => {
    expect(isWithinPlaidCoverage("2099-01-01", null)).toBe(false);
  });
});

describe("needsCreditCardReclassification", () => {
  it("is true for a credit_card account whose rows carry no lineType", () => {
    expect(
      needsCreditCardReclassification("credit_card", {
        transactionRows: [{ date: "2025-01-01" } as { lineType?: "charge" | "payment" }],
      })
    ).toBe(true);
  });

  it("is false for a checking account", () => {
    expect(
      needsCreditCardReclassification("checking", {
        transactionRows: [{}],
      })
    ).toBe(false);
  });

  it("is false for an empty/missing extraction", () => {
    expect(needsCreditCardReclassification("credit_card", null)).toBe(false);
    expect(needsCreditCardReclassification("credit_card", { transactionRows: [] })).toBe(false);
    expect(needsCreditCardReclassification("credit_card", {})).toBe(false);
  });

  it("is false for an already-reclassified extraction (every row has lineType)", () => {
    expect(
      needsCreditCardReclassification("credit_card", {
        transactionRows: [{ lineType: "charge" }, { lineType: "payment" }],
      })
    ).toBe(false);
  });
});

describe("formatFieldLabel", () => {
  it("drops the Cents suffix from amount fields", () => {
    expect(formatFieldLabel("openingBalanceCents")).toBe("Opening Balance");
    expect(formatFieldLabel("closingBalanceCents")).toBe("Closing Balance");
    expect(formatFieldLabel("minimumPaymentCents")).toBe("Minimum Payment");
    expect(formatFieldLabel("statementBalanceCents")).toBe("Statement Balance");
  });

  it("title-cases ordinary camelCase keys unchanged", () => {
    expect(formatFieldLabel("paymentDueDate")).toBe("Payment Due Date");
    expect(formatFieldLabel("accountMask")).toBe("Account Mask");
    expect(formatFieldLabel("institutionName")).toBe("Institution Name");
  });

  it("only strips a trailing Cents, not one mid-word", () => {
    expect(formatFieldLabel("centsPerKwh")).toBe("Cents Per Kwh");
  });
});

describe("normalizeBalanceCents", () => {
  it("stores a liability balance as the positive amount owed (regression: one card statement came back negative)", () => {
    expect(normalizeBalanceCents(-148154, "credit_card")).toBe(148154);
    expect(normalizeBalanceCents(-85679, "credit_card")).toBe(85679);
    expect(normalizeBalanceCents(-500000, "mortgage")).toBe(500000);
    expect(normalizeBalanceCents(-2500, "loan")).toBe(2500);
  });

  it("leaves an already-positive liability balance alone", () => {
    expect(normalizeBalanceCents(148154, "credit_card")).toBe(148154);
  });

  it("does not touch asset accounts, where negative means overdrawn", () => {
    expect(normalizeBalanceCents(-5000, "checking")).toBe(-5000);
    expect(normalizeBalanceCents(-5000, "savings")).toBe(-5000);
  });

  it("does not touch unlinked statements or null balances", () => {
    expect(normalizeBalanceCents(-5000, null)).toBe(-5000);
    expect(normalizeBalanceCents(-5000, undefined)).toBe(-5000);
    expect(normalizeBalanceCents(null, "credit_card")).toBeNull();
  });
});
