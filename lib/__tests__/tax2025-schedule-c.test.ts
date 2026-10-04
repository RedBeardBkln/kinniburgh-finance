import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GL_SCHEDULE_C_MAP, findGlMapEntry } from "@/lib/tax2025/gl-schedule-c-map";
import { SCHEDULE_C_LINE_IDS } from "@/lib/tax2025/line-catalog";
import { computeScheduleC, type ScheduleCInput } from "@/lib/tax2025/rules/schedule-c";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";
import { gl } from "@/lib/__tests__/tax2025-fixtures";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}
function st(r: RuleResult, key: LineKey): string | undefined {
  return r.lines.find((x) => x.key === key)?.status;
}

describe("GL-to-Schedule-C map (proposal)", () => {
  const csv = fs
    .readFileSync(path.resolve(__dirname, "..", "..", "data", "gl-accounts-ekc-2026.csv"), "utf8")
    .replace(/^﻿/, "");
  const accounts = csv
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(1)
    .map((l) => {
      const m = /^("([^"]*)"|[^,]*),/.exec(l);
      return (m?.[2] ?? m?.[1] ?? "").trim();
    });

  it("covers every one of the 146 accounts in data/gl-accounts-ekc-2026.csv exactly once", () => {
    expect(accounts).toHaveLength(146);
    expect(GL_SCHEDULE_C_MAP).toHaveLength(146);
    const mapped = GL_SCHEDULE_C_MAP.map((e) => e.account);
    expect(new Set(mapped).size).toBe(146);
    expect([...mapped].sort()).toEqual([...accounts].sort());
  });

  it("every `line` target is a real Schedule C line id; meals are flagged 50% and sit on 24b", () => {
    for (const e of GL_SCHEDULE_C_MAP) {
      if (e.target.kind === "line") expect(SCHEDULE_C_LINE_IDS).toContain(e.target.line);
    }
    const meals = GL_SCHEDULE_C_MAP.filter((e) => e.account === "Meals" || e.account.startsWith("Meals:"));
    expect(meals).toHaveLength(3);
    for (const e of meals) expect(e.target).toEqual({ kind: "line", line: "24b", meals: true });
  });

  it("balance-sheet account types never target a Schedule C line", () => {
    const bs = new Set(["Bank", "Accounts receivable (A/R)", "Other Current Assets", "Fixed Assets", "Accounts payable (A/P)", "Credit Card", "Other Current Liabilities", "Long Term Liabilities", "Equity"]);
    for (const e of GL_SCHEDULE_C_MAP) {
      if (bs.has(e.qboType)) expect(e.target.kind).toBe("balance_sheet");
    }
  });

  it("findGlMapEntry matches the full path, tolerates case/spacing, and uses a leaf only when it is unique", () => {
    expect(findGlMapEntry("Office expenses:Software & apps")?.target).toEqual({ kind: "line", line: "18" });
    expect(findGlMapEntry("  office EXPENSES : software & apps ")?.account).toBe("Office expenses:Software & apps");
    expect(findGlMapEntry("Software & apps")?.account).toBe("Office expenses:Software & apps");
    // "Mortgage interest" is a leaf under both Interest paid and Home office: ambiguous -> no match
    expect(findGlMapEntry("Mortgage interest")).toBeNull();
    expect(findGlMapEntry("Home office:Mortgage interest")?.target.kind).toBe("home_office_actual");
    expect(findGlMapEntry("Something not in the chart")).toBeNull();
  });
});

function input(over: Partial<ScheduleCInput> = {}): ScheduleCInput {
  return {
    glLines: [
      gl("4000", "Services", "revenue", 6_000_000),
      gl("5010", "Office expenses:Software & apps", "expense", 600_000),
      gl("5020", "Insurance:Business insurance", "expense", 400_000),
      gl("5030", "Meals:Meals with clients", "expense", 100_100),
      gl("5040", "Travel:Airfare", "expense", 200_000),
      gl("5050", "Utilities:Phone service", "expense", 120_000),
      gl("5060", "General business expenses:Bank fees & service charges", "expense", 30_000),
    ],
    booksEmpty: false,
    mileage: [],
    mileageNoneConfirmed: true,
    homeOfficeEligibility: "yes_exclusive",
    homeOfficeSqft: 200,
    fixedAssets: [],
    fixedAssetsNoneConfirmed: true,
    ...over,
  };
}

