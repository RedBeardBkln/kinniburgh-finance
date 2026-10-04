import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LINE_KEYS, lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import type { PdfLine, PdfTableRow } from "@/lib/tax2025/pdf/types";
import type { L1Context } from "@/lib/tax-review/l1/context";
import {
  coverageDriftCheck,
  evaluateRule,
  F8949_BOX_TO_SCHD_LINE,
  footingCheck,
  footingCoverageDrift,
  footingCoverageSummary,
  linkCheck,
} from "@/lib/tax-review/l1/footing";
import { FOOTING_RULES, NOT_COVERED_FORMS, SPECIAL_COVERED_FORMS, TABLE_RULES } from "@/lib/tax-review/l1/footing-rules";
import { buildPipeline, cleanScenario, richScenario, loadCatalogs } from "./tax-review-harness";

let clean: L1Context;
let rich: L1Context;

beforeAll(async () => {
  clean = (await buildPipeline(cleanScenario())).ctx;
  rich = (await buildPipeline(richScenario())).ctx;
});

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A copy of the context whose view lines can be changed without touching the shared one. */
function withLines(ctx: L1Context, mutate: (lines: Partial<Record<string, PdfLine>>) => void): L1Context {
  const view = structuredClone(ctx.view);
  mutate(view.lines as Partial<Record<string, PdfLine>>);
  return { ...ctx, view };
}

function bump(ctx: L1Context, key: string, by: number): L1Context {
  return withLines(ctx, (lines) => {
    const l = lines[key];
    if (!l || l.amount === null) throw new Error(`${key} has no amount to change`);
    l.amount += by;
  });
}

describe("the rule tables are authored from the printed forms", () => {
  const catalogs = loadCatalogs();
  const speakOf = (formId: string): string => {
    const cat = catalogs[formId] ?? (JSON.parse(readFileSync(path.join(process.cwd(), "data", "forms", "2025", "catalog", `${formId}.fields.json`), "utf8")) as { fields: { speak: string | null }[] });
    return normalise(cat.fields.map((f) => f.speak ?? "").join(" | "));
  };
  it("rule ids are unique and every line key exists in the catalog", () => {
    const ids = FOOTING_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = new Set<string>(LINE_KEYS);
    for (const r of FOOTING_RULES) for (const k of [r.total, ...r.parts.map((t) => t.key)]) expect(keys.has(k), `${r.id}: ${k}`).toBe(true);
    for (const r of TABLE_RULES) expect(keys.has(r.total)).toBe(true);
  });
  it("every federal rule's quote is verbatim text of the printed form (the AcroForm description of its field)", () => {
    const missing: string[] = [];
    for (const r of FOOTING_RULES) {
      const form = r.quoteForm ?? r.form;
      if (form === "ct1040") continue;
      if (!speakOf(form).includes(normalise(r.quote))) missing.push(`${r.id}: "${r.quote}" is not printed on ${form}`);
    }
    for (const r of TABLE_RULES) {
      if (r.form === "ct1040") continue;
      if (!speakOf(r.form).includes(normalise(r.quote))) missing.push(`${r.id}: "${r.quote}" is not printed on ${r.form}`);
    }
    expect(missing).toEqual([]);
  });
  it("a Connecticut rule's quote is the printed-line label of the line it checks", () => {
    for (const r of [...FOOTING_RULES.filter((x) => x.form === "ct1040"), ...TABLE_RULES.filter((x) => x.form === "ct1040")]) {
      expect(r.quote).toBe(lineMeta(r.total as LineKey).label);
    }
  });
  it("a rule's parts are the lines the quote names (spot checks)", () => {
    const rule = (id: string) => FOOTING_RULES.find((r) => r.id === id);
    expect(rule("f1040.9")?.parts.map((t) => lineMeta(t.key).formLine)).toEqual(["1z", "2b", "3b", "4b", "5b", "6b", "7a", "8"]);
    expect(rule("sch2.21")?.parts.map((t) => lineMeta(t.key).formLine)).toEqual(["4", "7", "8", "9", "11", "12", "13", "14", "15", "16", "18", "19"]);
    expect(rule("scha.17")?.parts.map((t) => lineMeta(t.key).formLine)).toEqual(["4", "7", "10", "14", "15", "16"]);
    expect(rule("f1040.15")?.floor0).toBe(true);
    expect(rule("schd.7")?.parts.find((t) => t.key === "schd.6")?.sign).toBe(-1);
  });
  it("only the Schedule D family carries a tolerance, and each one says why", () => {
    for (const r of FOOTING_RULES) {
      if (r.tolerance === undefined) continue;
      expect(r.form).toBe("f1040sd");
      expect(r.toleranceReason).toMatch(/rounded/);
    }
  });
});

