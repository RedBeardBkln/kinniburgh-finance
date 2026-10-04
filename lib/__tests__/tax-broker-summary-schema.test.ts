// Schema / normalizer / prompt / cross-field tests for the 1099 sales summary capture (`bSummary`),
// plus the differential test proving every pre-existing 1099 field and behaviour is unchanged.
import { describe, expect, it } from "vitest";
import {
  BSUMMARY_BOXES,
  BSUMMARY_BOX_LABELS,
  BSUMMARY_FORMS,
  CURRENT_SCHEMA_VERSION,
  TAX_SCHEMAS,
  buildTaxExtractionPrompt,
  crossFieldWarnings,
  getFieldDef,
  isUsableTaxExtraction,
  normalizeTaxExtraction,
  salesSummaryWarnings,
  schemaVersionFor,
  usableSignalKeys,
  validateCorrections,
} from "@/lib/tax-extraction-schema";
import { isUsableExtraction } from "@/lib/document-extraction-state";
import { BROKER_BOXES, BROKER_FORMS } from "@/lib/tax2025/facts";
import {
  NEW_1099_KEYS,
  OLD_SHAPE_RESPONSES,
  ROBINHOOD_2025_RAW,
  ROBINHOOD_2025_ROWS,
} from "@/lib/__tests__/broker-summary-fixtures";
import golden from "@/lib/__tests__/fixtures/1099-old-normalized.golden.json";

const rows = (data: Record<string, unknown>): Record<string, unknown>[] => data.bSummary as Record<string, unknown>[];

describe("registry: bSummary on the 1099 schema", () => {
  const def = getFieldDef("1099", "bSummary")!;

  it("is a list of at most 12 per-category rows in its own group, holding only enum and money columns", () => {
    expect(def.kind).toBe("list");
    expect(def.maxItems).toBe(12);
    expect(TAX_SCHEMAS["1099"].groups.map((g) => g.id)).toContain("b");
    expect(def.group).toBe("b");
    expect(def.itemFields?.map((i) => [i.key, i.kind])).toEqual([
      ["form", "enum"],
      ["box", "enum"],
      ["proceedsCents", "money"],
      ["costCents", "money"],
      ["accruedMarketDiscountCents", "money"],
      ["washSaleLossDisallowedCents", "money"],
      ["gainLossCents", "money"],
    ]);
    // no text column: an account number, CUSIP or security name has nowhere to go
    expect(def.itemFields?.some((i) => i.kind === "text")).toBe(false);
  });

  it("only the printed gain is signed; the other columns cannot be negative", () => {
    for (const item of def.itemFields ?? []) {
      if (item.kind === "money") expect(item.signed === true, item.key).toBe(item.key === "gainLossCents");
    }
  });

  it("has a plain-language label for every box and it matches the Form 8949 parts", () => {
    expect(Object.keys(BSUMMARY_BOX_LABELS).sort()).toEqual([...BSUMMARY_BOXES].sort());
    expect(BSUMMARY_BOX_LABELS.A).toBe("Short-term, basis reported to the IRS (Form 8949 box A)");
    expect(BSUMMARY_BOX_LABELS.D).toBe("Long-term, basis reported to the IRS (Form 8949 box D)");
    for (const b of ["A", "B", "C", "G", "H", "I"]) expect(BSUMMARY_BOX_LABELS[b]).toMatch(/^Short-term/);
    for (const b of ["D", "E", "F", "J", "K", "L"]) expect(BSUMMARY_BOX_LABELS[b]).toMatch(/^Long-term/);
  });

  it("the engine's fact enums (lib/tax2025/facts.ts) are identical to the extraction enums", () => {
    expect([...BROKER_FORMS]).toEqual([...BSUMMARY_FORMS]);
    expect([...BROKER_BOXES]).toEqual([...BSUMMARY_BOXES]);
  });

  it("adds 1099-DA to the form types without bumping the schema version", () => {
    expect(getFieldDef("1099", "variantsPresent")?.options).toContain("1099-DA");
    expect(getFieldDef("1099", "formVariant")?.options).toContain("1099-DA");
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    expect(schemaVersionFor("1099")).toBe(2);
  });

  it("the extra fields (Section 1256 aggregate, printed totals) are signed money that is not a usable-extraction signal", () => {
    for (const key of ["sec1256AggregateCents", "bSummaryTotalProceedsCents", "bSummaryTotalGainCents"]) {
      const f = getFieldDef("1099", key)!;
      expect(f.kind, key).toBe("money");
      expect(f.signal, key).toBe(false);
    }
    expect(getFieldDef("1099", "sec1256AggregateCents")?.signed).toBe(true);
  });
});

