import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { REASON_MAX, REASON_MIN } from "@/lib/tax-review/gate";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { isSupportedOverrideTaxYear } from "@/lib/tax2025/overrides";

// Shared pieces of the Final review server actions (actions/tax-review.ts, actions/tax-return-approval.ts). A plain module, not a
// "use server" file, so it can export schemas and helpers. No auth here: each action calls requireAuth() as its first statement.

/** Only tax year 2025 is reviewed (the same guard the overrides use). */
export const reviewYearSchema = z
  .number()
  .int()
  .refine((y): y is 2025 => isSupportedOverrideTaxYear(y), "The review is available for tax year 2025 only.");

export const SSN_REASON_ERROR = "That text looks like a Social Security number, an employer ID or a long account number; remove it.";

/** A reason or typed name: 3..500 characters, never SSN-like / EIN-like / a long digit run (refused BEFORE any database or engine call). */
export const reasonSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(REASON_MIN, `Write at least ${REASON_MIN} characters.`).max(REASON_MAX, `Keep it to ${REASON_MAX} characters or fewer.`));

export function looksLikeIdentifier(text: string): boolean {
  return containsSsnLikeText(text) || findRedactionIssues(text).length > 0;
}

const hex16 = z.string().regex(/^[0-9a-f]{16}$/, "Not a finding.");

export const findingRefSchema = z.object({ findingKey: hex16, evidenceHash: hex16 });

export type ReviewActionResult<T extends object = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string; reasons?: string[] };

export type ReviewAuditType =
  | "tax_review_run_started"
  | "tax_review_disposition"
  | "tax_return_approved"
  | "tax_return_approval_withdrawn";

/**
 * One AuditLog row: ids, fingerprints, hashes and counts only (never a reason, a name, a finding text or a value). A failure to
 * write it is logged (error class only) and does not undo the record that was just stored: the review tables are the audit
 * trail of record, this row is the cross-reference.
 */
export async function writeReviewAudit(userId: string, changeType: ReviewAuditType, after: Prisma.InputJsonValue): Promise<void> {
  try {
    await db.auditLog.create({ data: { changedBy: userId, changeType, before: Prisma.JsonNull, after } });
  } catch (err) {
    console.error("tax review audit row failed:", err instanceof Error ? err.name : "unknown error");
  }
}
