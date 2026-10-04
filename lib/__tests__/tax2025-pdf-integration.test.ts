// T9 integration of the PDF layer with the real engine (adapter -> policy -> maps -> packet), run on the
// golden synthetic fixture (tax2025-fixtures.ts). Covers:
//   - the engine's formsRequired verdict decides inclusion (Schedule A is omitted when the standard
//     deduction wins; maps tester D2), with the line-based rule only as a fallback;
//   - the CT Schedule 3 property-tax table, the EKC trade name on Form 8995, the Schedule B Part III answers;
//   - the 1040 line 12d age/blind boxes (required answers) and the boxes listed on the cover (maps tester P1);
//   - Schedule C Part V with a non-zero line 48 and no rows (maps tester D3).
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { ctPropertyTaxRows } from "@/lib/tax2025/pdf/ct-property-tax";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { f8995Map } from "@/lib/tax2025/pdf/maps/f8995";
import { schAMap } from "@/lib/tax2025/pdf/maps/schA";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts, gl } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";

const OPTS = { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" } as const;

function build(facts: Ty2025Facts = fullFacts(), extra: Partial<Parameters<typeof toPdfReturnView>[2]> = {}) {
  const ret = computeTy2025Return(facts);
  const view = toPdfReturnView(ret, facts, { ...OPTS, ...extra });
  return { facts, ret, view };
}

function itemizingFacts(): Ty2025Facts {
  const f = fullFacts();
  const m = f.deductions.mortgages[0];
  if (!m) throw new Error("fixture has no mortgage");
  m.interestCents = 3_000_000;
  m.principalCents = 40_000_000;
  return f;
}

describe("the engine's formsRequired verdict decides the packet (maps tester D2)", () => {
  it("copies ret.formsRequired into the view as plain data, entry for entry", () => {
    const { ret, view } = build();
    expect(view.formsRequired).toBeDefined();
    expect(Object.keys(view.formsRequired ?? {}).sort()).toEqual(Object.keys(ret.formsRequired).sort());
    for (const [id, v] of Object.entries(ret.formsRequired)) {
      expect(view.formsRequired?.[id]).toEqual({ required: v.required, reason: v.reason });
    }
    expect(JSON.parse(JSON.stringify(view.formsRequired))).toEqual(view.formsRequired);
  });

  it("every map except the 1040 names an engine form id the engine actually reports", () => {
    const { view } = build();
    for (const map of FORM_MAPS) {
      if (map.formId === "f1040") continue;
      expect(map.engineFormId, `${map.formId} has an engineFormId`).toBeDefined();
      expect(view.formsRequired?.[map.engineFormId ?? ""], `${map.formId} -> ${map.engineFormId} is in formsRequired`).toBeDefined();
    }
    // no two maps share an engine form id
    const ids = FORM_MAPS.map((m) => m.engineFormId).filter((x): x is NonNullable<typeof x> => x !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("golden fixture: the standard deduction wins, so Schedule A is OMITTED (the line rule alone would include it)", async () => {
    const { ret, view } = build();
    expect(ret.formsRequired.scha).toMatchObject({ required: false, reason: "The standard deduction is larger." });
    expect(ret.lines["f1040.12e"]?.amount).toBe(31500);
    const inc = formInclusion(schAMap, view);
    expect(inc.include).toBe(false);
    expect(inc.reason).toContain("The standard deduction is larger.");
    // the pre-fix behaviour: without the verdict the line-based rule includes it (Sch A line 2 is a copy of 1040 11b)
    const { formsRequired: _dropped, ...withoutVerdict } = view;
    void _dropped;
    expect(formInclusion(schAMap, withoutVerdict as PdfReturnView).include).toBe(true);

    const packet = await buildPacket(view, { maps: FORM_MAPS });
    expect(packet.files.some((f) => f.formId === "f1040sa")).toBe(false);
    const sa = packet.forms.find((f) => f.formId === "f1040sa");
    expect(sa).toMatchObject({ included: false });
    expect(sa?.reason).toContain("The standard deduction is larger.");
    const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: [], stamp: true });
    expect(model.blocks.some((b) => b.kind === "bullet" && b.text.includes("(f1040sa) - omitted"))).toBe(true);
  });

  it("itemizing variant: itemized deductions exceed the standard deduction, so Schedule A IS included", async () => {
    const { ret, view } = build(itemizingFacts());
    expect(ret.formsRequired.scha?.required).toBe(true);
    expect(formInclusion(schAMap, view).include).toBe(true);
    const packet = await buildPacket(view, { maps: [f1040Map, schAMap] });
    expect(packet.files.some((f) => f.formId === "f1040sa")).toBe(true);
  });

  it("a view without a verdict falls back to the line-based rule; 'blocking' includes the form", () => {
    const { view } = build();
    const noVerdict: PdfReturnView = { ...view };
    delete noVerdict.formsRequired;
    expect(formInclusion(f8995Map, noVerdict).include).toBe(true); // 8995 line 15 is non-zero
    const blocking: PdfReturnView = { ...view, formsRequired: { scha: { required: "blocking", reason: "not decided" } } };
    expect(formInclusion(schAMap, blocking)).toMatchObject({ include: true });
  });
});

describe("table, header and answer wiring", () => {
  it("ct.propertyTax is ctPropertyTaxRows(facts.deductions.propertyTaxBills).rows (description + amount)", async () => {
    const { facts, view } = build();
    expect(view.tables["ct.propertyTax"]).toEqual(ctPropertyTaxRows(facts.deductions.propertyTaxBills).rows);
    expect(view.tables["ct.propertyTax"]?.[0]?.cells).toEqual({ description: "27 Old Barry Rd", amount: 6000 });
    // and the CT-1040 Schedule 3 row 60 prints it
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(res.bytes);
    expect(f.get("ct1040.l60d")).toBe("27 Old Barry Rd");
    expect(f.get("ct1040.l60")).toBe("6,000");
  });

  it("other real estate and unclassified bills never reach the Schedule 3 table", () => {
    const facts = fullFacts();
    const base = facts.deductions.propertyTaxBills[0];
    if (!base) throw new Error("fixture has no property tax bill");
    facts.deductions.propertyTaxBills.push(
      { ...base, label: "56 Arbor Rd bill", address: "56 Arbor Rd", kind: "other_real_estate", paidInYearCents: 900_000 },
      { ...base, label: "Mystery bill", address: null, kind: "unclassified", paidInYearCents: 100_000 },
    );
    const { view } = build(facts);
    expect(view.tables["ct.propertyTax"]).toHaveLength(1);
    expect(JSON.stringify(view.tables["ct.propertyTax"])).not.toContain("Arbor");
  });

  it("header.ekcName comes from the caller and prints in the Form 8995 trade-name row; absent = blank", async () => {
    const withName = build(fullFacts(), { ekcName: "Eric Kinniburgh Consulting, LLC" });
    expect(withName.view.header.ekcName).toBe("Eric Kinniburgh Consulting, LLC");
    const field = f8995Map.header.find((h) => h.source === "entity.ekcName")?.field;
    expect(field).toBeDefined();
    const res = await fillForm("f8995", withName.view, f8995Map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(res.bytes)).get(field ?? "")).toBe("Eric Kinniburgh Consulting, LLC");

    const without = build();
    expect(without.view.header.ekcName).toBeNull();
    const res2 = await fillForm("f8995", without.view, f8995Map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(res2.bytes)).get(field ?? "")).toBe("");
  });

  it("Schedule B Part III answers are not supplied yet (undefined): both boxes stay unchecked with 'Answer needed' items", async () => {
    const { view } = build();
    for (const k of ["foreignAccounts", "fincenRequired", "foreignTrust"]) expect(view.answers[k], k).toBeUndefined();
    const res = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
    expect(res.openItems.some((i) => i.id === "fill:f1040sb:answer:foreignAccounts")).toBe(true);
    expect(res.openItems.some((i) => i.id === "fill:f1040sb:answer:foreignTrust")).toBe(true);
    const f = await readAllFields(res.bytes);
    for (const m of schBMap.lines) if (m.kind === "check") expect(f.get(m.field), m.field).toBe(false);
    // once attestations exist (Phase 1b), the caller supplies them and exactly the matching boxes check
    const { view: answered } = build(fullFacts(), { answers: { foreignAccounts: "no", fincenRequired: "no", foreignTrust: "no" } });
    const res2 = await fillForm("f1040sb", answered, schBMap, DEFAULT_FILL_OPTIONS);
    expect(res2.openItems.some((i) => i.id.startsWith("fill:f1040sb:answer:"))).toBe(false);
    const f2 = await readAllFields(res2.bytes);
    const checked = schBMap.lines.filter((m) => m.kind === "check" && f2.get(m.field) === true);
    expect(checked.map((m) => (m.kind === "check" ? `${m.choice}=${String(m.equals)}` : "")).sort()).toEqual(["fincenRequired=no", "foreignAccounts=no", "foreignTrust=no"]);
  });
});

