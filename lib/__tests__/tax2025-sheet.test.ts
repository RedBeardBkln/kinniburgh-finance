import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { LINE_KEYS, type Ty2025Return } from "@/lib/tax2025/types";
import {
  SHEET_CHECKLIST,
  SHEET_DRAFT_LABEL,
  buildSheetModel,
  formatSheetMoney,
  openItemOwner,
  overrideNote,
  type SheetLine,
  type SheetModel,
  type SheetRawDocument,
} from "@/lib/tax2025-sheet";
import { applyOverrides, formatOverrideNote, lineSnapshot, type EffectiveReturn, type OverrideRow } from "@/lib/tax2025/overrides";
import { SHEET_CSV_COLUMNS, csvNumber, csvText, sheetCsvRow, sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { loadSheet } from "@/lib/tax2025-sheet-load";
import { ownerWordingDeep } from "@/lib/tax-wording";
import { emptyFacts, fullFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

const NOW = new Date("2026-10-03T16:30:00Z");
const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const golden = computeTy2025Return(fullFacts());
const golden1b = computeTy2025Return(fullFacts1b());
const empty = computeTy2025Return(emptyFacts());

function homeOfficeFacts() {
  const f = fullFacts();
  f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive" as const);
  f.income.scheduleC.homeOfficeSqft = owner(200);
  return f;
}

const DOCS: SheetRawDocument[] = [
  { id: "w2-eric-a", docType: "w2", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" },
  { id: "w2-eva", docType: "w2", taxYear: 2025, verified: false, legacyFormat: false, subjectType: "person" },
  { id: "unused-doc", docType: "other", taxYear: 2025, verified: true, legacyFormat: false, subjectType: null },
];

function model(ret: Ty2025Return, extra: { effective?: EffectiveReturn } = {}): SheetModel {
  return buildSheetModel({ ret, documents: DOCS, now: NOW, ...extra });
}

/** A recorded line override row, snapshotted from the return it is applied to. */
function pinRow(ret: Ty2025Return, key: (typeof LINE_KEYS)[number], valueCents: number, over: Partial<OverrideRow> = {}): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error(`no line ${key}`);
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents,
    valueText: null,
    computedSnapshot: lineSnapshot(l, ret.engineVersion),
    authority: "cpa",
    reason: "per the 1099 correction",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-05T14:00:00Z"),
    archivedAt: null,
    ...over,
  };
}

function allLines(m: SheetModel): SheetLine[] {
  return [...m.federal, ...m.connecticut].flatMap((g) => g.lines);
}

/** Every leaf must be a JSON primitive; no Decimal, Date, undefined, function or non-finite number anywhere. */
function assertPlainJson(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    expect(Number.isFinite(value), path).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertPlainJson(v, `${path}[${i}]`));
    return;
  }
  expect(typeof value, path).toBe("object");
  const proto = Object.getPrototypeOf(value) as unknown;
  expect(proto === Object.prototype, `${path} is a plain object`).toBe(true);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    expect(v, `${path}.${k} is not undefined`).not.toBeUndefined();
    assertPlainJson(v, `${path}.${k}`);
  }
}

