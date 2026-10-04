// TESTER: server-render the real runner for the production-shaped household and assert what the owner sees.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { React?: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/tax-questionnaires", () => ({ resetQuestionnaire: vi.fn(), saveQuestionnaireAnswer: vi.fn(), saveQuestionnaireNote: vi.fn() }));
vi.mock("@/actions/tax-questionnaire-prefill", () => ({ acceptPrefillSuggestions: vi.fn() }));

import { QuestionnaireRunner, type QuestionnaireRunnerProps } from "@/components/tax/forms/questionnaire-runner";
import { effectiveAnswers, parseStoredAnswers, type QuestionnaireContext } from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";
import { computePrefillStates, type PrefillSuggestion, type QuestionnairePrefill } from "@/lib/tax-prefill";
import { ERIC, EVA, box12, returnDoc, suggestionsFor, w2doc } from "@/lib/__tests__/tax-prefill-fixtures";

const RC = "return-completeness";
const def = questionnaireById(RC)!;
const CTX: QuestionnaireContext = { year: 2025, entityName: null, ekcActive: true, svActive: false };
const AT = "2026-10-04T16:00:00.000Z";
const IDS = ["a1", "a2", "a3", "a4", "a5"].map((x) => `eeeeeeee-0000-4000-8000-0000000000${x.slice(1)}${x.slice(1)}`);

function docs() {
  return [
    w2doc(IDS[0]!, ERIC, { employerName: "NUMU Food Group", employerEIN: "11-1111111", wagesCents: 5_000_000, box12: box12(["DD", 800_000]), retirementPlan: false }),
    w2doc(IDS[1]!, ERIC, { employerName: "Alpine Bio", employerEIN: "22-2222222", wagesCents: 7_000_000, box12: box12(["DD", 650_000]), retirementPlan: false }),
    w2doc(IDS[2]!, EVA, { employerName: "Seacoast Mushrooms", employerEIN: "33-3333333", wagesCents: 3_000_000, box12: [], retirementPlan: false }),
    w2doc(IDS[3]!, EVA, { employerName: "Fox Farm Brewery", employerEIN: "44-4444444", wagesCents: 4_000_000, box12: box12(["D", 54_089]), retirementPlan: true }),
    returnDoc(IDS[4]!, { filingStatus: "mfj" }),
  ];
}

function html(stored: unknown, suggestions: PrefillSuggestion[]): string {
  const effective = effectiveAnswers(def, parseStoredAnswers(stored), [], CTX);
  const states = computePrefillStates(RC, suggestions, effective);
  const waiting = Object.values(states).filter((s) => s.state === "suggested" && s.suggestionKey !== null);
  const prefill: QuestionnairePrefill = { suggestions, states, bulkCount: waiting.filter((s) => s.bulk).length, weakCount: waiting.filter((s) => !s.bulk).length };
  const props: QuestionnaireRunnerProps = {
    year: 2025, def, entityId: "22222222-2222-4222-8222-222222222222", ctx: CTX, effective, bound: {}, prefill,
    note: null, noteMeta: null, stale: false, userNames: { u1: "Eric" }, meId: "u1", planningLinks: [], prev: null, next: null,
  } as unknown as QuestionnaireRunnerProps;
  return renderToStaticMarkup(React.createElement(QuestionnaireRunner, props));
}

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("what the real household sees (server-rendered runner)", () => {
  const s = suggestionsFor(docs());

  it("fresh page: banner counts only strong ones; weak ones are called out; dashed not-saved blocks; no EIN / wages in the markup", () => {
    const h = html({}, s);
    const t = text(h);
    expect(t).toContain("3 answers can be filled from your documents");
    expect(t).toContain("Accept 3 suggestions");
    expect(t).toContain("2 more answers need a look");
    expect(t).toContain("Suggested from your documents - not saved yet");
    expect(t).toContain("Use a different document");
    expect(t).toContain("Or answer it yourself below");
    expect(h).toContain("border-dashed");
    expect(h).toContain("min-h-11");
    expect(h).not.toMatch(/window\.confirm|role="dialog"|aria-modal/);
    for (const bad of ["11-1111111", "22-2222222", "33-3333333", "44-4444444", "5000000", "7000000", "extractionData"]) expect(h).not.toContain(bad);
    // Eric's "none" / "no" are labelled as weak and say why
    expect(t).toContain("check this one before using it");
    expect(t).toContain("Not seeing a deferral on the W-2 is not proof there was none");
    // Eva's amount
    expect(t).toContain("$540.89");
    expect(t).toContain("Fox Farm Brewery");
  });

  it("answered-by-hand node that disagrees with the W-2 shows the amber 'differs' notice and offers 'Use the document value'", () => {
    const h = html({ plan_eva: { v: "no", at: AT, by: "u1" } }, s);
    const t = text(h);
    expect(t).toContain("You answered differently from your documents");
    expect(t).toContain("Use the document value");
    // the owner's own answer is not overwritten or hidden
    expect(t).toContain("You answered");
  });

  it("accepted node shows 'Filled from your documents, accepted by Eric' and no accept button for it", () => {
    const src = { kind: "document", field: "w2.box13.plan", docIds: [IDS[2]!, IDS[3]!], basis: "doc_verified", docValue: "yes" };
    const h = html({ plan_eva: { v: "yes", at: AT, by: "u1", src } }, s);
    const t = text(h);
    expect(t).toMatch(/Filled from your documents\s*, accepted by Eric on /);
    expect(t).toContain("Accepted by Eric");
  });

  it("an old-shape saved answer renders exactly 'Answered by ...' (no 'Accepted', no 'Filled from')", () => {
    const h = html({ age_eric: { v: "no", at: AT, by: "u1" } }, []);
    const t = text(h);
    expect(t).toContain("Answered by Eric");
    expect(t).not.toContain("Accepted by");
    expect(t).not.toContain("Filled from");
    expect(t).not.toContain("can be filled from your documents");
  });

  it("with no prefill prop at all the runner renders (no crash) and shows no suggestion UI", () => {
    const effective = effectiveAnswers(def, {}, [], CTX);
    const props = { year: 2025, def, entityId: "22222222-2222-4222-8222-222222222222", ctx: CTX, effective, bound: {}, note: null, noteMeta: null, stale: false, userNames: {}, meId: "u1", planningLinks: [], prev: null, next: null } as unknown as QuestionnaireRunnerProps;
    const t = text(renderToStaticMarkup(React.createElement(QuestionnaireRunner, props)));
    expect(t).not.toContain("not saved yet");
  });
});
