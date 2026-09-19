// Pure helpers for statement transaction import: row validation, ledger
// coverage, duplicate planning, and the single derived "stage" that both the
// Bank Statements list and the review page display. No DB access, no
// "use server" — safe to import from server components, server actions, and
// client components alike.
//
// Why "stage" is derived rather than stored: a statement's state used to be
// spread across three independent fields (BankStatement.extractStatus for
// period/balances, Document.extractionStatus for transaction rows, and
// BankStatement.confirmedAt) and nothing recorded whether the rows had
// actually reached the ledger. The fields drifted, and the UI showed a green
// "Extracted" badge on statements whose transactions were not imported at
// all. Transactions are immutable facts, so "is it imported" is answered by
// looking at the ledger itself — it cannot drift.

import { normalizePayee } from "@/lib/tags";

export interface StatementRow {
  date: string; // YYYY-MM-DD
  description: string;
  amountCents: number;
  lineType?: "charge" | "payment";
}

export interface LedgerEntry {
  postedAt: Date;
  amount: { toString(): string } | number | string; // Prisma.Decimal | number
  payeeRaw: string | null;
  payeeNormalized: string | null;
}

// ── Extraction usability ──────────────────────────────────────────────────────

interface ExtractionLike {
  docType?: string;
  data?: Record<string, unknown> | null;
  transactionRows?: unknown[] | null;
}

/**
 * True when a stored extraction holds real, reviewable data. A JSON-parse
 * failure is persisted by parseExtractionResponse as
 * { docType: "other", data: { raw } } — that has a non-empty `data` object but
 * is NOT usable, so it must never count (it used to, which produced a green
 * "Already extracted" banner with no rows and no way to retry).
 */
export function hasUsableExtraction(extraction: ExtractionLike | null | undefined): boolean {
  if (!extraction) return false;
  if ((extraction.transactionRows?.length ?? 0) > 0) return true;
  const data = extraction.data ?? {};
  const keys = Object.keys(data).filter((k) => k !== "raw");
  return keys.length > 0 && !("raw" in data);
}

// ── Row validation ────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function validateStatementRow(row: unknown): row is StatementRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.date === "string" &&
    isRealCalendarDate(r.date) &&
    typeof r.description === "string" &&
    r.description.trim().length > 0 &&
    typeof r.amountCents === "number" &&
    Number.isInteger(r.amountCents)
  );
}

// ── Duplicate key / ledger index ──────────────────────────────────────────────

export function importKey(dateIso: string, amountCents: number, description: string): string {
  return `${dateIso}|${amountCents}|${normalizePayee(description).slice(0, 100)}`;
}

/**
 * Multiset of already-present ledger rows, keyed the same way import rows are.
 * The payee is derived from payeeRaw (falling back to payeeNormalized) and
 * re-normalized here, so ledger rows imported before normalizePayee() was
 * applied at import time still match.
 */
export function buildLedgerIndex(ledger: LedgerEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const t of ledger) {
    const cents = Math.round(Number(t.amount.toString()) * 100);
    const key = importKey(
      t.postedAt.toISOString().slice(0, 10),
      cents,
      t.payeeRaw ?? t.payeeNormalized ?? ""
    );
    index.set(key, (index.get(key) ?? 0) + 1);
  }
  return index;
}

/**
 * For each statement row, whether it is already in the ledger. Multiplicity-
 * aware: two identical rows on one statement need two ledger rows to both
 * count as present. Rows that fail validation report false.
 */
export function computeLedgerPresence(
  rows: unknown[],
  ledgerIndex: Map<string, number>
): boolean[] {
  const remaining = new Map(ledgerIndex);
  return rows.map((row) => {
    if (!validateStatementRow(row)) return false;
    const key = importKey(row.date, row.amountCents, row.description);
    const left = remaining.get(key) ?? 0;
    if (left <= 0) return false;
    remaining.set(key, left - 1);
    return true;
  });
}

export interface ImportPlan {
  /** Indices (into the original rows array) to create, in order. */
  toCreate: number[];
  /** Selected rows skipped because an identical ledger row already exists. */
  duplicates: number;
  /** Selected rows skipped because they failed validation. */
  invalid: number;
}

/**
 * Decide which selected rows to create. Only rows already in the ledger are
 * skipped, and only up to their count there: two genuinely separate identical
 * charges on one statement (same date, amount, description) both import,
 * where the old check-then-insert loop silently dropped the second one as a
 * "duplicate" of the row it had just created.
 */
