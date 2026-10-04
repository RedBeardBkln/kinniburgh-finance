// Foreign tax credit, the direct (no Form 1116) route -> Schedule 3 line 1.
// Source: the 1040 instructions (Schedule 3, line 1), verified 2026-10-03: no Form
// 1116 is needed when ALL of the foreign source income is passive-category income
// reported on qualified payee statements (Forms 1099-INT / 1099-DIV) and the total
// foreign tax is not more than $300 ($600 if married filing jointly); the credit is
// then the foreign tax paid. The foreign tax comes from 1099-INT box 6 and
// 1099-DIV box 7 only (the engine's documents).
//   * no foreign tax on any 1099          -> not_applicable $0
//   * total at most the MFJ direct limit   -> computed credit = the tax paid
//   * more than the limit                  -> needs_cpa_judgment (Form 1116 is not built)
//   * documents not all read                -> missing_input
// Conditions this engine cannot see (other foreign income, the holding period for
// foreign tax on dividends) are listed in the reasons; the CPA confirms them.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt } from "@/lib/tax2025/money";
import type { RuleResult } from "@/lib/tax2025/types";

const CITES = ["FOREIGN_TAX_DIRECT_LIMIT_MFJ", "SCH3_LINE_MAP"];
const LABEL = "Foreign tax credit";

/** `foreignTaxPaid`: 1099-INT box 6 + 1099-DIV box 7 over every 1099; null = a 1099 box was not read or no 1099 status is known. */
export function computeForeignTaxCredit(input: { foreignTaxPaid: Decimal | null }): RuleResult {
  const base = { ruleId: "foreign-tax-credit", form: "Schedule 3", citations: CITES, inputsUsed: [] };
  if (input.foreignTaxPaid === null) {
    const reason = "Foreign tax paid (1099-INT box 6, 1099-DIV box 7) is unknown: no 1099 interest or dividend document is on file and none was confirmed absent, or a box was not read.";
    return { ...base, status: "missing_input", lines: [blockedLine("sch3.1", LABEL, "1", "missing_input", reason)], reasons: [reason], inputsMissing: ["1099 interest and dividend documents (or confirmation there are none)"] };
  }
  const paid = input.foreignTaxPaid;
  if (paid.isZero()) {
    const reason = "No foreign tax is reported on any 1099-INT or 1099-DIV.";
    return { ...base, status: "not_applicable", lines: [amountLine("sch3.1", LABEL, "1", ZERO, "not_applicable", reason)], reasons: [reason], inputsMissing: [] };
  }
  const limit = D(K.FOREIGN_TAX_DIRECT_LIMIT_MFJ.value);
  if (paid.greaterThan(limit)) {
    const reason = `Foreign tax paid ${fmt(paid)} is more than the ${fmt(limit)} direct-credit limit (married filing jointly): Form 1116 is required and is not built here.`;
    return { ...base, status: "needs_cpa_judgment", lines: [blockedLine("sch3.1", LABEL, "1", "needs_cpa_judgment", reason)], reasons: [reason], inputsMissing: ["Form 1116"] };
  }
  const reason = `Direct credit without Form 1116: foreign tax paid ${fmt(paid)} is at most ${fmt(limit)}. Assumes all foreign income was passive income reported on the 1099s and, for dividends, that the holding-period rules are met (not checked here).`;
  return { ...base, status: "computed", conclusion: "eligible", lines: [amountLine("sch3.1", LABEL, "1", paid, "computed", reason)], reasons: [reason], inputsMissing: [] };
}
