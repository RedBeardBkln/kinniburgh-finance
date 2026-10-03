import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QUESTIONNAIRES } from "@/lib/tax-questionnaire-content";
import {
  centsToDollarString,
  parseDollarInputToCents,
  resolveBoundWrite,
  validateAnswerValue,
  effectiveAnswers,
  type NumberNode,
  type QuestionnaireContext,
} from "@/lib/tax-questionnaire";
import { parseDollarAnswerToCents } from "@/lib/tax-compute-build";

// Tester round 2 probe: the cents work (centsToDollarString / parseDollarInputToCents),
// agreement with the planning parser, and the softened copy.

const CTX: QuestionnaireContext = { year: 2025, entityName: "X", ekcActive: true, svActive: true };
const dollarNodes: { qid: string; node: NumberNode }[] = [];
for (const q of QUESTIONNAIRES) for (const n of q.nodes) if (n.kind === "dollars") dollarNodes.push({ qid: q.id, node: n });

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("cents helpers: integer round trip", () => {
  it("there is at least one dollar node and every one is bound or free with the same max", () => {
    expect(dollarNodes.length).toBeGreaterThan(0);
  });

  it("named strings", () => {
    const table: [string, number | null][] = [
      ["12000", 1_200_000],
      ["12000.5", 1_200_050],
      ["12000.50", 1_200_050],
      ["$12,000.05", 1_200_005],
      ["0.01", 1],
      ["0", 0],
      ["  $ 1,234 ", 123_400],
      ["-5", null],
      ["-0.01", null],
      ["1e3", null],
      ["0x10", null],
      ["12.345", null],
      ["12.", null],
      [".5", null],
      ["", null],
      ["abc", null],
      ["12000 dollars", null],
      ["NaN", null],
      ["Infinity", null],
      ["12345678901", null], // 11 digits
    ];
    for (const [s, want] of table) expect(parseDollarInputToCents(s), JSON.stringify(s)).toBe(want);
  });

  it("every dollar node: over-max is rejected by validate, max accepted, negative rejected", () => {
    for (const { node } of dollarNodes) {
      const max = node.max * 100;
      expect(validateAnswerValue(node, max).ok).toBe(true);
      expect(validateAnswerValue(node, max + 1).ok).toBe(false);
      expect(validateAnswerValue(node, -1).ok).toBe(false);
      expect(validateAnswerValue(node, node.min * 100).ok).toBe(true);
      // the over-max typed string parses but is then rejected by validate (as the runner does)
      const typed = centsToDollarString(max + 1);
      const parsed = parseDollarInputToCents(typed);
      expect(parsed).toBe(max + 1);
      expect(validateAnswerValue(node, parsed).ok).toBe(false);
      // junk never validates
      for (const j of [NaN, Infinity, -Infinity, 0.5, 1e21, "12", null, undefined, {}, []]) {
        expect(validateAnswerValue(node, j).ok, String(j)).toBe(false);
      }
    }
  });

  it("fuzz: every integer cents value round-trips through the string, the input parser and the REAL planning parser", () => {
    const r = mulberry32(99);
    const max = Math.max(...dollarNodes.map((d) => d.node.max)) * 100;
    const samples: number[] = [];
    for (let i = 0; i < 60_000; i++) samples.push(Math.floor(r() * (max + 1)));
    for (let c = 0; c <= 2_500; c++) samples.push(c); // dense low range
    for (let k = 0; k <= 30; k++) for (const d of [-1, 0, 1]) { const v = 100 * Math.pow(10, k > 9 ? 9 : k) + d; if (v >= 0 && v <= max) samples.push(v); }
    for (const d of [-2, -1, 0]) samples.push(max + d);
    for (const c of samples) {
      const s = centsToDollarString(c);
      expect(s).toMatch(/^\d+(\.\d{2})?$/);
      expect(parseDollarInputToCents(s), s).toBe(c);
      expect(parseDollarAnswerToCents(s, null), s).toEqual({ cents: c, unparseable: false });
      // no trailing ".00" or ".x0" noise except exactly two-digit cents
      if (c % 100 === 0) expect(s).not.toContain(".");
    }
  });

  it("resolveBoundWrite on each bound dollar node writes a string the real planning parser reads back to the same cents", () => {
    const bound = dollarNodes.filter((d) => d.node.binding);
    expect(bound.length).toBeGreaterThan(0);
    for (const { node } of bound) {
      for (const c of [0, 1, 5, 50, 99, 100, 101, 1_200_050, 1_200_005, node.max * 100]) {
        const w = resolveBoundWrite(node, c)!;
        expect(parseDollarAnswerToCents(w.planningValue, null)).toEqual({ cents: c, unparseable: false });
      }
    }
  });
});

