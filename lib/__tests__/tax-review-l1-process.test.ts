import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { beforeAll, describe, expect, it } from "vitest";
import type { PdfLine } from "@/lib/tax2025/pdf/types";
import type { SheetLine } from "@/lib/tax2025-sheet";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { blankNotZeroCheck } from "@/lib/tax-review/l1/blank-not-zero";
import { plainStatus, plainText } from "@/lib/tax-review/l1/helpers";
import { engineCompleteCheck, engineGateState, overridesInForceCheck, unresolvedChoicesCheck } from "@/lib/tax-review/l1/engine-state";
import { filingMethodCheck } from "@/lib/tax-review/l1/filing-method";
import { requiredFormsCheck } from "@/lib/tax-review/l1/forms-required";
import { priorYearCheck } from "@/lib/tax-review/l1/prior-year";
import { privacyGuardCheck } from "@/lib/tax-review/l1/privacy-guard";
import { reasonablenessCheck } from "@/lib/tax-review/l1/reasonableness";
import { parseCsv, parseHeadlineText, surfaceAgreementCheck } from "@/lib/tax-review/l1/surface-agreement";
import type { Finding } from "@/lib/tax-review/types";
import { owner } from "./tax2025-fixtures";
import { buildPipeline, cleanScenario, richScenario } from "./tax-review-harness";

let clean: L1Context;
let rich: L1Context;

beforeAll(async () => {
  clean = (await buildPipeline(cleanScenario())).ctx;
  rich = (await buildPipeline(richScenario())).ctx;
});

const run = async (check: { run: (c: L1Context) => Finding[] | Promise<Finding[]> }, ctx: L1Context): Promise<Finding[]> => check.run(ctx);
const has = (f: Finding[], check: string, severity?: string): boolean => f.some((x) => x.check === check && (severity === undefined || x.severity === severity));

function withView(ctx: L1Context, edit: (v: L1Context["view"]) => void): L1Context {
  const view = structuredClone(ctx.view);
  edit(view);
  return { ...ctx, view };
}

function setLine(ctx: L1Context, key: string, patch: Partial<PdfLine>): L1Context {
  return withView(ctx, (v) => {
    const l = (v.lines as Partial<Record<string, PdfLine>>)[key];
    if (!l) throw new Error(`no line ${key}`);
    Object.assign(l, patch);
  });
}

describe("L1.D1 the return is complete", () => {
  it("passes on a complete return", async () => {
    expect(await run(engineCompleteCheck, clean)).toEqual([]);
    expect(await run(engineCompleteCheck, rich)).toEqual([]);
  });
  it("an incomplete headline and a blocking item are blockers that cannot be accepted", async () => {
    const c = withView(clean, (v) => {
      v.headline.complete = false;
      v.headline.blockingItemCount = 1;
      v.openItems.push({ id: "x", severity: "blocking", formLabel: "Form 1040", lineKeys: ["f1040.9"], message: "Ask the CPA about this.", action: "Tell the CPA." });
    });
    const f = await run(engineCompleteCheck, c);
    expect(has(f, "L1.D1.incomplete", "blocker")).toBe(true);
    const item = f.find((x) => x.check === "L1.D1.blocking-item");
    expect(item?.acceptable).toBe(false);
    expect(item?.message).not.toMatch(/\bCPA\b/);
    expect(item?.recommendedAction).not.toMatch(/\bCPA\b/);
  });
  it("a money line without an amount on a filed form that no blocking item names is a hole", async () => {
    const c = setLine(clean, "f1040.14", { status: "missing_input", amount: null });
    expect(has(await run(engineCompleteCheck, c), "L1.D1.blocked-lines", "blocker")).toBe(true);
  });
  it("an informational line, or a line of a form that is not filed, is not a hole", async () => {
    expect(await run(engineCompleteCheck, setLine(clean, "f1040.35a", { status: "not_yet_computed", amount: null, informational: true }))).toEqual([]);
    expect(await run(engineCompleteCheck, setLine(clean, "sch1a.38", { status: "not_yet_computed", amount: null }))).toEqual([]);
  });
});