describe("Form 1040 line 12d age / blind boxes (maps tester P1)", () => {
  const BOXES = {
    age65Taxpayer: "topmostSubform[0].Page2[0].c2_5[0]",
    blindTaxpayer: "topmostSubform[0].Page2[0].c2_6[0]",
    age65Spouse: "topmostSubform[0].Page2[0].c2_7[0]",
    blindSpouse: "topmostSubform[0].Page2[0].c2_8[0]",
  } as const;

  it("the four boxes are required checks keyed on the four boolean answers", () => {
    for (const [choice, field] of Object.entries(BOXES)) {
      const entry = f1040Map.lines.find((l) => l.kind === "check" && l.field === field);
      expect(entry, choice).toMatchObject({ kind: "check", choice, equals: true, required: true });
    }
  });

  it("no answers (the adapter supplies none yet): all four stay unchecked and each raises an 'Answer needed' item", async () => {
    const { view } = build();
    for (const k of Object.keys(BOXES)) expect(view.answers[k], k).toBeUndefined();
    const res = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(res.bytes);
    for (const [choice, field] of Object.entries(BOXES)) {
      expect(f.get(field), field).toBe(false);
      const item = res.openItems.find((i) => i.id === `fill:f1040:answer:${choice}`);
      expect(item?.severity, choice).toBe("advisory");
      expect(item?.message, choice).toContain("12d");
    }
  });

  it("true checks exactly that box; false leaves it unchecked with no item and is not flagged as unrecognised", async () => {
    const { view } = build(fullFacts(), { answers: { age65Taxpayer: true, blindTaxpayer: false, age65Spouse: false, blindSpouse: false } });
    const res = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(res.bytes);
    expect(f.get(BOXES.age65Taxpayer)).toBe(true);
    expect(f.get(BOXES.blindTaxpayer)).toBe(false);
    expect(f.get(BOXES.age65Spouse)).toBe(false);
    expect(f.get(BOXES.blindSpouse)).toBe(false);
    expect(res.openItems.filter((i) => i.id.includes(":answer:") && !i.id.endsWith(":digitalAssets"))).toEqual([]);
  });

  it("an unrecognised (string) answer checks nothing and says so", async () => {
    const { view } = build(fullFacts(), { answers: { age65Taxpayer: "yes" } });
    const res = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(res.bytes)).get(BOXES.age65Taxpayer)).toBe(false);
    expect(res.openItems.find((i) => i.id === "fill:f1040:answer:age65Taxpayer")?.message).toContain("not recognised");
  });

  it("12a, 12b, 12c, 7b and the other not-modeled decision boxes are LISTED on the cover, not only counted", async () => {
    const { view } = build();
    const res = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    const joined = res.blankNotes.join(" | ");
    for (const needle of ["line 12a", "line 12b", "line 12c", "line 7b", "line 3c", "line 4c", "line 5c", "line 6c", "line 6d", "line 16", "line 27b", "line 27c", "line 35a", "Presidential"]) {
      expect(joined, needle).toContain(needle);
    }
    expect(new Set(res.blankNotes).size).toBe(res.blankNotes.length);
    // the 12d boxes are answers now, not blank notes
    expect(joined).not.toContain("12d");

    const packet = await buildPacket(view, { maps: FORM_MAPS });
    const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: [], stamp: true });
    const at = model.blocks.findIndex((b) => b.kind === "heading" && b.text.startsWith("Boxes and entries the app does not decide"));
    expect(at).toBeGreaterThanOrEqual(0);
    const bullets: string[] = [];
    for (const b of model.blocks.slice(at + 1)) {
      if (b.kind === "heading") break;
      if (b.kind === "bullet") bullets.push(b.text);
    }
    expect(bullets.some((t) => t.includes("line 12a"))).toBe(true);
    expect(bullets.some((t) => t.includes("line 7b"))).toBe(true);
    // the 12d answers also appear as "Answer needed" fill notes on the cover
    expect(model.blocks.some((b) => b.kind === "bullet" && b.text.includes("Answer needed: 12d: taxpayer is blind"))).toBe(true);
  });
});

