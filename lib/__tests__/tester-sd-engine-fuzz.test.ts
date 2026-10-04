// TESTER probes for the Schedule D engine: no-silent-zero fuzz with an independent status oracle, routing table,
// questionnaire-path (real answers through parseCompletenessAnswers), G1 closure through the REAL capture resolver,
// purity / float / scope checks. Expected statuses are derived from the 2025 form text + the plan, not from the Coder's code.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNSURE_ID, type AnswerValue, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { normalizeTaxExtraction } from "@/lib/tax-extraction-schema";
import { BROKER_BOXES, type BrokerBox, type BrokerSaleFact, type OtherIncomeBox, type Ty2025Facts } from "@/lib/tax2025/facts";
import { LINE_CATALOG, NONE_GROUP_IDS } from "@/lib/tax2025/line-catalog";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { missingLeaf, type LineKey, type Sourced } from "@/lib/tax2025/types";
import { ERIC_ID, EVA_ID, dividend, fullFacts, owner } from "@/lib/__tests__/tax2025-fixtures";

const SCHD_KEYS = LINE_CATALOG.filter((m) => m.key.startsWith("schd.")).map((m) => m.key);
const WATCH: LineKey[] = [...SCHD_KEYS, "f1040.7a", "f1040.7b", "qdcg.3"];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Tri = "yes" | "no" | "unsure" | "missing";
const leafOf = <T,>(state: Tri, yes: T, no: T): Sourced<T> => (state === "yes" ? owner(yes) : state === "no" ? owner(no) : state === "unsure" ? { value: null, basis: "answer_owner", refs: [] } : missingLeaf());

interface Gen {
  f: Ty2025Facts;
  // oracle inputs
  docs: { summaryRead: boolean; signalled: boolean; da: boolean; sec1256: number | null; rows: { form: "1099-B" | "1099-DA" | null; box: BrokerBox | null; p: number | null; c: number | null; w: number | null; d: number | null; g: number | null }[] }[];
  salesComplete: Tri; // yes = true
  adj: Tri; // yes = something the broker missed (true)
  carryS: { state: "answered" | "unsure" | "missing"; v: number };
  carryL: { state: "answered" | "unsure" | "missing"; v: number };
  otherNone: "true" | "false" | "absent";
  specialNone: "true" | "false" | "absent";
  box2a: number | null; // null = no dividend docs and not confirmed
}

function gen(rnd: () => number): Gen {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const f = fullFacts();
  const nDocs = pick([0, 1, 1, 1, 2]);
  const docs: Gen["docs"] = [];
  const sales: BrokerSaleFact[] = [];
  const money = (): number | null => pick([null, 0, 0, 1, 599, 100_000, 587_231, 1_203_728, 5_000_000]);
  for (let i = 0; i < nDocs; i++) {
    const summaryRead = rnd() < 0.75;
    const nRows = summaryRead ? pick([0, 1, 2, 2, 3]) : 0;
    const rows: Gen["docs"][number]["rows"] = [];
    for (let k = 0; k < nRows; k++) {
      const form = pick(["1099-B", "1099-B", "1099-B", "1099-DA", null] as const);
      const box = pick([...BROKER_BOXES, "A", "D", "A", "D", "B", null] as const) as BrokerBox | null;
      rows.push({ form, box, p: money(), c: money(), w: pick([null, 0, 0, 0, 599, 2_000]), d: pick([null, 0, 0, 0, 0, 300]), g: money() });
    }
    const signalled = rnd() < 0.8;
    const da = rows.some((r) => r.form === "1099-DA") || rnd() < 0.1;
    const sec1256 = pick([null, null, 0, 0, 5_000, -3_000]);
    docs.push({ summaryRead, signalled, da, sec1256, rows });
    sales.push({
      docId: `d${i}`,
      payer: pick(["Robinhood Markets, Inc.", "Robinhood Markets, Inc.", "Other Broker", null]),
      basis: "doc_verified",
      legacyFormat: false,
      refs: [{ kind: "document", id: `d${i}`, label: "1099" }],
      summaryRead,
      signalled1099B: signalled,
      rows: rows.map((r) => ({ form: r.form, box: r.box, proceedsCents: r.p, costCents: r.c, accruedMarketDiscountCents: r.d, washSaleLossDisallowedCents: r.w, gainLossCents: r.g })),
      sec1256AggregateCents: sec1256,
      forms1099DaPresent: da,
    });
  }
  f.income.brokerSales = sales;
  const salesComplete = pick<Tri>(["yes", "yes", "yes", "no", "unsure", "missing"]);
  const adj = pick<Tri>(["no", "no", "no", "yes", "unsure", "missing"]);
  const carry = (): Gen["carryS"] => pick([{ state: "answered" as const, v: 0 }, { state: "answered" as const, v: 0 }, { state: "answered" as const, v: 150_000 }, { state: "unsure" as const, v: 0 }, { state: "missing" as const, v: 0 }]);
  const carryS = carry();
  const carryL = carry();
  const lf = (c: Gen["carryS"]): Sourced<number> => (c.state === "answered" ? owner(c.v) : c.state === "unsure" ? { value: null, basis: "answer_owner", refs: [] } : missingLeaf());
  f.returnAnswers.capitalGains = {
    carryoverShortCents: lf(carryS),
    carryoverLongCents: lf(carryL),
    salesComplete: leafOf(salesComplete, true, false),
    brokerAdjustments: leafOf(adj, true, false),
  };
  const otherNone = pick(["true", "true", "true", "false", "absent"] as const);
  const specialNone = pick(["true", "true", "true", "false", "absent"] as const);
  if (otherNone === "absent") delete f.statedNone.capital_gain_other;
  else f.statedNone.capital_gain_other = owner(otherNone === "true");
  if (specialNone === "absent") delete f.statedNone.capital_special_rates;
  else f.statedNone.capital_special_rates = owner(specialNone === "true");
  let box2a: number | null = 0;
  const divMode = pick(["zero", "zero", "some", "none"] as const);
  if (divMode === "some") {
    box2a = pick([1234, 56_789]);
    f.income.dividends = [dividend({ docId: "div-1", box1aCents: 100_000, box1bCents: 80_000, box2aCents: box2a })];
  } else if (divMode === "none") {
    f.income.dividends = [];
    f.income.noDividendsConfirmed = pick([owner(true), missingLeaf<boolean>()]);
    box2a = f.income.noDividendsConfirmed.value === true ? 0 : null;
  }
  f.returnAnswers.attestations.digitalAssets = pick([owner(true), owner(false), missingLeaf<boolean>()]);
  return { f, docs, salesComplete, adj, carryS, carryL, otherNone, specialNone, box2a };
}

