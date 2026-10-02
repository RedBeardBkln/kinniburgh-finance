import { describe, it, expect } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  EXPANDED_RAW_DOC_TYPES,
  TAX_SCHEMAS,
  TAX_SCHEMA_DOC_TYPES,
  buildTaxExtractionPrompt,
  centsToDollarsInput,
  containsSsnLikeText,
  crossFieldWarnings,
  deriveLegacyKeys,
  dollarsInputToCents,
  formatCentsDisplay,
  getFieldDef,
  isUsableTaxExtraction,
  normalizeTaxExtraction,
  promptFields,
  schemaTypeForDocType,
  schemaVersionFor,
  sumCtWithholding,
  sumInstallmentsDueInYear,
  usableSignalKeys,
  validateCorrections,
} from "@/lib/tax-extraction-schema";

const SSN_ANYWHERE = /\b\d{3}-?\d{2}-?\d{4}\b/;

describe("registry shape", () => {
  it("has every tax schema type and maps raw docTypes to it (mortgage_interest -> form_1098)", () => {
    expect([...TAX_SCHEMA_DOC_TYPES].sort()).toEqual(["1099", "form_1098", "k1", "property_tax", "tax_return", "w2"]);
    expect(schemaTypeForDocType("mortgage_interest")).toBe("form_1098");
    expect(schemaTypeForDocType("form_1098")).toBe("form_1098");
    expect(schemaTypeForDocType("w2")).toBe("w2");
    expect(schemaTypeForDocType("property_tax")).toBe("property_tax");
    expect(schemaTypeForDocType("mortgage_statement")).toBeNull();
    expect(schemaTypeForDocType("extension")).toBeNull();
    expect(schemaTypeForDocType("other")).toBeNull();
  });

  it("expanded schemas are version 2; tax_return keeps its unchanged version 1", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    for (const t of ["w2", "1099", "form_1098", "property_tax", "k1"] as const) expect(schemaVersionFor(t)).toBe(2);
    expect(schemaVersionFor("tax_return")).toBe(1);
    expect([...EXPANDED_RAW_DOC_TYPES].sort()).toEqual(["1099", "k1", "mortgage_interest", "property_tax", "w2"]);
  });

  it("has unique keys per schema and every field belongs to a declared group", () => {
    for (const type of TAX_SCHEMA_DOC_TYPES) {
      const schema = TAX_SCHEMAS[type];
      const keys = schema.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      const groups = new Set(schema.groups.map((g) => g.id));
      for (const f of schema.fields) expect(groups.has(f.group)).toBe(true);
    }
  });

  it("NO field can hold an SSN / ITIN / taxpayer id (not even last 4)", () => {
    const forbidden = /ssn|itin|taxpayerid|last4|tin$/i;
    for (const type of TAX_SCHEMA_DOC_TYPES) {
      for (const f of TAX_SCHEMAS[type].fields) {
        expect(f.key).not.toMatch(forbidden);
        for (const item of f.itemFields ?? []) expect(item.key).not.toMatch(forbidden);
      }
    }
  });

  it("keeps ALL pre-existing flat keys so older documents and resolvers keep working", () => {
    const legacyKeys: Record<string, string[]> = {
      w2: [
        "taxYear",
        "employerName",
        "employerEIN",
        "wagesCents",
        "federalWithheldCents",
        "stateWithheldCents",
        "socialSecurityWagesCents",
        "medicareWagesCents",
      ],
      "1099": ["taxYear", "formVariant", "payerName", "payerEIN", "amountCents", "federalWithheldCents"],
      k1: [
        "taxYear",
        "formType",
        "entityName",
        "entityEIN",
        "partnerSharePct",
        "ordinaryIncomeCents",
        "guaranteedPaymentsCents",
        "distributionsCents",
        "capitalAccountCents",
      ],
      form_1098: ["servicerName", "loanNumber", "principalBalanceCents", "interestCents", "propertyAddress"],
      tax_return: [
        "taxYear",
        "formType",
        "taxpayerName",
        "agiCents",
        "totalTaxCents",
        "refundCents",
        "balanceDueCents",
        "filingStatus",
      ],
    };
    for (const [type, keys] of Object.entries(legacyKeys)) {
      const schema = TAX_SCHEMAS[type as keyof typeof TAX_SCHEMAS];
      for (const key of keys) expect(schema.fields.some((f) => f.key === key)).toBe(true);
    }
  });

  it("the Forms feeds reference real catalog ids", () => {
    const known = new Set(["form-1040", "schedule-a", "ct-1040", "ct-schedule-3", "additional-medicare-tax"]);
    for (const type of TAX_SCHEMA_DOC_TYPES) {
      for (const f of TAX_SCHEMAS[type].fields) {
        for (const feed of f.feeds) expect(known.has(feed.formId)).toBe(true);
      }
    }
    // property tax lines are fed ONLY by the owner-entered "paid in the tax year" value
    const feedsScheduleA = TAX_SCHEMAS.property_tax.fields.filter((f) => f.feeds.some((x) => x.formId === "schedule-a"));
    expect(feedsScheduleA.map((f) => f.key)).toEqual(["paidInTaxYearCents"]);
    expect(getFieldDef("property_tax", "paidInTaxYearCents")?.aiFills).toBe(false);
  });
});

