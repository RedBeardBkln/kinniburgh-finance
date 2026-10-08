// Tester probe: a select-honouring fake db returns rows that carry EVERY forbidden column with a marker; the new Phase 2 tools are run through the
// real runTool framework. If any tool selects (or passes through) a column it should not, the marker shows up in the tool_result string.
import { describe, expect, it, vi } from "vitest";

const M = "LEAK-MARKER-4471";
const NOW = new Date("2026-10-08T12:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

type Row = Record<string, unknown>;
function pick(row: Row, select: Record<string, unknown> | undefined): Row {
  if (select === undefined) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v !== null && typeof v === "object" && "select" in (v as Row)) {
      const sub = row[k];
      const s = (v as { select: Record<string, unknown>; take?: number }).select;
      out[k] = Array.isArray(sub) ? sub.slice(0, (v as { take?: number }).take ?? 1000).map((r) => pick(r as Row, s)) : sub === null || sub === undefined ? sub : pick(sub as Row, s);
    }
  }
  return out;
}

const dec = (s: string) => ({ toString: () => s });
const fixtures: Record<string, Row[]> = {
  rentalBooking: [{ payoutDate: day("2026-11-01"), startDate: day("2026-10-20"), endDate: day("2026-10-25"), nights: 5, grossEarnings: dec("500.00"), currency: "USD", guest: M, guestName: M, confirmationCode: M, listing: M, entity: { name: "Sudden Valley", slug: M } }],
  insurancePolicy: [{ policyType: "term_life", insurer: "Acme Mutual", policyNumber: M, documentId: M, notes: M, faceAmountCents: 100_000_00, monthlyPremiumCents: 50_00, effectiveDate: day("2020-01-01"), expiryDate: null, entity: { name: "Personal" }, cashValueEntries: [{ asOf: day("2026-01-01"), cashValueCents: 1_000_00, note: M }] }],
  taxDeadline: [{ label: "Estimated tax Q4", dueDate: day("2027-01-15"), type: "estimated", status: "pending", notes: M, entity: { name: "Personal" } }],
  taxFact: [{ factKey: "decision.x1.home_office_method", changeKind: "changed", setByName: "Eric", setAt: day("2026-10-07"), valueText: M, valueCents: 123_45, reason: M, note: M }],
  taxReturnOverride: [{ targetKind: "line", targetKey: "f1040.l1", version: 2, authority: "owner", setByName: "Eric", setAt: day("2026-10-06"), reason: M, valueCents: 99_99, valueText: M }],
  taxReviewRun: [{ taxYear: 2025, startedByName: "Eric", startedAt: day("2026-10-05"), fingerprint: M, verdictSnapshot: M, message: M }],
  document: [{ id: "11111111-1111-4111-8111-111111111111", docType: "w2", taxYear: 2025, createdAt: day("2026-10-04"), documentName: "W-2 2025 Acme", extractionStatus: "complete", extractionConfirmedAt: null, subjectType: "person", issuerName: "Acme", fileKey: M, metadata: M, notes: M, extractionData: { summary: M }, extractionCorrections: { x: M }, extractionError: M, entity: { name: "Personal" }, insurancePolicy: null }],
  recurringExpense: [{ name: "Gym", amountCents: 40_00, frequency: "monthly", dueDay: 3, nextDueDate: day("2026-11-03"), notes: M, entity: { name: "Personal" }, tag: { shortName: "Fitness", id: M } }],
  scheduledBill: [{ payee: "Power Co", amountType: "fixed", expectedAmount: dec("120.00"), annualBudget: null, autopayDay: 5, frequency: "monthly", payDayOfWeek: null, payMonth: null, active: true, notes: M, accountNumber: M, entity: { name: "Personal" }, account: { nickname: "Checking", mask: M } }],
  scheduledTransfer: [{ amount: dec("250.00"), cadence: "semi_monthly", dayRules: { days: [15, 30], note: M }, purpose: "Bills", active: true, notes: M, fromAccount: { nickname: "Checking", mask: M }, toAccount: { nickname: "Savings", mask: M } }],
  incomeSource: [{ description: "Paycheck", cadence: "biweekly", dayRules: { anchor: "2026-10-09", extra: M }, amount: dec("2000.00"), active: true, notes: M, entity: { name: "Personal" }, account: { nickname: "Checking" } }],
};
const groups: Record<string, Row[]> = {
  "auditLog.groupBy": [{ changeType: "advisor_memory_add", _count: { _all: 2 }, before: M, after: M }],
  "document.groupBy": [{ docType: "w2", extractionStatus: "complete", _count: { _all: 1 } }],
  "transaction.groupBy": [{ entityId: "e1", _count: { _all: 3 } }],
};

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$queryRaw" || model === "$queryRawUnsafe") return async () => [];
        return new Proxy(
          {},
          {
            get(_m, method: string) {
              return async (args: { select?: Record<string, unknown>; take?: number } = {}) => {
                if (method === "groupBy") return groups[`${model}.groupBy`] ?? [];
                if (method === "count") return 0;
                if (model === "entity") return method === "findFirst" ? null : [{ id: "e1", name: "Personal" }];
                const rows = (fixtures[model] ?? []).slice(0, args.take ?? 1000).map((r) => pick(r, args.select));
                return method === "findFirst" || method === "findUnique" ? (rows[0] ?? null) : rows;
              };
            },
          },
        );
      },
    },
  ),
}));