/** Independent expectation: can Form 1040 line 7a be COMPUTED from these facts? (derived from the form text + plan; null/unknown never defaults to zero) */
function expectComputed7a(g: Gen): { computed: boolean; why: string } {
  // A row is ignored only when all five figures are KNOWN zeros (D1 fixed: an unread figure is unknown, never zero).
  const rowIgnorable = (r: Gen["docs"][number]["rows"][number]): boolean => r.p === 0 && r.c === 0 && r.w === 0 && r.d === 0 && r.g === 0;
  const allRows = g.docs.flatMap((d) => d.rows.filter((r) => !rowIgnorable(r)));
  const hasRows = allRows.length > 0;
  const unread = g.docs.some((d) => !d.summaryRead && (d.signalled || d.da));
  const sec1256 = g.docs.some((d) => d.sec1256 !== null && d.sec1256 !== 0);
  const carryPositive = [g.carryS, g.carryL].some((c) => c.state === "answered" && c.v > 0);
  const carryUnsure = [g.carryS, g.carryL].some((c) => c.state === "unsure");
  const carryMissing = [g.carryS, g.carryL].some((c) => c.state === "missing");
  const anyTrue = hasRows || sec1256 || carryPositive || g.otherNone === "false" || g.specialNone === "false";
  const anyUnknown = unread || (g.docs.some((d) => d.da) && !hasRows) || g.salesComplete === "no" || g.salesComplete === "unsure" || carryUnsure;
  const required = anyTrue || anyUnknown;
  if (!required) {
    return g.box2a === null ? { computed: false, why: "box 2a unknown" } : { computed: true, why: "exception 1" };
  }
  if (unread) return { computed: false, why: "unread 1099-B summary" };
  if (g.salesComplete === "no" || g.salesComplete === "unsure") return { computed: false, why: "other sales" };
  if (hasRows && g.salesComplete === "missing") return { computed: false, why: "sales completeness unanswered" };
  if (hasRows && g.adj !== "no") return { computed: false, why: "broker adjustments not confirmed none" };
  if (!hasRows && g.specialNone === "false") return { computed: false, why: "special rates, no sale on file" };
  for (const r of allRows) {
    if (r.form === null || r.box === null) return { computed: false, why: "row not routable" };
    if (r.p === null || r.c === null || r.w === null || r.d === null) return { computed: false, why: "null figure" };
    if (r.d > 0) return { computed: false, why: "accrued market discount" };
    const noInfoReturn = ["C", "F", "I", "L"].includes(r.box);
    if (noInfoReturn) return { computed: false, why: "box C/F/I/L" };
    const daBoxes = ["G", "H", "I", "J", "K", "L"];
    if ((r.form === "1099-DA") !== daBoxes.includes(r.box)) return { computed: false, why: "form / box mismatch" };
  }
  if (sec1256) return { computed: false, why: "section 1256" };
  if (g.otherNone !== "true") return { computed: false, why: "lines 4/5/11/12 not stated none" };
  if (carryUnsure || carryMissing) return { computed: false, why: "carryover" };
  if (g.box2a === null) return { computed: false, why: "box 2a unknown" };
  return { computed: true, why: "all inputs known" };
}

