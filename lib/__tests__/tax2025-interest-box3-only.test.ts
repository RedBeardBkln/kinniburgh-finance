// A 1099-INT with box 1 blank and only box 3 (US savings bond interest) filled used to be dropped silently (engine ty2025-1b.10): 1040 line 2b,
// Schedule B and CT Schedule 1 line 39 never saw it and nothing warned the owner. Since ty2025-1b.11 it is an interest fact with box 1 = 0, and a
// 1099-INT with no readable interest amount at all raises a blocking open item.

import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { describe, expect, it } from "vitest";
import { resolveFacts, type RawDocument } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { oracleLedger, runL2 } from "@/lib/tax-review/l2";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { runL1 } from "@/lib/tax-review/l1/run-l1";
import { buildReviewPayload, serializePayload } from "@/lib/tax-review/llm/payload";
import { SCRUB, PEOPLE } from "./tax-review-l3-harness";
import { buildPipeline, cleanDocs, doc, rawInputs, scenarioFor, significant, describeFindings } from "./tax-review-harness";
import { owner } from "./tax2025-fixtures";

const BOX3_ONLY = (over: Record<string, unknown> = {}): RawDocument =>
  doc("1099", { formVariant: "1099-INT", payerName: "Jewett City Savings Bank", payerEIN: "06-0000001", amountCents: null, int_box1Cents: null, int_box3Cents: 189_450, ...over });

const interestOf = (docs: RawDocument[]) => resolveFacts(rawInputs(docs));

describe("resolveFacts: 1099-INT with box 1 blank", () => {
  it("box 1 blank + box 3 only: an interest fact with box 1 = 0 and box 3 from the data, no legacy headline", () => {
    const d = BOX3_ONLY();
    const { facts, openItems } = interestOf([d]);
    expect(facts.income.interest).toHaveLength(1);
    expect(facts.income.interest[0]).toMatchObject({ docId: d.id, payer: "Jewett City Savings Bank", box1Cents: 0, usedLegacyHeadline: false, box3Cents: 189_450, basis: "doc_verified" });
    expect(openItems.some((o) => o.id.startsWith("interest-1099-unreadable"))).toBe(false);
  });
  it("an unverified document counts the same way", () => {
    const { facts } = interestOf([{ ...BOX3_ONLY(), verified: false }]);
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 0, box3Cents: 189_450 });
    expect(facts.income.interest[0]?.basis).not.toBe("doc_verified");
  });
  it("box 1 blank + box 4 only (withholding) also counts, with box 1 = 0", () => {
    const { facts } = interestOf([BOX3_ONLY({ int_box3Cents: null, int_box4Cents: 5_000 })]);
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 0, box4Cents: 5_000, box3Cents: 0, usedLegacyHeadline: false });
  });
  it("a consolidated 1099 whose variantsPresent lists the 1099-INT counts the same way", () => {
    const { facts } = interestOf([BOX3_ONLY({ formVariant: "consolidated", variantsPresent: ["1099-INT", "1099-DIV"] })]);
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 0, box3Cents: 189_450 });
  });
  it("a 1099-INT with no interest box at all and no headline blocks with a document-review action (never silently ignored)", () => {
    const d = BOX3_ONLY({ int_box3Cents: null });
    const { facts, openItems } = interestOf([d]);
    expect(facts.income.interest).toHaveLength(0);
    const item = openItems.find((o) => o.id === `interest-1099-unreadable:${d.id}`);
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toMatch(/no readable interest amount/);
    expect(item?.action).toMatch(/review screen/);
    expect(item?.refs.map((r) => r.id)).toContain(d.id);
  });
  it("box 1 present is unchanged (box 1 kept, no extra item)", () => {
    const { facts, openItems } = interestOf([BOX3_ONLY({ int_box1Cents: 50_000, amountCents: 50_000, int_box3Cents: 0 })]);
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 50_000, usedLegacyHeadline: false, box3Cents: 0 });
    expect(openItems.some((o) => o.id.startsWith("interest-1099-unreadable"))).toBe(false);
  });
  it("the legacy headline is unchanged (box 1 blank, amountCents read: headline used and flagged)", () => {
    const { facts } = interestOf([BOX3_ONLY({ amountCents: 123_400, int_box3Cents: null })]);
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 123_400, usedLegacyHeadline: true });
  });
  it("a 1099 that is not an INT (DIV only) is not an interest fact and raises no unreadable-interest item", () => {
    const { facts, openItems } = interestOf([doc("1099", { formVariant: "1099-DIV", payerName: "Fund", div_box1aCents: 1_000 })]);
    expect(facts.income.interest).toHaveLength(0);
    expect(openItems.some((o) => o.id.startsWith("interest-1099-unreadable"))).toBe(false);
  });
});

