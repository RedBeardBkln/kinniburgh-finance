import { db } from "@/lib/db";
import {
  REASON_MAX,
  REASON_MIN,
  type ApprovalRow,
  type DispositionRow,
} from "@/lib/tax-review/gate";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { dedupeFindings, evidenceHashOf, findingKey, findingSchema, type Finding } from "@/lib/tax-review/types";

// ── DB access for the AI Return Reviewer (plan section 5.8) ─────────────────────
// INSERT-ONLY, by design and by test: this file contains reads (findMany / findFirst) and creates (create /
// createMany), never an update, delete or upsert, so a stored run, finding, disposition or approval can not be
// edited or removed through the app (tax records are never hard-deleted; the history IS the audit trail). State such as
// "open / accepted / fixed", "stale" and the verdict is derived at read time (lib/tax-review/gate.ts). A source-reading
// test pins this (tax-review-store.test.ts).
//
// No auth here: callers (actions/*.ts, a later task step) call requireAuth() first. No "use server": nothing in this file
// is callable from a client. Free-text reasons are tax records: they are never written to AuditLog (the action writes an
// AuditLog row with ids, fingerprints and counts only).
//
// The Prisma client in node_modules is generated from the schema; until `pnpm db:generate` runs after the migration
// 20261008000000_tax_return_review is approved, the new delegates have no generated types. The store therefore talks to
// the narrow structural interface below (the exact calls it makes) and the default wiring casts `db` to it. After the
// migration is applied and the client regenerated, the cast can be replaced by the generated types; the interface
// matches the schema field for field.

// ── Row shapes (the schema's columns) ──────────────────────────────────────────

export interface RunRow {
  id: string;
  taxYear: number;
  entityId: string;
  fingerprint: string;
  engineVersion: string;
  startedById: string | null;
  startedByName: string;
  startedAt: Date;
  config: unknown;
  l1Summary: unknown;
  l2Summary: unknown;
}

export interface FindingRow {
  id: string;
  runId: string;
  key: string;
  layer: string;
  check: string;
  severity: string;
  area: string;
  formKey: string | null;
  lineKey: string | null;
  message: string;
  evidence: unknown;
  citation: unknown;
  recommendedAction: string;
  acceptable: boolean;
  origin: string;
  pass: string | null;
  downgradedFrom: string | null;
  challenge: string | null;
  rejectedReason: string | null;
  evidenceHash: string;
}

export interface DispositionDbRow {
  id: string;
  taxYear: number;
  entityId: string;
  findingKey: string;
  evidenceHash: string;
  action: string;
  reason: string;
  byId: string | null;
  byName: string;
  at: Date;
}

export interface ApprovalDbRow {
  id: string;
  taxYear: number;
  entityId: string;
  kind: string;
  runId: string;
  fingerprint: string;
  verdictSnapshot: unknown;
  attestationVersion: string | null;
  attestationTextHash: string | null;
  typedConfirmationHash: string | null;
  reason: string | null;
  approvedById: string | null;
  approvedByName: string;
  at: Date;
}

type NewFindingRow = Omit<FindingRow, "id">;
type NewRunRow = Omit<RunRow, "id" | "startedAt">;
type NewDispositionRow = Omit<DispositionDbRow, "id" | "at">;
type NewApprovalRow = Omit<ApprovalDbRow, "id" | "at">;

/** The calls this store makes, and no others (there is deliberately no update / delete / upsert here). */
export interface ReviewStoreTx {
  taxReviewRun: {
    create(args: { data: NewRunRow }): Promise<RunRow>;
  };
  taxReviewFinding: {
    createMany(args: { data: NewFindingRow[] }): Promise<{ count: number }>;
  };
}