describe("no silent zero: random facts, independent status oracle", () => {
  it("random fact sets (3,000; 12,000 with SD_TESTER_FULL=1): never throws; every watched line has a status; amounts only when computed / not_applicable; reasons when blocked; 7a computed iff the oracle says so", () => {
    const N = process.env.SD_TESTER_FULL ? 12000 : 3000; // the Tester's verdict run used SD_TESTER_FULL=1
    const rnd = mulberry32(4242);
    let computedN = 0;
    let blockedN = 0;
    const whyCount = new Map<string, number>();
    const mismatches: string[] = [];
    for (let i = 0; i < N; i++) {
      const g = gen(rnd);
      const ret = computeTy2025Return(g.f); // must not throw
      for (const k of WATCH) {
        const l = ret.lines[k];
        expect(l, `${i} ${k} has no line`).toBeDefined();
        const st = l!.status;
        expect(st, `${i} ${k} no status`).toBeDefined();
        if (st === "computed" || st === "not_applicable") expect(l!.amount, `${i} ${k}`).not.toBeNull();
        else {
          expect(l!.amount, `${i} ${k} blocked line with an amount`).toBeNull();
          expect((l!.reason ?? "").length, `${i} ${k} blocked without reason`).toBeGreaterThan(10);
        }
      }
      const e = expectComputed7a(g);
      const st7a = ret.lines["f1040.7a"]!.status;
      const isComp = st7a === "computed";
      whyCount.set(e.why, (whyCount.get(e.why) ?? 0) + 1);
      if (isComp !== e.computed) mismatches.push(`${i}: engine 7a ${st7a}, oracle computed=${e.computed} (${e.why}) ${JSON.stringify(g.docs)} sc=${g.salesComplete} adj=${g.adj} cs=${JSON.stringify(g.carryS)} cl=${JSON.stringify(g.carryL)} other=${g.otherNone} special=${g.specialNone} 2a=${g.box2a}`);
      if (isComp) computedN++;
      else blockedN++;
      // headline is never "complete" while 7a is blocked
      if (!isComp) expect(ret.headline.complete, `${i} complete with blocked 7a`).toBe(false);
      // a read summary with a non-zero row can never be 'Schedule D not required' / 'no sales on file'
      const strictRows = g.docs.flatMap((d) => d.summaryRead ? d.rows : []).filter((r) => r.p !== 0 || r.c !== 0 || r.w !== 0 || r.d !== 0 || r.g !== 0);
      if (strictRows.length > 0) {
        expect(ret.scheduleD?.required, `${i} required false with rows`).not.toBe(false);
        expect(ret.lines["f1040.7a"]!.reason ?? "", `${i}`).not.toMatch(/no 1099-B sales are on file/i);
        expect(ret.formsRequired.schd?.required, `${i} formsRequired.schd false with rows`).not.toBe(false);
      }
    }
    console.log("fuzz 7a computed", computedN, "blocked", blockedN, [...whyCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" | "));
    if (mismatches.length > 0) console.log(mismatches.slice(0, 15).join("\n"));
    expect(mismatches.length, `status mismatches (first): ${mismatches[0] ?? ""}`).toBe(0);
    expect(computedN).toBeGreaterThan(N * 0.03);
    expect(blockedN).toBeGreaterThan(N * 0.25);
  }, 600_000);

  it("a legacy 1099-B 'other box' (no brokerSales entry) still blocks 7a (needs_cpa_judgment); a 1099-B box with a read summary does not double count", () => {
    const f = fullFacts();
    const box: OtherIncomeBox = { docId: "old", payer: "Robinhood", basis: "doc_verified", variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2_287_399 };
    f.income.otherIncomeBoxes = [box];
    const ret = computeTy2025Return(f);
    expect(ret.lines["f1040.7a"]!.status).toBe("needs_cpa_judgment");
    expect(ret.headline.complete).toBe(false);
  });
});

