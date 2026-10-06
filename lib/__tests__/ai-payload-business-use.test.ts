// The business-use percentage decision (X6) in the AI review payload (privacy): it is sent under its decision id ("X6"), never under its
// override key (`businessUse.<key>`), the value reads "70.5%", and no name or key text travels. Same leak check as ai-payload-fixes.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tax-review-build", () => ({ loadFormData: vi.fn(), loadReviewInputs: vi.fn() }));

import { recordedDecisionsOf, scrubAddressesFor, scrubEntitiesFor } from "@/lib/tax-review-l3";
import { buildOwnerStatements, neutralTarget } from "@/lib/tax-review/llm/owner-statements";
import { buildReviewPayload, serializePayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { BUSINESS_USE_ACCOUNTS, businessUseTargetKey } from "@/lib/tax2025/business-use";
import type { PropertyTaxBill } from "@/lib/tax2025/facts";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { fullFacts1b, gl } from "./tax2025-fixtures";
import { PEOPLE, richFixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FORM_1098 = "27 old barry rd quaker hill ct 06375";
const TAX_BILL = "27 OLD BARRY ROAD, WATERFORD, CT 06385";
const ARBOR_BILL = "56 ARBOR ROAD, WATERFORD CT";

function bill(id: string, address: string, kind: PropertyTaxBill["kind"]): PropertyTaxBill {
  return { docId: id, label: "Town", basis: "doc_verified", legacyFormat: false, refs: [], taxType: "real_estate", address, billedCents: 614_300, paidInYearCents: 614_300, kind, kindBasis: "derived" };
}

const REASON = "Bill split by the number of people working from home; usage log kept.";

function row(over: Partial<OverrideRow> = {}): OverrideRow {
  return {
    id: "row-1",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: "businessUse.internet_phone",
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText: "70.5",
    computedSnapshot: { status: "default_undecided", cents: null },
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: new Date("2026-10-06T16:00:00.000Z"),
    archivedAt: null,
    ...over,
  };
}

/** Names and key words that must never appear in the payload (the same list as the leak check of ai-payload-fixes.test.ts, plus the list key). */
function leakingNames(json: string): string[] {
  const raw = json.replace(/safe[_\s-]*harbor/gi, " ").toLowerCase();
  const split = json.replace(/safe[_\s-]*harbor/gi, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.:/-]+/g, " ").toLowerCase();
  const found: string[] = [];
  for (const n of ["barry", "arbor", "waterford", "quaker", "kinniburgh", "mezzo", "sudden valley", "suddenvalley", "ramirez", "wisiackas", "internet phone", "business use.", "businessuse"]) {
    if (raw.includes(n) || split.includes(n)) found.push(n);
  }
  for (const n of ["eric", "eva", "laura"]) if (new RegExp(`\\b${n}\\b`).test(split)) found.push(n);
  return found;
}

describe("neutralTarget for a business-use decision", () => {
  it("every list entry is sent as its decision id; unknown / odd keys become the neutral word", () => {
    for (const def of BUSINESS_USE_ACCOUNTS) expect(neutralTarget("decision", businessUseTargetKey(def)), def.key).toBe(def.decisionId);
    expect(neutralTarget("decision", "businessUse.internet_phone")).toBe("X6");
    for (const odd of ["businessUse.nope", "businessUse.constructor", "businessUse.", "businessUse.__proto__", "internet_phone"]) expect(neutralTarget("decision", odd), odd).toBe("decision");
    expect(neutralTarget("line", "businessUse.internet_phone")).toBe("line");
    expect(neutralTarget("rule_ack", "businessUse.internet_phone")).toBe("rule");
  });
  it("the labels of the list entries pass the redaction scrub and name no one", () => {
    for (const def of BUSINESS_USE_ACCOUNTS) {
      expect(findRedactionIssues(def.label), def.key).toEqual([]);
      expect(leakingNames(def.label), def.key).toEqual([]);
    }
  });
});

describe("recordedDecisionsOf and the owner statements for a business-use decision", () => {
  it("sends the value as a percentage text and the owner statements carry it under X6", () => {
    const recorded = recordedDecisionsOf([row(), row({ id: "row-2", targetKey: "homeOfficeMethod", valueText: "actual" })]);
    expect(recorded).toEqual([
      { kind: "decision", target: "businessUse.internet_phone", value: "70.5%", reason: REASON },
      { kind: "decision", target: "homeOfficeMethod", value: "actual", reason: REASON },
    ]);
    const stmts = buildOwnerStatements({ tdInterestAliases: [], otherPropertyBillAliases: [], documentAliases: new Set(), statedNone: [], recordedDecisions: recorded, acceptedFindings: [] });
    expect(stmts.recordedDecisions.map((d) => [d.target, d.value])).toEqual([
      ["X6", "70.5%"],
      ["X1", "actual"],
    ]);
    expect(JSON.stringify(stmts)).not.toMatch(/businessUse|internet_phone/);
  });
  it("an archived row is not sent; a hostile reason (identifier-shaped, or naming a retired entity) drops the record exactly as for any other decision", () => {
    expect(recordedDecisionsOf([row({ archivedAt: new Date() })])).toEqual([]);
    for (const reason of ["per statement SSN 123-45-6789", "the bill is shared with Mezzo", "the Property Management LLC pays half"]) {
      const stmts = buildOwnerStatements({ tdInterestAliases: [], otherPropertyBillAliases: [], documentAliases: new Set(), statedNone: [], recordedDecisions: recordedDecisionsOf([row({ reason })]), acceptedFindings: [] });
      expect(stmts.recordedDecisions, reason).toEqual([]);
    }
  });
});

describe("the whole payload", () => {
  async function payloadWithX6(): Promise<{ payload: ReviewPayload; json: string }> {
    const f = await richFixture();
    const facts = structuredClone(f.pipeline.ctx.facts);
    // the same real-shaped addresses as ai-payload-fixes.test.ts: the engine's other decision labels name them, and the scrubber removes them
    facts.deductions.primaryResidenceAddress = { value: FORM_1098, basis: "derived", refs: [] };
    facts.deductions.propertyTaxBills = [bill("d59a8102", TAX_BILL, "primary_residence"), bill("c68acecb", ARBOR_BILL, "other_real_estate")];
    // the engine's real X6 decision, from a return with the mixed-use account booked and 70.5% recorded
    const bu = fullFacts1b();
    bu.income.scheduleC.glLines = [...bu.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017)];
    const x6 = computeTy2025Return(bu, { businessUse: { internet_phone: { percentTenths: 705, by: "Eric", at: "2026-10-06T16:00:00.000Z" } } }).decisions.find((d) => d.id === "X6");
    expect(x6).toBeDefined();
    const ret = { ...f.pipeline.ret, decisions: [...f.pipeline.ret.decisions, ...(x6 ? [x6] : [])] };
    const bindings = bindFiles(f.pipeline.ctx, await readPacketFiles(f.pipeline.ctx.packet.files));
    const entities = scrubEntitiesFor(
      [
        { name: "Sudden Valley Property Management, LLC", slug: "sudden-valley", type: "business", foundedDate: new Date("2026-02-01T00:00:00.000Z"), taxStatusNotes: null, archivedAt: null },
        { name: "Eric Sample Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: null, archivedAt: null },
        { name: "Mezzo", slug: "mezzo", type: "business", foundedDate: null, taxStatusNotes: "Not yet formed/registered", archivedAt: null },
      ],
      2025
    );
    const payload = buildReviewPayload(
      {
        ret,
        view: f.pipeline.ctx.view,
        facts,
        documents: (f.pipeline.ctx.raw?.documents ?? []).map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, extractionStatus: d.extractionStatus, subjectType: d.subjectType, subjectUserId: d.subjectUserId })),
        bindings,
        l1Findings: f.l1Findings,
        entityLabels: entities.labels,
        ownerRecords: { recordedDecisions: recordedDecisionsOf([row()]), acceptedFindings: [] },
      },
      PEOPLE
    );
    const s = serializePayload(payload, PEOPLE, { entities: entities.entities, addresses: scrubAddressesFor(facts, FORM_1098) });
    return { payload: s.payload, json: s.json };
  }

  it("carries X6 under its id with the value and the reason, and no key text or name anywhere", async () => {
    const { payload, json } = await payloadWithX6();
    expect(payload.ownerStatements.recordedDecisions.map((d) => [d.target, d.value])).toEqual([["X6", "70.5%"]]);
    expect(json).toContain('"target":"X6"');
    expect(json).toContain('"value":"70.5%"');
    expect(json).toContain(REASON);
    expect(json).not.toMatch(/businessUse|internet_phone/);
    expect(leakingNames(json)).toEqual([]);
    const decision = payload.decisions.find((d) => d.id === "X6");
    expect(decision).toMatchObject({ id: "X6", chosen: "70.5%", status: "decided" });
    expect(decision?.label).toBe(BUSINESS_USE_ACCOUNTS[0].label);
  });
});
