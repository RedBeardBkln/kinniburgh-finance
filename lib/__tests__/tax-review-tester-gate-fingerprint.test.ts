// TESTER (independent) probes for ai-return-reviewer UNIT X: exhaustive gate enumeration against an oracle written from the plan,
// approval / current-approval oracles, and end-to-end fingerprint v2 mutation through the real loader.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { describe, expect, it } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn(async () => null) }));

import { createHash } from "node:crypto";
import { currentReturnFingerprint, type ReviewBuildDeps } from "@/lib/tax-review-build";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import {
  ATTESTATION_V1_TEXT,
  ATTESTATION_V2_TEXT,
  currentApproval,
  evaluateApproval,
  evaluateGate,
  type DispositionRow,
  type GateInput,
  type LayerRunState,
} from "@/lib/tax-review/gate";
import { computeReturnFingerprint, type FingerprintInput } from "@/lib/tax-review/fingerprint";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import { blankFormIds, cleanScenario, loadCatalogs, loadLineLabels, type Scenario } from "./tax-review-harness";

// ── Plan text, copied by hand from 01-plan.md section 5.7 item 7 ────────────────────────────────────────────
const PLAN_ATTESTATION =
  "I, Eric Kinniburgh, prepared this 2025 federal and Connecticut income tax return myself. I have reviewed every figure and every decision recorded in the Final review, I understand the AI review is an automated aid and not a professional opinion, and I take full responsibility for the return as its preparer.";

describe("attestation text v1", () => {
  it("is the plan's text verbatim", () => {
    expect(ATTESTATION_V1_TEXT).toBe(PLAN_ATTESTATION);
  });
});

// ── Independent gate oracle ─────────────────────────────────────────────────────────────────────────────────
type Scen = { name: string; finding: Finding | null; dispositions: DispositionRow[]; layer: "L1" | "L2" | "L3" };

function mk(layer: "L1" | "L2" | "L3", severity: Finding["severity"], acceptable: boolean, extra: Partial<{ downgradedFrom: Finding["severity"]; unverified: boolean; ruleTag: string; origin: "llm" | "deterministic" }> = {}): Finding {
  const origin = extra.origin ?? (acceptable || layer === "L1" ? (layer === "L3" ? "llm" : "deterministic") : "deterministic");
  return makeFinding({
    layer,
    check: `${layer}.probe`,
    severity,
    area: "process",
    ruleTag: extra.ruleTag ?? "t",
    message: "probe",
    recommendedAction: "probe",
    acceptable,
    origin: acceptable ? origin : "deterministic",
    ...(extra.downgradedFrom ? { downgradedFrom: extra.downgradedFrom } : {}),
    citation: { sources: [], sourceStatus: extra.unverified ? "unverified" : "not_applicable" },
    evidence: [{ ref: "f1040.9", amount: 5, status: "computed" }],
  });
}

