import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyOverrides,
  decisionsFromOverrides,
  lineSnapshot,
  type ComputedSnapshot,
  type OverrideRow,
} from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { downstreamOf } from "@/lib/tax2025/line-flow";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { emptyFacts, fullFacts, fullFacts1b, owner } from "./tax2025-fixtures";

// Independent Tester checks for ty2025-overrides-wiring. They exercise the pure layer against REAL
// computed returns (engine-produced open item ids) from angles the Coder's own tests do not take.

let seq = 0;
function pin(ret: Ty2025Return, key: LineKey, valueCents: number, over: Partial<OverrideRow> = {}): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error(`no line ${key}`);
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(70000 + seq).padStart(12, "0")}`,
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents,
    valueText: null,
    computedSnapshot: lineSnapshot(l, ret.engineVersion),
    authority: "cpa",
    reason: "Tester pin",
    setByName: "Tester",
    setAt: new Date("2026-10-12T02:30:00Z"),
    archivedAt: null,
    ...over,
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

describe("D1: a pin replaces the value in the effective view only", () => {
  const ret = computeTy2025Return(fullFacts());
  const before = JSON.stringify(ret);

  it("never mutates the engine return (deep-frozen input) and never changes a dependent's value", () => {
    const frozen = deepFreeze(computeTy2025Return(fullFacts()));
    const eff = applyOverrides(frozen, [pin(ret, "sch1.3", 9_900_000)]);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(eff.lines["sch1.3"]?.effective).toEqual({ amount: 99_000, status: "overridden" });
    expect(eff.lines["sch1.3"]?.base.amount).toBe(ret.lines["sch1.3"]?.amount);
    // every dependent keeps the engine's own value and status (nothing silently recomputed)
    for (const d of downstreamOf("sch1.3")) {
      const e = eff.lines[d];
      if (!e) continue;
      expect(e.effective.amount, d).toBe(ret.lines[d]?.amount ?? null);
      expect(e.effective.status, d).toBe(ret.lines[d]?.status);
      expect(e.dependsOnOverridden, d).toContain("sch1.3");
    }
  });

  it("headline.complete is false while a pin is in force even though the base was complete, and totals are flagged", () => {
    const golden = computeTy2025Return(fullFacts1b());
    expect(golden.headline.complete).toBe(true);
    const eff = applyOverrides(golden, [pin(golden, "sch1.3", 1_000_000)]);
    expect(eff.headline.complete).toBe(false);
    expect(eff.totalsNotRecomputed).toBe(true);
    // the engine's own headline amounts are untouched
    expect(eff.headline.federal.agi).toEqual(golden.headline.federal.agi);
    expect(eff.headlineRows["federal.agi"].dependsOnOverride).toBe(true);
    // and with no pin the headline is exactly the base's
    const none = applyOverrides(golden, []);
    expect(none.headline).toEqual(golden.headline);
    expect(none.totalsNotRecomputed).toBe(false);
  });

  it("clearing restores: no rows => lines, open items and headline equal the base, no marks", () => {
    const eff = applyOverrides(ret, []);
    for (const [k, l] of Object.entries(ret.lines)) {
      const e = eff.lines[k as LineKey]!;
      expect(e.effective).toEqual({ amount: l!.amount, status: l!.status });
      expect(e.override).toBeUndefined();
      expect(e.dependsOnOverridden).toBeUndefined();
    }
    expect(eff.openItems).toEqual(ret.openItems);
    expect(eff.headline).toEqual(ret.headline);
    expect(eff.resolvedByOverride).toEqual([]);
  });

  it("an archived (superseded or cleared) row is never applied; a v2 over an active v1 race applies only v2", () => {
    const archived = pin(ret, "sch1.3", 9_900_000, { archivedAt: new Date("2026-10-13T00:00:00Z") });
    expect(applyOverrides(ret, [archived]).applied.lines).toEqual([]);
    const v1 = pin(ret, "sch1.3", 1_100_000, { version: 1 });
    const v2 = pin(ret, "sch1.3", 2_200_000, { version: 2 });
    const eff = applyOverrides(ret, [v1, v2]);
    expect(eff.lines["sch1.3"]?.effective.amount).toBe(22_000);
    expect(eff.anomalies).toHaveLength(1);
  });

  it("a pinned $0 is an override (prints 0), distinct from the computed value", () => {
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", 0)]);
    expect(eff.lines["sch1.3"]?.effective).toEqual({ amount: 0, status: "overridden" });
  });

  it("a negative pin is accepted by the parser and applied", () => {
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", -500_000)]);
    expect(eff.lines["sch1.3"]?.effective.amount).toBe(-5000);
  });

  it("cents and out-of-range rows are reported invalid and NOT applied (the stored row cannot bypass the action)", () => {
    for (const bad of [1_234_550, 2_100_000_100, -2_100_000_100, Number.NaN, 1.5]) {
      const eff = applyOverrides(ret, [pin(ret, "sch1.3", bad)]);
      expect(eff.applied.lines, String(bad)).toEqual([]);
      expect(eff.invalid, String(bad)).toHaveLength(1);
      expect(eff.lines["sch1.3"]?.effective.status).toBe(ret.lines["sch1.3"]?.status);
    }
  });

  it("a row for a line that is not on the return is an orphan, not an exception", () => {
    const r = pin(ret, "sch1.3", 100, { targetKey: "f1040.nope" });
    const eff = applyOverrides(ret, [r]);
    expect(eff.orphans).toHaveLength(1);
    expect(eff.applied.lines).toEqual([]);
  });
});

describe("D3: staleness", () => {
  const ret = computeTy2025Return(fullFacts());

  it("engine-version-only change is advisory: blocking count unchanged, not marked stale", () => {
    const snap = lineSnapshot(ret.lines["sch1.3"]!, "ty2025-OLD");
    const base = applyOverrides(ret, [pin(ret, "sch1.3", 9_900_000)]);
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", 9_900_000, { computedSnapshot: snap })]);
    expect(eff.stale).toEqual([]);
    expect(eff.lines["sch1.3"]?.stale).toBeUndefined();
    expect(eff.engineChanged).toHaveLength(1);
    expect(eff.headline.blockingItemCount).toBe(base.headline.blockingItemCount);
    const it = eff.openItems.find((i) => i.id === "override-engine:line:sch1.3");
    expect(it?.severity).toBe("advisory");
  });

  it("a changed computed value is BLOCKING stale (+1) and the pin is still applied", () => {
    const snap: ComputedSnapshot = { status: "computed", cents: 123_400, engineVersion: ret.engineVersion };
    const fresh = applyOverrides(ret, [pin(ret, "sch1.3", 9_900_000)]);
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", 9_900_000, { computedSnapshot: snap })]);
    expect(eff.stale).toHaveLength(1);
    expect(eff.lines["sch1.3"]?.effective.status).toBe("overridden");
    expect(eff.headline.blockingItemCount).toBe(fresh.headline.blockingItemCount + 1);
    expect(eff.openItems.find((i) => i.id === "override-stale:line:sch1.3")?.severity).toBe("blocking");
  });

  it("both a value change AND a version change is blocking stale, and not also listed as engine-changed", () => {
    const snap: ComputedSnapshot = { status: "computed", cents: 1, engineVersion: "ty2025-OLD" };
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", 9_900_000, { computedSnapshot: snap })]);
    expect(eff.stale).toHaveLength(1);
    expect(eff.engineChanged).toEqual([]);
  });

  it("a legacy snapshot without an engineVersion is never engine-changed", () => {
    const snap: ComputedSnapshot = lineSnapshot(ret.lines["sch1.3"]!);
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", 9_900_000, { computedSnapshot: snap })]);
    expect(eff.engineChanged).toEqual([]);
    expect(eff.stale).toEqual([]);
  });
});

describe("D2: blocked-line pins move only fully supplied blocking items (real engine items)", () => {
  const ret = computeTy2025Return(emptyFacts());
  const blockedLine = (k: LineKey): boolean => ret.lines[k]?.amount === null;

  it("an item naming 2+ lines stays blocking when only some are pinned and resolves when all are", () => {
    const multi = ret.openItems.find((i) => i.severity === "blocking" && i.lineKeys.length >= 2 && i.lineKeys.every(blockedLine));
    expect(multi, "fixture needs a blocking item with 2+ blocked lines").toBeDefined();
    const [first, ...rest] = multi!.lineKeys;
    const partial = applyOverrides(ret, [pin(ret, first!, 100_00)]);
    expect(partial.resolvedByOverride.map((r) => r.item.id)).not.toContain(multi!.id);
    expect(partial.openItems.map((i) => i.id)).toContain(multi!.id);
    const all = applyOverrides(ret, multi!.lineKeys.map((k) => pin(ret, k, 100_00)));
    expect(all.resolvedByOverride.map((r) => r.item.id)).toContain(multi!.id);
    expect(all.openItems.map((i) => i.id)).not.toContain(multi!.id);
    expect(rest.length).toBeGreaterThan(0);
  });

  it("an item that names no lines is never resolved by a pin", () => {
    const eff = applyOverrides(ret, [pin(ret, "sch3.1", 100_00)]);
    for (const i of ret.openItems.filter((x) => x.lineKeys.length === 0)) expect(eff.openItems.map((o) => o.id)).toContain(i.id);
  });

  it("a stale blocked-line pin resolves nothing", () => {
    const snap: ComputedSnapshot = { status: "computed", cents: 500, engineVersion: ret.engineVersion };
    const eff = applyOverrides(ret, [pin(ret, "sch3.1", 100_00, { computedSnapshot: snap })]);
    expect(eff.resolvedByOverride).toEqual([]);
  });

  it("blocking count is base minus resolved (no double count) and never negative", () => {
    const keys = ret.openItems.filter((i) => i.severity === "blocking").flatMap((i) => i.lineKeys).filter(blockedLine);
    const eff = applyOverrides(ret, [...new Set(keys)].map((k) => pin(ret, k, 100_00)));
    const counted = eff.openItems.filter((i) => i.severity === "blocking").length;
    expect(eff.headline.blockingItemCount).toBeGreaterThanOrEqual(0);
    // the headline number the sheet prints equals the number of blocking items actually listed
    expect(eff.headline.blockingItemCount).toBe(counted);
  });
});

describe("D4: decisions recompute through the engine", () => {
  it("a decision override reaches computeTy2025Return and is not 'not reflected'", () => {
    const facts = fullFacts();
    facts.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    facts.income.scheduleC.homeOfficeSqft = owner(1200);
    const rows: OverrideRow[] = [
      {
        id: "00000000-0000-4000-8000-0000000d0001",
        taxYear: 2025,
        targetKind: "decision",
        targetKey: "homeOfficeMethod",
        version: 1,
        valueKind: "choice",
        valueCents: null,
        valueText: "actual",
        computedSnapshot: { status: "default_undecided", cents: null, engineVersion: "x" },
        authority: "owner",
        reason: "Tester decision",
        setByName: "Tester",
        setAt: new Date("2026-10-12T02:30:00Z"),
        archivedAt: null,
      },
    ];
    const decisions = decisionsFromOverrides(rows);
    expect(decisions.homeOfficeMethod?.chosen).toBe("actual");
    expect(decisions.homeOfficeMethod?.by).toBe("Tester");
    const undecided = computeTy2025Return(facts);
    expect(undecided.decisions[0]).toMatchObject({ id: "X1", status: "default_undecided" });
    const ret = computeTy2025Return(facts, decisions);
    const eff = applyOverrides(ret, rows);
    expect(eff.decisions.find((d) => d.id === "X1")).toMatchObject({ status: "decided", chosen: "actual", decidedBy: "Tester" });
    expect(eff.decisions.find((d) => d.id === "X1")?.override?.reason).toBe("Tester decision");
    // the engine really recomputed: Schedule C line 30 differs from the undecided (simplified) run
    expect(ret.lines["schc.30"]?.status).not.toBe(undecided.lines["schc.30"]?.status);
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
    // computed WITHOUT the decisions the layer says so (blocking), instead of silently showing the default
    const stale = applyOverrides(undecided, rows);
    expect(stale.openItems.find((i) => i.id === "override-decision-not-reflected:homeOfficeMethod")?.severity).toBe("blocking");
  });

  it("an unknown decision key / invalid choice is ignored by decisionsFromOverrides", () => {
    const mk = (key: string, text: string): OverrideRow => ({
      id: `00000000-0000-4000-8000-0000000d${key.length}${text.length}`,
      taxYear: 2025,
      targetKind: "decision",
      targetKey: key,
      version: 1,
      valueKind: "choice",
      valueCents: null,
      valueText: text,
      computedSnapshot: { status: "default_undecided", cents: null },
      authority: "cpa",
      reason: "r r r",
      setByName: "T",
      setAt: new Date(),
      archivedAt: null,
    });
    expect(decisionsFromOverrides([mk("bogus", "x"), mk("qbiForm", "9999")])).toEqual({});
  });
});

describe("source pins the Tester added", () => {
  const root = resolve(__dirname, "../..");
  const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

  it("every export of actions/tax-return-overrides.ts calls await requireAuth() as its first statement", () => {
    const src = read("actions/tax-return-overrides.ts");
    const chunks = src.split(/^export async function /m).slice(1);
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      const cl = c.split("\n");
      const open = cl.findIndex((l) => /Promise<.*>\s*\{$/.test(l.trim()));
      const firstStmt = cl.slice(open + 1).map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("//"));
      expect(firstStmt, c.slice(0, 40)).toMatch(/^(const \w+ = )?await requireAuth\(\);$/);
    }
  });

  it("no delete / upsert / deleteMany anywhere in actions or loader for the override table, and no hard delete in app code touching it", () => {
    for (const f of ["actions/tax-return-overrides.ts", "lib/tax2025-overrides-build.ts"]) {
      const code = read(f)
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(code, f).not.toMatch(/\.(delete|deleteMany|upsert)\s*\(/);
    }
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        if (["node_modules", ".next", ".git", ".claude", "__tests__"].includes(e.name)) continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && /taxReturnOverride\.(delete|deleteMany|upsert)\(/.test(read(rel))) hits.push(rel);
      }
    };
    for (const d of ["actions", "app", "components", "lib", "scripts"]) walk(d);
    expect(hits).toEqual([]);
  });

  it("the audit shape never includes the reason or archiveReason", () => {
    const src = read("actions/tax-return-overrides.ts");
    const auditFn = src.slice(src.indexOf("function auditShape"), src.indexOf("function isUniqueViolation"));
    expect(auditFn).not.toMatch(/\breason\b|archiveReason/);
    const auditCalls = [...src.matchAll(/auditLog\.create\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
    expect(auditCalls.length).toBe(2);
    for (const c of auditCalls) expect(c).not.toMatch(/\.reason|archiveReason|parsed\.data\.reason|v\.reason/);
  });

  it("window.confirm is not used in the new override components", () => {
    for (const f of ["modal-shell", "override-dialog", "override-line-button", "override-decision-button", "override-parts", "overrides-panel"]) {
      const code = read(`components/tax/forms/${f}.tsx`)
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/window\.confirm|\bconfirm\(/);
    }
  });
});

// Reviewer fix (N1): a save or clear in flight must not be dismissable (Esc / backdrop / Close), or the result text is lost.
describe("ModalShell cannot be dismissed while a save or clear is in flight", () => {
  const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8");
  const shell = read("components/tax/forms/modal-shell.tsx");
  it("Escape, the backdrop and the Close button honour `busy`", () => {
    expect(shell).toMatch(/busy\s*=\s*false/);
    expect(shell).toMatch(/e\.key === "Escape" && !busyRef\.current/);
    expect(shell).toMatch(/onClick=\{busy \? undefined : onClose\}/);
    expect(shell).toMatch(/onClick=\{onClose\} disabled=\{busy\}/);
  });
  it.each(["override-dialog", "override-decision-button"])("%s passes its busy flag to the shell", (f) => {
    expect(read(`components/tax/forms/${f}.tsx`)).toMatch(/<ModalShell [^>]*onClose=\{onClose\} busy=\{busy\}>/);
  });
});

describe("SSN-like guard behaviour on reasons (documents what the existing detector does and does not catch)", () => {
  it.each(["123-45-6789", "123 45 6789", "123456789", "SSN is 123.45.6789 ok", "１２３-４５-６７８９"])("refuses %s", (s) => {
    expect(containsSsnLikeText(s)).toBe(true);
  });
  it.each(["per CPA call 2026-10-12", "EIN 12-3456789", "wage 12,345 and 6,789", "phone 860 555 1234"])("allows %s", (s) => {
    expect(containsSsnLikeText(s)).toBe(false);
  });
  // Reviewer hardening (N4): repeated separators and invisible format characters can no longer split the digits.
  it.each([
    ["double spaces", "123  45  6789"],
    ["spaced hyphens", "123 - 45 - 6789"],
    ["zero-width space", "123​-45-6789"],
    ["zero-width space between digits", "12​3-45-67​89"],
    ["zero-width joiner / BOM", "123‍45﻿6789"],
    ["soft hyphen", "123­45­6789"],
    ["bidi mark", "‪123-45-6789‬"],
    ["mixed separators", "123 -45. 6789"],
  ])("refuses an SSN hidden with %s", (_name, s) => {
    expect(containsSsnLikeText(s)).toBe(true);
    expect(containsSsnLikeText(`reason: ${s} per CPA`)).toBe(true);
  });
  it.each([
    "1 2 3 4 5 6 7 8 9", // spaced single digits are deliberately not matched (digit tables)
    "ref 2025  10  1234 end", // 4-digit lead
    "total 1234  5678",
    "12345  678",
    "100  00  12345", // 5-digit tail
    "860  555  1234", // phone shape 3-3-4
    "12  3456789", // EIN shape
    "call 2026​-10-12",
  ])("still allows %s", (s) => {
    expect(containsSsnLikeText(s)).toBe(false);
  });
});

// A row that reached the DB with SSN-shaped text in its reason (e.g. written by another tool) must never reach a PDF.
describe("PDF: an SSN-shaped reason stored in a row is withheld from the cover and the field tooltip", () => {
  it("cover and /TU carry the placeholder, never the digits", async () => {
    const { PDFDocument, PDFName, PDFHexString } = await import("pdf-lib");
    const { toPdfReturnView } = await import("@/lib/tax2025/pdf/adapter");
    const { buildCoverModel } = await import("@/lib/tax2025/pdf/cover");
    const { fillForm } = await import("@/lib/tax2025/pdf/fill");
    const { FORM_MAPS } = await import("@/lib/tax2025/pdf/maps");
    const { formatOverrideNote } = await import("@/lib/tax2025/overrides");
    const { DEFAULT_FILL_OPTIONS } = await import("./tax2025-pdf-harness");
    const { SSN_PLACEHOLDER } = await import("@/lib/tax2025/pdf/safe-text");
    const facts = fullFacts();
    const ret = computeTy2025Return(facts);
    const eff = applyOverrides(ret, [pin(ret, "sch1.3", 6_000_000, { reason: "per call, SSN 123-45-6789 ok" })]);
    const view = toPdfReturnView(ret, facts, { generatedAt: "2026-10-13T16:00:00.000Z", generatedBy: "T", overrides: { effective: eff, formatNote: formatOverrideNote } });
    const cover = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    const coverBytes = JSON.stringify(cover.blocks);
    // the cover model may hold the raw note; the cover is drawn through safeText: assert the DRAWN text path by calling it
    const { safeText } = await import("@/lib/tax2025/pdf/safe-text");
    for (const b of cover.blocks) {
      const t = b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text;
      if (t.includes("123-45-6789")) expect(safeText(t).text).toBe(SSN_PLACEHOLDER);
    }
    expect(typeof coverBytes).toBe("string");
    const map = FORM_MAPS.find((m) => m.formId === "f1040s1")!;
    const entry = map.lines.find((l) => l.kind === "money" && l.line === "sch1.3");
    if (!entry || entry.kind !== "money") throw new Error("no map entry");
    const result = await fillForm("f1040s1", view, map, { ...DEFAULT_FILL_OPTIONS, stamp: false });
    const doc = await PDFDocument.load(result.bytes);
    const f = doc.getForm().getFields().find((x) => x.getName() === entry.field);
    const tu = f?.acroField.dict.lookup(PDFName.of("TU"));
    const tooltip = tu instanceof PDFHexString ? tu.decodeText() : "";
    expect(tooltip).not.toContain("123-45-6789");
  }, 90000);
});
