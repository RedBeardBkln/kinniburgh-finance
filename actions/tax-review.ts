"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runReviewForYear } from "@/lib/tax-review-build";
import { describeStoreFailure, loadReviewContext, readReviewRecords, stateOf } from "@/lib/tax-review-server";
import { getRunWithFindings, insertDisposition, insertReviewRun, listRuns } from "@/lib/tax-review-store";
import { findingRefSchema, looksLikeIdentifier, reasonSchema, reviewYearSchema, SSN_REASON_ERROR, writeReviewAudit, type ReviewActionResult } from "@/lib/tax-review-action-support";
import { toFindingDto, toRunDto, type FindingDto, type RunDto } from "@/lib/tax-review/state";

// AI Return Reviewer, Final review: run the checks, list runs and findings, accept or reopen a finding (ai-return-reviewer, A6).
//
// Every export starts with requireAuth() and the tax-year guard. NOTHING the gate depends on comes from the client: the return
// fingerprint, the engine state and who the owner is are recomputed here for every call (lib/tax-review-server.ts), and an input
// carrying a fingerprint, a verdict or any other extra field is rejected (strict schemas). Stored runs, findings and
// dispositions are INSERT-ONLY (lib/tax-review-store.ts): accepting never edits or deletes a finding, it adds a disposition
// row with the reason. Reasons are tax records: stored, shown, hashed nowhere else, and NEVER written to AuditLog (which holds
// ids, fingerprints and counts only).

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const yearOnly = z.object({ taxYear: reviewYearSchema }).strict();
const runIdSchema = z.object({ taxYear: reviewYearSchema, runId: z.string().uuid("Not a review run.") }).strict();
const acceptSchema = z.object({ taxYear: reviewYearSchema }).merge(findingRefSchema).extend({ reason: reasonSchema }).strict();
const reopenSchema = z.object({ taxYear: reviewYearSchema }).merge(findingRefSchema).extend({ reason: z.string().max(500).optional() }).strict();

function revalidateYear(year: number): void {
  revalidatePath(`/tax/forms/${year}/final-review`);
  revalidatePath(`/tax/forms/${year}`);
}

const firstError = (e: z.ZodError): string => e.errors[0]?.message ?? "Invalid input";

