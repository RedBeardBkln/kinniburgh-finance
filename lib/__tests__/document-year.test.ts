import { describe, it, expect } from "vitest";
import {
  buildYearFillConfirmMessage,
  deriveDocumentTaxYear,
  deriveEffectiveDocumentTaxYear,
  planYearFill,
} from "@/lib/document-year";

const NOW = 2026;

function stmt(data: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return { docType: "bank_statement", summary: "s", ...top, data };
}
const d = (docType: string, extraction: unknown) => deriveDocumentTaxYear(docType, extraction, NOW);

describe("deriveDocumentTaxYear - statement-like types (year of periodEnd)", () => {
  it.each(["bank_statement", "statement", "credit_card_statement", "mortgage_statement", "utility_bill"])(
    "%s -> year of periodEnd",
    (docType) => {
      expect(d(docType, stmt({ periodStart: "2025-03-28", periodEnd: "2025-04-27" }))).toBe(2025);
    }
  );

  it("a cross-year statement belongs to the periodEnd year", () => {
    expect(d("bank_statement", stmt({ periodStart: "2024-12-28", periodEnd: "2025-01-27" }))).toBe(2025);
  });

  it("Jan 1 and Dec 31 periodEnd use the string's own year (no timezone shift)", () => {
    expect(d("bank_statement", stmt({ periodEnd: "2025-01-01" }))).toBe(2025);
    expect(d("bank_statement", stmt({ periodEnd: "2025-12-31" }))).toBe(2025);
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(d("bank_statement", stmt({ periodEnd: "2024-02-29" }))).toBe(2024);
    expect(d("bank_statement", stmt({ periodEnd: "2025-02-29" }))).toBeNull();
  });

  it("periodEnd wins over a disagreeing period string", () => {
    expect(d("bank_statement", stmt({ periodEnd: "2025-01-27" }, { period: "2024-12" }))).toBe(2025);
  });

  it("an absent periodStart still uses periodEnd", () => {
    expect(d("bank_statement", stmt({ periodEnd: "2025-06-30" }))).toBe(2025);
  });

  it("periodStart after periodEnd is a contradiction -> null (even with a usable period)", () => {
    expect(d("bank_statement", stmt({ periodStart: "2025-05-01", periodEnd: "2025-04-01" }, { period: "2025-04" }))).toBeNull();
  });

  it("an invalid periodStart does not block a valid periodEnd", () => {
    expect(d("bank_statement", stmt({ periodStart: "garbage", periodEnd: "2025-04-27" }))).toBe(2025);
  });

  it("falls back to the TOP-level period when periodEnd is missing", () => {
    expect(d("bank_statement", stmt({}, { period: "2025-11" }))).toBe(2025);
    expect(d("mortgage_statement", stmt({}, { period: "2024-03" }))).toBe(2024);
  });

  it("falls back to data.period defensively", () => {
    expect(d("bank_statement", stmt({ period: "2025-11" }))).toBe(2025);
  });

  it("top-level period is read before data.period", () => {
    expect(d("bank_statement", stmt({ period: "2024-01" }, { period: "2025-11" }))).toBe(2025);
  });

  it("an invalid periodEnd falls back to a valid period", () => {
    expect(d("bank_statement", stmt({ periodEnd: "2025-13-40" }, { period: "2025-02" }))).toBe(2025);
  });

  it("both invalid -> null", () => {
    expect(d("bank_statement", stmt({ periodEnd: "2025-13-40" }, { period: "2025-13" }))).toBeNull();
  });

  it.each(["2025-00", "2025-13", "2025-1", "25-11", "2025/11", "", 202511])("rejects malformed period %s", (period) => {
    expect(d("bank_statement", stmt({}, { period }))).toBeNull();
  });

  it.each(["2025-4-7", "2025-04-7", "04/27/2025", "2025-04-27T00:00:00Z", "2025-13-40", "", 20250427, null])(
    "rejects malformed periodEnd %s",
    (periodEnd) => {
      expect(d("bank_statement", stmt({ periodEnd }))).toBeNull();
    }
  );

  it("no data at all -> null", () => {
    expect(d("bank_statement", { docType: "bank_statement", summary: "s" })).toBeNull();
    expect(d("bank_statement", { docType: "bank_statement", data: "x" })).toBeNull();
    expect(d("bank_statement", { docType: "bank_statement", data: [] })).toBeNull();
  });

  it("a top-level period alone works even when `data` is missing", () => {
    expect(d("bank_statement", { period: "2025-11" })).toBe(2025);
  });
});