/** Minimal RFC 4180 parser for the CSV round-trip checks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe("sheet model: lines", () => {
  for (const [name, ret] of [["golden", golden], ["golden 1b", golden1b], ["all-missing", empty]] as const) {
    it(`${name}: every emitted line appears exactly once, in catalog order`, () => {
      const m = model(ret);
      const keys = allLines(m).map((l) => l.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort()).toEqual(Object.keys(ret.lines).sort());
      const order = LINE_KEYS.filter((k) => ret.lines[k] !== undefined);
      expect(keys).toEqual(order);
    });

    it(`${name}: a line without an amount is never rendered as a number (and never 0 in the CSV)`, () => {
      const m = model(ret);
      const csv = parseCsv(sheetToCsv(m));
      const byKey = new Map(csv.slice(2).map((r) => [r[2], r]));
      for (const l of allLines(m)) {
        const hasAmt = l.status === "computed" || l.status === "not_applicable";
        if (hasAmt) {
          expect(l.amount, l.key).not.toBeNull();
          expect(l.amountText, l.key).toBe(formatSheetMoney(l.amount as number));
        } else {
          expect(l.amount, l.key).toBeNull();
          expect(l.amountText, l.key).toBe("not computed");
          expect(l.amountText, l.key).not.toMatch(/\d/);
          expect(byKey.get(l.key)?.[4], `${l.key} csv amount`).toBe("");
        }
      }
    });

    it(`${name}: the model is plain JSON (no Decimal, Date or undefined)`, () => {
      const m = model(ret);
      assertPlainJson(m, "model");
      expect(JSON.parse(JSON.stringify(m))).toStrictEqual(m);
    });
  }

  it("all-missing facts: most lines are not computed and the counts add up", () => {
    const m = model(empty);
    const lines = allLines(m);
    const counts = m.summary.statusCounts;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(lines.length);
    expect(counts.missing_input + counts.not_yet_computed).toBeGreaterThan(0);
    expect(lines.some((l) => l.amount === null && l.amountText === "not computed")).toBe(true);
  });

  it("splits Connecticut from federal and groups by form with the packet verdict", () => {
    const m = model(golden1b);
    expect(m.connecticut.every((g) => g.form === "CT-1040")).toBe(true);
    expect(m.federal.some((g) => g.form === "CT-1040")).toBe(false);
    const forms = m.federal.map((g) => g.form);
    for (const f of ["Form 1040", "Schedule 1", "Schedule 2", "Schedule 3", "Schedule A", "Schedule B", "Schedule C", "Schedule SE", "Form 8995", "Form 8959"]) {
      expect(forms).toContain(f);
    }
    expect(forms.indexOf("Form 1040")).toBeLessThan(forms.indexOf("Schedule 1"));
    const g1040 = m.federal.find((g) => g.form === "Form 1040");
    expect(g1040?.requirement?.required).toBe(true);
  });
});

describe("sheet model: summary (P1)", () => {
  it("carries the DRAFT label, counts, engine version and an America/New_York timestamp", () => {
    const m = model(empty);
    expect(m.draftLabel).toBe("DRAFT - not a filed return - computed from the inputs shown; the owner is the preparer of record");
    expect(SHEET_DRAFT_LABEL).toBe(m.draftLabel);
    expect(m.engineVersion).toBe(empty.engineVersion);
    expect(m.generatedAt).toBe("2026-10-03T16:30:00.000Z");
    expect(m.generatedAtDisplay).toBe("2026-10-03 12:30 EDT");
    expect(m.summary.blockingItemCount).toBe(empty.headline.blockingItemCount);
    expect(m.summary.undecidedDecisionCount).toBe(empty.headline.undecidedDecisionCount);
    expect(m.summary.unverifiedDocumentCount).toBe(empty.headline.unverifiedDocumentCount);
    expect(m.summary.derivedInputCount).toBe(empty.headline.derivedInputCount);
    // Engine prose is reworded once, at the sheet boundary (lib/tax-wording.ts); the caveats are otherwise the engine's.
    expect(m.summary.caveats).toEqual(ownerWordingDeep(empty.headline.caveats));
  });

  it("an incomplete return says INCOMPLETE, never presents provisional figures as computed", () => {
    const m = model(empty);
    expect(m.summary.complete).toBe(false);
    expect(m.summary.completenessText).toMatch(/^INCOMPLETE: \d+ blocking item\(s\)/);
    for (const r of [...m.summary.federal, ...m.summary.connecticut]) {
      if (r.status !== "computed" && r.status !== "not_applicable") expect(r.computedText, r.label).toBe("not computed");
    }
    expect(m.summary.provisionalNote).toMatch(/NOT a computed return/);
    expect(m.summary.federal.some((r) => r.provisionalText !== null)).toBe(true);
  });

  it("a complete return shows no provisional column values", () => {
    const m = model(golden1b);
    if (golden1b.headline.complete) {
      expect(m.summary.completenessText).toMatch(/^No blocking items/);
      for (const r of [...m.summary.federal, ...m.summary.connecticut]) expect(r.provisionalText).toBeNull();
    } else {
      expect(m.summary.completenessText).toMatch(/^INCOMPLETE/);
    }
  });

  it("formats balances as owed / refund", () => {
    const m = model(golden1b);
    const bal = m.summary.federal.find((r) => r.label === "Federal balance");
    expect(bal).toBeDefined();
    if (bal && bal.status === "computed") expect(bal.computedText).toMatch(/^(owed|refund) \$|^\$0/);
  });
});

describe("sheet model: open items, conflicts and homework (P5)", () => {
  it("lists blocking items before advisory ones and keeps the engine's line keys", () => {
    for (const ret of [empty, golden, golden1b]) {
      const m = model(ret);
      const sev = m.openItems.map((i) => i.severity);
      const firstAdvisory = sev.indexOf("advisory");
      if (firstAdvisory !== -1) expect(sev.slice(firstAdvisory).every((s) => s === "advisory")).toBe(true);
      expect(sev.filter((s) => s === "blocking").length).toBe(ret.openItems.filter((o) => o.severity === "blocking").length);
      expect(new Set(m.openItems.map((i) => i.id)).size).toBe(m.openItems.length);
    }
    const m = model(empty);
    expect(m.openItems[0]?.severity).toBe("blocking");
    const withLines = m.openItems.find((i) => i.lines.length > 0);
    expect(withLines?.lines[0]?.text).toMatch(/\S+ \S+/);
  });

  it("derives the owner homework from the open items (owner actions only, never decisions)", () => {
    const m = model(empty);
    expect(m.homework.length).toBeGreaterThan(0);
    const owners = new Set(m.openItems.filter((i) => i.who === "owner").map((i) => i.id));
    expect(m.homework.map((h) => h.id).sort()).toEqual([...owners].sort());
    expect(m.homework.some((h) => h.id.startsWith("decision:"))).toBe(false);
    expect(m.homework.some((h) => h.id.startsWith("none:"))).toBe(true);
    // blocking homework comes first
    const sev = m.homework.map((h) => h.severity);
    const firstAdvisory = sev.indexOf("advisory");
    if (firstAdvisory !== -1) expect(sev.slice(firstAdvisory).every((s) => s === "advisory")).toBe(true);
  });

  it("classifies who acts on an item", () => {
    expect(openItemOwner({ id: "doc-unverified:x", action: "Open the document and mark it verified." })).toBe("owner");
    expect(openItemOwner({ id: "decision:X1", action: "The CPA records the decision; the alternatives are shown side by side." })).toBe("cpa");
    expect(openItemOwner({ id: "rule:schedule-a", action: "Provide: the amounts." })).toBe("owner");
    expect(openItemOwner({ id: "rule:qbi-8995", action: "The CPA decides or supplies the rule." })).toBe("cpa");
    expect(openItemOwner({ id: "interest-box3", action: "Tell the CPA so the CT subtraction is taken." })).toBe("cpa");
    expect(openItemOwner({ id: "attest:digital", action: "Answer it in the Return completeness questionnaire." })).toBe("owner");
    expect(openItemOwner({ id: "attest:foreign", action: "The CPA decides the answer." })).toBe("cpa");
  });

  it("shows conflicts with every candidate source", () => {
    const withConflict: Ty2025Return = {
      ...golden,
      conflicts: [
        {
          factKey: "retirement",
          chosen: "W-2 box 12",
          reason: "Owner answer and W-2 differ.",
          candidates: [
            { basis: "answer_owner", label: "Owner answer", value: 5000, refs: [] },
            { basis: "doc_unverified", label: "W-2 box 12", value: "7,000", refs: [] },
            { basis: "books", label: "Books", value: null, refs: [] },
          ],
        },
      ],
    };
    const m = model(withConflict);
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]?.candidates.map((c) => c.valueText)).toEqual(["5000", "7,000", "none"]);
    expect(m.conflicts[0]?.candidates[1]?.basisLabel).toBe("UNVERIFIED document read");
  });
});

describe("sheet model: decisions (P4)", () => {
  it("shows both alternatives with the conservative one marked 'default, undecided'", () => {
    const ret = computeTy2025Return(homeOfficeFacts());
    const m = model(ret);
    const x1 = m.decisions.find((d) => d.id === "X1");
    expect(x1).toBeDefined();
    expect(x1?.undecided).toBe(true);
    expect(x1?.statusText).toBe("default, undecided");
    expect(x1?.alternatives.map((a) => a.id).sort()).toEqual(["actual", "simplified"]);
    const simplified = x1?.alternatives.find((a) => a.id === "simplified");
    expect(simplified?.isDefault).toBe(true);
    expect(simplified?.marker).toBe("default, undecided");
    expect(x1?.alternatives.find((a) => a.id === "actual")?.marker).toBeNull();
    expect(x1?.wholeReturnEffect).toMatch(/In force:/);
    expect(x1?.wholeReturnEffect).toMatch(/Alternatives:/);
    expect(x1?.affectedLines.length).toBeGreaterThan(0);
    expect(m.summary.undecidedDecisionCount).toBeGreaterThan(0);
  });

  it("marks the lines carried by an undecided default and a recorded decision removes the marker", () => {
    const f = homeOfficeFacts();
    const undecided = model(computeTy2025Return(f));
    const line30 = allLines(undecided).find((l) => l.key === "schc.30");
    expect(line30?.defaultUndecided).toMatch(/Home office/);
    expect(line30?.chips.some((c) => c.label.startsWith("default, undecided"))).toBe(true);

    const decided = model(computeTy2025Return(f, { homeOfficeMethod: { chosen: "actual", by: "Eric Kinniburgh", at: "2026-10-05T12:00:00Z" } }));
    const x1 = decided.decisions.find((d) => d.id === "X1");
    expect(x1?.undecided).toBe(false);
    expect(x1?.statusText).toBe("decided");
    expect(x1?.decidedBy).toBe("Eric Kinniburgh");
    expect(x1?.alternatives.find((a) => a.id === "actual")?.marker).toBe("chosen");
    expect(x1?.alternatives.find((a) => a.id === "simplified")?.marker).toBe("default");
    expect(allLines(decided).find((l) => l.key === "schc.30")?.defaultUndecided).toBeNull();
  });

  it("lists decisions the engine did not raise instead of hiding them", () => {
    const m = model(golden);
    const ids = m.decisionPlaceholders.map((p) => p.id);
    expect(ids).toContain("X2");
    for (const p of m.decisionPlaceholders) expect(p.note.length).toBeGreaterThan(10);
    const raised = new Set(m.decisions.map((d) => d.id));
    for (const p of m.decisionPlaceholders) expect(raised.has(p.id)).toBe(false);
  });
});

describe("sheet model: provenance, documents and overrides", () => {
  it("renders document chips as verified or UNVERIFIED from the loader's document list, with a review link", () => {
    const m = model(golden);
    const l1a = allLines(m).find((l) => l.key === "f1040.1a");
    expect(l1a).toBeDefined();
    const eric = l1a?.chips.find((c) => c.href === "/documents/w2-eric-a/review");
    const eva = l1a?.chips.find((c) => c.href === "/documents/w2-eva/review");
    expect(eric?.kind).toBe("document_verified");
    expect(eva?.kind).toBe("document_unverified");
  });

  it("adds a derived chip to lines built from other lines and rule-only lines", () => {
    const m = model(golden);
    const l = allLines(m).find((x) => x.key === "f1040.11a");
    expect(l?.chips.some((c) => c.kind === "derived")).toBe(true);
  });

  it("indexes documents with the lines they fed, unverified first", () => {
    const m = model(golden);
    const eric = m.documents.find((d) => d.id === "w2-eric-a");
    expect(eric?.fedLines.length).toBeGreaterThan(0);
    expect(eric?.statusText).toBe("verified");
    expect(m.documents.find((d) => d.id === "unused-doc")?.fedLines).toEqual([]);
    expect(m.documents[0]?.verified).toBe(false);
    // a document referenced by a line but absent from the loader list is still indexed
    const ghost = computeTy2025Return(fullFacts());
    const m2 = buildSheetModel({ ret: ghost, documents: [], now: NOW });
    expect(m2.documents.some((d) => d.id === "w2-eric-a" && d.statusText === "not in the loader's document list")).toBe(true);
  });

  it("renders a recorded override per line (the effective value, the ONE note wording, the computed value it replaced) and counts it", () => {
    const was = golden.lines["f1040.1a"]?.amount;
    expect(was).not.toBeNull();
    const eff = applyOverrides(golden, [pinRow(golden, "f1040.1a", 15_000)]);
    const m = model(golden, { effective: eff });
    const l = allLines(m).find((x) => x.key === "f1040.1a");
    expect(l?.status).toBe("overridden");
    expect(l?.statusLabel).toBe("Advisor override");
    expect(l?.amount).toBe(150);
    expect(l?.amountText).toBe("$150");
    expect(l?.override).toMatchObject({
      nowAmount: 150,
      computedAmount: was,
      authorityLabel: "Advisor (recorded earlier)",
      by: "Eric Kinniburgh",
      atDate: "2026-10-05",
      reason: "per the 1099 correction",
      supplied: false,
      stale: false,
    });
    expect(l?.override?.note).toBe(formatOverrideNote(eff.applied.lines[0]!));
    expect(overrideNote(l!.override!)).toBe(l!.override!.note);
    expect(l?.computed.amount).toBe(was);
    expect(m.overrideCount).toBe(1);
    expect(m.summary.overrides.lineCount).toBe(1);
    expect(m.summary.overrides.totalsNotRecomputed).toBe(true);
    expect(m.summary.completenessText).toContain("Totals are NOT recomputed");
    expect(m.summary.statusCounts.overridden).toBe(1);
    // dependents are flagged (and the headline AGI row says so), the overridden line itself is not
    expect(allLines(m).find((x) => x.key === "f1040.9")?.dependsOnOverridden).toContainEqual({ key: "f1040.1a", text: "Form 1040 1a" });
    expect(l?.dependsOnOverridden).toEqual([]);
    expect(m.summary.federal[0]?.dependsOnOverride).toBe(true);
    // no overrides in the build: every line is mirrored, offers no dialog, and the panel model is empty
    const plain = model(golden);
    expect(allLines(plain).every((x) => x.override === null && !x.canOverride && x.dependsOnOverridden.length === 0)).toBe(true);
    expect(plain.summary.overrides.lineCount).toBe(0);
    // with an effective view but no rows the lines can be overridden and nothing is marked
    const none = model(golden, { effective: applyOverrides(golden, []) });
    expect(allLines(none).every((x) => x.override === null && x.canOverride)).toBe(true);
    // CSV: the effective amount, the status cell and the override columns are filled only for that line
    const rows = parseCsv(sheetToCsv(m));
    const row = rows.find((r) => r[2] === "f1040.1a");
    expect(row?.[4]).toBe("150"); // amount = the effective amount
    expect(row?.[5]).toBe("Advisor override");
    expect(row?.[8]).toBe("150"); // override_amount
    expect(row?.[9]).toBe("Eric Kinniburgh");
    expect(row?.[10]).toBe("2026-10-05"); // override_at, YYYY-MM-DD in America/New_York
    expect(row?.[11]).toBe("per the 1099 correction");
    expect(row?.[12]).toBe(String(was)); // computed_amount
    expect(row?.[13]).toBe("Advisor (recorded earlier)");
    expect(row?.[14]).toBe("1");
    expect(row?.[15]).toBe("no");
    expect(row?.[16]).toBe(l!.override!.note);
    expect(rows.slice(2, -1).filter((r) => r[2] !== "f1040.1a" && r[8] !== "").length).toBe(0);
    const dependent = rows.find((r) => r[2] === "f1040.9");
    expect(dependent?.[17]).toContain("Form 1040 1a");
    expect(rows[rows.length - 1]![7]).toContain("1 override(s) in force");
  });

  it("a pin on a BLOCKED line prints its value with the override provenance; the engine's reason moves to `computed`", () => {
    const blocked = computeTy2025Return(emptyFacts());
    expect(blocked.lines["sch3.1"]?.amount).toBeNull();
    const eff = applyOverrides(blocked, [pinRow(blocked, "sch3.1", 250_000)]);
    const m = model(blocked, { effective: eff });
    const l = allLines(m).find((x) => x.key === "sch3.1");
    expect(l).toMatchObject({ status: "overridden", amount: 2500, amountText: "$2,500", reason: null });
    expect(l?.override?.supplied).toBe(true);
    expect(l?.computed.blocked).toBe(true);
    expect(l?.chips).toEqual([{ kind: "override", label: "Advisor override by Eric Kinniburgh on 2026-10-05", href: null }]);
    expect(m.summary.overrides.resolvedByOverride.map((r) => r.id)).toEqual(["rule:foreign-tax-credit"]);
    expect(m.openItems.some((i) => i.id === "rule:foreign-tax-credit")).toBe(false);
    expect(m.summary.blockingItemCount).toBe(blocked.headline.blockingItemCount - 1);
  });

  it("carries the static sign-off checklist", () => {
    const m = model(golden);
    expect(m.checklist).toEqual([...SHEET_CHECKLIST]);
    const joined = m.checklist.join("\n");
    expect(joined).toMatch(/decision/i);
    expect(joined).toMatch(/open item/i);
    expect(joined).toMatch(/Social Security numbers/);
    expect(joined).toMatch(/carryforward/i);
    expect(joined).toMatch(/estimated-payment dates/i);
    expect(joined).toMatch(/e-file authorization form/);
  });

  it("resolves citation ids to their source urls", () => {
    const m = model(golden1b);
    expect(m.citations.length).toBeGreaterThan(0);
    for (const c of m.citations) {
      expect(c.url, c.id).toMatch(/^https:\/\/(www\.irs\.gov|portal\.ct\.gov)\//);
      expect(c.verifiedOn, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("CSV export", () => {
  it("has the reserved columns, one row per line and a closing DRAFT notice", () => {
    const m = model(golden1b);
    const rows = parseCsv(sheetToCsv(m));
    expect(rows[0]![0]).toBe(SHEET_DRAFT_LABEL);
    expect(rows[0]!.slice(1).every((c) => c === "")).toBe(true);
    expect(rows[1]).toEqual([...SHEET_CSV_COLUMNS]);
    expect(SHEET_CSV_COLUMNS).toEqual([
      "form",
      "line_id",
      "line_key",
      "label",
      "amount",
      "status",
      "provenance",
      "citation_reason",
      "override_amount",
      "override_by",
      "override_at",
      "override_reason",
      "computed_amount",
      "override_authority",
      "override_version",
      "override_stale",
      "override_note",
      "depends_on_override",
    ]);
    expect(rows.length).toBe(allLines(m).length + 3);
    for (const r of rows) expect(r.length).toBe(SHEET_CSV_COLUMNS.length);
    const last = rows[rows.length - 1]!;
    expect(last[0]).toBe("DRAFT NOTICE");
    expect(last[7]).toContain("the owner is the preparer of record");
    expect(last[7]).not.toContain("override(s) in force");
    // override columns are empty when no override exists
    for (const r of rows.slice(2)) expect(r.slice(8)).toEqual(["", "", "", "", "", "", "", "", "", ""]);
  });

  it("uses CRLF line endings and ends with a newline", () => {
    const csv = sheetToCsv(model(golden));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n").length).toBeGreaterThan(10);
  });

  it("quotes commas, quotes and newlines (RFC 4180)", () => {
    expect(csvText("a,b")).toBe('"a,b"');
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    expect(csvText("line1\nline2")).toBe('"line1\nline2"');
    expect(csvText("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvText("plain text")).toBe("plain text");
    expect(csvText("")).toBe("");
  });

  it("guards formula injection: text cells starting with = + - @ (or tab / CR) get a leading quote", () => {
    expect(csvText("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvText("+1")).toBe("'+1");
    expect(csvText("-1+1")).toBe("'-1+1");
    expect(csvText("@cmd")).toBe("'@cmd");
    expect(csvText("\tcmd")).toBe("'\tcmd");
    expect(csvText("\rcmd")).toBe(`"'\rcmd"`);
    // guard and quoting compose
    expect(csvText('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    // only the first character matters
    expect(csvText("a=b")).toBe("a=b");
  });

  it("writes amounts from numbers without the guard (negative amounts stay numeric) and leaves null empty", () => {
    expect(csvNumber(-5)).toBe("-5");
    expect(csvNumber(1234)).toBe("1234");
    expect(csvNumber(0)).toBe("0");
    expect(csvNumber(null)).toBe("");
    expect(csvNumber(1.5)).toBe("");
    const line: SheetLine = {
      key: "f1040.1a",
      form: "Form 1040",
      formLine: "1a",
      label: "=evil, \"label\"",
      status: "computed",
      statusLabel: "computed",
      amount: -42,
      amountText: "-$42",
      reason: "line1\nline2, with comma",
      citations: [{ id: "SE_FLOOR", url: "https://www.irs.gov/x", verifiedOn: "2026-10-03", note: null }],
      chips: [{ kind: "owner_answer", label: "+answer", href: null }],
      defaultUndecided: null,
      override: null,
      computed: { amount: -42, amountText: "-$42", statusLabel: "computed", reason: null, blocked: false },
      affects: [],
      affectsMore: 0,
      dependsOnOverridden: [],
      canOverride: false,
    };
    const parsed = parseCsv(`${sheetCsvRow(line)}\r\n`)[0]!;
    expect(parsed[3]).toBe("'=evil, \"label\"");
    expect(parsed[4]).toBe("-42");
    expect(parsed[6]).toBe("owner answer: +answer");
    expect(parsed[7]).toBe("line1\nline2, with comma | Sources: SE_FLOOR https://www.irs.gov/x");
  });

  it("round-trips every row of the all-missing sheet through a CSV parser", () => {
    const m = model(empty);
    const rows = parseCsv(sheetToCsv(m));
    for (const r of rows) expect(r.length).toBe(SHEET_CSV_COLUMNS.length);
    // no text cell may start with a formula character unquoted
    for (const r of rows) for (const cell of r) expect(/^[=+\-@]/.test(cell), cell).toBe(false);
  });
});

describe("card conclusions (Forms page)", () => {
  it("states the engine's verdict for the cards whose subject is now computed", () => {
    const c = buildCardConclusions(golden1b);
    expect(Object.keys(c).sort()).toEqual(
      ["additional-medicare-tax", "child-dependent-credits", "form-2210", "form-4562", "form-8829", "form-8880", "form-8889", "qbi-deduction", "schedule-3-federal", "schedule-se"].sort()
    );
    expect(c["additional-medicare-tax"]?.text).toMatch(/^Computed: Form 8959 not required - /);
    expect(c["additional-medicare-tax"]?.tone).toBe("not_required");
    expect(c["form-2210"]?.text).toMatch(/^Computed: Form 2210 not required - The IRS figures any underpayment penalty itself/);
    expect(c["schedule-se"]?.text).toMatch(/^Computed: Schedule SE required - .*Self-employment tax \$[\d,]+ \(line 12\)/);
    expect(c["form-8829"]?.text).toMatch(/^Computed: Form 8829 not required - no home office deduction/);
  });

  it("never claims 'Computed' for something the engine could not compute", () => {
    const c = buildCardConclusions(empty);
    expect(c["child-dependent-credits"]?.tone).toBe("blocked");
    expect(c["child-dependent-credits"]?.text).toMatch(/^Not final/);
    expect(c["qbi-deduction"]?.text).not.toMatch(/^Computed/);
    expect(c["form-8880"]?.text).not.toMatch(/^Computed/);
    for (const v of Object.values(c)) expect(v.text.length).toBeGreaterThan(10);
  });

  it("names the simplified default and the undecided decision on the home office card", () => {
    const c = buildCardConclusions(computeTy2025Return(homeOfficeFacts()));
    expect(c["form-8829"]?.text).toMatch(/Schedule C line 30 is \$[\d,]+ \(simplified method in force by default; decision X1 is undecided\)/);
  });
});

describe("loadSheet (injected builder, no DB)", () => {
  const raw = { documents: DOCS };

  it("builds the model and conclusions from an injected builder and clock", async () => {
    const build = vi.fn(async () => ({ ret: golden1b, raw }));
    const res = await loadSheet(2025, { build, now: () => NOW });
    expect(build).toHaveBeenCalledWith(2025);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.model.generatedAt).toBe(NOW.toISOString());
      expect(res.conclusions["schedule-se"]).toBeDefined();
    }
  });

  it("other years never reach the builder", async () => {
    const build = vi.fn();
    expect(await loadSheet(2024, { build })).toEqual({ kind: "unsupported_year", year: 2024 });
    expect(build).not.toHaveBeenCalled();
  });

  it("passes a builder error through and hides a thrown error's text", async () => {
    expect(await loadSheet(2025, { build: async () => ({ error: "Personal entity not found" }) })).toEqual({ kind: "error", message: "Personal entity not found" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await loadSheet(2025, {
      build: async () => {
        throw new Error("secret row data: 123-45-6789");
      },
    });
    spy.mockRestore();
    expect(res.kind).toBe("error");
    expect(JSON.stringify(res)).not.toContain("123-45-6789");
  });

  it("shows the effective (overridden) values when the builder returns them", async () => {
    const res = await loadSheet(2025, {
      build: async () => ({ ret: golden, raw, effective: applyOverrides(golden, [pinRow(golden, "f1040.1a", 200)]) }),
      now: () => NOW,
    });
    expect(res.kind === "ok" && res.model.overrideCount).toBe(1);
    // without `effective` the sheet is the engine's own return
    const plain = await loadSheet(2025, { build: async () => ({ ret: golden, raw }), now: () => NOW });
    expect(plain.kind === "ok" && plain.model.overrideCount).toBe(0);
  });
});

describe("source checks (page, components, styles)", () => {
  const page = read("app/tax/forms/[year]/return/page.tsx");
  const sheetSrc = read("components/tax/forms/return-sheet.tsx");
  const csvBtn = read("components/tax/forms/return-csv-button.tsx");
  const libFiles = ["lib/tax2025-sheet.ts", "lib/tax2025-sheet-csv.ts", "lib/tax2025-sheet-conclusions.ts", "lib/tax2025-sheet-load.ts"].map(read);

  it("the page authenticates itself before loading anything and only hands the plain model to the sheet", () => {
    expect(page).toMatch(/const session = await auth\(\);\s*\n\s*if \(!session\?\.user\) redirect\("\/login"\);/);
    expect(page.indexOf("await auth()")).toBeLessThan(page.indexOf("loadSheet("));
    expect(page).toContain("<ReturnSheet model={loaded.model} links={linkContextForSheet(loaded.model)} />");
    expect(page).toContain("<AppShell");
    expect(page).toContain('id="return-sheet"');
    expect(page).not.toMatch(/\.facts\b|\.resolved\b|loadTy2025RawInputs|extractionData|Decimal/);
    expect(page).toMatch(/TY\{SHEET_SUPPORTED_YEAR\} only/);
  });

  it("no new file uses window.confirm / confirm( / alert(", () => {
    for (const src of [page, sheetSrc, csvBtn, read("components/tax/forms/form-card.tsx"), ...libFiles, read("actions/tax-return.ts")]) {
      expect(src).not.toMatch(/window\.confirm|\bconfirm\(|\balert\(/);
    }
  });

  it("the sheet component is a server component with no Decimal and no client hooks", () => {
    expect(sheetSrc).not.toMatch(/"use client"|useState|useEffect|import .*Decimal/);
    expect(sheetSrc).toContain('className="sheet-part');
    for (const id of ["part-1", "part-2", "part-3", "part-4", "part-5", "part-6"]) expect(sheetSrc).toContain(id);
  });

  it("no `any` in the new files", () => {
    for (const src of [page, sheetSrc, csvBtn, ...libFiles, read("actions/tax-return.ts")]) {
      expect(src).not.toMatch(/:\s*any\b|\bas any\b|<any>/);
    }
  });

  it("the print block is scoped to #return-sheet so no other page's print changes", () => {
    const css = read("app/globals.css");
    const start = css.indexOf("/* Print: the TY2025 CPA review sheet");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).toContain("@media print");
    const selectors = [...block.matchAll(/^\s*([^@\s/*}][^{}]*?)\s*\{/gm)].map((m) => m[1]!);
    expect(selectors.length).toBeGreaterThan(5);
    for (const sel of selectors) {
      for (const part of sel.split(",")) expect(part.trim(), part).toMatch(/#return-sheet/);
    }
    expect(block).toMatch(/\.sheet-part\s*\{\s*break-before: page;/);
    // the existing cpa-summary block is untouched in shape
    expect(css).toContain("html:has(#cpa-summary)");
  });

  it("the Forms page wiring keeps the cards and counters logic untouched", () => {
    const forms = read("app/tax/forms/[year]/page.tsx");
    expect(forms).toContain("conclusion={conclusions[entry.id]}");
    expect(forms).toContain("{year === PDF_SUPPORTED_YEAR ? <PdfDownloadButtons year={year} overrideCount={overrideCount} /> : null}");
    // T9b: the Forms page banner says the card figures are the engine's and points at the sheet when overrides are in force
    expect(forms).toContain("{overrideCount} owner override(s) are in force. The card figures below are the engine");
    expect(forms).toContain("data.needsCpaInput.map");
    expect(forms).toContain("<FormsSummary data={data} />");
    const buttons = read("components/tax/forms/pdf-download-buttons.tsx");
    expect(buttons).toContain("`/tax/forms/${year}/return`");
    expect(buttons).toContain("Return review sheet");
  });
});