describe("F1 / F2 on real engine output", () => {
  it("the clean and the rich return foot on every rule that applies (no finding)", async () => {
    for (const ctx of [clean, rich]) {
      expect(await footingCheck.run(ctx)).toEqual([]);
      expect(await linkCheck.run(ctx)).toEqual([]);
    }
  });
  it("most rules are actually evaluated on the rich return (the check is not vacuous)", () => {
    const s = footingCoverageSummary(rich);
    expect(s.evaluated).toBeGreaterThanOrEqual(110);
    expect(s.rules).toBe(FOOTING_RULES.length);
  });
  it("mutation test: every rule that holds is broken by moving its total one dollar past the tolerance", () => {
    let mutated = 0;
    const neverEvaluated: string[] = [];
    for (const rule of FOOTING_RULES) {
      const base = [rich, clean].find((c) => evaluateRule(c, rule).status === "ok");
      if (!base) {
        neverEvaluated.push(rule.id);
        continue;
      }
      // past the tolerance whatever rounding difference the line started with: 2 x tolerance + 1
      const broken = bump(base, rule.total, (rule.tolerance ?? 0) * 2 + 1);
      const r = evaluateRule(broken, rule);
      expect(r.status, `rule ${rule.id} must fail when its total is off`).toBe("mismatch");
      mutated += 1;
    }
    expect(mutated).toBeGreaterThanOrEqual(110);
    // the rules no fixture exercises: Schedule 1-A (no data in the fixtures) and CT-1040 line 30 (its late-payment lines are informational: no amount)
    expect(neverEvaluated.sort()).toEqual(neverEvaluated.filter((id) => /^(sch1a|ct1040\.30)/.test(id)).sort());
  });
  it("a part with no amount while its total has one is 'cannot prove' (high), not silently zero", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "f1040.9");
    if (!rule) throw new Error("rule missing");
    const ctx = withLines(rich, (lines) => {
      const l = lines["f1040.3b"];
      if (l) {
        l.status = "missing_input";
        l.amount = null;
      }
    });
    const r = evaluateRule(ctx, rule);
    expect(r.status).toBe("unproven");
    const found = footingCheckSync(ctx).find((f) => f.check === "L1.F1.f1040.9");
    expect(found?.severity).toBe("high");
    expect(found?.acceptable).toBe(true);
  });
  it("a total with no amount is skipped (blank-not-zero and completeness report it elsewhere)", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "f1040.9");
    if (!rule) throw new Error("rule missing");
    const ctx = withLines(rich, (lines) => {
      const l = lines["f1040.9"];
      if (l) {
        l.status = "not_yet_computed";
        l.amount = null;
      }
    });
    expect(evaluateRule(ctx, rule)).toEqual({ status: "skipped", why: "the total has no amount" });
  });
  it("a rule on a form that is not filed is skipped", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "scha.17");
    if (!rule) throw new Error("rule missing");
    expect(evaluateRule(clean, rule)).toEqual({ status: "skipped", why: "form not filed" });
  });
  it("the mismatch finding quotes the printed form, shows the parts and cannot be accepted", () => {
    const ctx = bump(rich, "f1040.9", 1);
    const f = footingCheckSync(ctx).find((x) => x.check === "L1.F1.f1040.9");
    expect(f?.severity).toBe("blocker");
    expect(f?.acceptable).toBe(false);
    expect(f?.message).toContain("Add lines 1z, 2b, 3b");
    expect(f?.citation.sourceStatus).toBe("verified");
    expect(f?.citation.sources[0]?.kind).toBe("form_text");
    expect(f?.evidence[0]?.ref).toBe("f1040.9");
  });
  it("Schedule D lines may differ by $1 (rounded once from cents) but not by $2", () => {
    const rule = FOOTING_RULES.find((r) => r.id === "schd.16");
    if (!rule) throw new Error("rule missing");
    expect(evaluateRule(bump(rich, "schd.16", 1), rule).status).toBe("ok");
    expect(evaluateRule(bump(rich, "schd.16", 2), rule).status).toBe("mismatch");
  });
  it("an override that was not recomputed downstream breaks the footing of the totals it feeds", () => {
    const ctx = bump(rich, "sch1.3", 5_000);
    const hit = footingCheckSync(ctx).map((f) => f.check);
    expect(hit).toContain("L1.F1.sch1.10");
  });
});

