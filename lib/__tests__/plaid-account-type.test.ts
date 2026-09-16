import { describe, it, expect } from "vitest";
import { inferAccountTypeFromPlaid } from "@/lib/plaid-account-type";

describe("inferAccountTypeFromPlaid", () => {
  it("maps mortgage subtype to mortgage", () => {
    expect(inferAccountTypeFromPlaid("loan", "mortgage")).toBe("mortgage");
  });

  it("maps loan type to loan", () => {
    expect(inferAccountTypeFromPlaid("loan", "home equity")).toBe("loan");
  });

  it("maps student subtype to loan", () => {
    expect(inferAccountTypeFromPlaid("loan", "student")).toBe("loan");
  });

  it("maps line of credit subtype to loan", () => {
    expect(inferAccountTypeFromPlaid("credit", "line of credit")).toBe("loan");
  });

  it("maps credit type to credit_card", () => {
    expect(inferAccountTypeFromPlaid("credit", "credit card")).toBe("credit_card");
  });

  it("maps credit card subtype to credit_card", () => {
    expect(inferAccountTypeFromPlaid(null, "credit card")).toBe("credit_card");
  });

  it("maps savings subtype to savings", () => {
    expect(inferAccountTypeFromPlaid("depository", "savings")).toBe("savings");
  });

  it("maps cd subtype to savings", () => {
    expect(inferAccountTypeFromPlaid("depository", "cd")).toBe("savings");
  });

  it("maps money market subtype to savings", () => {
    expect(inferAccountTypeFromPlaid("depository", "money market")).toBe("savings");
  });

  it("maps investment type to investment", () => {
    expect(inferAccountTypeFromPlaid("investment", "401k")).toBe("investment");
  });

  it("maps brokerage type to investment", () => {
    expect(inferAccountTypeFromPlaid("brokerage", null)).toBe("investment");
  });

  it("maps depository type with an unenumerated subtype (checking) to checking", () => {
    expect(inferAccountTypeFromPlaid("depository", "checking")).toBe("checking");
  });

  it("maps depository type with an unenumerated subtype (hsa) to checking", () => {
    expect(inferAccountTypeFromPlaid("depository", "hsa")).toBe("checking");
  });

  it("falls back to checking when both inputs are null/empty", () => {
    expect(inferAccountTypeFromPlaid(null, null)).toBe("checking");
    expect(inferAccountTypeFromPlaid("", "")).toBe("checking");
    expect(inferAccountTypeFromPlaid(undefined, undefined)).toBe("checking");
  });

  it("is case-insensitive on both type and subtype", () => {
    expect(inferAccountTypeFromPlaid("LOAN", "MORTGAGE")).toBe("mortgage");
    expect(inferAccountTypeFromPlaid("CREDIT", "Credit Card")).toBe("credit_card");
    expect(inferAccountTypeFromPlaid("Investment", null)).toBe("investment");
  });
});
