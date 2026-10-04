import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 }); // each case fills real IRS forms
import { describe, expect, it } from "vitest";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { schDMap } from "@/lib/tax2025/pdf/maps/schD";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { EXPLICIT_NO_PDF, requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { missingLeaf } from "@/lib/tax2025/types";
import { DEFAULT_FILL_OPTIONS, assertMapGolden, loadCatalog, readAllFields, type FieldValue } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { VIEW_OPTS, build, realFacts, salesFacts } from "./fixtures/tax2025-pdf-schd.fixture";

// Golden tests of the filled Schedule D (and the Form 1040 lines 7a / 7b it feeds). Every number below is the engine's own cell for
// the REAL Robinhood figures (short A 5,872.31 / 5,285.50 / wash 5.99 -> 592.80; long D 17,001.68 / 12,037.28 -> 4,964.40) as printed
// in tax2025-schedule-d.test.ts: line 1b (d) 5,872 (e) 5,286 (g) 6 (h) 593 (592.80 rounded once from cents, NOT 5,872 - 5,286 + 6 = 592),
// line 8a 17,002 / 12,037 / 4,964, line 7 593, line 15 4,964, line 16 5,557 (5,557.20).

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const T1 = `${P1}Table_PartI[0].`;
const T2 = `${P1}Table_PartII[0].`;
const NAMES = "Eric and Eva";

/** Field name of one transaction cell: line id (1a ... 10) and column (d e g h). */
const ROW_FIRST: Readonly<Record<string, [string, string, number]>> = {
  "1a": [T1, "Row1a", 3],
  "1b": [T1, "Row1b", 7],
  "2": [T1, "Row2", 11],
  "3": [T1, "Row3", 15],
  "8a": [T2, "Row8a", 23],
  "8b": [T2, "Row8b", 27],
  "9": [T2, "Row9", 31],
  "10": [T2, "Row10", 35],
};
const cell = (line: string, col: "d" | "e" | "g" | "h"): string => {
  const r = ROW_FIRST[line];
  if (!r) throw new Error(line);
  return `${r[0]}${r[1]}[0].f1_${r[2] + ["d", "e", "g", "h"].indexOf(col)}[0]`;
};
const F = {
  name: `${P1}f1_1[0]`,
  ssn: `${P1}f1_2[0]`,
  l4: `${P1}f1_19[0]`,
  l5: `${P1}f1_20[0]`,
  l6: `${P1}f1_21[0]`,
  l7: `${P1}f1_22[0]`,
  l11: `${P1}f1_39[0]`,
  l12: `${P1}f1_40[0]`,
  l13: `${P1}f1_41[0]`,
  l14: `${P1}f1_42[0]`,
  l15: `${P1}f1_43[0]`,
  l16: `${P2}f2_1[0]`,
  l18: `${P2}f2_2[0]`,
  l19: `${P2}f2_3[0]`,
  l21: `${P2}f2_4[0]`,
  qofYes: `${P1}c1_1[0]`,
  qofNo: `${P1}c1_1[1]`,
  l17Yes: `${P2}c2_1[0]`,
  l17No: `${P2}c2_1[1]`,
  l20Yes: `${P2}c2_2[0]`,
  l20No: `${P2}c2_2[1]`,
  l22Yes: `${P2}c2_3[0]`,
  l22No: `${P2}c2_3[1]`,
};

const real = build(realFacts());

// The real household's expected sheet, field by field. Everything NOT listed here must be empty / unchecked.
const REAL_EXPECTED: Readonly<Record<string, FieldValue>> = {
  [F.name]: NAMES,
  [cell("1b", "d")]: "5,872",
  [cell("1b", "e")]: "5,286",
  [cell("1b", "g")]: "6",
  [cell("1b", "h")]: "593",
  [F.l7]: "593",
  [cell("8a", "d")]: "17,002",
  [cell("8a", "e")]: "12,037",
  [cell("8a", "h")]: "4,964",
  [F.l15]: "4,964",
  [F.l16]: "5,557",
  [F.qofNo]: true, // owner stated none for collectibles / QSB / real estate / QOF
  [F.l17Yes]: true, // lines 15 and 16 are both gains
  [F.l20Yes]: true, // lines 18 and 19 zero, no Form 4952
};

registerCommonMapTests({
  map: schDMap,
  fieldCount: 55,
  view: real.view,
  expected: REAL_EXPECTED,
  spot: [
    [F.name, /Name\(s\) shown on return/],
    [F.ssn, /social security number/i],
    [cell("1b", "d"), /Row: 1b\..*Box A or Box G.*Column: \(d\) Proceeds/],
    [cell("1b", "h"), /Row: 1b\..*Column: \(h\) Gain or \(loss\)/],
    [cell("8a", "e"), /Row: 8a\..*long-term.*Column: \(e\) Cost/],
    [cell("8b", "g"), /Row: 8b\..*Box D or Box J.*Column: \(g\) Adjustments/],
    [cell("2", "d"), /Row: 2\..*Box B or Box H/],
    [F.l7, /7\. Net short-term capital gain or \(loss\)/],
    [F.l13, /13\. Capital gain distributions/],
    [F.l15, /15\. Net long-term capital gain or \(loss\)/],
    [F.l16, /16\. Combine lines 7 and 15/],
    [F.l21, /21\. Open parenthesis\. If line 16 is a loss/],
    [F.qofYes, /qualified opportunity fund/],
    [F.l17Yes, /17\. Are lines 15 and 16 both gains\? Yes/],
    [F.l20No, /20\. No\. Complete the Schedule D Tax Worksheet/],
    [F.l22Yes, /22\. Do you have qualified dividends/],
  ],
});

describe("Schedule D map: every printed cell is in the column its engine key names", () => {
  it("each schd.<line>.<col> money field's IRS text names its row and its column letter", () => {
    const speak = new Map(loadCatalog("f1040sd").fields.map((f) => [f.name, f.speak ?? ""]));
    let checked = 0;
    for (const l of schDMap.lines) {
      if (l.kind !== "money") continue;
      const m = /^schd\.(\d+[ab]?)\.([degh])$/.exec(l.line);
      if (!m) continue;
      const [, line, col] = m;
      const text = speak.get(l.field) ?? "";
      expect(text, `${l.field} (${l.line}) row`).toMatch(new RegExp(`Row: ${line}\\.`));
      expect(text, `${l.field} (${l.line}) column`).toMatch(new RegExp(`Column: \\(${col}\\)`));
      checked += 1;
    }
    // 8 lines x 4 columns, minus the two (g) cells of lines 1a / 8a that have no engine key by design
    expect(checked).toBe(30);
    const blankG = schDMap.blank.filter((b) => "field" in b && b.reason === "form_na").map((b) => ("field" in b ? b.field : ""));
    expect(blankG.sort()).toEqual([cell("1a", "g"), cell("8a", "g")].sort());
    for (const f of blankG) expect(speak.get(f)).toMatch(/Column: \(g\) Adjustments/);
  });

  it("every non-cell money line is keyed to the right printed line", () => {
    const speak = new Map(loadCatalog("f1040sd").fields.map((f) => [f.name, f.speak ?? ""]));
    const pairs: ReadonlyArray<readonly [string, string, RegExp]> = [
      [F.l4, "schd.4", /^4\. Short-term gain from Form 6252/],
      [F.l5, "schd.5", /^5\. Net short-term gain or \(loss\) from partnerships/],
      [F.l6, "schd.6", /^6\. Open parenthesis\. Short-term capital loss carryover/],
      [F.l11, "schd.11", /^11\. Gain from Form 4797/],
      [F.l12, "schd.12", /^12\. Net long-term gain or \(loss\) from partnerships/],
      [F.l14, "schd.14", /^14\. Open parenthesis\. Long-term capital loss carryover/],
      [F.l18, "schd.18", /^18\. If you are required to complete the 28% Rate Gain Worksheet/],
      [F.l19, "schd.19", /^19\. If you are required to complete the Unrecaptured Section 1250/],
    ];
    for (const [field, key, pattern] of pairs) {
      const entry = schDMap.lines.find((l) => l.kind === "money" && l.field === field);
      expect(entry && entry.kind === "money" ? entry.line : null, field).toBe(key);
      expect(speak.get(field), field).toMatch(pattern);
    }
  });
});

describe("Schedule D golden: the real Robinhood household", () => {
  it("the engine's own cells are what prints (lines 1b / 8a / 7 / 15 / 16, Form 1040 line 7a)", () => {
    const l = (k: string): number | null => real.view.lines[k as keyof typeof real.view.lines]?.amount ?? null;
    expect([l("schd.1b.d"), l("schd.1b.e"), l("schd.1b.g"), l("schd.1b.h")]).toEqual([5872, 5286, 6, 593]);
    expect([l("schd.8a.d"), l("schd.8a.e"), l("schd.8a.h")]).toEqual([17002, 12037, 4964]);
    expect([l("schd.7"), l("schd.15"), l("schd.16"), l("f1040.7a"), l("qdcg.3")]).toEqual([593, 4964, 5557, 5557, 4964]);
  });

  it("lines 1a / 8a (g), the SSN and every line with no amount are blank, not zero; no item blocks the sheet", async () => {
    const result = await fillForm("f1040sd", real.view, schDMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    for (const name of [cell("1a", "d"), cell("1a", "e"), cell("1a", "g"), cell("1a", "h"), cell("8a", "g"), F.ssn, F.l4, F.l5, F.l6, F.l11, F.l12, F.l13, F.l14, F.l18, F.l19, F.l21]) {
      expect(fields.get(name), name).toBe("");
    }
    expect(result.blankByDesign.ssn).toBe(1);
    expect(result.blankByDesign.form_na).toBe(2);
    expect(result.openItems.filter((i) => i.severity === "blocking")).toEqual([]);
  });

  it("Form 1040: line 7a prints 5,557 and the line 7b 'Schedule D not required' box stays unchecked", async () => {
    const result = await fillForm("f1040", real.view, f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(`${P1}f1_70[0]`)).toBe("5,557");
    expect(fields.get(`${P1}c1_43[0]`)).toBe(false);
    expect(fields.get(`${P1}c1_44[0]`)).toBe(false);
  });
});

describe("Form 1040 line 7b box follows the engine's Exception 1", () => {
  it("no sales and no carryover: the box is checked, Schedule D and Form 8949 are omitted and say why on the cover list", async () => {
    const facts = salesFacts([]);
    facts.income.dividendBoxes2b2dConfirmedZero = true; // the owner confirmed 1099-DIV boxes 2b, 2c and 2d are zero
    const golden = build(facts);
    // no sales summary at all and boxes 2b-2d confirmed: Exception 1 (only capital gain distributions, here none)
    expect(golden.ret.scheduleD?.exception1).toBe(true);
    expect(golden.view.answers["schdNotRequired"]).toBe(true);
    const result = await fillForm("f1040", golden.view, f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(`${P1}c1_43[0]`)).toBe(true);
    expect(fields.get(`${P1}c1_44[0]`)).toBe(false); // the child's capital gain box stays blank and is still listed on the cover
    expect(result.blankNotes.some((n) => /line 7b/.test(n) && /child's capital gain/.test(n))).toBe(true);
    const packet = await buildPacket(golden.view, { maps: FORM_MAPS });
    const sd = packet.forms.find((f) => f.formId === "f1040sd");
    const f8949 = packet.forms.find((f) => f.formId === "f8949");
    for (const f of [sd, f8949]) {
      expect(f?.included).toBe(false);
      expect(f?.reason).toContain("the engine reports it is not required");
    }
    expect(packet.files.some((f) => f.formId === "f1040sd" || f.formId === "f8949")).toBe(false);
  });

  it("with sales the box stays unchecked and the engine's verdict includes Schedule D", async () => {
    const result = await fillForm("f1040", real.view, f1040Map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}c1_43[0]`)).toBe(false);
    const packet = await buildPacket(real.view, { maps: FORM_MAPS });
    expect(packet.forms.find((f) => f.formId === "f1040sd")?.included).toBe(true);
  });
});

describe("Form 1040 line 7b box is NEVER ticked while 1099-DIV boxes 2b-2d are unconfirmed", () => {
  it("no sales, boxes unconfirmed: Schedule D / 8949 are still omitted, but the box stays unchecked", async () => {
    const { ret, view } = build(salesFacts([])); // fullFacts has 1099-DIVs and no 2b-2d confirmation
    expect(ret.scheduleD).toMatchObject({ required: false, exception1: false, boxes2b2dUnconfirmed: true });
    expect(view.answers["schdNotRequired"]).toBe(false);
    const result = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}c1_43[0]`)).toBe(false);
  });

  it("the adapter never lets exception1 and boxes2b2dUnconfirmed both pass (a hypothetical engine result with both true stays unchecked)", () => {
    const { ret, facts } = build(salesFacts([]));
    const forged = { ...ret, scheduleD: ret.scheduleD ? { ...ret.scheduleD, exception1: true, boxes2b2dUnconfirmed: true } : null };
    expect(toPdfReturnView(forged, facts, VIEW_OPTS).answers["schdNotRequired"]).toBe(false);
  });
});

describe("Form 1040 line 7a: a zero prints only when Schedule D is filed and line 16 is exactly 0", () => {
  const f1040Fields = async (view: ReturnType<typeof build>["view"]): Promise<Map<string, FieldValue>> =>
    readAllFields((await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS)).bytes);

  it("line 16 = 0 with Schedule D filed: 7a prints 0", async () => {
    const { view } = build(salesFacts([{ box: "A", proceedsCents: 100_000, costCents: 100_100, washSaleCents: 100 }]));
    expect(view.lines["schd.16"]?.amount).toBe(0);
    expect(view.answers["schdLine16Zero"]).toBe(true);
    expect((await f1040Fields(view)).get(`${P1}f1_70[0]`)).toBe("0");
  });

  it("Schedule D not required (zero 7a): 7a stays blank, no schdLine16Zero answer", async () => {
    const { view } = build(salesFacts([]));
    expect(view.answers["schdLine16Zero"]).toBeUndefined();
    expect((await f1040Fields(view)).get(`${P1}f1_70[0]`)).toBe("");
  });

  it("a gain or a loss on line 16 prints its own amount and sets no zero answer", async () => {
    const gain = build(salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 60_000 }]));
    expect(gain.view.answers["schdLine16Zero"]).toBeUndefined();
    expect((await f1040Fields(gain.view)).get(`${P1}f1_70[0]`)).toBe("400");
    const loss = build(salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 600_000 }]));
    expect((await f1040Fields(loss.view)).get(`${P1}f1_70[0]`)).toBe("-3,000");
  });

  it("the policy: zeroWhen prints 0 only for a matching answer; a missing / blocked line is never 0", () => {
    const entry = { kind: "money" as const, field: "x", line: "f1040.7a" as const, zeroWhen: { choice: "z", equals: true } };
    const zero = { key: "f1040.7a" as const, status: "computed" as const, amount: 0, reason: null, formLabel: "Form 1040", formLine: "7a", label: "x" };
    expect(resolveFieldValue("f1040", zero, entry, { z: true }).write).toBe("0");
    expect(resolveFieldValue("f1040", zero, entry, { z: false }).write).toBeNull();
    expect(resolveFieldValue("f1040", zero, entry, {}).write).toBeNull();
    expect(resolveFieldValue("f1040", zero, entry).write).toBeNull();
    const blocked = { ...zero, status: "missing_input" as const, amount: null };
    expect(resolveFieldValue("f1040", blocked, entry, { z: true }).write).toBeNull();
  });
});

