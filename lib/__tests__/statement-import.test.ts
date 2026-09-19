import { describe, it, expect } from "vitest";
import {
  buildLedgerIndex,
  computeLedgerPresence,
  deriveStatementStage,
  describeStage,
  effectiveDocumentStatus,
  hasUsableExtraction,
  importableRowIndices,
  importKey,
  planImport,
  rowDateBounds,
  STALE_PROCESSING_MS,
  stageNeedsAttention,
  validateStatementRow,
  type LedgerEntry,
} from "@/lib/statement-import";

const row = (over: Record<string, unknown> = {}) => ({
  date: "2025-06-20",
  description: "USPS PO 1234",
  amountCents: -1250,
  lineType: "charge" as const,
  ...over,
});

const ledgerRow = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  postedAt: new Date("2025-06-20T12:00:00Z"),
  amount: "-12.50",
  payeeRaw: "USPS PO 1234",
  payeeNormalized: "usps po 1234",
  ...over,
});

describe("hasUsableExtraction", () => {
  it("is false for null/undefined/empty", () => {
    expect(hasUsableExtraction(null)).toBe(false);
    expect(hasUsableExtraction(undefined)).toBe(false);
    expect(hasUsableExtraction({ data: {} })).toBe(false);
  });

  it("is true when there are transaction rows", () => {
    expect(hasUsableExtraction({ data: {}, transactionRows: [row()] })).toBe(true);
  });

  it("is true when there are real extracted fields", () => {
    expect(hasUsableExtraction({ data: { periodEnd: "2025-07-18" } })).toBe(true);
  });

  it("is FALSE for the parse-failure stub { data: { raw } } (regression)", () => {
    // parseExtractionResponse persists this on unparseable/truncated output.
    // It used to count as usable, which locked the review page in a green
    // "Already extracted" state with no rows and no retry.
    expect(hasUsableExtraction({ docType: "other", data: { raw: "{\"docType\":\"cred" } })).toBe(false);
  });
});

describe("validateStatementRow", () => {
  it("accepts a well-formed row", () => {
    expect(validateStatementRow(row())).toBe(true);
  });

  it.each([
    ["bad date format", row({ date: "06/20/2025" })],
    ["impossible date", row({ date: "2025-02-31" })],
    ["non-integer cents", row({ amountCents: -12.5 })],
    ["string cents", row({ amountCents: "-1250" })],
    ["missing description", row({ description: "  " })],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(validateStatementRow(value)).toBe(false);
  });
});

describe("computeLedgerPresence", () => {
  it("marks rows already in the ledger", () => {
    const index = buildLedgerIndex([ledgerRow()]);
    expect(computeLedgerPresence([row(), row({ date: "2025-06-21" })], index)).toEqual([true, false]);
  });

  it("matches ledger rows whose payeeNormalized predates normalizePayee()", () => {
    // Older imports stored a raw slice in payeeNormalized; payeeRaw is the
    // authoritative description, so matching still works.
    const index = buildLedgerIndex([ledgerRow({ payeeNormalized: "USPS PO 1234!!" })]);
    expect(computeLedgerPresence([row()], index)).toEqual([true]);
  });

  it("is multiplicity-aware: one ledger row covers only one of two identical rows", () => {
    const index = buildLedgerIndex([ledgerRow()]);
    expect(computeLedgerPresence([row(), row()], index)).toEqual([true, false]);
  });

  it("reports invalid rows as absent", () => {
    expect(computeLedgerPresence([row({ amountCents: 1.5 })], buildLedgerIndex([]))).toEqual([false]);
  });
});

describe("planImport", () => {
  it("creates every selected row when the ledger is empty", () => {
    const plan = planImport([row(), row({ date: "2025-06-21" })], [0, 1], buildLedgerIndex([]));
    expect(plan).toEqual({ toCreate: [0, 1], duplicates: 0, invalid: 0 });
  });

  it("imports BOTH of two identical same-day charges (regression: second used to be dropped)", () => {
    const plan = planImport([row(), row()], [0, 1], buildLedgerIndex([]));
    expect(plan.toCreate).toEqual([0, 1]);
    expect(plan.duplicates).toBe(0);
  });

  it("skips only as many identical rows as the ledger already holds", () => {
    const plan = planImport([row(), row()], [0, 1], buildLedgerIndex([ledgerRow()]));
    expect(plan.toCreate).toEqual([1]);
    expect(plan.duplicates).toBe(1);
  });

  it("re-running an import against its own result creates nothing", () => {
    const rows = [row(), row(), row({ date: "2025-06-22", amountCents: -500 })];
    const first = planImport(rows, [0, 1, 2], buildLedgerIndex([]));
    const ledger = first.toCreate.map((i) => {
      const r = rows[i]!;
      return ledgerRow({
        postedAt: new Date(`${r.date}T12:00:00Z`),
        amount: (r.amountCents / 100).toFixed(2),
        payeeRaw: r.description,
      });
    });
    const second = planImport(rows, [0, 1, 2], buildLedgerIndex(ledger));
    expect(second).toEqual({ toCreate: [], duplicates: 3, invalid: 0 });
  });

  it("counts invalid selected rows instead of throwing", () => {
    const plan = planImport([row({ date: "nope" }), row()], [0, 1], buildLedgerIndex([]));
    expect(plan).toEqual({ toCreate: [1], duplicates: 0, invalid: 1 });
  });

  it("ignores duplicate and out-of-range selected indices", () => {
    const plan = planImport([row()], [0, 0, 5], buildLedgerIndex([]));
    expect(plan.toCreate).toEqual([0]);
    expect(plan.invalid).toBe(1); // index 5 -> undefined row
  });
});

