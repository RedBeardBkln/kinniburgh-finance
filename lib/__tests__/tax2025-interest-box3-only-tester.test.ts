// Tester round for interest-box3-only-1099 (engine ty2025-1b.11). Independent of the Coder's test file:
//  A. a seeded oracle fuzz of the resolver over 1099 documents (variant x box 1 x headline x other boxes), own arithmetic, not the Coder's rule text;
//  B. a live-shaped whole return (the four live 1099-INT cents values), NIIT arithmetic, the Schedule B PDF read back from bytes (payer row 1,895,
//     total, line 4), the final package builds with the banned-wording scan, the L1 run raises no tie-out / footing / pdf blocker;
//  C. the unreadable-1099-INT blocking item: headline, link, an "unusable consolidated" over-flag documented;
//  D. pinned gaps found by the tester (it.fails: they flip red the day someone fixes them, then drop the .fails).

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
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { buildLinkContext } from "@/lib/tax-review/links-context";
import { openItemLinks, openItemRuleFor } from "@/lib/tax-review/links";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { SCRUB, PEOPLE } from "./tax-review-l3-harness";
import { buildPipeline, cleanDocs, doc, loadCatalogs, rawInputs, scenarioFor, significant, describeFindings, w2Doc, interestDoc, dividendDoc, mortgageDoc, propertyTaxDoc } from "./tax-review-harness";
import { owner, ERIC_ID, EVA_ID } from "./tax2025-fixtures";
import { computePersonalFormPlan, type PersonalFormPlanInput } from "@/lib/tax-form-plan";

// ── A. resolver oracle fuzz ───────────────────────────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const OTHER = ["int_box2Cents", "int_box3Cents", "int_box4Cents", "int_box5Cents", "int_box6Cents", "int_box8Cents", "int_box9Cents"] as const;

