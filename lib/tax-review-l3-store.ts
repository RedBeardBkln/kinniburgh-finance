import { db } from "@/lib/db";
import { DuplicateEventError, type AiRunStore, type NewRunEvent, type StoredFinding } from "@/lib/tax-review/llm/run";
import type { RunEvent } from "@/lib/tax-review/llm/progress";
import { dedupeFindings, findingSchema, SEVERITIES, severityRank, type Finding, type Severity } from "@/lib/tax-review/types";
import { rowToFinding, type FindingRow } from "@/lib/tax-review-store";

// ── DB access for the AI review passes (ai-return-reviewer, Phase B) ────────────────────────────────────────
// INSERT-ONLY, by design and by test: reads (findMany) and creates (create / createMany), never an update, delete, upsert or raw SQL.
// The run row (TaxReviewRun) is immutable; the progress of an AI review lives in TaxReviewRunEvent rows (derived state, see
// lib/tax-review/llm/progress.ts) and the L3 findings are ordinary TaxReviewFinding rows of the same run (layer "L3"), so the gate and
// the findings table read them with the code that already exists.
//
// No auth here: callers (actions/tax-review.ts) call requireAuth() first and check that the run belongs to the household return.
// No "use server". Free text is never written here except the validated findings and the redacted payload JSON.
//
// Like lib/tax-review-store.ts, this talks to the Prisma delegates through a narrow structural interface and casts `db` because the
// Prisma client in node_modules is not regenerated until the migrations are approved (20261009000000_tax_review_run_events).

interface EventDbRow {
  id: string;
  runId: string;
  eventKey: string;
  kind: string;
  taskId: string | null;
  attempt: number | null;
  data: unknown;
  createdAt: Date;
}

type NewEventRow = Omit<EventDbRow, "id" | "createdAt">;

type NewFindingRow = Omit<FindingRow, "id">;

export interface L3StoreTx {
  taxReviewRunEvent: { createMany(args: { data: NewEventRow[] }): Promise<{ count: number }> };
  taxReviewFinding: {
    findMany(args: { where: { runId: string; layer?: string }; orderBy?: { createdAt: "asc" } }): Promise<Array<{ key: string } & Partial<FindingRow>>>;
    createMany(args: { data: NewFindingRow[] }): Promise<{ count: number }>;
  };
}

export interface L3StoreDb extends L3StoreTx {
  taxReviewRunEvent: L3StoreTx["taxReviewRunEvent"] & {
    findMany(args: { where: { runId: string }; orderBy: { createdAt: "asc" } }): Promise<EventDbRow[]>;
  };
  $transaction<T>(fn: (tx: L3StoreTx) => Promise<T>): Promise<T>;
}

function defaultDb(): L3StoreDb {
  return db as unknown as L3StoreDb;
}

export class L3StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L3StoreError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "P2002";
}

function toFindingRow(runId: string, f: Finding): NewFindingRow {
  const parsed = findingSchema.safeParse(f);
  if (!parsed.success || f.layer !== "L3") throw new L3StoreError(`finding ${f.check} is not a valid L3 finding`);
  return {
    runId,
    key: f.key,
    layer: f.layer,
    check: f.check,
    severity: f.severity,
    area: f.area,
    formKey: f.formKey ?? null,
    lineKey: f.lineKey ?? null,
    message: f.message,
    evidence: f.evidence,
    citation: f.citation,
    recommendedAction: f.recommendedAction,
    acceptable: f.acceptable,
    origin: f.origin,
    pass: f.pass ?? null,
    downgradedFrom: f.downgradedFrom ?? null,
    challenge: f.challenge ?? null,
    rejectedReason: null,
    evidenceHash: f.evidenceHash,
  };
}

/** The AiRunStore backed by the database (append-only events + L3 findings of the run). */
export function dbAiRunStore(store: L3StoreDb = defaultDb()): AiRunStore {
  return {
    async listEvents(runId: string): Promise<RunEvent[]> {
      const rows = await store.taxReviewRunEvent.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
      return rows.map((r): RunEvent => ({ runId: r.runId, eventKey: r.eventKey, kind: r.kind as RunEvent["kind"], taskId: r.taskId, attempt: r.attempt, data: r.data, createdAt: r.createdAt }));
    },
    async listL3Findings(runId: string): Promise<Finding[]> {
      const rows = (await store.taxReviewFinding.findMany({ where: { runId, layer: "L3" }, orderBy: { createdAt: "asc" } })) as unknown as FindingRow[];
      // Two tasks of one pass can emit the same finding key (same pass, category, line and rule) with different severities: both rows are kept
      // (the table is insert-only), and every reader sees the MORE SEVERE one (dedupeFindings keeps the most serious, the first on a tie).
      return dedupeFindings(rows.map(rowToFinding));
    },
    async listL3FindingRows(runId: string): Promise<StoredFinding[]> {
      // read-only: every stored L3 row of the run as it is (not collapsed per key), with the time it was stored; reuse.ts attributes them to tasks
      const rows = (await store.taxReviewFinding.findMany({ where: { runId, layer: "L3" }, orderBy: { createdAt: "asc" } })) as unknown as Array<FindingRow & { createdAt: Date }>;
      return rows.map((r) => ({ finding: rowToFinding(r), at: r.createdAt.getTime() }));
    },
    async append(runId: string, events: readonly NewRunEvent[], findings: readonly Finding[]): Promise<void> {
      const eventRows: NewEventRow[] = events.map((e) => ({ runId, eventKey: e.eventKey, kind: e.kind, taskId: e.taskId, attempt: e.attempt, data: e.data }));
      try {
        await store.$transaction(async (tx) => {
          // the events first: a duplicate key aborts the whole transaction, so a task can never be recorded twice
          await tx.taxReviewRunEvent.createMany({ data: eventRows });
          if (findings.length > 0) {
            // a finding whose key the run already holds is stored again ONLY when it is strictly more serious than every stored one (insert-only: the
            // earlier row stays, readers keep the more severe); a repeat of the same or a lesser severity is skipped
            const stored = await tx.taxReviewFinding.findMany({ where: { runId } });
            const best = new Map<string, number>();
            for (const r of stored) {
              const rank = SEVERITIES.includes(r.severity as Severity) ? severityRank(r.severity as Severity) : SEVERITIES.length;
              best.set(r.key, Math.min(best.get(r.key) ?? SEVERITIES.length, rank));
            }
            const fresh = dedupeFindings(findings).filter((f) => {
              const have = best.get(f.key);
              return have === undefined || severityRank(f.severity) < have;
            });
            if (fresh.length > 0) await tx.taxReviewFinding.createMany({ data: fresh.map((f) => toFindingRow(runId, f)) });
          }
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateEventError();
        throw err;
      }
    },
  };
}