export function planImport(
  rows: unknown[],
  selectedIndices: number[],
  ledgerIndex: Map<string, number>
): ImportPlan {
  const remaining = new Map(ledgerIndex);
  const toCreate: number[] = [];
  let duplicates = 0;
  let invalid = 0;

  const unique = Array.from(new Set(selectedIndices)).sort((a, b) => a - b);
  for (const i of unique) {
    const row = rows[i];
    if (!validateStatementRow(row)) {
      invalid++;
      continue;
    }
    const key = importKey(row.date, row.amountCents, row.description);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      duplicates++;
      continue;
    }
    toCreate.push(i);
  }
  return { toCreate, duplicates, invalid };
}

// ── Derived stage ─────────────────────────────────────────────────────────────

export type StatementStage =
  | "needs_extraction" // no usable transaction data yet
  | "extracting" // a fresh extraction is running
  | "extraction_failed"
  | "skipped" // owner chose to store without extraction
  | "ready_to_import" // rows extracted, some not yet in the ledger, not confirmed
  | "confirmed_not_imported" // confirmed, but rows are missing from the ledger
  | "imported" // every importable row is in the ledger
  | "no_transactions"; // extraction succeeded, nothing importable on it

export interface StageInput {
  documentStatus: string | null;
  /** hasUsableExtraction() of the document's extractionData. */
  hasUsableData: boolean;
  /** Rows that should reach the ledger (valid, not a card payment-to-issuer). */
  importableRows: number;
  /** Of those, how many are already in the ledger. */
  rowsInLedger: number;
  confirmed: boolean;
}

export function deriveStatementStage(input: StageInput): StatementStage {
  const { documentStatus, hasUsableData, importableRows, rowsInLedger, confirmed } = input;

  if (!hasUsableData) {
    if (documentStatus === "skipped") return "skipped";
    if (documentStatus === "processing") return "extracting";
    if (documentStatus === "failed") return "extraction_failed";
    return "needs_extraction";
  }
  if (importableRows === 0) return "no_transactions";
  if (rowsInLedger >= importableRows) return "imported";
  return confirmed ? "confirmed_not_imported" : "ready_to_import";
}

/** True for stages where the owner still has something to do. */
export function stageNeedsAttention(stage: StatementStage): boolean {
  return stage !== "imported" && stage !== "no_transactions" && stage !== "skipped";
}

export interface StageDisplay {
  label: string;
  tone: "green" | "amber" | "red" | "blue" | "muted";
}

export function describeStage(
  stage: StatementStage,
  importableRows: number,
  rowsInLedger: number
): StageDisplay {
  const missing = Math.max(0, importableRows - rowsInLedger);
  switch (stage) {
    case "imported":
      return { label: `Imported (${importableRows})`, tone: "green" };
    case "ready_to_import":
      return { label: `${missing} to import`, tone: "amber" };
    case "confirmed_not_imported":
      return { label: `Confirmed — ${missing} not imported`, tone: "red" };
    case "no_transactions":
      return { label: "No transactions", tone: "muted" };
    case "extracting":
      return { label: "Extracting…", tone: "blue" };
    case "extraction_failed":
      return { label: "Extraction failed", tone: "red" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
    case "needs_extraction":
      return { label: "Needs extraction", tone: "amber" };
  }
}

/** Rows that should reach the ledger: valid and not a card payment-to-issuer. */
export function importableRowIndices(rows: unknown[]): number[] {
  const out: number[] = [];
  rows.forEach((row, i) => {
    if (validateStatementRow(row) && row.lineType !== "payment") out.push(i);
  });
  return out;
}

/**
 * Date window (± 1 day, for timezone slack) covering every valid row, used to
 * bound the ledger query. Null when there is no valid row.
 */
export function rowDateBounds(rows: unknown[]): { from: Date; to: Date } | null {
  const dates = rows.filter(validateStatementRow).map((r) => r.date).sort();
  if (dates.length === 0) return null;
  const DAY = 86_400_000;
  return {
    from: new Date(new Date(`${dates[0]}T00:00:00Z`).getTime() - DAY),
    to: new Date(new Date(`${dates[dates.length - 1]}T23:59:59Z`).getTime() + DAY),
  };
}

/** A "processing" claim older than this is treated as a dead extraction. */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/**
 * The status to display/derive from: a "processing" lock older than
 * STALE_PROCESSING_MS means the serverless function was killed mid-extraction
 * and nothing will ever finish it, so it reads as "failed" (retryable) rather
 * than "in progress" forever.
 */
export function effectiveDocumentStatus(
  status: string | null,
  updatedAt: Date,
  now: number = Date.now()
): string | null {
  return status === "processing" && now - updatedAt.getTime() >= STALE_PROCESSING_MS
    ? "failed"
    : status;
}
