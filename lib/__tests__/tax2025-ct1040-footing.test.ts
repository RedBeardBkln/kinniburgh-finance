// CT-1040 footing (ty2025-ct1040-derived-lines): for several fact patterns, every line the form tells the filer to compute
// from other lines equals that computation, BOTH on the engine's lines and on the fields printed in the filled PDF.
// A blank printed field counts as 0 only where the engine line is computed or not_applicable (otherwise the line is blocked
// and an open item must say why: never a silent 0).
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { PENDING_LINE_KEYS } from "@/lib/tax2025/pdf/pending-line-keys";
import { ctPropertyTaxPhaseOutDecimal } from "@/lib/tax2025/rules/ct";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { D, roundLine } from "@/lib/tax2025/money";
import { hasAmount, missingLeaf, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { bill, fullFacts, owner } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields, type FieldValue } from "./tax2025-pdf-harness";

const OPTS = { generatedAt: "2026-10-04T12:00:00.000Z", generatedBy: "Footing Test" } as const;
const cents = (dollars: number): number => Math.round(dollars * 100);

// ── Fact patterns ───────────────────────────────────────────────────────────────

interface Shape {
  /** The CT AGI to hit (a stated CT Schedule 1 addition / subtraction moves federal AGI there). */
  ctAgi?: number;
  /** CT withholding minus CT-1040 line 14 (negative = tax due). Default +982: Eric's overpayment. */
  withheldMinusTax?: number;
  /** Applied before the tax is figured (changes the numbers: property tax bills, use tax ...). */
  tweak?: (f: Ty2025Facts) => void;
  /** Applied after the withholding is set (blocks lines without changing the numbers the withholding was sized from). */
  afterTweak?: (f: Ty2025Facts) => void;
}

function wholeDollars(ret: Ty2025Return, key: LineKey): number {
  const l = ret.lines[key];
  if (!l || !hasAmount(l.status) || l.amount === null) throw new Error(`${key} is not computed (${l?.status ?? "absent"}: ${l?.reason ?? ""})`);
  return l.amount;
}

function shapedFacts(shape: Shape = {}): Ty2025Facts {
  const f = fullFacts();
  shape.tweak?.(f);
  if (shape.ctAgi !== undefined) {
    const fed = wholeDollars(computeTy2025Return(f), "f1040.11a");
    const diff = fed - shape.ctAgi;
    if (diff >= 0) f.ct.subtractions = owner(cents(diff));
    else f.ct.additions = owner(cents(-diff));
  }
  const line14 = wholeDollars(computeTy2025Return(f), "ct1040.14");
  const withheld = Math.max(0, line14 + (shape.withheldMinusTax ?? 982));
  const [first, second] = f.income.w2s;
  if (!first || !second) throw new Error("fixture has two W-2s");
  first.ctWithheldCents = cents(withheld);
  second.ctWithheldCents = 0;
  shape.afterTweak?.(f);
  return f;
}

// ── The footing helper ──────────────────────────────────────────────────────────

/** engine key -> printed field suffix (ct1040.<suffix>) for every single-field line the footing reads. */
const FIELD: Partial<Record<LineKey, string>> = {
  "ct1040.1": "l1",
  "ct1040.additions": "l2",
  "ct1040.3": "l3",
  "ct1040.subtractions": "l4",
  "ct1040.ctAgi": "l5",
  "ct1040.6": "l6",
  "ct1040.7": "l7",
  "ct1040.8": "l8",
  "ct1040.9": "l9",
  "ct1040.10": "l10",
  "ct1040.11": "l11",
  "ct1040.12": "l12",
  "ct1040.13": "l13",
  "ct1040.14": "l14",
  "ct1040.15": "l15",
  "ct1040.16": "l16",
  "ct1040.17": "l17",
  "ct1040.18": "l18",
  "ct1040.19": "l19",
  "ct1040.20": "l20",
  "ct1040.20a": "l20a",
  "ct1040.20b": "l20b",
  "ct1040.20c": "l20c",
  "ct1040.20d": "l20d",
  "ct1040.21": "l21",
  "ct1040.22": "l22",
  "ct1040.25": "l25",
  "ct1040.26": "l26",
  "ct1040.27": "l27",
  "ct1040.28": "l28",
  "ct1040.29": "l29",
  "ct1040.30": "l30",
  "ct1040.s3.63": "l63",
  "ct1040.s3.65": "l65",
  "ct1040.s3.67": "l67",
  "ct1040.s4.69b": "l69b",
};