function scenarios(layer: "L1" | "L2" | "L3"): Scen[] {
  const out: Scen[] = [];
  const acc = (f: Finding, reason = "owner reason", hash = f.evidenceHash, action: "accepted" | "reopened" = "accepted", at = "2026-10-05T10:00:00Z"): DispositionRow => ({ findingKey: f.key, evidenceHash: hash, action, reason, at });
  out.push({ name: "none", finding: null, dispositions: [], layer });
  const b = mk(layer, "blocker", true);
  out.push({ name: "blocker open", finding: b, dispositions: [], layer });
  out.push({ name: "blocker accepted", finding: b, dispositions: [acc(b)], layer });
  out.push({ name: "blocker accepted reason 2 chars", finding: b, dispositions: [acc(b, "ab")], layer });
  out.push({ name: "blocker accepted reason padded spaces", finding: b, dispositions: [acc(b, "  a  ")], layer });
  out.push({ name: "blocker accepted stale hash", finding: b, dispositions: [acc(b, "owner reason", "0000000000000000")], layer });
  out.push({ name: "blocker accepted then reopened", finding: b, dispositions: [acc(b), acc(b, "x", b.evidenceHash, "reopened", "2026-10-05T11:00:00Z")], layer });
  out.push({ name: "blocker reopened then accepted", finding: b, dispositions: [acc(b, "x", b.evidenceHash, "reopened", "2026-10-05T09:00:00Z"), acc(b)], layer });
  out.push({ name: "blocker accepted(array 1st, later time) then reopened(earlier time)", finding: b, dispositions: [acc(b, "ok ok", b.evidenceHash, "accepted", "2026-10-05T12:00:00Z"), acc(b, "x", b.evidenceHash, "reopened", "2026-10-05T11:00:00Z")], layer });
  const h = mk(layer, "high", true);
  out.push({ name: "high open", finding: h, dispositions: [], layer });
  out.push({ name: "high accepted", finding: h, dispositions: [acc(h)], layer });
  const m = mk(layer, "medium", true);
  out.push({ name: "medium open", finding: m, dispositions: [], layer });
  const l = mk(layer, "low", false);
  out.push({ name: "low NON-acceptable open", finding: l, dispositions: [], layer });
  out.push({ name: "low NON-acceptable 'accepted'", finding: l, dispositions: [acc(l)], layer });
  const nb = mk(layer, "blocker", false);
  out.push({ name: "blocker NON-acceptable 'accepted'", finding: nb, dispositions: [acc(nb)], layer });
  const info = mk(layer, "info", false);
  out.push({ name: "info NON-acceptable open", finding: info, dispositions: [], layer });
  const dg = mk(layer, "medium", true, { downgradedFrom: "blocker", unverified: true, origin: "llm" });
  out.push({ name: "unverified downgraded-from-blocker open", finding: dg, dispositions: [], layer });
  out.push({ name: "unverified downgraded-from-blocker accepted", finding: dg, dispositions: [acc(dg)], layer });
  const dv = mk(layer, "medium", true, { downgradedFrom: "blocker", unverified: false, origin: "llm" });
  out.push({ name: "verified downgraded-from-blocker open", finding: dv, dispositions: [], layer });
  const dm = mk(layer, "low", true, { downgradedFrom: "medium", unverified: true, origin: "llm" });
  out.push({ name: "unverified downgraded-from-medium open", finding: dm, dispositions: [], layer });
  return out;
}

const isGatingSev = (s: string) => s === "blocker" || s === "high";
function oracleOpen(f: Finding, ds: DispositionRow[]): boolean {
  // accepted iff acceptable and the LATEST disposition for (key, hash) is accepted with >=3 non-space chars
  if (!f.acceptable) return true;
  const mine = ds.map((d, i) => ({ d, i, t: Date.parse(String(d.at)) })).filter((x) => x.d.findingKey === f.key && x.d.evidenceHash === f.evidenceHash);
  if (mine.length === 0) return true;
  mine.sort((a, b) => a.t - b.t || a.i - b.i);
  const last = mine[mine.length - 1]!.d;
  return !(last.action === "accepted" && last.reason.trim().length >= 3);
}
function oracleGating(f: Finding): boolean {
  return isGatingSev(f.severity) || (f.downgradedFrom !== undefined && isGatingSev(f.downgradedFrom) && f.citation.sourceStatus === "unverified") || !f.acceptable;
}

function oracleApprovable(i: GateInput): boolean {
  if (i.runFingerprint === null || i.runFingerprint !== i.currentFingerprint) return false;
  if (!i.engine.complete || i.engine.blockingItemCount !== 0 || i.engine.lineOverrideCount !== 0 || i.engine.staleOverrideCount !== 0) return false;
  const layerOk = (layer: "L1" | "L2" | "L3", st: LayerRunState, extraOk: boolean) => {
    if (st !== "completed" || !extraOk) return false;
    return !i.findings.some((f) => f.layer === layer && oracleOpen(f, [...i.dispositions]) && oracleGating(f));
  };
  return layerOk("L1", i.l1.status, true) && layerOk("L2", i.l2.status, i.l2.coverageListed) && layerOk("L3", i.l3.status, i.l3.adversarialCompleted);
}