describe("computeScheduleC", () => {
  it("builds net profit from the books: gross income 60,000, expenses 14,001 (meals at 50%), home office 1,000 -> 44,999", () => {
    // 18 = 6,000; 15 = 4,000; 24b = 1,001.00 x 50% = 500.50 -> 501; 24a = 2,000; 25 = 1,200; 27b = 300;
    // line 28 = 14,001; line 29 = 60,000 - 14,001 = 45,999; line 30 simplified = 200 sq ft x $5 = 1,000; line 31 = 44,999
    const { result, detail } = computeScheduleC(input());
    expect(result.status).toBe("computed");
    expect(amt(result, "schc.1")).toBe("60000");
    expect(amt(result, "schc.7")).toBe("60000");
    expect(amt(result, "schc.18")).toBe("6000");
    expect(amt(result, "schc.15")).toBe("4000");
    expect(amt(result, "schc.24b")).toBe("501");
    expect(amt(result, "schc.24a")).toBe("2000");
    expect(amt(result, "schc.25")).toBe("1200");
    expect(amt(result, "schc.27b")).toBe("300");
    expect(amt(result, "schc.48")).toBe("300");
    expect(amt(result, "schc.28")).toBe("14001");
    expect(amt(result, "schc.29")).toBe("45999");
    expect(amt(result, "schc.30")).toBe("1000");
    expect(amt(result, "schc.31")).toBe("44999");
    // lines with no activity are computed zeros from the books, never missing
    expect(amt(result, "schc.8")).toBe("0");
    expect(amt(result, "schc.9")).toBe("0");
    expect(amt(result, "schc.13")).toBe("0");
    // Part III is not needed
    expect(st(result, "schc.42")).toBe("not_applicable");
    // detail for the PDF: Part V item and meals
    expect(detail.otherExpenseItems).toEqual([{ code: "5060", name: "Bank fees & service charges", amountCents: 30_000 }]);
    expect(detail.lines.find((l) => l.lineId === "24b")?.accounts[0]?.rawCents).toBe(100_100);
  });

  it("the 50% meals rule is applied once to the line total (two accounts: 0.25 + 0.25 -> round(0.25))", () => {
    const { result } = computeScheduleC(
      input({
        glLines: [
          gl("4000", "Services", "revenue", 100_000),
          gl("1", "Meals:Meals with clients", "expense", 25),
          gl("2", "Meals:Travel meals", "expense", 25),
        ],
      })
    );
    expect(amt(result, "schc.24b")).toBe("0");
    const big = computeScheduleC(
      input({ glLines: [gl("4000", "Services", "revenue", 100_000), gl("1", "Meals", "expense", 301)] })
    ).result;
    // $3.01 x 50% = 1.505 -> 2
    expect(amt(big, "schc.24b")).toBe("2");
  });

  it("home-office accounts are not part of Schedule C profit under the simplified method", () => {
    const { result, detail } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("9000", "Home office:Rent", "expense", 500_000)] })
    );
    expect(amt(result, "schc.28")).toBe("14001");
    expect(detail.homeOfficeActualCandidates).toEqual([{ code: "9000", name: "Home office:Rent", totalCents: 500_000 }]);
    expect(result.reasons.join(" ")).toContain("left out of Schedule C");
  });

  it("an unmapped GL account makes expenses missing_input and lists the account (never silently 0)", () => {
    const { result, detail } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("7777", "Mystery account", "expense", 12_345)] })
    );
    expect(st(result, "schc.28")).toBe("missing_input");
    expect(st(result, "schc.31")).toBe("missing_input");
    expect(amt(result, "schc.31")).toBeNull();
    expect(detail.unmapped).toEqual([{ code: "7777", name: "Mystery account", totalCents: 12_345, glType: "expense" }]);
    expect(result.inputsMissing.join(" ")).toContain("Mystery account");
    // income lines are still fine
    expect(amt(result, "schc.7")).toBe("60000");
  });

  it("an unmapped income account blocks the income side only", () => {
    const { result } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("4999", "Mystery income", "revenue", 10_000)] })
    );
    expect(st(result, "schc.7")).toBe("missing_input");
    expect(st(result, "schc.28")).toBe("computed");
    expect(st(result, "schc.31")).toBe("missing_input");
  });

  it("needs_cpa accounts with a balance (client entertainment) -> needs_cpa_judgment on the expense total", () => {
    const { result, detail } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("5100", "Entertainment with clients", "expense", 50_000)] })
    );
    expect(st(result, "schc.28")).toBe("needs_cpa_judgment");
    expect(st(result, "schc.31")).toBe("needs_cpa_judgment");
    expect(detail.needsCpa).toHaveLength(1);
  });

  it("a zero-balance unmapped account does not block", () => {
    const { result } = computeScheduleC(input({ glLines: [...input().glLines, gl("7777", "Mystery account", "expense", 0)] }));
    expect(st(result, "schc.31")).toBe("computed");
  });

  it("cost of goods sold with a balance -> needs_cpa_judgment (inventory not modeled); none -> Part III not applicable", () => {
    const { result } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("6000", "Cost of goods sold:Supplies & materials", "expense", 20_000)] })
    );
    expect(st(result, "schc.4")).toBe("needs_cpa_judgment");
    expect(st(result, "schc.7")).toBe("needs_cpa_judgment");
    expect(st(result, "schc.42")).toBe("needs_cpa_judgment");
  });

  it("no GL activity at all -> missing_input (zero activity is not assumed)", () => {
    const { result } = computeScheduleC(input({ glLines: [], booksEmpty: true }));
    expect(result.status).toBe("missing_input");
    expect(amt(result, "schc.31")).toBeNull();
  });
});