/** Runs every deterministic check for the CURRENT return and stores the run and its findings (nothing else is changed). */
export async function runReviewChecks(input: z.input<typeof yearOnly>): Promise<ReviewActionResult<{ runId: string; findingCount: number; reused: boolean }>> {
  const user = await requireAuth();
  const parsed = yearOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const year = parsed.data.taxYear;

  const author = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  if (!author) return { ok: false, error: "Your user record was not found." };

  // READ-ONLY: builds the return, the packet and the final package in this request and runs L1 over them.
  const result = await runReviewForYear(year, author.name, "draft");
  if ("error" in result) return { ok: false, error: result.error };

  try {
    // a second click on "Run checks" for the same return state within seconds is the same run, not a new one
    const latest = (await listRuns(year, result.entityId, 1))[0];
    if (latest !== undefined && latest.fingerprint === result.fingerprint.fingerprint && Date.now() - new Date(latest.startedAt).getTime() < 15_000) {
      return { ok: true, runId: latest.id, findingCount: result.l1.findings.length, reused: true };
    }
    const stored = await insertReviewRun({
      taxYear: year,
      entityId: result.entityId,
      fingerprint: result.fingerprint.fingerprint,
      engineVersion: result.engineVersion,
      startedById: user.id,
      startedByName: author.name,
      config: result.config,
      l1Summary: result.l1Summary,
      l2Summary: result.l2Summary,
      findings: result.l1.findings,
    });
    await writeReviewAudit(user.id, "tax_review_run_started", {
      runId: stored.runId,
      taxYear: year,
      fingerprint: result.fingerprint.fingerprint,
      engineVersion: result.engineVersion,
      findingCount: stored.findingCount,
      l1Status: result.l1.status,
      counts: result.l1.summary.counts,
    });
    revalidateYear(year);
    return { ok: true, runId: stored.runId, findingCount: stored.findingCount, reused: false };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** Newest first. */
export async function listReviewRuns(input: z.input<typeof yearOnly>): Promise<ReviewActionResult<{ runs: RunDto[] }>> {
  const user = await requireAuth();
  const parsed = yearOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const loaded = await loadReviewContext(parsed.data.taxYear, user.id);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  try {
    const runs = await listRuns(parsed.data.taxYear, loaded.ctx.entityId, 25);
    return { ok: true, runs: runs.map((r) => toRunDto(r, loaded.ctx.fingerprint)) };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** One stored run with its findings, read-only (the page's run history opens past runs through this). */
export async function getReviewRun(input: z.input<typeof runIdSchema>): Promise<ReviewActionResult<{ run: RunDto; findings: FindingDto[] }>> {
  const user = await requireAuth();
  const parsed = runIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const loaded = await loadReviewContext(parsed.data.taxYear, user.id);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  try {
    const stored = await getRunWithFindings(parsed.data.runId, loaded.ctx.entityId);
    if (stored === null) return { ok: false, error: "That review run was not found." };
    const records = await readReviewRecords(loaded.ctx);
    return { ok: true, run: toRunDto(stored.run, loaded.ctx.fingerprint), findings: stored.findings.map((f) => toFindingDto(f, records.dispositions)) };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

type DispositionKind = "accepted" | "reopened";

async function recordDisposition(
  userId: string,
  v: { taxYear: 2025; findingKey: string; evidenceHash: string; reason: string },
  action: DispositionKind
): Promise<ReviewActionResult<{ dispositionId: string }>> {
  if (looksLikeIdentifier(v.reason)) return { ok: false, error: SSN_REASON_ERROR };
  const loaded = await loadReviewContext(v.taxYear, userId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { ctx } = loaded;
  // owner only (decision D6)
  if (!ctx.approver.allowed) return { ok: false, error: ctx.approver.reason ?? "Only the owner's own account can do this." };
  try {
    const records = await readReviewRecords(ctx);
    const latest = records.latest;
    if (latest === null) return { ok: false, error: "No checks have been run for this return yet." };
    // a decision about a finding means something only for the return it was found on
    if (latest.run.fingerprint !== ctx.fingerprint) return { ok: false, error: "The return changed after those checks ran. Run the checks again before deciding on a finding." };
    const finding = latest.findings.find((f) => f.key === v.findingKey && f.evidenceHash === v.evidenceHash);
    if (finding === undefined) return { ok: false, error: "That finding is not in the latest checks (it may have changed). Run the checks again." };
    if (action === "accepted" && !finding.acceptable) {
      return { ok: false, error: "This finding cannot be accepted: it is something the return must get right. Fix the return, then run the checks again." };
    }
    const stored = await insertDisposition({
      taxYear: v.taxYear,
      entityId: ctx.entityId,
      findingKey: v.findingKey,
      evidenceHash: v.evidenceHash,
      action,
      reason: v.reason === "" ? "Reopened" : v.reason,
      byId: userId,
      byName: ctx.user.name,
    });
    await writeReviewAudit(userId, "tax_review_disposition", { dispositionId: stored.id, runId: latest.run.id, taxYear: v.taxYear, findingKey: v.findingKey, evidenceHash: v.evidenceHash, action, fingerprint: ctx.fingerprint });
    revalidateYear(v.taxYear);
    return { ok: true, dispositionId: stored.id };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** Accept a finding with a written reason (owner's account only; a finding that must be fixed can never be accepted). */
export async function acceptFinding(input: z.input<typeof acceptSchema>): Promise<ReviewActionResult<{ dispositionId: string }>> {
  const user = await requireAuth();
  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  return recordDisposition(user.id, parsed.data, "accepted");
}

/** Reopen a finding that was accepted (appends a row; the earlier acceptance and its reason stay in the history). */
export async function reopenFinding(input: z.input<typeof reopenSchema>): Promise<ReviewActionResult<{ dispositionId: string }>> {
  const user = await requireAuth();
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  return recordDisposition(user.id, { ...parsed.data, reason: (parsed.data.reason ?? "").trim() }, "reopened");
}

/** The current Final review state for the page (a re-read after an action; the page itself reads it on the server). */
export async function getFinalReviewState(input: z.input<typeof yearOnly>) {
  const user = await requireAuth();
  const parsed = yearOnly.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: firstError(parsed.error) };
  const loaded = await loadReviewContext(parsed.data.taxYear, user.id);
  if (!loaded.ok) return { ok: false as const, error: loaded.error };
  try {
    return { ok: true as const, state: stateOf(loaded.ctx, await readReviewRecords(loaded.ctx)) };
  } catch (err) {
    return { ok: false as const, error: describeStoreFailure(err) };
  }
}