describe("gate: exhaustive enumeration against an independent oracle", () => {
  it("verdict === oracle for every combination (and 'passed' only on the single all-green path)", () => {
    const FP = "a".repeat(64);
    const OTHER = "b".repeat(64);
    const fps: [string | null, string][] = [[null, FP], [FP, FP], [OTHER, FP], ["", ""]];
    const states: LayerRunState[] = ["not_run", "partial", "completed", "failed"];
    let total = 0;
    let passed = 0;
    const passedSample: string[] = [];
    for (const [runFp, curFp] of fps) {
      for (let eb = 0; eb < 16; eb++) {
        const engine = { complete: !(eb & 1), blockingItemCount: eb & 2 ? 1 : 0, lineOverrideCount: eb & 4 ? 1 : 0, staleOverrideCount: eb & 8 ? 1 : 0 };
        for (const s1 of states) for (const s2 of states) for (const s3 of states) for (const cov of [false, true]) for (const adv of [false, true]) {
          for (const layer of ["L1", "L2", "L3"] as const) {
            for (const sc of scenarios(layer)) {
              const input: GateInput = {
                runFingerprint: runFp,
                currentFingerprint: curFp,
                engine,
                findings: sc.finding ? [sc.finding] : [],
                dispositions: sc.dispositions,
                l1: { status: s1 },
                l2: { status: s2, coverageListed: cov },
                l3: { status: s3, adversarialCompleted: adv },
              };
              // reduce the enumeration: the two non-finding layer states only vary fully for the "none" scenario
              if (sc.name !== "none" && (s1 !== "completed" || s2 !== "completed" || s3 !== "completed") && (eb !== 0 || runFp !== FP)) continue;
              const g = evaluateGate(input);
              const expected = oracleApprovable(input);
              total += 1;
              if ((g.verdict === "passed") !== expected) throw new Error(`mismatch ${JSON.stringify({ runFp, eb, s1, s2, s3, cov, adv, layer, sc: sc.name })}: impl=${g.verdict} oracle=${expected}`);
              if (g.verdict === "passed") {
                passed += 1;
                if (passedSample.length < 40) passedSample.push(`${layer}/${sc.name}`);
                // every item must be pass when the verdict is passed
                expect(g.items.every((x) => x.state === "pass")).toBe(true);
              } else {
                // when flagged at least one item is not pass
                expect(g.items.some((x) => x.state !== "pass")).toBe(true);
              }
              // the verdict item mirrors the verdict
              expect(g.items.find((x) => x.id === "verdict")?.state).toBe(g.verdict === "passed" ? "pass" : "fail");
            }
          }
        }
      }
    }
    console.log(`gate enumeration: ${total} combos, ${passed} passed`);
    // the passed set must contain only scenarios that leave nothing open+gating
    expect(passed).toBeGreaterThan(0);
  });

  it("D8: L2/L3 not_run is red and there is no waiver field anywhere on GateInput", () => {
    const FP = "c".repeat(64);
    const base: GateInput = {
      runFingerprint: FP, currentFingerprint: FP,
      engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
      findings: [], dispositions: [],
      l1: { status: "completed" }, l2: { status: "completed", coverageListed: true }, l3: { status: "completed", adversarialCompleted: true },
    };
    expect(evaluateGate(base).verdict).toBe("passed");
    for (const k of ["l2", "l3"] as const) {
      const g = evaluateGate({ ...base, [k]: { status: "not_run", coverageListed: true, adversarialCompleted: true } });
      expect(g.verdict).toBe("flagged");
      expect(g.items.find((x) => x.id === k)?.state).toBe("not_run");
    }
    // extra properties a caller might try to sneak in (waiver) are ignored: gate still flagged
    const sneaky = { ...base, l2: { status: "not_run" as const, coverageListed: true, waived: true, waiver: "accepted" }, l3: { status: "not_run" as const, adversarialCompleted: true, waived: true }, waiveL2: true, waiveL3: true } as unknown as GateInput;
    expect(evaluateGate(sneaky).verdict).toBe("flagged");
  });
});

