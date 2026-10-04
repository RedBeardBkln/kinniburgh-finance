import React, { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Render smoke tests (no DOM, no browser): vitest's esbuild uses the classic JSX runtime for .tsx
// sources, so React is provided as a global for the components under test.
(globalThis as { React?: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/tax-questionnaires", () => ({
  resetQuestionnaire: vi.fn(),
  saveQuestionnaireAnswer: vi.fn(),
  saveQuestionnaireNote: vi.fn(),
}));
vi.mock("@/actions/tax-questionnaire-prefill", () => ({ acceptPrefillSuggestions: vi.fn() }));

import { QuestionnaireRunner, type QuestionnaireRunnerProps } from "@/components/tax/forms/questionnaire-runner";
import { PrefillPanel } from "@/components/tax/forms/prefill-panel";
import { CpaSummaryView } from "@/components/tax/forms/cpa-summary-view";
import { buildSummary, effectiveAnswers, parseStoredAnswers, type AnswerSource, type EffectiveAnswers, type QuestionnaireContext } from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";
import { buildAnswerSource, combineContributions, computePrefillStates, type PrefillSuggestion, type QuestionnairePrefill } from "@/lib/tax-prefill";
import { DOC_A, DOC_B, DOC_EVA, DOC_RET, DOC_RET2, ERIC, EVA, box12, returnDoc, suggestionsFor, w2doc } from "@/lib/__tests__/tax-prefill-fixtures";
import type { CpaSummaryData } from "@/lib/tax-questionnaire-build";

const RC = "return-completeness";
const def = questionnaireById(RC)!;
const CTX: QuestionnaireContext = { year: 2025, entityName: null, ekcActive: true, svActive: false };
const AT = "2026-10-04T16:00:00.000Z";

function docs() {
  return [
    w2doc(DOC_A, ERIC, { employerName: "Alpine Bio", box12: box12(["D", 1_200_000]), retirementPlan: true, employerEIN: "12-3456789" }),
    w2doc(DOC_B, ERIC, { employerName: "NUMU Food Group", box12: box12(["AA", 650_000]), employerEIN: "98-7654321" }),
    w2doc(DOC_EVA, EVA, { employerName: "Fox Farm Brewery", box12: box12(["D", 400_000]) }, { verified: false }),
    returnDoc(DOC_RET, { filingStatus: "mfj" }),
  ];
}

function prefillFor(suggestions: PrefillSuggestion[], effective: EffectiveAnswers): QuestionnairePrefill {
  const states = computePrefillStates(RC, suggestions, effective);
  const waiting = Object.values(states).filter((s) => s.state === "suggested" && s.suggestionKey !== null);
  return { suggestions, states, bulkCount: waiting.filter((s) => s.bulk).length, weakCount: waiting.filter((s) => !s.bulk).length };
}

function runnerHtml(effective: EffectiveAnswers, suggestions: PrefillSuggestion[] | null): string {
  const props: QuestionnaireRunnerProps = {
    year: 2025,
    def,
    entityId: "22222222-2222-4222-8222-222222222222",
    ctx: CTX,
    effective,
    bound: {},
    ...(suggestions ? { prefill: prefillFor(suggestions, effective) } : {}),
    note: null,
    noteMeta: null,
    stale: false,
    userNames: { u1: "Eric" },
    meId: "u1",
    planningLinks: [],
  };
  return renderToStaticMarkup(createElement(QuestionnaireRunner, props));
}

const ans = (value: string | number, src?: AnswerSource): EffectiveAnswers[string] => ({ value, source: "questionnaire", at: AT, by: "u1", ...(src ? { src } : {}) });