describe("L1.D2 unresolved choices", () => {
  it("passes on the clean return", async () => {
    expect(await run(unresolvedChoicesCheck, clean)).toEqual([]);
  });
  it("lists a default decision, a fact conflict, unverified documents, derived inputs and a 'not sure' header answer", async () => {
    const view = structuredClone(clean.view);
    view.decisions = [{ id: "X1", label: "Home office method", chosen: "simplified", status: "default_undecided", effectNote: "In force: simplified." }];
    view.headline.unverifiedDocumentCount = 2;
    view.headline.derivedInputCount = 1;
    const ret = {
      ...clean.ret,
      conflicts: [{ factKey: "income.interest.d1", candidates: [], chosen: null, reason: "Two sources disagree." }],
      attestations: { ...clean.ret.attestations, foreignAccounts: { ...clean.ret.attestations.foreignAccounts, status: "unsure" as const, value: null } },
    };
    const f = await run(unresolvedChoicesCheck, { ...clean, view, ret });
    for (const id of ["L1.D2.decision", "L1.D2.conflict", "L1.D2.unverified-docs", "L1.D2.derived-inputs"]) expect(has(f, id, "medium"), id).toBe(true);
    expect(has(f, "L1.D2.header-answer", "high")).toBe(true);
    expect(f.every((x) => x.acceptable)).toBe(true);
  });
});

describe("L1.D3 overrides in force", () => {
  it("nothing to report without overrides", async () => {
    expect(await run(overridesInForceCheck, clean)).toEqual([]);
    expect(await run(overridesInForceCheck, { ...clean, effective: null })).toEqual([]);
  });
  it("orphan, unreadable and duplicate override rows are reported; an engine-version-only change is information", async () => {
    const eff = clean.effective;
    if (!eff) throw new Error("no effective return");
    const e = {
      ...eff,
      orphans: [{ id: "o1", targetKind: "line" as const, targetKey: "x.y", version: 1, message: "The target no longer exists." }],
      invalid: [{ id: "o2", error: "unknown authority" }],
      anomalies: [{ targetKind: "line", targetKey: "sch1.3", ids: ["a", "b"], message: "More than one active override exists for line sch1.3." }],
      engineChanged: [{ id: "o3", targetKind: "line" as const, targetKey: "sch1.3", version: 1, was: "$1", now: "$1", message: "The engine changed; the value did not." }],
    };
    const f = await run(overridesInForceCheck, { ...clean, effective: e });
    expect(f.filter((x) => x.check === "L1.D3.unusable").length).toBe(2);
    expect(has(f, "L1.D3.anomaly", "high")).toBe(true);
    expect(has(f, "L1.D3.engine-changed", "info")).toBe(true);
  });
  it("the gate's engine state counts line overrides and stale ones (counts only)", () => {
    expect(engineGateState(clean)).toEqual({ complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 });
  });
});

describe("L1.D4 privacy guard", () => {
  it("passes (an employer ID alone is low, not a blocker) on the clean return", async () => {
    const f = await run(privacyGuardCheck, clean);
    expect(f.every((x) => x.severity === "low" && x.check === "L1.D4.ein" && x.acceptable)).toBe(true);
  });
  it("an SSN-like number, a 9-digit run or a long account number in any text surface is a blocker, and is never echoed", async () => {
    for (const bad of ["123-45-6789", "987654321", "12345678901234"]) {
      const c = { ...clean, csvText: `${clean.csvText}\r\nnote,${bad}\r\n` };
      const f = await run(privacyGuardCheck, c);
      const hit = f.find((x) => x.check === "L1.D4.text");
      expect(hit?.severity, bad).toBe("blocker");
      expect(hit?.acceptable).toBe(false);
      expect(JSON.stringify(hit)).not.toContain(bad);
    }
  });
  it("text in the view (an open item) and in the sheet is scanned too", async () => {
    const v = withView(clean, (view) => view.openItems.push({ id: "p", severity: "advisory", formLabel: "General", lineKeys: [], message: "Call 123-45-6789", action: "x" }));
    expect((await run(privacyGuardCheck, v)).some((x) => x.check === "L1.D4.text")).toBe(true);
  });
});