export interface ReviewStoreDb extends ReviewStoreTx {
  taxReviewRun: ReviewStoreTx["taxReviewRun"] & {
    findMany(args: { where: { taxYear: number; entityId: string }; orderBy: { startedAt: "desc" }; take?: number }): Promise<RunRow[]>;
    findFirst(args: { where: { id: string; entityId?: string } }): Promise<RunRow | null>;
  };
  taxReviewFinding: ReviewStoreTx["taxReviewFinding"] & {
    findMany(args: { where: { runId: string }; orderBy: { createdAt: "asc" } }): Promise<FindingRow[]>;
  };
  taxReviewFindingDisposition: {
    create(args: { data: NewDispositionRow }): Promise<DispositionDbRow>;
    findMany(args: { where: { taxYear: number; entityId: string }; orderBy: { at: "asc" } }): Promise<DispositionDbRow[]>;
  };
  taxReturnApproval: {
    create(args: { data: NewApprovalRow }): Promise<ApprovalDbRow>;
    findMany(args: { where: { taxYear: number; entityId: string }; orderBy: { at: "asc" } }): Promise<ApprovalDbRow[]>;
  };
  $transaction<T>(fn: (tx: ReviewStoreTx) => Promise<T>): Promise<T>;
}

function defaultDb(): ReviewStoreDb {
  return db as unknown as ReviewStoreDb;
}

export class ReviewStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewStoreError";
  }
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Reasons and names are tax records: no SSN-like text, no EIN, no long digit run (never echo the text). */
function checkFreeText(label: string, text: string): void {
  if (findRedactionIssues(text).length > 0) throw new ReviewStoreError(`${label} looks like an SSN, an EIN or a long number; remove it`);
}

// ── Runs and findings ─────────────────────────────────────────────────────────

export interface InsertRunInput {
  taxYear: number;
  entityId: string;
  /** 64 hex: return fingerprint v2. */
  fingerprint: string;
  engineVersion: string;
  startedById: string | null;
  startedByName: string;
  config: unknown;
  l1Summary: unknown;
  l2Summary: unknown;
  findings: readonly Finding[];
}

