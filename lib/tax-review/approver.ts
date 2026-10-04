// Who may approve the return and accept findings (decisions D5 / D6): Eric's account only. PURE.
//
// How the account is identified. The repo has no "Eric" flag on the User row (`role` is "owner" for BOTH spouses, the seed e-mail is
// a placeholder that can change, and the e-mail of the person running the app is not stored anywhere as "the preparer"). The one
// rule the repo already uses to say "this user is the person who owns the consulting business" is lib/tax2025/derive.ts
// inferScheduleCOwner: the household user whose full name is contained in the EK Consulting entity name ("Eric Kinniburgh
// Consulting, LLC" -> the user named "Eric Kinniburgh"); a tie or no match is "unknown". The return itself names that user as the
// Schedule C owner, so he is also the preparer of record who signs. The approver is that user; if the rule cannot name exactly one
// user the answer is "nobody may approve" (fail closed), never a guess.

import { inferScheduleCOwner } from "@/lib/tax2025/derive";

export interface ApproverUser {
  id: string;
  name: string;
}

export interface ApproverResolution {
  /** The signed-in account is the owner's. */
  allowed: boolean;
  /** The owner's full name as on his account (null when nobody could be named). */
  ownerName: string | null;
  /** Plain-language reason when not allowed (never includes a name other than the signed-in user's own). */
  reason: string | null;
}

export function resolveApprover(users: readonly ApproverUser[], ekcEntityName: string | null, sessionUserId: string): ApproverResolution {
  if (ekcEntityName === null || ekcEntityName.trim() === "") {
    return { allowed: false, ownerName: null, reason: "The owner's account could not be identified (the consulting entity was not found), so nothing can be approved." };
  }
  const owner = inferScheduleCOwner(ekcEntityName, users);
  if (owner === null) {
    return { allowed: false, ownerName: null, reason: "The owner's account could not be identified (no single user matches the consulting entity's name), so nothing can be approved." };
  }
  const user = users.find((u) => u.id === owner.userId);
  if (user === undefined) return { allowed: false, ownerName: null, reason: "The owner's account could not be identified." };
  if (user.id !== sessionUserId) {
    return { allowed: false, ownerName: user.name, reason: "Only the owner's own account can approve the return or accept a finding." };
  }
  return { allowed: true, ownerName: user.name, reason: null };
}
