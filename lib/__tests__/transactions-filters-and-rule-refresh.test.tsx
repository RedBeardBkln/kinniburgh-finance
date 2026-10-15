import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

(globalThis as unknown as { React: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { TransactionsFilterBar } from "@/components/transactions/transactions-filter-bar";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const bar = (over: Partial<React.ComponentProps<typeof TransactionsFilterBar>> = {}) =>
  renderToStaticMarkup(
    <TransactionsFilterBar
      bucket="personal"
      tab="all"
      accounts={[]}
      tags={[]}
      currentSearch=""
      currentAccountId=""
      currentTagId=""
      currentDateFrom=""
      currentDateTo=""
      currentSort="date"
      currentSortDir="desc"
      {...over}
    />
  );

describe("Reset filters button", () => {
  it("is always on the bar, disabled when nothing is applied", () => {
    const html = bar();
    expect(html).toContain("Reset filters");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reset filters<\/button>/);
  });

  it("is enabled when a filter is applied", () => {
    const html = bar({ currentSearch: "amazon" });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reset filters<\/button>/);
  });

  it("is enabled when only the sort was changed (it resets the sort too)", () => {
    const html = bar({ currentSort: "payee", currentSortDir: "asc" });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reset filters<\/button>/);
  });
});

describe("transactions page: filters survive a tab change", () => {
  const page = read("app/transactions/page.tsx");

  it("the tab links carry search, account, tag, dates and sort", () => {
    const fn = page.slice(page.indexOf("function buildTabUrl"), page.indexOf("return (", page.indexOf("function buildTabUrl")));
    for (const key of ["search", "accountId", "tagId", "dateFrom", "dateTo", "sort", "sortDir"]) expect(fn).toContain(`"${key}"`);
    expect(fn).toContain('page: "1"');
  });

  it("a tag filter shows Needs Review as unavailable instead of a link that lands on All", () => {
    expect(page).toMatch(/slug === "review" && params\.tagId/);
  });

  it("the from and to dates share one postedAt clause (the second used to overwrite the first)", () => {
    expect(page).toMatch(/\(params\.dateFrom \|\| params\.dateTo\) && \{\s+postedAt: \{/);
    expect(page.match(/postedAt: \{ (gte|lte)/g)).toBeNull();
  });
});

describe("a rule applied from one row updates the other rows on screen", () => {
  const cell = read("components/transactions/inline-tag-cell.tsx");

  it("the tag cell follows the tags the server sends after a refresh, except while it is mid-edit", () => {
    expect(cell).toMatch(/const initialKey = initialTagIds\.join\(","\)/);
    expect(cell).toMatch(/editingRef\.current = rulePrompt !== null \|\| retroModal !== null \|\| isPending;/);
    expect(cell).toMatch(/if \(!editingRef\.current\) setTagIds\(initialTagIds\)/);
    expect(cell).toMatch(/\[initialKey\]/);
  });

  it("the list reloads as soon as the retroactive tags are applied, not only when the dialog closes", () => {
    expect(cell).toContain("onApplied={() => router.refresh()}");
    const modal = read("components/tag-rules/retroactive-rule-modal.tsx");
    expect(modal).toMatch(/setStep\("done"\);\s+onApplied\?\.\(\);/);
  });
});

describe("retroactive rule dialog: resizable Payee column", () => {
  const modal = read("components/tag-rules/retroactive-rule-modal.tsx");

  it("has a keyboard- and pointer-operable resize handle on the Payee header, with a bounded width", () => {
    expect(modal).toContain('role="separator"');
    expect(modal).toMatch(/onPointerDown=\{onResizeDown\}/);
    expect(modal).toMatch(/onKeyDown=\{onResizeKey\}/);
    expect(modal).toMatch(/PAYEE_WIDTH_MIN = 120/);
    expect(modal).toMatch(/PAYEE_WIDTH_MAX = 900/);
  });

  it("the width applies to the header and every payee cell, the full text is in the tooltip, and the table can scroll sideways", () => {
    expect((modal.match(/maxWidth: payeeWidth/g) ?? []).length).toBe(2);
    expect(modal).toContain("title={m.payeeRaw ?? undefined}");
    expect(modal).toContain("overflow-x-auto");
  });
});