describe("Schedule C Part V with a non-zero line 48 and no rows is never silent (maps tester D3)", () => {
  function withOtherExpense(): { facts: Ty2025Facts; ret: Ty2025Return } {
    const facts = fullFacts();
    facts.income.scheduleC.glLines.push(gl("5090", "General business expenses:Bank fees & service charges", "expense", 12_350));
    return { facts, ret: computeTy2025Return(facts) };
  }

  it("engine exposes an empty item list: an advisory adapter item reaches the packet cover's open items", async () => {
    const { facts, ret } = withOtherExpense();
    expect(ret.lines["schc.48"]?.amount).toBeGreaterThan(0);
    if (!ret.scheduleC) throw new Error("no scheduleC detail");
    const stripped: Ty2025Return = { ...ret, scheduleC: { ...ret.scheduleC, otherExpenseItems: [] } };
    const view = toPdfReturnView(stripped, facts, OPTS);
    const item = view.openItems.find((i) => i.id === "adapter:schc.other-no-items");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("line 48");
    const packet = await buildPacket(view, { maps: FORM_MAPS });
    const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: [], stamp: true });
    expect(model.blocks.some((b) => b.kind === "bullet" && b.text.includes("Part V rows are blank"))).toBe(true);
  });

  it("no Schedule C detail at all (books unreadable) but a non-zero line 48: the item is raised and the table stays unset", () => {
    const { facts, ret } = withOtherExpense();
    const view = toPdfReturnView({ ...ret, scheduleC: null }, facts, OPTS);
    expect(view.tables["schc.otherExpenses"]).toBeUndefined();
    expect(view.openItems.some((i) => i.id === "adapter:schc.other-no-items")).toBe(true);
  });

  it("with item rows present, or with a zero line 48, no item is raised", () => {
    const { facts, ret } = withOtherExpense();
    expect(toPdfReturnView(ret, facts, OPTS).openItems.some((i) => i.id === "adapter:schc.other-no-items")).toBe(false);
    const plain = build();
    expect(plain.view.openItems.some((i) => i.id === "adapter:schc.other-no-items")).toBe(false);
  });
});
