import { describe, it, expect, vi } from "vitest";
import {
  TAX_SCHEMAS,
  buildTaxExtractionPrompt,
  containsAccountNumberLikeText,
  crossFieldWarnings,
  getTaxSchema,
  isUsableTaxExtraction,
  normalizeTaxExtraction,
  schemaVersionFor,
  usableSignalKeys,
  validateCorrections,
} from "@/lib/tax-extraction-schema";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";
import { isUsableExtraction } from "@/lib/document-extraction-state";
import {
  RETIREMENT_BADGE_LABEL,
  RETIREMENT_PICKER_LABEL,
  retirementStatementSummary,
} from "@/lib/retirement-statement";

// The Anthropic SDK is mocked exactly like doc-extract.test.ts: no real API call.
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));
import { extractDocumentOrThrow } from "@/lib/doc-extract";

const schema = getTaxSchema("retirement_contribution");

// Box numbering verified against the 2025 Form 5498 (IRS) - see lib/tax-extraction-schema.ts.
const KEYS = [
  "taxYear",
  "formVariant",
  "issuerName",
  "accountKind",
  "iraContributionsCents", // box 1
  "rothIraContributionsCents", // box 10
  "sepContributionsCents", // box 8
  "simpleContributionsCents", // box 9
  "postponedContributionCents", // box 13a
  "postponedForYear", // box 13b
  "rolloverContributionsCents", // box 2
  "rothConversionCents", // box 3
  "recharacterizedContributionsCents", // box 4
  "fairMarketValueCents", // box 5
];

const BOX_BY_KEY: Record<string, string> = {
  iraContributionsCents: "box 1",
  rolloverContributionsCents: "box 2",
  rothConversionCents: "box 3",
  recharacterizedContributionsCents: "box 4",
  fairMarketValueCents: "box 5",
  sepContributionsCents: "box 8",
  simpleContributionsCents: "box 9",
  rothIraContributionsCents: "box 10",
  postponedContributionCents: "box 13a",
  postponedForYear: "box 13b",
};

const GOOD = {
  taxYear: 2025,
  formVariant: "form_5498",
  issuerName: "Betterment",
  accountKind: "traditional_ira",
  iraContributionsCents: 700000,
  rothIraContributionsCents: null,
  sepContributionsCents: null,
  simpleContributionsCents: null,
  postponedContributionCents: null,
  postponedForYear: null,
  rolloverContributionsCents: null,
  rothConversionCents: null,
  recharacterizedContributionsCents: null,
  fairMarketValueCents: 5123456,
};

describe("retirement_contribution registry shape", () => {
  it("has exactly the specified keys in order", () => {
    expect(schema.fields.map((f) => f.key)).toEqual(KEYS);
  });

  it("every box field cites its real Form 5498 box number", () => {
    for (const [key, box] of Object.entries(BOX_BY_KEY)) {
      const def = schema.fields.find((f) => f.key === key)!;
      expect(def.formRef.toLowerCase(), key).toContain(box);
    }
  });

  it("money fields are unsigned integer-cent fields; no feeds; every field is in a declared group", () => {
    const groups = new Set(schema.groups.map((g) => g.id));
    for (const f of schema.fields) {
      expect(groups.has(f.group), f.key).toBe(true);
      expect(f.feeds, f.key).toEqual([]);
      expect(f.legacy).toBe(false);
      expect(f.aiFills).toBe(true);
      if (f.kind === "money") expect(f.signed).toBeFalsy();
    }
  });

  it("has no participant identity, taxpayer id or account number key", () => {
    const forbidden = /ssn|tin\b|taxpayerid|participant|account(number|no|num)|accountNumber|address|^name$|holder/i;
    for (const f of schema.fields) {
      expect(f.key, f.key).not.toMatch(forbidden);
      expect(f.kind, f.key).not.toBe("mask");
      expect(f.kind, f.key).not.toBe("ein");
    }
  });

  it("is an expanded (version 2) schema registered for the raw docType", () => {
    expect(schemaVersionFor("retirement_contribution")).toBe(2);
    expect(TAX_SCHEMAS.retirement_contribution.docType).toBe("retirement_contribution");
  });

  it("every enum value has a plain-language label and none shows the raw key to the owner", () => {
    for (const key of ["formVariant", "accountKind"]) {
      const def = schema.fields.find((f) => f.key === key)!;
      for (const option of def.options ?? []) {
        const label = def.optionLabels?.[option];
        expect(label, `${key}.${option}`).toBeTruthy();
        expect(label).not.toContain("_");
      }
    }
  });
});