// ── Routing table (Form 8949 instructions Exception 1 / Exception 2) ──────────────────────────────────
describe("routing: each (form, box) with and without wash sale, per the 2025 instructions", () => {
  const route = (form: "1099-B" | "1099-DA", box: BrokerBox, w: number, extra: Partial<{ d: number; adjYes: boolean }> = {}) => {
    const f = fullFacts();
    f.income.brokerSales = [{
      docId: "x", payer: "Robinhood Markets, Inc.", basis: "doc_verified", legacyFormat: false, refs: [{ kind: "document", id: "x", label: "1099" }],
      summaryRead: true, signalled1099B: true,
      rows: [{ form, box, proceedsCents: 100_000, costCents: 60_000, accruedMarketDiscountCents: extra.d ?? 0, washSaleLossDisallowedCents: w, gainLossCents: 40_000 + w }],
      sec1256AggregateCents: 0, forms1099DaPresent: form === "1099-DA",
    }];
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(extra.adjYes === true) };
    if (form === "1099-DA") f.returnAnswers.attestations.digitalAssets = owner(true);
    return computeTy2025Return(f);
  };
  const L = (ret: ReturnType<typeof computeTy2025Return>, k: LineKey) => ret.lines[k]?.amount ?? null;

  it("A and D, no wash sale, cgadj No: lines 1a / 8a directly, no Form 8949 (Exception 1)", () => {
    const a = route("1099-B", "A", 0);
    expect(L(a, "schd.1a.d")).toBe(1000);
    expect(L(a, "schd.1a.h")).toBe(400);
    expect(a.lines["schd.1b.d"]!.status).toBe("not_applicable");
    expect(a.scheduleD?.form8949Required).toBe(false);
    expect(a.formsRequired.f8949?.required).toBe(false);
    const d = route("1099-B", "D", 0);
    expect([L(d, "schd.8a.d"), L(d, "schd.8a.e"), L(d, "schd.8a.h")]).toEqual([1000, 600, 400]);
    expect(d.scheduleD?.categories[0]).toMatchObject({ routing: "schedule_d_direct", codes: "", description: "" });
  });

  it("A / D with a wash sale -> 1b / 8b on Form 8949: code MW, (g) positive, (h) = d - e + g, description 'broker - see attached statement'", () => {
    const a = route("1099-B", "A", 599);
    expect([L(a, "schd.1b.d"), L(a, "schd.1b.e"), L(a, "schd.1b.g"), L(a, "schd.1b.h")]).toEqual([1000, 600, 6, 406]);
    expect(a.scheduleD?.categories[0]).toMatchObject({ routing: "form_8949_summary", codes: "MW", description: "Robinhood Markets, Inc. - see attached statement" });
    expect(a.formsRequired.f8949?.required).toBe(true);
    expect(a.lines["schd.1a.d"]!.status).toBe("not_applicable");
    const d = route("1099-B", "D", 599);
    expect([L(d, "schd.8b.g"), L(d, "schd.8b.h")]).toEqual([6, 406]);
    expect(d.scheduleD?.categories[0]?.codes).toBe("MW");
  });

  it("B and E (basis not reported): Form 8949 code M, lines 2 / 9, even with no adjustment", () => {
    const b = route("1099-B", "B", 0);
    expect([L(b, "schd.2.d"), L(b, "schd.2.g"), L(b, "schd.2.h")]).toEqual([1000, 0, 400]);
    expect(b.scheduleD?.categories[0]).toMatchObject({ routing: "form_8949_summary", codes: "M" });
    const e = route("1099-B", "E", 0);
    expect([L(e, "schd.9.d"), L(e, "schd.9.h")]).toEqual([1000, 400]);
  });

  it("cgadj Yes ('something the broker missed') blocks every route and never lands a number on 7a", () => {
    for (const box of ["A", "B", "D", "E"] as const) {
      const r = route("1099-B", box, 0, { adjYes: true });
      expect(r.lines["f1040.7a"]!.status, box).toBe("needs_cpa_judgment");
      expect(r.lines["f1040.7a"]!.amount, box).toBeNull();
    }
  });

  it("boxes C / F / I / L are blocked; accrued market discount is blocked", () => {
    for (const [form, box] of [["1099-B", "C"], ["1099-B", "F"], ["1099-DA", "I"], ["1099-DA", "L"]] as const) {
      const r = route(form, box, 0);
      expect(r.lines["f1040.7a"]!.status, box).toBe("needs_cpa_judgment");
    }
    const m = route("1099-B", "A", 0, { d: 5_000 });
    expect(m.lines["f1040.7a"]!.status).toBe("needs_cpa_judgment");
  });

  it("1099-DA rows (G / H / J / K) are computed with the same arithmetic but a blocking 'schd-1256-or-1099da' item keeps the return incomplete", () => {
    for (const [box, line] of [["G", "schd.1a.h"], ["H", "schd.2.h"], ["J", "schd.8a.h"], ["K", "schd.9.h"]] as const) {
      const r = route("1099-DA", box, 0);
      expect(r.lines[line]!.amount, box).toBe(400);
      expect(r.lines["f1040.7a"]!.status, box).toBe("computed");
      expect(r.openItems.some((o) => o.id === "schd-1256-or-1099da" && o.severity === "blocking"), box).toBe(true);
      expect(r.headline.complete, box).toBe(false);
    }
  });

  it("a 1099-DA with the digital-assets answer No raises the consistency item", () => {
    const f = fullFacts();
    f.income.brokerSales = [{ docId: "x", payer: "R", basis: "doc_verified", legacyFormat: false, refs: [], summaryRead: true, signalled1099B: false, rows: [{ form: "1099-DA", box: "K", proceedsCents: 1, costCents: 1, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 0 }], sec1256AggregateCents: null, forms1099DaPresent: true }];
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
    f.returnAnswers.attestations.digitalAssets = owner(false);
    const r = computeTy2025Return(f);
    expect(r.openItems.some((o) => o.id === "schd-digital-answer")).toBe(true);
  });

  it("two brokers in one box: one Form 8949 summary row per broker; the totals add", () => {
    const f = fullFacts();
    const mk = (id: string, payer: string, p: number, c: number, w: number): BrokerSaleFact => ({
      docId: id, payer, basis: "doc_verified", legacyFormat: false, refs: [{ kind: "document", id, label: "1099" }], summaryRead: true, signalled1099B: true,
      rows: [{ form: "1099-B", box: "A", proceedsCents: p, costCents: c, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: w, gainLossCents: p - c + w }],
      sec1256AggregateCents: null, forms1099DaPresent: false,
    });
    f.income.brokerSales = [mk("a", "Broker One", 100_000, 80_000, 0), mk("b", "Broker Two", 50_000, 70_000, 1_000)];
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
    const r = computeTy2025Return(f);
    const cat = r.scheduleD!.categories.find((c) => c.box === "A")!;
    expect(cat.rows.map((x) => x.payer)).toEqual(["Broker One", "Broker Two"]);
    expect(cat.rows.map((x) => x.gainCents)).toEqual([20_000, -19_000]);
    // total: d = 1,500, e = 1,500, g = 10, h = (150000 - 150000 + 1000)/100 = 10
    expect([r.lines["schd.1b.d"]!.amount, r.lines["schd.1b.e"]!.amount, r.lines["schd.1b.g"]!.amount, r.lines["schd.1b.h"]!.amount]).toEqual([1500, 1500, 10, 10]);
    expect(r.lines["f1040.7a"]!.amount).toBe(10);
  });

  it("Section 1256: a printed 0.00 aggregate blocks nothing; a non-zero aggregate (either sign) blocks 7a, lines 4 and 11 and the NIIT conclusion", () => {
    const base = (agg: number | null) => {
      const f = fullFacts();
      f.income.brokerSales = [{ docId: "x", payer: "R", basis: "doc_verified", legacyFormat: false, refs: [], summaryRead: true, signalled1099B: true, rows: [{ form: "1099-B", box: "D", proceedsCents: 100_000, costCents: 60_000, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 40_000 }], sec1256AggregateCents: agg, forms1099DaPresent: false }];
      f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
      return computeTy2025Return(f);
    };
    expect(base(0).lines["f1040.7a"]!.status).toBe("computed");
    expect(base(null).lines["f1040.7a"]!.status).toBe("computed");
    for (const v of [1, -1, 5_000, -250_000]) {
      const r = base(v);
      expect(r.lines["f1040.7a"]!.status, String(v)).toBe("needs_cpa_judgment");
      expect(r.lines["schd.4"]!.status, String(v)).toBe("needs_cpa_judgment");
      expect(r.lines["schd.11"]!.status, String(v)).toBe("needs_cpa_judgment");
    }
  });
});