describe("A. resolveFacts 1099-INT oracle fuzz (own arithmetic)", () => {
  it("2000 random 1099 documents: fact present / box 1 / legacy flag / unreadable item match an independent oracle", () => {
    const rnd = lcg(20261006);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const counts = { fact: 0, zeroBox1: 0, legacy: 0, item: 0, none: 0, consolidated: 0 };
    for (let n = 0; n < 2000; n++) {
      const variant = pick(["1099-INT", "1099-INT", "consolidated", "1099-DIV", undefined] as const);
      const vp = variant === "consolidated" ? pick([["1099-INT", "1099-DIV"], ["1099-DIV", "1099-B"], ["1099-INT"]] as const) : undefined;
      const data: Record<string, unknown> = { payerName: "Payer X" };
      if (variant !== undefined) data.formVariant = variant;
      if (vp !== undefined) data.variantsPresent = [...vp];
      const int1 = pick([undefined, null, 0, 5_000] as const);
      if (int1 !== undefined) data.int_box1Cents = int1;
      const headline = pick([undefined, null, 7_777] as const);
      if (headline !== undefined) data.amountCents = headline;
      for (const k of OTHER) {
        const v = pick([undefined, undefined, null, 0, 1_234] as const);
        if (v !== undefined) data[k] = v;
      }
      const d = doc("1099", data);
      const { facts, openItems } = resolveFacts(rawInputs([d]));

      const isInt = variant === "1099-INT" || ((vp as readonly string[] | undefined)?.includes("1099-INT") ?? false);
      const hasInt1 = typeof int1 === "number";
      const legacy = !hasInt1 && variant === "1099-INT" && typeof headline === "number";
      const hasOther = OTHER.some((k) => typeof data[k] === "number");
      const wantFact = hasInt1 || legacy || (isInt && hasOther);
      const wantItem = isInt && !hasInt1 && !legacy && !hasOther;

      const got = facts.income.interest.filter((i) => i.docId === d.id);
      expect(got.length, JSON.stringify(data)).toBe(wantFact ? 1 : 0);
      const item = openItems.filter((o) => o.id === `interest-1099-unreadable:${d.id}`);
      expect(item.length, JSON.stringify(data)).toBe(wantItem ? 1 : 0);
      if (wantItem) expect(item[0]?.severity).toBe("blocking");
      if (wantFact) {
        const f = got[0]!;
        const wantBox1 = hasInt1 ? (int1 as number) : legacy ? (headline as number) : 0;
        expect(f.box1Cents, JSON.stringify(data)).toBe(wantBox1);
        expect(f.usedLegacyHeadline, JSON.stringify(data)).toBe(legacy);
        counts.fact++;
        if (!hasInt1 && !legacy) counts.zeroBox1++;
        if (legacy) counts.legacy++;
      }
      if (wantItem) counts.item++;
      if (!wantFact && !wantItem) counts.none++;
      if (variant === "consolidated") counts.consolidated++;
    }
    // the generator really reached every branch
    expect(counts.zeroBox1).toBeGreaterThan(100);
    expect(counts.legacy).toBeGreaterThan(50);
    expect(counts.item).toBeGreaterThan(8);
    expect(counts.none).toBeGreaterThan(100);
    expect(counts.consolidated).toBeGreaterThan(200);
  });

  it("a document that is not a 1099-INT never becomes an interest fact even if a stray int box is present (DIV with int_box3)", () => {
    const d = doc("1099", { formVariant: "1099-DIV", payerName: "Fund", int_box3Cents: 5_000, div_box1aCents: 1_000 });
    const { facts, openItems } = resolveFacts(rawInputs([d]));
    expect(facts.income.interest).toHaveLength(0);
    expect(openItems.some((o) => o.id.startsWith("interest-1099-unreadable"))).toBe(false);
  });

  it("two 1099-INT documents (one box-3-only, one all-null): the first counts, the second blocks, neither hides the other", () => {
    const a = doc("1099", { formVariant: "1099-INT", payerName: "A", int_box1Cents: null, int_box3Cents: 10_000 });
    const b = doc("1099", { formVariant: "1099-INT", payerName: "B", int_box1Cents: null });
    const { facts, openItems } = resolveFacts(rawInputs([a, b]));
    expect(facts.income.interest.map((i) => i.docId)).toEqual([a.id]);
    expect(openItems.filter((o) => o.id.startsWith("interest-1099-unreadable")).map((o) => o.id)).toEqual([`interest-1099-unreadable:${b.id}`]);
  });

  it("a document of another tax year is ignored by both paths (no fact, no unreadable item)", () => {
    const d = doc("1099", { formVariant: "1099-INT", payerName: "A", int_box1Cents: null, int_box3Cents: 10_000 }, { taxYear: 2024 });
    const e = doc("1099", { formVariant: "1099-INT", payerName: "B", int_box1Cents: null }, { taxYear: 2024 });
    const { facts, openItems } = resolveFacts(rawInputs([d, e]));
    expect(facts.income.interest).toHaveLength(0);
    expect(openItems.some((o) => o.id.startsWith("interest-1099-unreadable"))).toBe(false);
  });
});

// ── B. live-shaped whole return ───────────────────────────────────────────────

// The four live 1099-INT documents' cents (read-only run, 2026-10-06): box 1 of 1,372 / 0 / 112,432 and box 3 189,450 with box 1 blank.
function liveShapedDocs(withBox3Doc: boolean): RawDocument[] {
  const docs: RawDocument[] = [
    w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 20_000_000, 3_000_000, 600_000),
    w2Doc(EVA_ID, "Brewery Sample LLC", "22-2222222", 9_000_000, 900_000, 300_000),
    interestDoc("Bank One", "33-3333333", 1_372),
    interestDoc("Bank Two", "33-3333334", 0),
    interestDoc("Bank Three", "33-3333335", 112_432),
    dividendDoc("Sample Brokerage", "44-4444444", 100_000, 80_000),
    mortgageDoc(1_888_269, 40_000_000),
    propertyTaxDoc("Town of Sample", "27 Old Barry Rd", 600_000),
  ];
  if (withBox3Doc) docs.push(doc("1099", { formVariant: "1099-INT", payerName: "Savings Sample Bank", payerEIN: "06-0000001", amountCents: null, int_box1Cents: null, int_box3Cents: 189_450 }));
  return docs;
}
const scenario = (withDoc: boolean) =>
  scenarioFor(withDoc ? "box3" : "base", liveShapedDocs(withDoc), (f) => {
    f.priorYear = { totalTaxCents: owner(5_000_000), agiCents: owner(32_000_000), filingStatus: owner("mfj") };
    f.statedNone.savings_bond_exclusion = owner(true);
  });
