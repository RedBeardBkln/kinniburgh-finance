import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  validateTransferPair,
  wouldBreachMinimum,
  balanceCushion,
  projectBalance,
  findFirstBreach,
  TD_MINIMUM_BALANCE,
} from "../transfer";

const D = (s: string) => new Decimal(s);
const MIN = TD_MINIMUM_BALANCE; // $250

describe("validateTransferPair", () => {
  it("passes when outflow and inflow match in absolute value", () => {
    expect(validateTransferPair(D("-256"), D("256"))).toBe(true);
  });

  it("fails when amounts differ", () => {
    expect(validateTransferPair(D("-256"), D("255.99"))).toBe(false);
  });

  it("passes for the $400/wk Mortgage & Insurance transfer", () => {
    expect(validateTransferPair(D("-400"), D("400"))).toBe(true);
  });

  it("passes for $2350 semi-monthly mortgage funding", () => {
    expect(validateTransferPair(D("-2350"), D("2350"))).toBe(true);
  });
});

describe("wouldBreachMinimum", () => {
  it("returns false when balance stays above minimum after transfer", () => {
    // x2566 has $5000; $256/wk transfer → $4744 > $250
    expect(wouldBreachMinimum(D("5000"), D("-256"), MIN)).toBe(false);
  });

  it("returns true when balance would fall below $250 (TD fee trigger)", () => {
    // Balance $300, transfer $256 → $44 < $250
    expect(wouldBreachMinimum(D("300"), D("-256"), MIN)).toBe(true);
  });

  it("returns false at exactly $250 (not below)", () => {
    // Balance $506, transfer $256 → exactly $250 = minimum, NOT below
    expect(wouldBreachMinimum(D("506"), D("-256"), MIN)).toBe(false);
  });

  it("returns true when already below minimum", () => {
    expect(wouldBreachMinimum(D("200"), D("-1"), MIN)).toBe(true);
  });

  it("returns true when transfer pushes to exactly $249.99", () => {
    expect(wouldBreachMinimum(D("505.99"), D("-256"), MIN)).toBe(true);
    // 505.99 - 256 = 249.99 < 250
  });
});

describe("balanceCushion", () => {
  it("returns positive cushion when above minimum after transfer", () => {
    // $506 - $256 - $250 = $0 cushion (just at min)
    expect(balanceCushion(D("506"), D("-256"), MIN).toString()).toBe("0");
  });

  it("returns negative cushion when minimum would be breached", () => {
    // $300 - $256 - $250 = -$206
    expect(balanceCushion(D("300"), D("-256"), MIN).toString()).toBe("-206");
  });
});

describe("projectBalance", () => {
  it("applies all scheduled amounts to starting balance", () => {
    // Eric paycheck $2000 on 15th, then $400 weekly transfer out, then $256 weekly transfer out
    const projected = projectBalance(D("2500"), [
      D("2000"),  // income
      D("-400"),  // x2558 transfer
      D("-256"),  // x2540 transfer
    ]);
    expect(projected.toString()).toBe("3844");
  });

  it("handles empty schedule", () => {
    expect(projectBalance(D("1000"), []).toString()).toBe("1000");
  });
});

describe("findFirstBreach", () => {
  it("returns -1 when no breach", () => {
    const amounts = [D("-100"), D("-100"), D("-100")];
    expect(findFirstBreach(D("1000"), amounts, MIN)).toBe(-1);
  });

  it("returns index of first breach", () => {
    // Balance $500, three $150 outflows: 500 → 350 → 200 (breach at index 1)
    const amounts = [D("-150"), D("-150"), D("-150")];
    expect(findFirstBreach(D("500"), amounts, MIN)).toBe(1);
  });

  it("detects breach at index 0 if starting balance is low", () => {
    expect(findFirstBreach(D("260"), [D("-20")], MIN)).toBe(0);
    // 260 - 20 = 240 < 250
  });

  it("models the Heating & Electric weekly drain correctly", () => {
    // x2540 starts at $800; drains $506/mo solar on 20th + fluctuating Eversource
    // Simulate: 4 weekly $256 inflows, then $506 solar + $184 Eversource out
    const schedule = [
      D("256"),   // week 1 transfer in
      D("256"),   // week 2
      D("256"),   // week 3
      D("256"),   // week 4
      D("-506"),  // solar autopay
      D("-184"),  // Eversource autopay
    ];
    // 800 → 1056 → 1312 → 1568 → 1824 → 1318 → 1134  — never below $250
    expect(findFirstBreach(D("800"), schedule, MIN)).toBe(-1);
  });
});