describe("Schedule D: loss, zero, signs and the blank-not-zero policy", () => {
  it("a long-term loss of $5,000: negatives print with a minus, line 21 is the positive $3,000, 17 and 20 stay unchecked, 22 is answered", async () => {
    const { view, ret } = build(salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 600_000 }]));
    expect(ret.scheduleD?.line17).toBe(false);
    const result = await assertMapGolden(
      schDMap,
      view,
      {
        [F.name]: NAMES,
        [cell("8a", "d")]: "1,000",
        [cell("8a", "e")]: "6,000",
        [cell("8a", "h")]: "-5,000",
        [F.l7]: "0", // a computed subtotal of zero prints as 0
        [F.l15]: "-5,000",
        [F.l16]: "-5,000",
        [F.l21]: "3,000", // the form pre-prints the parentheses: the positive amount
        [F.qofNo]: true,
        // line 17 / 20 are skipped when line 16 is a loss; 22 is asked (qualified dividends exist on the fixture 1040)
        [F.l22Yes]: true,
      },
      DEFAULT_FILL_OPTIONS,
    );
    expect(result.openItems.filter((i) => i.severity === "blocking")).toEqual([]);
    expect(view.lines["f1040.7a"]?.amount).toBe(-3000);
  });

  it("net zero: lines 7 / 15 / 16 print 0, the zero detail cell stays blank, no 17 / 20", async () => {
    const { view } = build(salesFacts([{ box: "D", proceedsCents: 50_000, costCents: 50_000 }]));
    await assertMapGolden(
      schDMap,
      view,
      {
        [F.name]: NAMES,
        [cell("8a", "d")]: "500",
        [cell("8a", "e")]: "500",
        [F.l7]: "0",
        [F.l15]: "0",
        [F.l16]: "0",
        [F.qofNo]: true,
        [F.l22Yes]: true,
      },
      DEFAULT_FILL_OPTIONS,
    );
  });

  it("an unanswered carryover blocks line 6 / 7 / 16: they print blank (never 0) with a blocking item", async () => {
    const f = salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 60_000 }], { carryoverShort: missingLeaf<number>() });
    const { view } = build(f);
    expect(view.lines["schd.6"]?.status).toBe("missing_input");
    const result = await fillForm("f1040sd", view, schDMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    for (const name of [F.l6, F.l7, F.l16]) expect(fields.get(name), name).toBe("");
    const ids = result.openItems.filter((i) => i.severity === "blocking").map((i) => i.id);
    expect(ids).toContain("blank:f1040sd:schd.6");
    expect(ids).toContain("blank:f1040sd:schd.7");
    expect(ids).toContain("blank:f1040sd:schd.16");
  });

  it("a stated carryover prints on line 6 / 14 as the positive amount", async () => {
    const { owner } = await import("./tax2025-fixtures");
    const { view } = build(salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 60_000 }], { carryoverShort: owner(12_300), carryoverLong: owner(45_600) }));
    const result = await fillForm("f1040sd", view, schDMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(F.l6)).toBe("123");
    expect(fields.get(F.l14)).toBe("456");
    expect(fields.get(F.l7)).toBe("-123"); // line 7 = 0 - 123
    expect(fields.get(F.l15)).toBe("-56"); // 400 - 456
  });
});