const num = (r: ReturnType<typeof computeTy2025Return>, k: string): number => {
  const l = (r.lines as Record<string, { amount?: number | null } | undefined>)[k];
  return l?.amount ?? NaN;
};
const half = (x: number): number => Math.floor(x + 0.5);

describe("B. live-shaped whole return", () => {
  const withDoc = computeTy2025Return(scenario(true).facts, {});
  const base = computeTy2025Return(scenario(false).facts, {});

  it("2b: 1,138 before (1,372+0+112,432 cents) and 3,033 after (303,254 cents rounded once), Schedule B 2 / 4 agree", () => {
    expect(num(base, "f1040.2b")).toBe(1138);
    expect(num(withDoc, "f1040.2b")).toBe(half((1372 + 0 + 112_432 + 189_450) / 100));
    expect(num(withDoc, "f1040.2b")).toBe(3033);
    expect(num(withDoc, "schb.2")).toBe(3033);
    expect(num(withDoc, "schb.4")).toBe(3033);
    expect(base.formsRequired.schb?.required).toBe(false);
    expect(withDoc.formsRequired.schb?.required).toBe(true);
  });

  it("CT line 39 subtracts the box 3 amount once ($1,894.50 -> 1,895) and CT AGI is federal AGI minus it", () => {
    expect(num(withDoc, "ct1040.s1.39")).toBe(1895);
    expect(num(base, "ct1040.s1.39")).toBe(0);
    expect(num(withDoc, "ct1040.ctAgi")).toBe(num(withDoc, "f1040.11b") - 1895);
    // federal AGI rose by the new interest; CT AGI by that minus the subtraction (the box 3 amount only: no other change)
    expect(num(withDoc, "f1040.11b") - num(base, "f1040.11b")).toBe(1895);
    expect(num(withDoc, "ct1040.ctAgi")).toBe(num(base, "ct1040.ctAgi"));
  });

  it("NIIT: 3.8% of the lesser of net investment income and MAGI over 250,000; the box 3 interest is in line 1 and line 8", () => {
    expect(num(withDoc, "f8960.1")).toBe(3033);
    expect(num(withDoc, "f8960.8") - num(base, "f8960.8")).toBe(1895);
    for (const r of [base, withDoc]) {
      const magi = num(r, "f8960.13");
      const over = magi - 250_000;
      expect(num(r, "f8960.15")).toBe(over);
      const nii = num(r, "f8960.nii");
      expect(num(r, "f8960.16")).toBe(Math.min(nii, over));
      expect(num(r, "sch2.12")).toBe(half(Math.min(nii, over) * 0.038));
      expect(over).toBeGreaterThan(0);
    }
    expect(num(withDoc, "sch2.12")).toBeGreaterThan(num(base, "sch2.12"));
  });

  it("L2 (independent recomputation) agrees on every compared line", () => {
    const f = scenario(true).facts;
    const ret = computeTy2025Return(f, {});
    const input = { ret, effective: applyOverrides(ret, []), facts: f };
    const r = runL2(input);
    expect(r.status, r.reason ?? "").toBe("ran");
    expect(r.summary.mismatchCount).toBe(0);
    expect(oracleLedger(input).get("f1040.2b")).toBe(3033);
  });

  it("the Schedule B PDF read back from its bytes shows the payer row 1,895, the total 3,033 and line 4 3,033; the final package builds; L1 has no tie-out / footing / pdf blocker", async () => {
    const s = scenario(true);
    const pipeline = await buildPipeline(s, { includeFinalPackage: true });
    const read = await readPacketFiles(pipeline.ctx.packet.files);
    const sb = read.find((r) => r.formId === "f1040sb");
    expect(sb, "Schedule B is in the packet").toBeDefined();
    const vals = [...(sb?.fields ?? new Map<string, string | boolean>()).entries()].filter(([, v]) => typeof v === "string" && v !== "") as [string, string][];
    const byName = (suffix: string) => vals.find(([n]) => n.endsWith(suffix))?.[1];
    expect(vals.map(([, v]) => v)).toContain("1,895");
    expect(byName("f1_31[0]")).toBe("3,033");
    expect(byName("f1_33[0]")).toBe("3,033");
    // the payer name field sits just before its amount field (name = amount field number - 1)
    const amountField = vals.find(([, v]) => v === "1,895")![0];
    const m = /f1_(\d\d)\[0\]$/.exec(amountField)!;
    const nameField = amountField.replace(/f1_\d\d\[0\]$/, `f1_${String(Number(m[1]) - 1).padStart(2, "0")}[0]`);
    expect(vals.find(([n]) => n === nameField)?.[1]).toBe("Savings Sample Bank");
    // final package: built (not refused) and carries Schedule B
    expect(pipeline.ctx.finalPackage?.ok, JSON.stringify(pipeline.ctx.finalPackage)).toBe(true);
    if (pipeline.ctx.finalPackage?.ok === true) expect(pipeline.ctx.finalPackage.files.some((f) => f.formId === "f1040sb")).toBe(true);
    const result = await runL1(pipeline.ctx);
    const gating = result.findings.filter((f) => f.severity === "blocker" || f.severity === "high");
    expect(describeFindings(gating)).toEqual([]);
    const bad = significant(result.findings).filter((x) => /L1\.(B|C1|F)|tieout|pdf|footing/i.test(x.check) && !/books-interest|business-use/.test(x.check));
    expect(describeFindings(bad)).toEqual([]);
  });

  it("no string of the owner-visible final package or the sheet carries banned wording for this return", async () => {
    const pipeline = await buildPipeline(scenario(true), { includeFinalPackage: true });
    const texts = [pipeline.ctx.csvText, ...pipeline.ctx.sheet.openItems.map((i) => `${i.message} ${i.action}`)];
    for (const t of texts) expect(findOwnerBannedWording(t), t.slice(0, 80)).toEqual([]);
  });

  it("the fingerprint inputs differ: the facts carry the new interest row (box 1 = 0, box 3 = 189,450)", () => {
    const a = JSON.stringify(scenario(false).facts.income.interest);
    const b = JSON.stringify(scenario(true).facts.income.interest);
    expect(a).not.toBe(b);
    expect(scenario(true).facts.income.interest.some((i) => i.box1Cents === 0 && i.box3Cents === 189_450)).toBe(true);
  });
});

