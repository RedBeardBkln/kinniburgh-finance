import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guards for the dashboard accuracy / drill-down work: where the numbers may be computed, what the
// drill-down may import, and what the page must keep (auth first, the Upcoming Suspense wiring).

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const PURE_LIBS = ["lib/month-spend.ts", "lib/month-spend-labels.ts", "lib/budget-effective.ts", "lib/dashboard-drill.ts", "lib/dashboard-drill-build.ts", "lib/dashboard-budget-tree.ts"];
const NEW_LIBS = [...PURE_LIBS, "lib/month-spend-build.ts"];
const CLIENT_SAFE = ["lib/month-spend-labels.ts", "lib/dashboard-drill.ts", "lib/dashboard-budget-tree.ts"];
const DASHBOARD_UI = [
  "app/page.tsx",
  "components/dashboard/dashboard-client.tsx",
  "components/dashboard/drill-button.tsx",
  "components/dashboard/drill-context.tsx",
  "components/dashboard/drilldown-dialog.tsx",
  "components/dashboard/budget-lines-table.tsx",
  "components/dashboard/spend-category-cards.tsx",
  "components/dashboard/spending-chart.tsx",
];

describe("dashboard accuracy: new modules stay read-only and out of the Budget table", () => {
  it.each(NEW_LIBS)("%s never touches the Budget table (only app/page.tsx and /budgets read it)", (file) => {
    expect(read(file)).not.toMatch(/\b(?:db|tx|trx|prisma|client)\s*\.\s*budget\b/);
  });

  it.each(PURE_LIBS)("%s is pure: no database, auth or Next imports", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/from "@\/lib\/db"|from "@\/lib\/auth"|from "next\/|next-auth|server-only|"use server"/);
    expect(src).not.toMatch(/\bnew Date\(\)|Date\.now\(|process\.env/);
  });

  it("the loader is read-only with an explicit select and none of the free-text or secret columns", () => {
    const src = read("lib/month-spend-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect((src.match(/\.findMany\(/g) ?? []).length).toBe(1);
    expect(src).toMatch(/select:\s*\{/);
    expect(src).not.toMatch(/include:/);
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bdescription\b|\bnotes\b|\bmask\b|accessToken|plaidTransactionId/);
    expect(src).toMatch(/archivedAt: null/);
  });
});

describe("dashboard accuracy: client-safe files stay client-safe", () => {
  it.each(CLIENT_SAFE)("%s has no runtime Prisma/Decimal import (it is bundled for the browser)", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/^import\s+(?!type\b)[^;]*from "@prisma\/client[^"]*"/m);
    expect(src).not.toMatch(/from "@\/lib\/month-spend"|from "@\/lib\/budget-effective"|from "@\/lib\/dashboard-drill-build"/);
  });

  it("client components only import types from the server-only drill builders", () => {
    for (const file of DASHBOARD_UI.filter((f) => f.startsWith("components/"))) {
      expect(read(file), file).not.toMatch(/from "@\/lib\/(month-spend|budget-effective|dashboard-drill-build|month-spend-build)"/);
    }
  });
});

describe("dashboard accuracy: boundaries with other work", () => {
  it.each(DASHBOARD_UI)("%s does not import the carry-forward modules or the advisor", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/budget-carry-forward/);
    expect(src).not.toMatch(/from "@\/lib\/advisor|from "@\/lib\/bill-dates|from "@\/lib\/upcoming-ledger-(?!build|view)/);
  });

  it("no tax code is imported by the dashboard", () => {
    for (const file of DASHBOARD_UI.concat(NEW_LIBS)) expect(read(file), file).not.toMatch(/lib\/tax/);
  });

  it("no new server action was added for the drill-down (it works from the page's own payload)", () => {
    for (const file of DASHBOARD_UI.concat(NEW_LIBS)) expect(read(file), file).not.toMatch(/^"use server"/m);
  });

  it("the old per-tag modal and its server action are gone", () => {
    expect(() => read("components/dashboard/category-drilldown-modal.tsx")).toThrow();
    expect(() => read("actions/dashboard.ts")).toThrow();
  });
});

describe("dashboard accuracy: types and money", () => {
  it.each(NEW_LIBS.concat(DASHBOARD_UI))("%s has no `any` and no float money maths", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/:\s*any\b|\bas any\b|<any>|any\[\]/);
    expect(src).not.toMatch(/parseFloat\(|Number\.parseFloat\(/);
  });
});

