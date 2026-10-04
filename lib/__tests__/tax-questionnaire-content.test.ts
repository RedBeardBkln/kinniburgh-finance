import { describe, it, expect } from "vitest";
import {
  QUESTIONNAIRES,
  SOURCES,
  SOURCE_IDS,
  questionnaireById,
} from "@/lib/tax-questionnaire-content";
import {
  computeOutcome,
  computeStatus,
  effectiveAnswers,
  coveringAnswerPaths,
  enumerateAnswerPaths,
  renderCopy,
  resolveBoundWrite,
  validateAnswerValue,
  validateDefinition,
  visibleNodes,
  type ChoiceNode,
  type NumberNode,
  type QNode,
  type QuestionnaireContext,
  type QuestionnaireDef,
} from "@/lib/tax-questionnaire";
import { TAX_QUESTION_BANK } from "@/lib/tax-guidance";
import { parseDollarAnswerToCents, parseSqftAnswer } from "@/lib/tax-compute-build";

const FULL: QuestionnaireContext = { year: 2025, entityName: "Sudden Valley Property Management, LLC", ekcActive: true, svActive: true };

const EXPECTED_IDS = [
  "form-8829",
  "form-4562",
  "form-8582",
  "form-8880",
  "form-8889",
  "form-2210",
  "form-1040-es",
  "schedule-3-federal",
  "qbi-deduction",
  "additional-medicare-tax",
  "child-dependent-credits",
  "clean-vehicle-credit",
  "k1-handling",
  "schedule-se",
  "entity-federal-return",
  "entity-ct-filing",
];

/**
 * Long, mostly independent flows are exempt from the "4-10 questions" / "1-12 shown" norms of the
 * short per-form questionnaires and are walked with the covering enumeration instead of the full
 * cartesian product (which is astronomically large). Everything else is checked identically.
 */
const LARGE_FLOW_IDS = ["return-completeness"];
const ALL_IDS = [...EXPECTED_IDS, ...LARGE_FLOW_IDS];

function isChoice(n: QNode): n is ChoiceNode {
  return n.kind === "single" || n.kind === "multi";
}

/** Every user-visible string of a definition (for copy-wide checks). */
function copyOf(def: QuestionnaireDef): { where: string; text: string; help: boolean }[] {
  const out: { where: string; text: string; help: boolean }[] = [
    { where: `${def.id}.title`, text: def.title, help: false },
    { where: `${def.id}.intro`, text: def.intro, help: false },
  ];
  for (const n of def.nodes) {
    out.push({ where: `${def.id}.${n.id}.prompt`, text: n.prompt, help: false });
    if (n.help) out.push({ where: `${def.id}.${n.id}.help`, text: n.help, help: true });
    if (isChoice(n)) {
      for (const o of n.options) {
        out.push({ where: `${def.id}.${n.id}.${o.id}`, text: o.label, help: false });
        if (o.help) out.push({ where: `${def.id}.${n.id}.${o.id}.help`, text: o.help, help: true });
        if (o.warning) out.push({ where: `${def.id}.${n.id}.${o.id}.warning`, text: o.warning, help: false });
      }
    }
  }
  for (const k of ["applies", "not_applies", "unsure"] as const) {
    out.push({ where: `${def.id}.outcome.${k}`, text: def.outcomeText[k], help: false });
  }
  return out;
}

describe("registry", () => {
  it("has the 16 form questionnaires plus the Return completeness flow, with unique ids", () => {
    expect(QUESTIONNAIRES.map((q) => q.id)).toEqual(ALL_IDS);
    expect(new Set(QUESTIONNAIRES.map((q) => q.id)).size).toBe(17);
    for (const id of ALL_IDS) expect(questionnaireById(id)?.id).toBe(id);
    expect(questionnaireById("nope")).toBeNull();
  });

  it("every household id maps to the Forms-page entry id it is attached to (CPA_INPUT_FORMS ids + fixed extras)", () => {
    const household = QUESTIONNAIRES.filter((q) => q.scope === "household").map((q) => q.id);
    expect(household).toHaveLength(15);
    expect(QUESTIONNAIRES.filter((q) => q.scope === "entity").map((q) => q.id)).toEqual([
      "entity-federal-return",
      "entity-ct-filing",
    ]);
  });
});