const SCH1_ADD_FIELDS = ["l31", "l32", "l33", "l34", "l35", "l36", "l36a", "l37"];
const SCH1_SUB_FIELDS = ["l39", "l40", "l41", "l42", "l43", "l44", "l45", "l46", "l47", "l48", "l48a", "l48b", "l48c", "l48d", "l49"];

interface Built {
  ret: Ty2025Return;
  fields: Map<string, FieldValue>;
  itemIds: string[];
  viewItemIds: string[];
}

async function build(facts: Ty2025Facts): Promise<Built> {
  const ret = computeTy2025Return(facts);
  const view = toPdfReturnView(ret, facts, OPTS);
  const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
  return { ret, fields: await readAllFields(res.bytes), itemIds: res.openItems.map((i) => i.id), viewItemIds: view.openItems.map((i) => i.id) };
}

function printedNumber(fields: Map<string, FieldValue>, field: string): number | null {
  const v = fields.get(`ct1040.${field}`);
  if (typeof v !== "string" || v === "") return null;
  return Number(v.replace(/,/g, ""));
}

/** Asserts every CT-1040 relation on the engine lines and on the printed fields; returns nothing. */
function assertCt1040Foots(b: Built): void {
  const { ret, fields } = b;
  const eng = (key: LineKey): number | null => {
    const l = ret.lines[key];
    return l !== undefined && hasAmount(l.status) && l.amount !== null ? l.amount : null;
  };
  /** What a reader of the printed form takes the line to be: the printed number, 0 for a blank computed / not_applicable line, null when blocked. */
  const printed = (key: LineKey): number | null => {
    const field = FIELD[key];
    if (field === undefined) throw new Error(`no field for ${key}`);
    const p = printedNumber(fields, field);
    if (p !== null) return p;
    return eng(key) !== null ? 0 : null;
  };

  // 1. printed = engine on every mapped line; a non-zero line is never blank, a blank line is computed 0 / not_applicable, or blocked with an item
  for (const key of Object.keys(FIELD) as LineKey[]) {
    const e = eng(key);
    const p = printedNumber(fields, FIELD[key] ?? "");
    if (e === null) {
      expect(p, `${key} is blocked: its field stays blank`).toBeNull();
      expect(b.itemIds.includes(`blank:ct1040:${key}`), `${key} is blank and blocked: an item must say why`).toBe(true);
    } else if (e !== 0) {
      expect(p, `${key} prints its amount`).toBe(e);
    } else {
      expect(p === null || p === 0, `${key} is 0: blank or 0`).toBe(true);
    }
  }

  // 2. the form's own arithmetic, read twice (engine, then printed); a relation is checked only when every part has a value
  const relations: Array<[string, LineKey, LineKey[], (v: number[]) => number]> = [
    ["L3 = L1 + L2", "ct1040.3", ["ct1040.1", "ct1040.additions"], (v) => v[0]! + v[1]!],
    ["L5 = L3 - L4", "ct1040.ctAgi", ["ct1040.3", "ct1040.subtractions"], (v) => v[0]! - v[1]!],
    ["L8 = max(0, L6 - L7)", "ct1040.8", ["ct1040.6", "ct1040.7"], (v) => Math.max(0, v[0]! - v[1]!)],
    ["L10 = L8 + L9", "ct1040.10", ["ct1040.8", "ct1040.9"], (v) => v[0]! + v[1]!],
    ["L12 = max(0, L10 - L11)", "ct1040.12", ["ct1040.10", "ct1040.11"], (v) => Math.max(0, v[0]! - v[1]!)],
    ["L14 = max(0, L12 - L13)", "ct1040.14", ["ct1040.12", "ct1040.13"], (v) => Math.max(0, v[0]! - v[1]!)],
    ["L16 = L14 + L15", "ct1040.16", ["ct1040.14", "ct1040.15"], (v) => v[0]! + v[1]!],
    ["L17 = L16", "ct1040.17", ["ct1040.16"], (v) => v[0]!],
    [
      "L21 = L18 + L19 + L20 + L20a-d",
      "ct1040.21",
      ["ct1040.18", "ct1040.19", "ct1040.20", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"],
      (v) => v.reduce((a, x) => a + x, 0),
    ],
    ["L22 = max(0, L21 - L17)", "ct1040.22", ["ct1040.21", "ct1040.17"], (v) => Math.max(0, v[0]! - v[1]!)],
    ["L26 = max(0, L17 - L21)", "ct1040.26", ["ct1040.17", "ct1040.21"], (v) => Math.max(0, v[0]! - v[1]!)],
    ["L30 = L26 + L27 + L28 + L29", "ct1040.30", ["ct1040.26", "ct1040.27", "ct1040.28", "ct1040.29"], (v) => v.reduce((a, x) => a + x, 0)],
  ];
  for (const [name, out, ins, fn] of relations) {
    for (const [who, read] of [["engine", eng], ["printed", printed]] as const) {
      const o = read(out);
      const parts = ins.map((k) => read(k));
      if (o === null || parts.some((p) => p === null)) continue;
      expect(o, `${who}: ${name}`).toBe(fn(parts as number[]));
    }
  }
  // the signed headline: balance = L26 - L22, and at most one of L22 / L26 prints
  const bal = eng("ct1040.balance" as LineKey);
  const l22 = eng("ct1040.22");
  const l26 = eng("ct1040.26");
  if (bal !== null && l22 !== null && l26 !== null) expect(bal).toBe(l26 - l22);
  expect((printedNumber(fields, "l22") ?? 0) === 0 || (printedNumber(fields, "l26") ?? 0) === 0, "at most one of L22 / L26 prints").toBe(true);

  // 3. withholding schedule: the printed rows 18a-18e add to the printed 18 (this fixture has at most 5 rows)
  const rows = ["l18a", "l18b", "l18c", "l18d", "l18e"].map((f) => printedNumber(fields, f) ?? 0);
  expect(rows.reduce((a, x) => a + x, 0), "rows 18a-18e add to line 18").toBe(printedNumber(fields, "l18") ?? 0);

  // 4. Schedule 1 totals equal their printed detail lines
  const sum = (names: string[]): number => names.reduce((a, n) => a + (printedNumber(fields, n) ?? 0), 0);
  if (eng("ct1040.additions") !== null) expect(printedNumber(fields, "l38") ?? 0, "line 38 = lines 31-37").toBe(sum(SCH1_ADD_FIELDS));
  if (eng("ct1040.subtractions") !== null) expect(printedNumber(fields, "l50") ?? 0, "line 50 = lines 39-49").toBe(sum(SCH1_SUB_FIELDS));

  // 5. Schedule 3: blank entirely when 63 is not_applicable; otherwise rows add to 63, 65 = min(63, 300), 67 = round(65 x decimal), 68 = 65 - 67 (capped by line 10)
  const s3 = ret.lines["ct1040.s3.63"];
  const rowTotal = ["l60", "l61", "l62"].reduce((a, n) => a + (printedNumber(fields, n) ?? 0), 0);
  if (s3?.status === "not_applicable") {
    for (const n of ["l60", "l60d", "l61", "l61d", "l62", "l62d", "l63", "l65", "l67", "l68"]) expect(printedNumber(fields, n) ?? 0, `Schedule 3 ${n} is blank`).toBe(0);
    expect(fields.get("ct1040.l60d") ?? "").toBe("");
    expect(eng("ct1040.11")).toBe(0);
    expect(b.viewItemIds).toContain("adapter:ct.schedule3-blank");
  } else if (s3 !== undefined && hasAmount(s3.status)) {
    const l63 = eng("ct1040.s3.63") ?? 0;
    expect(rowTotal, "printed rows 60-62 add to line 63").toBe(l63);
    const l65 = Math.min(l63, 300);
    expect(eng("ct1040.s3.65")).toBe(l65);
    const ctAgi = eng("ct1040.ctAgi");
    if (ctAgi !== null) {
      const l67 = roundLine(D(l65).times(ctPropertyTaxPhaseOutDecimal(D(ctAgi)))).toNumber();
      expect(eng("ct1040.s3.67")).toBe(l67);
      const l10 = eng("ct1040.10") ?? 0;
      expect(eng("ct1040.11"), "line 11 = line 68 = 65 - 67, not more than line 10").toBe(Math.min(l65 - l67, l10));
      expect(printedNumber(fields, "l68") ?? 0).toBe(eng("ct1040.11"));
    }
  }

  // 6. Schedule 4: 69 = 69a + 69b + 69c + 69d = line 15 (a stated total has no breakdown: 69a-d blank, advisory item)
  const l15 = eng("ct1040.15");
  if (l15 !== null && l15 !== 0) {
    const detail = sum(["l69a", "l69b", "l69c", "l69d"]);
    if (detail !== 0) expect(detail, "line 69 = 69a + 69b + 69c + 69d").toBe(l15);
    else expect(b.ret.openItems.some((i) => i.id === "info:ct1040.s4.69b"), "stated use tax without a breakdown has an advisory item").toBe(true);
  }

  // 7. a pending key is never used by the CT-1040 map
  for (const entry of ct1040Map.lines) if (entry.kind === "money") expect((PENDING_LINE_KEYS as readonly string[]).includes(entry.line), entry.line).toBe(false);
}

const itemSeverity = (ret: Ty2025Return, id: string): string | undefined => ret.openItems.find((i) => i.id === id)?.severity;

// ── The twelve fact patterns ────────────────────────────────────────────────────

describe("CT-1040 footing (plan 8.1)", () => {
  it("1. overpayment (the Eric shape: CT AGI 270,980, withholding 982 over the tax)", async () => {
    const b = await build(shapedFacts({ ctAgi: 270980, withheldMinusTax: 982 }));
    assertCt1040Foots(b);
    const { ret, fields } = b;
    expect(wholeDollars(ret, "ct1040.ctAgi")).toBe(270980);
    expect(wholeDollars(ret, "ct1040.22")).toBe(982);
    expect(wholeDollars(ret, "ct1040.26")).toBe(0);
    expect(wholeDollars(ret, "ct1040.balance" as LineKey)).toBe(-982);
    expect(printedNumber(fields, "l22")).toBe(982);
    expect(printedNumber(fields, "l26")).toBeNull();
    // every derived line prints: 3 / 8 / 12 / 14 / 16 / 17 / 21 are filled, with the right amounts
    const tax = wholeDollars(ret, "ct1040.6");
    for (const f of ["l3", "l5"]) expect(printedNumber(fields, f)).toBe(270980);
    for (const f of ["l6", "l8", "l10", "l12", "l14", "l16", "l17"]) expect(printedNumber(fields, f), f).toBe(tax);
    expect(printedNumber(fields, "l21")).toBe(tax + 982);
    // line 25: informational, blank, with line 22's amount in the item; 23 / 24 / 24a / 26-30 blank
    expect(printedNumber(fields, "l25")).toBeNull();
    expect(ret.lines["ct1040.25"]?.status).toBe("not_yet_computed");
    expect(itemSeverity(ret, "info:ct1040.25")).toBe("advisory");
    expect(ret.openItems.find((i) => i.id === "info:ct1040.25")?.message).toContain("$982");
    for (const f of ["l23", "l24", "l24a", "l26", "l27", "l28", "l29", "l30"]) expect(printedNumber(fields, f), f).toBeNull();
    // use tax answered 0: line 15 and Schedule 4 line 69 print "0"
    expect(fields.get("ct1040.l15")).toBe("0");
    expect(fields.get("ct1040.l69")).toBe("0");
    expect(ret.headline.complete).toBe(true);
  });

  it("2. tax due (withholding 400 under the tax): L26 prints, L22 blank, 27 / 28 informational, 29 is 0", async () => {
    const b = await build(shapedFacts({ ctAgi: 270980, withheldMinusTax: -400 }));
    assertCt1040Foots(b);
    const { ret, fields } = b;
    expect(wholeDollars(ret, "ct1040.26")).toBe(400);
    expect(wholeDollars(ret, "ct1040.22")).toBe(0);
    expect(printedNumber(fields, "l26")).toBe(400);
    expect(printedNumber(fields, "l22")).toBeNull();
    expect(ret.lines["ct1040.27"]?.status).toBe("needs_cpa_rule_unverified");
    expect(itemSeverity(ret, "info:ct1040.27")).toBe("advisory");
    expect(ret.lines["ct1040.29"]?.status).toBe("not_applicable"); // 400 < 1,000
    expect(ret.lines["ct1040.30"]?.informational).toBe(true);
    expect(printedNumber(fields, "l30")).toBeNull();
    expect(ret.lines["ct1040.25"]?.status).toBe("not_applicable"); // no overpayment
  });

  it("3. tax due with line 14 less line 18 at least 1,000: line 29 is informational (CT-2210 not modeled); just under: 0", async () => {
    const over = await build(shapedFacts({ ctAgi: 270980, withheldMinusTax: -1500 }));
    assertCt1040Foots(over);
    expect(over.ret.lines["ct1040.29"]?.status).toBe("needs_cpa_rule_unverified");
    expect(over.ret.lines["ct1040.29"]?.informational).toBe(true);
    expect(printedNumber(over.fields, "l29")).toBeNull();
    expect(itemSeverity(over.ret, "info:ct1040.29")).toBe("advisory");
    const under = await build(shapedFacts({ ctAgi: 270980, withheldMinusTax: -999 }));
    assertCt1040Foots(under);
    expect(under.ret.lines["ct1040.29"]?.status).toBe("not_applicable");
    const at = await build(shapedFacts({ ctAgi: 270980, withheldMinusTax: -1000 }));
    expect(at.ret.lines["ct1040.29"]?.status).toBe("needs_cpa_rule_unverified");
  });

  it("4. exactly zero balance: both L22 and L26 blank, 25 and 27-30 are zero (not applicable)", async () => {
    const b = await build(shapedFacts({ ctAgi: 270980, withheldMinusTax: 0 }));
    assertCt1040Foots(b);
    expect(wholeDollars(b.ret, "ct1040.22")).toBe(0);
    expect(wholeDollars(b.ret, "ct1040.26")).toBe(0);
    expect(printedNumber(b.fields, "l22")).toBeNull();
    expect(printedNumber(b.fields, "l26")).toBeNull();
    expect(b.ret.lines["ct1040.25"]?.status).toBe("not_applicable");
    expect(wholeDollars(b.ret, "ct1040.30")).toBe(0);
  });

  it("5. CT AGI 24,000 or less: no tax; 8 / 10 / 12 / 14 are 0 and Schedule 3 is not claimed (line 10 is zero)", async () => {
    const b = await build(shapedFacts({ ctAgi: 24000, withheldMinusTax: 0 }));
    assertCt1040Foots(b);
    for (const k of ["ct1040.6", "ct1040.8", "ct1040.10", "ct1040.12", "ct1040.14", "ct1040.16", "ct1040.17"] as const) expect(wholeDollars(b.ret, k), k).toBe(0);
    for (const f of ["l8", "l12", "l14", "l16", "l17", "l21"]) expect(b.fields.get(`ct1040.${f}`), f).toBe("0"); // "enter 0"
    expect(b.ret.lines["ct1040.s3.63"]?.status).toBe("not_applicable");
  });

  it("6. partial property tax credit (CT AGI 125,000): rows 1,001 + 101 = 1,102, 65 = 300, 67 = 270, credit 30; a rounding case", async () => {
    const b = await build(
      shapedFacts({
        ctAgi: 125000,
        tweak: (f) => {
          f.deductions.propertyTaxBills = [
            bill({ docId: "pt-home", label: "Town of X", address: "27 Old Barry Rd", paidInYearCents: 100_050, kind: "primary_residence" }),
            bill({ docId: "pt-car", label: "Auto 1", address: null, paidInYearCents: 10_050, kind: "motor_vehicle", taxType: "motor_vehicle" }),
          ];
        },
      })
    );
    assertCt1040Foots(b);
    const { ret, fields } = b;
    expect(wholeDollars(ret, "ct1040.s3.63")).toBe(1102);
    expect(wholeDollars(ret, "ct1040.s3.65")).toBe(300);
    expect(wholeDollars(ret, "ct1040.s3.67")).toBe(270);
    expect(wholeDollars(ret, "ct1040.11")).toBe(30);
    expect(printedNumber(fields, "l60")).toBe(1001);
    expect(printedNumber(fields, "l61")).toBe(101);
    expect(printedNumber(fields, "l63")).toBe(1102);
    expect(printedNumber(fields, "l68")).toBe(30);
    expect(printedNumber(fields, "l12")).toBe(wholeDollars(ret, "ct1040.10") - 30);
    expect(b.viewItemIds).toContain("adapter:ct.schedule3-boxes");
  });

  it("7. fully phased out (CT AGI 270,980): Schedule 3 left blank with a cover note, line 11 = 0", async () => {
    const b = await build(shapedFacts({ ctAgi: 270980 }));
    assertCt1040Foots(b);
    expect(b.ret.lines["ct1040.s3.63"]?.status).toBe("not_applicable");
    expect(wholeDollars(b.ret, "ct1040.11")).toBe(0);
    expect(b.viewItemIds).toContain("adapter:ct.schedule3-blank");
    expect(b.viewItemIds).not.toContain("adapter:ct.schedule3-boxes");
  });

  it("8. use tax: a rule-derived amount is all line 69b; a stated total prints 69 with 69a-d blank and an advisory item", async () => {
    const rule = await build(
      shapedFacts({
        ctAgi: 270980,
        tweak: (f) => {
          f.ct.useTax = missingLeaf();
          f.returnAnswers.useTax.choice = owner("some");
          f.returnAnswers.useTax.generalRatePurchasesCents = owner(100_000);
          f.returnAnswers.useTax.otherRateItems = owner(false);
          f.returnAnswers.useTax.taxPaidToOtherStateCents = owner(0);
          f.returnAnswers.useTax.untaxedPurchasesCents = owner(0);
        },
      })
    );
    assertCt1040Foots(rule);
    expect(wholeDollars(rule.ret, "ct1040.15")).toBe(64); // 1,000.00 x 6.35% = 63.50, rounded
    expect(wholeDollars(rule.ret, "ct1040.s4.69b")).toBe(64);
    expect(printedNumber(rule.fields, "l69")).toBe(64);
    expect(printedNumber(rule.fields, "l69b")).toBe(64);
    expect(wholeDollars(rule.ret, "ct1040.16")).toBe(wholeDollars(rule.ret, "ct1040.14") + 64);

    const stated = await build(shapedFacts({ ctAgi: 270980, tweak: (f) => void (f.ct.useTax = owner(12_000)) }));
    assertCt1040Foots(stated);
    expect(printedNumber(stated.fields, "l69")).toBe(120);
    expect(printedNumber(stated.fields, "l69b")).toBeNull();
    expect(itemSeverity(stated.ret, "info:ct1040.s4.69b")).toBe("advisory");
  });

  it("9. other Connecticut credits answered Yes: 13 / 20a-d need the CPA, everything downstream is blocked and nothing prints from it", async () => {
    const b = await build(shapedFacts({ ctAgi: 270980, afterTweak: (f) => void (f.statedNone.ct_other_credits = owner(false)) }));
    assertCt1040Foots(b);
    const { ret, fields } = b;
    for (const k of ["ct1040.13", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"] as const) expect(ret.lines[k]?.status, k).toBe("needs_cpa_judgment");
    for (const k of ["ct1040.14", "ct1040.16", "ct1040.17", "ct1040.21", "ct1040.22", "ct1040.26", "ct1040.balance"] as const) {
      expect(hasAmount(ret.lines[k]?.status ?? "missing_input"), `${k} is blocked`).toBe(false);
    }
    for (const f of ["l13", "l14", "l16", "l17", "l20a", "l21", "l22", "l26"]) expect(printedNumber(fields, f), f).toBeNull();
    expect(itemSeverity(ret, "rule:ct-credits")).toBe("blocking");
    expect(ret.headline.complete).toBe(false);
    expect(ret.headline.connecticut.balance.amount).toBeNull();
  });

  it("10. the two new questions unanswered: missing_input on 7 / 13 / 20a-d, no silent 0, the CT balance is not complete", async () => {
    const b = await build(
      shapedFacts({
        ctAgi: 270980,
        afterTweak: (f) => {
          delete f.statedNone.ct_other_state_tax;
          delete f.statedNone.ct_other_credits;
        },
      })
    );
    assertCt1040Foots(b);
    for (const k of ["ct1040.7", "ct1040.13", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"] as const) {
      expect(b.ret.lines[k]?.status, k).toBe("missing_input");
      expect(b.ret.lines[k]?.amount, k).toBeNull();
    }
    expect(b.ret.lines["ct1040.8"]?.status).toBe("missing_input");
    expect(b.ret.lines["ct1040.10"]?.status).toBe("missing_input");
    expect(itemSeverity(b.ret, "rule:ct-credits")).toBe("blocking");
    expect(b.ret.openItems.find((i) => i.id === "rule:ct-credits")?.message).toContain("needs an owner / CPA statement");
    expect(b.ret.headline.complete).toBe(false);
    expect(b.ret.headline.connecticut.balance.amount).toBeNull();
    for (const f of ["l7", "l8", "l12", "l14", "l17", "l21", "l22", "l26"]) expect(printedNumber(b.fields, f), f).toBeNull();
    // the tax itself (line 6) does not depend on the credits and still prints
    expect(printedNumber(b.fields, "l6")).not.toBeNull();
  });

  it("11. a W-2 with another state's withholding: line 7 goes to the CPA even though the owner stated none; 8 and 10 are blocked", async () => {
    const b = await build(
      shapedFacts({
        ctAgi: 270980,
        afterTweak: (f) => {
          const w = f.income.w2s[0];
          if (!w) throw new Error("no W-2");
          w.stateLines = [{ stateCode: "NY", wagesCents: 1_000_000, withheldCents: 50_000 }];
        },
      })
    );
    assertCt1040Foots(b);
    expect(b.ret.lines["ct1040.7"]?.status).toBe("needs_cpa_judgment");
    expect(b.ret.lines["ct1040.8"]?.status).toBe("needs_cpa_judgment");
    expect(b.ret.lines["ct1040.10"]?.status).toBe("needs_cpa_judgment");
    expect(b.ret.lines["ct1040.6"]?.status).toBe("computed");
    expect(b.ret.headline.complete).toBe(false);
  });

  it("12. provisional pass: the CT balance is produced with the unresolved credit lines listed as assumed 0; the strict result is unchanged", () => {
    const f = shapedFacts({
      ctAgi: 270980,
      afterTweak: (g) => {
        delete g.statedNone.ct_other_state_tax;
        delete g.statedNone.ct_other_credits;
      },
    });
    const ret = computeTy2025Return(f);
    const prov = ret.headline.provisional;
    expect(prov).not.toBeNull();
    for (const k of ["ct1040.7", "ct1040.13", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"] as LineKey[]) expect(prov?.assumedZeroLines, k).toContain(k);
    expect(prov?.ctBalance).toBe(-982);
    expect(hasAmount(ret.lines["ct1040.balance" as LineKey]?.status ?? "missing_input")).toBe(false);
    // the strict run of the same facts, with the statements answered, is a computed balance
    const answered = computeTy2025Return(shapedFacts({ ctAgi: 270980 }));
    expect(answered.lines["ct1040.balance" as LineKey]?.status).toBe("computed");
  });
});

describe("CT-1040 engine invariants", () => {
  it("every CT-1040 line the engine owns is emitted exactly once and the strict Eric-shape return has no duplicate emissions", () => {
    const ret = computeTy2025Return(shapedFacts({ ctAgi: 270980 }));
    for (const k of Object.keys(FIELD) as LineKey[]) expect(ret.lines[k], k).toBeDefined();
    expect(ret.openItems.filter((i) => i.id.startsWith("dup:") || i.id.includes("duplicate")).length).toBe(0);
  });
});
