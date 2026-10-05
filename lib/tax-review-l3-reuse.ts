import type { ReviewPayload } from "@/lib/tax-review/llm/payload";
import type { RegisterEntry } from "@/lib/tax-review/llm/register";
import { NO_REUSE, pickReuseSource, planReuse, type ReusePlan } from "@/lib/tax-review/llm/reuse";
import type { AiRunStore } from "@/lib/tax-review/llm/run";
import type { SourcePack } from "@/lib/tax-review/llm/sources";
import { dbAiRunStore } from "@/lib/tax-review-l3-store";
import { listRunsForFingerprint } from "@/lib/tax-review-store";

// DB-aware lookup for the reuse of finished AI review tasks (ai-token-budget). READ-ONLY: it lists the earlier runs of the SAME return
// state and reads their events and L3 finding rows; the decision itself is lib/tax-review/llm/reuse.ts (pure). No auth here and no
// "use server": callers (actions/tax-review.ts) call requireAuth() first. Nothing is written here; the copying is done by startAiRun in
// the same atomic append that starts the new run.

/** How many earlier runs of the same return state are looked at for finished tasks to reuse (each holds a ~200 KB payload event). */
const REUSE_LOOKBACK_RUNS = 10;

export interface ReuseLookup {
  entityId: string;
  /** Return fingerprint v2 the new run is for (64 hex). */
  fingerprint: string;
  model: string;
  /** The redacted payload text exactly as the new run will store it. */
  payloadJson: string;
  register: readonly RegisterEntry[];
  pack: SourcePack;
}

/**
 * Which finished tasks of an earlier AI review of the SAME return state (same fingerprint, same model, same prompts, same input) can be
 * copied into the new run `targetRunId` instead of being paid for again. Source = the newest earlier run of this fingerprint whose AI
 * review failed or was cancelled. Any read failure means "reuse nothing": the tasks are then simply sent again, which is safe.
 */
export async function loadReusePlan(lookup: ReuseLookup, year: 2025, targetRunId: string, store: AiRunStore = dbAiRunStore(), nowMs: number = Date.now()): Promise<ReusePlan> {
  try {
    const runs = (await listRunsForFingerprint(year, lookup.entityId, lookup.fingerprint)).filter((r) => r.id !== targetRunId).slice(0, REUSE_LOOKBACK_RUNS);
    for (const r of runs) {
      const events = await store.listEvents(r.id);
      if (pickReuseSource([{ runId: r.id, events }], nowMs) === null) continue;
      const findingRows = await store.listL3FindingRows(r.id);
      return planReuse(
        { runId: r.id, fingerprint: r.fingerprint, events, findingRows },
        // the payload as the run will read it back (a JSON round trip) and the register the run will store
        { runId: targetRunId, fingerprint: lookup.fingerprint, model: lookup.model, payload: JSON.parse(lookup.payloadJson) as ReviewPayload, register: lookup.register, pack: lookup.pack }
      );
    }
    return NO_REUSE;
  } catch (err) {
    console.error("tax review: earlier AI reviews could not be read for reuse:", err instanceof Error ? err.name : "unknown error");
    return NO_REUSE;
  }
}