describe("Schedule D: the QOF box is the owner's statement, never a guess", () => {
  it.each([
    ["not stated / not sure", "unstated" as const],
    ["answered yes (a special-rate sale exists)", false as const],
  ])("%s: both boxes unchecked and an 'Answer needed' item", async (_label, specialRatesNone) => {
    const { view } = build(salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 60_000 }], { specialRatesNone }));
    expect(view.answers["schd.qof"]).toBeUndefined();
    const result = await fillForm("f1040sd", view, schDMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(F.qofYes)).toBe(false);
    expect(fields.get(F.qofNo)).toBe(false);
    expect(result.openItems.some((i) => i.id === "fill:f1040sd:answer:schd.qof" && /Answer needed/.test(i.message))).toBe(true);
  });

  it("stated none: No is checked and no item is raised", async () => {
    const result = await fillForm("f1040sd", real.view, schDMap, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(F.qofNo)).toBe(true);
    expect(result.openItems.some((i) => i.id.includes(":answer:"))).toBe(false);
  });
});

describe("Schedule D: line 17 / 20 / 22 boxes (derived from the engine, only where the form asks)", () => {
  it("a short-term gain with a long-term loss: line 16 is a gain but line 15 is not, so 17 = No and 22 is answered", async () => {
    const { view } = build(
      salesFacts([
        { box: "A", proceedsCents: 3_000_000, costCents: 0, washSaleCents: 0 },
        { box: "D", proceedsCents: 0, costCents: 1_000_000 },
      ]),
    );
    expect(view.lines["schd.16"]?.amount).toBe(20_000);
    const result = await fillForm("f1040sd", view, schDMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(F.l17No)).toBe(true);
    expect(fields.get(F.l17Yes)).toBe(false);
    expect(fields.get(F.l20Yes)).toBe(false);
    expect(fields.get(F.l20No)).toBe(false);
    expect(fields.get(F.l22Yes)).toBe(true);
  });
});