describe("computeScheduleC: line 9 (car and truck)", () => {
  it("no log and no 'none' statement -> missing_input; the owner's 'none' answer is a confirmed $0", () => {
    const missing = computeScheduleC(input({ mileageNoneConfirmed: false })).result;
    expect(st(missing, "schc.9")).toBe("missing_input");
    expect(st(missing, "schc.28")).toBe("missing_input");
    const none = computeScheduleC(input({ mileageNoneConfirmed: true })).result;
    expect(amt(none, "schc.9")).toBe("0");
    expect(none.lines.find((l) => l.key === "schc.9")?.reason).toContain("no business mileage");
  });

  it("standard mileage from the log: 1,000 miles x $0.700 = $700", () => {
    const { result, detail } = computeScheduleC(
      input({ mileageNoneConfirmed: false, mileage: [{ miles: 1000, ratePerMile: "0.700", dateIso: "2025-05-01" }] })
    );
    expect(amt(result, "schc.9")).toBe("700");
    expect(detail.mileage).toEqual({ entries: 1, miles: 1000, deductionCents: 70_000 });
  });

  it("a log that contradicts the 'no mileage' answer, or mileage together with actual vehicle expenses -> needs_cpa_judgment", () => {
    const contradict = computeScheduleC(input({ mileage: [{ miles: 10, ratePerMile: "0.700", dateIso: "2025-05-01" }] })).result;
    expect(st(contradict, "schc.9")).toBe("needs_cpa_judgment");
    const both = computeScheduleC(
      input({
        mileageNoneConfirmed: false,
        mileage: [{ miles: 10, ratePerMile: "0.700", dateIso: "2025-05-01" }],
        glLines: [...input().glLines, gl("8000", "Vehicle expenses:Vehicle gas & fuel", "expense", 10_000)],
      })
    ).result;
    expect(st(both, "schc.9")).toBe("needs_cpa_judgment");
  });

  it("actual vehicle expenses with no mileage log -> needs_cpa_judgment (method and business-use % are a CPA call)", () => {
    const { result } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("8000", "Vehicle expenses:Vehicle gas & fuel", "expense", 10_000)] })
    );
    expect(st(result, "schc.9")).toBe("needs_cpa_judgment");
  });
});