describe("dashboard accuracy: the page keeps its contract", () => {
  const page = read("app/page.tsx");
  it("auth() runs first and redirects before any data is read", () => {
    const authIdx = page.indexOf("await auth()");
    expect(authIdx).toBeGreaterThan(-1);
    expect(page.indexOf('redirect("/login")')).toBeGreaterThan(authIdx);
    expect(page.indexOf("db.")).toBeGreaterThan(page.indexOf('redirect("/login")'));
  });

  it("each widget read is fail-soft (settled on its own) and logs the error name only", () => {
    expect(page).toMatch(/async function settle</);
    expect((page.match(/settle\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(page).not.toMatch(/err\.message|err\.stack/);
    expect(page).toMatch(/drill = null;/);
  });

  it("uses the New York month and the shared model, not a UTC month or a raw SQL sum", () => {
    expect(page).toMatch(/currentPeriodNY\(now\)/);
    expect(page).not.toMatch(/\$queryRaw|getUTCMonth\(\) \+ 1\)\.padStart\(2, "0"\)\}`;\n  \/\/ \?period/);
    expect(page).not.toMatch(/_sum:\s*\{\s*amount/);
    expect(page).toMatch(/buildMonthSpend\(/);
  });

  it("keeps the Upcoming widget behind its Suspense boundary, gated to the current month", () => {
    expect(page).toMatch(/\{isCurrentPeriod && \(\n\s+<Suspense key=\{bucket\} fallback=\{<UpcomingWidgetSkeleton days=\{30\} \/>\}>/);
    expect(page).toContain("{/* Next 30 days (current month only) */}");
    expect(page.slice(0, page.indexOf("async function UpcomingWidgetSection"))).not.toContain("loadUpcomingLedger(");
  });

  it("the Total Budgeted sub-line comes from the shared helper that labels the All Entities view", () => {
    expect(page).toMatch(/budgetedSubline\(drill\.isAllEntities\)/);
  });

  it("scheduled transfers are scoped to the active bucket", () => {
    expect(page).toMatch(/fromAccount: \{ entityId: entity\.id \}/);
  });

  it("every summary card, account row and transfer row is a drill button; the page shows no account numbers beyond the last 4", () => {
    expect((page.match(/<DrillButton/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(page).not.toMatch(/accountNumber|routingNumber/i);
  });
});

describe("/budgets uses the same model as the dashboard", () => {
  const budgets = read("app/budgets/page.tsx");
  it("shares the resolver and the spend model, with no raw SQL spend sum", () => {
    expect(budgets).toMatch(/resolveEffectiveBudgets\(/);
    expect(budgets).toMatch(/buildMonthSpend\(/);
    expect(budgets).not.toMatch(/\$queryRaw/);
    expect(budgets).toMatch(/totalActual = -decimalToNumber\(spendModel\.spent\)/);
  });
  it("still reads real Budget rows itself and never the carry-forward loader (pinned by the carry-forward guards)", () => {
    expect(budgets).toMatch(/db\.budget\.findMany/);
    expect(budgets).not.toMatch(/carried|loadEffective|budget-carry-forward/);
  });
});

describe("posted dates are shown as the calendar day", () => {
  it("the Transactions table formats posted dates in UTC", () => {
    const src = read("components/transactions/transactions-table.tsx");
    const fn = src.slice(src.indexOf("function formatDate"), src.indexOf("function formatAmount"));
    expect(fn).toMatch(/timeZone: "UTC"/);
    expect(fn).not.toMatch(/America\/New_York/);
  });
  it("the other pages that showed a date-only posted value in New York time now use UTC", () => {
    for (const f of [
      "app/transactions/[id]/page.tsx",
      "components/business/excluded-from-pl-section.tsx",
      "components/business/gl-page-client.tsx",
      "components/review-queue/queue-client.tsx",
    ]) {
      const src = read(f);
      expect(src, f).toMatch(/timeZone: "UTC"/);
    }
  });
});

describe("browser-check fixes: own-account masks and page order", () => {
  const page = read("app/page.tsx");
  const budgets = read("app/budgets/page.tsx");

  it("the mask loader is read-only, active accounts only, and selects nothing but id and mask", () => {
    const src = read("lib/own-account-masks-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/);
    expect(src).toMatch(/archivedAt: null/);
    expect(src).toMatch(/select:\s*\{\s*id: true,\s*mask: true,?\s*\}/);
    expect(src).not.toMatch(/console\./);
  });

  it("the dashboard and /budgets feed the SAME mask map to the model, so Total Spent still agrees", () => {
    expect(page).toMatch(/loadOwnAccountByMask\(\)/);
    expect(page).toMatch(/\{ ownAccountByMask \}/);
    expect(budgets).toMatch(/ownAccountByMask: await loadOwnAccountByMask\(\)/);
  });

  it("the model recognises a transfer only through the validated mask map, never by payee text alone", () => {
    const src = read("lib/month-spend.ts");
    expect(src).toMatch(/ownAccountByMask \? parseOwnTransferLabel\(tx\.payee\) : null/);
    expect(src).toMatch(/counterpart !== tx\.accountId/);
    expect(src).not.toMatch(/\b(?:account|acct)\.mask\b/); // it never reads the Account table itself
  });

  it("no mask or raw transfer label reaches the client payload (the drill builder redacts it)", () => {
    const src = read("lib/dashboard-drill-build.ts");
    expect(src).toMatch(/displayPayee\(t\.payee, input\.ownAccountByMask, nicknameById\)/);
    expect(src).toMatch(/hideTransferMask\(payee\)/); // the digits are hidden for every transfer-shaped label (see lib/own-transfer-label.ts)
    expect(read("lib/own-transfer-label.ts")).toMatch(/x\*\*\*\*/);
  });

  it("the title and month navigation are handed to DashboardClient as the header, which renders first", () => {
    expect(page).toMatch(/<DashboardClient\s+data=\{drill\}\s+allTags=\{tagRows \?\? \[\]\}\s+header=\{/);
    const client = read("components/dashboard/dashboard-client.tsx");
    expect(client.indexOf("{header}")).toBeGreaterThan(-1);
    expect(client.indexOf("{header}")).toBeLessThan(client.indexOf("<SpendCategoryCards"));
  });

  it("the scheduled-transfer badge shows the plain cadence, not the stored enum", () => {
    expect(page).toMatch(/cadenceText\(st\.cadence\)/);
    expect(page).not.toMatch(/\{st\.cadence\}/);
  });
});