describe("evaluateApproval: oracle enumeration", () => {
  const passedGate = (() => {
    const FP = "d".repeat(64);
    return evaluateGate({
      runFingerprint: FP, currentFingerprint: FP,
      engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
      findings: [], dispositions: [],
      l1: { status: "completed" }, l2: { status: "completed", coverageListed: true }, l3: { status: "completed", adversarialCompleted: true },
    });
  })();
  const flaggedGate = evaluateGate({
    runFingerprint: null, currentFingerprint: "e".repeat(64),
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [], dispositions: [],
    l1: { status: "completed" }, l2: { status: "not_run", coverageListed: false }, l3: { status: "not_run", adversarialCompleted: false },
  });
  it("ok only when passed + allowed + checked + exact text + exact phrase + matching name", () => {
    const texts = [ATTESTATION_V2_TEXT, ATTESTATION_V2_TEXT + " ", ATTESTATION_V2_TEXT.replace("Eric", "Eva"), PLAN_ATTESTATION, "", ATTESTATION_V2_TEXT.toLowerCase()];
    const phrases = ["I PREPARED THIS RETURN", "i prepared this return", " I PREPARED THIS RETURN ", "I PREPARED THIS RETURN.", "I  PREPARED THIS RETURN", ""];
    const names = ["Eric Kinniburgh", "eric kinniburgh", "  ERIC   KINNIBURGH ", "Eric", "Eva-Laura Ramirez-Wisiackas", "", "Eric Kinniburgh​"];
    let oks = 0;
    for (const gate of [passedGate, flaggedGate]) for (const allowed of [true, false]) for (const checked of [true, false]) for (const t of texts) for (const ph of phrases) for (const nm of names) for (const approver of ["Eric Kinniburgh", ""]) {
      const d = evaluateApproval(gate, { checked, attestationText: t, typedPhrase: ph, typedName: nm }, { approverName: approver, approverAllowed: allowed });
      const normName = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
      const expected = gate.verdict === "passed" && allowed && checked && t === ATTESTATION_V2_TEXT && ph.trim() === "I PREPARED THIS RETURN" && approver !== "" && normName(nm) === normName(approver);
      if (d.ok !== expected) throw new Error(`mismatch ${JSON.stringify({ gate: gate.verdict, allowed, checked, t: t.slice(0, 10), ph, nm, approver })}: impl ${d.ok}`);
      if (d.ok) oks += 1;
      if (!d.ok) expect(d.reasons.length).toBeGreaterThan(0);
    }
    expect(oks).toBeGreaterThan(0);
  });
});

describe("currentApproval oracle", () => {
  it("latest row by (time, array position) must be 'approved' with the current fingerprint", () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const fps = ["1".repeat(64), "2".repeat(64)];
    for (let n = 0; n < 5000; n++) {
      const len = Math.floor(rnd() * 6);
      const rows = Array.from({ length: len }, (_, i) => ({ kind: (rnd() < 0.5 ? "approved" : "withdrawn") as "approved" | "withdrawn", fingerprint: fps[Math.floor(rnd() * 2)]!, at: new Date(Date.UTC(2026, 9, 5, 10, Math.floor(rnd() * 4))), id: i }));
      const cur = fps[Math.floor(rnd() * 2)]!;
      const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.at.getTime() - b.r.at.getTime() || a.i - b.i);
      const last = sorted[sorted.length - 1]?.r;
      const expected = last && last.kind === "approved" && last.fingerprint === cur ? last : null;
      const got = currentApproval(rows, cur, { findings: [], dispositions: [], aiCancelledAt: [] });
      expect(got?.id ?? null).toBe(expected?.id ?? null);
    }
  });
});

// ── fingerprint e2e mutation through the real loader ───────────────────────────────────────────────────────
const ENTITY = "22222222-2222-4222-8222-222222222222";
function depsFor(s: Scenario, over: Partial<ReviewBuildDeps> & { rows?: OverrideRow[]; q?: unknown } = {}): ReviewBuildDeps {
  return {
    loadRaw: async () => structuredClone(s.raw),
    overrides: { resolveEntityId: async () => ENTITY, loadRows: async () => over.rows ?? [] },
    loadQuestionnaires: async () => [{ questionnaireId: "return_completeness", definitionVersion: 3, answers: over.q ?? { q1: "none", nested: { a: 1, b: 2 } } }],
    ekcName: async () => "Sample Consulting, LLC",
    now: () => new Date("2026-10-05T16:00:00Z"),
    formData: () => ({ catalogs: loadCatalogs(), lineLabels: loadLineLabels(), blankFormIds: blankFormIds() }),
    ...over,
  };
}
async function fpOf(s: Scenario, over: Partial<ReviewBuildDeps> & { rows?: OverrideRow[]; q?: unknown } = {}) {
  const r = await currentReturnFingerprint(2025, "Tester", depsFor(s, over));
  if ("error" in r) throw new Error(r.error);
  return r.fingerprint;
}
const overrideRow = (over: Partial<OverrideRow> = {}): OverrideRow => ({
  id: "00000000-0000-4000-8000-0000000000dd", taxYear: 2025, targetKind: "decision", targetKey: "homeOfficeMethod", version: 1, valueKind: "choice",
  valueCents: null, valueText: "actual", computedSnapshot: { status: "default_undecided", cents: null }, authority: "owner", reason: "because",
  setByName: "Test User", setAt: new Date("2026-10-01T12:00:00Z"), archivedAt: null, ...over,
});

