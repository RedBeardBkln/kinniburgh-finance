import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { applyOverrides, lineSnapshot, type OverrideRow } from "@/lib/tax2025/overrides";
import { buildSheetModel, type SheetModel } from "@/lib/tax2025-sheet";
import { buildReviewState, type ApprovalDetail, type DispositionDetail, type RunRowLike } from "@/lib/tax-review/state";
import { makeFinding } from "@/lib/tax-review/types";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { FORBIDDEN_OUTPUT_KEY_PATTERN } from "@/lib/advisor/exclusions";
import { scrubDeep } from "@/lib/advisor/scrub";
import { runTool, newTurnBudget, toolMap } from "@/lib/advisor/tools/run-tool";
import { findSchemaProblems } from "@/lib/advisor/tools/registry";
import { TAX_TOOLS } from "@/lib/advisor/tools/tax-tools";
import { shapeTaxSummary, sheetOrNotice, UNSUPPORTED_YEAR_HINT } from "@/lib/advisor/tools/get-tax-return-summary";
import { shapeTaxLines } from "@/lib/advisor/tools/get-tax-return-lines";
import { shapeTaxOpenItems } from "@/lib/advisor/tools/get-tax-open-items";
import { shapeTaxDecisions } from "@/lib/advisor/tools/get-tax-decisions";
import { shapeTaxFacts, factsNotice } from "@/lib/advisor/tools/get-tax-facts";
import { shapeReviewStatus } from "@/lib/advisor/tools/get-tax-review-status";
import type { TaxFactRow } from "@/lib/tax-facts/types";
import type { ToolOutput } from "@/lib/advisor/tools/types";
import { emptyFacts, fullFacts, owner } from "./tax2025-fixtures";

const NOW = new Date("2026-10-08T16:00:00Z");

/** Every string leaf, skipping identifier-like tokens (ids, keys, urls). */
function proseStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!/^[a-z0-9_.:/-]+$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => proseStrings(v, out));
  else if (value !== null && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => proseStrings(v, out));
  return out;
}
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
}
function expectCleanTaxOutput(out: ToolOutput): void {
  const scrubbed = scrubDeep(out.data); // what the framework would do: must not throw
  const json = JSON.stringify(scrubbed);
  expect(json).not.toMatch(/needs_cpa/);
  expect(findOwnerBannedWording(proseStrings(out.data).join("\n"))).toEqual([]);
  expect(keysOf(out.data).filter((k) => FORBIDDEN_OUTPUT_KEY_PATTERN.test(k))).toEqual([]);
  expect(findRedactionIssues(json.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ""))).toEqual([]);
}

function pinRow(ret: ReturnType<typeof computeTy2025Return>, key: "sch1.3", valueCents: number): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error("no line");
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents,
    valueText: null,
    computedSnapshot: lineSnapshot(l, ret.engineVersion),
    authority: "owner",
    reason: "per the corrected 1099",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-05T14:00:00Z"),
    archivedAt: null,
  };
}

const golden = computeTy2025Return(fullFacts());
const blocked = computeTy2025Return(emptyFacts());
const homeOfficeFacts = fullFacts();
homeOfficeFacts.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive" as const);
homeOfficeFacts.income.scheduleC.homeOfficeSqft = owner(200);
const homeOffice = computeTy2025Return(homeOfficeFacts);
const models: { name: string; model: SheetModel }[] = [
  { name: "complete", model: buildSheetModel({ ret: golden, documents: [], now: NOW }) },
  { name: "blocked", model: buildSheetModel({ ret: blocked, documents: [], now: NOW }) },
  { name: "home office (decision X1 undecided)", model: buildSheetModel({ ret: homeOffice, documents: [], now: NOW }) },
  { name: "owner override", model: buildSheetModel({ ret: golden, documents: [], now: NOW, effective: applyOverrides(golden, [pinRow(golden, "sch1.3", 600_000)]) }) },
];
const OVERRIDE_MODEL = models[3]!.model;
const DECISION_MODEL = models[2]!.model;

