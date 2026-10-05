"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runReviewForYear } from "@/lib/tax-review-build";
import { describeStoreFailure, loadReviewContext, readReviewRecords, stateOf, type ReviewContext } from "@/lib/tax-review-server";
import { getRunWithFindings, insertDisposition, insertReviewRun, listRuns } from "@/lib/tax-review-store";
import { findingRefSchema, looksLikeIdentifier, reasonSchema, reviewYearSchema, SSN_REASON_ERROR, writeReviewAudit, type ReviewActionResult } from "@/lib/tax-review-action-support";
import { toAiDto, toFindingDto, toRunDto, type AiEstimateDto, type AiReviewDto, type FindingDto, type RunDto } from "@/lib/tax-review/state";
import { prepareAiReview } from "@/lib/tax-review-l3";
import { dbAiRunStore } from "@/lib/tax-review-l3-store";
import { createAnthropicTransport } from "@/lib/tax-review-anthropic";
import { loadSourcePack } from "@/lib/tax-review-sources";
import type { LlmTransport } from "@/lib/tax-review/llm/client";
import { formatUsd } from "@/lib/tax-review/llm/model";
import { foldProgress } from "@/lib/tax-review/llm/progress";
import { cancelAiRun, runNextTask, startAiRun } from "@/lib/tax-review/llm/run";

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

// ── AI review passes (L3; ai-return-reviewer, Phase B) ──────────────────────────────────────────────────────
// The AI review attaches to a stored run of the CURRENT return (run the checks first). It is started only after the owner sees the
// cost estimate and confirms, and only from the owner's own account (it spends the owner's API credit). It runs ONE model request per
// call (the page loops), so every call fits a serverless time limit and a failed task is retried alone. The state is derived from
// append-only event rows (lib/tax-review/llm/progress.ts); the verdict and the gate stay code (lib/tax-review/gate.ts): the model can
// only ADD findings, validated by lib/tax-review/llm/validate.ts. Only counts, task states, tokens and an estimate go to the client,
// never the payload or any model text.

const aiRunSchema = z.object({ taxYear: reviewYearSchema, runId: z.string().uuid("Not a review run.") }).strict();
const aiStartSchema = z.object({ taxYear: reviewYearSchema, confirm: z.literal(true, { errorMap: () => ({ message: "Confirm the estimated cost first." }) }), acknowledgeHighCost: z.boolean().optional() }).strict();

type AiAccess = { ok: true; ctx: ReviewContext; userName: string } | { ok: false; error: string };

async function aiAccess(userId: string, year: 2025): Promise<AiAccess> {
  const author = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!author) return { ok: false, error: "Your user record was not found." };
  const loaded = await loadReviewContext(year, userId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  // owner only: the AI review spends the owner's API credit
  if (!loaded.ctx.approver.allowed) return { ok: false, error: loaded.ctx.approver.reason ?? "Only the owner's own account can run the AI review." };
  return { ok: true, ctx: loaded.ctx, userName: author.name };
}

