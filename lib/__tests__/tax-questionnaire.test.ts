import { describe, it, expect } from "vitest";
import {
  boundPlanningConflict,
  buildCardState,
  buildSummary,
  centsToDollarString,
  parseDollarInputToCents,
  computeOutcome,
  computeStatus,
  effectiveAnswers,
  enumerateAnswerPaths,
  isNodeVisible,
  parseStoredAnswers,
  questionnaireHref,
  renderCopy,
  resolveBoundWrite,
  resolveQuestionnaireScope,
  statusLabel,
  summarizeQuestionnaires,
  validateAnswerValue,
  validateDefinition,
  visibleNodes,
  type AnswerValue,
  type EffectiveAnswers,
  type PlanningAnswerInput,
  type QNode,
  type QuestionnaireContext,
  type QuestionnaireDef,
  type ScopeEntity,
  type StoredAnswers,
} from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";

const CTX: QuestionnaireContext = { year: 2025, entityName: null, ekcActive: true, svActive: true };
const T = "2026-10-03T14:00:00.000Z";

function def(id: string): QuestionnaireDef {
  const d = questionnaireById(id);
  if (!d) throw new Error(`no questionnaire ${id}`);
  return d;
}

/** Effective answers built directly (source "questionnaire"). */
function eff(values: Record<string, AnswerValue>): EffectiveAnswers {
  const out: EffectiveAnswers = {};
  for (const [id, value] of Object.entries(values)) out[id] = { value, source: "questionnaire", at: T, by: "u1" };
  return out;
}

function stored(values: Record<string, AnswerValue | null>, by: string | null = "u1", at: string = T): StoredAnswers {
  const out: StoredAnswers = {};
  for (const [id, v] of Object.entries(values)) out[id] = { v, at, by };
  return out;
}

const ids = (nodes: QNode[]) => nodes.map((n) => n.id);

describe("branching: Form 8889", () => {
  const d = def("form-8889");

  it("shows only the first question until HSA coverage is answered", () => {
    expect(ids(visibleNodes(d, CTX, {}))).toEqual(["hs1"]);
  });

  it("hs1=neither hides every follow-up", () => {
    expect(ids(visibleNodes(d, CTX, eff({ hs1: "neither" })))).toEqual(["hs1"]);
  });

  it("hs1=eric shows coverage type, contributions, withdrawals and Medicare questions", () => {
    expect(ids(visibleNodes(d, CTX, eff({ hs1: "eric" })))).toEqual(["hs1", "hs2", "hs3", "hs7", "hs9"]);
  });

  it("contribution answers open the right follow-ups", () => {
    const base = { hs1: "both", hs3: "yes" } as const;
    expect(ids(visibleNodes(d, CTX, eff({ ...base })))).toContain("hs4");
    expect(ids(visibleNodes(d, CTX, eff({ ...base, hs4: ["direct"] })))).toContain("hs5");
    expect(ids(visibleNodes(d, CTX, eff({ ...base, hs4: ["direct"] })))).not.toContain("hs6");
    const payroll = ids(visibleNodes(d, CTX, eff({ ...base, hs4: ["payroll"] })));
    expect(payroll).toContain("hs6");
    expect(payroll).not.toContain("hs5");
    const both = ids(visibleNodes(d, CTX, eff({ ...base, hs4: ["payroll", "direct"] })));
    expect(both).toContain("hs5");
    expect(both).toContain("hs6");
    expect(ids(visibleNodes(d, CTX, eff({ hs1: "eric", hs7: "yes" })))).toContain("hs8");
    expect(ids(visibleNodes(d, CTX, eff({ hs1: "eric", hs7: "no" })))).not.toContain("hs8");
  });

  it("a changed upstream answer hides downstream nodes; their stored answers are kept but ignored, and return on flip-back", () => {
    const s = stored({ hs1: "eric", hs3: "yes", hs4: ["direct"], hs5: 500_000, hs7: "no", hs9: "no" });
    const open = effectiveAnswers(d, s, [], CTX);
    expect(computeStatus(d, CTX, open)).toMatchObject({ kind: "in_progress" }); // hs2 still unanswered

    const closed = effectiveAnswers(d, { ...s, hs1: { v: "neither", at: T, by: "u1" } }, [], CTX);
    expect(ids(visibleNodes(d, CTX, closed))).toEqual(["hs1"]);
    const status = computeStatus(d, CTX, closed);
    expect(status).toEqual({ kind: "answered", shown: 1, unsureCount: 0, outcome: "not_applies" });
    // the hidden hs5 answer is still in the effective map (storage kept) ...
    expect(closed["hs5"]?.value).toBe(500_000);
    // ... and counts again once the branch reopens
    const reopened = effectiveAnswers(d, { ...s, hs1: { v: "eric", at: T, by: "u1" } }, [], CTX);
    expect(ids(visibleNodes(d, CTX, reopened))).toContain("hs5");
  });
});