import { ADVISOR_TOOL_MAP } from "@/lib/advisor/tools/all-tools";
import { newTurnBudget, runTool } from "@/lib/advisor/tools/run-tool";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { findRedactionIssues } from "@/lib/tax-review/redact";

const ctx = () => ({ userId: "u1", firstName: "Eric", now: NOW, memo: new Map() });
const CASES: [string, Record<string, unknown>][] = [
  ["get_rental_income", {}],
  ["list_insurance", {}],
  ["get_tax_calendar", {}],
  ["get_recent_changes", { days: 30 }],
  ["list_documents", {}],
  ["list_recurring_and_scheduled", {}],
];

describe("new tools never surface a column they did not select (select-honouring fake db, real framework)", () => {
  for (const [name, args] of CASES) {
    it(`${name}`, async () => {
      const r = await runTool(ADVISOR_TOOL_MAP, ctx(), newTurnBudget(), name, args);
      expect(r.ok, r.content.slice(0, 200)).toBe(true);
      expect(r.content).not.toContain(M);
      expect(findOwnerBannedWording(r.content)).toEqual([]);
      expect(r.content).not.toMatch(/needs_cpa|cpaNote|\bCPA\b/);
      expect(findRedactionIssues(r.content.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ""))).toEqual([]);
      // no OUTPUT KEY (not prose) is a forbidden column name
      expect(r.content).not.toMatch(/"(guest\w*|confirmationCode|policyNumber|fileKey|metadata|verdict\w*|fingerprint|valueText|valueCents|extractionData|extractionCorrections|extractionError|listing|documentId|accountNumber|mask)"\s*:/);
    });
  }

  it("rows actually came back (the fake is not vacuously empty)", async () => {
    const r = await runTool(ADVISOR_TOOL_MAP, ctx(), newTurnBudget(), "list_insurance", {});
    expect(r.content).toContain("Acme Mutual");
    const r2 = await runTool(ADVISOR_TOOL_MAP, ctx(), newTurnBudget(), "get_rental_income", {});
    expect(r2.content).toContain("500");
    const r3 = await runTool(ADVISOR_TOOL_MAP, ctx(), newTurnBudget(), "list_recurring_and_scheduled", {});
    expect(r3.content).toContain("Power Co");
    expect(r3.content).toContain("Paycheck");
  });
});