describe("QuestionnaireRunner with prefill", () => {
  const suggestions = suggestionsFor(docs());

  it("shows the suggested block, the dashed suggested option, the source chip, the picker button and the bulk banner (strong only)", () => {
    const html = runnerHtml({}, suggestions);
    expect(html).toContain("Suggested from your documents - not saved yet");
    expect(html).toContain("(suggested, not saved)");
    expect(html).toContain("From 2 W-2s (Alpine Bio, NUMU Food Group), box 12 codes AA + D, verified: $18,500.00");
    expect(html).toContain("Use this answer");
    expect(html).toContain("Use a different document");
    expect(html).toContain("Or answer it yourself below");
    // Eric: plan, deferral and the 2024 return are strong -> 3; Eva's unverified deferral (and her W-2 plan "no") need a look
    expect(html).toContain("3 answers can be filled from your documents");
    expect(html).toContain("Accept 3 suggestions");
    expect(html).toMatch(/\d+ more answers? needs? a look/);
    expect(html).toContain("(check this one before using it)");
    // no EIN, SSN-shaped text, raw extraction or window.confirm leaks into the page
    expect(html).not.toMatch(/\b\d{2}-\d{7}\b|\b\d{3}-\d{2}-\d{4}\b/);
    expect(html).not.toContain("extractionData");
    expect(html).not.toContain("confirm(");
  });

  it("mobile sizing: every prefill button is at least 44px tall", () => {
    const html = runnerHtml({}, suggestions);
    for (const label of ["Use this answer", "Use a different document", "Accept 3 suggestions"]) {
      const m = new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`).exec(html);
      expect(m, label).not.toBeNull();
      expect(m![1], label).toMatch(/min-h-11/);
    }
  });

  it("renders exactly as before when there is no prefill (no panel, no banner, no suggested marker)", () => {
    const html = runnerHtml({}, null);
    expect(html).not.toContain("Suggested from your documents");
    expect(html).not.toContain("data-prefill-banner");
    expect(html).not.toContain("(suggested, not saved)");
  });

  it("an accepted answer says where it came from, who accepted it and when, and offers a different document", () => {
    const s = suggestions.find((x) => x.key === `${RC}:w2_plan:eric`)!;
    const src = buildAnswerSource(s, combineContributions(s, s.docIds)!, s.docIds);
    const html = runnerHtml({ plan_eric: ans("yes", src) }, suggestions);
    expect(html).toContain('data-prefill="accepted"');
    expect(html).toContain("Filled from your documents");
    expect(html).toContain("accepted by Eric on");
    expect(html).toContain("Accepted by Eric on");
    expect(html).toContain("Filled from a W-2 (box 13 retirement plan box), verified when accepted");
    expect(html).toContain("marked as answered by you");
  });

  it("an owner answer that differs shows both values and a one-click use-the-document control", () => {
    const html = runnerHtml({ plan_eric: ans("no") }, suggestions);
    expect(html).toContain('data-prefill="differs"');
    expect(html).toContain("You answered differently from your documents");
    expect(html).toContain("Use the document value");
    expect(html).toContain("The questions and answers summary shows both");
  });

  it("a changed source shows the amber notice with Update and Keep my answer", () => {
    const s = suggestions.find((x) => x.key === `${RC}:w2_deferrals:eric`)!;
    const old = { ...buildAnswerSource(s, combineContributions(s, s.docIds)!, s.docIds), docValue: 1_000_000 };
    const html = runnerHtml({ def_eric: ans("some", old), defamt_eric: ans(1_000_000, old) }, suggestions);
    expect(html).toContain('data-prefill="stale"');
    expect(html).toContain("Changed since you accepted this answer");
    expect(html).toContain("The document now reads differently from when you accepted it.");
    expect(html).toContain("Value when you accepted it: $10,000.00");
    expect(html).toContain("Update to Yes, $18,500.00");
    expect(html).toContain("Keep my answer");
  });

  it("an accepted answer whose source disappeared is flagged (doc_gone) with only Keep my answer", () => {
    const s = suggestions.find((x) => x.key === `${RC}:w2_plan:eric`)!;
    const src = buildAnswerSource(s, combineContributions(s, s.docIds)!, s.docIds);
    const html = runnerHtml({ plan_eric: ans("yes", src) }, suggestions.filter((x) => x.key !== s.key));
    expect(html).toContain('data-stale="doc_gone"');
    expect(html).toContain("Keep my answer");
    expect(html).not.toContain("Update to");
  });

  it("several 2024 returns: the owner is asked to choose, nothing is defaulted", () => {
    const two = suggestionsFor([returnDoc(DOC_RET, { filingStatus: "mfj" }), returnDoc(DOC_RET2, { filingStatus: "single" })]);
    const html = runnerHtml({}, two);
    expect(html).toContain("More than one document could be the source");
    expect(html).toContain("Choose the document");
    expect(html).not.toContain("Use this answer");
    expect(html).not.toContain("Accept 1 suggestion");
  });
});

describe("PrefillPanel picker", () => {
  const s = suggestionsFor([
    w2doc(DOC_A, ERIC, { employerName: "Alpine Bio", box12: box12(["D", 1_200_000]) }),
    w2doc(DOC_B, ERIC, { employerName: "NUMU Food Group", box12: box12(["AA", 650_000]) }, { verified: false }),
    w2doc("bbbbbbbb-0000-4000-8000-000000000099", null, { employerName: "Loose Co" }),
  ]).find((x) => x.key === `${RC}:w2_deferrals:eric`)!;

  it("lists each candidate W-2 with a checkbox, its contribution and verified state, and the documents that are not counted with a review link", () => {
    const html = renderToStaticMarkup(
      createElement(PrefillPanel, {
        suggestion: s,
        state: { nodeId: "def_eric", suggestionKey: s.key, state: "suggested", staleReason: null, bulk: false, acceptedDocValue: null },
        savedText: null,
        answerText: (a) => a.map((x) => String(x.value)).join(", "),
        acceptedChip: null,
        acceptedLine: null,
        acceptedDocIds: [],
        busy: false,
        onAccept: () => undefined,
        onKeepMine: () => undefined,
        initialOpen: true,
      })
    );
    expect(html).toContain("Which documents should be counted?");
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(html).toContain("box 12 D $12,000.00");
    expect(html).toContain("box 12 AA $6,500.00");
    expect(html).toContain("unverified AI read");
    expect(html).toContain("Not counted");
    expect(html).toContain("Not assigned to a person yet");
    expect(html).toContain("/documents/bbbbbbbb-0000-4000-8000-000000000099/review");
    expect(html).toContain("With these documents:");
    expect(html).toContain("Use this selection");
  });
});

describe("CPA summary", () => {
  it("shows 'Accepted by ... - Filled from a W-2 ...' for an answer with a source, and 'Answered by' otherwise", () => {
    const SRC: AnswerSource = { kind: "document", field: "w2.box12.deferrals", docIds: [DOC_A], basis: "doc_verified", docValue: 1_200_000 };
    const stored = parseStoredAnswers({
      def_eric: { v: "some", at: AT, by: "u1", src: SRC },
      plan_eva: { v: "yes", at: AT, by: "u1" },
    });
    const summary = buildSummary(def, CTX, effectiveAnswers(def, stored, [], CTX), null);
    const data: CpaSummaryData = {
      year: 2025,
      householdLabel: "Kinniburgh",
      counts: { total: 1, notStarted: 0, inProgress: 1, answered: 0 },
      household: [
        { key: "k", title: "Return completeness", formName: "Form 1040", entityId: "e", entityName: null, href: "/x", stale: false, summary, noteMeta: null, planningLinks: [] },
      ],
      entities: [],
      userNames: { u1: "Eric" },
    };
    const html = renderToStaticMarkup(createElement(CpaSummaryView, { data }));
    expect(html).toMatch(/Accepted by Eric on [^<]*- Filled from a W-2 \(box 12 deferral codes\), verified when accepted/);
    expect(html).toMatch(/Answered by Eric on/);
  });
});
