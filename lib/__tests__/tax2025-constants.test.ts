import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CONSTANTS,
  allConstants,
  constantCitationProblems,
  protectedNumericValues,
  type TaxConstant,
} from "@/lib/tax2025/constants";

// Acceptance criterion 11: every constant has a url and verifiedOn; a test reading
// the rule files finds no hardcoded copy of those numbers.

describe("TY2025 constants registry (citations)", () => {
  it("every constant has an irs.gov / portal.ct.gov url, an ISO verifiedOn date and a note", () => {
    expect(constantCitationProblems(CONSTANTS)).toEqual([]);
    expect(allConstants().length).toBeGreaterThan(50);
  });

  it("the citation check FAILS for a constant with no url (the step-1 done condition)", () => {
    const bad = {
      NO_URL: { id: "NO_URL", value: 1, url: "", verifiedOn: "2026-10-03", note: "x" },
      NO_DATE: { id: "NO_DATE", value: 1, url: "https://www.irs.gov/x", verifiedOn: "", note: "x" },
      WRONG_HOST: { id: "WRONG_HOST", value: 1, url: "https://example.com/x", verifiedOn: "2026-10-03", note: "x" },
      WRONG_ID: { id: "SOMETHING_ELSE", value: 1, url: "https://www.irs.gov/x", verifiedOn: "2026-10-03", note: "x" },
    } satisfies Record<string, TaxConstant<number>>;
    const problems = constantCitationProblems(bad);
    expect(problems.some((p) => p.startsWith("NO_URL: missing url"))).toBe(true);
    expect(problems.some((p) => p.startsWith("NO_DATE: missing or malformed verifiedOn"))).toBe(true);
    expect(problems.some((p) => p.startsWith("WRONG_HOST"))).toBe(true);
    expect(problems.some((p) => p.startsWith("WRONG_ID"))).toBe(true);
  });

  it("spot-checks the values transcribed from the verified table", () => {
    expect(CONSTANTS.STANDARD_DEDUCTION_MFJ.value).toBe(31500);
    expect(CONSTANTS.SE_WAGE_BASE.value).toBe(176100);
    expect(CONSTANTS.SE_FLOOR.value).toBe(400);
    expect(CONSTANTS.QDCG_ZERO_RATE_LIMIT_MFJ.value).toBe(96700);
    expect(CONSTANTS.QDCG_FIFTEEN_RATE_LIMIT_MFJ.value).toBe(600050);
    expect(CONSTANTS.SALT_CAP_MFJ.value).toBe(40000);
    expect(CONSTANTS.SALT_PHASE_DOWN_THRESHOLD_MFJ.value).toBe(500000);
    expect(CONSTANTS.SALT_PHASE_DOWN_RATE.value).toBe(0.3);
    expect(CONSTANTS.SALT_FLOOR.value).toBe(10000);
    expect(CONSTANTS.MORTGAGE_DEBT_LIMIT.value).toBe(750000);
    expect(CONSTANTS.QBI_8995_THRESHOLD_MFJ.value).toBe(394600);
    expect(CONSTANTS.AMT_EXEMPTION_MFJ.value).toBe(137000);
    expect(CONSTANTS.AMT_PHASEOUT_START_MFJ.value).toBe(1252700);
    expect(CONSTANTS.AMT_28_PERCENT_THRESHOLD.value).toBe(239100);
    expect(CONSTANTS.NIIT_THRESHOLD_MFJ.value).toBe(250000);
    expect(CONSTANTS.CT_TABLE_C.value).toEqual({ threshold: 100500, stepSize: 5000, stepAmount: 50, maxSteps: 10 });
    expect(CONSTANTS.SAVERS_RATE_BANDS_MFJ.value.map((b) => b.upTo)).toEqual([47500, 51000, 79000, null]);
  });

  it("D1: the home office gross income limitation basis is registered with its source", () => {
    expect(CONSTANTS.HOME_OFFICE_GROSS_INCOME_LIMIT.value).toContain("Schedule C line 29");
    expect(CONSTANTS.HOME_OFFICE_GROSS_INCOME_LIMIT.url).toBe("https://www.irs.gov/instructions/i1040sc");
    expect(CONSTANTS.HOME_OFFICE_GROSS_INCOME_LIMIT.verifiedOn).toBe("2026-10-03");
  });

  it("the older (2026-09-17) entries are dated to the earlier pass, the rest to 2026-10-03", () => {
    expect(CONSTANTS.FEDERAL_BRACKETS_MFJ.verifiedOn).toBe("2026-09-17");
    expect(CONSTANTS.SE_WAGE_BASE.verifiedOn).toBe("2026-10-03");
  });
});

// ── No hardcoded copy of a registry number in the rule files ──────────────────

