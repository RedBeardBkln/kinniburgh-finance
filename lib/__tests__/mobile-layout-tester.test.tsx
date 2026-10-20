// mobile-layout-cleanup (Tester): extra coverage for the stacked transactions rows the Coder's render test does not pin:
// ONE tag cell (and one project cell) per row, no two cells placed in the same phone grid slot, every cell placed, and
// the select-all checkbox that lives only in the (phone-hidden) thead.
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/transactions",
  useSearchParams: () => new URLSearchParams("bucket=personal"),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/actions/transactions", () => ({ deleteTransaction: async () => {} }));
vi.mock("@/actions/review-assignments", () => ({
  assignTransactions: async () => ({ ok: true, rejected: [] }),
  markAssigneeTagReviewed: async () => ({ ok: true }),
  unassignTransaction: async () => ({ ok: true }),
}));
// Stub the two inline editors so each instance is countable in the markup.
vi.mock("@/components/transactions/inline-tag-cell", () => ({
  InlineTagCell: () => React.createElement("i", { "data-stub": "tag" }),
}));
vi.mock("@/components/transactions/inline-project-cell", () => ({
  InlineProjectCell: () => React.createElement("i", { "data-stub": "project" }),
}));
(globalThis as unknown as { React: typeof React }).React = React;

import type { TxRow } from "@/components/transactions/transactions-table";

let TransactionsTable: typeof import("@/components/transactions/transactions-table").TransactionsTable;
beforeAll(async () => {
  ({ TransactionsTable } = await import("@/components/transactions/transactions-table"));
});

const ROW: TxRow = {
  id: "t1",
  postedAt: "2026-10-01T00:00:00.000Z",
  payeeRaw: "Payee",
  payeeNormalized: "payee",
  description: null,
  amount: "-12.34",
  accountId: "a1",
  accountNickname: "Checking",
  accountMask: "1234",
  tagIds: [],
  projectId: null,
  transferPairId: null,
};

function render(withAssign: boolean, withProjects: boolean, n = 3): string {
  const rows = Array.from({ length: n }, (_, i) => ({ ...ROW, id: `t${i}` }));
  return renderToStaticMarkup(
    <TransactionsTable
      transactions={rows}
      allTags={[]}
      allProjects={withProjects ? [{ id: "p1", name: "Barn" }] : []}
      {...(withAssign ? { assign: { assigneeName: "Eva Example" } } : {})}
    />
  );
}

/** Data rows (the ones that become a phone grid) and the class list of each of their cells. */
function gridRows(html: string): string[][][] {
  const tbody = html.slice(html.indexOf("<tbody"));
  const out: string[][][] = [];
  for (const tr of tbody.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/g)) {
    if (!(tr[1] ?? "").split(/\s+/).includes("max-md:grid")) continue;
    const cells = [...(tr[2] ?? "").matchAll(/<td[^>]*class="([^"]*)"/g)].map((m) => (m[1] ?? "").split(/\s+/));
    out.push(cells);
  }
  return out;
}

function slots(cls: string[]): string[] {
  const num = (p: string, d: number) => {
    const c = cls.find((x) => x.startsWith(p));
    return c ? Number(c.slice(p.length)) : d;
  };
  const col = num("max-md:col-start-", NaN);
  const row = num("max-md:row-start-", NaN);
  const span = num("max-md:row-span-", 1);
  return Array.from({ length: span }, (_, i) => `${col},${row + i}`);
}

describe("transactions stacked rows (tester)", () => {
  for (const withAssign of [false, true]) {
    for (const withProjects of [false, true]) {
      const name = `assign=${withAssign} projects=${withProjects}`;
      it(`${name}: one tag cell (and one project cell) per row`, () => {
        const html = render(withAssign, withProjects, 3);
        expect((html.match(/data-stub="tag"/g) ?? []).length).toBe(3);
        expect((html.match(/data-stub="project"/g) ?? []).length).toBe(withProjects ? 3 : 0);
      });

      it(`${name}: every cell has an explicit phone grid slot and no two cells share one`, () => {
        const rows = gridRows(render(withAssign, withProjects, 2));
        expect(rows.length).toBe(2);
        const maxCol = withAssign ? 3 : 2;
        for (const cells of rows) {
          // checkbox? + date, payee, amount, account, tags, project?, delete
          expect(cells.length).toBe(5 + (withAssign ? 1 : 0) + (withProjects ? 1 : 0) + 1);
          const used: string[] = [];
          for (const c of cells) {
            expect(c).toContain("max-md:block");
            const s = slots(c);
            for (const slot of s) {
              const [col, row] = slot.split(",").map(Number);
              expect(Number.isFinite(col) && Number.isFinite(row), `unplaced cell: ${c.join(" ")}`).toBe(true);
              expect(col).toBeGreaterThanOrEqual(1);
              expect(col).toBeLessThanOrEqual(maxCol);
            }
            used.push(...s);
          }
          expect(new Set(used).size, `overlapping cells: ${used.join(" | ")}`).toBe(used.length);
        }
      });
    }
  }

  it("the desktop table markup still carries the column-width colgroup and resize handles", () => {
    const html = render(true, true, 1);
    expect((html.match(/<col style="width:\d+px"/g) ?? []).length).toBe(1 + 6 + 1); // checkbox + 6 cols + actions
    expect((html.match(/cursor-col-resize/g) ?? []).length).toBe(6);
  });

  // Was D1 (round 1): the "Select all assignable transactions on this page" checkbox existed only in the thead, which is
  // `max-md:hidden`. Round 2 added a phone-only (md:hidden) select-all above the rows; this pins it.
  it("select-all stays reachable on phones (an element outside the phone-hidden thead)", () => {
    const html = render(true, false, 2);
    const theadEnd = html.indexOf("</thead>");
    const outsideThead = html.slice(0, html.indexOf("<thead")) + html.slice(theadEnd);
    expect(outsideThead).toContain('aria-label="Select all assignable transactions on this page"');
  });
});