describe("L1.D5 blank-not-zero", () => {
  it("passes on the clean return, with informational lines listed as advisory items", async () => {
    expect(await run(blankNotZeroCheck, clean)).toEqual([]);
  });
  it("a sheet line without an amount shown as $0 is a blocker", async () => {
    const sheet = structuredClone(clean.sheet);
    const l = sheet.federal.flatMap((g) => g.lines).find((x: SheetLine) => x.key === "f1040.35a");
    if (!l) throw new Error("line missing on the sheet");
    l.amountText = "$0";
    expect(has(await run(blankNotZeroCheck, { ...clean, sheet }), "L1.D5.sheet", "blocker")).toBe(true);
  });
  it("a headline figure without an amount shown as $0 on the cover is a blocker", async () => {
    const view = structuredClone(clean.view);
    view.headline.federal.totalTax.amount = null;
    const cover = structuredClone(clean.cover);
    const row = cover?.blocks.find((b) => b.kind === "kv" && b.label.startsWith("Federal total tax"));
    if (!cover || row?.kind !== "kv") throw new Error("cover row missing");
    row.value = "$0";
    expect(has(await run(blankNotZeroCheck, { ...clean, view, cover }), "L1.D5.cover", "blocker")).toBe(true);
  });
  it("an informational line with no advisory item that names it is medium", async () => {
    const view = structuredClone(clean.view);
    view.openItems = view.openItems.filter((i) => !i.lineKeys.includes("f1040.35a"));
    expect(has(await run(blankNotZeroCheck, { ...clean, view }), "L1.D5.informational", "medium")).toBe(true);
  });
});

describe("L1.E1 prior year", () => {
  it("passes within the thresholds and says nothing about the 2024 return beyond three figures", async () => {
    expect(await run(priorYearCheck, clean)).toEqual([]);
  });
  it("is low (never higher) when no 2024 return is on file", async () => {
    const facts = structuredClone(clean.facts);
    facts.priorYear = { totalTaxCents: { value: null, basis: null, refs: [] }, agiCents: { value: null, basis: null, refs: [] }, filingStatus: { value: null, basis: null, refs: [] } };
    const f = await run(priorYearCheck, { ...clean, facts });
    expect(f.map((x) => `${x.check}:${x.severity}`)).toEqual(["L1.E1.missing:low"]);
  });
  it("flags a changed filing status, and AGI / tax moves beyond the heuristic thresholds (medium, acceptable, labelled a heuristic)", async () => {
    const facts = structuredClone(clean.facts);
    facts.priorYear = { totalTaxCents: owner(1_000_000), agiCents: owner(8_000_000), filingStatus: owner("single") };
    const f = await run(priorYearCheck, { ...clean, facts });
    for (const id of ["L1.E1.filing-status", "L1.E1.agi", "L1.E1.tax"]) {
      const hit = f.find((x) => x.check === id);
      expect(hit?.severity, id).toBe("medium");
      expect(hit?.acceptable).toBe(true);
    }
    expect(f.find((x) => x.check === "L1.E1.agi")?.citation.sources[0]?.kind).toBe("heuristic");
    expect(f.find((x) => x.check === "L1.E1.agi")?.message).toMatch(/heuristic, not a rule of law/);
  });
  it("a move inside the threshold is not flagged; a zero prior value is skipped", async () => {
    const agi = clean.view.lines["f1040.11a"]?.amount ?? 0;
    const facts = structuredClone(clean.facts);
    facts.priorYear = { totalTaxCents: owner(0), agiCents: owner(Math.round((agi / 1.2) * 100)), filingStatus: owner("mfj") };
    const f = await run(priorYearCheck, { ...clean, facts });
    expect(f.some((x) => x.check === "L1.E1.agi")).toBe(false);
    expect(f.some((x) => x.check === "L1.E1.tax")).toBe(false);
  });
});

describe("L1.E2 reasonableness", () => {
  it("passes on the clean and rich returns", async () => {
    expect(await run(reasonablenessCheck, clean)).toEqual([]);
    expect(await run(reasonablenessCheck, rich)).toEqual([]);
  });
  it("each ratio is flagged only above its limit, as a heuristic of at most medium severity", async () => {
    const cases: [string, string, number][] = [
      ["effective-rate", "f1040.24", 100_000],
      ["se-ratio", "se.12", 40_000],
      ["expense-ratio", "schc.28", 80_000],
      ["charity-ratio", "scha.14", 250_000],
      ["ct-ratio", "ct1040.6", 40_000],
    ];
    for (const [id, key, extra] of cases) {
      const base = [rich, clean].find((c) => c.view.lines[key as keyof typeof c.view.lines]?.amount !== undefined) ?? rich;
      const c = setLine(base, key, { amount: (base.view.lines[key as keyof typeof base.view.lines]?.amount ?? 0) + extra, status: "computed" });
      const f = await run(reasonablenessCheck, c);
      const hit = f.find((x) => x.check === `L1.E2.${id}`);
      expect(hit, id).toBeDefined();
      expect(["medium", "low"]).toContain(hit?.severity);
      expect(hit?.citation.sources[0]?.kind).toBe("heuristic");
    }
  });
  it("a tiny denominator gives no ratio finding, and a close itemize-vs-standard call is low", async () => {
    const tiny = setLine(clean, "f1040.9", { amount: 10 });
    expect((await run(reasonablenessCheck, tiny)).some((x) => x.check === "L1.E2.effective-rate")).toBe(false);
    const std = rich.view.lines["std.total"]?.amount ?? 0;
    const close = setLine(rich, "scha.17", { amount: std + 1 });
    expect(has(await run(reasonablenessCheck, close), "L1.E2.itemize-margin", "low")).toBe(true);
  });
});