describe("context flags", () => {
  it("hides a node whose entity is not active, and filters options by context", () => {
    const d4562 = def("form-4562");
    expect(ids(visibleNodes(d4562, { ...CTX, ekcActive: false }, {}))).toEqual(["da2"]);
    expect(ids(visibleNodes(d4562, { ...CTX, svActive: false }, {}))).toEqual(["da1"]);

    const qbi = def("qbi-deduction");
    const q1 = qbi.nodes[0]!;
    expect(q1.kind).toBe("multi");
    const ok = validateAnswerValue(q1, ["sv"], CTX);
    expect(ok.ok).toBe(true);
    expect(validateAnswerValue(q1, ["sv"], { ...CTX, svActive: false }).ok).toBe(false);
    expect(validateAnswerValue(q1, ["ekc"], { ...CTX, ekcActive: false }).ok).toBe(false);
  });

  it("an `hidden` condition counts a context-off node as hidden", () => {
    const d4562 = def("form-4562");
    const ctx = { ...CTX, ekcActive: false };
    expect(computeOutcome(d4562, ctx, eff({ da2: "none" }))).toBe("not_applies");
    expect(computeOutcome(d4562, CTX, eff({ da2: "none" }))).toBe("unsure"); // da1 visible but unanswered
  });
});

describe("validateAnswerValue", () => {
  const hs1 = def("form-8889").nodes[0]!;
  const hs4 = def("form-8889").nodes.find((n) => n.id === "hs4")!;
  const hs5 = def("form-8889").nodes.find((n) => n.id === "hs5")!;
  const ho5 = def("form-8829").nodes.find((n) => n.id === "ho5")!;

  it("single: only a known option id", () => {
    expect(validateAnswerValue(hs1, "eric")).toEqual({ ok: true, value: "eric" });
    expect(validateAnswerValue(hs1, "nope").ok).toBe(false);
    expect(validateAnswerValue(hs1, ["eric"]).ok).toBe(false);
    expect(validateAnswerValue(hs1, 3).ok).toBe(false);
  });

  it("multi: de-duplicates, rejects empty / unknown / Not sure combined with others", () => {
    expect(validateAnswerValue(hs4, ["payroll", "payroll", "direct"])).toEqual({ ok: true, value: ["payroll", "direct"] });
    expect(validateAnswerValue(hs4, []).ok).toBe(false);
    expect(validateAnswerValue(hs4, ["bogus"]).ok).toBe(false);
    expect(validateAnswerValue(hs4, ["unsure", "direct"]).ok).toBe(false);
    expect(validateAnswerValue(hs4, ["unsure"])).toEqual({ ok: true, value: ["unsure"] });
    const s34 = def("schedule-3-federal").nodes.find((n) => n.id === "s34")!;
    expect(validateAnswerValue(s34, ["none", "education"]).ok).toBe(false); // exclusive "none"
    expect(validateAnswerValue(s34, ["none"]).ok).toBe(true);
  });

  it("whole numbers: integer in range, or Not sure", () => {
    expect(validateAnswerValue(ho5, 180)).toEqual({ ok: true, value: 180 });
    expect(validateAnswerValue(ho5, 0).ok).toBe(false);
    expect(validateAnswerValue(ho5, 100_000).ok).toBe(false);
    expect(validateAnswerValue(ho5, 1.5).ok).toBe(false);
    expect(validateAnswerValue(ho5, -4).ok).toBe(false);
    expect(validateAnswerValue(ho5, "180").ok).toBe(false);
    expect(validateAnswerValue(ho5, "unsure")).toEqual({ ok: true, value: "unsure" });
  });

  it("dollars: stored as integer cents (cents allowed), in range", () => {
    expect(validateAnswerValue(hs5, 500_000)).toEqual({ ok: true, value: 500_000 });
    expect(validateAnswerValue(hs5, 500_050)).toEqual({ ok: true, value: 500_050 }); // $5,000.50
    expect(validateAnswerValue(hs5, 10_000_000 * 100 + 1).ok).toBe(false);
    expect(validateAnswerValue(hs5, -100).ok).toBe(false);
    expect(validateAnswerValue(hs5, 10_000_000 * 100 + 100).ok).toBe(false);
    expect(validateAnswerValue(hs5, 0)).toEqual({ ok: true, value: 0 });
    expect(validateAnswerValue(hs5, 12.5).ok).toBe(false);
    expect(validateAnswerValue(hs5, "unsure")).toEqual({ ok: true, value: "unsure" });
  });
});

