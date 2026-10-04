import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { OVERFLOW_LABEL, fillForm } from "@/lib/tax2025/pdf/fill";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import { engineLine, linesOf, payerRows, required, sumAmounts, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS, assertMapComplete, assertMapGolden, readAllFields } from "./tax2025-pdf-harness";

const P = "topmostSubform[0].Page1[0].";
const INTEREST_NAME = (i: number): string => (i === 1 ? `${P}Line1_ReadOrder[0].f1_03[0]` : `${P}f1_${String(3 + 2 * (i - 1)).padStart(2, "0")}[0]`);
const INTEREST_AMT = (i: number): string => `${P}f1_${String(4 + 2 * (i - 1)).padStart(2, "0")}[0]`;
const DIV_NAME = (i: number): string => (i === 1 ? `${P}ReadOrderControl[0].f1_34[0]` : `${P}f1_${34 + 2 * (i - 1)}[0]`);
const DIV_AMT = (i: number): string => `${P}f1_${35 + 2 * (i - 1)}[0]`;

function scheduleBView(nInterest: number, nDividends: number, extra: Parameters<typeof viewWith>[0] = {}) {
  const interest = payerRows(nInterest, "Interest");
  const dividends = payerRows(nDividends, "Dividend");
  const i = sumAmounts(interest);
  const d = sumAmounts(dividends);
  return {
    view: viewWith({
      lines: linesOf([engineLine("schb.2", i), engineLine("schb.3", 0), engineLine("schb.4", i), engineLine("schb.6", d)]),
      tables: { "schb.interest": interest, "schb.dividends": dividends },
      formsRequired: { schb: required(true, "Interest or ordinary dividends exceed the Schedule B threshold.") },
      ...extra,
    }),
    interest,
    dividends,
    i,
    d,
  };
}

const num = (v: string | boolean | undefined): number => Number(String(v ?? "").replace(/,/g, ""));

