// The overpayment decisions X7 / X8 on the printed forms: Form 1040 lines 35a / 36 and CT-1040 lines 23 / 25 print what the engine
// computed (a computed 0 prints blank, undecided prints blank), CT lines 24 / 24a stay blank with the "never modelled" note, and the
// "To do by hand" list drops the two overpayment bullets once the decision is recorded.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { BY_HAND, buildIndexLines, byHandItems, scanChrome } from "@/lib/tax2025/pdf/final-package";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { findFinalPackageBannedWording } from "@/lib/tax-wording";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { MapBlank } from "@/lib/tax2025/pdf/types";
import type { DecidedOverpayment, Ty2025Decisions, Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields, type FieldValue } from "./tax2025-pdf-harness";
import { fieldOfLine } from "./tax-review-harness";

const OPTS = { generatedAt: "2026-10-06T12:00:00.000Z", generatedBy: "Overpayment Test" } as const;
const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const refund = (): DecidedOverpayment => ({ chosen: "refund_all", ...WHO });
const applyAmount = (n: number): DecidedOverpayment => ({ chosen: "apply_amount", appliedDollars: n, ...WHO });

function overFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.income.w2s[0]!.fedWithheldCents = (f.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
  f.income.w2s[0]!.ctWithheldCents = (f.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
  return f;
}

interface Printed {
  ret: Ty2025Return;
  f1040: Map<string, FieldValue>;
  ct: Map<string, FieldValue>;
  ctItemIds: string[];
  view: ReturnType<typeof toPdfReturnView>;
}

async function print(decisions: Ty2025Decisions, facts: Ty2025Facts = overFacts()): Promise<Printed> {
  const ret = computeTy2025Return(facts, decisions);
  const view = toPdfReturnView(ret, facts, OPTS);
  const fed = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
  const ct = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
  return { ret, f1040: await readAllFields(fed.bytes), ct: await readAllFields(ct.bytes), ctItemIds: ct.openItems.map((i) => i.id), view };
}
const fed = (p: Printed, line: string): string => String(p.f1040.get(fieldOfLine(f1040Map, line)) ?? "");
const ct = (p: Printed, field: string): string => String(p.ct.get(`ct1040.${field}`) ?? "");
/** The exact-field blank entries of a map (the regex entries match field names instead). */
const fieldBlanks = (map: { blank: readonly MapBlank[] }): { field: string; reason: string; note?: string }[] =>
  map.blank.flatMap((b) => ("field" in b ? [{ field: b.field, reason: b.reason, ...(b.note === undefined ? {} : { note: b.note }) }] : []));
const n = (s: string): number => (s === "" ? 0 : parseInt(s.replace(/,/g, ""), 10));

describe("the CT-1040 map: line 23 is a money line, 24 / 24a stay blank with the 'never modelled' note", () => {
  it("l23 is claimed as the engine line ct1040.23; l24 and l24a are not_modeled blanks that say they are never modelled", () => {
    expect(ct1040Map.lines.some((l) => l.kind === "money" && l.field === "ct1040.l23" && l.line === "ct1040.23")).toBe(true);
    for (const f of ["ct1040.l24", "ct1040.l24a"]) {
      const b = fieldBlanks(ct1040Map).find((x) => x.field === f);
      expect(b?.reason, f).toBe("not_modeled");
      expect(b?.note, f).toContain("never models them");
      expect(b?.note, f).toContain("decision X8");
    }
    expect(fieldBlanks(ct1040Map).some((x) => x.field === "ct1040.l23")).toBe(false);
  });
});

describe("undecided: everything prints blank exactly as before", () => {
  it("35a, 36, CT 23, 24, 24a and 25 are blank; CT 22 and Form 1040 line 34 print the overpayment", async () => {
    const p = await print({});
    expect(n(fed(p, "f1040.34"))).toBeGreaterThan(1000);
    expect(n(ct(p, "l22"))).toBeGreaterThan(1000);
    expect(fed(p, "f1040.35a")).toBe("");
    expect(fed(p, "f1040.36")).toBe("");
    for (const f of ["l23", "l24", "l24a", "l25"]) expect(ct(p, f), f).toBe("");
  });
});

describe("refund all on both: 35a and CT 25 print; 36, CT 23, 24, 24a stay blank", () => {
  it("prints line 34 on line 35a and line 22 on line 25", async () => {
    const p = await print({ federalOverpayment: refund(), ctOverpayment: refund() });
    expect(n(fed(p, "f1040.35a"))).toBe(n(fed(p, "f1040.34")));
    expect(fed(p, "f1040.36")).toBe("");
    expect(n(ct(p, "l25"))).toBe(n(ct(p, "l22")));
    for (const f of ["l23", "l24", "l24a"]) expect(ct(p, f), f).toBe("");
    // Form 8888 box, direct deposit: still blank (by hand)
    expect(p.ctItemIds.some((id) => id.includes("ct1040.23"))).toBe(false);
  });
  it("the Form 1040 and CT bank fields stay blank", async () => {
    const p = await print({ federalOverpayment: refund(), ctOverpayment: refund() });
    const bank = fieldBlanks(f1040Map).filter((b) => b.reason === "bank");
    expect(bank.length).toBeGreaterThan(0);
    // text fields read "" and checkboxes false when untouched
    for (const b of bank) expect(["", false], b.field).toContain(p.f1040.get(b.field) ?? "");
    // the Form 8888 box next to line 35a is not ticked either
    for (const b of fieldBlanks(f1040Map).filter((x) => /8888/.test(x.note ?? ""))) expect(p.f1040.get(b.field) ?? false, b.field).toBeFalsy();
  });
});

describe("apply all and a stated amount print the hand tables", () => {
  it("apply all: 35a blank (0), 36 = line 34; CT 23 = line 22, CT 25 blank", async () => {
    const p = await print({ federalOverpayment: { chosen: "apply_all", ...WHO }, ctOverpayment: { chosen: "apply_all", ...WHO } });
    expect(fed(p, "f1040.35a")).toBe("");
    expect(n(fed(p, "f1040.36"))).toBe(n(fed(p, "f1040.34")));
    expect(n(ct(p, "l23"))).toBe(n(ct(p, "l22")));
    expect(ct(p, "l25")).toBe("");
  });
  it("a stated amount: 35a + 36 = line 34 and 23 + 25 = line 22 on the printed form", async () => {
    const p = await print({ federalOverpayment: applyAmount(5000), ctOverpayment: applyAmount(400) });
    expect(n(fed(p, "f1040.36"))).toBe(5000);
    expect(n(fed(p, "f1040.35a")) + n(fed(p, "f1040.36"))).toBe(n(fed(p, "f1040.34")));
    expect(n(ct(p, "l23"))).toBe(400);
    expect(n(ct(p, "l23")) + n(ct(p, "l25"))).toBe(n(ct(p, "l22")));
  });
});

describe("the cover lists both decisions", () => {
  it("undecided: under 'Defaults in force'; decided: under 'Decisions recorded' with the choice", async () => {
    const text = (p: Printed): string =>
      buildCoverModel({ view: p.view, forms: [], fillItems: [], continuations: [], stamp: true })
        .blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : "text" in b ? b.text : ""))
        .join("\n");
    const u = text(await print({}));
    expect(u).toContain("Overpayment on Form 1040 line 34");
    expect(u).toContain("Overpayment on CT-1040 line 22");
    expect(u).toMatch(/\(lines 35a and 36\): no_election \(default, undecided\)/);
    expect(u).toMatch(/\(lines 23 and 25\): no_election \(default, undecided\)/);
    const d = text(await print({ federalOverpayment: refund(), ctOverpayment: applyAmount(400) }));
    expect(d).toMatch(/Decisions recorded/);
    expect(d).toContain("(lines 35a and 36): refund_all");
    expect(d).toContain("(lines 23 and 25): apply_amount:400");
    expect(d).not.toMatch(/\bCPA\b/);
  });
});