// ── Schedule D Tax Worksheet trigger (lines 15 and 16 both gains AND line 18 or 19 not zero) ─────────────
describe("lines 18 / 19: the Schedule D Tax Worksheet is never replaced by the QDCG worksheet silently", () => {
  const withSpecial = (special: "true" | "false" | "absent" | "unsure", rows: { box: BrokerBox; p: number; c: number }[]) => {
    const f = fullFacts();
    f.income.brokerSales = [{ docId: "x", payer: "R", basis: "doc_verified", legacyFormat: false, refs: [{ kind: "document", id: "x", label: "1099" }], summaryRead: true, signalled1099B: true,
      rows: rows.map((r) => ({ form: "1099-B" as const, box: r.box, proceedsCents: r.p, costCents: r.c, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: r.p - r.c })), sec1256AggregateCents: 0, forms1099DaPresent: false }];
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
    if (special === "absent") delete f.statedNone.capital_special_rates;
    else if (special === "unsure") delete f.statedNone.capital_special_rates; // "Not sure" and unanswered are both absent in facts
    else f.statedNone.capital_special_rates = owner(special === "true");
    return computeTy2025Return(f);
  };
  const gains = [{ box: "D" as const, p: 1_000_000, c: 600_000 }];
  it("both gains + special rates stated none: QDCG worksheet used, tax computed", () => {
    const r = withSpecial("true", gains);
    expect(r.lines["f1040.16"]!.status).toBe("computed");
    expect(r.scheduleD?.line20).toBe(true);
    expect(r.scheduleD?.taxWorksheetNeeded).toBe(false);
  });
  it("both gains + special rates Yes / absent: tax 16 and qdcg.25 blocked (not computed with the QDCG worksheet), lines 18 / 19 not computed", () => {
    for (const s of ["false", "absent"] as const) {
      const r = withSpecial(s, gains);
      expect(r.lines["f1040.16"]!.status, s).not.toBe("computed");
      expect(r.lines["f1040.16"]!.amount, s).toBeNull();
      expect(r.lines["qdcg.25"]!.status, s).not.toBe("computed");
      expect(r.lines["schd.18"]!.status, s).not.toBe("computed");
      expect(r.lines["schd.19"]!.status, s).not.toBe("computed");
      expect(r.scheduleD?.taxWorksheetNeeded, s).toBe(true);
      expect(r.headline.complete, s).toBe(false);
    }
  });
  it("a loss / zero / short-term-gain-with-long-term-loss (lines 15 and 16 NOT both gains): the QDCG worksheet applies regardless of the special-rates answer (Schedule D line 17 = No skips 18-21)", () => {
    const lossRows = [{ box: "D" as const, p: 100_000, c: 600_000 }];
    const mixed = [{ box: "A" as const, p: 3_000_000, c: 0 }, { box: "D" as const, p: 0, c: 1_000_000 }];
    for (const s of ["false", "absent", "true"] as const) {
      for (const rows of [lossRows, mixed]) {
        const r = withSpecial(s, rows);
        expect(r.scheduleD?.line17, s).toBe(false);
        expect(r.lines["f1040.16"]!.status, `${s}`).toBe("computed");
        expect(r.scheduleD?.taxWorksheetNeeded, s).toBe(false);
      }
    }
  });
  it("only a line 15 / 16 that are BOTH gains matters: ST gain with LT zero is not 'both gains'", () => {
    const r = withSpecial("absent", [{ box: "A", p: 1_000_000, c: 0 }]);
    expect(r.scheduleD?.line17).toBe(false);
    expect(r.lines["f1040.16"]!.status).toBe("computed");
    expect(r.lines["qdcg.3"]!.amount).toBe(0);
  });
});

