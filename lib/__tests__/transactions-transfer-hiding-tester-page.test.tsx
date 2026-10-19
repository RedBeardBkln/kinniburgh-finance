// Tester (transactions-transfer-hiding): behavioural render of the REAL app/transactions/page.tsx with the db mocked at
// the boundary. Captures every where clause the page sends and the rows it hands to the table, for each tab / filter
// combination named in the plan (AC12, AC13, AC14). No database is contacted.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as { React: typeof React }).React = React;

type Where = Record<string, unknown>;

const m = vi.hoisted(() => ({
  txFindMany: vi.fn(),
  txCount: vi.fn(),
  maskMap: vi.fn(),
  tableProps: [] as { transactions: { id: string; transferKind?: string | null; assignDisabledReason?: string | null }[] }[],
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-eric", name: "Eric" } }) }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect ${p}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    transaction: { findMany: m.txFindMany, count: m.txCount },
    tag: { findMany: async () => [] },
    account: { findMany: async () => [], count: async () => 0 },
    project: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/entity", () => ({
  getEntityBySlug: async (slug: string) =>
    slug === "taxes" ? null : { id: `ent-${slug}`, name: slug, slug, navLabel: slug, type: "personal" },
}));
vi.mock("@/lib/own-account-masks-build", () => ({ loadOwnAccountByMask: m.maskMap }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/actions/reports", () => ({ exportTransactionsCsv: async () => ({}) }));
vi.mock("@/components/export-csv-button", () => ({ ExportCsvButton: () => null }));
vi.mock("@/components/transactions/apply-rules-button", () => ({ ApplyRulesButton: () => null }));
vi.mock("@/components/transactions/dry-run-button", () => ({ DryRunButton: () => null }));
vi.mock("@/components/transactions/transactions-filter-bar", () => ({ TransactionsFilterBar: () => null }));
vi.mock("@/components/transactions/sync-now-button", () => ({ SyncNowButton: () => null }));
vi.mock("@/components/review-queue/eric-review-panel", () => ({ EricReviewPanel: () => null }));
vi.mock("@/components/transactions/transactions-table", () => ({
  TransactionsTable: (p: (typeof m.tableProps)[number]) => {
    m.tableProps.push(p);
    return <table data-rows={p.transactions.length} />;
  },
}));
vi.mock("@/actions/review-assignments", () => ({
  getDraftBatchSummary: async () => ({ assignee: { id: "u-eva", name: "Eva" }, assigneeProblem: null }),
}));
vi.mock("@/lib/review-queue-server", () => ({
  loadAssignmentStates: async () => new Map(),
  loadBatchStatuses: async () => [],
}));

import TransactionsPage from "@/app/transactions/page";

function baseRow(o: Record<string, unknown>) {
  return {
    postedAt: new Date("2026-04-06T00:00:00Z"),
    payeeRaw: "Payee",
    payeeNormalized: null,
    description: null,
    amount: "-10.00",
    accountId: "acc-primary",
    entityId: "ent-personal",
    transferPairId: null,
    ownTransferAccountId: null,
    pending: false,
    archivedAt: null,
    projectId: null,
    account: { nickname: "Primary Checking", mask: "2566" },
    tags: [],
    ...o,
  };
}

let listRows: ReturnType<typeof baseRow>[] = [];
let pendingRows: { id: string; accountId: string; payeeRaw: string | null; amount: { toString(): string } }[] = [];

beforeEach(() => {
  m.txFindMany.mockReset();
  m.txCount.mockReset();
  m.maskMap.mockReset();
  m.tableProps.length = 0;
  listRows = [];
  pendingRows = [];
  m.txFindMany.mockImplementation(async (arg: { where: Where }) => (arg.where.pending === true ? pendingRows : listRows));
  m.txCount.mockResolvedValue(0);
  m.maskMap.mockResolvedValue(
    new Map([
      ["2566", "acc-primary"],
      ["3612", "acc-slush"],
      ["3950", "acc-savings"],
      ["8815", "acc-savings"],
    ])
  );
});

async function render(params: Record<string, string>) {
  const el = await TransactionsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(el as React.ReactElement);
}

const listWhere = () => (m.txFindMany.mock.calls.find((c) => c[0].where.pending !== true)?.[0].where ?? null) as Where | null;
const pendingWhere = () => (m.txFindMany.mock.calls.find((c) => c[0].where.pending === true)?.[0].where ?? null) as Where | null;
// count() is called for the review badge first and then for the list total
const reviewCountWhere = () => m.txCount.mock.calls[0]![0].where as Where;
const totalWhere = () => m.txCount.mock.calls[1]![0].where as Where;

describe("AC12: without an account filter, All and Needs Review hide paired AND one-sided legs", () => {
  it("tab=all: list, total and badge all carry transferPairId: null and ownTransferAccountId: null", async () => {
    await render({ bucket: "personal", tab: "all" });
    for (const w of [listWhere()!, totalWhere(), reviewCountWhere()]) {
      expect(w.transferPairId).toBeNull();
      expect(w.ownTransferAccountId).toBeNull();
      expect(w.archivedAt).toBeNull();
      expect(w.entityId).toBe("ent-personal");
    }
    expect(reviewCountWhere()).toMatchObject({ tags: { none: {} }, pending: false });
  });

  it("tab=review (default): list is untagged, posted, no transfers; the badge uses the same filter", async () => {
    await render({ bucket: "personal" });
    expect(listWhere()).toMatchObject({ tags: { none: {} }, pending: false, transferPairId: null, ownTransferAccountId: null });
    expect(reviewCountWhere()).toEqual(listWhere());
  });
});

describe("AC13: per-account view", () => {
  it("tab=all with accountId lists that account's transfers (no transfer filter), shows the line, maps the chip kind", async () => {
    listRows = [
      baseRow({ id: "paired", transferPairId: "p1" }),
      baseRow({ id: "one", ownTransferAccountId: "acc-savings" }),
      baseRow({ id: "plain" }),
    ];
    const html = await render({ bucket: "personal", tab: "all", accountId: "acc-primary" });
    const w = listWhere()!;
    expect(w.accountId).toBe("acc-primary");
    expect("transferPairId" in w).toBe(false);
    expect("ownTransferAccountId" in w).toBe(false);
    expect(totalWhere()).toEqual(w);
    expect(html).toContain("Transfers to and from this account are included.");
    const rows = m.tableProps[0]!.transactions;
    expect(rows.map((r) => [r.id, r.transferKind])).toEqual([
      ["paired", "paired"],
      ["one", "one_sided"],
      ["plain", null],
    ]);
    // a one-sided leg gets the same "transfer leg" disabled reason as a paired one; a plain row stays selectable
    const reason = (id: string) => rows.find((r) => r.id === id)!.assignDisabledReason;
    expect(reason("one")).toBe(reason("paired"));
    expect(reason("one")).toBeTruthy();
    expect(reason("plain")).toBeNull();
  });

  it("tab=review with accountId still hides transfers, and the badge too; no 'included' line", async () => {
    const html = await render({ bucket: "personal", tab: "review", accountId: "acc-primary" });
    expect(listWhere()).toMatchObject({ accountId: "acc-primary", transferPairId: null, ownTransferAccountId: null });
    expect(reviewCountWhere()).toMatchObject({ accountId: "acc-primary", transferPairId: null, ownTransferAccountId: null });
    expect(html).not.toContain("Transfers to and from this account are included.");
  });

  it("the bucket=taxes fallback (entity without slug) still shows the account's rows (no entity filter)", async () => {
    await render({ bucket: "taxes", tab: "all", accountId: "acc-x" });
    const w = listWhere()!;
    expect(w.accountId).toBe("acc-x");
    expect("entityId" in w).toBe(false);
  });
});

describe("AC14: pending note", () => {
  it("counts pending untagged rows under the SAME bucket/account/search/date filters, minus validated own transfers", async () => {
    pendingRows = [
      { id: "own", accountId: "acc-primary", payeeRaw: "Online  Xfer Transfer to CK x3612", amount: { toString: () => "-5.00" } },
      { id: "alias", accountId: "acc-primary", payeeRaw: "Online Xfer Transfer to SV x8815", amount: { toString: () => "-10.00" } },
      { id: "ext", accountId: "acc-primary", payeeRaw: "Online Xfer Transfer to CK x0000", amount: { toString: () => "-5.00" } },
      { id: "shop", accountId: "acc-primary", payeeRaw: "STOP & SHOP", amount: { toString: () => "-40.00" } },
    ];
    const html = await render({
      bucket: "personal",
      tab: "review",
      accountId: "acc-primary",
      search: "shop",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
    });
    const pw = pendingWhere()!;
    const rc = reviewCountWhere();
    expect(pw).toMatchObject({ pending: true, tags: { none: {} }, transferPairId: null, ownTransferAccountId: null });
    for (const k of ["entityId", "accountId", "OR", "postedAt", "archivedAt"]) expect(pw[k]).toEqual(rc[k]);
    expect(html).toContain("2 pending transactions will appear here once they post");
    expect(html).toMatch(/<p class="text-xs text-muted-foreground">2 pending transactions/);
  });

  it("singular wording at 1; omitted at 0", async () => {
    pendingRows = [{ id: "a", accountId: "acc-primary", payeeRaw: "X", amount: { toString: () => "-1.00" } }];
    expect(await render({ bucket: "personal" })).toContain("1 pending transaction will appear here once it posts");
    pendingRows = [];
    expect(await render({ bucket: "personal" })).not.toContain("pending transaction");
  });

  it("is not read or shown on the All tab", async () => {
    pendingRows = [{ id: "a", accountId: "acc-primary", payeeRaw: "X", amount: { toString: () => "-1.00" } }];
    const html = await render({ bucket: "personal", tab: "all" });
    expect(pendingWhere()).toBeNull();
    expect(m.maskMap).not.toHaveBeenCalled();
    expect(html).not.toContain("pending transaction");
  });

  it("a failed read (pending rows or mask map) omits the note and the page still renders", async () => {
    pendingRows = [{ id: "a", accountId: "acc-primary", payeeRaw: "X", amount: { toString: () => "-1.00" } }];
    m.maskMap.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render({ bucket: "personal" });
    expect(html).toContain("Transactions");
    expect(html).not.toContain("pending transaction");
    expect(err.mock.calls.flat().join(" ")).not.toMatch(/db down/); // err.name only
    err.mockRestore();
  });
});
