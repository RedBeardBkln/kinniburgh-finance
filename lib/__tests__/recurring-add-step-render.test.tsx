import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The client leaf imports the server actions; static markup never calls them.
vi.mock("@/actions/recurring-suggestions", () => ({
  addSuggestedRecurringExpense: vi.fn(),
  dismissSuggestion: vi.fn(),
  restoreSuggestion: vi.fn(),
}));

import { ADD_TAG_HELP, AddStep, SuggestionActions } from "@/components/upcoming/suggestion-actions";
import { RecurringSuggestions } from "@/components/upcoming/recurring-suggestions";
import { TagOptionsProvider } from "@/components/upcoming/tag-options";
import { buildAddRequest, clientNameProblem, initialAddState, type AddTagOption } from "@/lib/recurring-add-step";
import type { UiDetection, UiSuggestion } from "@/lib/upcoming-ledger-view";

(globalThis as unknown as { React: typeof React }).React = React;

const TAGS: AddTagOption[] = [
  { id: "t-groc", label: "Food & Drink / Groceries" },
  { id: "t-stream", label: "Bills / Streaming" },
  { id: "t-fees", label: "Bank Fees" },
];
const E = "ent-p";
const KEY = `${E}|acct|out|netflix`;

function suggestion(over: Partial<UiSuggestion> = {}): UiSuggestion {
  return {
    key: KEY,
    entityId: E,
    entityName: "Personal",
    payee: "Netflix",
    kind: "outflow",
    cadence: "monthly",
    summary: "~$15.49 monthly, usually around the 5th",
    confidence: "high",
    confidenceLabel: "Strong pattern",
    why: "Seen 6 times.",
    nextLabel: "Next expected around Oct 5",
    canAdd: true,
    suggestedTagId: "t-stream",
    ...over,
  };
}

const detection = (over: Partial<UiDetection> = {}): UiDetection => ({
  suggestions: [],
  deposits: [],
  dismissed: [],
  flags: [],
  lateCount: 0,
  suppressedCount: 0,
  ...over,
});