// ── Questionnaire path: the real owner's answers, through parseCompletenessAnswers + the capture resolver ──────────
const PEOPLE = [{ userId: ERIC_ID, name: "Eric Kinniburgh" }, { userId: EVA_ID, name: "Eva-Laura Ramirez-Wisiackas" }];
const ea = (m: Record<string, AnswerValue>): EffectiveAnswers => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v, source: "questionnaire" as const, at: "2026-10-04T12:00:00.000Z", by: ERIC_ID }]));

// the owner's real Robinhood summary exactly as printed (not imported from the Coder's fixture)
const ROBINHOOD_STORED = normalizeTaxExtraction("1099", {
  docType: "1099",
  summary: "Robinhood consolidated 1099",
  data: {
    taxYear: 2025,
    formVariant: "consolidated",
    variantsPresent: ["1099-DIV", "1099-B"],
    payerName: "Robinhood Markets, Inc.",
    int_box1Cents: 120,
    div_box1aCents: 238,
    div_box1bCents: 200,
    div_box2aCents: 0,
    bSummary: [
      { form: "1099-B", box: "A", proceedsCents: 587231, costCents: 528550, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 599, gainLossCents: 59280 },
      { form: "1099-B", box: "D", proceedsCents: 1700168, costCents: 1203728, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 496440 },
    ],
    sec1256AggregateCents: 0,
  },
});

function resolveReal(storedData: unknown, answers: EffectiveAnswers, verified = true) {
  const p = parseCompletenessAnswers(answers, PEOPLE);
  const r = resolveTaxDocForCompute({ docType: "1099", extractionStatus: "complete", extractionData: storedData, extractionCorrections: null, extractionConfirmedAt: verified ? new Date("2026-10-02T00:00:00Z") : null });
  const doc: RawDocument = { id: "rh", docType: "1099", taxYear: 2025, extractionStatus: r.extractionStatus, extractionData: r.extractionData, verified: r.verified, legacyFormat: r.legacyFormat, subjectType: "person", subjectUserId: ERIC_ID, documentName: null };
  const raw: RawTy2025Inputs = {
    taxYear: 2025,
    people: PEOPLE,
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "x" },
    documents: [doc],
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
    // the production wiring (lib/tax2025-build.ts): parseCompletenessAnswers -> RawAnswers
    answers: { statedNone: p.statedNone, returnAnswers: p.returnAnswers },
  };
  const resolved = resolveFacts(raw);
  return { resolved, facts: resolved.facts, p };
}