describe("L1.G1 required forms exist", () => {
  it("passes on the clean and the rich return (Schedule 1-A and Form 8960 have PDFs now); a required form with no map is blocked and says what to do", async () => {
    expect(await run(requiredFormsCheck, clean)).toEqual([]);
    expect(await run(requiredFormsCheck, rich)).toEqual([]);
    // the rich return needs Form 8960 (NIIT): take its map away and the form has no PDF, which is the blocker
    const f = await run(requiredFormsCheck, { ...rich, maps: rich.maps.filter((m) => m.formId !== "f8960") });
    expect(f.map((x) => x.check)).toEqual(["L1.G1.no-pdf"]);
    expect(f[0]?.severity).toBe("blocker");
    expect(f[0]?.acceptable).toBe(false);
    expect(f[0]?.recommendedAction).toMatch(/Prepare this form outside this app/);
  });
  it("a form the engine cannot rule out counts as required", async () => {
    const view = structuredClone(clean.view);
    view.formsRequired = { ...view.formsRequired, f6251: { required: "blocking", reason: "The AMT screen is not computed yet." } };
    const f = await run(requiredFormsCheck, { ...clean, view });
    expect(f.some((x) => x.check === "L1.G1.no-pdf" && /cannot rule it out/.test(x.message))).toBe(true);
  });
  it("a map without a pinned blank, and a required form that the packet did not emit, are blockers", async () => {
    const noBlank = await run(requiredFormsCheck, { ...clean, blankFormIds: new Set([...clean.blankFormIds].filter((id) => id !== "f1040sc")) });
    expect(has(noBlank, "L1.G1.no-blank", "blocker")).toBe(true);
    const files = clean.packet.files.filter((f) => f.formId !== "f1040sc");
    const notEmitted = await run(requiredFormsCheck, { ...clean, packet: { ...clean.packet, files } });
    expect(has(notEmitted, "L1.G1.not-emitted", "blocker")).toBe(true);
  });
});