describe("deriveDocumentTaxYear - plausibility range (2000 .. currentYear + 1)", () => {
  it("1999 -> null, 2000 -> ok", () => {
    expect(d("bank_statement", stmt({ periodEnd: "1999-12-31" }))).toBeNull();
    expect(d("bank_statement", stmt({ periodEnd: "2000-01-31" }))).toBe(2000);
  });

  it("currentYear + 1 ok, currentYear + 2 null", () => {
    expect(d("bank_statement", stmt({ periodEnd: `${NOW + 1}-01-31` }))).toBe(NOW + 1);
    expect(d("bank_statement", stmt({ periodEnd: `${NOW + 2}-01-31` }))).toBeNull();
    expect(d("w2", { data: { taxYear: NOW + 1 } })).toBe(NOW + 1);
    expect(d("w2", { data: { taxYear: NOW + 2 } })).toBeNull();
    expect(d("w2", { data: { taxYear: 1999 } })).toBeNull();
    expect(d("w2", { data: { taxYear: 2000 } })).toBe(2000);
  });

  it("an out-of-range periodEnd does not fall back to the period string", () => {
    expect(d("bank_statement", stmt({ periodEnd: "1999-12-31" }, { period: "2025-01" }))).toBeNull();
  });

  it("an out-of-range period string -> null", () => {
    expect(d("bank_statement", stmt({}, { period: "1999-05" }))).toBeNull();
  });
});

describe("deriveDocumentTaxYear - annual tax forms (data.taxYear)", () => {
  it.each(["w2", "1099", "k1", "mortgage_interest", "form_1098", "property_tax", "tax_return"])(
    "%s -> data.taxYear",
    (docType) => {
      expect(d(docType, { docType, data: { taxYear: 2025 } })).toBe(2025);
    }
  );

  it("does not coerce strings or floats, and rejects NaN/null/missing", () => {
    expect(d("w2", { data: { taxYear: "2025" } })).toBeNull();
    expect(d("w2", { data: { taxYear: 2025.5 } })).toBeNull();
    expect(d("w2", { data: { taxYear: Number.NaN } })).toBeNull();
    expect(d("w2", { data: { taxYear: null } })).toBeNull();
    expect(d("w2", { data: {} })).toBeNull();
    expect(d("w2", { data: null })).toBeNull();
  });

  it("never falls back to dates or period for a tax form", () => {
    expect(d("w2", { period: "2025-01", data: { periodEnd: "2025-01-31" } })).toBeNull();
  });

  it("a statement's taxYear field is ignored (statements use their period)", () => {
    expect(d("bank_statement", stmt({ taxYear: 2025 }))).toBeNull();
  });
});

describe("deriveDocumentTaxYear - types with no reliable year", () => {
  it.each(["insurance_policy", "policy", "other", "extension", "something_new", ""])(
    "%s -> null even if the data carries year-like fields",
    (docType) => {
      expect(d(docType, { period: "2025-01", data: { taxYear: 2025, periodEnd: "2025-06-30" } })).toBeNull();
    }
  );
});

describe("deriveDocumentTaxYear - garbage input", () => {
  it.each([null, undefined, [], "2025", 2025, true])("extractionData %j -> null", (value) => {
    expect(d("bank_statement", value)).toBeNull();
    expect(d("w2", value)).toBeNull();
  });
});

