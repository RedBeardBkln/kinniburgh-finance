import { describe, it, expect } from "vitest";
import { generateDocumentName, documentTypeLabel } from "@/lib/doc-naming";

describe("generateDocumentName", () => {
  it("W-2: uses employer name and year", () => {
    const name = generateDocumentName("w2", 2025, {
      docType: "w2",
      data: { employerName: "Acme Corp", taxYear: 2025 },
    });
    expect(name).toBe("W-2 — Acme Corp (2025)");
  });

  it("1099: uses variant and payer", () => {
    const name = generateDocumentName("1099", 2025, {
      docType: "1099",
      data: { payerName: "Fiverr Inc", formVariant: "1099-NEC" },
    });
    expect(name).toBe("1099-NEC — Fiverr Inc (2025)");
  });

  it("1099-INT variant formats correctly", () => {
    const name = generateDocumentName("1099", 2025, {
      docType: "1099",
      data: { payerName: "Betterment", formVariant: "1099-INT" },
    });
    expect(name).toBe("1099-INT — Betterment (2025)");
  });

  it("1099 without payer falls back to type + year", () => {
    const name = generateDocumentName("1099", 2025, {
      docType: "1099",
      data: {},
    });
    expect(name).toBe("1099 (2025)");
  });

  it("mortgage 1098 uses servicer", () => {
    const name = generateDocumentName("mortgage_interest", 2025, {
      docType: "mortgage_statement",
      data: { servicerName: "PennyMac" },
    });
    expect(name).toBe("1098 — PennyMac (2025)");
  });

  it("bank statement uses institution and period", () => {
    const name = generateDocumentName("bank_statement", 2025, {
      docType: "bank_statement",
      data: { institutionName: "TD Bank", period: "2026-03" },
    });
    expect(name).toBe("Bank Statement — TD Bank (2026-03)");
  });

  it("prefers parsed taxYear over the upload-year parameter", () => {
    const name = generateDocumentName("w2", 2026, {
      docType: "w2",
      data: { employerName: "Acme Corp", taxYear: 2024 },
    });
    expect(name).toBe("W-2 — Acme Corp (2024)");
  });

  it("null extraction falls back to type + taxYear arg", () => {
    expect(generateDocumentName("k1", 2025, null)).toBe("K-1 (2025)");
  });

  it("no year anywhere returns just the type label", () => {
    expect(generateDocumentName("extension", null, null)).toBe("Extension");
  });

  it("unknown doc type passes through", () => {
    expect(generateDocumentName("custom_thing", 2025, null)).toBe("custom_thing (2025)");
  });

  it("never throws on odd data shapes", () => {
    expect(() =>
      generateDocumentName("w2", 2025, { docType: "w2", data: { employerName: 42 } })
    ).not.toThrow();
  });
});

describe("documentTypeLabel", () => {
  it("maps known types", () => {
    expect(documentTypeLabel("w2")).toBe("W-2");
    expect(documentTypeLabel("property_tax")).toBe("Property Tax Bill");
  });
  it("passes unknown types through", () => {
    expect(documentTypeLabel("weird")).toBe("weird");
  });
});