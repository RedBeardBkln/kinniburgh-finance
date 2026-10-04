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
import { buildCoverModel, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { ENGINE_FORM_TITLES, EXPLICIT_NO_PDF, requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import { PDFDocument } from "pdf-lib";
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
import { missingLeaf } from "@/lib/tax2025/types";
import { emptyFacts, fullFacts, gl } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";

const OPTS = { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" } as const;

function build(facts: Ty2025Facts = fullFacts(), extra: Partial<Parameters<typeof toPdfReturnView>[2]> = {}) {
  const ret = computeTy2025Return(facts);
  const view = toPdfReturnView(ret, facts, { ...OPTS, ...extra });
  return { facts, ret, view };
}

/** The fixture with the header attestations and the 12d age / blind answers all UNANSWERED. */
function unansweredFacts(): Ty2025Facts {
  const f = fullFacts();
  f.returnAnswers.attestations = { digitalAssets: missingLeaf<boolean>(), foreignAccounts: missingLeaf<boolean>() };
  for (const p of f.returnAnswers.people) {
    p.bornBefore1961 = missingLeaf<boolean>();
    p.blind = missingLeaf<boolean>();
  }
  return f;
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
  /** The golden fixture's CT AGI is above the property tax credit phase-out, so Schedule 3 is left blank; this makes the engine say a credit applies. */
  function withCreditEligible(ret: Ty2025Return): Ty2025Return {
    const mk = (key: "ct1040.s3.63" | "ct1040.s3.65" | "ct1040.s3.67", amount: number) => {
      const l = ret.lines[key];
      if (!l) throw new Error(`${key} missing`);
      return { ...l, status: "computed" as const, amount, exact: String(amount), reason: null };
    };
    return { ...ret, lines: { ...ret.lines, "ct1040.s3.63": mk("ct1040.s3.63", 6000), "ct1040.s3.65": mk("ct1040.s3.65", 300), "ct1040.s3.67": mk("ct1040.s3.67", 270) } };
  }

  it("ct.propertyTax is ctPropertyTaxRows(facts.deductions.propertyTaxBills).rows (description + amount) when a credit can be claimed", async () => {
    const { facts, ret } = build();
    const view = toPdfReturnView(withCreditEligible(ret), facts, OPTS);
    expect(view.tables["ct.propertyTax"]).toEqual(ctPropertyTaxRows(facts.deductions.propertyTaxBills).rows);
    expect(view.tables["ct.propertyTax"]?.[0]?.cells).toEqual({ description: "27 Old Barry Rd", amount: 6000 });
    // and the CT-1040 Schedule 3 row 60 prints it
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(res.bytes);
    expect(f.get("ct1040.l60d")).toBe("27 Old Barry Rd");
    expect(f.get("ct1040.l60")).toBe("6,000");
    expect(f.get("ct1040.l63")).toBe("6,000");
    expect(f.get("ct1040.l65")).toBe("300");
    expect(f.get("ct1040.l67")).toBe("270");
    expect(view.openItems.some((i) => i.id === "adapter:ct.schedule3-boxes")).toBe(true);
  });

  it("fully phased out (the golden fixture): Schedule 3 is left entirely blank and the cover item says why", async () => {
    const { ret, view } = build();
    expect(ret.lines["ct1040.s3.63"]?.status).toBe("not_applicable");
    expect(view.tables["ct.propertyTax"]).toEqual([]);
    const item = view.openItems.find((i) => i.id === "adapter:ct.schedule3-blank");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("fully phased out");
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(res.bytes);
    for (const k of ["l60", "l60d", "l61", "l62", "l63", "l65", "l67", "l68"]) expect(f.get(`ct1040.${k}`) ?? "", k).toBe("");
  });

  it("other real estate and unclassified bills never reach the Schedule 3 table", () => {
    const facts = fullFacts();
    const base = facts.deductions.propertyTaxBills[0];
    if (!base) throw new Error("fixture has no property tax bill");
    facts.deductions.propertyTaxBills.push(
      { ...base, label: "56 Arbor Rd bill", address: "56 Arbor Rd", kind: "other_real_estate", paidInYearCents: 900_000 },
      { ...base, label: "Mystery bill", address: null, kind: "unclassified", paidInYearCents: 100_000 },
    );
    const ret = computeTy2025Return(facts);
    const view = toPdfReturnView(withCreditEligible(ret), facts, OPTS);
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

  it("Schedule B Part III answers unanswered (undefined): both boxes stay unchecked with 'Answer needed' items", async () => {
    const { view } = build(unansweredFacts());
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

  it("no answers (unanswered questionnaire): all four stay unchecked and each raises an 'Answer needed' item", async () => {
    const { view } = build(unansweredFacts());
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
    const { view } = build(unansweredFacts());
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

// ── Round 2 (review fixes B1, B2, S1, S2, S3, S5) ──────────────────────────────

function bulletsAfter(blocks: readonly CoverBlock[], headingStart: string): string[] {
  const at = blocks.findIndex((b) => b.kind === "heading" && b.text.startsWith(headingStart));
  expect(at, `heading "${headingStart}"`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const b of blocks.slice(at + 1)) {
    if (b.kind === "heading") break;
    if (b.kind === "bullet") out.push(b.text);
  }
  return out;
}

function allText(blocks: readonly CoverBlock[]): string {
  return blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text)).join("\n");
}

describe("B1: forms the engine requires but the packet cannot generate are listed on the cover", () => {
  it("every engine form id is either served by a registered map or on the explicit no-PDF list (never both, never neither)", () => {
    const engineIds = Object.keys(ENGINE_FORM_TITLES).sort();
    const mapped = new Set<string>(["f1040", ...FORM_MAPS.map((m) => m.engineFormId).filter((x): x is NonNullable<typeof x> => x !== undefined)]);
    const noPdf = new Set<string>(EXPLICIT_NO_PDF);
    for (const id of engineIds) {
      expect(mapped.has(id) !== noPdf.has(id), `${id}: exactly one of "has a map" / "explicit no-PDF list"`).toBe(true);
    }
    expect([...mapped, ...noPdf].sort()).toEqual(engineIds);
    // the engine never reports a form id this module does not know
    const { ret } = build();
    for (const id of Object.keys(ret.formsRequired)) expect(ENGINE_FORM_TITLES, id).toHaveProperty(id);
  });

  it("required (true) and undecided ('blocking') forms without a map are listed with the engine's reason; false verdicts are not", () => {
    const { view } = build();
    const v: PdfReturnView = {
      ...view,
      formsRequired: {
        ...view.formsRequired,
        sch1a: { required: "blocking", reason: "Cannot tell until a blocking item is resolved." },
        f8889: { required: true, reason: "HSA contributions or distributions exist." },
        f8283: { required: false, reason: "Noncash gifts are not over $500." },
      },
    };
    const missing = requiredFormsWithoutPdf(v);
    expect(missing.map((m) => m.formId)).toEqual(["sch1a", "f8889"]); // the explicit-list order
    const model = buildCoverModel({ view: v, forms: [], fillItems: [], continuations: [], stamp: true, missingForms: missing });
    const heading = model.blocks.find((b) => b.kind === "heading" && b.text.startsWith("Required forms this packet does NOT contain"));
    expect(heading && "text" in heading ? heading.text : "").toContain("(2)");
    const bullets = bulletsAfter(model.blocks, "Required forms this packet does NOT contain");
    expect(bullets).toHaveLength(2);
    const s1a = bullets.find((t) => t.includes("Schedule 1-A"));
    const f8889 = bullets.find((t) => t.includes("Form 8889"));
    expect(s1a).toContain("cannot rule it out yet");
    expect(s1a).toContain("Cannot tell until a blocking item is resolved.");
    expect(f8889).toContain("the engine says it is required");
    expect(f8889).toContain("HSA contributions or distributions exist.");
    expect(allText(model.blocks)).not.toContain("Form 8283");
    // the section comes before "Forms in this packet"
    const order = model.blocks.map((b) => (b.kind === "heading" ? b.text : ""));
    expect(order.findIndex((t) => t.startsWith("Required forms this packet does NOT"))).toBeLessThan(order.indexOf("Forms in this packet"));
  });

  it("a real packet carries the section and the status banner counts the missing forms", async () => {
    const { view } = build();
    const v: PdfReturnView = { ...view, formsRequired: { ...view.formsRequired, f4562: { required: true, reason: "The fixed-asset register is not empty." } } };
    const packet = await buildPacket(v, { maps: FORM_MAPS });
    const model = buildCoverModel({ view: v, forms: packet.forms, fillItems: packet.openItems, continuations: [], stamp: true, missingForms: requiredFormsWithoutPdf(v) });
    expect(bulletsAfter(model.blocks, "Required forms this packet does NOT contain").some((t) => t.includes("Form 4562"))).toBe(true);
    const missingCount = requiredFormsWithoutPdf(v).length;
    expect(missingCount).toBeGreaterThanOrEqual(1);
    expect(allText(model.blocks)).toContain(`${missingCount} form(s) the engine requires are not generated by this packet`);
  });

  it("none missing: the section says so", () => {
    const { view } = build();
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    expect(allText(model.blocks)).toContain("None: every form the engine requires or cannot rule out is in this packet.");
  });
});

describe("B2: a blank line is never read as a zero unless it is one", () => {
  it("the engine emits every CT-1040 derived line (no pending keys): lines 3, 7, 8, 12, 13, 14, 16, 17, 21 are real lines and raise no 'not emitted' item", async () => {
    const { view } = build();
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    for (const key of ["ct1040.3", "ct1040.7", "ct1040.8", "ct1040.12", "ct1040.13", "ct1040.14", "ct1040.16", "ct1040.17", "ct1040.21"] as const) {
      expect(view.lines[key], `${key} is emitted`).toBeDefined();
      expect(res.openItems.some((i) => i.id === `noemit:ct1040:${key}`), key).toBe(false);
    }
  });

  it("on the real engine view, every blank mapped money line (all forms) is explained by an item or is a genuine zero", async () => {
    for (const facts of [fullFacts(), itemizingFacts()]) {
      const { view } = build(facts);
      for (const map of FORM_MAPS) {
        const res = await fillForm(map.formId, view, map, DEFAULT_FILL_OPTIONS);
        const values = await readAllFields(res.bytes);
        for (const entry of map.lines) {
          if (entry.kind !== "money") continue;
          if ((values.get(entry.field) ?? "") !== "") continue;
          const explained = res.openItems.some((i) => i.lineKey === entry.line);
          const line = view.lines[entry.line];
          const zeroish =
            line !== undefined &&
            (line.status === "computed" || line.status === "not_applicable" || line.status === "overridden") &&
            line.amount !== null &&
            (line.amount === 0 || entry.sign !== undefined);
          expect(explained || zeroish, `${map.formId} ${entry.line} is blank with no item and is not a zero (${line?.status ?? "not emitted"})`).toBe(true);
        }
      }
    }
  });

  it("the cover's blank-line policy never claims a blank is a zero without the listed exceptions", () => {
    const { view } = build();
    const text = allText(buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true }).blocks);
    expect(text).toContain("A blank MONEY line that is not listed under 'Lines left blank on the forms'");
    expect(text).toContain("'Boxes and entries the app does not decide'");
    expect(text).not.toContain("A blank form line with no open item is a computed zero");
  });

  it("the CT-1040 not-modeled lines (18f, 23 / 24 / 24a, 69a / 69c / 69d) are listed on the cover; lines 20a-20d, 25, 29, 30, 63/65/67 and 69b are engine lines now (ty2025-ct1040-derived-lines)", async () => {
    const { view } = build();
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const joined = res.blankNotes.join(" | ");
    for (const needle of ["18f", "23, 24, 24a", "69a, 69c, 69d"]) expect(joined, needle).toContain(needle);
    for (const gone of ["20a-20d", "lines 29, 30", "63, 65, 67", "69a-69d", "Schedule 1 detail"]) expect(joined, gone).not.toContain(gone);
  });
});

describe("S1: answered questions reach the boxes and clear the 'Answer needed' items", () => {
  it("fully answered fixture: digital assets 'No' and Schedule B Part III 'No' boxes check; 12d boxes stay unchecked with no item", async () => {
    const { view } = build();
    const f1040 = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(f1040.bytes);
    expect(f.get("topmostSubform[0].Page1[0].c1_10[1]")).toBe(true); // digital assets: No
    expect(f.get("topmostSubform[0].Page1[0].c1_10[0]")).toBe(false);
    expect(f1040.openItems.filter((i) => i.id.includes(":answer:"))).toEqual([]);
    const b = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
    expect(b.openItems.filter((i) => i.id.includes(":answer:"))).toEqual([]);
    const fb = await readAllFields(b.bytes);
    const checked = schBMap.lines.filter((m) => m.kind === "check" && fb.get(m.field) === true).map((m) => (m.kind === "check" ? `${m.choice}=${String(m.equals)}` : ""));
    expect(checked.sort()).toEqual(["fincenRequired=no", "foreignAccounts=no", "foreignTrust=no"]);
  });

  it("a person who is 65 or older checks that 12d box and nothing is reported as missing", async () => {
    const facts = fullFacts();
    const eric = facts.returnAnswers.people.find((p) => p.name === "Eric");
    if (!eric) throw new Error("fixture person missing");
    eric.bornBefore1961 = { ...eric.bornBefore1961, value: true };
    const { view } = build(facts);
    expect(view.answers["age65Taxpayer"]).toBe(true);
    const res = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(res.bytes);
    expect(f.get("topmostSubform[0].Page2[0].c2_5[0]")).toBe(true);
    expect(res.openItems.filter((i) => i.id.includes(":answer:"))).toEqual([]);
  });
});

describe("S2: informational lines never block", () => {
  it("a needs-CPA line the engine marks informational is an ADVISORY blank item; others stay blocking", () => {
    const base = { key: "ct1040.28" as const, status: "needs_cpa_rule_unverified" as const, amount: null, reason: "not estimated", formLabel: "CT-1040", formLine: "28", label: "interest" };
    const entry = { kind: "money" as const, field: "x", line: "ct1040.28" as const };
    expect(resolveFieldValue("ct1040", { ...base, informational: true }, entry).items[0]?.severity).toBe("advisory");
    expect(resolveFieldValue("ct1040", base, entry).items[0]?.severity).toBe("blocking");
  });

  it("real engine: CT-1040 lines 27 / 28 are informational advisory blanks", async () => {
    const { view } = build();
    expect(view.lines["ct1040.27"]?.informational).toBe(true);
    expect(view.lines["ct1040.28"]?.informational).toBe(true);
    const packet = await buildPacket(view, { maps: FORM_MAPS });
    const ct = packet.openItems.filter((i) => i.formId === "ct1040" && (i.lineKey === "ct1040.27" || i.lineKey === "ct1040.28"));
    expect(ct.length).toBe(2);
    for (const i of ct) expect(i.severity).toBe("advisory");
  });
});

describe("S3 + S5: provisional facts and the status banner", () => {
  it("the PROVISIONAL block lists the engine's assumedFacts one per bullet", () => {
    const { ret, view } = build(emptyFacts());
    expect(ret.headline.complete).toBe(false);
    const facts = ret.headline.provisional?.assumedFacts ?? [];
    expect(facts.length).toBeGreaterThan(0);
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    const bullets = bulletsAfter(model.blocks, "Headline numbers");
    for (const a of facts) expect(bullets, a).toContain(a);
    expect(allText(model.blocks)).toContain("these facts were assumed");
  });

  it("status banner: blocking items remain -> NOT ready; none -> review still required", () => {
    const { ret, view } = build(emptyFacts());
    const blocking = ret.openItems.filter((i) => i.severity === "blocking").length;
    expect(blocking).toBeGreaterThan(0);
    const bad = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    const at = bad.blocks.findIndex((b) => b.kind === "heading" && b.text.startsWith("STATUS:"));
    const status = bad.blocks[at];
    expect(status && "text" in status ? status.text : "").toBe(`STATUS: ${blocking} blocking item(s) remain - NOT ready to file.`);
    expect(at).toBeLessThan(4); // right after the title block
    const clean = buildCoverModel({ view: { ...view, openItems: [] }, forms: [], fillItems: [], continuations: [], stamp: true });
    expect(allText(clean.blocks)).toContain("STATUS: no blocking items; CPA review is still required.");
    const withMissing = buildCoverModel({
      view: { ...view, openItems: [] },
      forms: [],
      fillItems: [],
      continuations: [],
      stamp: true,
      missingForms: requiredFormsWithoutPdf({ formsRequired: { f8889: { required: true, reason: "r" } } }),
    });
    expect(allText(withMissing.blocks)).toContain(
      "STATUS: no blocking items, but 1 form(s) the engine requires are not generated by this packet (see below) - NOT ready to file; CPA review required.",
    );
  });
});

describe("nits", () => {
  it("every filled form keeps a DRAFT note in its document properties (also the clean ?stamp=0 copy)", async () => {
    const { view } = build();
    const res = await fillForm("f1040", view, f1040Map, { ...DEFAULT_FILL_OPTIONS, stamp: false });
    const doc = await PDFDocument.load(res.bytes);
    expect(doc.getSubject()).toContain("DRAFT");
  });
});
