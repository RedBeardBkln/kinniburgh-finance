// mobile-layout-cleanup: static renders (no DOM infra in this repo) of the app shell, the assistant launcher, the
// transactions table and TableScroll, pinning the phone-only layout classes and that the desktop classes are still there.
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/transactions",
  useSearchParams: () => new URLSearchParams("bucket=personal"),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next-auth/react", () => ({ signOut: async () => {} }));
vi.mock("@/actions/notifications", () => ({
  getNotifications: async () => [],
  markRead: async () => {},
  markAllRead: async () => {},
  approveNotification: async () => ({ ok: true }),
}));
vi.mock("@/actions/transactions", () => ({
  deleteTransaction: async () => {},
  updateTransactionTags: async () => ({ ok: true }),
  updateTransactionProject: async () => ({ ok: true }),
}));
vi.mock("@/actions/review-assignments", () => ({
  assignTransactions: async () => ({ ok: true, rejected: [] }),
  markAssigneeTagReviewed: async () => ({ ok: true }),
  unassignTransaction: async () => ({ ok: true }),
}));
vi.mock("@/actions/tag-rules", () => ({
  createTagRule: async () => ({ ok: true }),
  previewRetroactiveRule: async () => ({ ok: true }),
  applyRetroactiveRule: async () => ({ ok: true }),
}));
vi.mock("@/actions/tags", () => ({ createTag: async () => ({ ok: true }) }));
(globalThis as unknown as { React: typeof React }).React = React;

import type { TxRow } from "@/components/transactions/transactions-table";

// Imported after React is on globalThis (some components use the classic JSX runtime at module scope).
let AppShellNav: typeof import("@/components/app-shell-nav").AppShellNav;
let AdvisorLauncher: typeof import("@/components/advisor/advisor-launcher").AdvisorLauncher;
let TransactionsTable: typeof import("@/components/transactions/transactions-table").TransactionsTable;
let TableScroll: typeof import("@/components/ui/table-scroll").TableScroll;
beforeAll(async () => {
  ({ AppShellNav } = await import("@/components/app-shell-nav"));
  ({ AdvisorLauncher } = await import("@/components/advisor/advisor-launcher"));
  ({ TransactionsTable } = await import("@/components/transactions/transactions-table"));
  ({ TableScroll } = await import("@/components/ui/table-scroll"));
});

/** The class attribute of the first element whose class list contains every given class. */
function classOf(html: string, ...mustHave: string[]): string | undefined {
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    const cls = (m[1] ?? "").split(/\s+/);
    if (mustHave.every((c) => cls.includes(c))) return m[1];
  }
  return undefined;
}

function renderShell(): string {
  return renderToStaticMarkup(
    <AppShellNav
      userName="Test User"
      unreadCount={0}
      navBuckets={[
        { slug: "personal", label: "Personal", type: "personal", id: "e1" },
        { slug: "taxes", label: "Taxes", type: "taxes", id: null },
      ]}
      logoUrl={null}
      businessSlugs={[]}
      taxEntityLinks={[]}
      taxFormsHref="/tax/forms"
      taxMileageHref={null}
    >
      <p>page body</p>
    </AppShellNav>
  );
}

describe("app shell on phones", () => {
  let html = "";
  beforeAll(() => {
    html = renderShell();
  });

  it("has the hamburger only below md", () => {
    expect(html).toContain('aria-label="Open navigation menu"');
    expect(classOf(html, "md:hidden", "max-md:p-3")).toBeDefined();
  });

  it("puts the bucket tabs on their own swipeable row below md and keeps the desktop row", () => {
    const tabs = classOf(html, "overflow-x-auto", "max-md:basis-full");
    expect(tabs).toBeDefined();
    expect(tabs).toContain("max-md:order-last");
    const row = classOf(html, "md:h-14", "max-md:flex-wrap");
    expect(row).toBeDefined();
    expect(row!.split(/\s+/)).toContain("gap-4");
  });

  it("keeps the desktop content padding and adds 16px phone padding", () => {
    const wrap = classOf(html, "px-6", "py-6");
    expect(wrap).toBeDefined();
    expect(wrap).toContain("max-md:px-4");
    expect(wrap).toContain("max-md:pb-24");
    expect(html).toContain("page body");
  });

  it("keeps the closed drawer inert", () => {
    expect(html).toMatch(/<div[^>]*inert=""[^>]*>|<div[^>]*inert[^>]*md:hidden/);
  });
});

describe("assistant launcher on phones", () => {
  it("is an icon-only round button with the label kept for screen readers", () => {
    const html = renderToStaticMarkup(<AdvisorLauncher />);
    expect(html).toContain("Ask the assistant");
    expect(html).toContain("print:hidden");
    expect(html).toContain("aria-expanded");
    expect(html).toContain("max-sm:sr-only");
    expect(html).toContain('aria-label="Ask the assistant"');
  });
});

const ROW: TxRow = {
  id: "t1",
  postedAt: "2026-10-01T00:00:00.000Z",
  payeeRaw: "A very long payee name that would not fit",
  payeeNormalized: "a very long payee",
  description: null,
  amount: "-12.34",
  accountId: "a1",
  accountNickname: "Checking",
  accountMask: "1234",
  tagIds: [],
  projectId: null,
  transferPairId: null,
};

describe("transactions table on phones", () => {
  it("stacks rows below md (no assignment column, no projects)", () => {
    const html = renderToStaticMarkup(
      <TransactionsTable transactions={[ROW, { ...ROW, id: "t2" }]} allTags={[]} allProjects={[]} />
    );
    expect(classOf(html, "max-md:hidden")).toBeDefined();
    expect(html).toMatch(/<thead class="max-md:hidden"/);
    expect(html).toMatch(/<colgroup class="max-md:hidden"/);
    const tr = classOf(html, "max-md:grid");
    expect(tr).toContain("max-md:grid-cols-[minmax(0,1fr)_auto]");
    expect(classOf(html, "md:overflow-x-auto")).toBeDefined();
  });

  it("adds the checkbox column when assignment is on", () => {
    const html = renderToStaticMarkup(
      <TransactionsTable
        transactions={[ROW]}
        allTags={[]}
        allProjects={[{ id: "p1", name: "Barn" }]}
        assign={{ assigneeName: "Eva Example" }}
      />
    );
    expect(classOf(html, "max-md:grid")).toContain("max-md:grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(classOf(html, "max-md:row-start-4")).toBeDefined(); // the project cell
  });

  it("keeps the empty-state row usable in block layout", () => {
    const html = renderToStaticMarkup(<TransactionsTable transactions={[]} allTags={[]} allProjects={[]} />);
    expect(html).toContain("No transactions found");
    expect(html).toMatch(/<tr class="max-md:block"><td colSpan="6" class="[^"]*max-md:block/i);
  });
});

describe("TableScroll", () => {
  it("wraps children in a sideways-scrolling box", () => {
    const html = renderToStaticMarkup(
      <TableScroll>
        <table />
      </TableScroll>
    );
    expect(html).toBe('<div class="w-full overflow-x-auto"><table></table></div>');
  });

  it("is a focusable named region when given a label", () => {
    const html = renderToStaticMarkup(
      <TableScroll label="Budget lines" className="mt-2">
        <table />
      </TableScroll>
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Budget lines"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("mt-2");
  });
});
