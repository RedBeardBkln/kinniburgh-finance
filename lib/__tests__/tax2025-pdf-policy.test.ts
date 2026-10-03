import { describe, expect, it } from "vitest";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { formInclusion, resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import type { FormMap, MapMoneyLine } from "@/lib/tax2025/pdf/types";
import { f1040Lines, makeView, pdfLine } from "./fixtures/tax2025-pdf-view.fixture";

const entry: MapMoneyLine = { kind: "money", field: "x", line: "f1040.2b" };
const entryZero: MapMoneyLine = { ...entry, zero: "print" };
const mk = (status: Parameters<typeof pdfLine>[0]["status"], amount: number | null, extra: Partial<Parameters<typeof pdfLine>[0]> = {}) =>
  pdfLine({ key: "f1040.2b", formLabel: "Form 1040", formLine: "2b", label: "Taxable interest", status, amount, ...extra });

describe("resolveFieldValue (blank policy table)", () => {
  it("computed non-zero -> the formatted amount, no item", () => {
    expect(resolveFieldValue("f1040", mk("computed", 1234), entry)).toEqual({ write: "1,234", items: [] });
    expect(resolveFieldValue("f1040", mk("computed", -50), entry).write).toBe("-50");
  });

  it("computed zero -> blank on detail lines, '0' only when the map says zero:print", () => {
    expect(resolveFieldValue("f1040", mk("computed", 0), entry)).toEqual({ write: null, items: [] });
    expect(resolveFieldValue("f1040", mk("computed", 0), entryZero)).toEqual({ write: "0", items: [] });
  });

  it("not_applicable -> blank (or '0' with zero:print), never an item", () => {
    expect(resolveFieldValue("f1040", mk("not_applicable", 0), entry)).toEqual({ write: null, items: [] });
    expect(resolveFieldValue("f1040", mk("not_applicable", 0), entryZero).write).toBe("0");
  });

  it("missing_input and needs_cpa_* -> blank + BLOCKING item, never 0", () => {
    for (const s of ["missing_input", "needs_cpa_rule_unverified", "needs_cpa_judgment"] as const) {
      const d = resolveFieldValue("f1040", mk(s, null, { reason: "why" }), entryZero);
      expect(d.write, s).toBeNull();
      expect(d.items).toHaveLength(1);
      expect(d.items[0]?.severity).toBe("blocking");
      expect(d.items[0]?.id).toBe("blank:f1040:f1040.2b");
      expect(d.items[0]?.message).toContain("why");
    }
  });

  it("not_yet_computed -> blank + advisory item, even with zero:print", () => {
    const d = resolveFieldValue("f1040", mk("not_yet_computed", null), entryZero);
    expect(d.write).toBeNull();
    expect(d.items[0]?.severity).toBe("advisory");
  });

  it("no ReturnLine -> blank; an item only when the map flags expected", () => {
    expect(resolveFieldValue("f1040", undefined, entry)).toEqual({ write: null, items: [] });
    const d = resolveFieldValue("f1040", undefined, { ...entry, expected: true });
    expect(d.write).toBeNull();
    expect(d.items[0]?.id).toBe("noemit:f1040:f1040.2b");
  });

  it("overridden -> the override amount with the note as tooltip; an explicit $0 pin prints '0'", () => {
    const o = mk("overridden", 3000, { override: { note: "CPA override: was $2,500 computed, now $3,000", computedAmount: 2500, stale: false } });
    expect(resolveFieldValue("f1040", o, entry)).toEqual({ write: "3,000", tooltip: "CPA override: was $2,500 computed, now $3,000", items: [] });
    const zero = mk("overridden", 0, { override: { note: "n", computedAmount: 5, stale: false } });
    expect(resolveFieldValue("f1040", zero, entry).write).toBe("0");
  });

  it("default undecided -> the amount with a 'default, undecided' tooltip", () => {
    const d = resolveFieldValue("f1040", mk("computed", 5000, { defaultUndecided: "QBI form: Form 8995" }), entry);
    expect(d.write).toBe("5,000");
    expect(d.tooltip).toBe("default, undecided: QBI form: Form 8995");
  });

  it("refuses a float or a missing amount on an amount-carrying status", () => {
    const f = resolveFieldValue("f1040", mk("computed", 12.5), entry);
    expect(f.write).toBeNull();
    expect(f.items[0]?.severity).toBe("blocking");
    const n = resolveFieldValue("f1040", mk("computed", null), entry);
    expect(n.write).toBeNull();
    expect(n.items[0]?.severity).toBe("blocking");
  });
});

describe("formInclusion", () => {
  const sch: FormMap = {
    formId: "f1040s2",
    lines: [{ kind: "money", field: "a", line: "sch2.3" }, { kind: "money", field: "b", line: "sch2.4" }],
    tables: [],
    header: [],
    blank: [],
  };
  const lineOf = (key: "sch2.3" | "sch2.4", status: Parameters<typeof pdfLine>[0]["status"], amount: number | null) =>
    pdfLine({ key, formLabel: "Schedule 2", formLine: key.slice(5), label: "x", status, amount });

  it("always includes the 1040", () => {
    expect(formInclusion(f1040Map, makeView({ lines: {} })).include).toBe(true);
    expect(formInclusion(f1040Map, makeView({ lines: f1040Lines() })).include).toBe(true);
  });

  it("includes when a mapped line is computed non-zero", () => {
    const v = makeView({ lines: { "sch2.4": lineOf("sch2.4", "computed", 100) } });
    expect(formInclusion(sch, v).include).toBe(true);
  });

  it("includes when a mapped line needs input or a CPA decision", () => {
    for (const s of ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified"] as const) {
      expect(formInclusion(sch, makeView({ lines: { "sch2.3": lineOf("sch2.3", s, null) } })).include, s).toBe(true);
    }
  });

  it("omits when every mapped line is not applicable, zero or not yet computed, or absent", () => {
    const v = makeView({
      lines: { "sch2.3": lineOf("sch2.3", "not_applicable", 0), "sch2.4": lineOf("sch2.4", "computed", 0) },
    });
    const r = formInclusion(sch, v);
    expect(r.include).toBe(false);
    expect(r.reason).toMatch(/not applicable, zero or not yet computed/);
    expect(formInclusion(sch, makeView({ lines: { "sch2.3": lineOf("sch2.3", "not_yet_computed", null) } })).include).toBe(false);
    const none = formInclusion(sch, makeView({ lines: {} }));
    expect(none.include).toBe(false);
    expect(none.reason).toMatch(/emitted no line/);
  });
});
