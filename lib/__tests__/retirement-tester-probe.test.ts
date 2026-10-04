import { describe, it, expect } from "vitest";
import {
  TAX_SCHEMAS,
  buildTaxExtractionPrompt,
  containsAccountNumberLikeText,
  crossFieldWarnings,
  normalizeTaxExtraction,
  schemaTypeForDocType,
  usableSignalKeys,
  validateCorrections,
} from "@/lib/tax-extraction-schema";
import { retirementStatementSummary } from "@/lib/retirement-statement";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";
import { refreshAutoNameForYear } from "@/lib/document-rename";
import { generateDocumentName } from "@/lib/doc-naming";
import { deriveEffectiveDocumentTaxYear } from "@/lib/document-year";
import { isUsableExtraction } from "@/lib/document-extraction-state";
import { classifyDocType } from "@/lib/doc-extract";

// Independent tester probes for retirement-contribution-document-type. Own oracle values
// (Form 5498 box numbers read from the IRS 2025 form text), not copied from the Coder's tests.

const RET = "retirement_contribution" as const;
const schema = TAX_SCHEMAS[RET];
const moneyKeys = schema.fields.filter((f) => f.kind === "money").map((f) => f.key);

function norm(data: Record<string, unknown>, summary = "ok") {
  return normalizeTaxExtraction(RET, { docType: RET, summary, data });
}

describe("schema shape", () => {
  it("has exactly the 14 documented fields; boxes 1/2/3/4/5/8/9/10/13a/13b are all present, no identity fields", () => {
    expect(schema.fields.map((f) => f.key).sort()).toEqual(
      [
        "taxYear", "formVariant", "issuerName", "accountKind",
        "iraContributionsCents", "rothIraContributionsCents", "sepContributionsCents", "simpleContributionsCents",
        "postponedContributionCents", "postponedForYear",
        "rolloverContributionsCents", "rothConversionCents", "recharacterizedContributionsCents", "fairMarketValueCents",
      ].sort()
    );
    for (const f of schema.fields) {
      expect(f.key).not.toMatch(/tin$|ssn|itin|accountnumber|acct|participant|address/i);
      expect(f.kind).not.toBe("mask");
      expect(f.kind).not.toBe("ein");
    }
    expect(schemaTypeForDocType(RET)).toBe(RET);
  });

  it("formRefs point at the real box numbers", () => {
    const ref = (k: string) => schema.fields.find((f) => f.key === k)?.formRef;
    expect(ref("iraContributionsCents")).toMatch(/box 1$/);
    expect(ref("rolloverContributionsCents")).toMatch(/box 2$/);
    expect(ref("rothConversionCents")).toMatch(/box 3$/);
    expect(ref("recharacterizedContributionsCents")).toMatch(/box 4$/);
    expect(ref("fairMarketValueCents")).toMatch(/box 5$/);
    expect(ref("accountKind")).toMatch(/box 7$/);
    expect(ref("sepContributionsCents")).toMatch(/box 8$/);
    expect(ref("simpleContributionsCents")).toMatch(/box 9$/);
    expect(ref("rothIraContributionsCents")).toMatch(/box 10$/);
    expect(ref("postponedContributionCents")).toMatch(/box 13a$/);
    expect(ref("postponedForYear")).toMatch(/box 13b$/);
  });

  it("feeds nothing (no Forms readiness / engine wiring)", () => {
    for (const f of schema.fields) expect(f.feeds).toEqual([]);
  });

  it("usable signal = the 10 money fields + issuerName; a 0 counts, all-null does not", () => {
    expect(usableSignalKeys(RET).sort()).toEqual([...moneyKeys, "issuerName"].sort());
    const zero = norm({ iraContributionsCents: 0 });
    expect(isUsableExtraction(RET, zero)).toBe(true);
    expect(isUsableExtraction(RET, norm({ accountKind: "employer_plan", formVariant: "other_statement", taxYear: 2025 }))).toBe(false);
    expect(isUsableExtraction(RET, norm({ issuerName: "Betterment" }))).toBe(true);
  });
});