// ── C. the unreadable 1099-INT blocking item ──────────────────────────────────

describe("C. a 1099-INT with no readable interest", () => {
  const unreadable = () => doc("1099", { formVariant: "1099-INT", payerName: "Blank Sample Bank", int_box1Cents: null });
  const docs = (): RawDocument[] => [...cleanDocs(), unreadable()];

  it("blocks the headline (complete = false, a blocking item) rather than being silently omitted; 2b stays what the other documents give", () => {
    const sc = scenarioFor("unreadable", docs(), (f) => {
      f.priorYear = { totalTaxCents: owner(2_600_000), agiCents: owner(17_000_000), filingStatus: owner("mfj") };
    });
    const { openItems } = resolveFacts(sc.raw);
    const item = openItems.find((o) => o.id.startsWith("interest-1099-unreadable:"));
    expect(item?.severity).toBe("blocking");
    // facts of scenarioFor are grafted: feed the resolver's items to the engine as the build does
    const resolved = resolveFacts(sc.raw);
    const ret = computeTy2025Return(resolved.facts, {}, { conflicts: resolved.conflicts, openItems: resolved.openItems });
    expect(ret.openItems.some((o) => o.id.startsWith("interest-1099-unreadable:") && o.severity === "blocking")).toBe(true);
    expect(ret.headline.blockingItemCount).toBeGreaterThanOrEqual(1);
    expect(ret.headline.complete).toBe(false);
  });

  it("the item has an explicit link rule and its link opens the document's review screen", () => {
    const d = unreadable();
    const sc = scenarioFor("unreadable-link", [...cleanDocs(), d]);
    const resolved = resolveFacts(sc.raw);
    const ret = computeTy2025Return(resolved.facts, {}, { conflicts: resolved.conflicts, openItems: resolved.openItems });
    const id = `interest-1099-unreadable:${d.id}`;
    expect(openItemRuleFor(id).explicit).toBe(true);
    const model = buildSheetModel({ ret, documents: sc.raw.documents.map((x) => ({ id: x.id, docType: x.docType, taxYear: x.taxYear, verified: x.verified, legacyFormat: x.legacyFormat, subjectType: x.subjectType })), now: new Date("2026-10-05T12:00:00Z") });
    const item = model.openItems.find((i) => i.id === id);
    expect(item, "the item is on the sheet").toBeDefined();
    const ctx = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
    const links = openItemLinks(item!, ctx);
    expect(links.map((l) => l.href)).toContain(`/documents/${d.id}/review`);
  });

  it("a consolidated 1099 whose variantsPresent lists the 1099-INT but whose int boxes are all null ALSO blocks (documented over-flag: the engine cannot tell 'no interest' from 'unread')", () => {
    const d = doc("1099", { formVariant: "consolidated", variantsPresent: ["1099-INT", "1099-DIV", "1099-B"], payerName: "Broker", div_box1aCents: 1_000 });
    const { openItems } = resolveFacts(rawInputs([d]));
    expect(openItems.some((o) => o.id === `interest-1099-unreadable:${d.id}`)).toBe(true);
  });
});