describe("status counting", () => {
  const d = def("form-8889");

  it("not started / in progress (n of m) / answered", () => {
    expect(computeStatus(d, CTX, {})).toEqual({ kind: "not_started" });
    expect(computeStatus(d, CTX, eff({ hs1: "eric" }))).toEqual({ kind: "in_progress", answered: 1, shown: 5 });
    expect(computeStatus(d, CTX, eff({ hs1: "neither" }))).toEqual({ kind: "answered", shown: 1, unsureCount: 0, outcome: "not_applies" });
  });

  it("'Not sure' counts as answered and is tallied", () => {
    const status = computeStatus(d, CTX, eff({ hs1: "unsure" }));
    expect(status).toEqual({ kind: "answered", shown: 1, unsureCount: 1, outcome: "unsure" });
  });

  it("hidden answered nodes do not count", () => {
    expect(computeStatus(d, CTX, eff({ hs1: "neither", hs3: "yes" }))).toEqual({
      kind: "answered",
      shown: 1,
      unsureCount: 0,
      outcome: "not_applies",
    });
  });

  it("labels", () => {
    expect(statusLabel({ kind: "not_started" })).toBe("Not started");
    expect(statusLabel({ kind: "in_progress", answered: 2, shown: 5 })).toBe("In progress (2 of 5 answered)");
    expect(statusLabel({ kind: "answered", shown: 1, unsureCount: 0, outcome: "applies" })).toBe("Answered");
  });

  it("summarizeQuestionnaires buckets add up", () => {
    const counts = summarizeQuestionnaires([
      { status: { kind: "not_started" } },
      { status: { kind: "in_progress", answered: 1, shown: 3 } },
      { status: { kind: "answered", shown: 1, unsureCount: 0, outcome: "applies" } },
      { status: { kind: "answered", shown: 2, unsureCount: 1, outcome: "unsure" } },
    ]);
    expect(counts).toEqual({ total: 4, notStarted: 1, inProgress: 1, answered: 2 });
  });
});

describe("outcome rules (table-driven, first match wins)", () => {
  type Row = [id: string, answers: Record<string, AnswerValue>, expected: "applies" | "not_applies" | "unsure", ctx?: Partial<QuestionnaireContext>];
  const rows: Row[] = [
    ["form-8829", { ho1: "yes_exclusive" }, "applies"],
    ["form-8829", { ho1: "yes_shared" }, "unsure"],
    ["form-8829", { ho1: "no" }, "not_applies"],
    ["form-8829", {}, "unsure"],
    ["form-4562", { da1: "some", da2: "none" }, "applies"],
    ["form-4562", { da1: "none", da2: "none" }, "not_applies"],
    ["form-4562", { da1: "none", da2: "unsure" }, "unsure"],
    ["form-4562", { da2: "none" }, "not_applies", { ekcActive: false }],
    ["form-8582", { pa3: "loss", pa9: "no", pa10: "no" }, "applies"],
    ["form-8582", { pa3: "profit", pa9: "no", pa10: "no" }, "not_applies"],
    ["form-8582", { pa3: "neither", pa9: "no", pa10: "no" }, "not_applies"],
    ["form-8582", { pa3: "profit", pa9: "yes", pa10: "no" }, "applies"],
    ["form-8582", { pa3: "profit", pa9: "unsure", pa10: "no" }, "unsure"],
    ["form-8880", { sv1: "neither" }, "not_applies"],
    ["form-8880", { sv1: "eric", sv4: "no" }, "applies"],
    ["form-8880", { sv1: "both", sv4: "yes" }, "unsure"],
    ["form-8889", { hs1: "neither" }, "not_applies"],
    ["form-8889", { hs1: "eric", hs3: "yes", hs7: "no" }, "applies"],
    ["form-8889", { hs1: "eric", hs3: "no", hs7: "yes" }, "applies"],
    ["form-8889", { hs1: "eric", hs3: "no", hs7: "no" }, "not_applies"],
    ["form-8889", { hs1: "eric", hs3: "no", hs7: "unsure" }, "unsure"],
    // Ordering: "no tax last year" wins over a missed payment.
    ["form-2210", { ut2: "none", ut7: "yes" }, "not_applies"],
    ["form-2210", { ut2: "none", ut7: "no" }, "applies"],
    ["form-2210", { ut2: "regular", ut5: "yes", ut7: "no", ut9: "no" }, "not_applies"],
    ["form-2210", { ut2: "regular", ut5: "no", ut7: "no", ut9: "no" }, "applies"],
    ["form-2210", { ut2: "regular", ut5: "yes", ut7: "no", ut9: "unsure" }, "unsure"],
    ["form-2210", { ut2: "regular", ut5: "yes", ut7: "no", ut9: "yes" }, "applies"],
    ["form-1040-es", { es1: "estimates" }, "applies"],
    ["form-1040-es", { es1: "nothing" }, "applies"],
    ["form-1040-es", { es1: "withholding" }, "not_applies"],
    ["form-1040-es", { es1: "unsure" }, "unsure"],
    ["schedule-3-federal", { s34: ["education"] }, "applies"],
    ["schedule-3-federal", { s31: "no", s33: "no", s34: ["none"] }, "not_applies"],
    ["schedule-3-federal", { s31: "no", s33: "no", s34: ["unsure"] }, "unsure"],
    ["schedule-3-federal", { s31: "no", s33: "no", s34: ["none"], s35: "yes_unclaimed" }, "applies"],
    ["qbi-deduction", { qb1: ["ekc"] }, "applies"],
    ["qbi-deduction", { qb1: ["k1", "other"] }, "applies"],
    ["qbi-deduction", { qb1: ["none"] }, "not_applies"],
    ["qbi-deduction", { qb1: ["unsure"] }, "unsure"],
    ["additional-medicare-tax", { mt1: "eric", mt2: "no", mt3: "no" }, "applies"],
    ["additional-medicare-tax", { mt1: "neither", mt2: "no", mt3: "no" }, "not_applies"],
    ["additional-medicare-tax", { mt1: "neither", mt2: "unsure", mt3: "no" }, "unsure"],
    ["additional-medicare-tax", { mt1: "neither", mt2: "no", mt3: "yes" }, "applies"],
    ["child-dependent-credits", { cd1: "none" }, "not_applies"],
    ["child-dependent-credits", { cd1: "children" }, "applies"],
    ["child-dependent-credits", { cd1: "other" }, "applies"],
    ["child-dependent-credits", { cd1: "unsure" }, "unsure"],
    ["clean-vehicle-credit", { ev1: "no" }, "not_applies"],
    ["clean-vehicle-credit", { ev1: "yes_new", ev2: "before" }, "applies"],
    ["clean-vehicle-credit", { ev1: "yes_used", ev2: "before" }, "applies"],
    ["clean-vehicle-credit", { ev1: "yes_new", ev2: "after" }, "unsure"],
    ["k1-handling", { kh1: "partnership" }, "applies"],
    ["k1-handling", { kh1: "trust" }, "applies"],
    ["k1-handling", { kh1: "unsure" }, "unsure"],
    ["schedule-se", { se1: "profit", se2: "no" }, "applies"],
    ["schedule-se", { se1: "neither", se2: "no" }, "not_applies"],
    ["schedule-se", { se1: "loss", se2: "no" }, "unsure"],
    ["schedule-se", { se1: "neither", se2: "yes" }, "applies"],
    ["entity-federal-return", { ef1: "multiple", ef3: "none" }, "applies", { entityName: "X" }],
    ["entity-federal-return", { ef1: "one", ef3: "none" }, "not_applies", { entityName: "X" }],
    ["entity-federal-return", { ef1: "one", ef3: "corp" }, "applies", { entityName: "X" }],
    ["entity-federal-return", { ef1: "one", ef3: "unsure" }, "unsure", { entityName: "X" }],
    ["entity-ct-filing", { cf1: "partnership" }, "applies", { entityName: "X" }],
    ["entity-ct-filing", { cf1: "household", cf4: "no", cf5: "no" }, "not_applies", { entityName: "X" }],
    ["entity-ct-filing", { cf1: "household", cf4: "yes", cf5: "no" }, "unsure", { entityName: "X" }],
  ];

  it.each(rows.map((r, i) => [i, ...r] as const))("#%i %s", (_i, id, answers, expected, ctxOver) => {
    expect(computeOutcome(def(id), { ...CTX, ...ctxOver }, eff(answers))).toBe(expected);
  });
});