describe("money normalisation (integer cents or null)", () => {
  const cases: [string, unknown, number | null][] = [
    ["integer", 123450, 123450],
    ["zero", 0, 0],
    ["negative zero", -0, 0],
    ["negative", -500, null],
    ["float", 1234.5, null],
    ["dollar string", "$1,234.50", null],
    ["words", "about $50", null],
    ["numeric string (lenient digits only, by design)", "5000", 5000],
    ["exponent string", "1e3", null],
    ["exponent number (JSON 1e3 is the integer 1000)", 1e3, 1000],
    ["huge", 1e30, null],
    ["unsafe integer", 2 ** 53, null],
    ["NaN", Number.NaN, null],
    ["Infinity", Number.POSITIVE_INFINITY, null],
    ["boolean", true, null],
    ["array", [1], null],
    ["object", { a: 1 }, null],
    ["empty string", "", null],
    ["null", null, null],
  ];
  for (const k of ["iraContributionsCents", "rothIraContributionsCents", "sepContributionsCents", "simpleContributionsCents", "postponedContributionCents", "fairMarketValueCents"]) {
    it.each(cases)(`${k}: %s`, (_n, input, expected) => {
      const out = norm({ [k]: input });
      expect(out.data[k]).toBe(expected);
      expect(Object.is(out.data[k], -0)).toBe(false);
    });
  }

  it("a key the model invents (account number, TIN, last4) is dropped, not stored", () => {
    const out = norm({
      accountNumber: "123456789012", participantTIN: "123-45-6789", accountLast4: "9012", participantName: "Eric K",
      iraContributionsCents: 650000,
    });
    expect(Object.keys(out.data).sort()).toEqual(schema.fields.map((f) => f.key).sort());
    expect(JSON.stringify(out)).not.toMatch(/123456789012|123-45-6789|9012|Eric K/);
  });

  it("an absent key is null (never guessed); the schema version is stamped", () => {
    const out = norm({});
    for (const f of schema.fields) expect(out.data[f.key]).toBeNull();
    expect(out.schemaVersion).toBe(2);
  });
});

