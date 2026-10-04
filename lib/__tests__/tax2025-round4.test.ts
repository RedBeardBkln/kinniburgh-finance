// Round 4: interest earned on the business bank account (GL "Other income:Interest earned") is taxable INTEREST
// (Form 1040 line 2b / Schedule B), not Schedule C income and not a needs-CPA block.

import { describe, expect, it } from "vitest";
import { CONSTANTS } from "@/lib/tax2025/constants";
import { GL_SCHEDULE_C_MAP, findGlMapEntry } from "@/lib/tax2025/gl-schedule-c-map";
import { resolveFacts, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { computeScheduleC, type ScheduleCInput } from "@/lib/tax2025/rules/schedule-c";
import { ERIC_ID, fullFacts, gl, owner } from "@/lib/__tests__/tax2025-fixtures";

const INTEREST = "Other income:Interest earned";

describe("GL map and constant", () => {
  it("the interest account routes to 1040 line 2b (no longer needs_cpa); the parent Other income stays Schedule C line 6", () => {
    expect(findGlMapEntry(INTEREST)?.target).toEqual({ kind: "interest_to_1040_2b" });
    expect(findGlMapEntry("Other income")?.target).toEqual({ kind: "line", line: "6" });
    expect(GL_SCHEDULE_C_MAP.filter((e) => e.target.kind === "needs_cpa")).toHaveLength(13);
    expect(GL_SCHEDULE_C_MAP.filter((e) => e.target.kind === "interest_to_1040_2b").map((e) => e.account)).toEqual([INTEREST]);
  });
  it("the routing rule is registered with its primary source", () => {
    const c = CONSTANTS.BUSINESS_BANK_INTEREST_ROUTING;
    expect(c.url).toBe("https://www.irs.gov/instructions/i1040sb");
    expect(c.verifiedOn).toBe("2026-10-04");
    expect(c.note).toContain("Schedule B");
    expect(c.note).toContain("line 2b");
  });
});

const base = (over: Partial<ScheduleCInput> = {}): ScheduleCInput => ({
  glLines: [gl("4000", "Services", "revenue", 6_000_000), gl("5010", "Office expenses:Software & apps", "expense", 600_000), gl("4900", INTEREST, "revenue", 12)],
  booksEmpty: false,
  mileage: [],
  mileageNoneConfirmed: true,
  homeOfficeEligibility: "no",
  homeOfficeSqft: null,
  fixedAssets: [],
  fixedAssetsNoneConfirmed: true,
  ...over,
});

describe("Schedule C rule", () => {
  it("$0.12 of books interest: Schedule C net profit is computable (54,000), line 6 is 0, the interest is reported separately and nothing needs the CPA", () => {
    const { result, detail } = computeScheduleC(base());
    const l = (k: string) => result.lines.find((x) => x.key === k)!;
    expect(l("schc.31").status).toBe("computed");
    expect(l("schc.31").amount?.toString()).toBe("54000");
    expect(l("schc.6").amount?.toString()).toBe("0");
    expect(l("schc.7").amount?.toString()).toBe("60000");
    expect(detail.booksInterest).toEqual([{ code: "4900", name: INTEREST, amountCents: 12 }]);
    expect(detail.needsCpa).toEqual([]);
    expect(result.inputsMissing).toEqual([]);
  });

  it("a net-negative interest account is a sign flip: needs_cpa_judgment, never added to interest or income", () => {
    const { result, detail } = computeScheduleC(
      base({ glLines: [gl("4000", "Services", "revenue", 6_000_000), { ...gl("4900", INTEREST, "revenue", 12), signedCents: -12 }] })
    );
    expect(result.lines.find((x) => x.key === "schc.31")?.status).toBe("needs_cpa_judgment");
    expect(detail.booksInterest).toEqual([]);
    expect(detail.needsCpa.map((n) => n.code)).toEqual(["4900"]);
  });
});

function withBooksInterest(cents: number, docInterestCents = 50_000) {
  const f = fullFacts();
  f.income.interest[0]!.box1Cents = docInterestCents;
  f.income.scheduleC.glLines.push(gl("4900", INTEREST, "revenue", cents));
  return f;
}

describe("the return", () => {
  it("golden fixture without such an account is unchanged", () => {
    const ret = computeTy2025Return(fullFacts());
    expect(ret.lines["f1040.2b"]?.amount).toBe(500);
    expect(ret.headline.federal.totalTax.amount).toBe(27015);
    expect(ret.openItems.some((o) => o.id === "books-interest-routed")).toBe(false);
    expect(ret.scheduleC?.booksInterest).toEqual([]);
  });

  it("$0.12 books interest: line 2b adds the cents BEFORE rounding (500.45 + 0.12 = 500.57 -> 501), Schedule B line 2 too, Schedule C unchanged, complete", () => {
    const without = computeTy2025Return(withBooksInterest(0, 50_045));
    expect(without.lines["f1040.2b"]?.amount).toBe(500);
    const ret = computeTy2025Return(withBooksInterest(12, 50_045));
    expect(ret.lines["f1040.2b"]?.amount).toBe(501);
    expect(ret.lines["f1040.2b"]?.exact).toBe("500.57");
    expect(ret.lines["schb.2"]?.amount).toBe(501);
    expect(ret.lines["f1040.2b"]?.reason).toContain("books");
    expect(ret.lines["f1040.2b"]?.refs.some((r) => r.kind === "gl" && r.id === "4900")).toBe(true);
    expect(ret.lines["schc.31"]?.amount).toBe(50000);
    expect(ret.lines["schc.6"]?.amount).toBe(0);
    expect(ret.lines["f1040.9"]?.amount).toBe(181501);
    expect(ret.lines["f1040.11a"]?.amount).toBe(177968); // 181,501 - half SE 3,533
    expect(ret.headline.complete).toBe(true);
    expect(ret.headline.blockingItemCount).toBe(0);
    expect(ret.scheduleC?.booksInterest).toEqual([{ code: "4900", name: INTEREST, amountCents: 12 }]);
  });

  it("an advisory explains the routing and a conflict flags possible double counting with a 1099-INT (nothing is subtracted)", () => {
    const ret = computeTy2025Return(withBooksInterest(12));
    const item = ret.openItems.find((o) => o.id === "books-interest-routed");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("NOT as Schedule C income");
    expect(item?.message).toContain("$0.12");
    const c = ret.conflicts.find((x) => x.factKey === "income.interest.books");
    expect(c?.chosen).toBe("both counted");
    expect(c?.candidates.map((x) => x.basis)).toEqual(["books", "doc_verified"]);
    expect(ret.lines["f1040.2b"]?.amount).toBe(500); // 500.00 + 0.12 = 500.12 -> 500, nothing subtracted
  });

  it("no 1099-INT on file (owner confirmed none): the advisory appears but there is no duplicate conflict; interest is only the books amount", () => {
    const f = fullFacts();
    f.income.interest = [];
    f.income.noInterestConfirmed = owner(true);
    f.income.scheduleC.glLines.push(gl("4900", INTEREST, "revenue", 12));
    const ret = computeTy2025Return(f);
    expect(ret.openItems.some((o) => o.id === "books-interest-routed")).toBe(true);
    expect(ret.conflicts.some((x) => x.factKey === "income.interest.books")).toBe(false);
    expect(ret.lines["f1040.2b"]?.exact).toBe("0.12");
    expect(ret.lines["f1040.2b"]?.amount).toBe(0);
  });

  it("large interest still routes sensibly: $5,000 of books interest raises line 2b past the Schedule B threshold and the NIIT screen sees it", () => {
    const ret = computeTy2025Return(withBooksInterest(500_000, 0));
    expect(ret.lines["f1040.2b"]?.amount).toBe(5000);
    expect(ret.lines["schc.31"]?.amount).toBe(50000);
    expect(ret.formsRequired.schb?.required).toBe(true);
    expect(ret.lines["f8960.nii"]?.amount).toBe(6000); // 5,000 interest + 1,000 dividends
  });

  it("negative books interest blocks (sign flip), it never silently reduces interest", () => {
    const f = fullFacts();
    f.income.scheduleC.glLines.push({ ...gl("4900", INTEREST, "revenue", 12), signedCents: -12 });
    const ret = computeTy2025Return(f);
    expect(ret.lines["schc.31"]?.status).toBe("needs_cpa_judgment");
    expect(ret.lines["f1040.2b"]?.amount).toBe(500);
  });

  it("resolver: a net-negative interest account raises the blocking sign-flip item", () => {
    const raw: RawTy2025Inputs = {
      taxYear: 2025,
      people: [{ userId: ERIC_ID, name: "Eric" }],
      scheduleCOwner: null,
      documents: [],
      planning: { filingStatus: "mfj", householdMembers: null, evVehicle: null, businessMileage: null, homeOfficeEligibility: null, homeOfficeSqft: null, solarCredit: null, donationsNone: false, fixedAssetsEkcNone: false, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
      primaryResidence: null,
      paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
      ekc: { glLines: [{ ...gl("4900", INTEREST, "revenue", 12), signedCents: -12 }], booksEmpty: false, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
      donations: [],
    };
    expect(resolveFacts(raw).openItems.find((o) => o.id === "gl-sign-flip:4900")?.severity).toBe("blocking");
  });
});