function step(over: Partial<React.ComponentProps<typeof AddStep>> = {}) {
  return renderToStaticMarkup(
    <AddStep
      idPrefix="add-x"
      defaultName="Netflix"
      tags={TAGS}
      state={{ tagId: "t-stream", name: "Netflix" }}
      suggestedTagId="t-stream"
      error={null}
      pending={false}
      onChange={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      {...over}
    />
  );
}

describe("the inline step, closed (as first rendered)", () => {
  it("shows the Add button collapsed and no form, select or name field", () => {
    const html = renderToStaticMarkup(
      <TagOptionsProvider tags={TAGS}>
        <SuggestionActions entityId={E} seriesKey={KEY} mode="suggest" defaultName="Netflix" suggestedTagId="t-stream" />
      </TagOptionsProvider>
    );
    expect(html).toContain("Add as recurring expense");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
    expect(html).toContain("Not a bill");
  });

  it("the review list wires each row's name and suggested tag, and hands the tag list down once", () => {
    const html = renderToStaticMarkup(
      <RecurringSuggestions detection={detection({ suggestions: [suggestion(), suggestion({ key: "k2", payee: "Gym", suggestedTagId: null })] })} isAggregate={false} tagOptions={TAGS} />
    );
    expect(html.match(/Add as recurring expense/g)).toHaveLength(2);
    // The categories are not serialized into the markup of every row (they live in one context).
    expect(html).not.toContain("Food &amp; Drink / Groceries");
  });
});

describe("the inline step, open", () => {
  it("has a labelled category list with 'No tag' first and every tag by its full path", () => {
    const html = step();
    expect(html).toContain('<form id="add-x-step" role="group" aria-labelledby="add-x-title"');
    expect(html).toContain('<label for="add-x-tag"');
    expect(html).toContain("Budget category (optional)");
    const select = /<select[\s\S]*?<\/select>/.exec(html)?.[0] ?? "";
    const options = [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    expect(options).toEqual(["No tag", "Food &amp; Drink / Groceries", "Bills / Streaming", "Bank Fees"]);
  });

  it("pre-selects the suggested tag and says why; the help text is the specified sentence", () => {
    const html = step();
    expect(html).toMatch(/<option value="t-stream" selected="">Bills \/ Streaming<\/option>/);
    expect(html).toContain(ADD_TAG_HELP);
    expect(ADD_TAG_HELP).toBe(
      "Link to a budget category so it shows up under your budget and future bank imports of this payee line up."
    );
    expect(html).toContain("Pre-selected because most of this payee&#x27;s transactions already carry this tag.");
  });

  it("starts on 'No tag' with no pre-selection note when nothing was suggested", () => {
    const html = step({ state: { tagId: "", name: "Netflix" }, suggestedTagId: null });
    expect(html).toMatch(/<option value="" selected="">No tag<\/option>/);
    expect(html).not.toContain("Pre-selected");
  });

  it("no pre-selection note once the owner picked something else", () => {
    const html = step({ state: { tagId: "t-fees", name: "Netflix" } });
    expect(html).not.toContain("Pre-selected");
    expect(html).toMatch(/<option value="t-fees" selected="">Bank Fees<\/option>/);
  });

  it("has a labelled, pre-filled name field", () => {
    const html = step({ defaultName: "Maintenance Fee (Credit Cards)", state: { tagId: "", name: "Maintenance Fee (Credit Cards)" } });
    expect(html).toContain('<label for="add-x-name"');
    expect(html).toContain('value="Maintenance Fee (Credit Cards)"');
    expect(html).toContain("Add Maintenance Fee (Credit Cards) as a recurring expense");
    expect(html).toContain("up to 80 characters");
  });

  it("has Confirm (the submit button, so Enter confirms) and Cancel", () => {
    const html = step();
    expect(html).toMatch(/<button type="submit"[^>]*>Confirm<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>Cancel<\/button>/);
  });

  it("shows an error as an alert and disables everything while saving", () => {
    expect(step({ error: "That budget category no longer exists." })).toContain('role="alert"');
    const html = step({ pending: true });
    expect(html).toContain("Adding...");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
    expect(step()).not.toContain('role="alert"');
  });

  it("is observational: no advice or money wording, no account numbers", () => {
    const html = step();
    expect(html).not.toMatch(/\bshould\b|\bmust\b|recommend|advis|guarantee|\$\d/i);
    expect(html).not.toMatch(/\d{4,}/);
  });
});

describe("what leaves the browser", () => {
  it("is only {entityId, seriesKey, tagId} when the name is unchanged", () => {
    const req = buildAddRequest({ entityId: E, seriesKey: KEY }, { tagId: "t-stream", name: "Netflix" }, "Netflix");
    expect(Object.keys(req).sort()).toEqual(["entityId", "seriesKey", "tagId"]);
    expect(req).toEqual({ entityId: E, seriesKey: KEY, tagId: "t-stream" });
  });

  it("adds a trimmed name only when it changed; 'No tag' is an explicit null", () => {
    const req = buildAddRequest({ entityId: E, seriesKey: KEY }, { tagId: "", name: "  Streaming TV  " }, "Netflix");
    expect(req).toEqual({ entityId: E, seriesKey: KEY, tagId: null, name: "Streaming TV" });
    expect(Object.keys(req).sort()).toEqual(["entityId", "name", "seriesKey", "tagId"]);
  });

  it("never carries an amount, frequency, day, date or notes", () => {
    const req = buildAddRequest({ entityId: E, seriesKey: KEY }, { tagId: "t-fees", name: "Other" }, "Netflix");
    for (const k of ["amount", "amountCents", "frequency", "dueDay", "nextDueDate", "notes", "cadence"]) expect(req).not.toHaveProperty(k);
  });

  it("the component source builds its request only through buildAddRequest and never mentions money fields", () => {
    const src = readFileSync(resolve(__dirname, "../../components/upcoming/suggestion-actions.tsx"), "utf8");
    expect(src).toMatch(/addSuggestedRecurringExpense\(buildAddRequest\(/);
    expect(src.match(/addSuggestedRecurringExpense\(/g)).toHaveLength(1);
    // amountCents / recurringFrequency appear only as DISPLAY props for the pre-confirm Budgets notice, never in the request.
    expect(src).not.toMatch(/typicalAmount|dueDay|nextDueDate/);
    expect(/addSuggestedRecurringExpense\(buildAddRequest\([^)]*\)[^)]*\)/.exec(src)?.[0] ?? "").not.toMatch(/amount|frequency/i);
    // Keyboard: Escape cancels, focus goes to the list on open and back to the button on close.
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toMatch(/selectRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/addButtonRef\.current\?\.focus\(\)/);
  });
});

describe("starting state", () => {
  it("pre-selects the suggested tag only when it is still in the list", () => {
    expect(initialAddState("Netflix", "t-stream", TAGS)).toEqual({ tagId: "t-stream", name: "Netflix" });
    expect(initialAddState("Netflix", "t-deleted", TAGS)).toEqual({ tagId: "", name: "Netflix" });
    expect(initialAddState("Netflix", null, TAGS)).toEqual({ tagId: "", name: "Netflix" });
    expect(initialAddState("Netflix", "t-stream", [])).toEqual({ tagId: "", name: "Netflix" });
  });

  it("the name check is 1 to 80 characters after trimming", () => {
    expect(clientNameProblem("a")).toBeNull();
    expect(clientNameProblem("a".repeat(80))).toBeNull();
    expect(clientNameProblem("a".repeat(81))).not.toBeNull();
    expect(clientNameProblem("   ")).not.toBeNull();
  });
});

describe("the recurring expenses table does not show the marker", () => {
  it("reads notes through visibleNotes", () => {
    const src = readFileSync(resolve(__dirname, "../../components/forecast/recurring-expenses-section.tsx"), "utf8");
    expect(src).toMatch(/visibleNotes\(exp\.notes\)/);
    expect(src).not.toMatch(/\{exp\.notes\}/);
  });
});