describe("L1.G2 filing method", () => {
  it("Form 8949 summary rows with an attached statement: medium, unverified, never an assertion of law", async () => {
    const f = await run(filingMethodCheck, rich);
    const hit = f.find((x) => x.check === "L1.G2.form8949-statement");
    expect(hit?.severity).toBe("medium");
    expect(hit?.citation.sourceStatus).toBe("unverified");
    expect(hit?.message).toMatch(/has not verified/);
    expect(f.some((x) => x.check === "L1.G2.form8949-statement")).toBe(true);
  });
  it("lists the CT-1040 as a printed form and the fields to complete by hand (counts only)", async () => {
    const f = await run(filingMethodCheck, clean);
    expect(f.some((x) => x.check === "L1.G2.form8949-statement")).toBe(false);
    expect(has(f, "L1.G2.ct-flat", "info")).toBe(true);
    const hand = f.find((x) => x.check === "L1.G2.by-hand");
    expect(hand?.message).toMatch(/Social security numbers \(\d+ field/);
    expect(hand?.message).toMatch(/signature line for you and one for your spouse/);
  });
});

describe("L1.X1 same figures on every surface", () => {
  it("passes on the clean and rich returns", async () => {
    expect(await run(surfaceAgreementCheck, clean)).toEqual([]);
    expect(await run(surfaceAgreementCheck, rich)).toEqual([]);
  });
  it("parses CSV text (quotes, doubled quotes, CRLF) and sheet headline text (owed / refund)", () => {
    expect(parseCsv('a,"b,c","d ""q"""\r\n1,2,3\r\n')).toEqual([["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
    expect(parseHeadlineText("owed $15,223")).toBe(15223);
    expect(parseHeadlineText("refund $1,000")).toBe(-1000);
    expect(parseHeadlineText("$0 (no balance)")).toBe(0);
    expect(parseHeadlineText("not computed")).toBeNull();
    expect(parseHeadlineText("-$5")).toBe(-5);
  });
  it("a sheet line that differs from the forms, a line missing from the sheet or the CSV, and an extra sheet line", async () => {
    const sheet = structuredClone(clean.sheet);
    const lines = sheet.federal.flatMap((g) => g.lines);
    const l = lines.find((x) => x.key === "f1040.9");
    if (!l || l.amount === null) throw new Error("line 9 missing");
    l.amount += 1;
    const f = await run(surfaceAgreementCheck, { ...clean, sheet });
    expect(has(f, "L1.X1.sheet", "blocker")).toBe(true);
    const dropped = structuredClone(clean.sheet);
    for (const g of dropped.federal) g.lines = g.lines.filter((x) => x.key !== "f1040.9");
    expect(has(await run(surfaceAgreementCheck, { ...clean, sheet: dropped }), "L1.X1.sheet-missing", "high")).toBe(true);
    const csv = clean.csvText.split("\r\n").filter((row) => !row.includes(",f1040.9,")).join("\r\n");
    expect(has(await run(surfaceAgreementCheck, { ...clean, csvText: csv }), "L1.X1.csv-missing", "high")).toBe(true);
    const extra = structuredClone(clean.sheet);
    const first = extra.federal[0];
    if (!first) throw new Error("no federal group");
    const view = structuredClone(clean.view);
    delete (view.lines as Record<string, PdfLine | undefined>)["f1040.38"];
    expect(has(await run(surfaceAgreementCheck, { ...clean, view }), "L1.X1.sheet-extra", "high")).toBe(true);
  });
  it("headline figures on the sheet and on the cover must equal the return's", async () => {
    const sheet = structuredClone(clean.sheet);
    const row = sheet.summary.federal[2];
    if (!row) throw new Error("headline row missing");
    row.computedText = "$1";
    const cover = structuredClone(clean.cover);
    const kv = cover?.blocks.find((b) => b.kind === "kv" && b.label.startsWith("Federal total tax"));
    if (!cover || kv?.kind !== "kv") throw new Error("cover row missing");
    kv.value = "$2";
    const f = await run(surfaceAgreementCheck, { ...clean, sheet, cover });
    expect(has(f, "L1.X1.headline-sheet", "blocker")).toBe(true);
    expect(has(f, "L1.X1.headline-cover", "blocker")).toBe(true);
  });
  it("an override note that differs between the forms and the sheet is a blocker", async () => {
    const view = structuredClone(clean.view);
    const line = (view.lines as Partial<Record<string, PdfLine>>)["sch1.3"];
    if (!line) throw new Error("no sch1.3");
    line.override = { note: "Owner override: was $1 computed, now $2", computedAmount: 1, stale: false };
    expect(has(await run(surfaceAgreementCheck, { ...clean, view }), "L1.X1.override-note", "blocker")).toBe(true);
  });
});

describe("plain wording of quoted engine text", () => {
  it("never leaves a CPA reference in text the reviewer shows (the shared owner-wording layer, lib/tax-wording.ts)", () => {
    expect(plainText("Ask the CPA about it.")).toBe("Ask a tax professional about it.");
    expect(plainText("The CPA decides.")).toBe("You decide.");
    expect(plainText("if the CPA chooses the actual method")).toBe("if you choose the actual method");
    expect(plainText("left for the CPA to figure")).toBe("left for you to figure");
    expect(plainText("CPA review needed")).toBe("Your review needed");
    expect(plainText("x".repeat(500), 50)).toHaveLength(50);
  });
  it("status ids become plain words", () => {
    expect(plainStatus("needs_cpa_rule_unverified")).toBe("rule not verified");
    expect(plainStatus("needs_cpa_judgment")).toBe("needs your decision");
    expect(plainStatus("missing_input")).toBe("missing input");
    expect(plainStatus("not_yet_computed")).toBe("not yet computed");
    for (const s of ["needs_cpa_rule_unverified", "needs_cpa_judgment"]) expect(plainStatus(s)).not.toMatch(/cpa/i);
  });
});