function footingCheckSync(ctx: L1Context) {
  const out = [];
  for (const rule of FOOTING_RULES) {
    const r = evaluateRule(ctx, rule);
    if (r.status === "mismatch" || r.status === "unproven") out.push(...(footingFindingsFor(ctx, rule.id)));
  }
  return out;
}

// the findings of one rule, through the public checks (footingCheck / linkCheck are synchronous in effect)
function footingFindingsFor(ctx: L1Context, ruleId: string) {
  const rule = FOOTING_RULES.find((r) => r.id === ruleId);
  const check = rule?.category === "link" ? linkCheck : footingCheck;
  const res = check.run(ctx);
  if (res instanceof Promise) throw new Error("the footing checks are synchronous");
  return res.filter((f) => f.check === `${rule?.category === "link" ? "L1.F2" : "L1.F1"}.${ruleId}`);
}

describe("F2 special checks", () => {
  it("1040 line 12e must be the larger of the standard and the itemized deduction", () => {
    const ctx = bump(rich, "f1040.12e", 100);
    const f = linkCheck.run(ctx);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F2.f1040.12e" && x.severity === "blocker")).toBe(true);
  });
  it("1040 line 7a must follow Schedule D line 16 (and line 21 for a loss)", () => {
    const ctx = bump(rich, "f1040.7a", 7);
    const f = linkCheck.run(ctx);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F2.f1040.7a")).toBe(true);
  });
  it("headline figures must equal the lines they are read from", () => {
    const view = structuredClone(rich.view);
    view.headline.federal.totalTax.amount = (view.headline.federal.totalTax.amount ?? 0) + 3;
    const f = linkCheck.run({ ...rich, view });
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F2.headline.federal.totalTax")).toBe(true);
  });
  it("headline ties are not checked while an override left the totals un-recomputed (the override check reports that)", () => {
    const view = structuredClone(rich.view);
    view.headline.federal.totalTax.amount = (view.headline.federal.totalTax.amount ?? 0) + 3;
    view.overrideNotice.totalsNotRecomputed = true;
    const f = linkCheck.run({ ...rich, view });
    expect(Array.isArray(f) && f.some((x) => x.check.startsWith("L1.F2.headline"))).toBe(false);
  });
});