describe("reuse of planning answers (single source of truth)", () => {
  const d8829 = def("form-8829");
  const planningAt = new Date("2026-10-01T15:00:00.000Z");
  const row = (key: string, answer: unknown, skippedReason: string | null = null, answeredAt: Date | null = planningAt): PlanningAnswerInput => ({
    key,
    answer,
    skippedReason,
    answeredAt,
  });

  it("the planning answer wins over a stored local value and maps back to the option id", () => {
    const e = effectiveAnswers(d8829, stored({ ho1: "unsure" }), [row("home_office_ekc", "yes_shared")], CTX);
    expect(e["ho1"]).toMatchObject({ value: "yes_shared", source: "planning" });
  });

  it("a skipped planning answer is unanswered", () => {
    const e = effectiveAnswers(d8829, {}, [row("home_office_ekc", "skipped", "Skipped for now")], CTX);
    expect(e["ho1"]).toBeUndefined();
  });

  it("a null planning answer is unanswered", () => {
    expect(effectiveAnswers(d8829, {}, [row("home_office_ekc", null)], CTX)["ho1"]).toBeUndefined();
  });

  it("a local-only stored value shows while the planning answer is empty, and loses to a later planning answer", () => {
    const local = effectiveAnswers(d8829, stored({ ho1: "unsure" }), [], CTX);
    expect(local["ho1"]).toMatchObject({ value: "unsure", source: "questionnaire", by: "u1" });
    const later = effectiveAnswers(d8829, stored({ ho1: "unsure" }), [row("home_office_ekc", "no")], CTX);
    expect(later["ho1"]).toMatchObject({ value: "no", source: "planning" });
  });

  it("a mirror entry (v: null) alone never invents an answer", () => {
    expect(effectiveAnswers(d8829, stored({ ho1: null }), [], CTX)["ho1"]).toBeUndefined();
  });

  it("household_members: bank value other_dependents maps to option 'other'; unmapped bank values are ignored", () => {
    const d = def("child-dependent-credits");
    expect(effectiveAnswers(d, {}, [row("household_members", "other_dependents")], CTX)["cd1"]?.value).toBe("other");
    expect(effectiveAnswers(d, {}, [row("household_members", "bogus")], CTX)["cd1"]).toBeUndefined();
  });

  it("solar_credit: the bank's own 'unsure' value maps to the Not sure option", () => {
    const d = def("schedule-3-federal");
    expect(effectiveAnswers(d, {}, [row("solar_credit", "unsure")], CTX)["s35"]).toMatchObject({ value: "unsure", source: "planning" });
    expect(effectiveAnswers(d, {}, [row("solar_credit", "claimed_already")], CTX)["s35"]?.value).toBe("claimed");
  });

  it("ev_vehicle: 'yes_used' has no planning value, so it is kept locally", () => {
    const d = def("clean-vehicle-credit");
    const e = effectiveAnswers(d, stored({ ev1: "yes_used" }), [], CTX);
    expect(e["ev1"]).toMatchObject({ value: "yes_used", source: "questionnaire" });
    expect(resolveBoundWrite(d.nodes[0]!, "yes_used")).toEqual({ questionKey: "ev_vehicle", planningValue: null });
    expect(resolveBoundWrite(d.nodes[0]!, "yes_new")).toEqual({ questionKey: "ev_vehicle", planningValue: "yes_new" });
    expect(resolveBoundWrite(d.nodes[0]!, "no")).toEqual({ questionKey: "ev_vehicle", planningValue: "no" });
    expect(resolveBoundWrite(d.nodes[0]!, "unsure")).toEqual({ questionKey: "ev_vehicle", planningValue: null });
  });

  it("number node: parseable planning text is read; free text is unparseable and NOT silently replaced", () => {
    const ho5 = d8829.nodes.find((n) => n.id === "ho5")!;
    const parsed = effectiveAnswers(d8829, {}, [row("home_office_sqft", "180")], CTX);
    expect(parsed["ho5"]).toMatchObject({ value: 180, source: "planning" });

    const prose = [row("home_office_sqft", "about 200 sq ft maybe")];
    expect(effectiveAnswers(d8829, {}, prose, CTX)["ho5"]).toBeUndefined();
    expect(boundPlanningConflict(ho5, prose)).toBe("about 200 sq ft maybe");
    expect(boundPlanningConflict(ho5, [row("home_office_sqft", "180")])).toBeNull();
    expect(boundPlanningConflict(ho5, [row("home_office_sqft", "x", "Skipped")])).toBeNull();
    expect(boundPlanningConflict(ho5, [])).toBeNull();
  });

  it("number writes: whole number string, whole dollars string, Not sure is local-only", () => {
    const ho5 = d8829.nodes.find((n) => n.id === "ho5")!;
    const ut3 = def("form-2210").nodes.find((n) => n.id === "ut3")!;
    expect(resolveBoundWrite(ho5, 180)).toEqual({ questionKey: "home_office_sqft", planningValue: "180" });
    expect(resolveBoundWrite(ut3, 1_200_000)).toEqual({ questionKey: "estimated_tax_payments_amount", planningValue: "12000" });
    expect(resolveBoundWrite(ut3, "unsure")).toEqual({ questionKey: "estimated_tax_payments_amount", planningValue: null });
    expect(resolveBoundWrite(def("form-8889").nodes[0]!, "eric")).toBeNull(); // unbound
  });

  it("dollars read from the planning answer are cents", () => {
    const e = effectiveAnswers(def("form-2210"), {}, [row("estimated_tax_payments_amount", "$12,000")], CTX);
    expect(e["ut3"]).toMatchObject({ value: 1_200_000, source: "planning" });
  });

  it("a Planning dollar answer with cents prefills exactly and re-saves without error (round-trip)", () => {
    const d2210 = def("form-2210");
    const ut3 = d2210.nodes.find((n) => n.id === "ut3")!;
    for (const [stored_, cents, text] of [
      ["12000.50", 1_200_050, "12000.50"],
      ["12000.5", 1_200_050, "12000.50"],
      ["$12,000.05", 1_200_005, "12000.05"],
      ["12000", 1_200_000, "12000"],
    ] as const) {
      const e = effectiveAnswers(d2210, {}, [row("estimated_tax_payments_amount", stored_)], CTX);
      expect(e["ut3"], stored_).toMatchObject({ value: cents, source: "planning" });
      // the prefill string the runner shows
      expect(centsToDollarString(cents)).toBe(text);
      // typing/re-saving that prefill parses to the same cents, validates, and writes the exact string back
      expect(parseDollarInputToCents(text)).toBe(cents);
      expect(validateAnswerValue(ut3, cents)).toEqual({ ok: true, value: cents });
      expect(resolveBoundWrite(ut3, cents)).toEqual({ questionKey: "estimated_tax_payments_amount", planningValue: text });
    }
  });

  it("parseDollarInputToCents: integer math, up to two decimals, rejects junk", () => {
    expect(parseDollarInputToCents("0.05")).toBe(5);
    expect(parseDollarInputToCents("$1,234.5")).toBe(123_450);
    expect(parseDollarInputToCents("12000")).toBe(1_200_000);
    for (const bad of ["", "12.345", "-5", "1e3", "abc", ".5", "12000.", "12345678901"]) {
      expect(parseDollarInputToCents(bad), bad).toBeNull();
    }
    expect(centsToDollarString(5)).toBe("0.05");
    expect(centsToDollarString(0)).toBe("0");
  });

  it("`by` is shown only when the mirror's `at` equals the planning answeredAt exactly", () => {
    const same = effectiveAnswers(d8829, stored({ ho1: null }, "u2", planningAt.toISOString()), [row("home_office_ekc", "no")], CTX);
    expect(same["ho1"]).toMatchObject({ source: "planning", by: "u2", at: planningAt.toISOString() });
    const differs = effectiveAnswers(d8829, stored({ ho1: null }, "u2", "2026-09-01T00:00:00.000Z"), [row("home_office_ekc", "no")], CTX);
    expect(differs["ho1"]).toMatchObject({ source: "planning", by: null });
    const noPlanningDate = effectiveAnswers(d8829, stored({ ho1: null }, "u2", T), [row("home_office_ekc", "no", null, null)], CTX);
    expect(noPlanningDate["ho1"]).toMatchObject({ by: null, at: null });
  });

  it("invalid stored values are dropped (unknown option, out-of-range number)", () => {
    const e = effectiveAnswers(def("form-8889"), stored({ hs1: "martian", hs5: 10_000_000 * 100 + 1 }), [], CTX);
    expect(e["hs1"]).toBeUndefined();
    expect(e["hs5"]).toBeUndefined();
  });
});