describe("prompts are generated from the registry (one source of truth)", () => {
  for (const type of TAX_SCHEMA_DOC_TYPES) {
    it(`${type}: every registry key is in the prompt JSON template and nothing else is`, () => {
      const prompt = buildTaxExtractionPrompt(type);
      const templateKeys = new Set([...prompt.matchAll(/"([A-Za-z0-9_]+)":/g)].map((m) => m[1]!));
      const expected = new Set<string>(["docType", "summary", "data"]);
      for (const f of promptFields(type)) {
        expected.add(f.key);
        for (const item of f.itemFields ?? []) expected.add(item.key);
      }
      expect([...templateKeys].sort()).toEqual([...expected].sort());
      // the field guide lists each asked-for key too
      for (const f of promptFields(type)) expect(prompt).toContain(`- ${f.key}:`);
      expect(prompt).toContain(`"docType": "${type}"`);
    });

    it(`${type}: the prompt carries the SSN rule and the integer-cents rule`, () => {
      const prompt = buildTaxExtractionPrompt(type);
      expect(prompt).toMatch(/never output a Social Security Number, ITIN or taxpayer ID/i);
      expect(prompt).toMatch(/integer cents/);
      expect(prompt).toMatch(/NN-NNNNNNN/);
    });
  }

  it("the legacy W-2 stateWithheldCents is NOT asked for (it is derived from stateLines)", () => {
    const prompt = buildTaxExtractionPrompt("w2");
    expect(prompt).not.toMatch(/"stateWithheldCents": 0,\n/);
    expect(promptFields("w2").some((f) => f.key === "stateWithheldCents")).toBe(false);
    expect(getFieldDef("w2", "stateWithheldCents")?.legacy).toBe(true);
  });

  it("property tax: the prompt tells the model to ALWAYS leave paidInTaxYearCents null", () => {
    expect(buildTaxExtractionPrompt("property_tax")).toMatch(/paidInTaxYearCents must ALWAYS be null/);
  });

  it("1099 prompt explains the consolidated handling and the variant prefixes", () => {
    const prompt = buildTaxExtractionPrompt("1099");
    expect(prompt).toMatch(/consolidated/);
    for (const prefix of ["nec_box1Cents", "int_box1Cents", "div_box1aCents", "misc_box1Cents", "otherBoxes"]) {
      expect(prompt).toContain(prefix);
    }
  });
});

