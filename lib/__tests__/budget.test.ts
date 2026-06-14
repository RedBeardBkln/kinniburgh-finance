import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  computeBudgetSummary,
  computeRolloverToNext,
  sumActualSpend,
} from "../budget";

const D = (s: string) => new Decimal(s);

describe("computeBudgetSummary", () => {
  it("calculates remaining for underspend scenario", () => {
    const r = computeBudgetSummary({
      budgeted: D("1200"),
      rolloverAmount: D("0"),
      actualSpend: D("-800"),
    });
    expect(r.effectiveBudget.toString()).toBe("1200");
    expect(r.remaining.toString()).toBe("400");
    expect(r.isOverspent).toBe(false);
    expect(r.percentUsed).toBeCloseTo(66.67, 1);
  });

  it("detects overspend", () => {
    const r = computeBudgetSummary({
      budgeted: D("1200"),
      rolloverAmount: D("0"),
      actualSpend: D("-1300"),
    });
    expect(r.remaining.toString()).toBe("-100");
    expect(r.isOverspent).toBe(true);
    expect(r.percentUsed).toBeCloseTo(108.33, 1);
  });

  it("applies positive rollover (underspend from prior month)", () => {
    const r = computeBudgetSummary({
      budgeted: D("1200"),
      rolloverAmount: D("200"),
      actualSpend: D("-1100"),
    });
    expect(r.effectiveBudget.toString()).toBe("1400");
    expect(r.remaining.toString()).toBe("300");
    expect(r.isOverspent).toBe(false);
  });

  it("applies negative rollover (overspend carried forward)", () => {
    const r = computeBudgetSummary({
      budgeted: D("1200"),
      rolloverAmount: D("-150"),
      actualSpend: D("-800"),
    });
    expect(r.effectiveBudget.toString()).toBe("1050");
    expect(r.remaining.toString()).toBe("250");
    expect(r.isOverspent).toBe(false);
  });

  it("handles zero actual spend", () => {
    const r = computeBudgetSummary({
      budgeted: D("300"),
      rolloverAmount: D("0"),
      actualSpend: D("0"),
    });
    expect(r.remaining.toString()).toBe("300");
    expect(r.percentUsed).toBe(0);
    expect(r.isOverspent).toBe(false);
  });

  it("handles zero budget with no spend", () => {
    const r = computeBudgetSummary({
      budgeted: D("0"),
      rolloverAmount: D("0"),
      actualSpend: D("0"),
    });
    expect(r.percentUsed).toBe(0);
  });

  it("uses exact cents from source data: x2540 Eversource budget $172, accrual $184", () => {
    // Budget line is $172; actual bill might be $184 — should show overspend
    const r = computeBudgetSummary({
      budgeted: D("172"),
      rolloverAmount: D("0"),
      actualSpend: D("-184"),
    });
    expect(r.remaining.toString()).toBe("-12");
    expect(r.isOverspent).toBe(true);
  });
});

describe("computeRolloverToNext", () => {
  it("returns remaining as rollover", () => {
    const summary = computeBudgetSummary({
      budgeted: D("1200"),
      rolloverAmount: D("0"),
      actualSpend: D("-900"),
    });
    const rollover = computeRolloverToNext(summary);
    expect(rollover.toString()).toBe("300");
  });

  it("returns negative rollover for overspend", () => {
    const summary = computeBudgetSummary({
      budgeted: D("1200"),
      rolloverAmount: D("0"),
      actualSpend: D("-1350"),
    });
    expect(computeRolloverToNext(summary).toString()).toBe("-150");
  });
});

describe("sumActualSpend", () => {
  it("sums negative transaction amounts", () => {
    const total = sumActualSpend([D("-45.23"), D("-12.00"), D("-78.50")]);
    expect(total.toString()).toBe("-135.73");
  });

  it("handles empty array", () => {
    expect(sumActualSpend([]).toString()).toBe("0");
  });

  it("handles mixed income and expense on same tag", () => {
    // Reimbursement scenario: outflow then refund
    const total = sumActualSpend([D("-100"), D("30")]);
    expect(total.toString()).toBe("-70");
  });
});