describe("retirement_contribution prompt", () => {
  const prompt = buildTaxExtractionPrompt("retirement_contribution");

  it("template lists exactly the registry keys (parity)", () => {
    const keys = [...prompt.matchAll(/"([A-Za-z0-9_]+)":/g)].map((m) => m[1]).filter((k) => k !== "docType" && k !== "summary" && k !== "data");
    expect(keys).toEqual(KEYS);
  });

  it("states the nulls-never-guess rule, one-box-per-field rule and the account number prohibition", () => {
    expect(prompt).toContain("Never guess");
    expect(prompt).toContain("Never add boxes together");
    expect(prompt).toMatch(/Do NOT output the account number or any part of it \(not even the last 4 digits\)/);
    expect(prompt).toContain("overrides the general rule on account numbers");
    expect(prompt).toContain("integer cents");
  });

  it("cites the verified box meanings", () => {
    expect(prompt).toContain("Form 5498 box 1");
    expect(prompt).toContain("Form 5498 box 10");
    expect(prompt).toContain("through April 15 of the next year");
    expect(prompt).toContain("Form 5498 box 13a");
    expect(prompt).toContain("Form 5498 box 13b");
  });
});

describe("retirement_contribution normalizer", () => {
  it("keeps a clean 5498 reading and stamps version 2", () => {
    const n = normalizeTaxExtraction("retirement_contribution", { docType: "retirement_contribution", summary: "Form 5498 for 2025", data: GOOD });
    expect(n.data).toEqual(GOOD);
    expect(n.schemaVersion).toBe(2);
    expect(n.warnings).toEqual([]);
  });

  it("gives null for everything absent (never a default or a zero)", () => {
    const n = normalizeTaxExtraction("retirement_contribution", { summary: "", data: {} });
    for (const k of KEYS) expect(n.data[k], k).toBeNull();
  });

  it("keeps a printed 0 as 0 but never turns null into 0", () => {
    const n = normalizeTaxExtraction("retirement_contribution", {
      data: { ...GOOD, iraContributionsCents: 0, rothIraContributionsCents: null },
    });
    expect(n.data.iraContributionsCents).toBe(0);
    expect(n.data.rothIraContributionsCents).toBeNull();
  });

  it("requires integer cents: floats, negatives and strings with decimals are cleared with a warning", () => {
    const n = normalizeTaxExtraction("retirement_contribution", {
      data: {
        ...GOOD,
        iraContributionsCents: 7000.5,
        sepContributionsCents: -100,
        simpleContributionsCents: "70.00",
        rothIraContributionsCents: "650000",
      },
    });
    expect(n.data.iraContributionsCents).toBeNull();
    expect(n.data.sepContributionsCents).toBeNull();
    expect(n.data.simpleContributionsCents).toBeNull();
    // a whole-number string is tolerated by the lenient AI-side normalizer (same as every other schema)
    expect(n.data.rothIraContributionsCents).toBe(650000);
    expect(n.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("drops identity / account-number keys the model adds on its own", () => {
    const n = normalizeTaxExtraction("retirement_contribution", {
      data: {
        ...GOOD,
        accountNumber: "123456789",
        participantName: "Eric Kinniburgh",
        participantTin: "***-**-1234",
        ssn: "123-45-6789",
        address: "27 Old Barry Rd",
      },
    });
    expect(Object.keys(n.data).sort()).toEqual([...KEYS].sort());
    expect(JSON.stringify(n)).not.toContain("123456789");
    expect(JSON.stringify(n)).not.toContain("Kinniburgh");
  });

  it("clears an issuer name that carries an account number or an SSN, and logs only a generic warning", () => {
    const withAccount = normalizeTaxExtraction("retirement_contribution", { data: { ...GOOD, issuerName: "Betterment acct 0012345678" } });
    expect(withAccount.data.issuerName).toBeNull();
    const withSsn = normalizeTaxExtraction("retirement_contribution", { data: { ...GOOD, issuerName: "Betterment 123-45-6789" } });
    expect(withSsn.data.issuerName).toBeNull();
    for (const n of [withAccount, withSsn]) {
      expect(n.warnings.join(" ")).not.toMatch(/\d{6,}/);
      expect(JSON.stringify(n)).not.toMatch(/0012345678|123-45-6789/);
    }
  });

  it("replaces a summary that contains an account number (and says so without repeating it)", () => {
    const n = normalizeTaxExtraction("retirement_contribution", { summary: "Form 5498 for account 998877665544", data: GOOD });
    expect(n.summary).toBe("Summary withheld: it contained text that looked like an account number.");
    expect(JSON.stringify(n)).not.toContain("998877665544");
    const ok = normalizeTaxExtraction("retirement_contribution", { summary: "Form 5498 for 2025 from Betterment", data: GOOD });
    expect(ok.summary).toBe("Form 5498 for 2025 from Betterment");
  });

  it("rejects an unknown kind or variant and an out-of-range year", () => {
    const n = normalizeTaxExtraction("retirement_contribution", {
      data: { ...GOOD, accountKind: "401k", formVariant: "1099-R", taxYear: 1850, postponedForYear: 3000 },
    });
    expect(n.data.accountKind).toBeNull();
    expect(n.data.formVariant).toBeNull();
    expect(n.data.taxYear).toBeNull();
    expect(n.data.postponedForYear).toBeNull();
  });

  it("accepts case differences in a kind (lenient AI side) and stores the canonical value", () => {
    const n = normalizeTaxExtraction("retirement_contribution", { data: { ...GOOD, accountKind: "Roth_IRA" } });
    expect(n.data.accountKind).toBe("roth_ira");
  });
});

describe("account-number detector", () => {
  it("flags long digit runs and grouped numbers; ignores years, dates, short amounts", () => {
    for (const bad of ["123456", "acct 0012345678", "123-456-7890", "1234 5678 9012", "１２３４５６７"]) {
      expect(containsAccountNumberLikeText(bad), bad).toBe(true);
    }
    for (const fine of ["Betterment", "Form 5498", "2025", "2025-04-15", "Roth IRA 2025 and 2026", "12345", "Fidelity Investments"]) {
      expect(containsAccountNumberLikeText(fine), fine).toBe(false);
    }
  });
});

describe("retirement_contribution corrections", () => {
  it("accepts owner values, null as blank, and rejects unknown keys, decimals and unknown words", () => {
    expect(validateCorrections("retirement_contribution", { iraContributionsCents: 650000, accountKind: "roth_ira", taxYear: 2025 })).toEqual({
      ok: true,
      fields: { iraContributionsCents: 650000, accountKind: "roth_ira", taxYear: 2025 },
    });
    expect(validateCorrections("retirement_contribution", { iraContributionsCents: null })).toEqual({ ok: true, fields: { iraContributionsCents: null } });
    expect(validateCorrections("retirement_contribution", { accountNumber: "1234" }).ok).toBe(false);
    expect(validateCorrections("retirement_contribution", { iraContributionsCents: 12.5 }).ok).toBe(false);
    expect(validateCorrections("retirement_contribution", { accountKind: "something" }).ok).toBe(false);
    expect(validateCorrections("retirement_contribution", { issuerName: "Acct 123456789" }).ok).toBe(false);
  });
});

describe("retirement_contribution usability and warnings", () => {
  it("is usable when any money box or the issuer name was read; not when everything is null", () => {
    expect(usableSignalKeys("retirement_contribution")).toEqual(
      expect.arrayContaining(["issuerName", "iraContributionsCents", "fairMarketValueCents"])
    );
    expect(isUsableTaxExtraction("retirement_contribution", { data: { iraContributionsCents: 0 } })).toBe(true);
    expect(isUsableTaxExtraction("retirement_contribution", { data: { issuerName: "Betterment" } })).toBe(true);
    expect(isUsableTaxExtraction("retirement_contribution", { data: { taxYear: 2025, accountKind: "roth_ira" } })).toBe(false);
    expect(isUsableExtraction("retirement_contribution", { docType: "retirement_contribution", summary: "x", data: { iraContributionsCents: 1 } })).toBe(true);
  });

  it("warns on a filed-under mismatch, kind/box mismatches and a late contribution without its year", () => {
    expect(crossFieldWarnings("retirement_contribution", { taxYear: 2025 }, { documentTaxYear: 2024 })).toEqual([
      "The form says tax year 2025 but this document is filed under 2024.",
    ]);
    const w = (data: Record<string, unknown>) => crossFieldWarnings("retirement_contribution", data).join(" | ");
    expect(w({ accountKind: "traditional_ira", rothIraContributionsCents: 100 })).toContain("Roth IRA contributions (box 10)");
    expect(w({ accountKind: "roth_ira", iraContributionsCents: 100 })).toContain("Traditional IRA contributions (box 1)");
    expect(w({ postponedContributionCents: 100 })).toContain("box 13b");
    expect(w({ taxYear: 2025, postponedContributionCents: 100, postponedForYear: 2025 })).toContain("before the statement's year");
    expect(w({ taxYear: 2025, accountKind: "traditional_ira", iraContributionsCents: 700000 })).toBe("");
  });
});

describe("retirementStatementSummary", () => {
  const eff = (data: Record<string, unknown>) => ({ docType: "retirement_contribution", summary: "", data });

  it("returns the figures per kind in integer cents, from an effective extraction", () => {
    const s = retirementStatementSummary(
      eff({
        ...GOOD,
        iraContributionsCents: 700000,
        rothIraContributionsCents: 650000,
        sepContributionsCents: 0,
        simpleContributionsCents: null,
        postponedContributionCents: 100000,
        postponedForYear: 2024,
        rolloverContributionsCents: 250000,
      })
    );
    expect(s.contributions).toEqual({ traditional_ira: 700000, roth_ira: 650000, sep_ira: 0, simple_ira: null });
    expect(s.kindsWithFigures).toEqual(["traditional_ira", "roth_ira", "sep_ira"]);
    expect(s.kindsWithContributions).toEqual(["traditional_ira", "roth_ira"]);
    expect(s.postponed).toEqual({ amountCents: 100000, forYear: 2024 });
    expect(s.other).toEqual({ rolloverCents: 250000, rothConversionCents: null, recharacterizedCents: null, fairMarketValueCents: 5123456 });
    expect(s).toMatchObject({ hasReading: true, taxYear: 2025, formVariant: "form_5498", issuerName: "Betterment", accountKind: "traditional_ira" });
  });

  it("works on the wrapper resolveEffectiveExtraction returns, with the owner's corrections winning", () => {
    const effective = resolveEffectiveExtraction({
      docType: "retirement_contribution",
      extractionData: eff({ ...GOOD, iraContributionsCents: 700000 }),
      extractionCorrections: { version: 1, fields: { iraContributionsCents: { value: 650000, aiValue: 700000 } }, events: [] },
      extractionConfirmedAt: null,
    });
    expect(retirementStatementSummary(effective).contributions.traditional_ira).toBe(650000);
    expect(retirementStatementSummary(effective.extractionData).contributions.traditional_ira).toBe(650000);
    // a corrected null clears the AI figure
    const cleared = resolveEffectiveExtraction({
      docType: "retirement_contribution",
      extractionData: eff({ ...GOOD }),
      extractionCorrections: { version: 1, fields: { iraContributionsCents: { value: null, aiValue: 700000 } }, events: [] },
      extractionConfirmedAt: null,
    });
    expect(retirementStatementSummary(cleared).contributions.traditional_ira).toBeNull();
  });

  it("never guesses: floats, negatives, strings, unknown words and garbage read as not stated", () => {
    const s = retirementStatementSummary(
      eff({
        iraContributionsCents: 7000.5,
        rothIraContributionsCents: -1,
        sepContributionsCents: "100",
        simpleContributionsCents: Number.NaN,
        accountKind: "401k",
        formVariant: "whatever",
        taxYear: "2025",
        issuerName: "   ",
      })
    );
    expect(s.contributions).toEqual({ traditional_ira: null, roth_ira: null, sep_ira: null, simple_ira: null });
    expect(s).toMatchObject({ accountKind: null, formVariant: null, taxYear: null, issuerName: null, hasReading: false });
    for (const junk of [null, undefined, 5, "x", [], { data: "x" }, { data: [] }]) {
      const out = retirementStatementSummary(junk);
      expect(out.hasReading).toBe(false);
      expect(out.kindsWithFigures).toEqual([]);
    }
  });

  it("a 401(k) plan statement with only a name and kind still reads as something, with no contribution figures", () => {
    const s = retirementStatementSummary(eff({ issuerName: "Fidelity NetBenefits", accountKind: "employer_plan", formVariant: "other_statement" }));
    expect(s.hasReading).toBe(true);
    expect(s.accountKind).toBe("employer_plan");
    expect(s.kindsWithFigures).toEqual([]);
  });

  it("is pure: does not mutate its input", () => {
    const input = eff({ ...GOOD });
    const copy = JSON.parse(JSON.stringify(input));
    retirementStatementSummary(input);
    expect(input).toEqual(copy);
  });

  it("carries the plain-language picker and badge wording", () => {
    expect(RETIREMENT_PICKER_LABEL).toBe("Retirement contributions (IRA / 401(k) statement or Form 5498)");
    expect(RETIREMENT_BADGE_LABEL).toBe("Retirement");
  });
});

describe("retirement_contribution through the model call (mocked, no real API)", () => {
  it("normalizes the model's reply and drops an account number the model volunteered", async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            docType: "retirement_contribution",
            summary: "Betterment Form 5498 for 2025",
            data: { ...GOOD, accountNumber: "5551234567" },
          }),
        },
      ],
    });
    const out = await extractDocumentOrThrow(Buffer.from("x"), "application/pdf", "retirement_contribution");
    expect(out.docType).toBe("retirement_contribution");
    expect(out.schemaVersion).toBe(2);
    expect(out.data.iraContributionsCents).toBe(700000);
    expect(JSON.stringify(out)).not.toContain("5551234567");
    const sent = JSON.stringify(mockCreate.mock.calls[0]);
    expect(sent).toContain("Form 5498");
  });
});
