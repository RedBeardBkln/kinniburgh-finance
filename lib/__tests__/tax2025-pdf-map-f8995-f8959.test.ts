import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f8959Map } from "@/lib/tax2025/pdf/maps/f8959";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";
import { f8995Map } from "@/lib/tax2025/pdf/maps/f8995";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { LineKey, RuleStatus } from "@/lib/tax2025/types";
import { fullFacts } from "./tax2025-fixtures";
import { engineLine, linesOf, required, viewFromEngine, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS, assertMapComplete, assertMapGolden, readAllFields } from "./tax2025-pdf-harness";

const P = "topmostSubform[0].Page1[0].";
const T = `${P}Table[0].`;
const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };

// ── Form 8995 ─────────────────────────────────────────────────────────────────

const F8995_AMOUNTS: ReadonlyArray<readonly [LineKey, number]> = [
  ["f8995.1i", 45000],
  ["f8995.2", 45000],
  ["f8995.3", 0], // detail line, computed zero -> blank
  ["f8995.4", 45000],
  ["f8995.5", 9000],
  ["f8995.6", 0],
  ["f8995.7", 0],
  ["f8995.8", 0],
  ["f8995.9", 0],
  ["f8995.10", 9000],
  ["f8995.11", 96000],
  ["f8995.12", 1500],
  ["f8995.13", 94500],
  ["f8995.14", 18900],
  ["f8995.15", 9000],
  ["f8995.16", 0],
  ["f8995.17", 0],
];

