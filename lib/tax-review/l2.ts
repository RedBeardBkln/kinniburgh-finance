// L2: independent recomputation (plan sections 5.4 and 8.3). The oracle itself lives in lib/tax-review/l2/** (a second, separately
// written calculator). This module is the stable entry point the review runner imports.
//
//   runL2(input)    pure; { status: "ran" | "not_run", reason, findings, coverage, summary }; fails closed ("not_run", never a pass)
//   l2SummaryOf(r)  the small JSON the run stores for the gate: { status: "completed" | "not_run", mismatchCount, coverage, counts }
//
// Called without an input (the Phase A call shape) it returns "not_run", so the gate stays red exactly as before.

export { L2_VERSION, l2SummaryOf, oracleLedger, runL2, type L2Input, type L2Result, type L2Summary } from "@/lib/tax-review/l2/run";
export type { L2Coverage } from "@/lib/tax-review/l2/coverage";