describe("normalizeTaxExtraction", () => {
  const w2Raw = {
    docType: "w2",
    summary: "W-2 from Acme for 2025.",
    data: {
      taxYear: 2025,
      employerName: "Acme Corp",
      employerEIN: "12-3456789",
      wagesCents: 5000000,
      federalWithheldCents: 800000,
      socialSecurityWagesCents: 5000000,
      socialSecurityWithheldCents: 310000,
      medicareWagesCents: 5000000,
      medicareWithheldCents: 72500,
      box12: [
        { code: "d", amountCents: 600000 },
        { code: "DD", amountCents: 1200000 },
      ],
      retirementPlan: true,
      statutoryEmployee: false,
      stateLines: [
        { stateCode: "ct", stateEmployerId: "9999", stateWagesCents: 5000000, stateWithheldCents: 150000 },
        { stateCode: "NY", stateEmployerId: null, stateWagesCents: 100000, stateWithheldCents: 5000 },
      ],
    },
  };

  it("keeps good values, stamps schemaVersion, upper-cases codes, derives the legacy CT withholding", () => {
    const out = normalizeTaxExtraction("w2", w2Raw);
    expect(out.docType).toBe("w2");
    expect(out.schemaVersion).toBe(2);
    expect(out.summary).toBe("W-2 from Acme for 2025.");
    expect(out.data.wagesCents).toBe(5000000);
    expect(out.data.employerEIN).toBe("12-3456789");
    expect(out.data.box12).toEqual([
      { code: "D", amountCents: 600000 },
      { code: "DD", amountCents: 1200000 },
    ]);
    expect(out.data.stateLines).toEqual([
      { stateCode: "CT", stateEmployerId: "9999", stateWagesCents: 5000000, stateWithheldCents: 150000 },
      { stateCode: "NY", stateEmployerId: null, stateWagesCents: 100000, stateWithheldCents: 5000 },
    ]);
    // Legacy flat key = CT lines only (older resolvers read it as CT withholding).
    expect(out.data.stateWithheldCents).toBe(150000);
    // Anything not present is explicitly null.
    expect(out.data.dependentCareBenefitsCents).toBeNull();
    expect(out.warnings).toEqual([]);
  });

  it("drops unknown keys (including anything SSN-like the model volunteered)", () => {
    const out = normalizeTaxExtraction("w2", {
      ...w2Raw,
      data: { ...w2Raw.data, employeeSSN: "123-45-6789", ssn: "123456789", last4: "6789", recipientTIN: "123-45-6789" },
    });
    const keys = Object.keys(out.data);
    for (const k of ["employeeSSN", "ssn", "last4", "recipientTIN"]) expect(keys).not.toContain(k);
    expect(JSON.stringify(out)).not.toMatch(SSN_ANYWHERE);
  });

  it("nulls SSN-shaped strings anywhere (fields, nested list rows) and records a warning", () => {
    const out = normalizeTaxExtraction("w2", {
      ...w2Raw,
      data: {
        ...w2Raw.data,
        employerName: "123-45-6789",
        stateLines: [{ stateCode: "CT", stateEmployerId: "123456789", stateWagesCents: 1, stateWithheldCents: 2 }],
        box14: [{ label: "SSN 987-65-4321", amountCents: 5 }],
      },
    });
    expect(out.data.employerName).toBeNull();
    expect((out.data.stateLines as { stateEmployerId: unknown }[])[0]?.stateEmployerId).toBeNull();
    expect((out.data.box14 as { label: unknown }[])[0]?.label).toBeNull();
    expect(out.warnings).toContain("removed text that looked like an SSN");
    expect(JSON.stringify(out)).not.toMatch(SSN_ANYWHERE);
  });

  it("replaces an SSN-bearing summary", () => {
    const out = normalizeTaxExtraction("w2", { ...w2Raw, summary: "W-2 for John, SSN 123-45-6789, from Acme." });
    expect(out.summary).not.toMatch(SSN_ANYWHERE);
    expect(out.summary).toMatch(/withheld/i);
    expect(out.warnings).toContain("removed text that looked like an SSN");
  });

  describe("SSN scrub separator variants (NFKC + any dash/space/dot)", () => {
    const variants: [string, string][] = [
      ["hyphen", "123-45-6789"],
      ["bare", "123456789"],
      ["space", "123 45 6789"],
      ["dot", "123.45.6789"],
      ["en dash U+2013", "123–45–6789"],
      ["em dash U+2014", "123—45—6789"],
      ["non-breaking hyphen U+2011", "123‑45‑6789"],
      ["minus sign U+2212", "123−45−6789"],
      ["non-breaking space U+00A0", "123 45 6789"],
      ["fullwidth digits", "１２３４５６７８９"],
      ["fullwidth digits + fullwidth hyphen", "１２３－４５－６７８９"],
      ["mixed separators", "123-45 6789"],
    ];

    for (const [name, ssn] of variants) {
      it(`containsSsnLikeText catches ${name}`, () => {
        expect(containsSsnLikeText(ssn)).toBe(true);
        expect(containsSsnLikeText(`SSN: ${ssn}, filed`)).toBe(true);
      });

      it(`normalizer nulls a text field and replaces the summary for ${name}`, () => {
        const out = normalizeTaxExtraction("w2", {
          summary: `W-2 for ${ssn}`,
          data: { employerName: `ACME ${ssn}`, wagesCents: 10 },
        });
        expect(out.data.employerName).toBeNull();
        expect(out.summary).toMatch(/withheld/i);
        expect(out.warnings).toContain("removed text that looked like an SSN");
        expect(out.data.wagesCents).toBe(10);
      });
    }

    it("the Tester's repro: 'W-2 for 123 45 6789' / 'ACME 123 45 6789'", () => {
      const out = normalizeTaxExtraction("w2", {
        summary: "W-2 for 123 45 6789",
        data: { employerName: "ACME 123 45 6789", wagesCents: 10 },
      });
      expect(out.summary).not.toContain("6789");
      expect(out.data.employerName).toBeNull();
      expect(out.data.wagesCents).toBe(10);
    });

    it("the correction validator also rejects spaced / dotted / en-dash SSNs", () => {
      for (const ssn of ["123 45 6789", "123.45.6789", "123–45–6789"]) {
        expect(validateCorrections("w2", { employerName: ssn }).ok).toBe(false);
      }
    });

    it("does not blank legitimate values (no false positives)", () => {
      const safe = [
        "Acme Corp",
        "12-3456789", // EIN shape
        "2025-12-31", // ISO date
        "12/31/2025",
        "1,234,567.89", // amount with separators
        "$1 234 567", // spaced thousands (3-3 groups, not 3-2-4)
        "1234567890", // 10-digit run
        "12345678", // 8 digits
        "860-555-1234", // phone (3-3-4)
        "Box 12 code DD 4567",
        "Wages 5,000.00 and 1,500.00",
        "100 00 12345", // 5-digit tail
        "0123 45 6789", // 4-digit lead
      ];
      for (const text of safe) expect(containsSsnLikeText(text)).toBe(false);

      const out = normalizeTaxExtraction("w2", {
        summary: "W-2 from ACME Corp for 2025, wages 5,000.00",
        data: { employerName: "ACME Corp 2025-12-31", employerEIN: "12-3456789", wagesCents: 500000 },
      });
      expect(out.data.employerName).toBe("ACME Corp 2025-12-31");
      expect(out.data.employerEIN).toBe("12-3456789");
      expect(out.data.wagesCents).toBe(500000);
      expect(out.summary).toBe("W-2 from ACME Corp for 2025, wages 5,000.00");
      expect(out.warnings).not.toContain("removed text that looked like an SSN");
    });
  });

  it("accepts EIN fields only as NN-NNNNNNN (a bare 9 digits could be an SSN)", () => {
    for (const bad of ["123456789", "123-45-6789", "12-345678", "EIN 12-3456789", 123456789]) {
      const out = normalizeTaxExtraction("w2", { ...w2Raw, data: { ...w2Raw.data, employerEIN: bad } });
      expect(out.data.employerEIN).toBeNull();
    }
    for (const type of ["1099", "k1"] as const) {
      const key = type === "1099" ? "payerEIN" : "entityEIN";
      expect(normalizeTaxExtraction(type, { data: { [key]: "98-7654321" } }).data[key]).toBe("98-7654321");
      expect(normalizeTaxExtraction(type, { data: { [key]: "987654321" } }).data[key]).toBeNull();
    }
  });

  it("money must be integer cents: numeric strings are coerced, fractions / garbage / negatives are nulled with a warning", () => {
    const out = normalizeTaxExtraction("w2", {
      data: {
        wagesCents: "5000000",
        federalWithheldCents: 1234.5,
        socialSecurityWagesCents: "12.50",
        medicareWagesCents: -100,
        medicareWithheldCents: "abc",
      },
    });
    expect(out.data.wagesCents).toBe(5000000);
    expect(out.data.federalWithheldCents).toBeNull();
    expect(out.data.socialSecurityWagesCents).toBeNull();
    expect(out.data.medicareWagesCents).toBeNull();
    expect(out.data.medicareWithheldCents).toBeNull();
    expect(out.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("signed K-1 amounts may be negative", () => {
    const out = normalizeTaxExtraction("k1", { data: { ordinaryIncomeCents: -250000, capitalAccountCents: -1 } });
    expect(out.data.ordinaryIncomeCents).toBe(-250000);
    expect(out.data.capitalAccountCents).toBe(-1);
  });

  it("caps list lengths (box12 <= 4, stateLines <= 4, installments <= 12, otherBoxes <= 20)", () => {
    const box12 = Array.from({ length: 7 }, (_, i) => ({ code: "A", amountCents: i + 1 }));
    const w2 = normalizeTaxExtraction("w2", { data: { box12, wagesCents: 1 } });
    expect(w2.data.box12).toHaveLength(4);
    expect(w2.warnings.some((w) => /first 4 of 7/.test(w))).toBe(true);

    const installments = Array.from({ length: 15 }, (_, i) => ({
      label: `I${i}`,
      dueDate: "2025-07-01",
      amountCents: 100,
      status: "unknown",
    }));
    expect(normalizeTaxExtraction("property_tax", { data: { installments } }).data.installments).toHaveLength(12);

    const otherBoxes = Array.from({ length: 30 }, (_, i) => ({ variant: "1099-B", box: String(i), label: "x", amountCents: 1 }));
    expect(normalizeTaxExtraction("1099", { data: { otherBoxes } }).data.otherBoxes).toHaveLength(20);
    expect(normalizeTaxExtraction("k1", { data: { otherBoxes } }).data.otherBoxes).toHaveLength(20);
  });

  it("drops entirely-empty list rows and non-list values", () => {
    const out = normalizeTaxExtraction("w2", {
      data: { box12: [{ code: null, amountCents: null }, { code: "W", amountCents: 100 }], stateLines: "CT" },
    });
    expect(out.data.box12).toEqual([{ code: "W", amountCents: 100 }]);
    expect(out.data.stateLines).toBeNull();
  });

  it("1099 consolidated: variant prefixes, variantsPresent and enum canonicalisation", () => {
    const out = normalizeTaxExtraction("1099", {
      data: {
        taxYear: 2025,
        formVariant: "Consolidated",
        variantsPresent: ["1099-int", "1099-DIV", "1099-DIV", "bogus"],
        payerName: "Robinhood",
        payerEIN: "46-4136152",
        amountCents: 358,
        federalWithheldCents: 0,
        int_box1Cents: 120,
        div_box1aCents: 238,
        div_box1bCents: 200,
        otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 5000 }],
      },
    });
    expect(out.data.formVariant).toBe("consolidated");
    expect(out.data.variantsPresent).toEqual(["1099-INT", "1099-DIV"]);
    expect(out.data.int_box1Cents).toBe(120);
    expect(out.data.div_box1aCents).toBe(238);
    expect(out.data.nec_box1Cents).toBeNull();
    expect(out.data.otherBoxes).toEqual([{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 5000 }]);
  });

  it("1098: loan number is last 4 only; property address / dates kept", () => {
    const out = normalizeTaxExtraction("form_1098", {
      data: {
        taxYear: 2025,
        servicerName: "PennyMac",
        loanNumber: "000123456789",
        interestCents: 1888269,
        principalBalanceCents: 37787263,
        originationDate: "2021-05-14",
        pointsPaidCents: null,
        propertyAddress: "27 Old Barry Rd",
        numberOfProperties: 1,
      },
    });
    expect(out.docType).toBe("form_1098");
    expect(out.data.loanNumber).toBe("6789");
    expect(out.data.originationDate).toBe("2021-05-14");
    expect(out.data.interestCents).toBe(1888269);
  });

  it("rejects an impossible date", () => {
    const out = normalizeTaxExtraction("form_1098", { data: { originationDate: "2021-13-45" } });
    expect(out.data.originationDate).toBeNull();
  });

  it("property tax: paidInTaxYearCents is owner-entered only, the AI value is always discarded", () => {
    const out = normalizeTaxExtraction("property_tax", {
      data: {
        taxYear: 2025,
        taxType: "real_estate",
        totalTaxBilledCents: 600000,
        paidInTaxYearCents: 600000,
        installments: [{ label: "July", dueDate: "2025-07-01", amountCents: 300000, status: "paid" }],
      },
    });
    expect(out.data.paidInTaxYearCents).toBeNull();
    expect(out.data.totalTaxBilledCents).toBe(600000);
    expect(out.data.taxType).toBe("real_estate");
  });

  it("tax_return keeps its unchanged shape and version 1", () => {
    const out = normalizeTaxExtraction("tax_return", {
      summary: "1040",
      data: { taxYear: 2024, formType: "1040", taxpayerName: "A B", agiCents: -5, totalTaxCents: 100, filingStatus: "mfj" },
    });
    expect(out.schemaVersion).toBe(1);
    expect(out.data.agiCents).toBe(-5);
    expect(out.data.filingStatus).toBe("mfj");
  });

  it("never throws on junk input", () => {
    for (const junk of [null, undefined, "x", 5, [], { data: "x" }, { data: null }]) {
      const out = normalizeTaxExtraction("w2", junk);
      expect(out.schemaVersion).toBe(2);
      expect(typeof out.summary).toBe("string");
    }
  });
});

describe("legacy key derivation", () => {
  it("sums CT withholding only; no lines -> null; lines but none CT -> 0", () => {
    expect(sumCtWithholding(undefined)).toBeNull();
    expect(sumCtWithholding([])).toBeNull();
    expect(sumCtWithholding([{ stateCode: "NY", stateWithheldCents: 5 }])).toBe(0);
    expect(
      sumCtWithholding([
        { stateCode: "CT", stateWithheldCents: 100 },
        { stateCode: "CT", stateWithheldCents: 50 },
        { stateCode: "NY", stateWithheldCents: 999 },
        { stateCode: null, stateWithheldCents: 7 },
      ])
    ).toBe(150);
  });

  it("deriveLegacyKeys leaves an explicit value alone unless forced, and ignores other types", () => {
    const data = { stateLines: [{ stateCode: "CT", stateWithheldCents: 100 }], stateWithheldCents: 5 };
    expect(deriveLegacyKeys("w2", data).stateWithheldCents).toBe(5);
    expect(deriveLegacyKeys("w2", data, true).stateWithheldCents).toBe(100);
    expect(deriveLegacyKeys("1099", data)).toBe(data);
    expect(deriveLegacyKeys("w2", { wagesCents: 1 })).toEqual({ wagesCents: 1 });
  });
});

describe("usable signal", () => {
  it("lists the money signal keys per raw docType", () => {
    expect(usableSignalKeys("w2")).toContain("wagesCents");
    expect(usableSignalKeys("w2")).toContain("stateWithheldCents");
    expect(usableSignalKeys("mortgage_interest")).toEqual(["interestCents", "principalBalanceCents"]);
    expect(usableSignalKeys("property_tax")).toEqual(["totalTaxBilledCents"]);
    expect(usableSignalKeys("property_tax")).not.toContain("paidInTaxYearCents");
    expect(usableSignalKeys("1099")).toContain("div_box1aCents");
    expect(usableSignalKeys("1099")).toContain("amountCents");
    expect(usableSignalKeys("tax_return")).toEqual([]);
    expect(usableSignalKeys("other")).toEqual([]);
  });

  it("an all-null tax extraction is not usable; one money field is enough", () => {
    expect(isUsableTaxExtraction("w2", { data: { wagesCents: null, federalWithheldCents: null } })).toBe(false);
    expect(isUsableTaxExtraction("w2", { data: { wagesCents: 0 } })).toBe(true);
    expect(isUsableTaxExtraction("w2", null)).toBe(false);
    expect(isUsableTaxExtraction("w2", { data: "x" })).toBe(false);
    expect(isUsableTaxExtraction("tax_return", { data: {} })).toBe(true); // no signal fields defined
    expect(isUsableTaxExtraction("insurance_policy", { data: {} })).toBe(true);
  });
});

describe("containsSsnLikeText", () => {
  it("matches 9-digit and 3-2-4 forms, not EINs, dates or phone numbers", () => {
    expect(containsSsnLikeText("123-45-6789")).toBe(true);
    expect(containsSsnLikeText("123456789")).toBe(true);
    expect(containsSsnLikeText("id 123-45-6789 end")).toBe(true);
    expect(containsSsnLikeText("12-3456789")).toBe(false);
    expect(containsSsnLikeText("2025-07-01")).toBe(false);
    expect(containsSsnLikeText("203-555-1234")).toBe(false);
    expect(containsSsnLikeText("1234567890")).toBe(false);
  });
});

describe("validateCorrections (strict)", () => {
  it("accepts valid values and null (blank on the form)", () => {
    const r = validateCorrections("w2", {
      wagesCents: 5000000,
      federalWithheldCents: null,
      employerName: "  Acme  Corp ",
      retirementPlan: true,
      box12: [{ code: "d", amountCents: 100 }],
    });
    expect(r).toEqual({
      ok: true,
      fields: {
        wagesCents: 5000000,
        federalWithheldCents: null,
        employerName: "Acme Corp",
        retirementPlan: true,
        box12: [{ code: "D", amountCents: 100 }],
      },
    });
  });

  it("rejects unknown keys and non-object input", () => {
    expect(validateCorrections("w2", { nope: 1 })).toEqual({ ok: false, error: "Unknown field: nope" });
    expect(validateCorrections("w2", { ssn: "123-45-6789" }).ok).toBe(false);
    expect(validateCorrections("w2", "x").ok).toBe(false);
    expect(validateCorrections("w2", null).ok).toBe(false);
  });

  it("rejects wrong kinds and non-integer cents (no coercion in strict mode)", () => {
    for (const bad of [12.5, "12", true, Number.NaN, Infinity, 1e20]) {
      expect(validateCorrections("w2", { wagesCents: bad }).ok).toBe(false);
    }
    expect(validateCorrections("w2", { wagesCents: -1 }).ok).toBe(false); // not signed
    expect(validateCorrections("k1", { ordinaryIncomeCents: -1 }).ok).toBe(true); // signed
    expect(validateCorrections("w2", { taxYear: 1800 }).ok).toBe(false);
    expect(validateCorrections("w2", { retirementPlan: "yes" }).ok).toBe(false);
    expect(validateCorrections("1099", { formVariant: "1099-XYZ" }).ok).toBe(false);
    expect(validateCorrections("1099", { formVariant: "consolidated" }).ok).toBe(true);
    expect(validateCorrections("form_1098", { originationDate: "2021-02-30" }).ok).toBe(false);
    expect(validateCorrections("k1", { partnerSharePct: 150 }).ok).toBe(false);
  });

  it("rejects SSN-shaped text everywhere, and a bare-9-digit EIN", () => {
    expect(validateCorrections("w2", { employerName: "123-45-6789" }).ok).toBe(false);
    expect(validateCorrections("w2", { employerEIN: "123456789" }).ok).toBe(false);
    expect(validateCorrections("w2", { employerEIN: "12-3456789" }).ok).toBe(true);
    const nested = validateCorrections("w2", {
      stateLines: [{ stateCode: "CT", stateEmployerId: "123456789", stateWagesCents: 1, stateWithheldCents: 1 }],
    });
    expect(nested.ok).toBe(false);
    expect(nested.ok === false && nested.error).toMatch(/Social Security/);
  });

  it("rejects too many rows and unknown list columns", () => {
    const tooMany = Array.from({ length: 5 }, () => ({ code: "A", amountCents: 1 }));
    expect(validateCorrections("w2", { box12: tooMany }).ok).toBe(false);
    expect(validateCorrections("w2", { box12: [{ code: "A", amountCents: 1, ssn: "x" }] }).ok).toBe(false);
    expect(validateCorrections("w2", { box12: "x" }).ok).toBe(false);
  });

  it("accepts the owner-entered property tax value", () => {
    expect(validateCorrections("property_tax", { paidInTaxYearCents: 600000 })).toEqual({
      ok: true,
      fields: { paidInTaxYearCents: 600000 },
    });
  });
});

describe("dollarsInputToCents", () => {
  it("parses dollars strictly into integer cents", () => {
    expect(dollarsInputToCents("1234.56")).toBe(123456);
    expect(dollarsInputToCents("$1,234.5")).toBe(123450);
    expect(dollarsInputToCents("1,234")).toBe(123400);
    expect(dollarsInputToCents("0.07")).toBe(7);
    expect(dollarsInputToCents("  12  ")).toBe(1200);
    expect(dollarsInputToCents("0")).toBe(0);
    expect(dollarsInputToCents("19.99")).toBe(1999); // would be 1998.9999... with float math
    expect(dollarsInputToCents("1.15")).toBe(115);
  });
  it("rejects everything else (never NaN)", () => {
    for (const bad of ["", "abc", "1.234", "1,2345", "12,34", "1e3", ".5", "5.", "$", "1 000", "12-3", "(5)", "--5"]) {
      expect(dollarsInputToCents(bad)).toBeNull();
    }
  });
  it("negatives only when allowed", () => {
    expect(dollarsInputToCents("-5.25")).toBeNull();
    expect(dollarsInputToCents("-5.25", { allowNegative: true })).toBe(-525);
    expect(dollarsInputToCents("-$5", { allowNegative: true })).toBe(-500);
    expect(dollarsInputToCents("-0", { allowNegative: true })).toBe(0);
  });
  it("round-trips with centsToDollarsInput and formats for display", () => {
    for (const cents of [0, 7, 100, 123456, -525, 99999999]) {
      expect(dollarsInputToCents(centsToDollarsInput(cents), { allowNegative: true })).toBe(cents);
    }
    expect(formatCentsDisplay(123456)).toBe("$1,234.56");
    expect(formatCentsDisplay(-525)).toBe("-$5.25");
    expect(formatCentsDisplay(0)).toBe("$0.00");
  });
});

describe("crossFieldWarnings (non-blocking)", () => {
  it("flags qualified dividends above total ordinary dividends", () => {
    const w = crossFieldWarnings("1099", { div_box1aCents: 100, div_box1bCents: 200 });
    expect(w.some((x) => /1b/.test(x))).toBe(true);
    expect(crossFieldWarnings("1099", { div_box1aCents: 200, div_box1bCents: 100 })).toEqual([]);
  });
  it("flags a tax year that differs from the document's, a bad box 12 code and a state line without a code", () => {
    expect(crossFieldWarnings("w2", { taxYear: 2024 }, { documentTaxYear: 2025 })[0]).toMatch(/2024.*2025/);
    expect(crossFieldWarnings("w2", { taxYear: 2025 }, { documentTaxYear: 2025 })).toEqual([]);
    expect(crossFieldWarnings("w2", { box12: [{ code: "D1", amountCents: 1 }] }).some((x) => /Box 12/.test(x))).toBe(true);
    expect(
      crossFieldWarnings("w2", { stateLines: [{ stateCode: null, stateWithheldCents: 1 }] }).some((x) => /state code/.test(x))
    ).toBe(true);
  });
  it("flags installments that do not add up to the total billed", () => {
    const data = { totalTaxBilledCents: 600000, installments: [{ amountCents: 300000 }, { amountCents: 200000 }] };
    expect(crossFieldWarnings("property_tax", data).some((x) => /add up/.test(x))).toBe(true);
    expect(
      crossFieldWarnings("property_tax", { ...data, installments: [{ amountCents: 300000 }, { amountCents: 300000 }] })
    ).toEqual([]);
  });
});

describe("sumInstallmentsDueInYear", () => {
  it("sums only installments due in the calendar year; null when none", () => {
    const installments = [
      { dueDate: "2025-07-01", amountCents: 300000 },
      { dueDate: "2026-01-01", amountCents: 300000 },
      { dueDate: "2025-12-31", amountCents: 1 },
    ];
    expect(sumInstallmentsDueInYear(installments, 2025)).toBe(300001);
    expect(sumInstallmentsDueInYear(installments, 2026)).toBe(300000);
    expect(sumInstallmentsDueInYear(installments, 2024)).toBeNull();
    expect(sumInstallmentsDueInYear(null, 2025)).toBeNull();
  });
});