/** The estimate and the run it would attach to. Writes nothing and calls no model. */
export async function estimateAiReview(input: z.input<typeof yearOnly>): Promise<ReviewActionResult<{ estimate: AiEstimateDto }>> {
  const user = await requireAuth();
  const parsed = yearOnly.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const year = parsed.data.taxYear;
  const access = await aiAccess(user.id, year);
  if (!access.ok) return access;
  try {
    const records = await readReviewRecords(access.ctx);
    const latest = records.latest;
    if (latest === null || latest.run.fingerprint !== access.ctx.fingerprint) return { ok: false, error: "Run the checks for the current return first; the AI review attaches to them." };
    const prep = await prepareAiReview(year, access.userName, latest.findings.filter((f) => f.layer === "L1"));
    if ("error" in prep) return { ok: false, error: prep.error };
    if (prep.fingerprint !== access.ctx.fingerprint) return { ok: false, error: "The return changed while the estimate was being prepared. Try again." };
    const e = prep.estimate;
    return {
      ok: true,
      estimate: {
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        expectedUsd: e.expectedUsd,
        worstCaseUsd: e.worstCaseUsd,
        warn: e.warn,
        warnThresholdUsd: e.warnThresholdUsd,
        priceSource: e.price.source,
        inPerMtok: e.price.inPerMtok,
        outPerMtok: e.price.outPerMtok,
        payloadBytes: prep.serialized.bytes,
        tasks: e.tasks.map((t) => ({ id: t.taskId, inputTokens: t.inputTokens, outputTokens: t.outputTokens })),
        alreadyStarted: records.ai?.started === true,
        runId: latest.run.id,
      },
    };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** Starts the AI review of the current run after the owner confirmed the estimate. Idempotent: a second start returns the existing review. */
export async function startAiReview(input: z.input<typeof aiStartSchema>): Promise<ReviewActionResult<{ runId: string; ai: AiReviewDto; reused: boolean }>> {
  const user = await requireAuth();
  const parsed = aiStartSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const year = parsed.data.taxYear;
  const access = await aiAccess(user.id, year);
  if (!access.ok) return access;
  try {
    const records = await readReviewRecords(access.ctx);
    const latest = records.latest;
    if (latest === null || latest.run.fingerprint !== access.ctx.fingerprint) return { ok: false, error: "Run the checks for the current return first; the AI review attaches to them." };
    if (records.ai?.started === true) return { ok: true, runId: latest.run.id, ai: toAiDto(records.ai), reused: true };
    const prep = await prepareAiReview(year, access.userName, latest.findings.filter((f) => f.layer === "L1"));
    if ("error" in prep) return { ok: false, error: prep.error };
    if (prep.fingerprint !== access.ctx.fingerprint) return { ok: false, error: "The return changed while the review was being prepared. Run the checks again." };
    if (prep.estimate.warn && parsed.data.acknowledgeHighCost !== true) {
      return { ok: false, error: `The estimated cost is above ${formatUsd(prep.estimate.warnThresholdUsd)}. Confirm that you accept it to start.` };
    }
    const store = dbAiRunStore();
    const started = await startAiRun(store, { runId: latest.run.id, payload: prep.serialized, model: prep.model, estimate: prep.estimate, pack: prep.pack, ret: prep.ret, facts: prep.facts });
    await writeReviewAudit(user.id, "tax_review_ai_started", { runId: latest.run.id, taxYear: year, fingerprint: access.ctx.fingerprint, model: prep.model, estimatedUsd: Math.round(prep.estimate.expectedUsd * 100) / 100, tasks: prep.estimate.tasks.length, started: started.started });
    revalidateYear(year);
    return { ok: true, runId: latest.run.id, ai: toAiDto(foldProgress(await store.listEvents(latest.run.id), Date.now())), reused: !started.started };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

async function findRun(year: 2025, entityId: string, runId: string): Promise<{ id: string; fingerprint: string } | null> {
  const runs = await listRuns(year, entityId, 25);
  const run = runs.find((r) => r.id === runId);
  return run === undefined ? null : { id: run.id, fingerprint: run.fingerprint };
}

/** Runs the next pending task of a started AI review (at most one model request) and returns the new progress. */
export async function runNextAiTask(input: z.input<typeof aiRunSchema>): Promise<ReviewActionResult<{ ai: AiReviewDto; step: string }>> {
  const user = await requireAuth();
  const parsed = aiRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const year = parsed.data.taxYear;
  const access = await aiAccess(user.id, year);
  if (!access.ok) return access;
  try {
    const run = await findRun(year, access.ctx.entityId, parsed.data.runId);
    if (run === null) return { ok: false, error: "That review run was not found." };
    let transport: LlmTransport;
    try {
      transport = createAnthropicTransport();
    } catch {
      return { ok: false, error: "The AI review is not configured on this server (no API key)." };
    }
    // the fingerprint is recomputed here from the live inputs (access.ctx), never taken from the client
    const step = await runNextTask(run.id, {
      store: dbAiRunStore(),
      transport,
      pack: loadSourcePack(),
      nowMs: () => Date.now(),
      currentFingerprint: access.ctx.fingerprint,
      runFingerprint: run.fingerprint,
      timeoutMs: 240_000,
    });
    if (step.status === "ran") {
      await writeReviewAudit(user.id, "tax_review_ai_task_done", { runId: run.id, taxYear: year, task: step.task, ok: step.ok, completed: step.progress.completedCount, inputTokens: step.progress.usage.inputTokens, outputTokens: step.progress.usage.outputTokens });
      revalidateYear(year);
    }
    return { ok: true, ai: toAiDto(step.progress), step: step.status === "ran" ? (step.ok ? "ran" : "task_failed") : step.status };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** Progress of an AI review (a re-read; the page also gets it with the Final review state). */
export async function getAiReviewStatus(input: z.input<typeof aiRunSchema>): Promise<ReviewActionResult<{ ai: AiReviewDto }>> {
  const user = await requireAuth();
  const parsed = aiRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const loaded = await loadReviewContext(parsed.data.taxYear, user.id);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  try {
    const run = await findRun(parsed.data.taxYear, loaded.ctx.entityId, parsed.data.runId);
    if (run === null) return { ok: false, error: "That review run was not found." };
    return { ok: true, ai: toAiDto(foldProgress(await dbAiRunStore().listEvents(run.id), Date.now())) };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}

/** Cancels an AI review: the gate then treats the AI review passes as not passed. Nothing already stored is removed. */
export async function cancelAiReview(input: z.input<typeof aiRunSchema>): Promise<ReviewActionResult<{ ai: AiReviewDto }>> {
  const user = await requireAuth();
  const parsed = aiRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const access = await aiAccess(user.id, parsed.data.taxYear);
  if (!access.ok) return access;
  try {
    const run = await findRun(parsed.data.taxYear, access.ctx.entityId, parsed.data.runId);
    if (run === null) return { ok: false, error: "That review run was not found." };
    const store = dbAiRunStore();
    await cancelAiRun(store, run.id);
    await writeReviewAudit(user.id, "tax_review_ai_cancelled", { runId: run.id, taxYear: parsed.data.taxYear });
    revalidateYear(parsed.data.taxYear);
    return { ok: true, ai: toAiDto(foldProgress(await store.listEvents(run.id), Date.now())) };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}