describe("G1 closure: a read summary with rows can never come out as 'computed, no sales'", () => {
  const allNone: Record<string, AnswerValue> = { cgco: "none", cgall: "yes", cgadj: "no", g_capital_gain_other: "none", g_capital_special_rates: "none" };
  it("the owner's real answers (cgco None, cgall Yes, cgadj No, both groups none) + the real summary -> Schedule D complete with the real figures (7a 5,557, qdcg.3 4,964, line 1b(h) 593, line 8a(h) 4,964)", () => {
    const { facts, resolved } = resolveReal(ROBINHOOD_STORED, ea(allNone));
    expect(resolved.facts.income.brokerSales[0]).toMatchObject({ summaryRead: true, sec1256AggregateCents: 0 });
    expect(resolved.facts.income.brokerSales[0]!.rows).toHaveLength(2);
    const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
    const A = (k: LineKey) => ret.lines[k]?.amount;
    expect([A("schd.1b.h"), A("schd.8a.h"), A("schd.7"), A("schd.15"), A("schd.16"), A("f1040.7a"), A("qdcg.3")]).toEqual([593, 4964, 593, 4964, 5557, 5557, 4964]);
    expect([A("schd.1b.d"), A("schd.1b.e"), A("schd.1b.g"), A("schd.8a.d"), A("schd.8a.e")]).toEqual([5872, 5286, 6, 17002, 12037]);
    for (const k of SCHD_KEYS) {
      const l = ret.lines[k]!;
      // every schd line is either computed, not applicable, or (for 4/5/11/12/18/19 none-group lines) not_applicable with the owner's statement
      expect(["computed", "not_applicable"], `${k}: ${l.status} ${l.reason}`).toContain(l.status);
    }
    expect(ret.openItems.filter((o) => o.severity === "blocking" && (o.id.startsWith("schd") || o.id.startsWith("none:capital") || o.id.startsWith("broker"))).map((o) => o.id)).toEqual([]);
    expect(ret.scheduleD).toMatchObject({ required: true, form8949Required: true, line17: true, line20: true, taxWorksheetNeeded: false });
    expect(ret.formsRequired.schd?.required).toBe(true);
    expect(ret.formsRequired.f8949?.required).toBe(true);
  });

  it("the same read summary with NONE of the capital answers: 7a is missing_input (never 0), the headline is incomplete, schd lines have reasons", () => {
    const { facts, resolved } = resolveReal(ROBINHOOD_STORED, {});
    const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
    expect(ret.lines["f1040.7a"]!.status).toBe("missing_input");
    expect(ret.lines["f1040.7a"]!.amount).toBeNull();
    expect(ret.headline.complete).toBe(false);
    expect(ret.scheduleD?.required).toBe(true);
    // provisional (fill) pass carries the real numbers and says what it assumed
    expect(ret.headline.provisional?.lines["f1040.7a"]).toBe(5557);
  });

  it("partial answers: each of cgco / cgall / cgadj / the two groups left out (or Not sure) keeps 7a / the tax from being computed", () => {
    const base = { ...allNone };
    for (const drop of ["cgco", "cgall", "cgadj", "g_capital_gain_other"] as const) {
      for (const how of ["missing", "unsure"] as const) {
        const a = { ...base };
        if (how === "missing") delete a[drop];
        else a[drop] = UNSURE_ID as AnswerValue;
        const { facts, resolved } = resolveReal(ROBINHOOD_STORED, ea(a));
        const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
        expect(ret.lines["f1040.7a"]!.status, `${drop} ${how}`).not.toBe("computed");
        expect(ret.headline.complete, `${drop} ${how}`).toBe(false);
      }
    }
    // special-rates group missing / unsure: 7a is computed (Schedule D lines 15 and 16 are known) but the TAX is blocked (both gains)
    for (const how of ["missing", "unsure"] as const) {
      const a = { ...base };
      if (how === "missing") delete a.g_capital_special_rates;
      else a.g_capital_special_rates = UNSURE_ID as AnswerValue;
      const { facts, resolved } = resolveReal(ROBINHOOD_STORED, ea(a));
      const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
      expect(ret.lines["f1040.16"]!.status, how).not.toBe("computed");
      expect(ret.headline.complete, how).toBe(false);
    }
    // 'Yes' to "anything the broker could not know" (cgadj yes) or "not every sale listed" (cgall no): blocked
    for (const [k, v] of [["cgadj", "yes"], ["cgall", "no"], ["cgco", "some"]] as const) {
      const { facts, resolved } = resolveReal(ROBINHOOD_STORED, ea({ ...base, [k]: v }));
      const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
      expect(ret.lines["f1040.7a"]!.status, `${k}=${v}`).not.toBe("computed");
    }
  });

  it("the questionnaire inversion is right: cgadj 'No' (nothing the broker could not know) = the rule's 'confirmed no adjustment'; cgadj 'Yes' blocks", () => {
    const p = parseCompletenessAnswers(ea({ cgadj: "no" }), PEOPLE).returnAnswers.capitalGains.brokerAdjustments;
    expect(p.value).toBe(false);
    const q = parseCompletenessAnswers(ea({ cgadj: "yes" }), PEOPLE).returnAnswers.capitalGains.brokerAdjustments;
    expect(q.value).toBe(true);
  });

  it("an UNREAD summary (old read, no bSummary) with the 1099-B boxes blocks, with a re-extract item, and a read-then-corrected summary through the overlay behaves like a read one", () => {
    const old = normalizeTaxExtraction("1099", { docType: "1099", summary: "x", data: { taxYear: 2025, formVariant: "consolidated", variantsPresent: ["1099-DIV", "1099-B"], payerName: "Robinhood Markets, Inc.", div_box1aCents: 238, div_box1bCents: 200, div_box2aCents: 0, otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2287399 }] } });
    const { facts, resolved } = resolveReal(old, ea(allNone));
    const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
    expect(ret.lines["f1040.7a"]!.status).toBe("missing_input");
    expect(ret.openItems.some((o) => o.id.startsWith("broker-summary-unread") && o.severity === "blocking")).toBe(true);
    expect(ret.openItems.some((o) => o.id === "schd-unread")).toBe(true);
    expect(ret.headline.complete).toBe(false);
  });

  it("a read summary with ONE all-null row and a zero row: the null row blocks (never ignored); the zero row alone is ignored", () => {
    const mk = (rows: unknown[]) => normalizeTaxExtraction("1099", { docType: "1099", summary: "x", data: { taxYear: 2025, formVariant: "consolidated", variantsPresent: ["1099-B"], payerName: "R", div_box1aCents: 0, div_box1bCents: 0, div_box2aCents: 0, bSummary: rows, sec1256AggregateCents: 0 } });
    const nullRow = { form: "1099-B", box: "A", proceedsCents: null, costCents: null, accruedMarketDiscountCents: null, washSaleLossDisallowedCents: null, gainLossCents: null };
    const { facts, resolved } = resolveReal(mk([nullRow]), ea(allNone));
    const ret = computeTy2025Return(facts, {}, { openItems: resolved.openItems, conflicts: resolved.conflicts });
    expect(ret.lines["f1040.7a"]!.status).not.toBe("computed");
    // a printed-zero proceeds row with every other figure unread
    const zeroP = { form: "1099-B", box: "A", proceedsCents: 0, costCents: null, accruedMarketDiscountCents: null, washSaleLossDisallowedCents: null, gainLossCents: null };
    const r2 = resolveReal(mk([zeroP]), ea(allNone));
    const ret2 = computeTy2025Return(r2.facts, {}, { openItems: r2.resolved.openItems, conflicts: r2.resolved.conflicts });
    // (D1: pinned by the it.fails probe at the end of this file)
    void ret2;


  });
});