describe("account numbers never stored or echoed", () => {
  const leaks = ["123456789012", "1234 5678 9012", "123-456-789", "000123456", "X12345678"];
  it.each(leaks)("issuerName containing %s is cleared; warnings do not echo digits", (n) => {
    const out = norm({ issuerName: `Betterment ${n}` });
    if (containsAccountNumberLikeText(`Betterment ${n}`)) {
      expect(out.data.issuerName).toBeNull();
      expect(out.warnings.join(" ")).not.toMatch(/\d{3,}/);
    }
  });
  it("the plain digit-run and grouped shapes are caught", () => {
    expect(containsAccountNumberLikeText("Acct 123456789012")).toBe(true);
    expect(containsAccountNumberLikeText("Acct 1234 5678 9012")).toBe(true);
    expect(containsAccountNumberLikeText("Acct 123-456-789")).toBe(true);
  });
  it("normal values are not falsely cleared: years, short numbers, names", () => {
    for (const s of ["Betterment LLC", "Vanguard Fiduciary Trust Company", "Charles Schwab & Co., Inc.", "Form 5498 for 2025", "Fidelity (2025)", "Box 1 $6,500.00", "E*TRADE Savings Bank"]) {
      expect(containsAccountNumberLikeText(s), s).toBe(false);
    }
    expect(norm({ issuerName: "Betterment LLC" }).data.issuerName).toBe("Betterment LLC");
  });
  it("a summary carrying an account number is replaced, without the digits; SSN-shaped summary stays replaced", () => {
    const out = norm({ issuerName: "Betterment" }, "IRA contribution statement for account 8765432109 in 2025");
    expect(out.summary).not.toMatch(/\d{5,}/);
    expect(out.summary).toMatch(/withheld/i);
    expect(out.warnings.join(" ")).not.toMatch(/\d{4,}/);
    const ssn = norm({ issuerName: "Betterment" }, "for 123-45-6789");
    expect(ssn.summary).not.toMatch(/6789/);
  });
  it("owner correction of issuerName with an account number is rejected without echoing it (strict)", () => {
    const res = validateCorrections(RET, { issuerName: "Betterment 998877665544" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toMatch(/998877665544/);
  });
  it("KNOWN GAP (documented, low): a bare last-4 in the summary is NOT stripped by the normalizer (prompt only)", () => {
    const out = norm({ issuerName: "Betterment" }, "Roth IRA account ending in 4821");
    expect(out.summary).toContain("4821");
  });
});

describe("prompt", () => {
  const prompt = buildTaxExtractionPrompt(RET);
  it("forbids account number incl. last 4, and the override comes after the generic 'last 4' rule", () => {
    expect(prompt).toMatch(/not even the last 4/i);
    const generic = prompt.indexOf("Loan and account numbers: last 4 characters only.");
    const override = prompt.indexOf("this overrides the general rule on account numbers");
    expect(generic).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(generic);
  });
  it("asks for no participant name/TIN, none of the identity keys appear as JSON keys", () => {
    for (const k of ["accountNumber", "participantTin", "participantName", "accountLast4", "tin\""]) {
      expect(prompt.toLowerCase()).not.toContain(`"${k.toLowerCase().replace('"', "")}"`);
    }
  });
  it("describes each box on its own field and warns SEP+Roth both checked -> null", () => {
    expect(prompt).toMatch(/If both SEP and Roth IRA are checked/);
    expect(prompt).toMatch(/Box 1 only/);
    expect(prompt).toMatch(/Box 10 only/);
    expect(prompt).toMatch(/Box 8 only/);
    expect(prompt).toMatch(/Box 9 only/);
  });
  it("classifyDocType maps the new type and never guesses it from a file name", () => {
    expect(classifyDocType(RET, "x.pdf")).toBe(RET);
    expect(classifyDocType("other", "5498-betterment.pdf")).not.toBe(RET);
    expect(classifyDocType("other", "ira-contribution-statement.pdf")).not.toBe(RET);
  });
});

describe("crossFieldWarnings", () => {
  const w = (data: Record<string, unknown>, ctx = {}) => crossFieldWarnings(RET, data, ctx);
  it("no warnings on a clean traditional-only 5498", () => {
    expect(w({ taxYear: 2025, accountKind: "traditional_ira", iraContributionsCents: 700000, rothIraContributionsCents: null })).toEqual([]);
  });
  it("Roth amount on a traditional account warns; traditional amount on a Roth warns; 0 does not", () => {
    expect(w({ accountKind: "traditional_ira", rothIraContributionsCents: 100 })).toHaveLength(1);
    expect(w({ accountKind: "roth_ira", iraContributionsCents: 100 })).toHaveLength(1);
    expect(w({ accountKind: "roth_ira", iraContributionsCents: 0 })).toEqual([]);
    expect(w({ accountKind: "traditional_ira", rothIraContributionsCents: 0 })).toEqual([]);
  });
  it("null kind (Roth SEP / both checked) never produces a kind-mismatch warning", () => {
    expect(w({ accountKind: null, rothIraContributionsCents: 100, sepContributionsCents: 100 })).toEqual([]);
  });
  it("13a without 13b warns; 13b not before the form year warns; blank 13b with no 13a does not", () => {
    expect(w({ taxYear: 2025, postponedContributionCents: 100 }).length).toBe(1);
    expect(w({ taxYear: 2025, postponedContributionCents: 100, postponedForYear: 2024 })).toEqual([]);
    expect(w({ taxYear: 2025, postponedContributionCents: 100, postponedForYear: 2025 }).length).toBe(1);
    expect(w({ taxYear: 2025 })).toEqual([]);
  });
  it("filed-under year mismatch uses the shared warning", () => {
    expect(w({ taxYear: 2025 }, { documentTaxYear: 2024 }).length).toBe(1);
  });
  it("warning text never contains digits of an account number (it is a fixed string)", () => {
    for (const s of w({ accountKind: "roth_ira", iraContributionsCents: 99999999, postponedContributionCents: 5 })) {
      expect(s).not.toMatch(/\d{5,}/);
    }
  });
});

describe("retirementStatementSummary per-kind cents", () => {
  const eff = (data: Record<string, unknown>) =>
    resolveEffectiveExtraction({
      docType: RET,
      extractionData: { docType: RET, summary: "s", data, schemaVersion: 2, warnings: [] },
      extractionCorrections: null,
      extractionConfirmedAt: null,
    });
  it("maps traditional=box1, roth=box10, sep=box8, simple=box9 (no cross-wiring)", () => {
    const s = retirementStatementSummary(
      eff({ iraContributionsCents: 1, rothIraContributionsCents: 10, sepContributionsCents: 8, simpleContributionsCents: 9, rolloverContributionsCents: 2, rothConversionCents: 3, recharacterizedContributionsCents: 4, fairMarketValueCents: 5 })
    );
    expect(s.contributions).toEqual({ traditional_ira: 1, roth_ira: 10, sep_ira: 8, simple_ira: 9 });
    expect(s.other).toEqual({ rolloverCents: 2, rothConversionCents: 3, recharacterizedCents: 4, fairMarketValueCents: 5 });
    expect(s.kindsWithContributions).toEqual(["traditional_ira", "roth_ira", "sep_ira", "simple_ira"]);
  });
  it("accepts both the resolveEffectiveExtraction wrapper and the bare extraction", () => {
    const e = eff({ rothIraContributionsCents: 650000 });
    expect(retirementStatementSummary(e).contributions.roth_ira).toBe(650000);
    expect(retirementStatementSummary(e.extractionData).contributions.roth_ira).toBe(650000);
  });
  it("owner correction overrides the AI figure and a corrected null blanks it", () => {
    const e = resolveEffectiveExtraction({
      docType: RET,
      extractionData: { docType: RET, summary: "", data: { iraContributionsCents: 100, rothIraContributionsCents: 200 }, schemaVersion: 2, warnings: [] },
      extractionCorrections: { version: 1, events: [], fields: { iraContributionsCents: { value: 700000, aiValue: 100 }, rothIraContributionsCents: { value: null, aiValue: 200 } } },
      extractionConfirmedAt: new Date(),
    });
    const s = retirementStatementSummary(e);
    expect(s.contributions.traditional_ira).toBe(700000);
    expect(s.contributions.roth_ira).toBeNull();
  });
  it("a printed 0 stays 0 (stated) and is distinct from null", () => {
    const s = retirementStatementSummary(eff({ iraContributionsCents: 0 }));
    expect(s.contributions.traditional_ira).toBe(0);
    expect(s.kindsWithFigures).toEqual(["traditional_ira"]);
    expect(s.kindsWithContributions).toEqual([]);
  });
  it("junk never throws and reads as null", () => {
    for (const junk of [null, undefined, 5, "x", [], [1], {}, { extractionData: null }, { extractionData: "x" }, { extractionData: { data: "x" } }, { data: { iraContributionsCents: "700000" } }, { data: { iraContributionsCents: 1.5, rothIraContributionsCents: -1, sepContributionsCents: NaN, simpleContributionsCents: 2 ** 60 } }]) {
      const s = retirementStatementSummary(junk);
      expect(s.contributions).toEqual({ traditional_ira: null, roth_ira: null, sep_ira: null, simple_ira: null });
      expect(s.hasReading).toBe(false);
    }
  });
  it("does not mutate its input", () => {
    const e = eff({ iraContributionsCents: 5 });
    const before = JSON.stringify(e);
    retirementStatementSummary(e);
    expect(JSON.stringify(e)).toBe(before);
  });
  it("unknown account kind / variant words read as null", () => {
    const s = retirementStatementSummary(eff({ accountKind: "brokerage", formVariant: "1099" }));
    expect(s.accountKind).toBeNull();
    expect(s.formVariant).toBeNull();
  });
});

describe("document year + name for the new type", () => {
  it("year comes from data.taxYear (form header), corrected overlay wins", () => {
    const row = { docType: RET, extractionData: { data: { taxYear: 2025 } }, extractionCorrections: null, extractionConfirmedAt: null };
    expect(deriveEffectiveDocumentTaxYear(row, 2026)).toBe(2025);
    expect(deriveEffectiveDocumentTaxYear({ ...row, extractionCorrections: { version: 1, events: [], fields: { taxYear: { value: 2024, aiValue: 2025 } } } }, 2026)).toBe(2024);
    expect(deriveEffectiveDocumentTaxYear({ ...row, extractionData: { data: { taxYear: "2025" } } }, 2026)).toBeNull();
    expect(deriveEffectiveDocumentTaxYear({ ...row, extractionData: { data: { taxYear: 2025.5 } } }, 2026)).toBeNull();
  });
  it("name = trustee + year; falls back to label", () => {
    expect(generateDocumentName(RET, 2025, { docType: "other", data: { issuerName: "Betterment", taxYear: 2025 } })).toBe("Retirement Contributions — Betterment (2025)");
    expect(generateDocumentName(RET, null, null)).toBe("Retirement Contributions");
  });
});

describe("refreshAutoNameForYear adversarial", () => {
  const base = { docType: "property_tax", oldYears: [2025, 2024], newYear: 2025, dataVariants: [{ taxYear: 2024 }] };
  it("Eric's case", () => {
    expect(refreshAutoNameForYear({ ...base, documentName: "Property Tax Bill (2024)" })).toBe("Property Tax Bill (2025)");
  });
  it.each([
    "Property Tax Bill (2024) - Barry Rd",
    "property tax bill (2024)",
    "Property Tax Bill (2024) ",
    " My taxes",
    "Property Tax Bill  (2024)",
    "Property Tax Bill (2023)",
    "2024 property tax",
    "Property Tax Bill (2024)​",
    "‘Property Tax Bill (2024)",
    "Property Tax Bill (2024); (2024)",
    "x".repeat(300),
  ])("owner-typed %j is left alone (or only whitespace-trim equal)", (name) => {
    const out = refreshAutoNameForYear({ ...base, documentName: name });
    // The one tolerated case: trailing-space variant trims to the exact auto name.
    if (name === "Property Tax Bill (2024) ") expect(out).toBe("Property Tax Bill (2025)");
    else expect(out).toBeNull();
  });
  it("null / empty / whitespace name -> null (never invents a name for an unnamed document)", () => {
    expect(refreshAutoNameForYear({ ...base, documentName: null })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, documentName: "" })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, documentName: "   " })).toBeNull();
  });
  it("newYear null / non-integer / unchanged -> null", () => {
    expect(refreshAutoNameForYear({ ...base, documentName: "Property Tax Bill (2024)", newYear: null })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, documentName: "Property Tax Bill (2024)", newYear: 2025.5 })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, documentName: "Property Tax Bill (2025)", oldYears: [2025], dataVariants: [{ taxYear: 2025 }], newYear: 2025 })).toBeNull();
  });
  it("junk in oldYears / empty dataVariants does not throw", () => {
    expect(() =>
      refreshAutoNameForYear({ docType: "w2", documentName: "W-2 (2024)", oldYears: [undefined, null, Number.NaN, 1.5], newYear: 2025, dataVariants: [] })
    ).not.toThrow();
  });
  it("W-2 with employer keeps the employer; only the year changes", () => {
    expect(
      refreshAutoNameForYear({ docType: "w2", documentName: "W-2 — Acme (2024)", oldYears: [2025, 2024], newYear: 2025, dataVariants: [{ employerName: "Acme", taxYear: 2024 }] })
    ).toBe("W-2 — Acme (2025)");
  });
  it("RISK (documented): an owner-typed name identical to the auto name IS refreshed", () => {
    expect(refreshAutoNameForYear({ ...base, documentName: "Property Tax Bill (2024)" })).not.toBeNull();
  });
  it("retirement statement name follows a year correction", () => {
    expect(
      refreshAutoNameForYear({
        docType: RET,
        documentName: "Retirement Contributions — Betterment (2024)",
        oldYears: [2025, 2024],
        newYear: 2025,
        dataVariants: [{ issuerName: "Betterment", taxYear: 2024 }],
      })
    ).toBe("Retirement Contributions — Betterment (2025)");
  });
});