describe("tax tools on the real TY2025 engine output", () => {
  for (const { name, model } of models) {
    describe(name, () => {
      it("summary: draft label, status words and counts; nothing the wording rules ban; fits its cap", () => {
        const out = shapeTaxSummary(model);
        expectCleanTaxOutput(out);
        const d = out.data as { draft_label: string; engine_version: string; counts: Record<string, number>; federal: unknown[]; connecticut: unknown[]; notes: string[] };
        expect(d.draft_label).toContain("DRAFT");
        expect(d.engine_version).toBe("ty2025-1b.11");
        expect(d.counts.blocking_items).toBe(model.summary.blockingItemCount);
        expect(d.federal.length).toBeGreaterThan(0);
        expect(JSON.stringify(out.data).length).toBeLessThan(8_000);
      });

      it("lines: never shows a line without an amount as zero, carries provenance and citations, no internal ids", () => {
        const out = shapeTaxLines(model, { limit: 60 });
        expectCleanTaxOutput(out);
        const rows = (out.data as { rows: { key: string; status: string; amount: string; sources: unknown[]; citations: unknown[] }[] }).rows;
        expect(rows.length).toBeGreaterThan(10);
        for (const r of rows) {
          if (r.status !== "computed" && r.status !== "overridden" && r.status !== "informational") expect(r.amount, r.key).toMatch(/not computed|not applicable|\$0|-/i);
          expect(r.status).not.toMatch(/cpa/);
        }
        const anyWithSources = rows.some((r) => r.sources.length > 0);
        expect(anyWithSources || name === "blocked").toBe(true);
        expect(out.total).toBeGreaterThanOrEqual(rows.length);
      });

      it("open items and decisions", () => {
        const items = shapeTaxOpenItems(model, { severity: "blocking", limit: 30 });
        expectCleanTaxOutput(items);
        expect((items.data as { rows: { severity: string }[] }).rows.every((r) => r.severity === "blocking")).toBe(true);
        const decisions = shapeTaxDecisions(model, {});
        expectCleanTaxOutput(decisions);
        const rows = (decisions.data as { rows: { undecided: boolean; recorded_decision: unknown; alternatives: unknown[] }[] }).rows;
        expect(rows.length).toBe(model.decisions.length);
        for (const r of rows) if (r.undecided) expect(r.recorded_decision).toBeNull();
      });
    });
  }

  it("the blocked return reports blocking items; the complete one has fewer", () => {
    const b = shapeTaxOpenItems(models[1]!.model, { severity: "blocking" }).total ?? 0;
    const c = shapeTaxOpenItems(models[0]!.model, { severity: "blocking" }).total ?? 0;
    expect(b).toBeGreaterThan(c);
  });

  it("the override scenario says the totals were not recomputed and marks the overridden line", () => {
    const model = OVERRIDE_MODEL;
    const s = JSON.stringify(shapeTaxSummary(model).data);
    expect(s).toContain("totals_not_recomputed\":true");
    const lines = shapeTaxLines(model, { key: "sch1.3" });
    const row = (lines.data as { rows: { key: string; override_note: string | null }[] }).rows.find((r) => r.key === "sch1.3");
    expect(row?.override_note).toBeTruthy();
    // the note ends with the owner's own recorded reason (decision D12)
    expect(row?.override_note).toContain("per the corrected 1099");
  });

  it("line filters: form text, status and key prefix; the limit is honoured", () => {
    const model = models[0]!.model;
    const schC = shapeTaxLines(model, { form: "Schedule C", limit: 60 });
    expect((schC.data as { rows: { form: string }[] }).rows.every((r) => /schedule c/i.test(r.form))).toBe(true);
    const none = shapeTaxLines(models[1]!.model, { status: "needs_owner_decision", limit: 60 });
    expect((none.data as { rows: { status: string }[] }).rows.every((r) => r.status === "needs_owner_decision")).toBe(true);
    const prefix = shapeTaxLines(model, { key: "sch1", limit: 5 });
    const d = prefix.data as { rows: { key: string }[]; matching_lines: number; more?: string };
    expect(d.rows.length).toBeLessThanOrEqual(5);
    expect(d.rows.every((r) => r.key.startsWith("sch1"))).toBe(true);
    if (d.matching_lines > 5) expect(d.more).toMatch(/more lines match/);
  });

  it("the default call fits the tool cap without the framework having to trim it", () => {
    const out = shapeTaxLines(models[1]!.model, {});
    expect(JSON.stringify(out.data).length).toBeLessThan(12_000);
  });

  it("a decided decision shows who, when and the owner's recorded reason (scrubbed); the recorder appears by first name only", () => {
    const model = JSON.parse(JSON.stringify(DECISION_MODEL)) as SheetModel;
    expect(model.decisions.length).toBeGreaterThan(0);
    const d = model.decisions[0]!;
    d.undecided = false;
    d.statusText = "decided";
    d.decidedBy = "Eric Kinniburgh";
    d.override = {
      id: "x",
      version: 2,
      authority: "owner",
      authorityLabel: "Owner (Eric)",
      note: "Chose the simplified method",
      by: "Eric Kinniburgh",
      at: "2026-10-05T14:00:00.000Z",
      atDate: "2026-10-05",
      reason: "Simpler. My SSN 123-45-6789 should never appear.",
      choice: "simplified",
    };
    const out = shapeTaxDecisions(model, { id: d.id });
    const json = JSON.stringify(out.data);
    expect(json).not.toContain("123-45-6789");
    expect(json).not.toContain("Kinniburgh");
    expect(json).toContain("Simpler.");
    expect(json).toContain("\"decided_by\":\"Eric\"");
    expect((out.data as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

describe("unsupported year and an unavailable sheet", () => {
  it("are neutral results, never an error text", () => {
    const hint = sheetOrNotice(2024, { kind: "unsupported_year", year: 2024 });
    expect("out" in hint && (hint.out.data as { hint: string }).hint).toBe(UNSUPPORTED_YEAR_HINT);
    const err = sheetOrNotice(2025, { kind: "error", message: "row 123-45-6789 exploded" });
    expect("out" in err && JSON.stringify(err.out.data)).not.toContain("123-45-6789");
    expect("out" in err && (err.out.data as { available: boolean }).available).toBe(false);
  });
});

describe("get_tax_facts shaper", () => {
  const fact = (over: Partial<TaxFactRow>): TaxFactRow => ({
    id: "f1",
    factKey: "household.filing_status",
    version: 1,
    category: "household",
    label: "Filing status",
    taxYear: 2025,
    valueKind: "choice",
    valueCents: null,
    valueText: "married_filing_jointly",
    carryPolicy: "stable",
    changeKind: "established",
    sourceKind: "owner_statement",
    sourceRef: "Owner statement 2026-10-07",
    reason: null,
    confirmedAt: new Date("2026-10-07T12:00:00Z"),
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-07T12:00:00Z"),
    archivedAt: null,
    ...over,
  });
  const rows: TaxFactRow[] = [
    fact({}),
    fact({ id: "f2", factKey: "income.w2_total", category: "income", label: "W-2 wages", valueKind: "money_cents", valueCents: 12_345_600, valueText: null, taxYear: 2025, carryPolicy: "year_specific" }),
    fact({ id: "f3", factKey: "household.dependents", category: "household", label: "Dependents", taxYear: 2024, carryPolicy: "reconfirm", valueText: "none" }),
    fact({ id: "f4", factKey: "open.gift_tax", category: "open_item", label: "Gift tax question", valueKind: "open_item", valueText: "Ask about 2024 gift", taxYear: 2025, carryPolicy: "year_specific" }),
    fact({ id: "f5", factKey: "household.filing_status", version: 2, taxYear: 2026, changeKind: "changed", valueText: "head_of_household", reason: "Moved. SSN 123-45-6789 no.", archivedAt: null }),
  ];

  it("resolves through the carry-forward rules for the asked year and says where each fact came from", () => {
    const out = shapeTaxFacts(rows, { tax_year: 2025 });
    expectCleanTaxOutput(out);
    const g = (out.data as { groups: Record<string, { key: string; value: string; provenance: string; from_tax_year: number; version: number }[]> }).groups;
    expect(g.already_confirmed_for_year!.map((x) => x.key).sort()).toEqual(["household.filing_status", "income.w2_total"]);
    expect(g.already_confirmed_for_year!.find((x) => x.key === "income.w2_total")!.value).toBe("$123,456");
    expect(g.already_confirmed_for_year![0]!.provenance).toMatch(/confirmed 2026-10-07 for TY2025/);
    expect(g.needs_reconfirmation!.map((x) => x.key)).toEqual(["household.dependents"]);
    expect(g.open_items!.map((x) => x.key)).toEqual(["open.gift_tax"]);
    // the TY2026 version is not applied to a TY2025 question
    expect(JSON.stringify(out.data)).not.toContain("head of household");
  });

  it("filters by category, key prefix and open items; includes history with scrubbed reasons only when asked", () => {
    expect(Object.keys((shapeTaxFacts(rows, { open_items_only: true }).data as { groups: object }).groups)).toEqual(["open_items"]);
    const cat = shapeTaxFacts(rows, { category: "income" }).data as { groups: Record<string, unknown[]> };
    expect(cat.groups.already_confirmed_for_year).toHaveLength(1);
    const pre = shapeTaxFacts(rows, { key_prefix: "household.filing" }).data as { groups: Record<string, unknown[]> };
    expect(pre.groups.already_confirmed_for_year).toHaveLength(1);
    expect(JSON.stringify(shapeTaxFacts(rows, {}).data)).not.toContain("\"history\"");
    const h = shapeTaxFacts(rows, { tax_year: 2026, include_history: true, key_prefix: "household.filing" });
    const json = JSON.stringify(h.data);
    expect(json).toContain("\"history\"");
    expect(json).not.toContain("123-45-6789");
    expect(json).toContain("recorded_by\":\"Eric\"");
  });

  it("states a missing table or any failure plainly instead of returning an empty list", () => {
    const missing = factsNotice({ state: "table_missing" });
    expect(JSON.stringify(missing?.data)).toMatch(/not available yet/);
    expect(factsNotice({ state: "error" })?.data).toMatchObject({ available: false });
    expect(factsNotice({ state: "no_entity" })?.data).toMatchObject({ available: false });
    expect(factsNotice({ state: "ok", entityId: "e", rows: [], skipped: 0 })).toBeNull();
  });

  it("empty store: empty groups, no invented value", () => {
    const d = shapeTaxFacts([], {}).data as { groups: Record<string, unknown[]> };
    expect(Object.values(d.groups).every((g) => g.length === 0)).toBe(true);
  });
});

describe("get_tax_review_status shaper", () => {
  const FP = "a".repeat(64);
  const run: RunRowLike = { id: "r1", fingerprint: FP, engineVersion: "ty2025-1b.11", startedAt: "2026-10-05T10:00:00.000Z", startedByName: "Eric Kinniburgh", l1Summary: { status: "completed", counts: { blocker: 1, high: 0, medium: 1, low: 0, info: 0 } }, l2Summary: { status: "not_run", coverage: [] } };
  const engine = { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 };
  const approver = { allowed: true, ownerName: "Eric Kinniburgh", reason: null };
  const blocker = makeFinding({ layer: "L1", check: "L1.F1.f1040.9", severity: "blocker", area: "tax", message: "Footing differs on line 9.", evidence: [{ ref: "f1040.9", amount: 5, status: "computed" }], recommendedAction: "Check line 9.", acceptable: false });
  const medium = makeFinding({ layer: "L1", check: "L1.E2.expense-ratio", severity: "medium", area: "tax", message: "Ratio looks high.", evidence: [{ ref: "schc.28", amount: 5, status: "computed" }], recommendedAction: "Look.", acceptable: true });
  const disp: DispositionDetail = { findingKey: medium.key, evidenceHash: medium.evidenceHash, action: "accepted", reason: "Startup year, the SECRET-REASON ratio is right.", at: "2026-10-05T11:00:00.000Z", byName: "Eric Kinniburgh" };

  it("reports the gate, the open gating findings and no acceptance reasons, evidence or full fingerprint", () => {
    const state = buildReviewState({ currentFingerprint: FP, engine, latest: { run, findings: [blocker, medium] }, runs: [run], dispositions: [disp], approvals: [] as ApprovalDetail[], approver });
    const out = shapeReviewStatus(state);
    expectCleanTaxOutput(out);
    const json = JSON.stringify(out.data);
    expect(json).not.toContain("SECRET-REASON");
    expect(json).not.toContain(FP);
    expect(json).not.toContain("Kinniburgh");
    expect(json).not.toContain("evidence");
    const d = out.data as { verdict: string; rows: { check: string }[]; findings: { open_gating: number; accepted_by_owner: number }; owner_can_approve_now: boolean; latest_run: { started_by: string } };
    expect(d.verdict).toMatch(/FLAGGED/);
    expect(d.rows.map((r) => r.check)).toEqual(["L1.F1.f1040.9"]);
    expect(d.findings).toMatchObject({ open_gating: 1, accepted_by_owner: 1 });
    expect(d.owner_can_approve_now).toBe(false);
    expect(d.latest_run.started_by).toBe("Eric");
  });

  it("no run yet: nothing invented", () => {
    const state = buildReviewState({ currentFingerprint: FP, engine, latest: null, runs: [], dispositions: [], approvals: [], approver });
    const out = shapeReviewStatus(state);
    expect((out.data as { latest_run: unknown }).latest_run).toBeNull();
    expect((out.data as { approval: { in_force: boolean } }).approval.in_force).toBe(false);
  });

  it("the approval is reported by first name with a 12 character fingerprint", () => {
    const approved: ApprovalDetail = { id: "a1", kind: "approved", fingerprint: FP, at: "2026-10-06T10:00:00.000Z", runId: "r1", approvedByName: "Eric Kinniburgh" };
    const state = buildReviewState({ currentFingerprint: FP, engine, latest: { run, findings: [] }, runs: [run], dispositions: [], approvals: [approved], approver });
    const a = (shapeReviewStatus(state).data as { approval: { approved_by: string; fingerprint_12: string; in_force: boolean } }).approval;
    expect(a).toMatchObject({ approved_by: "Eric", fingerprint_12: FP.slice(0, 12), in_force: true });
  });
});

describe("the tax tool set", () => {
  it("has six tools, all strict-compatible, all read-only descriptions that name the draft", () => {
    expect(TAX_TOOLS.map((t) => t.name).sort()).toEqual(["get_tax_decisions", "get_tax_facts", "get_tax_open_items", "get_tax_return_lines", "get_tax_return_summary", "get_tax_review_status"]);
    for (const t of TAX_TOOLS) {
      expect(findSchemaProblems(t.inputJsonSchema), t.name).toEqual([]);
      expect(findOwnerBannedWording(t.description), t.name).toEqual([]);
    }
  });

  it("year is required for the two year-scoped tools and other years are refused by validation or answered neutrally", async () => {
    const summary = TAX_TOOLS.find((t) => t.name === "get_tax_return_summary")!;
    expect(summary.prepare({}).ok).toBe(false);
    expect(summary.prepare({ year: 2025 }).ok).toBe(true);
    const r = await runTool(toolMap(TAX_TOOLS), { userId: "u", firstName: "Eric", now: NOW, memo: new Map() }, newTurnBudget(), "get_tax_return_summary", { year: 2024 });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).data).toEqual({ supported: false, hint: UNSUPPORTED_YEAR_HINT });
  });

  it("no tax tool exposes a write path: every description says read-only data and none takes a fingerprint, reason or value to record", () => {
    for (const t of TAX_TOOLS) {
      const props = Object.keys(t.inputJsonSchema.properties);
      for (const p of props) expect(/fingerprint|reason|value|approve|confirm|override|decision_choice/i.test(p), `${t.name}.${p}`).toBe(false);
    }
  });
});
