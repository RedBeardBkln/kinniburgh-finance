// Tester round for model-unmodeled-lines (engine ty2025-1b.7). Independent probes, not a copy of the Coder's tests:
//  A. the safety net for EVERY line a zero_line_entry follows, through the real override rows + the real L1 pipeline + the filled PDFs
//  B. Form 1040 line 16 gate: answers (None / Yes / Not sure / unanswered) x tax path (Tax Table, rate schedule, QDCG, Schedule D worksheet)
//  C. 24z / 6z are zero whatever any answer says, and nothing else moves when the statement is "none"
//  D. mapped-blank reasons: every followed line has a filled MapLine; every blank-claimed field of the task is not a money line field
import { vi } from "vitest";
vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
import { describe, expect, it } from "vitest";
import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";
import { effectiveAnswers, visibleNodes, UNSURE_ID, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { lineSnapshot, type OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { LineKey } from "@/lib/tax2025/line-catalog";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { formatDollars } from "@/lib/tax2025/pdf/format";
import { entriesNeedingHand } from "@/lib/tax2025/pdf/hand-entries";
import { unkeyedLinesCheck } from "@/lib/tax-review/l1/pdf-unkeyed";
import { fullFacts, owner } from "./tax2025-fixtures";
import { buildPipeline, richScenario } from "./tax-review-harness";
import { loadCatalog } from "./tax2025-pdf-harness";

// ── D. followed lines ────────────────────────────────────────────────────────────────────────────────────────────────
const ENTRIES = FORM_MAPS.flatMap((m) => m.blank.filter((b) => b.reason === "zero_line_entry" && b.follows !== undefined).map((b) => ({ map: m, b })));
const FOLLOWED = [...new Set(ENTRIES.flatMap((e) => [...(e.b.follows ?? [])]))] as LineKey[];

describe("D. mapped blanks cannot hide a printed amount", () => {
  it("every followed amount line is itself filled by a money MapLine of the SAME form map (4a, 5a and sch1a.23 included)", () => {
    expect(FOLLOWED.length).toBeGreaterThanOrEqual(17);
    for (const e of ENTRIES) {
      for (const k of e.b.follows ?? []) {
        const hit = e.map.lines.some((l) => l.kind === "money" && l.line === k);
        expect(hit, `${e.map.formId}: ${k} must be filled by a money line`).toBe(true);
      }
    }
    for (const k of ["f1040.4a", "f1040.5a", "sch1a.23"]) expect(FOLLOWED).toContain(k);
  });
  it("no blank-claimed field of the form_na / zero_line_entry / owner_statement_na reasons is a MapLine field, header or table cell (claimed once)", () => {
    for (const m of FORM_MAPS) {
      const filled = new Set<string>([...m.lines.map((l) => l.field), ...m.header.map((h) => h.field)]);
      for (const t of m.tables ?? []) for (const r of t.rows) for (const f of Object.values(r)) filled.add(f);
      for (const b of m.blank) {
        if (!("field" in b)) continue;
        if (b.reason === "form_na" || b.reason === "zero_line_entry" || b.reason === "owner_statement_na") expect(filled.has(b.field), `${m.formId} ${b.field}`).toBe(false);
      }
    }
  });
  it("a decided blank is never an amount-bearing text field: every zero_line_entry / form_na field of the task has a type/text/code/date/reserved/box description", () => {
    const ok = /(type|specify|reserved|date of|amount repaid|vehicle identification|V I N|Interest for this loan|2 digit year|beginning|ending|Check if|Rollover|Q C D|P S O|^[\w. ]*\d+\. \d\.$|^[\w. ]*\d+\. 3\.$|payee|identifying|Recapture of other credits|Other additions|Other nonrefundable credits \(see instructions\)|Maximum|Footnote|Repaid|If you repaid)/i;
    const TASK_FORMS = new Set(["f1040", "f1040s1", "f1040s2", "f1040s3", "f1040sa", "f1040sb", "f1040s1a", "f1040sse"]);
    for (const m of FORM_MAPS.filter((x) => TASK_FORMS.has(x.formId))) {
      const cat = loadCatalog(m.formId);
      for (const b of m.blank) {
        if (!("field" in b) || !(b.reason === "form_na" || b.reason === "zero_line_entry")) continue;
        const f = cat.fields.find((x) => x.name === b.field);
        expect(f, `${m.formId} ${b.field} exists in the catalog`).toBeDefined();
        if (f?.type !== "text") continue; // check boxes carry no amount
        expect(`${f?.speak ?? ""}`, `${m.formId} ${b.field}: ${f?.speak ?? ""}`).toMatch(ok);
      }
    }
  });
});

// ── A. the safety net, every followed key, real override rows through the real pipeline ─────────────────────────────
function lineRow(key: LineKey, cents: number, snapshot: unknown, n: number): OverrideRow {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents: cents,
    valueText: null,
    computedSnapshot: snapshot,
    authority: "owner",
    reason: "tester: force a followed line non-zero",
    setByName: "Tester",
    setAt: new Date("2026-10-05T12:00:00Z"),
    archivedAt: null,
  };
}

describe("A. a followed line forced non-zero: advisory item + L1.B5.entry-by-hand, and the entry boxes stay blank", () => {
  const skipped: string[] = [];
  const results: string[] = [];
  for (const key of FOLLOWED) {
    it(`${key}`, async () => {
      const base = richScenario();
      const ret0 = computeTy2025Return(base.facts);
      const baseLine = ret0.lines[key];
      if (baseLine === undefined) {
        skipped.push(`${key}: not emitted by this return`);
        return;
      }
      const s = { ...base, overrideRows: [lineRow(key, 50_000, lineSnapshot(baseLine, ret0.engineVersion), 1)] };
      const { ctx } = await buildPipeline(s);
      const pl = ctx.view.lines[key];
      expect(pl?.status, `${key} view status`).toBe("overridden");
      expect(pl?.amount, `${key} view amount`).toBe(500);
      const owners = ENTRIES.filter((e) => e.b.follows?.includes(key));
      const forms = [...new Set(owners.map((e) => e.map.formId))];
      for (const formId of forms) {
        const map = FORM_MAPS.find((m) => m.formId === formId)!;
        const hand = entriesNeedingHand(map, ctx.view);
        expect(hand.some((h) => h.lines.some((l) => l.key === key)), `${formId}: entriesNeedingHand lists ${key}`).toBe(true);
        const filed = ctx.packet.forms.some((f) => f.formId === formId && f.included) || formId === "f1040";
        if (!filed) {
          skipped.push(`${key}: ${formId} is not in this packet (not filed for the rich return)`);
          continue;
        }
        // (1) the advisory item on the packet
        const items = ctx.packet.openItems.filter((i) => i.id.startsWith(`fill:${formId}:entry:`));
        expect(items.length, `${formId}: advisory item for ${key}`).toBeGreaterThan(0);
        expect(items.every((i) => i.severity === "advisory"), "advisory only").toBe(true);
        // (2) the review finding
        const f = (await unkeyedLinesCheck.run(ctx)).filter((x) => x.check === "L1.B5.entry-by-hand" && x.formKey === formId);
        expect(f.length, `${formId}: L1.B5.entry-by-hand for ${key}`).toBeGreaterThan(0);
        expect(f.every((x) => x.severity === "medium" && x.acceptable === true)).toBe(true);
        // (3) nothing printed in the description / type / code boxes; the amount line itself prints $500
        const file = ctx.packet.files.find((x) => x.formId === formId);
        expect(file, `${formId} file`).toBeDefined();
        const doc = await PDFDocument.load(file!.bytes);
        const form = doc.getForm();
        for (const e of owners.filter((o) => o.map.formId === formId)) {
          const field = (e.b as { field?: string }).field;
          if (field === undefined) continue;
          const fld = form.getField(field);
          if (fld instanceof PDFTextField) expect(fld.getText() ?? "", `${formId} ${field} must stay blank`).toBe("");
          if (fld instanceof PDFCheckBox) expect(fld.isChecked(), `${formId} ${field} must stay unchecked`).toBe(false);
        }
        const ml = map.lines.find((l) => l.kind === "money" && l.line === key)!;
        const amt = form.getField(ml.field);
        expect(amt instanceof PDFTextField ? amt.getText() : "", `${formId} ${key} amount printed`).toBe(formatDollars(500));
        results.push(`${key} -> ${formId}: ok`);
      }
      // B5 never reports a gap for these (the override must not turn a decided blank back into "not modeled")
      const all = await unkeyedLinesCheck.run(ctx);
      expect(all.filter((x) => x.check === "L1.B5.unmodeled" || x.check === "L1.B5.footing-part")).toEqual([]);
    });
  }
  it("summary of the loop", () => {
    // not an assertion about content: records what was exercised in the log
    console.log("SAFETY NET exercised:", results.length, "followed-line/form pairs; skipped:", JSON.stringify(skipped));
    expect(results.length).toBeGreaterThan(8);
  });
});

// ── B. Form 1040 line 16 gate ────────────────────────────────────────────────────────────────────────────────────────
type Shape = "tax_table" | "rate_schedule" | "qdcg" | "sch_d_worksheet";
function factsFor(shape: Shape) {
  const f = fullFacts();
  f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
  if (shape === "tax_table" || shape === "rate_schedule") {
    f.income.dividends = [];
    f.income.noDividendsConfirmed = owner(true);
    if (shape === "tax_table") {
      for (const w of f.income.w2s) {
        w.wagesCents = 2_500_000;
        w.medicareWagesCents = 2_500_000;
        w.socialSecurityWagesCents = 2_500_000;
      }
      f.income.scheduleC.glLines = f.income.scheduleC.glLines.slice(0, 1);
    }
  }
  if (shape === "sch_d_worksheet") {
    f.statedNone.capital_special_rates = owner(false);
    const mk = (box: "A" | "D", proceeds: number, cost: number) => ({ form: "1099-B" as const, box, proceedsCents: proceeds, costCents: cost, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: proceeds - cost });
    f.income.brokerSales = [{ docId: "rh", payer: "Robinhood Markets, Inc.", basis: "doc_verified", legacyFormat: false, refs: [{ kind: "document", id: "rh", label: "1099-B" }], summaryRead: true, signalled1099B: true, rows: [mk("A", 900_000, 500_000), mk("D", 2_000_000, 1_000_000)], sec1256AggregateCents: null, forms1099DaPresent: false }];
  }
  return f;
}
const STATES = ["none", "yes", "unsure", "unanswered"] as const;

describe("B. Form 1040 line 16 on every tax path and every state of the other_taxes statement", () => {
  for (const shape of ["tax_table", "rate_schedule", "qdcg", "sch_d_worksheet"] as const) {
    for (const st of STATES) {
      it(`${shape} / other_taxes ${st}`, () => {
        const f = factsFor(shape);
        if (st === "none") f.statedNone.other_taxes = owner(true);
        else if (st === "yes") f.statedNone.other_taxes = owner(false);
        else delete (f.statedNone as Record<string, unknown>).other_taxes;
        const ret = computeTy2025Return(f);
        const l16 = ret.lines["f1040.16"];
        expect(l16?.ruleId, "line 16 is always the tax-calc rule").toBe("tax-calc");
        if (st === "none") {
          if (shape !== "sch_d_worksheet") {
            expect(l16?.status).toBe("computed");
            expect(l16?.amount).not.toBeNull();
          } else {
            // the Schedule D Tax Worksheet is not implemented: blocked on its own reason, with or without the new gate
            expect(l16?.amount ?? null).toBeNull();
            expect(l16?.status === "missing_input" || l16?.status === "needs_cpa_judgment").toBe(true);
          }
        } else if (shape === "sch_d_worksheet") {
          expect(l16?.amount ?? null, "never a value").toBeNull();
          expect(l16?.reason ?? "", "the Schedule D worksheet reason is kept (not replaced by the statement text)").toMatch(/Schedule D Tax Worksheet/);
        } else {
          expect(l16?.amount ?? null, "never a silent figure").toBeNull();
          expect(l16?.status).toBe(st === "yes" ? "needs_cpa_judgment" : "not_yet_computed");
          // everything that adds line 16 is blocked too (no number is printed from a gated line 16)
          for (const k of ["f1040.18", "f1040.22", "f1040.24"] as const) expect(ret.lines[k]?.amount ?? null, k).toBeNull();
          expect(ret.headline.federal.totalTax.amount ?? null).toBeNull();
        }
      });
    }
  }
  it("the answer mapping: Yes -> statement false, Not sure and unanswered -> absent (blocked as not yet computed), No -> true", () => {
    const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
    expect(visibleNodes(def, RC_CONTEXT, {}).some((n) => n.id === "g_other_taxes")).toBe(true);
    const eff = (v: string): EffectiveAnswers => ({ g_other_taxes: { value: v, source: "questionnaire", at: "2026-10-05T00:00:00.000Z", by: null } });
    const p = (v: string) => parseCompletenessAnswers(eff(v), [{ userId: "u1", name: "Eric K" }]).statedNone.other_taxes;
    expect(p("none")).toBe(true);
    expect(p("some")).toBe(false);
    expect(p(UNSURE_ID)).toBeUndefined();
    expect(parseCompletenessAnswers({}, []).statedNone.other_taxes).toBeUndefined();
    // saved answers (no definition change) still resolve
    const saved = effectiveAnswers(def, { g_other_taxes: { v: "none", at: "2026-10-03T00:00:00.000Z", by: null } }, [], RC_CONTEXT);
    expect(saved.g_other_taxes?.value).toBe("none");
  });
  it("the gate blocks only the tax side: no income, adjustment, deduction or Schedule C / D / SE line moves when the statement is Yes", () => {
    const base = computeTy2025Return(factsFor("qdcg"));
    const f = factsFor("qdcg");
    f.statedNone.other_taxes = owner(false);
    const gated = computeTy2025Return(f);
    const changed = Object.keys(gated.lines).filter((k) => {
      const a = base.lines[k as LineKey];
      const b = gated.lines[k as LineKey];
      return a?.status !== b?.status || a?.amount !== b?.amount;
    });
    expect(changed).toContain("f1040.16");
    const incomeSide = changed.filter((k) => /^(sch1.|schc.|scha.|schd.|se.|f8995.|f8959.|f8960.|qdcg.3$|f1040.(1[a-z]?|2[ab]|3[ab]|4[ab]|5[ab]|6[ab]|7|8|9|10|11[ab]|12[a-e]|13[ab]|14|15)$)/.test(k));
    expect(incomeSide, "income-side lines moved").toEqual([]);
    console.log("LINES THAT MOVE (other_taxes Yes vs none, QDCG shape):", changed.join(" "));
  });
});

// ── C. 24z / 6z ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("C. Schedule 1 line 24z and Schedule 3 line 6z", () => {
  it("are zero whatever the other_adjustments / other_nonrefundable_credits answers are, and the neighbouring lines still follow the answers", () => {
    for (const st of [true, false, "unset"] as const) {
      const f = fullFacts();
      if (st === "unset") {
        delete (f.statedNone as Record<string, unknown>).other_adjustments;
        delete (f.statedNone as Record<string, unknown>).other_nonrefundable_credits;
      } else {
        f.statedNone.other_adjustments = owner(st);
        f.statedNone.other_nonrefundable_credits = owner(st);
      }
      const ret = computeTy2025Return(f);
      expect(ret.lines["sch1.24z"]).toMatchObject({ status: "not_applicable", amount: 0 });
      expect(ret.lines["sch3.6z"]).toMatchObject({ status: "not_applicable", amount: 0 });
      // the sibling lines of the same groups are still gated (the group did not stop working)
      expect(ret.lines["sch1.24a"]?.status === "not_applicable").toBe(st === true);
      expect(ret.lines["sch3.6a"]?.status === "not_applicable").toBe(st === true);
    }
  });
});
