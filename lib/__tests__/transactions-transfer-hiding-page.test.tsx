import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as { React: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/actions/transactions", () => ({ deleteTransaction: async () => ({}) }));
vi.mock("@/actions/review-assignments", () => ({
  assignTransactions: async () => ({}),
  markAssigneeTagReviewed: async () => ({}),
  unassignTransaction: async () => ({}),
}));
vi.mock("@/components/transactions/inline-tag-cell", () => ({ InlineTagCell: () => null }));
vi.mock("@/components/transactions/inline-project-cell", () => ({ InlineProjectCell: () => null }));

import { TransactionsTable, type TxRow } from "@/components/transactions/transactions-table";

const page = readFileSync(join(process.cwd(), "app/transactions/page.tsx"), "utf8");
const accountsClient = readFileSync(join(process.cwd(), "components/accounts/accounts-page-client.tsx"), "utf8");
const accountsPage = readFileSync(join(process.cwd(), "app/accounts/page.tsx"), "utf8");

describe("app/transactions/page.tsx: transfer hiding", () => {
  it("baseWhere hides transfers unless an account filter is set", () => {
    expect(page).toMatch(/\.\.\.transferVisibilityWhere\(!!params\.accountId\)/);
    const base = page.slice(page.indexOf("const baseWhere"), page.indexOf("const needsReviewFilter"));
    expect(base).not.toMatch(/transferPairId: null/);
  });

  it("Needs Review and its badge count use NEEDS_REVIEW_WHERE (always hiding transfers)", () => {
    expect(page).toMatch(/const needsReviewFilter: Prisma\.TransactionWhereInput = NEEDS_REVIEW_WHERE;/);
    expect(page).toMatch(/where: \{ \.\.\.baseWhere, \.\.\.needsReviewFilter \}/);
    expect(page).toMatch(/\.\.\.\(tab === "review" && needsReviewFilter\)/);
  });

  it("the pending note is read and rendered only on the review tab, fail-soft", () => {
    expect(page).toMatch(/if \(tab === "review"\) \{\s*try \{/);
    expect(page).toMatch(/\{ \.\.\.baseWhere, \.\.\.PENDING_NOTE_WHERE \}/);
    expect(page).toMatch(/\{tab === "review" && pendingNote && \(/);
    expect(page).toMatch(/err instanceof Error \? err\.name : "unknown"/);
  });

  it("selects the marker, maps it to the row's transfer kind and into checkAssignable", () => {
    expect(page).toMatch(/ownTransferAccountId: true,/);
    expect(page).toMatch(/transferKind: transferKindOf\(tx\)/);
    expect(page).toMatch(/transferPairId: tx\.transferPairId \?\? \(tx\.ownTransferAccountId \? "own-transfer" : null\)/);
  });

  it("says transfers are included in the per-account All view", () => {
    expect(page).toMatch(/params\.accountId && tab === "all" && \(/);
    expect(page).toContain("Transfers to and from this account are included.");
  });
});

describe("Accounts page: the nickname opens the account's transactions", () => {
  it("links through accountTransactionsHref with the account's own entity slug", () => {
    expect(accountsClient).toMatch(/href=\{accountTransactionsHref\(acct\)\}/);
    expect(accountsPage).toMatch(/entitySlug: a\.entity\.slug,/);
  });
});

function txRow(o: Partial<TxRow> & Pick<TxRow, "id">): TxRow {
  return {
    postedAt: "2026-04-06T00:00:00.000Z",
    payeeRaw: "Payee " + o.id,
    payeeNormalized: null,
    description: null,
    amount: "-10.00",
    accountId: "acc",
    accountNickname: "Primary Checking",
    accountMask: null,
    tagIds: [],
    projectId: null,
    transferPairId: null,
    ...o,
  };
}

describe("TransactionsTable: transfer chips", () => {
  const html = renderToStaticMarkup(
    <TransactionsTable
      transactions={[
        txRow({ id: "paired", transferPairId: "p1", transferKind: "paired" }),
        txRow({ id: "one", transferKind: "one_sided" }),
        txRow({ id: "plain", transferKind: null }),
        txRow({ id: "legacy", transferPairId: "p2" }),
      ]}
      allTags={[]}
      allProjects={[]}
    />
  );
  const rowOf = (id: string) => {
    const start = html.indexOf(`/transactions/${id}"`);
    const trStart = html.lastIndexOf("<tr", start);
    return html.slice(trStart, html.indexOf("</tr>", start));
  };

  it("labels a paired leg 'Transfer' and dims it", () => {
    const r = rowOf("paired");
    expect(r).toContain(">Transfer</span>");
    expect(r).toContain("opacity-70");
  });

  it("labels a one-sided leg 'Transfer (one side)' with the explanation and dims it", () => {
    const r = rowOf("one");
    expect(r).toContain("Transfer (one side)");
    expect(r).toContain("The other account&#x27;s side of this transfer is not in your records");
    expect(r).toContain("opacity-70");
  });

  it("a plain row has no chip and is not dimmed", () => {
    const r = rowOf("plain");
    expect(r).not.toContain("Transfer");
    expect(r).not.toContain("opacity-70");
  });

  it("a row without transferKind falls back to transferPairId", () => {
    expect(rowOf("legacy")).toContain(">Transfer</span>");
  });
});
