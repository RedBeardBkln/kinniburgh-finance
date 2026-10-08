// Who may mark a tax year filed or reopen it: the owner's account only (decision D2). PURE.
//
// Closing records "the return was filed", and Eric is the self-preparer of record, so this reuses the approver rule
// (lib/tax-review/approver.ts: the household user whose full name is contained in the EK Consulting entity name; no single
// match means nobody, fail closed) and only rewrites the refusal text. Reading the year's state is open to any logged-in user.

import { resolveApprover, type ApproverUser } from "@/lib/tax-review/approver";

export interface YearCloserResolution {
  allowed: boolean;
  ownerName: string | null;
  /** Plain-language reason when not allowed. */
  reason: string | null;
}

export const NOT_OWNER_MESSAGE = "Only the owner's own account can mark a tax year filed or reopen it.";
export const OWNER_UNKNOWN_MESSAGE =
  "The owner's account could not be identified (no single user matches the consulting entity's name), so no tax year can be marked filed or reopened.";

export function resolveYearCloser(users: readonly ApproverUser[], ekcEntityName: string | null, sessionUserId: string): YearCloserResolution {
  const r = resolveApprover(users, ekcEntityName, sessionUserId);
  if (r.allowed) return { allowed: true, ownerName: r.ownerName, reason: null };
  return { allowed: false, ownerName: r.ownerName, reason: r.ownerName === null ? OWNER_UNKNOWN_MESSAGE : NOT_OWNER_MESSAGE };
}