describe("summary generation", () => {
  it("Form 8889 path: exact outcome sentence, fact lines, dollar formatting, open questions", () => {
    const d = def("form-8889");
    const e = eff({ hs1: "eric", hs2: "family", hs3: "yes", hs4: ["direct"], hs5: 500_000, hs7: "no", hs9: "no" });
    const s = buildSummary(d, CTX, e, "bring the W-2");
    expect(s.status).toEqual({ kind: "answered", shown: 7, unsureCount: 0, outcome: "applies" });
    expect(s.outcomeText).toBe(
      "Owner reports HSA contributions or withdrawals, so Form 8889 likely applies - the Return completeness answers feed the computed HSA deduction; the CPA decides whether and how to prepare it."
    );
    expect(s.facts.map((f) => [f.nodeId, f.answerLabel])).toEqual([
      ["hs1", "Eric"],
      ["hs2", "Family"],
      ["hs3", "Yes"],
      ["hs4", "We deposited it ourselves, not through payroll"],
      ["hs5", "$5,000.00"],
      ["hs7", "No"],
      ["hs9", "No"],
    ]);
    expect(s.facts[0]!.prompt).toBe(
      "Which of you was covered by a high-deductible health plan (HDHP) that can be paired with a Health Savings Account (HSA) for any part of 2025? (Your insurer or employer can tell you whether the plan is HSA-eligible.)"
    );
    expect(s.facts[4]!.prompt).toBe("About how much did you deposit yourselves into an HSA for 2025 (not through payroll), in whole dollars?");
    expect(s.openQuestions).toEqual([]);
    expect(s.note).toBe("bring the W-2");
    expect(s.planningLinks).toEqual([{ key: "retirement_contributions", label: "Retirement contributions (Planning answer)" }]);
  });

  it("open questions list Not sure and unanswered visible questions only", () => {
    const d = def("form-8889");
    const s = buildSummary(d, CTX, eff({ hs1: "eric", hs3: "unsure", hs7: "no" }), null);
    expect(s.status.kind).toBe("in_progress");
    expect(s.outcomeText).toBeNull();
    expect(s.openQuestions).toEqual([
      "What kind of HDHP coverage was it in 2025 - self-only (covering just one person) or family?",
      "Was money contributed to an HSA for 2025, whether by you, through payroll deduction at work, or by an employer?",
      "For any month of 2025, was either of you enrolled in Medicare or claimed as someone else's dependent?",
    ]);
    expect(s.note).toBeNull();
    expect(s.facts.find((f) => f.nodeId === "hs3")).toMatchObject({ answerLabel: "Not sure - ask the CPA", unsure: true });
  });

  it("entity questionnaire renders the entity name and year placeholders", () => {
    const d = def("entity-federal-return");
    const ctx = { ...CTX, year: 2026, entityName: "Sudden Valley Property Management, LLC" };
    const s = buildSummary(d, ctx, eff({ ef1: "one", ef3: "none", ef4: "no", ef5: "neither", ef6: "during", ef7: "personal" }), "   ");
    expect(s.outcomeText).toBe(
      "Owner reports one owner and no election; the IRS describes that as a disregarded entity - the CPA confirms."
    );
    expect(s.facts[0]).toMatchObject({
      prompt: "How many owners (members) does Sudden Valley Property Management, LLC have?",
      answerLabel: "One",
    });
    expect(s.facts.find((f) => f.nodeId === "ef6")).toMatchObject({ answerLabel: "During 2026" });
    expect(s.note).toBeNull(); // whitespace-only note is dropped
  });

  it("summary text contains no number the owner did not type (no computed tax figure)", () => {
    const d = def("form-2210");
    const e = eff({ ut1: "yes", ut2: "some", ut3: 1_200_000, ut4: 900_000, ut5: "no", ut6: "no", ut7: "no", ut8: "no", ut9: "no" });
    const s = buildSummary(d, CTX, e, null);
    const dollars = JSON.stringify(s).match(/\$[\d,.]+/g) ?? [];
    expect(dollars.sort()).toEqual(["$12,000.00", "$9,000.00"].sort());
  });
});

