// L2: independent recomputation (plan sections 5.4 and 8.3). PHASE C builds the real oracle (lib/tax-review/oracle/**). Until
// then this stub keeps the contract: the gate sees L2 as "not_run", which keeps it RED (owner decision D8: no waiver, approval
// waits until L2 has run for the current fingerprint). It never returns a finding, so it can never look like a pass.

import type { Finding } from "@/lib/tax-review/types";

export interface L2Coverage {
  /** A form / line group the recomputation compared. */
  area: string;
  compared: boolean;
  note: string;
}

export interface L2Result {
  status: "not_run" | "completed" | "failed";
  findings: Finding[];
  /** What was recomputed and what was not (empty until the oracle exists). */
  coverage: L2Coverage[];
}

/** Stub: the independent recomputation has not been built yet. */
export function runL2(): L2Result {
  return { status: "not_run", findings: [], coverage: [] };
}
