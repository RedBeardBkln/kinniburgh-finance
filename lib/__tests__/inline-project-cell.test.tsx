// A transaction keeps its project link after the project is completed: the Transactions row must still show that
// project (labelled completed) instead of falling back to "No project", and a completed project is never offered to
// rows that are not linked to it.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/actions/transactions", () => ({ updateTransactionProject: async () => {} }));
(globalThis as unknown as { React: typeof React }).React = React;

import { InlineProjectCell } from "@/components/transactions/inline-project-cell";

const ACTIVE = { id: "11111111-1111-4111-8111-111111111111", name: "Deck", status: "active" };
const DONE = { id: "22222222-2222-4222-8222-222222222222", name: "Kitchen", status: "completed" };

function render(initialProjectId: string | null, projects = [ACTIVE, DONE]): string {
  return renderToStaticMarkup(
    <InlineProjectCell transactionId="t1" projects={projects} initialProjectId={initialProjectId} />
  );
}

describe("InlineProjectCell and completed projects", () => {
  it("keeps showing a completed project on the row linked to it", () => {
    const html = render(DONE.id);
    expect(html).toContain(`<option value="${DONE.id}" selected="">Kitchen (completed)</option>`);
    expect(html).not.toMatch(/<option value="" selected="">/);
  });

  it("does not offer a completed project to a row that is not linked to it", () => {
    expect(render(null)).not.toContain("Kitchen");
    expect(render(ACTIVE.id)).not.toContain("Kitchen");
    expect(render(null)).toContain(">Deck<");
  });

  it("renders nothing when only completed projects exist and the row has none", () => {
    expect(render(null, [DONE])).toBe("");
    expect(render(DONE.id, [DONE])).toContain("Kitchen (completed)");
  });
});