describe("card state, hrefs and stored-answer parsing", () => {
  it("buildCardState: stale when the saved definition version differs; carries the owner line", () => {
    const d = def("form-8889");
    const row = {
      taxYear: 2025,
      entityId: "e1",
      questionnaireId: "form-8889",
      definitionVersion: 0,
      answers: { hs1: { v: "neither", at: T, by: "u1" } },
      note: null,
    };
    const state = buildCardState(d, "e1", CTX, row, []);
    expect(state.stale).toBe(true);
    expect(state.status).toMatchObject({ kind: "answered", outcome: "not_applies" });
    expect(state.ownerLine).toBe("Owner reports this likely does not apply - confirm with the CPA.");
    expect(state.outcomeText).toBe("Owner reports no HSA-eligible plan, or no contributions or withdrawals.");
    expect(buildCardState(d, "e1", CTX, null, []).status).toEqual({ kind: "not_started" });
    expect(buildCardState(d, "e1", CTX, null, []).stale).toBe(false);
    expect(buildCardState(d, "e1", CTX, { ...row, definitionVersion: 1 }, []).stale).toBe(false);
  });

  it("card title renders year placeholders", () => {
    expect(buildCardState(def("form-1040-es"), "e1", { ...CTX, year: 2025 }, null, []).title).toBe("Estimated tax for 2026");
  });

  it("an unsure outcome shows the unsure owner line", () => {
    const s = buildCardState(def("form-8889"), "e1", CTX, {
      taxYear: 2025, entityId: "e1", questionnaireId: "form-8889", definitionVersion: 1,
      answers: { hs1: { v: "unsure", at: T, by: null } }, note: null,
    }, []);
    expect(s.ownerLine).toBe("Owner is unsure - the CPA decides.");
  });

  it("questionnaireHref scopes entity questionnaires with ?entity=", () => {
    expect(questionnaireHref(2025, { id: "form-8889", scope: "household" }, "p1")).toBe("/tax/forms/2025/questionnaire/form-8889");
    expect(questionnaireHref(2026, { id: "entity-ct-filing", scope: "entity" }, "e 1")).toBe(
      "/tax/forms/2026/questionnaire/entity-ct-filing?entity=e%201"
    );
  });

  it("renderCopy fills year, previous / next year and entity", () => {
    expect(renderCopy("{prevYear} {year} {nextYear} {entity}", { year: 2025, entityName: "Acme" })).toBe("2024 2025 2026 Acme");
    expect(renderCopy("{entity}", { year: 2025, entityName: null })).toBe("the entity");
  });

  it("parseStoredAnswers drops malformed entries", () => {
    expect(parseStoredAnswers(null)).toEqual({});
    expect(parseStoredAnswers([1, 2])).toEqual({});
    expect(
      parseStoredAnswers({
        a: { v: "x", at: T, by: "u" },
        b: { v: { nested: 1 }, at: T },
        c: { v: "x" },
        d: "nope",
        e: { v: null, at: T },
        f: { v: ["a", 2], at: T },
        g: { v: 5, at: T, by: 7 },
      })
    ).toEqual({
      a: { v: "x", at: T, by: "u" },
      e: { v: null, at: T, by: null },
      g: { v: 5, at: T, by: null },
    });
  });

  it("isNodeVisible agrees with visibleNodes", () => {
    const d = def("form-8889");
    expect(isNodeVisible(d, CTX, eff({ hs1: "eric" }), "hs3")).toBe(true);
    expect(isNodeVisible(d, CTX, eff({ hs1: "neither" }), "hs3")).toBe(false);
  });
});

