// Connecticut individual use tax (CT-1040 line 15 / Schedule 4), general rate only.
// Source: the 2025 CT-1040 instructions (use tax worksheet, Section B), verified
// 2026-10-03: purchases of goods or services for use in Connecticut on which no
// Connecticut sales tax was paid are taxed at the general rate of 6.35% of the
// purchase price, minus any tax paid to another state (worksheet column 6); line 15
// must be "0" when none is due. The 7.75% (luxury goods), 1% (computer and data
// processing services) and 2.99% (vessels) sections are not computed: an owner who
// has such items gets needs_cpa_judgment, never a guess.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, fmt, maxD } from "@/lib/tax2025/money";
import type { RuleStatus } from "@/lib/tax2025/types";

export type UseTaxResult =
  | { ok: true; amount: Decimal; reason: string }
  | { ok: false; status: Exclude<RuleStatus, "computed" | "not_applicable">; reason: string; missing: string };

export interface CtUseTaxInput {
  choice: Ans<"none" | "some">;
  /** Total purchase price of general-rate goods and services bought without Connecticut sales tax. */
  generalRatePurchases: Ans<Decimal>;
  /** True = there were luxury items, computer / data processing services or vessels. */
  otherRateItems: Ans<boolean>;
  /** Sales or use tax already paid to another state on those purchases. */
  taxPaidToOtherState: Ans<Decimal>;
}

export function computeCtUseTax(input: CtUseTaxInput): UseTaxResult {
  const miss = (what: string): UseTaxResult => ({ ok: false, status: "missing_input", reason: `Use tax: ${what} has not been answered (CT-1040 line 15 must be 0 or an amount).`, missing: what });
  const unsure = (what: string): UseTaxResult => ({ ok: false, status: "needs_cpa_judgment", reason: `Use tax: the owner is not sure about ${what}; the CPA decides.`, missing: what });
  const c = input.choice;
  if (c.state === "missing") return miss("whether out-of-state purchases were made without Connecticut sales tax");
  if (c.state === "unsure") return unsure("whether out-of-state purchases were made without Connecticut sales tax");
  if (c.value === "none") return { ok: true, amount: ZERO, reason: "The owner states no 2025 out-of-state purchases were made without Connecticut sales tax: line 15 is 0." };
  if (input.otherRateItems.state === "missing") return miss("whether any purchases were luxury items, computer services or vessels");
  if (input.otherRateItems.state === "unsure") return unsure("whether any purchases were luxury items, computer services or vessels");
  if (input.otherRateItems.value) {
    return { ok: false, status: "needs_cpa_judgment", reason: "Use tax: some purchases are at the 7.75%, 1% or 2.99% rate, whose worksheet sections are not computed here.", missing: "Use tax worksheet sections A, C, D" };
  }
  if (input.generalRatePurchases.state === "missing") return miss("the total of purchases subject to use tax");
  if (input.generalRatePurchases.state === "unsure") return unsure("the total of purchases subject to use tax");
  if (input.taxPaidToOtherState.state === "missing") return miss("the tax already paid to another state on those purchases");
  if (input.taxPaidToOtherState.state === "unsure") return unsure("the tax already paid to another state on those purchases");
  const rate = D(K.CT_USE_TAX_RATE_GENERAL.value);
  const gross = input.generalRatePurchases.value.times(rate);
  const amount = maxD(ZERO, gross.minus(input.taxPaidToOtherState.value));
  return {
    ok: true,
    amount,
    reason: `Use tax ${fmt(amount)}: ${fmt(input.generalRatePurchases.value)} of purchases x ${rate.times(100).toString()}% = ${fmt(gross.toDecimalPlaces(2))}, minus ${fmt(input.taxPaidToOtherState.value)} already paid to another state.`,
  };
}
