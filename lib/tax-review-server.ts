import { db } from "@/lib/db";
import { loadReviewInputs } from "@/lib/tax-review-build";
import { getRunWithFindings, listApprovals, listDispositionDetails, listRuns } from "@/lib/tax-review-store";
import { dbAiRunStore } from "@/lib/tax-review-l3-store";
import { emptyProgress, foldProgress, type AiReviewProgress } from "@/lib/tax-review/llm/progress";
import { buildRegister, type RegisterEntry } from "@/lib/tax-review/llm/register";
import { resolveApprover, type ApproverResolution } from "@/lib/tax-review/approver";
import type { GateEngineState } from "@/lib/tax-review/gate";
import { engineGateState } from "@/lib/tax-review/l1/engine-state";
import { buildReviewState, pickRun, type ApprovalDetail, type DispositionDetail, type ReviewStateDto, type RunRowLike } from "@/lib/tax-review/state";
import type { Finding } from "@/lib/tax-review/types";

// ── DB-aware assembly for the Final review page and its server actions (ai-return-reviewer, A6) ─────────────
// READ-ONLY. No auth here and no "use server": every caller authenticates first (requireAuth() / auth()) and passes the session
// user id. Everything that decides something is recomputed HERE from the database and the engine: the return fingerprint v2, the
// engine state, who the owner is. Nothing is ever taken from a client (an action's input has no fingerprint, no gate state).

export interface ReviewContext {
  year: 2025;
  entityId: string;
  user: { id: string; name: string };
  /** Return fingerprint v2 recomputed now from the live inputs (64 hex). */
  fingerprint: string;
  engineVersion: string;
  engine: GateEngineState;
  approver: ApproverResolution;
  /** The judgments register built from the engine's own state (the AI-narrated wording replaces it once that task completed). */
  register?: RegisterEntry[];
}

export type ContextResult = { ok: true; ctx: ReviewContext } | { ok: false; error: string };

/** Message for a database that has not had the review migration applied (Prisma P2021: table does not exist). */
export const TABLES_MISSING_MESSAGE = "The review tables are not available yet: the database migration for the Final review has not been applied.";

/** Plain-language text for a failure while reading or writing the review tables. Only the error class is logged, never its text. */
export function describeStoreFailure(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
  console.error("tax review store failed:", err instanceof Error ? err.name : "unknown error", code);
  if (code === "P2021" || code === "P2022") return TABLES_MISSING_MESSAGE;
  if (err instanceof Error && err.name === "ReviewStoreError") return err.message;
  return "The review could not be read or saved. Nothing was changed; try again.";
}

export async function loadReviewContext(year: 2025, userId: string): Promise<ContextResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
  if (!user) return { ok: false, error: "Your user record was not found." };
  const inputs = await loadReviewInputs(year, user.name);
  if ("error" in inputs) return { ok: false, error: inputs.error };
  const users = await db.user.findMany({ select: { id: true, name: true } });
  return {
    ok: true,
    ctx: {
      year,
      entityId: inputs.entityId,
      user: { id: user.id, name: user.name },
      fingerprint: inputs.fingerprint.fingerprint,
      engineVersion: inputs.engineVersion,
      engine: engineGateState({ view: inputs.view, effective: inputs.built.effective }),
      approver: resolveApprover(users, inputs.ekcName, user.id),
      register: buildRegister({ ret: inputs.built.ret, facts: inputs.built.facts }),
    },
  };
}

export interface ReviewRecords {
  runs: RunRowLike[];
  /** The run the gate looks at: the newest run for the CURRENT return, else the newest run. */
  latest: { run: RunRowLike; findings: Finding[] } | null;
  dispositions: DispositionDetail[];
  approvals: ApprovalDetail[];
  /** The AI review of the latest run, folded from its events (null = no run). */
  ai?: AiReviewProgress | null;
}

/** The events of a run's AI review. A table that does not exist yet (migration not applied) or any read failure means "no AI review": the gate stays red. */
async function readAiProgress(runId: string): Promise<AiReviewProgress> {
  try {
    return foldProgress(await dbAiRunStore().listEvents(runId), Date.now());
  } catch (err) {
    console.error("tax review: AI review events could not be read:", err instanceof Error ? err.name : "unknown error");
    return emptyProgress();
  }
}

export async function readReviewRecords(ctx: Pick<ReviewContext, "year" | "entityId" | "fingerprint">): Promise<ReviewRecords> {
  const runs = await listRuns(ctx.year, ctx.entityId, 25);
  const picked = pickRun(runs, ctx.fingerprint);
  const stored = picked === null ? null : await getRunWithFindings(picked.id, ctx.entityId);
  const [dispositions, approvals, ai] = await Promise.all([listDispositionDetails(ctx.year, ctx.entityId), listApprovals(ctx.year, ctx.entityId), picked === null ? Promise.resolve(null) : readAiProgress(picked.id)]);
  return { runs, latest: stored === null ? null : { run: stored.run, findings: stored.findings }, dispositions, approvals, ai };
}

export function stateOf(ctx: ReviewContext, records: ReviewRecords): ReviewStateDto {
  return buildReviewState({
    currentFingerprint: ctx.fingerprint,
    engine: ctx.engine,
    latest: records.latest,
    runs: records.runs,
    dispositions: records.dispositions,
    approvals: records.approvals,
    approver: ctx.approver,
    ai: records.ai,
    register: ctx.register,
  });
}

export async function loadReviewState(year: 2025, userId: string): Promise<{ ok: true; state: ReviewStateDto } | { ok: false; error: string }> {
  const loaded = await loadReviewContext(year, userId);
  if (!loaded.ok) return loaded;
  try {
    const records = await readReviewRecords(loaded.ctx);
    return { ok: true, state: stateOf(loaded.ctx, records) };
  } catch (err) {
    return { ok: false, error: describeStoreFailure(err) };
  }
}
