"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { describeStoreFailure, loadReviewContext, readReviewRecords, stateOf } from "@/lib/tax-review-server";
import { insertApproval } from "@/lib/tax-review-store";
import { looksLikeIdentifier, reasonSchema, reviewYearSchema, SSN_REASON_ERROR, writeReviewAudit, type ReviewActionResult } from "@/lib/tax-review-action-support";
import { approvalInForce, ATTESTATION_VERSION, attestationTextHash, evaluateApproval, gateSnapshot, typedConfirmationHash } from "@/lib/tax-review/gate";

// The owner's approval of the return (ai-return-reviewer, A6; plan 5.7, decision D5).
//
// Approval is IMPOSSIBLE unless, recomputed on the server for this very call: the return fingerprint v2 equals the one the latest
// checks ran on, the gate is green (computed by code in lib/tax-review/gate.ts: engine complete, no line override, no open
// blocker/high finding, every layer run), and the signed-in account is the owner's. At this phase the independent recalculation
// (L2) and the AI review passes (L3) have not run, so the gate is red and there is NO waiver: approving is refused.
//
// Append-only: an approval is a new row; withdrawing appends a "withdrawn" row; nothing is ever updated or deleted. The attestation
// text is hashed (version id + sha256 of the text) and so is what was typed (phrase + name), so the record proves what was
// agreed without storing the typed text. AuditLog rows carry ids, fingerprints, hashes and counts only (never a name or a reason).
//
// Every export starts with requireAuth() and the tax-year guard; the inputs carry NO fingerprint and no gate state (strict schemas).

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const approveSchema = z
  .object({
    taxYear: reviewYearSchema,
    checked: z.boolean(),
    /** The attestation text the page showed; it must be the current version verbatim (the server compares it). */
    attestationText: z.string().max(2000),
    typedPhrase: z.string().max(100),
    typedName: z.string().max(200),
  })
  .strict();

const withdrawSchema = z.object({ taxYear: reviewYearSchema, reason: reasonSchema }).strict();

function revalidateYear(year: number): void {
  revalidatePath(`/tax/forms/${year}/final-review`);
  revalidatePath(`/tax/forms/${year}`);
}

const firstError = (e: z.ZodError): string => e.errors[0]?.message ?? "Invalid input";

export async function approveReturn(input: z.input<typeof approveSchema>): Promise<ReviewActionResult<{ approvalId: string }>> {
  const user = await requireAuth();
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const v = parsed.data;
  if (looksLikeIdentifier(v.typedName) || looksLikeIdentifier(v.typedPhrase)) return { ok: false, error: SSN_REASON_ERROR };

  // everything the decision depends on is recomputed here: the fingerprint, the engine state, who the owner is
  const loaded = await loadReviewContext(v.taxYear, user.id);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { ctx } = loaded;
  try {
    const records = await readReviewRecords(ctx);
    const state = stateOf(ctx, records);
    if (state.approval.current) return { ok: false, error: "This return is already approved in its current state." };
    const decision = evaluateApproval(state.gate, { checked: v.checked, attestationText: v.attestationText, typedPhrase: v.typedPhrase, typedName: v.typedName }, { approverName: ctx.approver.ownerName ?? "", approverAllowed: ctx.approver.allowed });
    if (!decision.ok) return { ok: false, error: decision.reasons[0] ?? "The return cannot be approved yet.", reasons: decision.reasons };
    const run = records.latest?.run;
    if (run === undefined || run.fingerprint !== ctx.fingerprint) return { ok: false, error: "The return changed after the last checks. Run the checks again." };

    const stored = await insertApproval({
      taxYear: v.taxYear,
      entityId: ctx.entityId,
      kind: "approved",
      runId: run.id,
      fingerprint: ctx.fingerprint,
      verdictSnapshot: gateSnapshot(state.gate),
      attestationVersion: ATTESTATION_VERSION,
      attestationTextHash: attestationTextHash(),
      typedConfirmationHash: typedConfirmationHash(v.typedPhrase, v.typedName),
      reason: null,
      approvedById: user.id,
      approvedByName: ctx.user.name,
    });
    await writeReviewAudit(user.id, "tax_return_approved", {
      approvalId: stored.id,
      runId: run.id,
      taxYear: v.taxYear,
      fingerprint: ctx.fingerprint,
      attestationVersion: ATTESTATION_VERSION,
      attestationTextHash: attestationTextHash(),
      typedConfirmationHash: typedConfirmationHash(v.typedPhrase, v.typedName),
      gate: gateSnapshot(state.gate),
    });
    revalidateYear(v.taxYear);
    return { ok: true, approvalId: stored.id };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** Withdraw the approval in force (any fingerprint): appends a "withdrawn" row with the reason; the approval row stays in the history. */
export async function withdrawApproval(input: z.input<typeof withdrawSchema>): Promise<ReviewActionResult<{ approvalId: string }>> {
  const user = await requireAuth();
  const parsed = withdrawSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const v = parsed.data;
  if (looksLikeIdentifier(v.reason)) return { ok: false, error: SSN_REASON_ERROR };

  const loaded = await loadReviewContext(v.taxYear, user.id);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { ctx } = loaded;
  if (!ctx.approver.allowed) return { ok: false, error: ctx.approver.reason ?? "Only the owner's own account can withdraw the approval." };
  try {
    const records = await readReviewRecords(ctx);
    // the latest word must be an approval (any fingerprint: a stale approval can be withdrawn too)
    const inForce = approvalInForce(records.approvals);
    if (inForce === null) return { ok: false, error: "There is no approval to withdraw." };
    const stored = await insertApproval({
      taxYear: v.taxYear,
      entityId: ctx.entityId,
      kind: "withdrawn",
      runId: inForce.runId ?? "",
      fingerprint: inForce.fingerprint,
      verdictSnapshot: {},
      attestationVersion: null,
      attestationTextHash: null,
      typedConfirmationHash: null,
      reason: v.reason,
      approvedById: user.id,
      approvedByName: ctx.user.name,
    });
    await writeReviewAudit(user.id, "tax_return_approval_withdrawn", { approvalId: stored.id, withdrawnApprovalId: inForce.id, runId: inForce.runId ?? null, taxYear: v.taxYear, fingerprint: inForce.fingerprint });
    revalidateYear(v.taxYear);
    return { ok: true, approvalId: stored.id };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}