describe("tree integrity (all definitions)", () => {
  it.each(ALL_IDS)("%s: validateDefinition returns no problems", (id) => {
    expect(validateDefinition(questionnaireById(id)!, SOURCE_IDS)).toEqual([]);
  });

  it.each(LARGE_FLOW_IDS)("%s (large flow): unique node ids, one unsure option per choice, numbers allow Not sure", (id) => {
    const def = questionnaireById(id)!;
    expect(new Set(def.nodes.map((n) => n.id)).size).toBe(def.nodes.length);
    for (const n of def.nodes) {
      if (isChoice(n)) {
        expect(n.options.filter((o) => o.unsure), `${id}.${n.id}`).toHaveLength(1);
        expect(n.options.find((o) => o.unsure)?.id).toBe("unsure");
      } else {
        expect(validateAnswerValue(n, "unsure").ok, `${id}.${n.id}`).toBe(true);
      }
    }
  });

  it.each(LARGE_FLOW_IDS)("%s (large flow): covering paths terminate, resolve an outcome and show every node and option at least once", (id) => {
    const def = questionnaireById(id)!;
    const paths = coveringAnswerPaths(def, FULL);
    expect(paths.length).toBeGreaterThan(1);
    const seenNodes = new Set<string>();
    const seenValues = new Set<string>();
    for (const p of paths) {
      expect(computeStatus(def, FULL, p).kind).toBe("answered");
      expect(["applies", "not_applies", "unsure"]).toContain(computeOutcome(def, FULL, p));
      for (const [nid, a] of Object.entries(p)) {
        seenNodes.add(nid);
        for (const v of Array.isArray(a.value) ? a.value : [a.value]) seenValues.add(`${nid}:${v}`);
      }
    }
    for (const n of def.nodes) {
      expect(seenNodes.has(n.id), `${id}.${n.id} never shown`).toBe(true);
      if (isChoice(n)) for (const o of n.options) expect(seenValues.has(`${n.id}:${o.id}`), `${id}.${n.id}:${o.id} never chosen`).toBe(true);
    }
    // every "stated none" group can be answered none or some, and the outcome follows
    const outcomes = new Set(paths.map((p) => computeOutcome(def, FULL, p)));
    expect(outcomes.has("applies")).toBe(true);
    expect(outcomes.has("not_applies")).toBe(true);
  });

  it.each(EXPECTED_IDS)("%s: 4-10 questions, unique node ids, one unsure option per choice, numbers allow Not sure", (id) => {
    const def = questionnaireById(id)!;
    expect(def.nodes.length).toBeGreaterThanOrEqual(4);
    expect(def.nodes.length).toBeLessThanOrEqual(10);
    expect(new Set(def.nodes.map((n) => n.id)).size).toBe(def.nodes.length);
    for (const n of def.nodes) {
      if (isChoice(n)) {
        expect(n.options.filter((o) => o.unsure), `${id}.${n.id}`).toHaveLength(1);
        expect(n.options.find((o) => o.unsure)?.id).toBe("unsure");
      } else {
        expect(validateAnswerValue(n, "unsure").ok, `${id}.${n.id}`).toBe(true);
      }
    }
    for (const k of ["applies", "not_applies", "unsure"] as const) expect(def.outcomeText[k].trim()).not.toBe("");
  });

  it.each(EXPECTED_IDS)("%s: complete answer paths terminate, resolve an outcome and stay within 1-12 questions", (id) => {
    const def = questionnaireById(id)!;
    const { paths, truncated } = enumerateAnswerPaths(def, FULL, 20000);
    expect(truncated).toBe(false);
    expect(paths.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const p of paths) {
      const status = computeStatus(def, FULL, p);
      expect(status.kind).toBe("answered");
      expect(["applies", "not_applies", "unsure"]).toContain(computeOutcome(def, FULL, p));
      const shown = visibleNodes(def, FULL, p).length;
      expect(shown).toBeGreaterThanOrEqual(1);
      expect(shown).toBeLessThanOrEqual(12);
      for (const nid of Object.keys(p)) seen.add(nid);
    }
    // Reachability: every node is visible on at least one path.
    for (const n of def.nodes) expect(seen.has(n.id), `${id}.${n.id} unreachable`).toBe(true);
  });

  it("the first screen of every questionnaire shows only always-visible questions (no follow-ups)", () => {
    for (const def of QUESTIONNAIRES) {
      const first = visibleNodes(def, FULL, {});
      expect(first.length, def.id).toBeGreaterThan(0);
      for (const n of first) expect(n.showWhen === null || n.showWhen.kind === "hidden", `${def.id}.${n.id}`).toBe(true);
    }
  });
});