describe("scope resolution", () => {
  const entity = (over: Partial<ScopeEntity>): ScopeEntity => ({
    id: "x", name: "X", slug: null, type: "business", foundedDate: null, taxStatusNotes: null, ...over,
  });
  const personal = entity({ id: "p", name: "Personal", type: "personal", slug: "personal" });
  const ekc = entity({ id: "ekc", name: "EK Consulting", slug: "ek-consulting" });
  const sv = entity({ id: "sv", name: "Sudden Valley", slug: "sudden-valley", foundedDate: new Date("2026-02-01") });
  const mezzo = entity({ id: "mz", name: "Mezzo", slug: "mezzo", taxStatusNotes: "Not yet formed" });
  const all = [personal, ekc, sv, mezzo];

  it("household questionnaires belong to Personal only", () => {
    const d = def("form-8889");
    expect(resolveQuestionnaireScope(d, all, 2025, "p")).toMatchObject({ ok: true });
    expect(resolveQuestionnaireScope(d, all, 2025, "ekc")).toMatchObject({ ok: false });
    expect(resolveQuestionnaireScope(d, all, 2025, "missing")).toMatchObject({ ok: false });
  });

  it("entity questionnaires belong to an active business entity", () => {
    const d = def("entity-ct-filing");
    expect(resolveQuestionnaireScope(d, all, 2025, "p")).toMatchObject({ ok: false });
    expect(resolveQuestionnaireScope(d, all, 2025, "ekc")).toMatchObject({ ok: true, entityName: "EK Consulting" });
    expect(resolveQuestionnaireScope(d, all, 2025, "sv")).toMatchObject({ ok: false }); // formed 2026
    expect(resolveQuestionnaireScope(d, all, 2026, "sv")).toMatchObject({ ok: true });
    expect(resolveQuestionnaireScope(d, all, 2026, "mz")).toMatchObject({ ok: false }); // not yet formed
  });

  it("Sudden Valley-only questionnaires need Sudden Valley active; flags come from the entities", () => {
    expect(resolveQuestionnaireScope(def("form-4562"), all, 2025, "p")).toMatchObject({ ok: false });
    const ok = resolveQuestionnaireScope(def("form-4562"), all, 2026, "p");
    expect(ok).toMatchObject({ ok: true, ctx: { year: 2026, ekcActive: true, svActive: true, entityName: null } });
    expect(resolveQuestionnaireScope(def("form-8582"), all, 2025, "p")).toMatchObject({ ok: false });
  });
});