describe("byHandItems: the two overpayment bullets follow the decisions", () => {
  const FED = "Form 1040 lines 35a and 36";
  const CT = "CT-1040 lines 23, 24 and 24a";
  const has = (items: readonly string[], prefix: string): boolean => items.some((t) => t.startsWith(prefix));
  it("undecided keeps both bullets with their ORIGINAL text (the hint exists only with withPageHints); decided drops them; no decision (no overpayment) drops them", () => {
    const undecided = [{ id: "X7", status: "default_undecided" as const }, { id: "X8", status: "default_undecided" as const }];
    const u = byHandItems(undecided);
    expect(has(u, FED) && has(u, CT)).toBe(true);
    expect(u).toEqual(BY_HAND.filter((t) => true)); // nothing added, nothing removed: the original neutral list
    const page = byHandItems(undecided, { withPageHints: true });
    expect(page.find((t) => t.startsWith(FED))).toContain("record decision X7");
    expect(page.find((t) => t.startsWith(CT))).toContain("record decision X8");
    // the hint changes only those two bullets
    expect(page.filter((t) => !t.startsWith(FED) && !t.startsWith(CT))).toEqual(BY_HAND.filter((t) => !t.startsWith(FED) && !t.startsWith(CT)));
    const d = byHandItems([{ id: "X7", status: "decided" }, { id: "X8", status: "decided" }]);
    expect(has(d, FED) || has(d, CT)).toBe(false);
    const none = byHandItems([]);
    expect(has(none, FED) || has(none, CT)).toBe(false);
    // independent
    const half = byHandItems([{ id: "X7", status: "decided" }, { id: "X8", status: "default_undecided" }]);
    expect(has(half, FED)).toBe(false);
    expect(has(half, CT)).toBe(true);
  });
  it("every other bullet is unchanged and in order; the bank, signature and 7b bullets stay; unknown decisions give the full catalogue", () => {
    const d = byHandItems([{ id: "X7", status: "decided" }, { id: "X8", status: "decided" }]);
    expect(d).toEqual(BY_HAND.filter((t) => !t.startsWith(FED) && !t.startsWith(CT)));
    expect(d.some((t) => t.startsWith("Bank routing and account numbers"))).toBe(true);
    expect(byHandItems()).toBe(BY_HAND);
  });
  it("S1: 'decisions not supplied' (undefined or null) is the FULL list, and is not the same as an empty list (no overpayment)", () => {
    expect(byHandItems(undefined)).toBe(BY_HAND);
    expect(byHandItems(null)).toBe(BY_HAND);
    expect(byHandItems(null, { withPageHints: true })).toBe(BY_HAND);
    expect(byHandItems([]).length).toBe(BY_HAND.length - 2);
    expect(has(byHandItems(null), FED) && has(byHandItems(null), CT)).toBe(true);
  });
  it("every variant passes the final-package banned-wording scan", () => {
    for (const ds of [[{ id: "X7", status: "default_undecided" as const }, { id: "X8", status: "default_undecided" as const }], []]) {
      for (const t of byHandItems(ds)) expect(findFinalPackageBannedWording(t), t).toEqual([]);
    }
    // the page-only hint says "app" (it never reaches the package): that is exactly why the index must not use it
    const hinted = byHandItems([{ id: "X7", status: "default_undecided" }], { withPageHints: true }).join(" ");
    expect(hinted).toMatch(/\bapp\b/);
  });
  it("the package index prints the same list: undecided has the bullets, decided does not, and the index scan is clean", async () => {
    const lines = async (decisions: Ty2025Decisions): Promise<string> => {
      const p = await print(decisions);
      const idx = buildIndexLines({ view: p.view, formFiles: [{ name: "forms/01-f1040.pdf", title: "Form 1040" }], attachments: [], notIncluded: [], hasForm8949Summary: false });
      expect(scanChrome(idx)).toEqual([]);
      return idx.map((l) => (l.block.kind === "kv" ? `${l.block.label}: ${l.block.value}` : "text" in l.block ? l.block.text : "")).join("\n");
    };
    const u = await lines({});
    expect(u).toContain(FED);
    expect(u).toContain(CT);
    // B1: the undecided index keeps the neutral original bullets: no "app", no decision id, clean under the final-package scan
    expect(u).toContain("(your choice; left blank)");
    expect(u).not.toMatch(/\bapp\b|decision X|\bX7\b|\bX8\b|Or record/i);
    expect(findFinalPackageBannedWording(u)).toEqual([]);
    const d = await lines({ federalOverpayment: refund(), ctOverpayment: refund() });
    expect(d).not.toContain(FED);
    expect(d).not.toContain(CT);
    expect(d).toContain("Bank routing and account numbers");
  });
});