describe("the whole return with a box-3-only 1099-INT", () => {
  // cleanDocs(): Sample Bank box 1 $500.00; plus Jewett City box 3 $1,894.50 => 2b = 2,394.50 rounded once to $2,395
  const docs = (): RawDocument[] => [...cleanDocs(), BOX3_ONLY()];
  const scenario = () => scenarioFor("box3", docs(), (f) => {
    f.priorYear = { totalTaxCents: owner(2_600_000), agiCents: owner(17_000_000), filingStatus: owner("mfj") };
  });

  it("line 2b / Schedule B line 2 include box 1 + box 3, rounded once from cents", () => {
    const ret = computeTy2025Return(scenario().facts, {});
    expect(ret.lines["f1040.2b"]?.amount).toBe(2395);
    expect(ret.lines["schb.2"]?.amount).toBe(2395);
  });
  it("Schedule B is required (over $1,500) and the baseline without the document was not", () => {
    expect(computeTy2025Return(scenario().facts, {}).formsRequired.schb?.required).toBe(true);
    const baseline = computeTy2025Return(scenarioFor("base", cleanDocs()).facts, {});
    expect(baseline.formsRequired.schb?.required).toBe(false);
  });
  it("CT-1040 Schedule 1 line 39: subtracts box 3 when the owner stated no Form 8815 exclusion; blocks (existing rule) when unanswered", () => {
    const stated = scenario().facts;
    stated.statedNone.savings_bond_exclusion = owner(true);
    const a = computeTy2025Return(stated, {});
    expect(a.lines["ct1040.s1.39"]?.status).toBe("computed");
    expect(a.lines["ct1040.s1.39"]?.amount).toBe(1895);
    const unanswered = scenario().facts;
    delete unanswered.statedNone.savings_bond_exclusion;
    const b = computeTy2025Return(unanswered, {});
    expect(b.lines["ct1040.s1.39"]?.status).toBe("needs_cpa_judgment");
    expect(b.lines["ct1040.s1.39"]?.amount).toBeNull();
  });
  it("L2 (independent recomputation) agrees with the engine", () => {
    const f = scenario().facts;
    f.statedNone.savings_bond_exclusion = owner(true);
    const ret = computeTy2025Return(f, {});
    const input = { ret, effective: applyOverrides(ret, []), facts: f };
    const r = runL2(input);
    expect(r.status, r.reason ?? "").toBe("ran");
    expect(r.summary.mismatchCount).toBe(0);
    expect(oracleLedger(input).get("f1040.2b")).toBe(2395);
  });
  it("L1 finds no income tie-out problem and the PDF read-back agrees; the Schedule B payer row shows 1,895 (box 1 + box 3)", async () => {
    const s = scenario();
    s.facts.statedNone.savings_bond_exclusion = owner(true);
    const pipeline = await buildPipeline(s);
    const result = await runL1(pipeline.ctx);
    const bad = significant(result.findings).filter((x) => /C1|pdf|tieout|footing/i.test(x.check));
    expect(describeFindings(bad)).toEqual([]);
    const rows = pipeline.ctx.view.tables["schb.interest"] ?? [];
    const amounts = rows.map((r) => Object.values(r.cells).find((v) => typeof v === "number"));
    expect(amounts).toContain(1895);
    expect(rows.some((r) => Object.values(r.cells).includes("Jewett City Savings Bank"))).toBe(true);
  });
  it("L1 tie-out: the same document without the fix logic would have flagged; with it there is no 1040.2b mismatch", async () => {
    const s = scenario();
    const pipeline = await buildPipeline(s);
    const result = await runL1(pipeline.ctx);
    expect(result.findings.filter((x) => x.check.startsWith("L1.C1") && /1099-INT interest/.test(x.message))).toEqual([]);
  });
  it("the AI payload carries box1 0 / box3 1895 (whole dollars) with a document alias and the generic payer only", async () => {
    const pipeline = await buildPipeline(scenario());
    const read = await readPacketFiles(pipeline.ctx.packet.files);
    const bindings = bindFiles(pipeline.ctx, read);
    const l1 = await runL1(pipeline.ctx);
    const payload = buildReviewPayload(
      {
        ret: pipeline.ret,
        view: pipeline.ctx.view,
        facts: pipeline.ctx.facts,
        documents: (pipeline.ctx.raw?.documents ?? []).map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, extractionStatus: d.extractionStatus, subjectType: d.subjectType, subjectUserId: d.subjectUserId })),
        bindings,
        l1Findings: l1.findings,
        entityLabels: SCRUB.entities.map((e) => e.label),
        payerNames: "generic",
      },
      PEOPLE
    );
    // the payload sends whole dollars: $1,894.50 is rounded once to 1,895
    const { json, payload: sent } = serializePayload(payload, PEOPLE, SCRUB);
    const entry = sent.income.interest.find((i) => i.box3 === 1895);
    expect(entry, JSON.stringify(sent.income.interest)).toBeDefined();
    expect(entry).toMatchObject({ box1: 0, box3: 1895, payer: "Payer B" });
    // the structured facts carry the alias only; (the printed Schedule B text of the packet is a separate, existing payload section)
    expect(JSON.stringify(sent.income)).not.toContain("Jewett");
    expect(json).toContain("Payer B");
  });
});
