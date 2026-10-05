import { dbAiRunStore } from "@/lib/tax-review-l3-store";
import type { L3StoreDb } from "@/lib/tax-review-l3-store";
import { getRunWithFindings, listApprovals, listDispositionDetails, listRuns, type ReviewStoreDb } from "@/lib/tax-review-store";
import { currentApproval, NO_REVOCATION_FACTS, type ApprovalRevocationFacts, type ApprovalRow } from "@/lib/tax-review/gate";
import type { RunEvent } from "@/lib/tax-review/llm/progress";

// What an approval is re-checked against AFTER it was recorded (integration review, observation O3): the findings of the newest run bound to
// the approved fingerprint, every disposition, and the cancellations of AI reviews of runs for that fingerprint. The rule itself is pure and
// lives in lib/tax-review/gate.ts (approvalRevocationReasons / currentApproval); this file only READS (no write of any kind, no auth: callers
// authenticate first) and is the single place the page's records and the clean-copy routes get their answer from, so they cannot disagree.
//
// A read failure rejects (the caller fails closed: the routes answer 403, the page shows the store error).

export interface RevocationFactsDeps {
  /** Test seam: the review store. Production uses the database. */
  store?: ReviewStoreDb;
  /** Test seam: the events of a run. Default: the L3 store (the same database, or `store` when one is injected). */
  listEvents?: (runId: string) => Promise<RunEvent[]>;
}

export async function readRevocationFacts(taxYear: number, entityId: string, fingerprint: string, deps: RevocationFactsDeps = {}): Promise<ApprovalRevocationFacts> {
  const runs = (await listRuns(taxYear, entityId, 25, deps.store)).filter((r) => r.fingerprint === fingerprint);
  const newest = runs[0]; // newest first
  const stored = newest === undefined ? null : await getRunWithFindings(newest.id, entityId, deps.store);
  const dispositions = await listDispositionDetails(taxYear, entityId, deps.store);
  const listEvents = deps.listEvents ?? ((runId: string) => (deps.store !== undefined ? dbAiRunStore(deps.store as unknown as L3StoreDb) : dbAiRunStore()).listEvents(runId));
  const aiCancelledAt: (Date | string)[] = [];
  for (const run of runs) {
    for (const e of await listEvents(run.id)) if (e.kind === "cancelled") aiCancelledAt.push(e.createdAt);
  }
  return { findings: stored?.findings ?? [], dispositions, aiCancelledAt };
}

/** The approval in force for exactly this fingerprint that nothing recorded since has revoked, or null. The clean-copy routes call this. */
export async function findCurrentApproval(
  taxYear: number,
  entityId: string,
  fingerprint: string,
  deps: RevocationFactsDeps = {}
): Promise<(ApprovalRow & { id: string; approvedByName: string }) | null> {
  const approvals = await listApprovals(taxYear, entityId, deps.store);
  // nothing in force for this fingerprint: no need to read anything else (and the answer cannot depend on it)
  if (currentApproval(approvals, fingerprint, NO_REVOCATION_FACTS) === null) return null;
  return currentApproval(approvals, fingerprint, await readRevocationFacts(taxYear, entityId, fingerprint, deps));
}
