import { describe, it, expect } from "vitest";
import { parseExtractedResponse } from "@/lib/receipt-extract";

describe("parseExtractedResponse", () => {
  it("parses a valid JSON response", () => {
    const text = JSON.stringify({
      vendor: "Whole Foods Market",
      receiptDate: "2026-06-01",
      totalDollars: "42.50",
      description: "Groceries",
      glCode: "Groceries",
    });
    const result = parseExtractedResponse(text);
    expect(result.vendor).toBe("Whole Foods Market");
    expect(result.receiptDate).toBe("2026-06-01");
    expect(result.totalDollars).toBe("42.50");
    expect(result.description).toBe("Groceries");
    expect(result.glCode).toBe("Groceries");
  });

  it("strips markdown code fences", () => {
    const text = "```json\n{\"vendor\":\"Target\",\"receiptDate\":\"2026-06-02\",\"totalDollars\":\"15.99\",\"description\":null,\"glCode\":null}\n```";
    const result = parseExtractedResponse(text);
    expect(result.vendor).toBe("Target");
    expect(result.totalDollars).toBe("15.99");
  });

  it("returns null for missing glCode", () => {
    const text = JSON.stringify({
      vendor: "Shell",
      receiptDate: "2026-05-20",
      totalDollars: "78.00",
      description: "Gas",
    });
    const result = parseExtractedResponse(text);
    expect(result.glCode).toBeNull();
  });

  it("returns null fields for malformed JSON", () => {
    const result = parseExtractedResponse("not json at all");
    expect(result.vendor).toBeNull();
    expect(result.receiptDate).toBeNull();
    expect(result.totalDollars).toBeNull();
    expect(result.description).toBeNull();
    expect(result.glCode).toBeNull();
  });

  it("returns null fields when Claude returns empty object", () => {
    const result = parseExtractedResponse("{}");
    expect(result.vendor).toBeNull();
    expect(result.totalDollars).toBeNull();
  });

  it("coerces non-string vendor to null", () => {
    const text = JSON.stringify({ vendor: 123, receiptDate: null, totalDollars: null, description: null, glCode: null });
    const result = parseExtractedResponse(text);
    expect(result.vendor).toBeNull();
  });

  it("preserves dollar string with 2 decimal places", () => {
    const text = JSON.stringify({ vendor: "CVS", receiptDate: "2026-06-10", totalDollars: "12.50", description: null, glCode: null });
    const result = parseExtractedResponse(text);
    expect(result.totalDollars).toBe("12.50");
  });

  it("preserves ISO date string without conversion", () => {
    const text = JSON.stringify({ vendor: "BJ's", receiptDate: "2026-01-15", totalDollars: "200.00", description: null, glCode: null });
    const result = parseExtractedResponse(text);
    expect(result.receiptDate).toBe("2026-01-15");
  });

  it("stores raw response text", () => {
    const text = '{"vendor":"Test","receiptDate":null,"totalDollars":null,"description":null,"glCode":null}';
    const result = parseExtractedResponse(text);
    expect(result.raw).toBe(text);
  });

  it("handles null values in JSON response", () => {
    const text = JSON.stringify({ vendor: null, receiptDate: null, totalDollars: null, description: null, glCode: null });
    const result = parseExtractedResponse(text);
    expect(result.vendor).toBeNull();
    expect(result.totalDollars).toBeNull();
  });
});