function toFindingRow(runId: string, f: Finding): NewFindingRow {
  // Re-validate at the storage boundary: a finding that is not valid, or carries SSN-like text, never reaches the table.
  const parsed = findingSchema.safeParse(f);
  if (!parsed.success) throw new ReviewStoreError(`finding ${f.check} is not valid`);
  // Never trust the hashes the caller computed: recompute them from the content.
  if (f.evidenceHash !== evidenceHashOf(f.evidence)) throw new ReviewStoreError(`finding ${f.check} has an evidence hash that does not match its evidence`);
  const expectedKey = findingKey({ layer: f.layer, check: f.check, ...(f.formKey !== undefined ? { formKey: f.formKey } : {}), ...(f.lineKey !== undefined ? { lineKey: f.lineKey } : {}), ...(f.ruleTag !== undefined ? { ruleTag: f.ruleTag } : {}) });
  if (f.key !== expectedKey) throw new ReviewStoreError(`finding ${f.check} has a key that does not match its content`);
  // Whole-finding text guard (message, evidence, citation, ...): no SSN-like, EIN-like or long digit text reaches the table.
  // (the key and the hash are our own hex digests: a 16-hex digest can hold a 9-digit run by chance, so they are not part of the text scan)
  const { key: _key, evidenceHash: _hash, ...content } = f;
  void _key;
  void _hash;
  checkFreeText(`finding ${f.check}`, JSON.stringify(content));
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

/** One transaction: the run row and all of its findings. Returns the new run id. */
export async function insertReviewRun(input: InsertRunInput, store: ReviewStoreDb = defaultDb()): Promise<{ runId: string; findingCount: number }> {
  if (!FINGERPRINT_RE.test(input.fingerprint)) throw new ReviewStoreError("the return fingerprint must be 64 hex characters");
  const keys = new Set<string>();
  for (const f of input.findings) {
    if (keys.has(f.key)) throw new ReviewStoreError(`duplicate finding key in one run (${f.check})`);
    keys.add(f.key);
  }
  checkFreeText("started-by name", input.startedByName);
  checkFreeText("run config", JSON.stringify(input.config ?? null));
  checkFreeText("l1 summary", JSON.stringify(input.l1Summary ?? null));
  checkFreeText("l2 summary", JSON.stringify(input.l2Summary ?? null));
  return store.$transaction(async (tx) => {
    const run = await tx.taxReviewRun.create({
      data: {
        taxYear: input.taxYear,
        entityId: input.entityId,
        fingerprint: input.fingerprint,
        engineVersion: input.engineVersion,
        startedById: input.startedById,
        startedByName: input.startedByName,
        config: input.config,
        l1Summary: input.l1Summary,
        l2Summary: input.l2Summary,
      },
    });
    const rows = input.findings.map((f) => toFindingRow(run.id, f));
    if (rows.length > 0) await tx.taxReviewFinding.createMany({ data: rows });
    return { runId: run.id, findingCount: rows.length };
  });
}

export function rowToFinding(row: FindingRow): Finding {
  const parsed = findingSchema.safeParse({
    key: row.key,
    layer: row.layer,
    check: row.check,
    severity: row.severity,
    area: row.area,
    ...(row.formKey !== null ? { formKey: row.formKey } : {}),
    ...(row.lineKey !== null ? { lineKey: row.lineKey } : {}),
    message: row.message,
    evidence: row.evidence,
    citation: row.citation,
    recommendedAction: row.recommendedAction,
    acceptable: row.acceptable,
    origin: row.origin,
    ...(row.pass !== null ? { pass: row.pass } : {}),
    ...(row.downgradedFrom !== null ? { downgradedFrom: row.downgradedFrom } : {}),
    ...(row.challenge !== null ? { challenge: row.challenge } : {}),
    evidenceHash: row.evidenceHash,
  });
  if (!parsed.success) throw new ReviewStoreError("a stored finding no longer matches the finding schema");
  // The schema validated every field; lineKey is a plain string there, narrowed again by the checks that built it.
  return parsed.data as Finding;
}

export interface StoredRun {
  run: RunRow;
  findings: Finding[];
}

export async function getRunWithFindings(runId: string, entityId?: string, store: ReviewStoreDb = defaultDb()): Promise<StoredRun | null> {
  const run = await store.taxReviewRun.findFirst({ where: { id: runId, ...(entityId !== undefined ? { entityId } : {}) } });
  if (run === null) return null;
  const rows = await store.taxReviewFinding.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
  // an AI review can store two rows with one key (the later one more serious): the page, the gate and the register see the more severe one
  return { run, findings: dedupeFindings(rows.map(rowToFinding)) };
}

/** Newest first. */
export async function listRuns(taxYear: number, entityId: string, limit = 20, store: ReviewStoreDb = defaultDb()): Promise<RunRow[]> {
  return store.taxReviewRun.findMany({ where: { taxYear, entityId }, orderBy: { startedAt: "desc" }, take: limit });
}

export async function latestRun(taxYear: number, entityId: string, store: ReviewStoreDb = defaultDb()): Promise<RunRow | null> {
  const rows = await listRuns(taxYear, entityId, 1, store);
  return rows[0] ?? null;
}

// ── Dispositions ──────────────────────────────────────────────────────────────

export interface InsertDispositionInput {
  taxYear: number;
  entityId: string;
  findingKey: string;
  evidenceHash: string;
  action: "accepted" | "reopened";
  reason: string;
  byId: string | null;
  byName: string;
}

export async function insertDisposition(input: InsertDispositionInput, store: ReviewStoreDb = defaultDb()): Promise<{ id: string }> {
  if (!/^[0-9a-f]{16}$/.test(input.findingKey) || !/^[0-9a-f]{16}$/.test(input.evidenceHash)) throw new ReviewStoreError("not a finding key / evidence hash");
  const reason = input.reason.trim();
  if (input.action === "accepted" && reason.length < REASON_MIN) throw new ReviewStoreError(`a reason of at least ${REASON_MIN} characters is required to accept a finding`);
  if (reason.length > REASON_MAX) throw new ReviewStoreError(`the reason is limited to ${REASON_MAX} characters`);
  checkFreeText("reason", reason);
  checkFreeText("name", input.byName);
  const row = await store.taxReviewFindingDisposition.create({
    data: {
      taxYear: input.taxYear,
      entityId: input.entityId,
      findingKey: input.findingKey,
      evidenceHash: input.evidenceHash,
      action: input.action,
      reason,
      byId: input.byId,
      byName: input.byName,
    },
  });
  return { id: row.id };
}

/** Oldest first (the gate takes the latest per finding state). */
export async function listDispositions(taxYear: number, entityId: string, store: ReviewStoreDb = defaultDb()): Promise<DispositionRow[]> {
  const rows = await store.taxReviewFindingDisposition.findMany({ where: { taxYear, entityId }, orderBy: { at: "asc" } });
  return rows.map((r) => ({
    findingKey: r.findingKey,
    evidenceHash: r.evidenceHash,
    action: r.action === "accepted" ? "accepted" : "reopened",
    reason: r.reason,
    at: r.at,
  }));
}

/** Oldest first, with the name of the account that recorded each one (the page shows who accepted a finding and why). */
export async function listDispositionDetails(taxYear: number, entityId: string, store: ReviewStoreDb = defaultDb()): Promise<(DispositionRow & { byName: string })[]> {
  const rows = await store.taxReviewFindingDisposition.findMany({ where: { taxYear, entityId }, orderBy: { at: "asc" } });
  return rows.map((r) => ({
    findingKey: r.findingKey,
    evidenceHash: r.evidenceHash,
    action: r.action === "accepted" ? "accepted" : "reopened",
    reason: r.reason,
    at: r.at,
    byName: r.byName,
  }));
}

// ── Approvals ─────────────────────────────────────────────────────────────────

export interface InsertApprovalInput {
  taxYear: number;
  entityId: string;
  kind: "approved" | "withdrawn";
  runId: string;
  fingerprint: string;
  /** Counts-only gate snapshot (gateSnapshot()). */
  verdictSnapshot: unknown;
  attestationVersion: string | null;
  attestationTextHash: string | null;
  typedConfirmationHash: string | null;
  /** Required for "withdrawn". */
  reason: string | null;
  approvedById: string | null;
  approvedByName: string;
}

export async function insertApproval(input: InsertApprovalInput, store: ReviewStoreDb = defaultDb()): Promise<{ id: string }> {
  if (!FINGERPRINT_RE.test(input.fingerprint)) throw new ReviewStoreError("the return fingerprint must be 64 hex characters");
  if (input.kind === "approved") {
    // An approval is only valid for a gate that computed PASSED: refuse anything else here too (defence in depth; the action also calls evaluateApproval).
    const snap = input.verdictSnapshot as { verdict?: unknown } | null;
    if (snap === null || typeof snap !== "object" || snap.verdict !== "passed") throw new ReviewStoreError("an approval can only be recorded for a gate whose verdict is passed");
    if (input.attestationVersion === null || input.attestationTextHash === null || input.typedConfirmationHash === null) {
      throw new ReviewStoreError("an approval records the attestation version and the hashes of the text and of the typed confirmation");
    }
  } else {
    const r = (input.reason ?? "").trim();
    if (r.length < REASON_MIN || r.length > REASON_MAX) throw new ReviewStoreError(`a withdrawal needs a reason of ${REASON_MIN} to ${REASON_MAX} characters`);
    checkFreeText("reason", r);
  }
  checkFreeText("name", input.approvedByName);
  const row = await store.taxReturnApproval.create({
    data: {
      taxYear: input.taxYear,
      entityId: input.entityId,
      kind: input.kind,
      runId: input.runId,
      fingerprint: input.fingerprint,
      verdictSnapshot: input.verdictSnapshot,
      attestationVersion: input.attestationVersion,
      attestationTextHash: input.attestationTextHash,
      typedConfirmationHash: input.typedConfirmationHash,
      reason: input.reason === null ? null : input.reason.trim(),
      approvedById: input.approvedById,
      approvedByName: input.approvedByName,
    },
  });
  return { id: row.id };
}

/** Oldest first. */
export async function listApprovals(taxYear: number, entityId: string, store: ReviewStoreDb = defaultDb()): Promise<(ApprovalRow & { id: string; approvedByName: string })[]> {
  const rows = await store.taxReturnApproval.findMany({ where: { taxYear, entityId }, orderBy: { at: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "approved" ? "approved" : "withdrawn",
    fingerprint: r.fingerprint,
    at: r.at,
    runId: r.runId,
    approvedByName: r.approvedByName,
  }));
}
