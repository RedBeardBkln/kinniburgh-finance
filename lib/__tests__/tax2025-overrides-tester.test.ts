import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyOverrides,
  formatDollars,
  formatOverrideDate,
  formatOverrideNote,
  selectActiveOverrides,
  type ComputedSnapshot,
  type OverrideRow,
} from "@/lib/tax2025/overrides";
import { downstreamOf, LINE_FLOW } from "@/lib/tax2025/line-flow";
import type {
  Headline,
  HeadlineAmount,
  LineKey,
  OpenItem,
  ReturnLine,
  RuleResult,
  RuleStatus,
  Ty2025Return,
} from "@/lib/tax2025/types";

// Independent (Tester) checks for T7. Fixtures are written from scratch, not copied
// from tax2025-overrides.test.ts. LINE_FLOW edges below were each read from the 2025
// IRS form text (irs.gov/pub/irs-prior/<form>--2025.pdf, pdftotext) on 2026-10-03.

function line(key: LineKey, amount: number | null, status: RuleStatus = "computed"): ReturnLine {
  const [prefix = "", id = ""] = key.split(".");
  return { key, form: `Form ${prefix}`, formLine: id, label: `L ${key}`, status, amount, exact: null, reason: null, ruleId: "r", citations: [], refs: [] };
}
const HA = (): HeadlineAmount => ({ status: "computed", amount: 0, reason: null });
function headline(blocking: number, complete = false): Headline {
  return {
    complete,
    federal: { agi: HA(), taxableIncome: HA(), totalTax: HA(), totalPayments: HA(), balance: HA() },
    connecticut: { ctAgi: HA(), tax: HA(), totalPayments: HA(), balance: HA() },
    blockingItemCount: blocking,
    unverifiedDocumentCount: 0,
    derivedInputCount: 0,
    undecidedDecisionCount: 0,
    caveats: [],
    provisional: null,
  };
}
function rule(ruleId: string, status: RuleStatus, keys: LineKey[]): RuleResult {
  return {
    ruleId,
    form: "F",
    status,
    lines: keys.map((k) => ({ key: k, label: k, formLine: k, amount: new Decimal(7) })),
    reasons: [],
    citations: [],
    inputsUsed: [],
    inputsMissing: [],
  };
}
function item(id: string, severity: OpenItem["severity"], lineKeys: LineKey[] = []): OpenItem {
  return { id, severity, message: `m ${id}`, action: "a", lineKeys, refs: [] };
}
function base(over: Partial<Ty2025Return> = {}): Ty2025Return {
  return {
    engineVersion: "test-v1",
    scheduleC: null,
    scheduleD: null,
    formsRequired: {},
    attestations: {
      digitalAssets: { value: false, status: "answered", where: "w", refs: [] },
      foreignAccounts: { value: false, status: "answered", where: "w", refs: [] },
    },
    taxYear: 2025,
    filingStatus: "mfj",
    lines: {
      "sch1.3": line("sch1.3", 5000),
      "sch1.13": line("sch1.13", null, "missing_input"),
      "scha.17": line("scha.17", null, "needs_cpa_judgment"),
      "f1040.9": line("f1040.9", 9000),
      "se.12": line("se.12", 700),
      "sch1.15": line("sch1.15", 350),
    },
    results: [rule("hsa", "missing_input", ["sch1.13"]), rule("schedule-a", "needs_cpa_judgment", ["scha.17"]), rule("tax", "computed", ["f1040.9"])],
    conflicts: [],
    openItems: [item("hsa:missing", "blocking", ["sch1.13"]), item("sa:j", "blocking", ["scha.17"]), item("other", "blocking", [])],
    decisions: [
      { id: "X1", label: "Home office", chosen: "simplified", status: "default_undecided" },
      { id: "X3", label: "QBI", chosen: "8995", status: "default_undecided" },
    ],
    headline: headline(3),
    citations: [],
    ...over,
  };
}
let seq = 0;
function row(over: Partial<OverrideRow> & Pick<OverrideRow, "targetKind" | "targetKey">): OverrideRow {
  seq += 1;
  const isLine = over.targetKind === "line";
  const isDec = over.targetKind === "decision";
  return {
    id: `00000000-0000-4000-8000-${String(900 + seq).padStart(12, "0")}`,
    taxYear: 2025,
    version: 1,
    valueKind: isLine ? "money_cents" : isDec ? "choice" : "ack",
    valueCents: isLine ? 600_000 : null,
    valueText: isDec ? "actual" : null,
    computedSnapshot: { status: "computed", cents: 500_000 } satisfies ComputedSnapshot,
    authority: "cpa",
    reason: "per CPA",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-12T16:00:00Z"),
    archivedAt: null,
    ...over,
  };
}
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe("LINE_FLOW against the printed 2025 IRS form text (independent oracle)", () => {
  // [from, to, where the form says so]
  const edges: [LineKey, LineKey, string][] = [
    ["se.12", "sch2.4", "Sch SE line 12: 'Enter here and on Schedule 2 (Form 1040), line 4'"],
    ["se.12", "se.13", "Sch SE line 13: 'Multiply line 12 by 50%'"],
    ["se.13", "sch1.15", "Sch SE line 13: 'Enter here and on Schedule 1 (Form 1040), line 15'"],
    ["se.3", "se.4a", "Sch SE 4a: 'multiply line 3 by 92.35%'"],
    ["se.4a", "se.4c", "Sch SE 4c = 4a + 4b"],
    ["se.4c", "se.6", "Sch SE 6: 'Add lines 4c and 5b'"],
    ["se.6", "se.10", "Sch SE 10: 'smaller of line 6 or line 9'"],
    ["se.6", "se.11", "Sch SE 11: 'Multiply line 6 by 2.9%'"],
    ["se.10", "se.12", "Sch SE 12: 'Add lines 10 and 11'"],
    ["se.11", "se.12", "Sch SE 12: 'Add lines 10 and 11'"],
    ["schc.31", "sch1.3", "Sch C 31: 'enter on both Schedule 1 (Form 1040), line 3, and on Schedule SE, line 2'"],
    ["schc.31", "se.3", "Sch C 31 -> Sch SE line 2 -> line 3 (combine 1a, 1b, 2)"],
    ["schc.29", "schc.31", "Sch C 31: 'Subtract line 30 from line 29'"],
    ["schc.30", "schc.31", "Sch C 31: 'Subtract line 30 from line 29'"],
    ["schc.7", "schc.29", "Sch C 29: 'Subtract line 28 from line 7'"],
    ["schc.28", "schc.29", "Sch C 29: 'Subtract line 28 from line 7'"],
    ["schc.18", "schc.28", "Sch C 28: 'Add lines 8 through 27b'"],
    ["sch1.3", "sch1.10", "Sch 1 10: 'Combine lines 1 through 7 and 9'"],
    ["sch1.10", "f1040.8", "Sch 1 10: 'Enter here and on Form 1040 ... line 8'"],
    ["sch1.26", "f1040.10", "Sch 1 26: 'Enter here and on Form 1040 ... line 10'"],
    ["sch1.15", "sch1.26", "Sch 1 26: 'Add lines 11 through 23 and 25'"],
    ["sch1.13", "sch1.26", "Sch 1 26: 'Add lines 11 through 23 and 25'"],
    ["sch2.4", "sch2.21", "Sch 2 21: 'Add lines 4, 7 through 16, 18, and 19'"],
    ["sch2.11", "sch2.21", "Sch 2 21: 'Add lines 4, 7 through 16, 18, and 19'"],
    ["sch2.12", "sch2.21", "Sch 2 21: 'Add lines 4, 7 through 16, 18, and 19'"],
    ["sch2.21", "f1040.23", "Sch 2 21: 'Enter here and on Form 1040 ... line 23'"],
    ["sch2.3", "f1040.17", "Sch 2 3: 'Enter here and on Form 1040 ... line 17'"],
    ["scha.17", "f1040.12e", "Sch A 17: 'Enter ... on Form 1040 or 1040-SR, line 12e'"],
    ["scha.11", "scha.14", "Sch A 14: 'Add lines 11 through 13'"],
    ["f1040.9", "f1040.11a", "1040 11a: 'Subtract line 10 from line 9'"],
    ["f1040.10", "f1040.11a", "1040 11a: 'Subtract line 10 from line 9'"],
    ["f1040.12e", "f1040.14", "1040 14: 'Add lines 12e, 13a, and 13b'"],
    ["f1040.13a", "f1040.14", "1040 14: 'Add lines 12e, 13a, and 13b'"],
    ["f1040.14", "f1040.15", "1040 15: 'Subtract line 14 from line 11b'"],
    ["f1040.16", "f1040.18", "1040 18: 'Add lines 16 and 17'"],
    ["f1040.17", "f1040.18", "1040 18: 'Add lines 16 and 17'"],
    ["f1040.19", "f1040.21", "1040 21: 'Add lines 19 and 20'"],
    ["f1040.20", "f1040.21", "1040 21: 'Add lines 19 and 20'"],
    ["f1040.21", "f1040.22", "1040 22: 'Subtract line 21 from line 18'"],
    ["f1040.22", "f1040.24", "1040 24: 'Add lines 22 and 23'"],
    ["f1040.23", "f1040.24", "1040 24: 'Add lines 22 and 23'"],
    ["f1040.25d", "f1040.33", "1040 33: 'Add lines 25d, 26, and 32'"],
    ["f1040.26", "f1040.33", "1040 33: 'Add lines 25d, 26, and 32'"],
    ["sch3.8", "f1040.20", "Sch 3 8: 'Enter here and on Form 1040 ... line 20'"],
    ["sch3.15", "f1040.31", "Sch 3 15: 'Enter here and on Form 1040 ... line 31'"],
    ["f8995.15", "f1040.13a", "8995 15 -> Form 1040 line 13a"],
    ["f8995.4", "f8995.5", "8995 5: 'Multiply line 4 by 20%'"],
    ["f8995.5", "f8995.10", "8995 10: 'Add lines 5 and 9'"],
    ["f8995.14", "f8995.15", "8995 15: 'smaller of line 10 or line 14'"],
    ["f8959.18", "sch2.11", "8959 18: 'include this amount on Schedule 2 ... line 11'"],
    ["f8959.7", "f8959.18", "8959 18: 'Add lines 7, 13, and 17'"],
    ["f8959.13", "f8959.18", "8959 18: 'Add lines 7, 13, and 17'"],
    ["se.6", "f8959.8", "8959 8: 'Self-employment income from Schedule SE (Part I), line 6'"],
    ["f8959.8", "f8959.12", "8959 12: 'Subtract line 11 from line 8'"],
    ["f8959.12", "f8959.13", "8959 13: 'Multiply line 12 by 0.9% (0.009)'"],
    ["f8959.24", "f1040.25c", "8959 24 -> Form 1040 line 25c"],
  ];

  it.each(edges)("%s -> %s  (%s)", (from, to) => {
    expect(LINE_FLOW[from], `${from} has no outgoing edges`).toBeDefined();
    expect(LINE_FLOW[from]).toContain(to);
  });

  it("the SE example from the plan resolves through the printed form: se.12 reaches Sch 2 line 4 AND Sch 1 line 15", () => {
    const d = downstreamOf("se.12");
    expect(d).toEqual(expect.arrayContaining(["sch2.4", "sch2.21", "f1040.23", "f1040.24", "se.13", "sch1.15", "sch1.26", "f1040.10", "f1040.11a"]));
  });

  it("closure follows real chains: Sch A 17 -> 1040 12e -> 14 -> 15; 8995 15 -> 13a -> 14; Sch C 31 -> Sch 1 / SE / 8995", () => {
    expect(downstreamOf("scha.17")).toEqual(expect.arrayContaining(["f1040.12e", "f1040.14", "f1040.15", "f1040.16", "f1040.24", "f1040.37"]));
    expect(downstreamOf("f8995.15")).toEqual(expect.arrayContaining(["f1040.13a", "f1040.14", "f1040.15"]));
    expect(downstreamOf("schc.31")).toEqual(expect.arrayContaining(["sch1.3", "se.3", "f8995.4", "se.12", "sch2.4", "f1040.8", "f1040.9"]));
  });

  it("never flags upstream lines (no edge points back at a line's own inputs)", () => {
    expect(downstreamOf("f1040.16")).not.toContain("f1040.15");
    expect(downstreamOf("sch1.3")).not.toContain("schc.31");
    expect(downstreamOf("se.13")).not.toContain("se.12");
    expect(downstreamOf("f1040.9")).not.toContain("sch1.3");
  });
});

