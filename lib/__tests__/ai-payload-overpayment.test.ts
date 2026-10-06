// The overpayment decisions (X7 / X8) in the AI review payload (privacy): each is sent under its decision id ("X7" / "X8"), never under its
// override key (`federalOverpayment` / `ctOverpayment`), the value is the choice text, and no name or key text travels.
// Same leak check as ai-payload-fixes.test.ts / ai-payload-business-use.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tax-review-build", () => ({ loadFormData: vi.fn(), loadReviewInputs: vi.fn() }));

import { recordedDecisionsOf, scrubAddressesFor, scrubEntitiesFor } from "@/lib/tax-review-l3";
import { buildOwnerStatements, neutralTarget } from "@/lib/tax-review/llm/owner-statements";
import { buildReviewPayload, serializePayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { OVERPAYMENT_LABELS } from "@/lib/tax2025/overpayment";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { fullFacts1b } from "./tax2025-fixtures";
import { PEOPLE, richFixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FORM_1098 = "27 old barry rd quaker hill ct 06375";
const REASON = "Refund everything: the 2026 estimates are paid from the business account.";
const WHO = { by: "Eric", at: "2026-10-06T16:00:00.000Z" };

function row(over: Partial<OverrideRow> = {}): OverrideRow {
  return {
    id: "row-1",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: "federalOverpayment",
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText: "refund_all",
    computedSnapshot: { status: "default_undecided", cents: null },
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: new Date("2026-10-06T16:00:00.000Z"),
    archivedAt: null,
    ...over,
  };
}

/** Names and key words that must never appear in the payload (the list of ai-payload-fixes.test.ts, plus the registry key words). */
function leakingNames(json: string): string[] {
  const raw = json.replace(/safe[_\s-]*harbor/gi, " ").toLowerCase();
  const split = json.replace(/safe[_\s-]*harbor/gi, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.:/-]+/g, " ").toLowerCase();
  const found: string[] = [];
  for (const n of ["barry", "arbor", "waterford", "quaker", "kinniburgh", "mezzo", "sudden valley", "suddenvalley", "ramirez", "wisiackas", "federaloverpayment", "ctoverpayment", "federal overpayment", "ct overpayment"]) {
    if (raw.includes(n) || split.includes(n)) found.push(n);
  }
  for (const n of ["eric", "eva", "laura"]) if (new RegExp(`\\b${n}\\b`).test(split)) found.push(n);
  return found;
}

describe("neutralTarget for the overpayment decisions", () => {
  it("the registry keys are sent as X7 / X8; odd keys become the neutral word", () => {
    expect(neutralTarget("decision", "federalOverpayment")).toBe("X7");
    expect(neutralTarget("decision", "ctOverpayment")).toBe("X8");
    expect(neutralTarget("decision", "federalOverpayment ")).toBe("decision");
    expect(neutralTarget("line", "federalOverpayment")).toBe("line");
  });
  it("the labels pass the redaction scrub and name no one", () => {
    for (const label of Object.values(OVERPAYMENT_LABELS)) {
      expect(findRedactionIssues(label), label).toEqual([]);
      expect(leakingNames(label), label).toEqual([]);
    }
  });
});

describe("recordedDecisionsOf and the owner statements", () => {
  it("send the choice text under X7 / X8; the key text never reaches the statements", () => {
    const recorded = recordedDecisionsOf([row(), row({ id: "row-2", targetKey: "ctOverpayment", valueText: "apply_amount:400" })]);
    expect(recorded).toEqual([
      { kind: "decision", target: "federalOverpayment", value: "refund_all", reason: REASON },
      { kind: "decision", target: "ctOverpayment", value: "apply_amount:400", reason: REASON },
    ]);
    const stmts = buildOwnerStatements({ tdInterestAliases: [], otherPropertyBillAliases: [], documentAliases: new Set(), statedNone: [], recordedDecisions: recorded, acceptedFindings: [] });
    expect(stmts.recordedDecisions.map((d) => [d.target, d.value])).toEqual([
      ["X7", "refund_all"],
      ["X8", "apply_amount:400"],
    ]);
    expect(JSON.stringify(stmts)).not.toMatch(/federalOverpayment|ctOverpayment/);
  });
  it("an archived row is not sent; a hostile reason (identifier-shaped, or naming a retired entity) drops the record as for any other decision", () => {
    expect(recordedDecisionsOf([row({ archivedAt: new Date() })])).toEqual([]);
    for (const reason of ["per statement SSN 123-45-6789", "refund because Mezzo pays the estimates"]) {
      const stmts = buildOwnerStatements({ tdInterestAliases: [], otherPropertyBillAliases: [], documentAliases: new Set(), statedNone: [], recordedDecisions: recordedDecisionsOf([row({ reason })]), acceptedFindings: [] });
      expect(stmts.recordedDecisions, reason).toEqual([]);
    }
  });
});

describe("the whole payload", () => {
  async function payloadWithOverpayment(): Promise<{ payload: ReviewPayload; json: string }> {
    const f = await richFixture();
    const facts = structuredClone(f.pipeline.ctx.facts);
    facts.deductions.primaryResidenceAddress = { value: FORM_1098, basis: "derived", refs: [] };
    // the engine's real X7 / X8 decisions, from a return with an overpayment and both choices recorded
    const over = fullFacts1b();
    over.income.w2s[0]!.fedWithheldCents = (over.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
    over.income.w2s[0]!.ctWithheldCents = (over.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
    const real = computeTy2025Return(over, { federalOverpayment: { chosen: "refund_all", ...WHO }, ctOverpayment: { chosen: "apply_amount", appliedDollars: 400, ...WHO } });
    const ours = real.decisions.filter((d) => d.id === "X7" || d.id === "X8");
    expect(ours.map((d) => d.id)).toEqual(["X7", "X8"]);
    const ret = { ...f.pipeline.ret, decisions: [...f.pipeline.ret.decisions, ...ours] };
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
        ownerRecords: { recordedDecisions: recordedDecisionsOf([row(), row({ id: "row-2", targetKey: "ctOverpayment", valueText: "apply_amount:400" })]), acceptedFindings: [] },
      },
      PEOPLE
    );
    const s = serializePayload(payload, PEOPLE, { entities: entities.entities, addresses: scrubAddressesFor(facts, FORM_1098) });
    return { payload: s.payload, json: s.json };
  }

  it("carries X7 / X8 under their ids with the choice text and the reason, and no key text or name anywhere", async () => {
    const { payload, json } = await payloadWithOverpayment();
    expect(payload.ownerStatements.recordedDecisions.map((d) => [d.target, d.value])).toEqual([
      ["X7", "refund_all"],
      ["X8", "apply_amount:400"],
    ]);
    expect(json).toContain('"target":"X7"');
    expect(json).toContain('"target":"X8"');
    expect(json).toContain(REASON);
    expect(json).not.toMatch(/federalOverpayment|ctOverpayment/);
    expect(leakingNames(json)).toEqual([]);
    expect(payload.decisions.find((d) => d.id === "X7")).toMatchObject({ id: "X7", chosen: "refund_all", status: "decided", label: OVERPAYMENT_LABELS.X7 });
    expect(payload.decisions.find((d) => d.id === "X8")).toMatchObject({ id: "X8", chosen: "apply_amount:400", status: "decided", label: OVERPAYMENT_LABELS.X8 });
  });
});