describe("prompt", () => {
  const prompt = buildTaxExtractionPrompt("1099");

  it("lists every new key in the JSON template (prompt and registry cannot drift)", () => {
    const keys = new Set([...prompt.matchAll(/"([A-Za-z0-9_]+)":/g)].map((m) => m[1]));
    for (const k of NEW_1099_KEYS) expect(keys.has(k), k).toBe(true);
    for (const k of ["form", "box", "proceedsCents", "costCents", "accruedMarketDiscountCents", "washSaleLossDisallowedCents", "gainLossCents"]) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  it("has the guardrails: summary only, never guess, absent category not invented, crypto separate, no identifiers", () => {
    expect(prompt).toMatch(/read ONLY the printed summary of proceeds/);
    expect(prompt).toMatch(/never invent a category that is not printed/);
    expect(prompt).toMatch(/never sum transaction rows/);
    expect(prompt).toMatch(/leave box null rather than guess/);
    expect(prompt).toMatch(/1099-DA .* must never be put in a 1099-B row/);
    expect(prompt).toMatch(/empty list when the document has no 1099-B or 1099-DA sales summary/);
    expect(prompt).toMatch(/Section 1256 contracts section .* NOT a bSummary row/);
    expect(prompt).toMatch(/Never output an account number, CUSIP, security name, share quantity or transaction date/);
  });

  it("no longer tells the model to put 1099-B boxes in otherBoxes", () => {
    expect(prompt).not.toMatch(/1099-B, 1099-R, 1099-SSA and any other form: put their boxes in otherBoxes/);
    expect(prompt).toMatch(/EXCEPT 1099-B and 1099-DA/);
  });
});

describe("normalizer: the real Robinhood 2025 shape", () => {
  const out = normalizeTaxExtraction("1099", ROBINHOOD_2025_RAW);

  it("keeps both categories as integer cents (Short A and Long D) and the Section 1256 zero", () => {
    expect(out.warnings).toEqual([]);
    expect(rows(out.data)).toEqual([
      { form: "1099-B", box: "A", proceedsCents: 587231, costCents: 528550, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 599, gainLossCents: 59280 },
      { form: "1099-B", box: "D", proceedsCents: 1700168, costCents: 1203728, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 496440 },
    ]);
    expect(out.data.sec1256AggregateCents).toBe(0);
    expect(out.data.bSummaryTotalProceedsCents).toBeNull();
    expect(out.schemaVersion).toBe(2);
  });

  it("the worked numbers tie: A = 5,872.31 - 5,285.50 + 5.99 = 592.80 and D = 17,001.68 - 12,037.28 = 4,964.40", () => {
    const [a, d] = rows(out.data) as { proceedsCents: number; costCents: number; washSaleLossDisallowedCents: number; gainLossCents: number }[];
    expect(a!.proceedsCents - a!.costCents + a!.washSaleLossDisallowedCents).toBe(a!.gainLossCents);
    expect(d!.proceedsCents - d!.costCents + d!.washSaleLossDisallowedCents).toBe(d!.gainLossCents);
  });

  it("the fixture rows raise no cross-field warning", () => {
    expect(crossFieldWarnings("1099", out.data)).toEqual([]);
  });

  it("a verbatim signal: a sales summary alone makes the extraction usable even with every money box null", () => {
    expect(usableSignalKeys("1099")).toContain("bSummary");
    expect(isUsableTaxExtraction("1099", { data: { bSummary: [] } })).toBe(false);
    expect(isUsableTaxExtraction("1099", { data: { bSummary: [ROBINHOOD_2025_ROWS[0]] } })).toBe(true);
    expect(isUsableExtraction("1099", { docType: "1099", summary: "x", data: { bSummary: [ROBINHOOD_2025_ROWS[0]] } })).toBe(true);
    expect(isUsableTaxExtraction("1099", { data: { sec1256AggregateCents: 0, bSummaryTotalGainCents: 5 } })).toBe(false);
  });
});

describe("normalizer: null means not read, [] means read and none", () => {
  it("absent -> null, [] -> [], never invented", () => {
    expect(normalizeTaxExtraction("1099", { data: { int_box1Cents: 5 } }).data.bSummary).toBeNull();
    expect(normalizeTaxExtraction("1099", { data: { int_box1Cents: 5, bSummary: [] } }).data.bSummary).toEqual([]);
    expect(normalizeTaxExtraction("1099", { data: { int_box1Cents: 5, bSummary: null } }).data.bSummary).toBeNull();
    expect(normalizeTaxExtraction("1099", { data: { int_box1Cents: 5, bSummary: "none" } }).data.bSummary).toBeNull();
  });

  it("a blank column stays null and a printed 0.00 stays 0", () => {
    const out = normalizeTaxExtraction("1099", {
      data: { bSummary: [{ form: "1099-B", box: "B", proceedsCents: 1000, costCents: null, accruedMarketDiscountCents: 0 }] },
    });
    expect(rows(out.data)).toEqual([
      { form: "1099-B", box: "B", proceedsCents: 1000, costCents: null, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: null, gainLossCents: null },
    ]);
  });
});

describe("normalizer: defence in depth on the rows", () => {
  it("clears a box letter outside A-L and an unknown form, with a warning, keeping the numbers", () => {
    const out = normalizeTaxExtraction("1099", { data: { bSummary: [{ form: "1099-X", box: "Z", proceedsCents: 5 }] } });
    expect(rows(out.data)).toEqual([expect.objectContaining({ form: null, box: null, proceedsCents: 5 })]);
    expect(out.warnings.join("\n")).toMatch(/Sales summary rows \/ Category/);
  });

  it("never stores an account-number-like or SSN-like value, and drops unknown columns", () => {
    const out = normalizeTaxExtraction("1099", {
      data: {
        bSummary: [
          {
            form: "1099-B",
            box: "A",
            proceedsCents: 100,
            cusip: "037833100",
            accountNumber: "123456789012",
            description: "APPLE INC 123-45-6789",
            washSaleLossDisallowedCents: "123-45-6789",
          },
          { form: "123456789012", box: "123-45-6789", proceedsCents: 7 },
        ],
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("037833100");
    expect(text).not.toContain("123456789012");
    expect(text).not.toContain("123-45-6789");
    expect(Object.keys(rows(out.data)[0]!).sort()).toEqual(
      ["accruedMarketDiscountCents", "box", "costCents", "form", "gainLossCents", "proceedsCents", "washSaleLossDisallowedCents"].sort()
    );
  });

  it("integer cents only: a float, an unsafe number and a negative proceeds are cleared; a negative gain is kept", () => {
    const out = normalizeTaxExtraction("1099", {
      data: { bSummary: [{ form: "1099-B", box: "D", proceedsCents: 12.5, costCents: -5, gainLossCents: -250000, washSaleLossDisallowedCents: 1e30 }] },
    });
    expect(rows(out.data)[0]).toMatchObject({ proceedsCents: null, costCents: null, gainLossCents: -250000, washSaleLossDisallowedCents: null });
  });

  it("caps the list at 12 rows (with a warning) and drops an all-empty row", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ form: "1099-B", box: BSUMMARY_BOXES[i % 6], proceedsCents: i + 1 }));
    const out = normalizeTaxExtraction("1099", { data: { bSummary: [...many, { form: null, box: null }] } });
    expect(rows(out.data)).toHaveLength(12);
    expect(out.warnings.join("\n")).toMatch(/kept the first 12 of 16 rows/);
    expect(rows(normalizeTaxExtraction("1099", { data: { bSummary: [{ form: null, box: null, proceedsCents: null }] } }).data)).toEqual([]);
  });
});

describe("owner corrections validation of bSummary", () => {
  const good = { form: "1099-B", box: "D", proceedsCents: 100, costCents: 50, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 50 };

  it("accepts well-formed rows, a loss, and null (blank)", () => {
    expect(validateCorrections("1099", { bSummary: [good] }).ok).toBe(true);
    expect(validateCorrections("1099", { bSummary: [{ ...good, gainLossCents: -9900 }] }).ok).toBe(true);
    expect(validateCorrections("1099", { bSummary: null }).ok).toBe(true);
    expect(validateCorrections("1099", { sec1256AggregateCents: -5 }).ok).toBe(true);
  });

  it("rejects an unknown column, a bad box, a bad form, a float, a negative proceeds and more than 12 rows", () => {
    expect(validateCorrections("1099", { bSummary: [{ ...good, cusip: "x" }] }).ok).toBe(false);
    expect(validateCorrections("1099", { bSummary: [{ ...good, box: "Z" }] }).ok).toBe(false);
    expect(validateCorrections("1099", { bSummary: [{ ...good, form: "1099-X" }] }).ok).toBe(false);
    expect(validateCorrections("1099", { bSummary: [{ ...good, proceedsCents: 1.5 }] }).ok).toBe(false);
    expect(validateCorrections("1099", { bSummary: [{ ...good, proceedsCents: -1 }] }).ok).toBe(false);
    expect(validateCorrections("1099", { bSummary: Array.from({ length: 13 }, () => good) }).ok).toBe(false);
  });
});

describe("crossFieldWarnings: sales summary", () => {
  const base = { form: "1099-B", box: "A", proceedsCents: 587231, costCents: 528550, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 599, gainLossCents: 59280 };
  const warn = (bSummary: unknown, extra: Record<string, unknown> = {}) =>
    crossFieldWarnings("1099", { variantsPresent: ["1099-B"], bSummary, ...extra });

  it("accepts the gain printed as proceeds - cost (no add-back) or proceeds - cost + wash sale, within one cent", () => {
    expect(warn([{ ...base, gainLossCents: 58681 }])).toEqual([]);
    expect(warn([{ ...base, gainLossCents: 59280 }])).toEqual([]);
    expect(warn([{ ...base, gainLossCents: 59281 }])).toEqual([]);
    expect(warn([{ ...base, gainLossCents: 58680 }])).toEqual([]);
  });

  it("flags a gain that matches neither, saying both candidates", () => {
    const w = warn([{ ...base, gainLossCents: 60000 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/1099-B box A: the printed gain \$600\.00 does not equal proceeds minus cost \(\$586\.81\) or proceeds minus cost plus the wash sale loss \(\$592\.80\)/);
  });

  it("skips the arithmetic when the cost or the printed gain is not read (a noncovered category)", () => {
    expect(warn([{ ...base, box: "B", costCents: null, gainLossCents: 1 }])).toEqual([]);
    expect(warn([{ ...base, gainLossCents: null }])).toEqual([]);
  });

  it("flags a duplicate category, a form / box mismatch, and a row with no form or box", () => {
    expect(warn([base, base]).join("\n")).toMatch(/Two rows are for 1099-B box A/);
    expect(warn([{ ...base, box: "H" }]).join("\n")).toMatch(/a 1099-B category uses box A-F, not box H/);
    expect(crossFieldWarnings("1099", { variantsPresent: ["1099-DA"], bSummary: [{ ...base, form: "1099-DA", box: "A", gainLossCents: null }] }).join("\n")).toMatch(
      /a 1099-DA category uses box G-L, not box A/
    );
    expect(warn([{ ...base, box: null }]).join("\n")).toMatch(/has no form or box letter/);
  });

  it("flags a 1099-B in Forms present with an empty summary, and summary rows without 1099-B marked", () => {
    expect(warn([]).join("\n")).toMatch(/Forms present lists a 1099-B but the sales summary has no rows/);
    expect(crossFieldWarnings("1099", { variantsPresent: ["1099-DIV"], bSummary: [base] }).join("\n")).toMatch(/1099-B is not marked in Forms present/);
    expect(crossFieldWarnings("1099", { variantsPresent: ["1099-INT"], bSummary: [] })).toEqual([]);
  });

  it("flags a missing category when the rows do not add up to the table's printed totals", () => {
    const d = { ...base, box: "D", proceedsCents: 1700168, costCents: 1203728, washSaleLossDisallowedCents: 0, gainLossCents: 496440 };
    const ok = warn([base, d], { bSummaryTotalProceedsCents: 2287399, bSummaryTotalGainCents: 555720 });
    expect(ok).toEqual([]);
    const missing = warn([base], { bSummaryTotalProceedsCents: 2287399, bSummaryTotalGainCents: 555720 });
    expect(missing.join("\n")).toMatch(/proceeds add up to \$5,872\.31 but the summary prints a total of \$22,873\.99/);
    expect(missing.join("\n")).toMatch(/gains add up to \$592\.80 but the summary prints a total of \$5,557\.20/);
  });

  it("mentions accrued market discount, digital assets and a non-zero Section 1256 amount, but not a zero one", () => {
    expect(warn([{ ...base, accruedMarketDiscountCents: 1234 }]).join("\n")).toMatch(/accrued market discount of \$12\.34/);
    expect(warn([{ ...base }], { sec1256AggregateCents: 0 })).toEqual([]);
    expect(warn([{ ...base }], { sec1256AggregateCents: -50000 }).join("\n")).toMatch(/Section 1256 contracts show -\$500\.00/);
    expect(
      crossFieldWarnings("1099", { variantsPresent: ["1099-DA"], bSummary: [{ form: "1099-DA", box: "H", proceedsCents: 1, costCents: null }] }).join("\n")
    ).toMatch(/Digital asset \(1099-DA\) rows/);
  });

  it("says nothing when the summary was never read (null) and is not applied to other document types", () => {
    expect(crossFieldWarnings("1099", { variantsPresent: ["1099-B"], bSummary: null })).toEqual([]);
    expect(crossFieldWarnings("w2", { bSummary: [base] })).toEqual([]);
    expect(salesSummaryWarnings({})).toEqual([]);
  });
});

describe("differential: every pre-existing 1099 field and behaviour is unchanged", () => {
  const goldenByName = golden as Record<string, { docType: string; summary: string; data: Record<string, unknown>; warnings: string[]; schemaVersion: number }>;

  for (const c of OLD_SHAPE_RESPONSES) {
    it(`${c.name}: identical to the pre-change normalizer output, plus only null new keys`, () => {
      const before = goldenByName[c.name]!;
      const after = normalizeTaxExtraction("1099", c.raw);
      // every old key, value for value (the list of keys is the old registry's)
      for (const [key, value] of Object.entries(before.data)) expect(after.data[key], key).toEqual(value);
      // the only new keys are the capture's own, and for an old-shaped response they are all null
      const added = Object.keys(after.data).filter((k) => !(k in before.data));
      expect(added.sort()).toEqual([...NEW_1099_KEYS].sort());
      for (const k of added) expect(after.data[k], k).toBeNull();
      // everything outside data is byte-identical
      expect(after.docType).toBe(before.docType);
      expect(after.summary).toBe(before.summary);
      expect(after.warnings).toEqual(before.warnings);
      expect(after.schemaVersion).toBe(before.schemaVersion);
    });
  }

  it("an old-shaped extraction is still 'usable' exactly when it was (no new signal appears without bSummary rows)", () => {
    for (const c of OLD_SHAPE_RESPONSES) {
      const before = goldenByName[c.name]!;
      const oldUsable = [
        "amountCents",
        "federalWithheldCents",
        "nec_box1Cents",
        "nec_box4Cents",
        "int_box1Cents",
        "int_box2Cents",
        "int_box3Cents",
        "int_box4Cents",
        "int_box5Cents",
        "int_box6Cents",
        "int_box8Cents",
        "int_box9Cents",
        "div_box1aCents",
        "div_box1bCents",
        "div_box2aCents",
        "div_box3Cents",
        "div_box4Cents",
        "div_box5Cents",
        "div_box7Cents",
        "div_box11Cents",
        "misc_box1Cents",
        "misc_box2Cents",
        "misc_box3Cents",
        "misc_box4Cents",
      ].some((k) => before.data[k] !== null && before.data[k] !== undefined);
      expect(isUsableTaxExtraction("1099", { data: normalizeTaxExtraction("1099", c.raw).data }), c.name).toBe(oldUsable);
    }
  });

  it("existing pinned crossField behaviour is intact (box 1b > box 1a, state line without a code)", () => {
    expect(crossFieldWarnings("1099", { div_box1aCents: 100, div_box1bCents: 200 })).toHaveLength(1);
    expect(crossFieldWarnings("1099", { div_box1aCents: 200, div_box1bCents: 100 })).toEqual([]);
    expect(crossFieldWarnings("1099", { stateLines: [{ stateCode: null }] }).join("")).toMatch(/no state code/);
  });
});