describe("printed tables", () => {
  function withTable(ctx: L1Context, table: "schb.interest" | "ct.withholding" | "schc.otherExpenses", edit: (rows: PdfTableRow[]) => void): L1Context {
    const view = structuredClone(ctx.view);
    const rows = (view.tables[table] ?? []) as PdfTableRow[];
    edit(rows);
    view.tables[table] = rows;
    return { ...ctx, view };
  }
  it("the rows of the CT withholding table add up to line 18", () => {
    const rows = (rich.view.tables["ct.withholding"] ?? []).length;
    expect(rows).toBeGreaterThan(0);
    const broken = withTable(rich, "ct.withholding", (r) => {
      const first = r[0];
      if (first) first.cells = { ...first.cells, withheld: (typeof first.cells["withheld"] === "number" ? first.cells["withheld"] : 0) + 10 };
    });
    const f = footingCheck.run(broken);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F1.ct1040.18.rows" && x.severity === "blocker")).toBe(true);
  });
  it("the Schedule B interest rows add up to line 2", () => {
    const broken = withTable(rich, "schb.interest", (r) => {
      const first = r[0];
      if (first) first.cells = { ...first.cells, amount: (typeof first.cells["amount"] === "number" ? first.cells["amount"] : 0) + 50 };
    });
    const f = footingCheck.run(broken);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F1.schb.2.rows")).toBe(true);
  });
  it("a row with no whole-dollar amount cannot be added up", () => {
    const broken = withTable(rich, "schb.interest", (r) => {
      const first = r[0];
      if (first) first.cells = { ...first.cells, amount: "n/a" };
    });
    const f = footingCheck.run(broken);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F1.schb.2.rows" && /no whole-dollar amount/.test(x.message))).toBe(true);
  });
});

describe("Form 8949", () => {
  function with8949(edit: (rows: PdfTableRow[]) => void): L1Context {
    const view = structuredClone(rich.view);
    const rows = (view.tables["f8949.partI"] ?? []) as PdfTableRow[];
    edit(rows);
    view.tables["f8949.partI"] = rows;
    return { ...rich, view };
  }
  it("maps every box to the Schedule D line the printed form names", () => {
    expect(F8949_BOX_TO_SCHD_LINE).toMatchObject({ A: "1b", G: "1b", B: "2", H: "2", C: "3", I: "3", D: "8b", J: "8b", E: "9", K: "9", F: "10", L: "10" });
  });
  it("the rich return has Part I rows and they foot", () => {
    expect((rich.view.tables["f8949.partI"] ?? []).length).toBeGreaterThan(0);
    const f = footingCheck.run(rich);
    expect(Array.isArray(f) && f.filter((x) => x.check.startsWith("L1.F1.f8949")).length).toBe(0);
  });
  it("a row whose (h) is not (d) - (e) + (g) is a blocker", () => {
    const ctx = with8949((rows) => {
      const r = rows[0];
      if (r) r.cells = { ...r.cells, h: (typeof r.cells["h"] === "number" ? r.cells["h"] : 0) + 5 };
    });
    const f = footingCheck.run(ctx);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F1.f8949.row" && x.severity === "blocker")).toBe(true);
  });
  it("rows that no longer add up to their Schedule D line are a blocker", () => {
    const ctx = with8949((rows) => {
      const r = rows[0];
      if (r) r.cells = { ...r.cells, d: (typeof r.cells["d"] === "number" ? r.cells["d"] : 0) + 500, h: (typeof r.cells["h"] === "number" ? r.cells["h"] : 0) + 500 };
    });
    const f = footingCheck.run(ctx);
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F1.f8949.to-schd")).toBe(true);
  });
});

describe("F3 footing coverage drift", () => {
  it("every form map of the packet today has a footing decision", () => {
    expect(footingCoverageDrift(FORM_MAPS.map((m) => m.formId))).toEqual([]);
  });
  it("a new map with no rule is reported", () => {
    expect(footingCoverageDrift(["f1040", "f9999"])).toEqual(["f9999"]);
    const f = coverageDriftCheck.run({ ...rich, maps: [...rich.maps, { formId: "f9999", lines: [], tables: [], header: [], blank: [] }] });
    expect(Array.isArray(f) && f.map((x) => `${x.severity}:${x.formKey}`)).toEqual(["medium:f9999"]);
  });
  it("the explicit lists carry a reason for every entry", () => {
    for (const reason of [...Object.values(NOT_COVERED_FORMS), ...Object.values(SPECIAL_COVERED_FORMS)]) expect(reason.length).toBeGreaterThan(10);
  });
  it("the Schedule 1-A rules exist before its PDF map does (so the later merge needs no new decision)", () => {
    expect(FOOTING_RULES.some((r) => r.form === "f1040s1a")).toBe(true);
  });
});