describe("Form 8995 map", () => {
  it("claims every one of the form's 33 fields exactly once", () => assertMapComplete(f8995Map));

  it("every money line is a real engine LINE_KEY", () => {
    const real = new Set<string>(LINE_KEYS);
    for (const l of f8995Map.lines) if (l.kind === "money") expect(real.has(l.line), l.line).toBe(true);
  });

  it("covers every printed 8995 line 1i..17 exactly once", () => {
    const keys = f8995Map.lines.flatMap((l) => (l.kind === "money" ? [l.line] : []));
    expect(keys).toHaveLength(17);
    expect(new Set(keys).size).toBe(17);
  });

  it("golden read-back: EKC in the trade-name row, TIN blank, zero only where the form says enter 0", async () => {
    const view = viewWith({ lines: linesOf(F8995_AMOUNTS), formsRequired: { f8995: required(true, "A qualified business income deduction is claimed.") } });
    const result = await assertMapGolden(
      f8995Map,
      view,
      {
        [`${P}f1_01[0]`]: "Alex Example and Sam Q Example",
        [`${T}Row1i[0].f1_03[0]`]: "Example Consulting, LLC", // (a) trade name
        // (b) TIN: blank by design
        [`${T}Row1i[0].f1_05[0]`]: "45,000", // (c)
        [`${P}Line2_ReadOrder[0].f1_18[0]`]: "45,000",
        // line 3 computed 0 on a detail line: blank
        [`${P}f1_20[0]`]: "45,000",
        [`${P}f1_21[0]`]: "9,000",
        [`${P}f1_26[0]`]: "9,000",
        [`${P}f1_27[0]`]: "96,000",
        [`${P}f1_28[0]`]: "1,500",
        [`${P}f1_29[0]`]: "94,500",
        [`${P}f1_30[0]`]: "18,900",
        [`${P}f1_31[0]`]: "9,000",
      },
      NO_STAMP,
    );
    expect(result.blankByDesign.ssn).toBe(1);
    expect(result.blankByDesign.ein).toBe(1);
  });

  it("lines the form says to enter 0 on print '0' (4, 13, 15) while other computed zeros stay blank", async () => {
    const view = viewWith({
      lines: linesOf(F8995_AMOUNTS.map(([k]) => [k, 0] as const)),
      formsRequired: { f8995: required(true) },
    });
    const result = await fillForm("f8995", view, f8995Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P}f1_20[0]`)).toBe("0"); // line 4
    expect(f.get(`${P}f1_29[0]`)).toBe("0"); // line 13
    expect(f.get(`${P}f1_31[0]`)).toBe("0"); // line 15
    expect(f.get(`${P}f1_21[0]`)).toBe(""); // line 5
    expect(f.get(`${T}Row1i[0].f1_05[0]`)).toBe(""); // line 1i
  });

  // Lines 3, 7, 16 and 17 are (loss) lines whose parentheses the form pre-prints: the engine's negative loss prints as its magnitude
  // ("sign: refund"); a zero or positive amount stays blank. Lines 1i(c) and 2 have no printed parentheses and keep the minus sign.
  it("a loss year: 1i and 2 read -9,010, 4 and 15 read 0, line 16 reads 9,010 inside the printed parentheses, 17 stays blank (engine ty2025-1b.6)", async () => {
    const LOSS: ReadonlyArray<readonly [LineKey, number]> = [
      ["f8995.1i", -9010], ["f8995.2", -9010], ["f8995.3", 0], ["f8995.4", 0], ["f8995.5", 0], ["f8995.6", 0], ["f8995.7", 0], ["f8995.8", 0], ["f8995.9", 0],
      ["f8995.10", 0], ["f8995.11", 220025], ["f8995.12", 5557], ["f8995.13", 214468], ["f8995.14", 42894], ["f8995.15", 0], ["f8995.16", -9010], ["f8995.17", 0],
    ];
    const view = viewWith({ lines: linesOf(LOSS), formsRequired: { f8995: required(true, "A qualified business loss of $9,010 is carried forward to 2026: Form 8995 lines 16 and 17 are where the carryforward is recorded.") } });
    expect(formInclusion(f8995Map, view)).toMatchObject({ include: true });
    const result = await fillForm("f8995", view, f8995Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${T}Row1i[0].f1_05[0]`)).toBe("-9,010");
    expect(f.get(`${P}Line2_ReadOrder[0].f1_18[0]`)).toBe("-9,010");
    expect(f.get(`${P}f1_19[0]`)).toBe(""); // line 3
    expect(f.get(`${P}f1_20[0]`)).toBe("0"); // line 4
    expect(f.get(`${P}f1_31[0]`)).toBe("0"); // line 15
    expect(f.get(`${P}f1_32[0]`)).toBe("9,010"); // line 16
    expect(f.get(`${P}f1_33[0]`)).toBe(""); // line 17
  });

  it("carry-in and carry-out lines print the magnitude of a loss and nothing for zero or a positive amount", async () => {
    const mk = (l3: number, l16: number, l7: number, l17: number) =>
      viewWith({ lines: linesOf([["f8995.3", l3], ["f8995.7", l7], ["f8995.16", l16], ["f8995.17", l17]]), formsRequired: { f8995: required(true) } });
    const a = await readAllFields((await fillForm("f8995", mk(-3000, -3000, -400, -300), f8995Map, NO_STAMP)).bytes);
    expect([a.get(`${P}f1_19[0]`), a.get(`${P}f1_32[0]`), a.get(`${P}f1_23[0]`), a.get(`${P}f1_33[0]`)]).toEqual(["3,000", "3,000", "400", "300"]);
    const b = await readAllFields((await fillForm("f8995", mk(0, 0, 0, 0), f8995Map, NO_STAMP)).bytes);
    expect([b.get(`${P}f1_19[0]`), b.get(`${P}f1_32[0]`), b.get(`${P}f1_23[0]`), b.get(`${P}f1_33[0]`)]).toEqual(["", "", "", ""]);
  });

  it("no EKC name in the view: row i name stays blank with an advisory item", async () => {
    const view = viewWith({ lines: linesOf(F8995_AMOUNTS), header: { ekcName: null }, formsRequired: { f8995: required(true) } });
    const result = await fillForm("f8995", view, f8995Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${T}Row1i[0].f1_03[0]`)).toBe("");
    expect(result.openItems.some((o) => o.id === "fill:f8995:header:entity.ekcName")).toBe(true);
  });

  it("a blocked QBI line stays blank and raises a blocking item", async () => {
    const lines = linesOf(F8995_AMOUNTS);
    lines["f8995.15"] = engineLine("f8995.15", null, "missing_input" satisfies RuleStatus, "taxable income not known");
    const view = viewWith({ lines, formsRequired: { f8995: required("blocking") } });
    const result = await fillForm("f8995", view, f8995Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P}f1_31[0]`)).toBe("");
    expect(result.openItems.find((o) => o.id === "blank:f8995:f8995.15")?.severity).toBe("blocking");
  });

  it("omitted when the engine says no QBI deduction", () => {
    const view = viewWith({ lines: linesOf([["f8995.15", 0]]), formsRequired: { f8995: required(false, "No QBI deduction.") } });
    expect(formInclusion(f8995Map, view)).toEqual({ include: false, reason: "the engine reports it is not required: No QBI deduction." });
  });
});