// ── D. pinned gaps ────────────────────────────────────────────────────────────

describe("D. gaps found by the tester (pinned with it.fails; remove .fails when fixed)", () => {
  it.fails("L1.C2.books-interest states the 1099-INT interest INCLUDING box 3 (the return's 2b input), not box 1 only", async () => {
    // books interest + a box-3-only 1099-INT next to a box 1 document: the info message says "1099-INT interest (<box 1 sum>)" while 2b counts box 1 + box 3
    const sc = scenarioFor("books", [...cleanDocs(), doc("1099", { formVariant: "1099-INT", payerName: "Savings Sample Bank", int_box1Cents: null, int_box3Cents: 189_450 })], (f) => {
      f.priorYear = { totalTaxCents: owner(2_600_000), agiCents: owner(17_000_000), filingStatus: owner("mfj") };
    });
    const pipeline = await buildPipeline(sc);
    // give the return some books interest so the finding fires
    (pipeline.ctx.ret.scheduleC ??= {} as never);
    const sched = pipeline.ctx.ret.scheduleC as unknown as { booksInterest?: { amountCents: number }[] };
    sched.booksInterest = [{ amountCents: 20_000 }];
    const result = await runL1(pipeline.ctx);
    const f = result.findings.find((x) => x.check === "L1.C2.books-interest");
    expect(f, "the finding fires").toBeDefined();
    // 500.00 (box 1) + 1,894.50 (box 3) = 2,394.50 -> "$2,395"; the message must carry it
    expect(f?.message).toMatch(/2,395|2,394/);
  });

  it.fails("TAX_REVIEW_PAYER_NAMES=generic hides the payer name also in the open-item messages that reach the AI payload (new unreadable item names the payer)", async () => {
    const d = doc("1099", { formVariant: "1099-INT", payerName: "Zebracorp Savings Bank", int_box1Cents: null });
    const sc = scenarioFor("leak-items", [...cleanDocs(), d]);
    const resolved = resolveFacts(sc.raw);
    sc.facts = resolved.facts;
    const pipeline = await buildPipeline(sc);
    pipeline.ret.openItems.push(...resolved.openItems);
    const read = await readPacketFiles(pipeline.ctx.packet.files);
    const l1 = await runL1(pipeline.ctx);
    const payload = buildReviewPayload(
      { ret: pipeline.ret, view: pipeline.ctx.view, facts: pipeline.ctx.facts, documents: [], bindings: bindFiles(pipeline.ctx, read), l1Findings: l1.findings, entityLabels: SCRUB.entities.map((e) => e.label), payerNames: "generic" },
      PEOPLE
    );
    const { json } = serializePayload(payload, PEOPLE, SCRUB);
    expect(json).not.toContain("Zebracorp");
  });

  it.fails("TAX_REVIEW_PAYER_NAMES=generic hides the payer name also in the printed packet rows (forms[].rows[].printed); PRE-EXISTING on the base commit", async () => {
    const d = interestDoc("Zebracorp Savings Bank", "06-0000001", 200_000);
    const sc = scenarioFor("leak-forms", [...cleanDocs(), d]);
    const pipeline = await buildPipeline(sc);
    const read = await readPacketFiles(pipeline.ctx.packet.files);
    const l1 = await runL1(pipeline.ctx);
    const payload = buildReviewPayload(
      { ret: pipeline.ret, view: pipeline.ctx.view, facts: pipeline.ctx.facts, documents: [], bindings: bindFiles(pipeline.ctx, read), l1Findings: l1.findings, entityLabels: SCRUB.entities.map((e) => e.label), payerNames: "generic" },
      PEOPLE
    );
    const { json } = serializePayload(payload, PEOPLE, SCRUB);
    expect(json).not.toContain("Zebracorp");
  });
});