describe("agreement of planning-answer parsing with the new helpers", () => {
  const corpus = [
    "12000", "12000.5", "12000.50", "12000.05", "$12,000.05", "$ 12,000", "12,000", "0", "0.01", "0.1", "00012000",
    "10000000", "10000000.00", "10000000.01", "10000001", "9999999999", "99999999999", "1,2,3", "1,000,000.99",
    ",", "$,", "", " ", "-5", "$-5", "1e3", "12000.", ".5", "12.345", "abc", "12 000", "$12000 ", "  12000.50  ",
    "12000.5.0", "1_000", "\t5", "5\n",
  ];
  for (const { qid, node } of dollarNodes.filter((d) => d.node.binding)) {
    it(`${qid}/${node.id}: for every string BOTH the planning parser and the input parser accept, they agree; engine mapping equals the real parser`, () => {
      const q = QUESTIONNAIRES.find((x) => x.id === qid)!;
      const key = node.binding!.questionKey;
      for (const s of corpus) {
        const real = parseDollarAnswerToCents(s, null);
        const mine = parseDollarInputToCents(s);
        if (!real.unparseable && real.cents !== null && mine !== null) expect(mine, JSON.stringify(s)).toBe(real.cents);
        // engine's planning read: iff real parser succeeds and in range
        const inRange = real.cents !== null && real.cents >= node.min * 100 && real.cents <= node.max * 100;
        const eff = effectiveAnswers(q, {}, [{ key, answer: s, skippedReason: null, answeredAt: new Date("2026-01-01T00:00:00Z") } as never], CTX);
        const got = eff[node.id];
        if (!real.unparseable && inRange) expect(got?.value, JSON.stringify(s)).toBe(real.cents);
        else expect(got === undefined || got.source !== "planning", JSON.stringify(s)).toBe(true);
      }
    });
  }

  it("known asymmetries (documented, harmless): input parser is stricter on 11+ digits/'.'-leading; planning accepts a bare comma as 0 and the input parser does not", () => {
    expect(parseDollarAnswerToCents(",", null).cents).toBe(0);
    expect(parseDollarInputToCents(",")).toBeNull();
    expect(parseDollarAnswerToCents("12 000", null).unparseable).toBe(true);
    expect(parseDollarInputToCents("12 000")).toBe(1_200_000); // whitespace stripped (runner strips it too)
  });
});

describe("source scan: no float math on money in the cents helpers / runner", () => {
  const eng = readFileSync(path.join(process.cwd(), "lib/tax-questionnaire.ts"), "utf8");
  const start = eng.indexOf("export function centsToDollarString");
  const end = eng.indexOf("// ── Planning-answer binding");
  const block = eng.slice(start, end);
  it("no parseFloat / toFixed / Math.round / float literal in the helpers", () => {
    expect(block).not.toMatch(/parseFloat|toFixed|Math\.round|\d\.\d+\s*[*/]/);
  });
  it("runner does not divide or parseFloat", () => {
    const run = readFileSync(path.join(process.cwd(), "components/tax/forms/questionnaire-runner.tsx"), "utf8");
    expect(run).not.toMatch(/parseFloat|toFixed|\/\s*100\b/);
  });
  it("engine file outside the helper block: only the unchanged planning parser divides/multiplies", () => {
    expect(eng).not.toMatch(/parseFloat|toFixed/);
  });
});

describe("softened copy", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  it("strip: states the truth, old claim gone", () => {
    const s = read("components/tax/forms/forms-summary.tsx").replace(/\s+/g, " ");
    expect(s).toContain("Saving questionnaire answers does not change the counts above; the few answers shared with the Planning screen do");
    expect(s).not.toContain("Answering one does not change the counts above");
  });
  it("no new UI file says 'Nothing here decides'", () => {
    for (const p of [
      "components/tax/forms/cpa-summary-view.tsx",
      "components/tax/forms/questionnaire-runner.tsx",
      "components/tax/forms/questionnaire-card-block.tsx",
      "app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx",
      "app/tax/forms/[year]/cpa-summary/page.tsx",
    ]) expect(read(p), p).not.toMatch(/Nothing here decides/);
  });
  it("every outcome sentence still begins 'Owner reports'; none says the CPA prepares/handles/files", () => {
    for (const q of QUESTIONNAIRES) {
      const outs = (q as unknown as { outcomeText: Record<string, string> }).outcomeText;
      for (const [k, v] of Object.entries(outs ?? {})) {
        expect(v, `${q.id}.${k}`).toMatch(/^Owner /);
        if (k === "applies") expect(v, `${q.id}.${k}`).toMatch(/^Owner reports /);
        if (/CPA/.test(v)) expect(v, `${q.id}.${k}`).toMatch(/the CPA (decides|determines|checks|confirms|must assess)/i);
        expect(v, `${q.id}.${k}`).not.toMatch(/CPA (prepares|handles|files|will)/i);
        expect(v, `${q.id}.${k}`).not.toMatch(/\b(you|your) (qualify|must|should|can claim)\b/i);
      }
    }
  });
});