// ── Form 8959 ─────────────────────────────────────────────────────────────────

const F8959_AMOUNTS: ReadonlyArray<readonly [LineKey, number]> = [
  ["f8959.1", 280000],
  ["f8959.4", 280000],
  ["f8959.5", 250000],
  ["f8959.6", 30000],
  ["f8959.7", 270],
  ["f8959.8", 60000],
  ["f8959.9", 250000],
  ["f8959.10", 280000],
  ["f8959.11", 0],
  ["f8959.12", 60000],
  ["f8959.13", 540],
  ["f8959.18", 810],
  ["f8959.19", 4300],
  ["f8959.20", 280000],
  ["f8959.21", 4060],
  ["f8959.22", 240],
  ["f8959.24", 240],
];

const F8959_FIELD: Readonly<Record<string, number>> = {
  "f8959.1": 3,
  "f8959.4": 6,
  "f8959.5": 7,
  "f8959.6": 8,
  "f8959.7": 9,
  "f8959.8": 10,
  "f8959.9": 11,
  "f8959.10": 12,
  "f8959.11": 13,
  "f8959.12": 14,
  "f8959.13": 15,
  "f8959.18": 20,
  "f8959.19": 21,
  "f8959.20": 22,
  "f8959.21": 23,
  "f8959.22": 24,
  "f8959.24": 26,
};