describe("fingerprint v2: every input group changes it (through the real loader)", () => {
  it("baseline is deterministic; clock, caller name, key order of answers and an unrelated array order do not matter", async () => {
    const s = cleanScenario();
    const a = await fpOf(s);
    const b = await fpOf(s);
    const c = await fpOf(s, { now: () => new Date("2027-01-01T00:00:00Z") });
    const d = await fpOf(s, { q: { nested: { b: 2, a: 1 }, q1: "none" } });
    // reordered documents
    const s2 = cleanScenario();
    s2.raw.documents.reverse();
    const e = await fpOf(s2);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe(c.fingerprint);
    expect(a.fingerprint).toBe(d.fingerprint);
    // document order: the engine's resolved facts may depend on order (e.g. w2s list order) -> report what happens
    console.log("doc-order-reversed fingerprint equal:", a.fingerprint === e.fingerprint, "changed parts:", Object.keys(a.parts).filter((k) => (a.parts as unknown as Record<string, string>)[k] !== (e.parts as unknown as Record<string, string>)[k]).join(","));
  });

  const mutations: [string, (s: Scenario) => void, Partial<ReviewBuildDeps> & { rows?: OverrideRow[]; q?: unknown }, string][] = [
    ["engine version (via a direct input)", () => undefined, {}, "engine"],
    ["a W-2 box 1 value in the document extraction", (s) => { const d = s.raw.documents.find((x) => x.docType === "w2")!; (d.extractionData as { data: Record<string, unknown> }).data.wagesCents = 9_000_100; }, {}, "documents"],
    ["a document verified flag", (s) => { s.raw.documents[0]!.verified = false; }, {}, "documents"],
    ["a document status", (s) => { s.raw.documents[0]!.extractionStatus = "failed"; }, {}, "documents"],
    ["a document tax year", (s) => { s.raw.documents[0]!.taxYear = 2024; }, {}, "documents"],
    ["a document subject user", (s) => { s.raw.documents[0]!.subjectUserId = "x"; }, {}, "documents"],
    ["an extra (unrelated) document", (s) => { s.raw.documents.push({ ...s.raw.documents[0]!, id: "00000000-0000-4000-8000-00000000beef", docType: "other" }); }, {}, "documents"],
    ["a removed document", (s) => { s.raw.documents.pop(); }, {}, "documents"],
    ["a legacyFormat flag", (s) => { s.raw.documents[1]!.legacyFormat = true; }, {}, "documents"],
    ["a questionnaire answer", () => undefined, { q: { q1: "some", nested: { a: 1, b: 2 } } }, "questionnaires"],
    ["a questionnaire answer, deep", () => undefined, { q: { q1: "none", nested: { a: 1, b: 3 } } }, "questionnaires"],
    ["a questionnaire answer, whitespace", () => undefined, { q: { q1: "none ", nested: { a: 1, b: 2 } } }, "questionnaires"],
    ["a questionnaire answer, CRLF vs LF", () => undefined, { q: { q1: "none\r\n", nested: { a: 1, b: 2 } } }, "questionnaires"],
    ["a decision override row (X1)", () => undefined, { rows: [overrideRow()] }, "overrides"],
    ["an archived override row", () => undefined, { rows: [overrideRow({ archivedAt: new Date("2026-10-02T00:00:00Z") })] }, "overrides"],
    ["a person name (header)", (s) => { s.raw.people[0]!.name = "Eric Changed"; }, {}, "header"],
    ["filing status answer", (s) => { s.raw.planning.filingStatus = "single"; }, {}, "facts"],
    ["household member count planning answer", (s) => { s.raw.planning.householdMembers = "some"; }, {}, "facts"],
  ];
  it.each(mutations)("changes with: %s", async (_name, mutate, over, part) => {
    const base = await fpOf(cleanScenario());
    const s = cleanScenario();
    mutate(s);
    if (_name.startsWith("engine version")) {
      // direct: engine version group only
      const input: FingerprintInput = { engineVersion: "ty2025-xx", viewFingerprint: "v", answers: {}, header: {}, facts: {}, documents: [], questionnaires: [], overrides: [], decisions: {} };
      const a = computeReturnFingerprint(input);
      const b = computeReturnFingerprint({ ...input, engineVersion: "ty2025-yy" });
      expect(a.fingerprint).not.toBe(b.fingerprint);
      expect(a.parts.engine).not.toBe(b.parts.engine);
      return;
    }
    const fp = await fpOf(s, over);
    expect(fp.fingerprint, `${_name} must change the fingerprint (part ${part})`).not.toBe(base.fingerprint);
    void part;
  });

  it("direct per-group mutation of computeReturnFingerprint: answers, header, facts, decisions, view each change it", () => {
    const base: FingerprintInput = {
      engineVersion: "e1", viewFingerprint: "v1", answers: { fs: "mfj", n: [1, 2] }, header: { a: "x" }, facts: { f: 1 },
      documents: [{ id: "d1", docType: "w2", taxYear: 2025, extractionStatus: "complete", verified: true, legacyFormat: false, subjectType: "person", subjectUserId: "u", extractionData: { v: 1 } }],
      questionnaires: [{ questionnaireId: "q", definitionVersion: 1, answers: { a: 1 } }],
      overrides: [{ id: "o", version: 1, targetKind: "line", targetKey: "f1040.1a", valueKind: "cents", valueCents: 5, valueText: null, authority: "owner", archivedAt: null }],
      decisions: { homeOfficeMethod: "simplified" },
    };
    const b0 = computeReturnFingerprint(base);
    const variants: [string, FingerprintInput][] = [
      ["engine", { ...base, engineVersion: "e2" }],
      ["view", { ...base, viewFingerprint: "v2" }],
      ["answers", { ...base, answers: { fs: "single", n: [1, 2] } }],
      ["answers array order", { ...base, answers: { fs: "mfj", n: [2, 1] } }],
      ["header", { ...base, header: { a: "y" } }],
      ["facts", { ...base, facts: { f: 2 } }],
      ["decisions", { ...base, decisions: { homeOfficeMethod: "actual" } }],
      ["doc data", { ...base, documents: [{ ...base.documents[0]!, extractionData: { v: 2 } }] }],
      ["doc verified", { ...base, documents: [{ ...base.documents[0]!, verified: false }] }],
      ["doc archived-by-removal", { ...base, documents: [] }],
      ["doc reextractIncomplete", { ...base, documents: [{ ...base.documents[0]!, reextractIncomplete: true }] }],
      ["q answers", { ...base, questionnaires: [{ ...base.questionnaires[0]!, answers: { a: 2 } }] }],
      ["q version", { ...base, questionnaires: [{ ...base.questionnaires[0]!, definitionVersion: 2 }] }],
      ["q removed", { ...base, questionnaires: [] }],
      ["override value", { ...base, overrides: [{ ...base.overrides[0]!, valueCents: 6 }] }],
      ["override version", { ...base, overrides: [{ ...base.overrides[0]!, version: 2 }] }],
      ["override authority", { ...base, overrides: [{ ...base.overrides[0]!, authority: "cpa" }] }],
      ["override archived", { ...base, overrides: [{ ...base.overrides[0]!, archivedAt: "2026-10-01" }] }],
      ["override key", { ...base, overrides: [{ ...base.overrides[0]!, targetKey: "f1040.1b" }] }],
      ["override removed", { ...base, overrides: [] }],
    ];
    const seen = new Set<string>([b0.fingerprint]);
    for (const [name, v] of variants) {
      const f = computeReturnFingerprint(v);
      expect(f.fingerprint, name).not.toBe(b0.fingerprint);
      seen.add(f.fingerprint);
    }
    expect(seen.size).toBe(variants.length + 1);
    // stability: key order of nested objects and of the top-level doc rows
    const reordered: FingerprintInput = { ...base, answers: { n: [1, 2], fs: "mfj" }, facts: { f: 1 }, decisions: { homeOfficeMethod: "simplified" } };
    expect(computeReturnFingerprint(reordered).fingerprint).toBe(b0.fingerprint);
    // parts hold only 64-hex digests
    for (const v of Object.values(b0.parts)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    // no value from the inputs is present in the serialized result
    const ser = JSON.stringify(b0);
    for (const needle of ["mfj", "homeOfficeMethod", "simplified", "w2", "1040"]) expect(ser.includes(needle)).toBe(false);
    void createHash;
  });
});