const TAX2025_DIR = path.resolve(__dirname, "..", "tax2025");

function ruleFiles(): string[] {
  const out: string[] = [];
  const rulesDir = path.join(TAX2025_DIR, "rules");
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir)) if (f.endsWith(".ts")) out.push(path.join(rulesDir, f));
  }
  const ret = path.join(TAX2025_DIR, "return.ts");
  if (fs.existsSync(ret)) out.push(ret);
  const schedC = path.join(TAX2025_DIR, "gl-schedule-c-map.ts");
  if (fs.existsSync(schedC)) out.push(schedC);
  return out;
}

/** Source with comments and string/template text removed, so only code literals remain. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``");
}

function numericLiterals(code: string): number[] {
  const out: number[] = [];
  const re = /(?<![\w.$])(\d[\d_]*(?:\.\d+)?)(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    out.push(Number(m[1]!.replace(/_/g, "")));
  }
  return out;
}

describe("rule files do not repeat registry numbers", () => {
  it("finds the rule files it is supposed to scan (once they exist) and none contain a protected literal", () => {
    const protectedValues = protectedNumericValues();
    expect(protectedValues.has(176100)).toBe(true);
    const offenders: string[] = [];
    for (const file of ruleFiles()) {
      const lits = numericLiterals(codeOnly(fs.readFileSync(file, "utf8")));
      for (const n of lits) {
        if (protectedValues.has(n)) offenders.push(`${path.basename(file)}: literal ${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner itself catches a hardcoded constant (sanity check of the checker)", () => {
    const src = `// 176100 in a comment is fine\nconst a = "40,000 in a string is fine";\nconst b = wages - 176100;\nconst c = x * 0.9235;`;
    const lits = numericLiterals(codeOnly(src));
    expect(lits).toEqual([176100, 0.9235]);
  });
});

describe("mortgage insurance and CT-1040 Schedule 1 constants (verified 2026-10-04)", () => {
  it("the mortgage insurance premium constant cites Pub. 936 (2025) exactly and quotes the expiry", () => {
    const c = CONSTANTS.MORTGAGE_INSURANCE_PREMIUM_DEDUCTION_TY2025;
    expect(c.value).toBe("not deductible");
    expect(c.url).toBe("https://www.irs.gov/publications/p936");
    expect(c.verifiedOn).toBe("2026-10-04");
    expect(c.note).toContain("The itemized deduction for mortgage insurance premiums has expired. You can no longer claim the deduction.");
    // no claim about a later-year restoration is encoded anywhere in the registry
    expect(JSON.stringify(allConstants()).toLowerCase()).not.toContain("restor");
  });

  it("Schedule A line 8d is registered as reserved", () => {
    expect(CONSTANTS.SCHEDULE_A_LINE_8D.value).toBe("reserved for future use");
    expect(CONSTANTS.SCHEDULE_A_LINE_8D.url).toBe("https://www.irs.gov/instructions/i1040sca");
  });

  it("every CT Schedule 1 constant has the CT instructions url, the 2026-10-04 date and a note", () => {
    const ids = [
      "CT_SCH1_STATUTORY_MODIFICATIONS_ONLY",
      "CT_SCH1_LINE_RULES",
      "CT_SCH1_BONUS_168K_ADDBACK_PERCENT",
      "CT_SCH1_SECTION_179_ADDBACK_PERCENT",
      "CT_SCH1_PRIOR_ADDBACK_SUBTRACTION_PERCENT",
    ] as const;
    for (const id of ids) {
      expect(CONSTANTS[id].url, id).toBe("https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf");
      expect(CONSTANTS[id].verifiedOn, id).toBe("2026-10-04");
      expect(CONSTANTS[id].note.length, id).toBeGreaterThan(20);
    }
    expect(CONSTANTS.CT_SCH1_BONUS_168K_ADDBACK_PERCENT.value).toBe(100);
    expect(CONSTANTS.CT_SCH1_SECTION_179_ADDBACK_PERCENT.value).toBe(80);
    expect(CONSTANTS.CT_SCH1_PRIOR_ADDBACK_SUBTRACTION_PERCENT.value).toBe(25);
  });

  it("CT_SCH1_LINE_RULES has a rule sentence for every printed Schedule 1 line the engine emits", () => {
    const rules = CONSTANTS.CT_SCH1_LINE_RULES.value;
    for (const id of ["31", "32", "33", "34", "35", "36", "36a", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "48a", "48b", "48c", "48d", "49"]) {
      expect(rules[id]?.length ?? 0, `line ${id}`).toBeGreaterThan(20);
      expect(rules[id], `line ${id}`).toContain(`Line ${id}:`);
    }
  });
});