describe("registry and packet wiring", () => {
  it("Schedule D and Form 8949 are mapped, so they are no longer on the explicit no-PDF list", () => {
    expect(EXPLICIT_NO_PDF).not.toContain("schd");
    expect(EXPLICIT_NO_PDF).not.toContain("f8949");
    expect(schDMap.engineFormId).toBe("schd");
    expect(requiredFormsWithoutPdf(real.view).map((m) => m.formId)).not.toContain("schd");
    expect(requiredFormsWithoutPdf(real.view).map((m) => m.formId)).not.toContain("f8949");
  });

  it("packet order: after Schedule C, before Schedule SE; file names carry the sequence number", async () => {
    const packet = await buildPacket(real.view, { maps: FORM_MAPS });
    const names = packet.files.map((f) => f.name);
    const at = (id: string): number => names.findIndex((n) => new RegExp(`^\\d\\d-${id}(?:-[a-z0-9-]+)?\\.pdf$`).test(n));
    expect(at("f1040sc")).toBeGreaterThan(0);
    expect(at("f1040sd")).toBe(at("f1040sc") + 1);
    expect(at("f8949")).toBe(at("f1040sd") + 1);
    expect(at("f1040sse")).toBe(at("f8949") + 1);
  });

  it("the cover lists neither form as 'required but not generated'", async () => {
    const packet = await buildPacket(real.view, { maps: FORM_MAPS });
    const withoutPdf = requiredFormsWithoutPdf(real.view).map((m) => m.formId);
    expect(withoutPdf).not.toContain("schd");
    expect(withoutPdf).not.toContain("f8949");
    expect(packet.forms.find((f) => f.formId === "f1040sd")?.included).toBe(true);
  });
});
