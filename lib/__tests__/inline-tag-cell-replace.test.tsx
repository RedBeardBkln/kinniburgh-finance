// The dashboard Spent drill-down corrects miscategorized transactions: in "replace" mode a tagged row offers "Change"
// (picking a tag replaces the row's tags). The Transactions page keeps the default "add" mode: no "Change" button.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/actions/transactions", () => ({ updateTransactionTags: async () => {} }));
vi.mock("@/actions/tag-rules", () => ({ createTagRule: async () => ({ status: "created", id: "r" }) }));
vi.mock("@/actions/tags", () => ({ createTag: async () => ({ id: "t" }) }));
vi.mock("@/components/tag-rules/retroactive-rule-modal", () => ({ RetroactiveRuleModal: () => null }));
vi.mock("@/components/tag-rules/rule-conflict-warning", () => ({ RuleConflictWarning: () => null }));
(globalThis as unknown as { React: typeof React }).React = React;

import { InlineTagCell } from "@/components/transactions/inline-tag-cell";

const TAGS = [
  { id: "g", name: "Food & Drink / Groceries", shortName: "Groceries", parentId: null },
  { id: "r", name: "Food & Drink / Restaurants", shortName: "Restaurants", parentId: null },
];

function render(tagIds: string[], mode?: "add" | "replace"): string {
  return renderToStaticMarkup(
    <InlineTagCell transactionId="t1" allTags={TAGS} initialTagIds={tagIds} {...(mode ? { mode } : {})} />
  );
}

describe("InlineTagCell replace mode", () => {
  it("a tagged row gets a Change button in replace mode", () => {
    const html = render(["g"], "replace");
    expect(html).toContain(">Groceries");
    expect(html).toContain(">Change</button>");
  });

  it("the default (Transactions page) has no Change button on a tagged row", () => {
    expect(render(["g"])).not.toContain(">Change</button>");
  });

  it("an untagged row still shows Add tag (and no Change) in replace mode", () => {
    const html = render([], "replace");
    expect(html).toContain('title="Add tag"');
    expect(html).not.toContain(">Change</button>");
  });
});