describe("validateDefinition catches broken data", () => {
  const base = (): QuestionnaireDef => ({
    id: "fixture",
    version: 1,
    title: "Fixture",
    formLabel: "Fixture",
    scope: "household",
    intro: "x",
    sourcesTaxYear: 2025,
    nodes: [
      {
        id: "a",
        kind: "single",
        prompt: "A?",
        showWhen: null,
        options: [
          { id: "y", label: "Yes" },
          { id: "n", label: "No" },
          { id: "unsure", label: "Not sure", unsure: true },
        ],
      },
      {
        id: "b",
        kind: "single",
        prompt: "B?",
        showWhen: { kind: "in", node: "a", values: ["y"] },
        options: [
          { id: "y", label: "Yes" },
          { id: "unsure", label: "Not sure", unsure: true },
        ],
      },
    ],
    outcomeRules: [{ when: { kind: "in", node: "a", values: ["y"] }, outcome: "applies" }],
    outcomeDefault: "unsure",
    outcomeText: { applies: "Owner reports a.", not_applies: "Owner reports b.", unsure: "Owner is unsure." },
  });

  it("the fixture itself is valid", () => {
    expect(validateDefinition(base())).toEqual([]);
  });

  it("flags a dangling node reference", () => {
    const d = base();
    (d.nodes[1] as { showWhen: unknown }).showWhen = { kind: "in", node: "zzz", values: ["y"] };
    expect(validateDefinition(d).join("\n")).toMatch(/unknown node "zzz"/);
  });

  it("flags a reference to a later node", () => {
    const d = base();
    (d.nodes[0] as { showWhen: unknown }).showWhen = { kind: "in", node: "b", values: ["y"] };
    expect(validateDefinition(d).join("\n")).toMatch(/not an earlier node/);
  });

  it("flags an unknown option id in a condition", () => {
    const d = base();
    (d.nodes[1] as { showWhen: unknown }).showWhen = { kind: "in", node: "a", values: ["maybe"] };
    expect(validateDefinition(d).join("\n")).toMatch(/no option "maybe"/);
  });

  it("flags a missing or doubled unsure option", () => {
    const d = base();
    (d.nodes[1] as { options: unknown }).options = [{ id: "y", label: "Yes" }, { id: "n", label: "No" }];
    expect(validateDefinition(d).join("\n")).toMatch(/exactly one "unsure"/);
  });

  it("flags an unreachable node", () => {
    const d = base();
    (d.nodes[1] as { showWhen: unknown }).showWhen = {
      kind: "all",
      of: [
        { kind: "in", node: "a", values: ["y"] },
        { kind: "in", node: "a", values: ["n"] },
      ],
    };
    expect(validateDefinition(d).join("\n")).toMatch(/b: unreachable/);
  });

  it("flags a dollar amount without a source, an unknown source and an empty outcome sentence", () => {
    const d = base();
    (d.nodes[0] as { prompt: string }).prompt = "Is it over $200,000?";
    expect(validateDefinition(d).join("\n")).toMatch(/dollar amount in the copy needs a source/);
    (d.nodes[0] as { sources: string[] }).sources = ["NOPE"];
    expect(validateDefinition(d, new Set(["8889"])).join("\n")).toMatch(/unknown source "NOPE"/);
    (d.outcomeText as { unsure: string }).unsure = " ";
    expect(validateDefinition(d).join("\n")).toMatch(/outcomeText.unsure is empty/);
  });

  it("flags a bad binding (unknown planning key, missing option entry)", () => {
    const d = base();
    (d.nodes[0] as { binding: unknown }).binding = { mode: "shared_choice", questionKey: "nope", bank: {} };
    expect(validateDefinition(d).join("\n")).toMatch(/unknown planning question "nope"/);
    (d.nodes[0] as { binding: unknown }).binding = { mode: "shared_choice", questionKey: "ev_vehicle", bank: { y: "yes_new" } };
    expect(validateDefinition(d).join("\n")).toMatch(/has no binding entry/);
  });

  it("enumerateAnswerPaths stops at the cap and reports truncation", () => {
    const { paths, truncated } = enumerateAnswerPaths(def("form-2210"), CTX, 5);
    expect(paths.length).toBe(5);
    expect(truncated).toBe(true);
  });
});