describe("applyOverrides: whole-surface purity and determinism", () => {
  const mixedRows = (): OverrideRow[] => [
    row({ targetKind: "line", targetKey: "sch1.3", computedSnapshot: { status: "computed", cents: 123 } }), // stale
    row({ targetKind: "line", targetKey: "sch1.13", computedSnapshot: { status: "missing_input", cents: null } }),
    row({ targetKind: "line", targetKey: "se.12", version: 1 }),
    row({ targetKind: "line", targetKey: "se.12", version: 2, valueCents: 800_000 }), // race: two actives
    row({ targetKind: "line", targetKey: "nope.1" as LineKey }), // orphan
    row({ targetKind: "decision", targetKey: "homeOfficeMethod", valueText: "actual" }),
    row({ targetKind: "rule_ack", targetKey: "schedule-a", computedSnapshot: { status: "needs_cpa_judgment", cents: null } }),
    row({ targetKind: "rule_ack", targetKey: "hsa", computedSnapshot: { status: "computed", cents: null } }), // stale ack
    row({ targetKind: "line", targetKey: "f1040.9", valueCents: 1_234_500 + 50 }), // unreadable (cents)
  ];

  it("a deep-frozen base and rows are never mutated, whatever mix of kinds is applied", () => {
    const b = deepFreeze(base());
    const rows = deepFreeze(mixedRows());
    expect(() => applyOverrides(b, rows, { engineVersion: "x" })).not.toThrow();
  });

  it("is deterministic and independent of the order the rows are supplied in", () => {
    const rows = mixedRows().filter((r) => !(r.targetKind === "line" && r.targetKey === "f1040.9")); // drop the unreadable row (its position is reported in input order)
    const a = applyOverrides(base(), rows);
    const b = applyOverrides(base(), [...rows].reverse());
    const c = applyOverrides(base(), rows);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("returns plain JSON data: no Decimal and no `results`", () => {
    const eff = applyOverrides(base(), mixedRows());
    const json = JSON.stringify(eff);
    expect(json).not.toContain('"inputsUsed"');
    expect(json).not.toContain("ruleId\":\"hsa\",\"form"); // the RuleResult shape is absent
    expect(() => structuredClone(eff)).not.toThrow();
    expect("results" in eff).toBe(false);
  });

  it("with all kinds in play every failure is surfaced, none silently dropped", () => {
    const eff = applyOverrides(base(), mixedRows());
    const ids = eff.openItems.map((i) => i.id);
    expect(ids).toContain("override-stale:line:sch1.3");
    expect(ids).toContain("override-conflict:line:se.12");
    expect(ids).toContain("override-orphan:line:nope.1");
    expect(ids.some((i) => i.startsWith("override-invalid:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("override-stale:rule_ack:hsa"))).toBe(true);
    expect(ids).toContain("override-decision-not-reflected:homeOfficeMethod"); // base decision still default_undecided
    // the stale ack un-blocked nothing, but the fresh pin on sch1.13 SUPPLIED the line the hsa item names (D2: moved to
    // the resolved list, still visible); the fresh ack moved exactly its own item
    expect(ids).not.toContain("hsa:missing");
    expect(eff.resolvedByOverride.map((r) => r.item.id)).toEqual(["hsa:missing"]);
    expect(ids).not.toContain("sa:j");
    expect(eff.acknowledged.map((a) => a.ruleId)).toEqual(["schedule-a"]);
    expect(eff.applied.lines.find((l) => l.targetKey === "se.12")?.version).toBe(2);
    expect(eff.invalid).toHaveLength(1);
  });

  it("blockingItemCount equals the blocking items actually listed when the base count was consistent", () => {
    const b = base();
    expect(b.headline.blockingItemCount).toBe(b.openItems.filter((i) => i.severity === "blocking").length);
    const eff = applyOverrides(b, mixedRows());
    expect(eff.headline.blockingItemCount).toBe(eff.openItems.filter((i) => i.severity === "blocking").length);
  });
});

describe("rule acknowledgements never change a number", () => {
  it("every effective line is identical with and without an acknowledgement", () => {
    const withAck = applyOverrides(base(), [row({ targetKind: "rule_ack", targetKey: "schedule-a", computedSnapshot: { status: "needs_cpa_judgment", cents: null } })]);
    const without = applyOverrides(base(), []);
    expect(withAck.lines).toEqual(without.lines);
    expect(withAck.headline.federal).toEqual(without.headline.federal);
    expect(withAck.totalsNotRecomputed).toBe(false);
    expect(withAck.headline.blockingItemCount).toBe(without.headline.blockingItemCount - 1);
  });
});

describe("overriding a missing_input line (D2, changed from the core branch, which kept the blocker)", () => {
  it("a line override alone supplies the line and moves the line's blocker to the resolved list; with an acknowledgement too, the ack moves it first", () => {
    const lineOnly = applyOverrides(base(), [row({ targetKind: "line", targetKey: "sch1.13", computedSnapshot: { status: "missing_input", cents: null } })]);
    expect(lineOnly.lines["sch1.13"]?.effective.status).toBe("overridden");
    expect(lineOnly.openItems.find((i) => i.id === "hsa:missing")).toBeUndefined();
    expect(lineOnly.resolvedByOverride.map((r) => r.item.id)).toEqual(["hsa:missing"]);
    expect(lineOnly.headline.blockingItemCount).toBe(2);
    expect(lineOnly.totalsNotRecomputed).toBe(true);

    const both = applyOverrides(base(), [
      row({ targetKind: "line", targetKey: "sch1.13", computedSnapshot: { status: "missing_input", cents: null } }),
      row({ targetKind: "rule_ack", targetKey: "hsa", computedSnapshot: { status: "missing_input", cents: null } }),
    ]);
    expect(both.openItems.map((i) => i.id)).not.toContain("hsa:missing");
    expect(both.acknowledged[0]?.items.map((i) => i.id)).toEqual(["hsa:missing"]);
    expect(both.headline.blockingItemCount).toBe(2);
    // the override and its note stay visible
    expect(formatOverrideNote(both.applied.lines[0]!)).toContain("was missing input");
  });
});

describe("selectActiveOverrides: append-only versions", () => {
  it("ignores archived versions; with v1 archived, v2 archived and v3 active, v3 is the active one", () => {
    const mk = (version: number, archived: boolean) =>
      row({ targetKind: "line", targetKey: "sch1.3", version, valueCents: version * 100_000, archivedAt: archived ? new Date("2026-10-13T00:00:00Z") : null });
    const sel = selectActiveOverrides([mk(1, true), mk(2, true), mk(3, false)]);
    expect(sel.active.map((a) => a.version)).toEqual([3]);
    expect(sel.anomalies).toEqual([]);
  });

  it("an unreadable newer active row plus a readable older one: the older is applied AND the unreadable is a blocker", () => {
    const good = row({ targetKind: "line", targetKey: "sch1.3", version: 1 });
    const bad = row({ targetKind: "line", targetKey: "sch1.3", version: 2, valueCents: 600_050 });
    const eff = applyOverrides(base(), [good, bad]);
    expect(eff.applied.lines[0]?.version).toBe(1);
    expect(eff.openItems.find((i) => i.id === `override-invalid:${bad.id}`)?.severity).toBe("blocking");
  });

  it("an unreadable row for an unknown authority / bad snapshot / unknown kind is blocking, never applied", () => {
    const rows = [
      row({ targetKind: "line", targetKey: "sch1.3", authority: "cpa " }),
      row({ targetKind: "line", targetKey: "se.12", computedSnapshot: "garbage" }),
      row({ targetKind: "mystery", targetKey: "x" }),
    ];
    const eff = applyOverrides(base(), rows);
    expect(eff.invalid).toHaveLength(3);
    expect(eff.applied.lines).toEqual([]);
    expect(eff.headline.blockingItemCount).toBe(6);
  });
});

describe("formatOverrideNote / date: America/New_York at DST and midnight boundaries", () => {
  it.each([
    ["2026-03-08T04:59:00.000Z", "2026-03-07"], // 23:59 EST the night before spring-forward
    ["2026-03-08T05:00:00.000Z", "2026-03-08"],
    ["2026-11-01T03:59:00.000Z", "2026-10-31"], // 23:59 EDT
    ["2026-11-01T04:00:00.000Z", "2026-11-01"], // 00:00 EDT
    ["2026-11-01T05:30:00.000Z", "2026-11-01"], // 00:30 EST (fall-back repeat hour)
    ["2026-12-31T04:59:59.000Z", "2026-12-30"],
    ["2026-12-31T05:00:00.000Z", "2026-12-31"],
  ])("%s -> %s", (iso, ymd) => {
    expect(formatOverrideDate(iso)).toBe(ymd);
  });

  it("keeps the reason verbatim (including $ and quotes) and shows who/when/was/now", () => {
    const eff = applyOverrides(base(), [row({ targetKind: "line", targetKey: "sch1.3", reason: 'CPA: "use $6,000"; see email', authority: "owner" })]);
    expect(formatOverrideNote(eff.applied.lines[0]!)).toBe(
      'Owner override: was $5,000 computed, now $6,000, by Eric Kinniburgh (owner) on 2026-10-12, reason: CPA: "use $6,000"; see email'
    );
  });

  it("the maximum override ($21,000,000) formats and applies without overflow", () => {
    const eff = applyOverrides(base(), [row({ targetKind: "line", targetKey: "sch1.3", valueCents: 2_100_000_000 })]);
    expect(eff.lines["sch1.3"]?.effective.amount).toBe(21_000_000);
    expect(formatDollars(21_000_000)).toBe("$21,000,000");
  });
});

describe("no float money in the new modules (source pin)", () => {
  it("overrides.ts, line-flow.ts, the loader and the actions use no parseFloat / toFixed / Number()", () => {
    for (const f of ["lib/tax2025/overrides.ts", "lib/tax2025/line-flow.ts", "lib/tax2025-overrides-build.ts", "actions/tax-return-overrides.ts"]) {
      const src = readFileSync(resolve(__dirname, "../../", f), "utf8");
      expect(src, f).not.toMatch(/parseFloat|toFixed\(|\bNumber\(/);
      expect(src, f).not.toMatch(/:\s*any\b|as any\b/);
    }
  });

  it("no delete/deleteMany/upsert anywhere in the new modules", () => {
    for (const f of ["lib/tax2025/overrides.ts", "lib/tax2025-overrides-build.ts", "actions/tax-return-overrides.ts"]) {
      const src = readFileSync(resolve(__dirname, "../../", f), "utf8");
      expect(src, f).not.toMatch(/\.delete\(|\.deleteMany\(|\.upsert\(/);
    }
  });
});