describe("deriveDocumentTaxYear - default currentYear", () => {
  it("uses the real clock when not given (a near-term year is plausible)", () => {
    expect(deriveDocumentTaxYear("w2", { data: { taxYear: 2025 } })).toBe(2025);
  });
});

describe("deriveEffectiveDocumentTaxYear - owner corrections", () => {
  const confirmedAt = null;
  const corrections = (value: unknown) => ({ version: 1, fields: { taxYear: { value, aiValue: 2025 } }, events: [] });

  it("a corrected taxYear wins over the AI value", () => {
    const year = deriveEffectiveDocumentTaxYear(
      { docType: "w2", extractionData: { data: { taxYear: 2025 } }, extractionCorrections: corrections(2024), extractionConfirmedAt: confirmedAt },
      NOW
    );
    expect(year).toBe(2024);
  });

  it("a corrected null wins (the owner says the year is blank)", () => {
    const year = deriveEffectiveDocumentTaxYear(
      { docType: "w2", extractionData: { data: { taxYear: 2025 } }, extractionCorrections: corrections(null), extractionConfirmedAt: confirmedAt },
      NOW
    );
    expect(year).toBeNull();
  });

  it("no corrections -> same as the AI value; statements are unaffected by the overlay", () => {
    expect(
      deriveEffectiveDocumentTaxYear(
        { docType: "w2", extractionData: { data: { taxYear: 2025 } }, extractionCorrections: null, extractionConfirmedAt: confirmedAt },
        NOW
      )
    ).toBe(2025);
    expect(
      deriveEffectiveDocumentTaxYear(
        {
          docType: "bank_statement",
          extractionData: stmt({ periodEnd: "2025-04-27" }),
          extractionCorrections: corrections(1999),
          extractionConfirmedAt: confirmedAt,
        },
        NOW
      )
    ).toBe(2025);
  });
});

describe("planYearFill", () => {
  const row = (id: string, docType: string, extractionData: unknown, extractionCorrections: unknown = null) => ({
    id,
    docType,
    extractionData,
    extractionCorrections,
    extractionConfirmedAt: null,
  });

  it("splits a mixed list into fills and skipped", () => {
    const plan = planYearFill(
      [
        row("a", "bank_statement", stmt({ periodEnd: "2025-04-27" })),
        row("b", "bank_statement", stmt({}, { period: "2024-11" })),
        row("c", "w2", { data: { taxYear: 2025 } }),
        row("d", "other", { data: {} }),
        row("e", "bank_statement", null),
        row("f", "w2", { data: { taxYear: 2025 } }, { version: 1, fields: { taxYear: { value: null, aiValue: 2025 } }, events: [] }),
      ],
      NOW
    );
    expect(plan.fills).toEqual([
      { id: "a", year: 2025 },
      { id: "b", year: 2024 },
      { id: "c", year: 2025 },
    ]);
    expect(plan.skippedNoYear).toBe(3);
  });

  it("an empty list plans nothing", () => {
    expect(planYearFill([], NOW)).toEqual({ fills: [], skippedNoYear: 0 });
  });
});

describe("buildYearFillConfirmMessage", () => {
  it("includes the count with correct singular/plural", () => {
    expect(buildYearFillConfirmMessage(9)).toContain("9 documents that currently have no year");
    expect(buildYearFillConfirmMessage(1)).toContain("1 document that currently has no year");
  });

  it("says it never changes an existing year, makes no AI calls, and covers the whole vault", () => {
    const msg = buildYearFillConfirmMessage(3);
    expect(msg).toMatch(/never changes a year that is already set/);
    expect(msg).toMatch(/no AI calls/);
    expect(msg).toMatch(/does not re-read any document/);
    expect(msg).toMatch(/whole vault/);
    expect(msg).toMatch(/period end date/);
    expect(msg).toMatch(/tax year/);
  });
});