// ── E. the form-readiness plan (lib/tax-form-plan.ts interestEvidence): the Coder's change had no test (mutation M5 survived) ──────────

describe("E. form plan: interest income evidence for a 1099-INT with box 1 blank", () => {
  const input = (data: Record<string, unknown>): PersonalFormPlanInput => ({
    documents: [{ docType: "1099", extractionStatus: "complete", extractionData: { docType: "1099", summary: "", data } }],
    questions: [],
    ekConsultingPL: null,
    suddenValleyPL: null,
    ekConsultingMileageCount: 0,
    solarLoanOriginalCostCents: null,
    donationCount: 0,
    ekConsultingFixedAssetCount: 0,
    suddenValleyBuildingAssetCount: 0,
  });
  const flat = (data: Record<string, unknown>) => {
    const r: unknown = computePersonalFormPlan(input(data));
    const out: { line: string; haveData: boolean }[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.line === "string" && typeof o.haveData === "boolean") out.push({ line: o.line, haveData: o.haveData });
        for (const x of Object.values(o)) walk(x);
      }
    };
    walk(r);
    return out.find((l) => l.line === "Interest income (line 2b)")?.haveData;
  };

  it("box 3 only counts as interest data (1099-INT variant and consolidated with variantsPresent)", () => {
    expect(flat({ formVariant: "1099-INT", int_box1Cents: null, int_box3Cents: 189_450 })).toBe(true);
    expect(flat({ formVariant: "consolidated", variantsPresent: ["1099-INT"], int_box3Cents: 189_450 })).toBe(true);
  });
  it("a 1099-INT with no interest box at all is still missing, and a non-INT form with a stray int box is not interest data", () => {
    expect(flat({ formVariant: "1099-INT", int_box1Cents: null })).toBe(false);
    expect(flat({ formVariant: "1099-DIV", int_box3Cents: 5_000 })).toBe(false);
  });
});