describe("importableRowIndices", () => {
  it("excludes card payments and invalid rows", () => {
    const rows = [row(), row({ lineType: "payment" }), row({ amountCents: 1.5 }), row({ lineType: undefined })];
    expect(importableRowIndices(rows)).toEqual([0, 3]);
  });
});

describe("deriveStatementStage", () => {
  const base = { documentStatus: "complete", hasUsableData: true, importableRows: 12, rowsInLedger: 0, confirmed: false };

  it("no data: derives from the document status", () => {
    const none = { ...base, hasUsableData: false, importableRows: 0 };
    expect(deriveStatementStage({ ...none, documentStatus: null })).toBe("needs_extraction");
    expect(deriveStatementStage({ ...none, documentStatus: "processing" })).toBe("extracting");
    expect(deriveStatementStage({ ...none, documentStatus: "failed" })).toBe("extraction_failed");
    expect(deriveStatementStage({ ...none, documentStatus: "skipped" })).toBe("skipped");
  });

  it("ignores a stale 'failed' label when real data exists (the drifted-status case)", () => {
    expect(deriveStatementStage({ ...base, documentStatus: "failed" })).toBe("ready_to_import");
  });

  it("extracted but not in the ledger and unconfirmed -> ready_to_import", () => {
    expect(deriveStatementStage(base)).toBe("ready_to_import");
  });

  it("confirmed but rows missing from the ledger -> confirmed_not_imported (the 3 QuickBooks statements)", () => {
    expect(deriveStatementStage({ ...base, confirmed: true, rowsInLedger: 0 })).toBe("confirmed_not_imported");
    expect(deriveStatementStage({ ...base, confirmed: true, rowsInLedger: 11 })).toBe("confirmed_not_imported");
  });

  it("every importable row in the ledger -> imported", () => {
    expect(deriveStatementStage({ ...base, rowsInLedger: 12 })).toBe("imported");
    expect(deriveStatementStage({ ...base, confirmed: true, rowsInLedger: 12 })).toBe("imported");
  });

  it("nothing importable -> no_transactions", () => {
    expect(deriveStatementStage({ ...base, importableRows: 0 })).toBe("no_transactions");
  });
});

describe("stageNeedsAttention / describeStage", () => {
  it("flags only stages with work left", () => {
    expect(stageNeedsAttention("ready_to_import")).toBe(true);
    expect(stageNeedsAttention("confirmed_not_imported")).toBe(true);
    expect(stageNeedsAttention("extraction_failed")).toBe(true);
    expect(stageNeedsAttention("imported")).toBe(false);
    expect(stageNeedsAttention("skipped")).toBe(false);
    expect(stageNeedsAttention("no_transactions")).toBe(false);
  });

  it("reports how many rows are missing", () => {
    expect(describeStage("ready_to_import", 12, 0)).toEqual({ label: "12 to import", tone: "amber" });
    expect(describeStage("confirmed_not_imported", 3, 0)).toEqual({ label: "Confirmed — 3 not imported", tone: "red" });
    expect(describeStage("imported", 12, 12)).toEqual({ label: "Imported (12)", tone: "green" });
  });
});

describe("effectiveDocumentStatus", () => {
  const now = new Date("2026-09-19T12:00:00Z").getTime();

  it("passes through every status except a stale processing lock", () => {
    expect(effectiveDocumentStatus(null, new Date(now - 10 * 60_000), now)).toBeNull();
    expect(effectiveDocumentStatus("complete", new Date(now - 10 * 60_000), now)).toBe("complete");
  });

  it("keeps a fresh processing lock as processing", () => {
    expect(effectiveDocumentStatus("processing", new Date(now - 60_000), now)).toBe("processing");
  });

  it("reads a stale processing lock as failed so it can be retried", () => {
    expect(effectiveDocumentStatus("processing", new Date(now - STALE_PROCESSING_MS - 1), now)).toBe("failed");
  });
});

describe("rowDateBounds", () => {
  it("spans the valid rows plus a day of slack either side", () => {
    const b = rowDateBounds([row({ date: "2025-06-20" }), row({ date: "2025-07-10" }), row({ date: "bad" })]);
    expect(b?.from.toISOString()).toBe("2025-06-19T00:00:00.000Z");
    expect(b?.to.toISOString()).toBe("2025-07-11T23:59:59.000Z");
  });

  it("is null with no valid rows", () => {
    expect(rowDateBounds([])).toBeNull();
    expect(rowDateBounds([row({ date: "bad" })])).toBeNull();
  });
});

describe("importKey", () => {
  it("normalizes the description", () => {
    expect(importKey("2025-06-20", -1250, "USPS  PO #1234")).toBe(importKey("2025-06-20", -1250, "usps po 1234"));
  });
});