describe("Form 8959 map", () => {
  it("claims every one of the form's 26 fields exactly once", () => assertMapComplete(f8959Map));

  it("every money line is a real engine LINE_KEY and all 24 printed lines are mapped once", () => {
    const real = new Set<string>(LINE_KEYS);
    const keys = f8959Map.lines.flatMap((l) => (l.kind === "money" ? [l.line] : []));
    for (const k of keys) expect(real.has(k), k).toBe(true);
    expect(keys).toEqual(Array.from({ length: 24 }, (_, i) => `f8959.${i + 1}`));
  });

  it("golden read-back of a synthetic required return", async () => {
    const view = viewWith({ lines: linesOf(F8959_AMOUNTS), formsRequired: { f8959: required(true, "Form 8959 is required.") } });
    const expected: Record<string, string> = { [`${P}f1_1[0]`]: "Alex Example and Sam Q Example" };
    for (const [key, amount] of F8959_AMOUNTS) {
      const n = F8959_FIELD[key];
      if (n === undefined) throw new Error(`test table: no field for ${key}`);
      // line 11 is a computed zero but the form says "enter 0": printed
      expected[`${P}f1_${n}[0]`] = amount === 0 ? "0" : amount.toLocaleString("en-US");
    }
    await assertMapGolden(f8959Map, view, expected, NO_STAMP);
  });

  it("the SSN field and the not-applicable railroad / 4137 / 8919 lines stay blank", async () => {
    const lines = linesOf(F8959_AMOUNTS);
    for (const k of ["f8959.2", "f8959.3", "f8959.14", "f8959.15", "f8959.16", "f8959.17", "f8959.23"] as const) {
      lines[k] = engineLine(k, 0, "not_applicable", "No such wages.");
    }
    const view = viewWith({ lines, formsRequired: { f8959: required(true) } });
    const result = await fillForm("f8959", view, f8959Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    // lines 2, 3, 14, 15, 16, 17, 23 are fields f1_4, f1_5, f1_16 ... f1_19, f1_25
    for (const n of [4, 5, 16, 17, 18, 19, 25]) expect(f.get(`${P}f1_${n}[0]`), `f1_${n}`).toBe("");
    expect(f.get(`${P}f1_2[0]`)).toBe("");
    expect(result.blankByDesign.ssn).toBe(1);
  });

  describe("omitted from the packet when the engine reports it not required", () => {
    const notRequiredLines = linesOf(
      (["f8959.7", "f8959.13", "f8959.18", "f8959.24"] as const).map((k) => engineLine(k, 0, "not_applicable", "Below the Additional Medicare Tax thresholds.")),
    );

    it("by the engine's formsRequired verdict (reason shown on the cover, no PDF in the zip)", async () => {
      const view = viewWith({
        lines: notRequiredLines,
        formsRequired: { f8959: required(false, "Form 8959 is not required (below the Additional Medicare Tax thresholds).") },
      });
      const packet = await buildPacket(view, { maps: [f8959Map] });
      expect(Object.keys(unzipSync(packet.zip))).toEqual(["00-cover.pdf"]);
      const entry = packet.forms[0];
      expect(entry?.included).toBe(false);
      expect(entry?.reason).toContain("not required");
    });

    it("by the line-based rule when no verdict is supplied (every mapped line not applicable)", async () => {
      const packet = await buildPacket(viewWith({ lines: notRequiredLines }), { maps: [f8959Map] });
      expect(Object.keys(unzipSync(packet.zip))).toEqual(["00-cover.pdf"]);
    });

    it("the engine's verdict wins even when a mapped line carries an amount", () => {
      const view = viewWith({ lines: linesOf([["f8959.18", 500]]), formsRequired: { f8959: required(false, "not required") } });
      expect(formInclusion(f8959Map, view).include).toBe(false);
    });

    it("included (and filled) when required", async () => {
      const view = viewWith({ lines: linesOf(F8959_AMOUNTS), formsRequired: { f8959: required(true, "Form 8959 is required.") } });
      const packet = await buildPacket(view, { maps: [f8959Map] });
      const names = Object.keys(unzipSync(packet.zip));
      expect(names).toEqual(["00-cover.pdf", "01-f8959.pdf"]);
    });
  });
});

// ── Against the REAL engine output ───────────────────────────────────────────

describe("T3 maps against the real engine output", () => {
  const ret = computeTy2025Return(fullFacts());
  const view = viewFromEngine(ret, { header: { ekcName: "Example Consulting, LLC" } });

  it("Form 8995: the engine's QBI lines land on the printed lines", async () => {
    const result = await fillForm("f8995", view, f8995Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    const fmt = (key: LineKey): string => {
      const l = ret.lines[key];
      if (!l || l.amount === null) throw new Error(`engine did not compute ${key}`);
      return l.amount.toLocaleString("en-US");
    };
    expect(f.get(`${T}Row1i[0].f1_05[0]`)).toBe(fmt("f8995.1i"));
    expect(f.get(`${P}f1_21[0]`)).toBe(fmt("f8995.5"));
    expect(f.get(`${P}f1_27[0]`)).toBe(fmt("f8995.11"));
    expect(f.get(`${P}f1_31[0]`)).toBe(fmt("f8995.15"));
    expect(f.get(`${T}Row1i[0].f1_03[0]`)).toBe("Example Consulting, LLC");
    expect(f.get(`${T}Row1i[0].f1_04[0]`)).toBe("");
  });

  it("the packet follows the engine's formsRequired verdicts: 8995 in, 8959 and Schedule B out", async () => {
    expect(ret.formsRequired.f8995?.required).toBe(true);
    expect(ret.formsRequired.f8959?.required).toBe(false);
    expect(ret.formsRequired.schb?.required).toBe(false);
    const packet = await buildPacket(view, { maps: [schBMap, f8995Map, f8959Map] });
    const names = packet.files.map((x) => x.name);
    expect(names).toEqual(["00-cover.pdf", "01-f8995.pdf"]);
    const omitted = packet.forms.filter((x) => !x.included).map((x) => x.formId).sort();
    expect(omitted).toEqual(["f1040sb", "f8959"]);
    for (const o of packet.forms.filter((x) => !x.included)) expect(o.reason).toContain("not required");
  });
});