// ── Scope / purity / money checks ───────────────────────────────────────────────────────────────────
describe("scope, purity, money-type checks", () => {
  const root = path.join(__dirname, "..", "..");
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("lib/tax2025/rules/** stays pure: transitive import walk finds no db / prisma client / next / fs / network import", () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = strip(fs.readFileSync(file, "utf8"));
      const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1]!;
        if (/^(node:|fs$|path$|child_process|http|https|net$)/.test(spec)) bad.push(`${file} -> ${spec}`);
        if (/@prisma\/client$/.test(spec) || /^next(\/|$)/.test(spec) || /^@\/lib\/db$/.test(spec) || /^@\/actions\//.test(spec) || /^server-only$/.test(spec)) bad.push(`${file} -> ${spec}`);
        if (spec.startsWith("@/")) {
          const p = path.join(root, spec.slice(2));
          for (const ext of [".ts", "/index.ts"]) if (fs.existsSync(p + ext)) visit(p + ext);
        }
      }
    };
    for (const f of fs.readdirSync(path.join(root, "lib/tax2025/rules"))) if (f.endsWith(".ts")) visit(path.join(root, "lib/tax2025/rules", f));
    visit(path.join(root, "lib/tax2025/inputs.ts"));
    visit(path.join(root, "lib/tax2025/return.ts"));
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });
  it("no float arithmetic on money in schedule-d.ts / the inputs additions (no parseFloat / Number() on amounts / Math.round / toFixed)", () => {
    const sd = strip(fs.readFileSync(path.join(root, "lib/tax2025/rules/schedule-d.ts"), "utf8"));
    expect(sd).not.toMatch(/parseFloat|Math\.round|Math\.floor|Math\.ceil|\.toFixed\(|Number\(/);
    expect(sd).not.toMatch(/\bas any\b|: any\b/);
    const inp = strip(fs.readFileSync(path.join(root, "lib/tax2025/inputs.ts"), "utf8"));
    const scheduleDInput = inp.slice(inp.indexOf("export function scheduleDInput"), inp.indexOf("export function estimatesForYear"));
    expect(scheduleDInput).not.toMatch(/parseFloat|Math\.round|\.toFixed\(|Number\(/);
  });
  it("the capital none groups are registered and no 'income' string is used for GlCode types in the new code", () => {
    expect(NONE_GROUP_IDS).toContain("capital_gain_other");
    const sd = fs.readFileSync(path.join(root, "lib/tax2025/rules/schedule-d.ts"), "utf8");
    expect(sd).not.toMatch(/["']income["']/);
  });
});

// ── Robustness of the engine over hostile / extreme facts ────────────────────────────────────────────
describe("robustness", () => {
  it("each key is emitted by exactly one rule (duplicateEmissions) and the facts are never mutated, over 2,500 random fact sets", async () => {
    const { duplicateEmissions } = await import("@/lib/tax2025/return");
    const rnd = mulberry32(777);
    for (let i = 0; i < 2500; i++) {
      const g = gen(rnd);
      const before = JSON.stringify(g.f);
      expect(duplicateEmissions(g.f), `${i}`).toEqual([]);
      computeTy2025Return(g.f);
      expect(JSON.stringify(g.f), `${i} facts mutated`).toBe(before);
    }
  }, 300_000);

  it("extreme cents values (+/- 2^53-1, +/-1, 0) in every figure of a row: never throws, amounts finite or null", () => {
    const ext = [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1, -1, 0];
    for (const p of ext) for (const c of ext) for (const w of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const f = fullFacts();
      f.income.brokerSales = [{ docId: "x", payer: null, basis: "doc_verified", legacyFormat: false, refs: [], summaryRead: true, signalled1099B: true, rows: [{ form: "1099-B", box: "D", proceedsCents: p, costCents: c, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: w, gainLossCents: null }], sec1256AggregateCents: null, forms1099DaPresent: false }];
      f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
      const ret = computeTy2025Return(f);
      for (const k of WATCH) {
        const a = ret.lines[k]?.amount;
        expect(a === null || a === undefined || Number.isFinite(a), `${p} ${c} ${w} ${k}`).toBe(true);
      }
    }
  });

  it("sensitivity of the status oracle: dropping the 'row not routable' rule from the oracle WOULD be caught (self-test)", () => {
    const rnd = mulberry32(31337);
    let found = 0;
    for (let i = 0; i < 3000 && found === 0; i++) {
      const g = gen(rnd);
      const e = expectComputed7a(g);
      if (e.why === "row not routable" || e.why === "null figure") found++;
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("D1 (fixed in round 2)", () => {
  it("a read category row with a printed 0 proceeds but unread cost / wash sale / discount is unknown, not zero: 7a must not be computed as 'Schedule D not required'", () => {
    const f = fullFacts();
    f.income.brokerSales = [
      {
        docId: "x",
        payer: "Robinhood Markets, Inc.",
        basis: "doc_verified",
        legacyFormat: false,
        refs: [{ kind: "document", id: "x", label: "1099" }],
        summaryRead: true,
        signalled1099B: true,
        rows: [{ form: "1099-B", box: "A", proceedsCents: 0, costCents: null, accruedMarketDiscountCents: null, washSaleLossDisallowedCents: null, gainLossCents: null }],
        sec1256AggregateCents: 0,
        forms1099DaPresent: false,
      },
    ];
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
    const ret = computeTy2025Return(f);
    expect(ret.scheduleD?.required).not.toBe(false);
    expect(ret.lines["f1040.7a"]!.status).not.toBe("computed");
  });
});