describe("computeScheduleC: line 13 (depreciation)", () => {
  const asset = {
    id: "a1",
    description: "Barn renovation",
    placedInServiceIso: "2025-07-15",
    costBasisCents: 5_000_000,
    isRealProperty: true,
    landValueCents: null,
    businessUsePercent: 100,
  };
  it("assets on the register -> not_yet_computed (Form 4562 is Phase 2), never 0; profit blocked", () => {
    const { result } = computeScheduleC(input({ fixedAssets: [asset], fixedAssetsNoneConfirmed: false }));
    expect(st(result, "schc.13")).toBe("not_yet_computed");
    expect(amt(result, "schc.13")).toBeNull();
    expect(st(result, "schc.31")).toBe("not_yet_computed");
  });
  it("empty register without confirmation -> missing_input", () => {
    const { result } = computeScheduleC(input({ fixedAssetsNoneConfirmed: false }));
    expect(st(result, "schc.13")).toBe("missing_input");
  });
  it("booked depreciation with an empty register -> needs_cpa_judgment", () => {
    const { result } = computeScheduleC(
      input({ glLines: [...input().glLines, gl("9500", "Depreciation", "expense", 100_000)] })
    );
    expect(st(result, "schc.13")).toBe("needs_cpa_judgment");
  });
});

describe("computeScheduleC: line 30 home office (decision X1)", () => {
  it("undecided: simplified is used and marked 'default, undecided'; the actual method is listed, not computed", () => {
    const { result } = computeScheduleC(input());
    expect(result.decision).toMatchObject({ id: "X1", chosen: "simplified", status: "default_undecided" });
    expect(result.alternatives?.map((a) => [a.id, a.status, a.inForce])).toEqual([
      ["simplified", "computed", true],
      ["actual", "not_yet_computed", false],
    ]);
  });

  it("only 300 sq ft count: a 1,200 sq ft barn space -> $1,500", () => {
    const { result } = computeScheduleC(input({ homeOfficeSqft: 1200 }));
    expect(amt(result, "schc.30")).toBe("1500");
  });

  it("the CPA choosing the actual method -> line 30 not_yet_computed (Form 8829 is Phase 2) and the decision is recorded", () => {
    const { result } = computeScheduleC(
      input({ homeOfficeDecision: { chosen: "actual", by: "cpa", at: "2026-10-06T00:00:00Z" } })
    );
    expect(st(result, "schc.30")).toBe("not_yet_computed");
    expect(result.decision).toMatchObject({ chosen: "actual", status: "decided", decidedBy: "cpa" });
    expect(st(result, "schc.31")).toBe("not_yet_computed");
  });

  it("eligibility unanswered -> missing_input; 'no' or shared use -> not_applicable $0; exclusive but no square footage -> missing_input", () => {
    expect(st(computeScheduleC(input({ homeOfficeEligibility: null })).result, "schc.30")).toBe("missing_input");
    const no = computeScheduleC(input({ homeOfficeEligibility: "no" })).result;
    expect(st(no, "schc.30")).toBe("not_applicable");
    expect(amt(no, "schc.31")).toBe("45999");
    const shared = computeScheduleC(input({ homeOfficeEligibility: "yes_shared" })).result;
    expect(amt(shared, "schc.30")).toBe("0");
    expect(st(computeScheduleC(input({ homeOfficeSqft: null })).result, "schc.30")).toBe("missing_input");
  });
});
