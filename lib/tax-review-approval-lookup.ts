import { findCurrentApproval } from "@/lib/tax-review-approval-facts";
import type { RunEvent } from "@/lib/tax-review/llm/progress";
import type { ReviewStoreDb } from "@/lib/tax-review-store";
import { resolvePersonalEntityId } from "@/lib/tax2025-overrides-build";
import type { ApprovalLookup } from "@/lib/tax2025-pdf-approval";

// The store-backed ApprovalLookup the PDF routes use (ai-return-reviewer, A6; plan 5.7). A clean copy or the final package is served
// only when the LATEST word on the approval is "approved" (not "withdrawn") AND that approval is bound to exactly the fingerprint
// the route computed server-side from the live inputs just now (buildPdfViewForYear puts the return fingerprint v2 into the view).
// Any later change of the return gives a different fingerprint, so the old approval stops matching without being deleted, and a
// withdrawal row clears it. Two more things revoke it without a change of the return (lib/tax-review/gate.ts approvalRevocationReasons):
// a finding that blocks approval is open again (reopened, or a new one stored after the approval) and a cancelled AI review.
// Read-only; a failure rejects, and the route treats a rejection as "not approved" (fail closed).

export interface ApprovalLookupDeps {
  resolveEntityId?: () => Promise<string | null>;
  /** Test seam: the review store. Production uses the database. */
  store?: ReviewStoreDb;
  /** Test seam: the events of a run (the AI review cancellations are read from them). Default: the database, or `store` when one is injected. */
  listEvents?: (runId: string) => Promise<RunEvent[]>;
}

export const APPROVAL_TAX_YEAR = 2025 as const;

export function makeApprovalLookup(deps: ApprovalLookupDeps = {}): ApprovalLookup {
  async function current(fingerprint: string) {
    // a fingerprint that is not 64 hex cannot be an approved one (never reaches the database)
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) return null;
    const entityId = await (deps.resolveEntityId ?? resolvePersonalEntityId)();
    if (!entityId) return null;
    return findCurrentApproval(APPROVAL_TAX_YEAR, entityId, fingerprint, { ...(deps.store !== undefined ? { store: deps.store } : {}), ...(deps.listEvents !== undefined ? { listEvents: deps.listEvents } : {}) });
  }
  return {
    currentApproval: async (fingerprint) => (await current(fingerprint)) !== null,
    approvedAt: async (fingerprint) => {
      const row = await current(fingerprint);
      return row === null ? null : new Date(row.at).toISOString();
    },
  };
}

export const storeApprovalLookup: ApprovalLookup = makeApprovalLookup();