describe("Schedule B map", () => {
  it("claims every one of the form's 72 fields exactly once", () => {
    assertMapComplete(schBMap);
  });

  it("every money line is a real engine LINE_KEY (not pending)", () => {
    const real = new Set<string>(LINE_KEYS);
    for (const l of schBMap.lines) if (l.kind === "money") expect(real.has(l.line), l.line).toBe(true);
  });

  it("table shape: 14 interest rows and 15 dividend rows, every field distinct", () => {
    const [interest, dividends] = schBMap.tables;
    expect(interest?.rows).toHaveLength(14);
    expect(dividends?.rows).toHaveLength(15);
    const all = schBMap.tables.flatMap((t) => t.rows.flatMap((r) => Object.values(r)));
    expect(new Set(all).size).toBe(all.length);
    expect(interest?.rows[13]?.amount).toBe(INTEREST_AMT(14));
    expect(dividends?.rows[14]?.amount).toBe(DIV_AMT(15));
  });

  it("golden read-back: payer rows, totals, names; SSN, countries and every other field empty", async () => {
    const { view } = scheduleBView(2, 1);
    const result = await assertMapGolden(
      schBMap,
      view,
      {
        [`${P}f1_01[0]`]: "Alex Example and Sam Q Example",
        [INTEREST_NAME(1)]: "Interest 1 Bank",
        [INTEREST_AMT(1)]: "107",
        [INTEREST_NAME(2)]: "Interest 2 Bank",
        [INTEREST_AMT(2)]: "207",
        [`${P}f1_31[0]`]: "314", // line 2 = 107 + 207
        // line 3 is a computed zero on a detail line: blank
        [`${P}f1_33[0]`]: "314", // line 4
        [DIV_NAME(1)]: "Dividend 1 Bank",
        [DIV_AMT(1)]: "107",
        [`${P}f1_64[0]`]: "107", // line 6
      },
      { ...DEFAULT_FILL_OPTIONS, stamp: false },
    );
    expect(result.continuations).toEqual([]);
    expect(result.blankByDesign.ssn).toBe(1);
  });

  it("Part III Yes/No boxes stay unchecked with an 'Answer needed' item until the attestation exists", async () => {
    const { view } = scheduleBView(1, 1);
    const result = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    for (const box of [`${P}TagcorrectingSubform[0].c1_1[0]`, `${P}TagcorrectingSubform[0].c1_1[1]`, `${P}c1_2[0]`, `${P}c1_2[1]`, `${P}c1_3[0]`, `${P}c1_3[1]`]) {
      expect(fields.get(box), box).toBe(false);
    }
    const ids = result.openItems.map((o) => o.id);
    expect(ids).toContain("fill:f1040sb:answer:foreignAccounts");
    expect(ids).toContain("fill:f1040sb:answer:foreignTrust");
    // The conditional FinCEN 114 question raises no item of its own.
    expect(ids).not.toContain("fill:f1040sb:answer:fincenRequired");
    for (const item of result.openItems.filter((o) => o.id.includes(":answer:"))) expect(item.message).toMatch(/Answer needed/);
  });

  it("answers fill exactly the matching box and clear the open item", async () => {
    const { view } = scheduleBView(1, 1, { answers: { filingStatus: "mfj", foreignAccounts: "no", foreignTrust: "no" } });
    const result = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(`${P}TagcorrectingSubform[0].c1_1[0]`)).toBe(false);
    expect(fields.get(`${P}TagcorrectingSubform[0].c1_1[1]`)).toBe(true); // 7a No
    expect(fields.get(`${P}c1_3[0]`)).toBe(false);
    expect(fields.get(`${P}c1_3[1]`)).toBe(true); // 8 No
    expect(fields.get(`${P}c1_2[0]`)).toBe(false);
    expect(fields.get(`${P}c1_2[1]`)).toBe(false);
    expect(result.openItems.some((o) => o.id.includes(":answer:"))).toBe(false);
  });

  describe("table overflow policy (interest capacity 14, dividends capacity 15)", () => {
    for (const n of [0, 1, 14, 15, 16]) {
      it(`${n} interest payers: printed rows add up to the engine total; overflow adds a continuation list`, async () => {
        const { view, interest, i } = scheduleBView(n, 0);
        const result = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
        const f = await readAllFields(result.bytes);
        let printed = 0;
        let rowsWithAmount = 0;
        for (let k = 1; k <= 14; k++) {
          const amount = f.get(INTEREST_AMT(k));
          if (amount !== "") rowsWithAmount += 1;
          printed += num(amount);
        }
        expect(printed, "sum of printed interest amounts").toBe(i);
        expect(num(f.get(`${P}f1_31[0]`)), "line 2 equals the engine's total").toBe(i);
        expect(rowsWithAmount).toBe(Math.min(n, 14));
        if (n <= 14) {
          for (let k = 1; k <= n; k++) {
            expect(f.get(INTEREST_NAME(k))).toBe(`Interest ${k} Bank`);
            expect(num(f.get(INTEREST_AMT(k)))).toBe(100 * k + 7);
          }
          expect(result.continuations).toEqual([]);
        } else {
          for (let k = 1; k <= 13; k++) expect(f.get(INTEREST_NAME(k))).toBe(`Interest ${k} Bank`);
          expect(f.get(INTEREST_NAME(14))).toBe(OVERFLOW_LABEL);
          const rest = interest.slice(13);
          expect(num(f.get(INTEREST_AMT(14)))).toBe(sumAmounts(rest));
          expect(result.continuations).toHaveLength(1);
          const c = result.continuations[0]!;
          expect(c.table).toBe("schb.interest");
          expect(c.rows).toHaveLength(n);
          expect(result.openItems.some((o) => o.id === "fill:f1040sb:schb.interest:overflow")).toBe(true);
        }
      });

      it(`${n} dividend payers: printed rows add up to the engine total; overflow adds a continuation list`, async () => {
        const { view, dividends, d } = scheduleBView(0, n);
        const result = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
        const f = await readAllFields(result.bytes);
        let printed = 0;
        for (let k = 1; k <= 15; k++) printed += num(f.get(DIV_AMT(k)));
        expect(printed, "sum of printed dividend amounts").toBe(d);
        expect(num(f.get(`${P}f1_64[0]`))).toBe(d);
        if (n <= 15) {
          for (let k = 1; k <= n; k++) expect(f.get(DIV_NAME(k))).toBe(`Dividend ${k} Bank`);
          expect(result.continuations).toEqual([]);
        } else {
          expect(f.get(DIV_NAME(15))).toBe(OVERFLOW_LABEL);
          expect(num(f.get(DIV_AMT(15)))).toBe(sumAmounts(dividends.slice(14)));
          expect(result.continuations).toHaveLength(1);
          expect(result.continuations[0]!.table).toBe("schb.dividends");
          expect(result.continuations[0]!.rows).toHaveLength(n);
        }
      });
    }

    it("15 interest payers overflow (capacity 14) while 15 dividend payers fit (capacity 15)", async () => {
      const { view } = scheduleBView(15, 15);
      const result = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
      expect(result.continuations.map((c) => c.table)).toEqual(["schb.interest"]);
    });

    it("the cover carries the full continuation list of an overflowing table", async () => {
      const { view, interest } = scheduleBView(16, 3);
      const packet = await buildPacket(view, { maps: [schBMap] });
      expect(packet.continuations).toHaveLength(1);
      const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: packet.continuations, stamp: true });
      const text = model.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");
      expect(text).toContain("Continuation: schb.interest (f1040sb), all 16 rows");
      for (const row of interest) expect(text).toContain(String(row.cells.payer));
    });
  });

  it("a payer name that looks like an SSN is refused, never written", async () => {
    const view = viewWith({
      lines: linesOf([engineLine("schb.2", 100)]),
      tables: { "schb.interest": [{ cells: { payer: "123-45-6789", amount: 100 } }] },
      formsRequired: { schb: required(true) },
    });
    const result = await fillForm("f1040sb", view, schBMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(INTEREST_NAME(1))).toBe("");
    expect(result.openItems.some((o) => o.id.includes("ssnlike"))).toBe(true);
  });

  describe("inclusion follows the engine's formsRequired verdict", () => {
    it("omitted when the engine reports it not required (cover lists the reason; no PDF)", async () => {
      const view = viewWith({
        lines: linesOf([engineLine("schb.2", 900), engineLine("schb.6", 0)]),
        formsRequired: { schb: required(false, "Interest and dividends are under the Schedule B threshold.") },
      });
      const inc = formInclusion(schBMap, view);
      expect(inc.include).toBe(false);
      expect(inc.reason).toContain("under the Schedule B threshold");
      const packet = await buildPacket(view, { maps: [schBMap] });
      expect(packet.files.map((f) => f.name)).toEqual(["00-cover.pdf"]);
      expect(packet.forms[0]?.included).toBe(false);
    });

    it("included when required, and when the engine cannot tell yet (blocking)", () => {
      const lines = linesOf([engineLine("schb.2", 900)]);
      expect(formInclusion(schBMap, viewWith({ lines, formsRequired: { schb: required(true) } })).include).toBe(true);
      expect(formInclusion(schBMap, viewWith({ lines, formsRequired: { schb: required("blocking") } })).include).toBe(true);
    });

    it("without a verdict the line-based rule decides (computed non-zero => included)", () => {
      expect(formInclusion(schBMap, viewWith({ lines: linesOf([engineLine("schb.2", 1600)]) })).include).toBe(true);
      expect(formInclusion(schBMap, viewWith({ lines: linesOf([engineLine("schb.2", 0)]) })).include).toBe(false);
    });
  });
});