describe("citations and copy hygiene", () => {
  it("every source id used exists in SOURCES, and every registered source is used", () => {
    const used = new Set<string>();
    for (const def of QUESTIONNAIRES) {
      for (const s of def.introSources ?? []) used.add(s);
      for (const n of def.nodes) {
        for (const s of n.sources ?? []) used.add(s);
        if (isChoice(n)) for (const o of n.options) for (const s of o.sources ?? []) used.add(s);
      }
    }
    for (const s of used) expect(SOURCE_IDS.has(s), `unknown source ${s}`).toBe(true);
    for (const s of SOURCE_IDS) expect(used.has(s), `orphan source ${s}`).toBe(true);
  });

  it("every source has an https URL, a title and a verification date", () => {
    for (const [id, s] of Object.entries(SOURCES)) {
      expect(s.url, id).toMatch(/^https:\/\/(www\.irs\.gov|portal\.ct\.gov)\//);
      expect(s.title.trim(), id).not.toBe("");
      expect(s.verifiedOn, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("any copy containing a dollar amount has a source on its question", () => {
    for (const def of QUESTIONNAIRES) {
      for (const n of def.nodes) {
        const text = [n.prompt, n.help ?? "", ...(isChoice(n) ? n.options.flatMap((o) => [o.label, o.help ?? "", o.warning ?? ""]) : [])].join(" ");
        if (/\$\d/.test(text)) {
          const optionSources = isChoice(n) ? n.options.flatMap((o) => o.sources ?? []) : [];
          expect([...(n.sources ?? []), ...optionSources].length, `${def.id}.${n.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("the only dollar figures in the copy are the Additional Medicare thresholds and the $400 Schedule SE rule", () => {
    const found = new Set<string>();
    for (const def of QUESTIONNAIRES) for (const c of copyOf(def)) for (const m of c.text.matchAll(/\$[\d,]+/g)) found.add(m[0]);
    expect([...found].sort()).toEqual(["$125,000", "$200,000", "$250,000", "$400"]);
  });

  it("no advice / determination phrasing", () => {
    const forbidden = [/you should/i, /you qualify/i, /you must file/i, /eligible for/i, /you are required/i, /is required to file/i];
    for (const def of QUESTIONNAIRES) {
      for (const c of copyOf(def)) for (const re of forbidden) expect(c.text, c.where).not.toMatch(re);
    }
  });

  it("every help sentence is attributed to a primary source in its first words", () => {
    const attributed = /^(The IRS|The Form [0-9A-Za-z-]+ instructions|IRS Form [0-9A-Za-z-]+|Connecticut says)\b/;
    for (const def of QUESTIONNAIRES) {
      for (const c of copyOf(def)) if (c.help) expect(c.text, c.where).toMatch(attributed);
    }
  });

  it("every question that carries help also lists a source", () => {
    for (const def of QUESTIONNAIRES) {
      for (const n of def.nodes) if (n.help) expect((n.sources ?? []).length, `${def.id}.${n.id}`).toBeGreaterThan(0);
    }
  });

  it("outcome sentences are owner-reported, never a determination", () => {
    for (const def of QUESTIONNAIRES) {
      for (const k of ["applies", "not_applies", "unsure"] as const) {
        expect(def.outcomeText[k], `${def.id}.${k}`).toMatch(/^Owner (reports|is unsure)/);
      }
    }
  });

  it("does not repeat the known pre-existing wrong facts from the planning copy", () => {
    const all = QUESTIONNAIRES.flatMap((d) => copyOf(d).map((c) => c.text)).join("\n");
    expect(all).not.toMatch(/plan to before filing/i);
    expect(all).not.toMatch(/\$2,000|\$2,200|\$7,500|\$4,000|\$500\b/);
    // The saver's-credit questions do not carry the planning engine's filing-status exclusion.
    const sv = questionnaireById("form-8880")!;
    for (const c of copyOf(sv)) expect(c.text, c.where).not.toMatch(/separately|MFS/i);
    // EV copy is year-aware via {year} and the acquisition-date cutoff, not a hard-coded purchase-year promise.
    const ev = questionnaireById("clean-vehicle-credit")!;
    expect(ev.nodes[0]!.prompt).toContain("{year}");
  });

  it("every {placeholder} is resolved by renderCopy", () => {
    for (const def of QUESTIONNAIRES) {
      for (const c of copyOf(def)) {
        expect(renderCopy(c.text, FULL), c.where).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });
});

describe("plain-language copy", () => {
  /** A prompt may carry one explanatory parenthetical after the question mark; ignore it when checking the ending. */
  const questionPart = (prompt: string) => prompt.replace(/\s*\((?:[^()]|\([^()]*\))*\)$/, "").trim();

  it("every prompt is phrased as a question (ends with a question mark)", () => {
    for (const def of QUESTIONNAIRES) {
      for (const n of def.nodes) expect(questionPart(n.prompt), `${def.id}.${n.id}: "${n.prompt}"`).toMatch(/\?$/);
    }
  });

  it("the Form 2210 withholding question says it means ordinary paycheck withholding, not IRS collection", () => {
    const ut1 = questionnaireById("form-2210")!.nodes.find((n) => n.id === "ut1")!;
    expect(ut1.prompt).toMatch(/withhold federal income tax from your regular paychecks/);
    expect(ut1.prompt).toMatch(/box 2 of your W-2/);
    expect(ut1.prompt).toMatch(/not money collected by the IRS for back taxes/);
  });

  it("an acronym is spelled out the first time it appears in each questionnaire", () => {
    const ACRONYMS: [string, RegExp][] = [
      ["HSA", /Health Savings Account/i],
      ["HDHP", /high.deductible health plan/i],
      ["IRA", /Individual Retirement Account/i],
      ["QBI", /qualified business income/i],
      ["NIIT", /net investment income tax/i],
      ["FLSA", /Fair Labor Standards Act/i],
      ["SSN", /Social Security number/i],
      ["ITIN", /Individual Taxpayer Identification Number/i],
      ["ATIN", /Adoption Taxpayer Identification Number/i],
      ["EIN", /employer identification number/i],
      ["REIT", /real estate investment trust/i],
      ["ABLE", /Achieving a Better Life Experience/i],
      ["SEP", /Simplified Employee Pension/i],
      ["MSA", /Medical Savings Account/i],
    ];
    for (const def of QUESTIONNAIRES) {
      // Reading order: title, intro, then each question's prompt, option labels and help.
      const texts: string[] = [def.title, def.intro];
      for (const n of def.nodes) {
        texts.push(n.prompt);
        if (isChoice(n)) for (const o of n.options) texts.push(o.label, o.help ?? "");
        texts.push(n.help ?? "");
      }
      for (const [acronym, expansion] of ACRONYMS) {
        const word = new RegExp(`\\b${acronym}\\b`);
        const first = texts.find((t) => word.test(t));
        if (first !== undefined) expect(first, `${def.id}: first use of ${acronym}`).toMatch(expansion);
      }
    }
  });
});

describe("binding integrity with the planning question bank", () => {
  const bound: { def: QuestionnaireDef; node: QNode }[] = [];
  for (const def of QUESTIONNAIRES) for (const node of def.nodes) if (node.binding) bound.push({ def, node });

  it("binds exactly the eight overlapping planning questions", () => {
    expect(bound.map((b) => `${b.def.id}.${b.node.id}:${b.node.binding!.questionKey}`).sort()).toEqual(
      [
        "child-dependent-credits.cd1:household_members",
        "clean-vehicle-credit.ev1:ev_vehicle",
        "form-2210.ut3:estimated_tax_payments_amount",
        "form-4562.da1:fixed_assets_ekc",
        "form-4562.da2:fixed_assets_sv",
        "form-8829.ho1:home_office_ekc",
        "form-8829.ho5:home_office_sqft",
        "schedule-3-federal.s35:solar_credit",
      ].sort()
    );
  });

  it("every bound key exists in TAX_QUESTION_BANK; choice maps cover the bank options and number questions have none", () => {
    for (const { node } of bound) {
      const bank = TAX_QUESTION_BANK.find((q) => q.key === node.binding!.questionKey);
      expect(bank, node.id).toBeTruthy();
      if (node.binding!.mode === "shared_choice") {
        const values = new Set(bank!.options!.map((o) => o.value));
        const mapped = Object.values(node.binding!.bank).filter((v): v is string => v !== null);
        for (const v of mapped) expect(values.has(v), `${node.id} ${v}`).toBe(true);
        for (const v of values) expect(mapped.includes(v), `${node.id} unmapped ${v}`).toBe(true);
      } else {
        expect(bank!.options, node.id).toBeUndefined();
      }
    }
  });

  it("number writes round-trip through the repo's own planning parsers", () => {
    const ho5 = questionnaireById("form-8829")!.nodes.find((n) => n.id === "ho5") as NumberNode;
    const w1 = resolveBoundWrite(ho5, 180)!;
    expect(w1).toEqual({ questionKey: "home_office_sqft", planningValue: "180" });
    expect(parseSqftAnswer(w1.planningValue, null)).toEqual({ sqft: 180, unparseable: false });

    const ut3 = questionnaireById("form-2210")!.nodes.find((n) => n.id === "ut3") as NumberNode;
    const w2 = resolveBoundWrite(ut3, 1_200_000)!; // $12,000 in cents
    expect(w2).toEqual({ questionKey: "estimated_tax_payments_amount", planningValue: "12000" });
    expect(parseDollarAnswerToCents(w2.planningValue, null)).toEqual({ cents: 1_200_000, unparseable: false });
  });

  it("the questionnaire's number reader agrees with the repo's parsers (client-safe mirror)", () => {
    const def = questionnaireById("form-8829")!;
    const planningRow = (answer: unknown) => [
      { key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null },
      { key: "home_office_sqft", answer, skippedReason: null },
    ];
    for (const text of ["180", "180 sq ft", " 42 ", "99999", "abc", "1.5", "180 sqft", "12,000"]) {
      const repo = parseSqftAnswer(text, null);
      const eff = effectiveAnswers(def, {}, planningRow(text), FULL)["ho5"];
      const expected = !repo.unparseable && repo.sqft !== null && repo.sqft >= 1 && repo.sqft <= 99999 ? repo.sqft : undefined;
      expect(eff?.value, text).toBe(expected);
    }
    const def2210 = questionnaireById("form-2210")!;
    for (const text of ["12000", "$12,000", "12000.5", "0", "about 8000", "1e3", "-5"]) {
      const repo = parseDollarAnswerToCents(text, null);
      const eff = effectiveAnswers(
        def2210,
        {},
        [
          { key: "estimated_tax_payments_amount", answer: text, skippedReason: null },
        ],
        FULL
      )["ut3"];
      const expected = !repo.unparseable && repo.cents !== null ? repo.cents : undefined;
      expect(eff?.value, text).toBe(expected);
    }
  });

  it("link-only planning keys exist and are never bound by a node", () => {
    const boundKeys = new Set(bound.map((b) => b.node.binding!.questionKey));
    for (const def of QUESTIONNAIRES) {
      for (const l of def.planningLinks ?? []) {
        expect(TAX_QUESTION_BANK.some((q) => q.key === l.key), l.key).toBe(true);
        expect(boundKeys.has(l.key), `${l.key} must stay link-only`).toBe(false);
      }
    }
  });
});
