// Engine ty2025-1b.7, task model-unmodeled-lines: the 21 "printed money lines the app does not model" of the Final review page.
// Every one is an explicit decision now (reserved / calendar-year header = form_na, an entry an owner statement rules out =
// owner_statement_na, a type / code / memo entry beside a zero line = zero_line_entry with `follows`), with a safety net for a
// followed line that ever carries an amount. Also pinned here: Schedule 1 line 24z and Schedule 3 line 6z ("Leave blank"),
// the Form 1040 line 16 gate on the other_taxes statement, and the ratchet "0 unmapped printed money lines on every form".
import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import { buildGapReport } from "@/lib/tax2025-pdf-gap";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { checkCompleteness } from "@/lib/tax2025/pdf/completeness";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { entriesNeedingHand } from "@/lib/tax2025/pdf/hand-entries";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { sch1Map } from "@/lib/tax2025/pdf/maps/sch1";
import { sch1aMap } from "@/lib/tax2025/pdf/maps/sch1a";
import { sch2Map } from "@/lib/tax2025/pdf/maps/sch2";
import { sch3Map } from "@/lib/tax2025/pdf/maps/sch3";
import { schAMap } from "@/lib/tax2025/pdf/maps/schA";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";
import { fillPacketForms } from "@/lib/tax2025/pdf/packet";
import { BLANK_REASON_LABELS, type FormMap, type LineRef, type PdfReturnView } from "@/lib/tax2025/pdf/types";
import { NONE_GROUP_TEXT, lineMeta, LINE_CATALOG, type LineKey } from "@/lib/tax2025/line-catalog";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import { applyOverrides } from "@/lib/tax2025/overrides";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { FOOTING_RULES } from "@/lib/tax-review/l1/footing-rules";
import { oracleLedger, runL2, type L2Input } from "@/lib/tax-review/l2";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { QUESTIONNAIRES } from "@/lib/tax-questionnaire-content";
import { emptyFacts, fullFacts, fullFacts1b, owner } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, loadCatalog } from "./tax2025-pdf-harness";
import { cleanScenario } from "./tax-review-harness";
import { coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const OPTS = { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Model Test" } as const;
const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };

function viewOf(facts: ReturnType<typeof fullFacts>): PdfReturnView {
  return toPdfReturnView(computeTy2025Return(facts), facts, OPTS);
}

const MAPS_OF_THE_TASK: readonly FormMap[] = [f1040Map, sch1Map, sch2Map, sch3Map, schAMap, sch1aMap, schBMap];
const catalogs = Object.fromEntries(FORM_MAPS.map((m) => [m.formId, loadCatalog(m.formId)]));

describe("engine version", () => {
  it("is ty2025-1b.7", () => {
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.7");
  });
});

describe("ratchet: no printed money line is left unexplained on any form", () => {
  for (const [name, facts] of [["full facts", fullFacts()], ["Phase 1b facts", fullFacts1b()], ["empty facts", emptyFacts()]] as const) {
    it(`the gap report lists 0 unmapped printed money lines on every form (${name})`, () => {
      const gaps = buildGapReport(viewOf(facts), FORM_MAPS, catalogs);
      expect(gaps.map((g) => `${g.formId}:${g.unmappedMoneyLines.length}`).filter((s) => !s.endsWith(":0"))).toEqual([]);
    });
  }
  it("every map still claims every field of its form exactly once (unknown / duplicated / unclaimed all empty)", () => {
    for (const map of MAPS_OF_THE_TASK) {
      const names = catalogs[map.formId]?.fields.map((f) => f.name) ?? [];
      expect(names.length, map.formId).toBeGreaterThan(0);
      expect(checkCompleteness(map, names), map.formId).toEqual({ unknown: [], duplicated: [], unclaimed: [] });
    }
  });
});

/** The fields the task decided, per form: field short name -> reason (and what the entry follows). */
const DECISIONS: ReadonlyArray<{ map: FormMap; reason: string; fields: string[]; follows?: string[] }> = [
  { map: f1040Map, reason: "form_na", fields: ["Page1[0].f1_01[0]", "Page1[0].f1_02[0]", "Page1[0].f1_03[0]"] },
  { map: f1040Map, reason: "zero_line_entry", fields: ["Page1[0].f1_54[0]"], follows: ["f1040.1h"] },
  { map: f1040Map, reason: "zero_line_entry", fields: ["Page1[0].f1_64[0]", "Page1[0].c1_35[0]", "Page1[0].c1_36[0]", "Page1[0].c1_37[0]"], follows: ["f1040.4a", "f1040.4b"] },
  { map: f1040Map, reason: "zero_line_entry", fields: ["Page1[0].f1_67[0]", "Page1[0].c1_38[0]", "Page1[0].c1_39[0]", "Page1[0].c1_40[0]"], follows: ["f1040.5a", "f1040.5b"] },
  { map: f1040Map, reason: "owner_statement_na", fields: ["Page2[0].f2_07[0]", "Page2[0].c2_9[0]", "Page2[0].c2_10[0]", "Page2[0].c2_11[0]"] },
  { map: sch1Map, reason: "zero_line_entry", fields: ["Page1[0].Line7_ReadOrder[0].f1_11[0]", "Page1[0].Line7_ReadOrder[0].c1_3[0]"], follows: ["sch1.7"] },
  { map: sch1Map, reason: "zero_line_entry", fields: ["Page1[0].Line8z_ReadOrder[0].f1_35[0]"], follows: ["sch1.8z"] },
  { map: sch1Map, reason: "form_na", fields: ["Page2[0].f2_14[0]", "Page2[0].Line24z_ReadOrder[0].f2_27[0]"] },
  { map: sch1Map, reason: "owner_statement_na", fields: ["Page1[0].f1_03[0]"] },
  { map: sch1Map, reason: "zero_line_entry", fields: ["Page1[0].f1_06[0]"], follows: ["sch1.2a"] },
  { map: sch1Map, reason: "zero_line_entry", fields: ["Page2[0].f2_11[0]"], follows: ["sch1.19a"] },
  { map: sch2Map, reason: "zero_line_entry", fields: ["Page1[0].f1_09[0]"], follows: ["sch2.1y"] },
  { map: sch2Map, reason: "owner_statement_na", fields: ["Page1[0].Line4_ReadOrder[0].f1_14[0]", "Page1[0].Line4_ReadOrder[0].c1_3[0]", "Page1[0].Line4_ReadOrder[0].c1_4[0]", "Page1[0].Line4_ReadOrder[0].c1_5[0]"] },
  { map: sch2Map, reason: "form_na", fields: ["Page1[0].f1_21[0]"] },
  { map: sch2Map, reason: "zero_line_entry", fields: ["Page2[0].Line17z_ReadOrder[0].f2_19[0]"], follows: ["sch2.17z"] },
  { map: sch2Map, reason: "zero_line_entry", fields: ["Page2[0].Line17a_ReadOrder[0].Line17_ReadOrder[0].f2_01[0]"], follows: ["sch2.17a"] },
  { map: sch3Map, reason: "form_na", fields: ["Page1[0].f1_13[0]", "Page1[0].Line6z_ReadOrder[0].f2_22[0]"] },
  { map: sch3Map, reason: "zero_line_entry", fields: ["Page1[0].Line13z_ReadOrder[0].f1_34[0]"], follows: ["sch3.13z"] },
  { map: schAMap, reason: "zero_line_entry", fields: ["Page1[0].f1_12[0]"], follows: ["scha.6"] },
  { map: schAMap, reason: "zero_line_entry", fields: ["Page1[0].Line8b_ReadOrder[0].f1_16[0]"], follows: ["scha.8b"] },
  { map: schAMap, reason: "form_na", fields: ["Page1[0].f1_19[0]"] },
  { map: schAMap, reason: "zero_line_entry", fields: ["Page1[0].f1_28[0]"], follows: ["scha.16"] },
  { map: sch1aMap, reason: "zero_line_entry", fields: ["Table_Line22[0].Line22a[0].VIN-1_Comb[0].f2_01[0]", "Table_Line22[0].Line22a[0].f2_02[0]", "Table_Line22[0].Line22a[0].f2_03[0]", "Table_Line22[0].Line22b[0].VIN-2_Comb[0].f2_04[0]", "Table_Line22[0].Line22b[0].f2_05[0]", "Table_Line22[0].Line22b[0].f2_06[0]"], follows: ["sch1a.23"] },
  { map: schBMap, reason: "owner_statement_na", fields: ["Page1[0].f1_65[0]", "Page1[0].f1_66[0]"] },
];

describe("every decided field is claimed with the decided reason (and the entries carry a note and a follows)", () => {
  for (const d of DECISIONS) {
    it(`${d.map.formId}: ${d.fields.length} field(s) -> ${d.reason}${d.follows ? ` following ${d.follows.join(", ")}` : ""}`, () => {
      for (const short of d.fields) {
        const depth = short.split(".").length;
        const blanks = d.map.blank.filter((b) => "field" in b && b.field.split(".").slice(-depth).join(".") === short);
        expect(blanks.length, `${short} must be claimed exactly once by a blank entry`).toBe(1);
        const b = blanks[0];
        expect(b?.reason, short).toBe(d.reason);
        if (d.reason === "zero_line_entry" || d.reason === "owner_statement_na") expect(b?.note, `${short} carries a note`).toBeTruthy();
        if (d.reason === "zero_line_entry") expect([...(b?.follows ?? [])], short).toEqual(d.follows);
      }
    });
  }
  it("no entry of a decided reason is claimed as not_modeled any more (the 21 B5 lines and the 25 fields)", () => {
    const ids = new Set(DECISIONS.flatMap((d) => d.fields.map((s) => `${d.map.formId}|${s}`)));
    expect(ids.size).toBeGreaterThanOrEqual(25);
    for (const d of DECISIONS) {
      for (const b of d.map.blank) {
        if (!("field" in b) || b.reason !== "not_modeled") continue;
        const tail = b.field.split(".").slice(-2).join(".");
        expect(ids.has(`${d.map.formId}|${tail}`), `${d.map.formId} ${tail} is decided but still not_modeled`).toBe(false);
      }
    }
  });
});

describe("zero_line_entry shape", () => {
  const entries = FORM_MAPS.flatMap((m) => m.blank.filter((b) => b.reason === "zero_line_entry").map((b) => ({ formId: m.formId, b })));
  it("exists on the seven forms of the task, each with a plain-language note and a real amount line to follow", () => {
    expect(new Set(entries.map((e) => e.formId))).toEqual(new Set(["f1040", "f1040s1", "f1040s2", "f1040s3", "f1040sa", "f1040s1a"]));
    for (const { formId, b } of entries) {
      expect(b.note, formId).toBeTruthy();
      expect(b.follows?.length ?? 0, `${formId} follows`).toBeGreaterThan(0);
      for (const k of b.follows ?? []) expect(() => lineMeta(k as LineKey), `${formId} follows a real engine line (${k})`).not.toThrow();
    }
  });
  it("every followed amount line is added up by a footing rule (or is the gross figure beside its taxable twin)", () => {
    const inRule = new Set<string>(FOOTING_RULES.flatMap((r) => [r.total, ...r.parts.map((p) => p.key)]));
    const followed = new Set(entries.flatMap((e) => [...(e.b.follows ?? [])]));
    // 4a / 5a are the gross amounts printed beside the taxable 4b / 5b (the part that is added into total income); sch1a.23 is the total of
    // the Part IV rows of line 22 (the form does not add it into another printed line the review foots)
    const gross = new Set<string>(["f1040.4a", "f1040.5a", "sch1a.23"]);
    const notFooted = [...followed].filter((k) => !inRule.has(k) && !gross.has(k));
    expect(notFooted).toEqual([]);
  });
  it("the label says the entries are written by hand only if the line applies", () => {
    expect(BLANK_REASON_LABELS.zero_line_entry).toMatch(/written by hand only if the line applies/);
  });
  it("the notes of every new decision are plain language: no CPA, no 'approved', no 'final'", () => {
    const notes = MAPS_OF_THE_TASK.flatMap((m) => m.blank.flatMap((b) => (b.note === undefined ? [] : [b.note])));
    expect(notes.length).toBeGreaterThan(20);
    for (const n of notes) expect(findOwnerBannedWording(n), n).toEqual([]);
    for (const n of notes) expect(n, n).not.toMatch(/\bCPA\b/);
  });
});

describe("hand entries: a followed line that carries an amount raises a note, a zero line raises nothing", () => {
  it("Eric-shaped facts: no entry needs a hand", () => {
    const view = viewOf(fullFacts());
    for (const map of MAPS_OF_THE_TASK) expect(entriesNeedingHand(map, view), map.formId).toEqual([]);
  });
  it("an overridden or computed non-zero amount, or an owner Yes, needs the entry; zero / not applicable / blocked-without-answer do not", () => {
    const base = coreView();
    const non0 = coreView({ lines: withLine(base.lines, "sch1.8z", { status: "overridden", amount: 500 }) });
    const hit = entriesNeedingHand(sch1Map, non0);
    expect(hit).toHaveLength(1);
    expect(hit[0]?.lines.map((l) => `${l.key}:${l.why}:${l.amount}`)).toEqual(["sch1.8z:amount:500"]);
    expect(hit[0]?.note).toContain("line 8z");
    const yes = coreView({ lines: withLine(base.lines, "sch1.8z", { status: "needs_cpa_judgment", amount: null, reason: "owner answered Yes" }) });
    expect(entriesNeedingHand(sch1Map, yes)[0]?.lines[0]?.why).toBe("needs_answer");
    for (const status of ["not_applicable", "computed"] as const) {
      const zero = coreView({ lines: withLine(base.lines, "sch1.8z", { status, amount: 0 }) });
      expect(entriesNeedingHand(sch1Map, zero), status).toEqual([]);
    }
    for (const status of ["missing_input", "not_yet_computed"] as const) {
      const blocked = coreView({ lines: withLine(base.lines, "sch1.8z", { status, amount: null, reason: "x" }) });
      expect(entriesNeedingHand(sch1Map, blocked), status).toEqual([]);
    }
  });
  it("a followed key that is absent from the view does not throw and raises nothing", () => {
    const view = coreView();
    const rest = { ...view.lines };
    delete rest["sch1.8z"];
    expect(entriesNeedingHand(sch1Map, { ...view, lines: rest })).toEqual([]);
  });
  it("entries that share one note are ONE item (line 4c boxes and code follow two lines)", () => {
    const base = coreView();
    const lines = withLine(withLine(base.lines, "f1040.4a", { amount: 1000 }), "f1040.4b", { amount: 1000 });
    const hit = entriesNeedingHand(f1040Map, coreView({ lines }));
    expect(hit).toHaveLength(1);
    expect(hit[0]?.fields).toHaveLength(4);
    expect(hit[0]?.lines.map((l) => l.key)).toEqual(["f1040.4a", "f1040.4b"]);
  });
  it("a `follows` on a regex (match) blank works too", () => {
    const map: FormMap = { ...sch1Map, blank: [{ match: /Line8z_ReadOrder/, reason: "zero_line_entry", note: "line 8z words", follows: ["sch1.8z"] }] };
    const view = coreView({ lines: withLine(coreView().lines, "sch1.8z", { status: "overridden", amount: 5 }) });
    expect(entriesNeedingHand(map, view)[0]?.fields[0]).toMatch(/^match:/);
  });
  it("an entry without a note or without follows is ignored (the shape test above forbids it on the real maps)", () => {
    const map: FormMap = { ...sch1Map, blank: [{ field: "x", reason: "zero_line_entry", follows: ["sch1.8z" as LineRef] }] };
    const view = coreView({ lines: withLine(coreView().lines, "sch1.8z", { status: "overridden", amount: 5 }) });
    expect(entriesNeedingHand(map, view)).toEqual([]);
  });
});

describe("fill: an override-supplied amount beside a blank entry is an advisory item on the packet", () => {
  it("override 8z = $500: one advisory item on Schedule 1 and its note on the cover model; a zero line: none", async () => {
    const supplied = coreView({ lines: withLine(coreView().lines, "sch1.8z", { status: "overridden", amount: 500 }) });
    const filled = await fillForm("f1040s1", supplied, sch1Map, NO_STAMP);
    const items = filled.openItems.filter((i) => i.id.startsWith("fill:f1040s1:entry:"));
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("advisory");
    expect(items[0]?.source).toBe("fill");
    expect(items[0]?.message).toContain("line 8z");
    expect(items[0]?.message).toContain("attach a statement");
    expect(items[0]?.message).not.toMatch(/\bCPA\b/);
    const none = await fillForm("f1040s1", coreView(), sch1Map, NO_STAMP);
    expect(none.openItems.filter((i) => i.id.startsWith("fill:f1040s1:entry:"))).toEqual([]);
  });
  it("the packet carries the item and the cover lists the entry's note once per form and group", async () => {
    const supplied = coreView({ lines: withLine(coreView().lines, "sch1.8z", { status: "overridden", amount: 500 }) });
    const res = await fillPacketForms(supplied, { maps: [sch1Map, f1040Map], stamp: false, final: false, folder: "" });
    expect(res.openItems.some((i) => i.id.startsWith("fill:f1040s1:entry:"))).toBe(true);
    const form = res.forms.find((f) => f.formId === "f1040s1");
    expect(form?.blankNotes?.filter((n) => n.includes("line 8z"))).toHaveLength(1);
    expect(form?.blankByDesign.zero_line_entry).toBeGreaterThan(0);
  });
});

describe("Schedule 1 line 24z and Schedule 3 line 6z: the instructions say leave them blank", () => {
  it("both are in no none-group", () => {
    expect(LINE_CATALOG.find((m) => m.key === "sch1.24z")?.group).toBeUndefined();
    expect(LINE_CATALOG.find((m) => m.key === "sch3.6z")?.group).toBeUndefined();
  });
  it("both are fixed not_applicable zeros whatever the owner states, with the instruction as the reason", () => {
    for (const stated of [true, false, undefined] as const) {
      const f = fullFacts();
      if (stated === undefined) {
        delete (f.statedNone as Record<string, unknown>).other_adjustments;
        delete (f.statedNone as Record<string, unknown>).other_nonrefundable_credits;
      } else {
        f.statedNone.other_adjustments = owner(stated);
        f.statedNone.other_nonrefundable_credits = owner(stated);
      }
      const ret = computeTy2025Return(f);
      for (const key of ["sch1.24z", "sch3.6z"] as const) {
        expect(ret.lines[key]?.status, `${key} stated=${String(stated)}`).toBe("not_applicable");
        expect(ret.lines[key]?.amount).toBe(0);
        expect(ret.lines[key]?.reason).toMatch(/leave .* blank/i);
      }
    }
  });
  it("other_adjustments answered Yes flags the other adjustment lines but not 24z", () => {
    const f = fullFacts();
    f.statedNone.other_adjustments = owner(false);
    const ret = computeTy2025Return(f);
    expect(ret.lines["sch1.24a"]?.status).toBe("needs_cpa_judgment");
    expect(ret.lines["sch1.24z"]?.status).toBe("not_applicable");
  });
});

describe("Form 1040 line 16 is gated on the other_taxes statement (the Schedule D / QDCG tax path included)", () => {
  it("stated none: line 16 computes as before", () => {
    const ret = computeTy2025Return(fullFacts());
    expect(ret.lines["f1040.16"]?.status).toBe("computed");
  });
  it("answered Yes: line 16 needs the owner (needs_cpa_judgment) and the totals that use it are blocked", () => {
    const f = fullFacts();
    f.statedNone.other_taxes = owner(false);
    const ret = computeTy2025Return(f);
    expect(ret.lines["f1040.16"]?.status).toBe("needs_cpa_judgment");
    expect(ret.lines["f1040.16"]?.amount).toBeNull();
    expect(ret.lines["f1040.18"]?.amount ?? null).toBeNull();
    expect(ret.lines["f1040.24"]?.amount ?? null).toBeNull();
  });
  it("unstated: line 16 is not yet computed (never a silent figure)", () => {
    const f = fullFacts();
    delete (f.statedNone as Record<string, unknown>).other_taxes;
    const ret = computeTy2025Return(f);
    expect(ret.lines["f1040.16"]?.status).toBe("not_yet_computed");
    expect(ret.lines["f1040.16"]?.amount).toBeNull();
  });
  it("the provisional estimate does not gate it (an unstated group is assumed none there)", () => {
    const f = fullFacts();
    delete (f.statedNone as Record<string, unknown>).other_taxes;
    const ret = computeTy2025Return(f);
    expect(ret.headline.provisional?.totalTax ?? null).not.toBeNull();
  });
  it("a return that uses the Qualified Dividends and Capital Gain Tax Worksheet is gated the same way (line 16 comes from rule tax-calc)", () => {
    const f = fullFacts1b();
    const open = computeTy2025Return(f);
    const l16 = open.lines["f1040.16"];
    expect(l16?.ruleId).toBe("tax-calc");
    const gated = fullFacts1b();
    gated.statedNone.other_taxes = owner(false);
    expect(computeTy2025Return(gated).lines["f1040.16"]?.status).toBe("needs_cpa_judgment");
  });
  it("the Eric-shaped numbers do not change with the rest of the 1b.7 work", () => {
    const f = fullFacts();
    const a = computeTy2025Return(f);
    expect(a.lines["f1040.16"]?.amount).not.toBeNull();
    expect(a.lines["f1040.24"]?.status).toBe("computed");
  });
});

describe("the three widened statements name what the IRS puts in the type / code boxes (saved answers keep working)", () => {
  it("NONE_GROUP_TEXT carries the new words", () => {
    expect(NONE_GROUP_TEXT.other_earned_income).toMatch(/excess retirement plan deferrals/);
    expect(NONE_GROUP_TEXT.other_earned_income).toMatch(/strike or lockout/);
    expect(NONE_GROUP_TEXT.other_taxes).toMatch(/education credit/);
    expect(NONE_GROUP_TEXT.other_taxes).toMatch(/section 962/);
    expect(NONE_GROUP_TEXT.se_other).toMatch(/Form 4361/);
    expect(NONE_GROUP_TEXT.se_other).toMatch(/notary/);
    expect(NONE_GROUP_TEXT.other_income).toMatch(/1099-K/);
  });
  it("the questionnaire prompts name them in plain language, and the Return completeness version did not move", () => {
    const rc = QUESTIONNAIRES.find((q) => q.title === "Return completeness");
    expect(rc).toBeDefined();
    const text = JSON.stringify(rc);
    expect(text).toMatch(/excess deferrals/);
    expect(text).toMatch(/paying back an education credit/);
    expect(text).toMatch(/exemption from self-employment tax/);
    expect(text).toMatch(/Form 1099-K that were reported in error/);
    expect(rc?.version).toBe(2);
    // the widened prompts (and every other string of the questionnaire) carry no banned wording
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(rc);
    for (const t of strings) expect(findOwnerBannedWording(t), t.slice(0, 120)).toEqual([]);
    for (const s of [NONE_GROUP_TEXT.other_earned_income, NONE_GROUP_TEXT.other_taxes, NONE_GROUP_TEXT.se_other, NONE_GROUP_TEXT.other_income]) {
      expect(findOwnerBannedWording(s), s).toEqual([]);
    }
  });
});

describe("L2: Schedule 1 line 24z and Schedule 3 line 6z are independent zeros (the instruction, not the owner's statement)", () => {
  const inputOf = (facts: L2Input["facts"]): L2Input => {
    const ret = computeTy2025Return(facts);
    return { ret, effective: applyOverrides(ret, []), facts };
  };
  it("the oracle states 0 itself, with or without the owner's statement", () => {
    for (const stated of [true, false]) {
      const facts = structuredClone(cleanScenario().facts);
      facts.statedNone.other_adjustments = owner(stated);
      facts.statedNone.other_nonrefundable_credits = owner(stated);
      const ledger = oracleLedger(inputOf(facts));
      for (const key of ["sch1.24z", "sch3.6z"]) {
        const line = ledger.lines.get(key);
        expect(line?.source, key).toBe("oracle");
        expect(line?.value, key).toBe(0);
      }
    }
  });
  it("an engine amount on either line is a mismatch (it was an unchecked input before)", () => {
    for (const key of ["sch1.24z", "sch3.6z"] as const) {
      const input = inputOf(structuredClone(cleanScenario().facts));
      const line = input.ret.lines[key];
      if (line === undefined) throw new Error(`no ${key}`);
      const ret: Ty2025Return = { ...input.ret, lines: { ...input.ret.lines, [key]: { ...line, status: "computed", amount: 40 } } };
      const r = runL2({ ...input, ret, effective: applyOverrides(ret, []) });
      expect(r.findings.filter((f) => f.check !== "L2.coverage").length, key).toBeGreaterThan(0);
    }
  });
});
