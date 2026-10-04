import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 }); // filling several real IRS forms per test; the 5 s default is tuned for one
// TESTER (independent) coverage for T2a/T2b: the 1040 + Schedules 1, 2, 3, A, C, SE field maps.
// Everything here is derived WITHOUT the Coder's map tests or fixtures:
//   1. own completeness: every AcroForm field of each real blank PDF is claimed exactly once.
//   2. geometry oracle: for every money field the printed line label found by PDF text positions
//      (fixtures/tester-pdf-line-geometry-2025.json, generated with pdf.js from the blank PDFs) must
//      equal the printed line of the engine key the map puts there.
//   3. REAL engine end to end: tax2025-fixtures golden facts -> computeTy2025Return -> fill every map
//      -> re-load -> every printed amount equals the engine line, subtotals foot, cross-form carries agree.
//   4. policy: one filing-status box, private fields blank, zero:"print" only where the plan lists it.
// Names in the view are synthetic.

import fs from "node:fs";
import path from "node:path";
import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { lineMeta } from "@/lib/tax2025/line-catalog";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { fingerprintOf } from "@/lib/tax2025/pdf/format";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import type { FormMap, LineRef, PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";
import { emptyFacts, fullFacts, owner } from "./tax2025-fixtures";
import geometry from "./fixtures/tester-pdf-line-geometry-2025.json";

const FORMS = ["f1040", "f1040s1", "f1040s2", "f1040s3", "f1040sa", "f1040sc", "f1040sse"] as const;
// Integration (T9): the registry now also holds the MVP-2 / CT maps. This file keeps testing the seven T2 maps
// (the later maps have their own map tests); the registry itself is pinned below so a new map is a deliberate change.
const LATER_FORMS = ["f1040sb", "f1040sd", "f8949", "f8995", "f8959", "ct1040", "f1040s1a"] as const;
const T2_MAPS: readonly FormMap[] = FORM_MAPS.filter((m) => (FORMS as readonly string[]).includes(m.formId));

function mapOf(formId: string): FormMap {
  const m = FORM_MAPS.find((x) => x.formId === formId);
  if (!m) throw new Error(`no map for ${formId}`);
  return m;
}

async function realFieldNames(formId: string): Promise<string[]> {
  const bytes = fs.readFileSync(path.join(process.cwd(), "data", "forms", "2025", `${formId}.pdf`));
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getForm().getFields().map((f) => f.getName());
}

describe("tester T2: own completeness against the real blank PDFs", () => {
  it("the registry holds exactly the seven T2 maps plus the later maps (Schedule B, Schedule D, 8949, 8995, 8959, CT-1040, Schedule 1-A)", () => {
    expect(FORM_MAPS.map((m) => m.formId).sort()).toEqual([...FORMS, ...LATER_FORMS].sort());
    expect(T2_MAPS.map((m) => m.formId).sort()).toEqual([...FORMS].sort());
  });
  for (const formId of FORMS) {
    it(`${formId}: every AcroForm field claimed exactly once, nothing unknown`, async () => {
      const names = await realFieldNames(formId);
      const map = mapOf(formId);
      const claims = new Map<string, number>();
      const add = (n: string) => claims.set(n, (claims.get(n) ?? 0) + 1);
      for (const l of map.lines) add(l.field);
      for (const t of map.tables) for (const r of t.rows) for (const f of Object.values(r)) add(f);
      for (const h of map.header) add(h.field);
      for (const b of map.blank) {
        if ("field" in b) add(b.field);
        else for (const n of names) if (new RegExp(b.match.source).test(n)) add(n);
      }
      expect([...claims.keys()].filter((n) => !names.includes(n))).toEqual([]);
      expect([...claims.entries()].filter(([, c]) => c !== 1).map(([n]) => n)).toEqual([]);
      expect(names.filter((n) => !claims.has(n))).toEqual([]);
    });
  }
});

describe("tester T2: geometry oracle (pdf.js text positions) vs engine printed line", () => {
  const geo = geometry as unknown as Record<string, Record<string, string>>;
  for (const formId of FORMS) {
    it(`${formId}: every money field sits next to the printed line number of its engine key`, () => {
      const map = mapOf(formId);
      const table = geo[formId];
      expect(table).toBeDefined();
      let n = 0;
      for (const l of map.lines) {
        if (l.kind !== "money") continue;
        n += 1;
        const printed = lineMeta(l.line as LineKey).formLine;
        const found = table?.[l.field];
        expect(found, `${formId} ${l.field} has no geometry label`).toBeTruthy();
        // 1040 line 7b prints only a bare "b" sub-label next to its amount box.
        const ok = found === printed || (found?.length === 1 && /^\d+[a-z]$/.test(printed) && printed.endsWith(found));
        expect(ok, `${formId} ${l.line}: engine says line ${printed}, the blank PDF prints "${found}" next to ${l.field}`).toBe(true);
      }
      // Every geometry row is either a mapped money field or a field the map deliberately blanks: Schedule SE
      // lines 7 and 14 are read-only 1-pt dummy widgets over pre-printed constants (maps tester D1, moved to blank).
      const blanked = new Set(map.blank.filter((b): b is { field: string; reason: typeof b.reason } => "field" in b).map((b) => b.field));
      const unmapped = Object.keys(table ?? {}).filter((field) => !map.lines.some((l) => l.field === field));
      for (const field of unmapped) expect(blanked.has(field), `${formId}: geometry row ${field} is neither mapped nor blank`).toBe(true);
      expect(unmapped.sort()).toEqual(
        formId === "f1040sse" ? ["topmostSubform[0].Page1[0].f1_13[0]", "topmostSubform[0].Page2[0].f2_1[0]"] : [],
      );
      expect(n + unmapped.length).toBe(Object.keys(table ?? {}).length);
    });
  }
});

// ── real engine end to end ────────────────────────────────────────────────────

function viewFrom(ret: Ty2025Return, answers: Record<string, string | boolean | null> = { filingStatus: "mfj" }, tables: PdfReturnView["tables"] = {}): PdfReturnView {
  const lines: Partial<Record<LineRef, PdfLine>> = {};
  for (const [k, l] of Object.entries(ret.lines)) {
    if (!l) continue;
    lines[k as LineRef] = { key: l.key, status: l.status, amount: l.amount, reason: l.reason, formLabel: l.form, formLine: l.formLine, label: l.label };
  }
  return {
    taxYear: 2025,
    filingStatus: "mfj",
    generatedAt: "2026-10-04T02:30:00.000Z",
    generatedBy: "tester",
    fingerprint: fingerprintOf({ lines }),
    lines,
    header: { householdNames: "Pat Sample and Lee Sample", taxpayerName: "Pat Sample", spouseName: "Lee Sample", ekcName: "Sample Consulting, LLC" },
    answers,
    tables,
    openItems: [],
    decisions: [],
    overrides: [],
    overrideNotice: { totalsNotRecomputed: false, dependents: [], headlineMarks: [], engineChanged: [], count: 0 },
    resolvedByOverride: [],
    acknowledged: [],
    headline: ret.headline,
    citations: ret.citations,
  };
}

type Values = Record<string, string | boolean>;

async function fillEverything(ret: Ty2025Return, answers?: Record<string, string | boolean | null>) {
  const view = viewFrom(ret, answers);
  const out: Record<string, { values: Values; items: string[] }> = {};
  for (const map of T2_MAPS) {
    const res = await fillForm(map.formId, view, map, { stamp: true, fingerprint: "abcdef123456", stampDate: "2026-10-03" });
    const doc = await PDFDocument.load(res.bytes);
    const values: Values = {};
    for (const f of doc.getForm().getFields()) {
      if (f instanceof PDFTextField) values[f.getName()] = f.getText() ?? "";
      else if (f instanceof PDFCheckBox) values[f.getName()] = f.isChecked();
    }
    out[map.formId] = { values, items: res.openItems.map((i) => `${i.severity}|${i.id}`) };
  }
  return out;
}

function fmt(n: number): string {
  if (n === 0) return "0";
  return (n < 0 ? "-" : "") + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Printed value of an engine key on its form, as a number (blank = null). */
function reader(out: Record<string, { values: Values }>) {
  return (formId: string, key: string): number | null => {
    const entry = mapOf(formId).lines.find((l) => l.kind === "money" && l.line === key);
    if (!entry) throw new Error(`${formId} has no field for ${key}`);
    const v = out[formId]?.values[entry.field];
    if (typeof v !== "string") throw new Error(`${entry.field} is not a text field`);
    return v === "" ? null : Number(v.replace(/,/g, ""));
  };
}

function itemizingFacts() {
  const f = fullFacts();
  const m = f.deductions.mortgages[0];
  if (!m) throw new Error("fixture has no mortgage");
  m.interestCents = 3_000_000;
  m.principalCents = 40_000_000;
  return f;
}

describe("tester T2: golden fixture through the REAL engine, read back from the filled PDFs", () => {
  const ret = computeTy2025Return(fullFacts());

  it("engine headline is the known golden (AGI 177,967 / TI 137,174 / tax 27,015)", () => {
    expect(ret.headline.federal.agi.amount).toBe(177967);
    expect(ret.headline.federal.taxableIncome.amount).toBe(137174);
    expect(ret.headline.federal.totalTax.amount).toBe(27015);
  });

  it("every printed amount equals the engine line (computed non-zero), blank otherwise, on all seven forms", async () => {
    const out = await fillEverything(ret);
    for (const map of T2_MAPS) {
      for (const l of map.lines) {
        if (l.kind !== "money") continue;
        const rl = ret.lines[l.line as LineKey];
        let expected = "";
        if (rl && (rl.status === "computed" || rl.status === "not_applicable") && rl.amount !== null) {
          if (rl.amount !== 0) expected = fmt(rl.amount);
          else if (l.zero === "print") expected = "0";
        }
        expect(out[map.formId]?.values[l.field], `${map.formId} ${l.line}`).toBe(expected);
      }
    }
  });

  it("golden totals sit on the lines where they belong, subtotals foot, cross-form carries agree", async () => {
    const out = await fillEverything(ret);
    const r = reader(out);
    const n = (formId: string, key: string) => r(formId, key) ?? 0;
    // headline numbers on the 1040
    expect(r("f1040", "f1040.11a")).toBe(177967);
    expect(r("f1040", "f1040.11b")).toBe(177967);
    expect(r("f1040", "f1040.15")).toBe(137174);
    expect(r("f1040", "f1040.24")).toBe(27015);
    // 1040 footing
    const sum = (keys: string[]) => keys.reduce((s, k) => s + n("f1040", k), 0);
    expect(n("f1040", "f1040.9")).toBe(sum(["f1040.1z", "f1040.2b", "f1040.3b", "f1040.4b", "f1040.5b", "f1040.6b", "f1040.7a", "f1040.8"]));
    expect(n("f1040", "f1040.1z")).toBe(sum(["f1040.1a", "f1040.1b", "f1040.1c", "f1040.1d", "f1040.1e", "f1040.1f", "f1040.1g", "f1040.1h"]));
    expect(n("f1040", "f1040.11a")).toBe(n("f1040", "f1040.9") - n("f1040", "f1040.10"));
    expect(n("f1040", "f1040.14")).toBe(sum(["f1040.12e", "f1040.13a", "f1040.13b"]));
    expect(n("f1040", "f1040.15")).toBe(Math.max(0, n("f1040", "f1040.11b") - n("f1040", "f1040.14")));
    expect(n("f1040", "f1040.18")).toBe(n("f1040", "f1040.16") + n("f1040", "f1040.17"));
    expect(n("f1040", "f1040.22")).toBe(Math.max(0, n("f1040", "f1040.18") - n("f1040", "f1040.21")));
    expect(n("f1040", "f1040.24")).toBe(n("f1040", "f1040.22") + n("f1040", "f1040.23"));
    expect(n("f1040", "f1040.25d")).toBe(sum(["f1040.25a", "f1040.25b", "f1040.25c"]));
    expect(n("f1040", "f1040.33")).toBe(sum(["f1040.25d", "f1040.26", "f1040.32"]));
    expect(n("f1040", "f1040.37")).toBe(n("f1040", "f1040.24") - n("f1040", "f1040.33"));
    // cross-form carries
    expect(n("f1040sc", "schc.31")).toBe(50000);
    expect(n("f1040s1", "sch1.3")).toBe(n("f1040sc", "schc.31"));
    expect(n("f1040s1", "sch1.10")).toBe(n("f1040", "f1040.8"));
    expect(n("f1040sse", "se.2")).toBe(n("f1040sc", "schc.31"));
    expect(n("f1040sse", "se.12")).toBe(n("f1040s2", "sch2.4"));
    expect(n("f1040s2", "sch2.21")).toBe(n("f1040", "f1040.23"));
    expect(n("f1040sse", "se.13")).toBe(n("f1040s1", "sch1.15"));
    expect(n("f1040s1", "sch1.26")).toBe(n("f1040", "f1040.10"));
    expect(n("f1040sa", "scha.2")).toBe(n("f1040", "f1040.11b"));
    // Schedule C footing
    const c = (k: string) => n("f1040sc", k);
    expect(c("schc.3")).toBe(c("schc.1") - c("schc.2"));
    expect(c("schc.5")).toBe(c("schc.3") - c("schc.4"));
    expect(c("schc.7")).toBe(c("schc.5") + c("schc.6"));
    const exp = ["8", "9", "10", "11", "12", "13", "14", "15", "16a", "16b", "17", "18", "19", "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "27a", "27b"];
    expect(c("schc.28")).toBe(exp.reduce((s, id) => s + c(`schc.${id}`), 0));
    expect(c("schc.29")).toBe(c("schc.7") - c("schc.28"));
    expect(c("schc.31")).toBe(c("schc.29") - c("schc.30"));
    // Schedule SE footing
    const se = (k: string) => n("f1040sse", k);
    expect(se("se.12")).toBe(se("se.10") + se("se.11"));
    expect(Math.abs(se("se.13") * 2 - se("se.12"))).toBeLessThanOrEqual(1);
    expect(se("se.6")).toBe(se("se.4c") + n("f1040sse", "se.5b"));
    // standard deduction wins in this fixture: 12e is the standard deduction
    expect(n("f1040", "f1040.12e")).toBe(31500);
  });

  it("exactly one box is checked anywhere (MFJ, on-value /2); nothing else non-money is set; private fields stay empty", async () => {
    const out = await fillEverything(ret);
    const checkedAll: string[] = [];
    for (const map of T2_MAPS) {
      const money = new Set(map.lines.filter((l) => l.kind === "money").map((l) => l.field));
      const header = new Set(map.header.map((h) => h.field));
      for (const [name, v] of Object.entries(out[map.formId]?.values ?? {})) {
        if (v === true) checkedAll.push(`${map.formId}:${name}`);
        if (money.has(name) || header.has(name)) continue;
        if (typeof v === "string") expect(v, `${map.formId} ${name} must be empty`).toBe("");
      }
    }
    expect(checkedAll).toEqual(["f1040:topmostSubform[0].Page1[0].Checkbox_ReadOrder[0].c1_8[1]"]);
    // the MFJ box really is the one with on-value /2 in the blank
    const doc = await PDFDocument.load(fs.readFileSync(path.join(process.cwd(), "data", "forms", "2025", "f1040.pdf")), { updateMetadata: false });
    const box = doc.getForm().getCheckBox("topmostSubform[0].Page1[0].Checkbox_ReadOrder[0].c1_8[1]");
    expect(String((box.acroField as unknown as { getOnValue(): unknown }).getOnValue())).toBe("/2");
  });

  it("headers: 1040 first/last split, schedules share the household names, Schedule C business name", async () => {
    const out = await fillEverything(ret);
    const v = (f: string, n: string) => out[f]?.values[n];
    expect(v("f1040", "topmostSubform[0].Page1[0].f1_14[0]")).toBe("Pat");
    expect(v("f1040", "topmostSubform[0].Page1[0].f1_15[0]")).toBe("Sample");
    expect(v("f1040", "topmostSubform[0].Page1[0].f1_17[0]")).toBe("Lee");
    expect(v("f1040sc", "topmostSubform[0].Page1[0].f1_1[0]")).toBe("Pat Sample");
    expect(v("f1040sc", "topmostSubform[0].Page1[0].f1_5[0]")).toBe("Sample Consulting, LLC");
    expect(v("f1040s1", "topmostSubform[0].Page1[0].f1_01[0]")).toBe("Pat Sample and Lee Sample");
  });

  it("digital assets Y/N stay unchecked with an open item when unanswered; filing status unanswered checks nothing", async () => {
    const out = await fillEverything(ret, {});
    const f = out["f1040"];
    expect(Object.values(f?.values ?? {}).filter((x) => x === true)).toEqual([]);
    expect(f?.items.some((i) => i.includes("answer:digitalAssets"))).toBe(true);
    expect(f?.items.some((i) => i.includes("answer:filingStatus"))).toBe(true);
  });

  it("itemizing variant: Schedule A line 17 equals 1040 line 12e, Schedule A foots", async () => {
    const r2 = computeTy2025Return(itemizingFacts());
    expect(r2.headline.complete).toBe(true);
    const out = await fillEverything(r2);
    const r = reader(out);
    const n = (f: string, k: string) => r(f, k) ?? 0;
    expect(n("f1040sa", "scha.17")).toBe(40200);
    expect(n("f1040", "f1040.12e")).toBe(n("f1040sa", "scha.17"));
    expect(n("f1040sa", "scha.7")).toBe(n("f1040sa", "scha.5e") + n("f1040sa", "scha.6"));
    expect(n("f1040sa", "scha.5d")).toBe(n("f1040sa", "scha.5a") + n("f1040sa", "scha.5b") + n("f1040sa", "scha.5c"));
    expect(n("f1040sa", "scha.10")).toBe(n("f1040sa", "scha.8e") + n("f1040sa", "scha.9"));
    expect(n("f1040sa", "scha.17")).toBe(
      ["scha.4", "scha.7", "scha.10", "scha.14", "scha.15", "scha.16"].reduce((s, k) => s + n("f1040sa", k), 0),
    );
    expect(n("f1040", "f1040.15")).toBe(n("f1040", "f1040.11b") - n("f1040", "f1040.14"));
  });

  it("not-yet-computed / missing lines are EMPTY, never '0', when the facts are empty", async () => {
    const r3 = computeTy2025Return(emptyFacts());
    const out = await fillEverything(r3);
    for (const map of T2_MAPS) {
      for (const l of map.lines) {
        if (l.kind !== "money") continue;
        const rl = r3.lines[l.line as LineKey];
        if (rl && rl.status !== "computed" && rl.status !== "not_applicable") {
          expect(out[map.formId]?.values[l.field], `${map.formId} ${l.line} (${rl.status})`).toBe("");
        }
      }
    }
  });
});

describe("tester T2: zero:'print' only on the plan's 1040 lines", () => {
  it("1040 zero set and expected set are exactly as planned; no other map has either", () => {
    for (const map of T2_MAPS) {
      const zero = map.lines.filter((l) => l.kind === "money" && l.zero).map((l) => (l as { line: string }).line).sort();
      const exp = map.lines.filter((l) => l.kind === "money" && l.expected).map((l) => (l as { line: string }).line).sort();
      if (map.formId === "f1040") {
        expect(zero).toEqual(["f1040.11a", "f1040.15", "f1040.16", "f1040.24", "f1040.33", "f1040.9"]);
        expect(exp).toEqual(["f1040.11a", "f1040.15", "f1040.24"]);
      } else {
        expect(zero).toEqual([]);
        expect(exp).toEqual([]);
      }
    }
  });

  it("a computed zero prints '0' on 15, 16, 24, 33 and stays blank on 34, 37", async () => {
    const f = fullFacts();
    f.income.w2s[0]!.wagesCents = 1_000_000;
    f.income.w2s[0]!.medicareWagesCents = 1_000_000;
    f.income.w2s[0]!.socialSecurityWagesCents = 1_000_000;
    f.income.w2s[0]!.fedWithheldCents = 0;
    f.income.w2s[1]!.fedWithheldCents = 0;
    f.income.w2s[1]!.wagesCents = 500_000;
    f.income.w2s[1]!.medicareWagesCents = 500_000;
    f.income.w2s[1]!.socialSecurityWagesCents = 500_000;
    f.income.interest = [];
    f.income.noInterestConfirmed = owner(true);
    f.income.scheduleC.glLines = f.income.scheduleC.glLines.slice(0, 2).map((g) => ({ ...g, totalCents: 100_000 }));
    const ret = computeTy2025Return(f);
    const get = (k: LineKey) => ret.lines[k];
    expect(get("f1040.15")?.status).toBe("computed");
    expect(get("f1040.15")?.amount).toBe(0);
    const out = await fillEverything(ret);
    const r = reader(out);
    expect(r("f1040", "f1040.15")).toBe(0);
    expect(r("f1040", "f1040.16")).toBe(0);
    expect(r("f1040", "f1040.24")).toBe(0);
    expect(r("f1040", "f1040.33")).toBe(0);
    expect(r("f1040", "f1040.34")).toBeNull();
    expect(r("f1040", "f1040.37")).toBeNull();
  });
});

describe("tester T2: T1 probe-test narrowing check (the Coder loosened the not-written guard)", () => {
  // The Coder moved `if (benign.has(f.name)) continue;` above the never-written assertion. Only three of the six
  // benign names are legitimately written now (money lines 1e, 6a, 19); the other three must still never be written.
  it("the three non-money 'benign' 1040 fields are not written by the map", () => {
    const m = mapOf("f1040");
    const written = new Set([...m.lines.map((l) => l.field), ...m.header.map((h) => h.field)]);
    for (const name of [
      "topmostSubform[0].Page1[0].f1_29[0]",
      "topmostSubform[0].Page2[0].c2_1[0]",
      "topmostSubform[0].Page2[0].c2_2[0]",
    ]) {
      expect(written.has(name), name).toBe(false);
    }
    // and the three money ones really are money lines for 1e / 6a / 19
    const key = (f: string) => m.lines.find((l) => l.field === f && l.kind === "money");
    expect(key("topmostSubform[0].Page1[0].f1_51[0]")).toMatchObject({ line: "f1040.1e" });
    expect(key("topmostSubform[0].Page1[0].f1_68[0]")).toMatchObject({ line: "f1040.6a" });
    expect(key("topmostSubform[0].Page2[0].f2_11[0]")).toMatchObject({ line: "f1040.19" });
  });
});
