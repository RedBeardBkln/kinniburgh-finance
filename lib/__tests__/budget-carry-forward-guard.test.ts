import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard (carry-forward-seasonal-energy, step 1). Owner rule: a month with no Budget row for a line uses
// the latest earlier row of that line, at READ time, everywhere a forward month is read. So:
//  1. The only files that read Budget rows are the shared loader and the screens/actions that deliberately work on
//     REAL rows (Budgets page, dashboard, monthly review, CSV export, the Budget CRUD actions);
//  2. The carry-forward modules are pure / read-only, and the Budgets screen + its actions + the tax code never
//     import them (nesting, rollover and recurring-expense override on /budgets must be unaffected).

const root = process.cwd();
const cache = new Map<string, string>();
const read = (rel: string) => {
  let src = cache.get(rel);
  if (src === undefined) {
    src = readFileSync(join(root, rel), "utf8");
    cache.set(rel, src);
  }
  return src;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "__tests__") continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel);
  }
  return out;
}
const SOURCE_FILES = ["app", "lib", "actions", "components"].flatMap((d) => walk(d));

/** A direct Prisma read or write of the Budget table (db.budget.x, tx.budget.x, prisma.budget.x). */
const BUDGET_ACCESS_RE = /\b(?:db|tx|prisma)\.budget\.\w+/;

/** Files that may touch the Budget table directly, and why. Every other reader goes through the loader. */
const BUDGET_ACCESS_ALLOW: Record<string, string> = {
  "lib/budget-carry-forward-build.ts": "the shared effective-budget loader (the one forward-month reader)",
  "app/budgets/page.tsx": "the Budgets screen works on real rows (nesting, rollover, recurring-expense override)",
  "actions/budgets.ts": "Budget CRUD",
  "actions/recurring-suggestions.ts": "existence checks for a category before linking a recurring expense",
  "actions/reports.ts": "exportBudgetCsv (real rows; a follow-up may carry forward there)",
  "app/page.tsx": "dashboard (real rows; a follow-up may carry forward there)",
  "lib/monthly-review-build.ts": "monthly review (real rows; a follow-up may carry forward there)",
};

describe("only the shared loader reads Budget rows for forward months", () => {
  it("every direct Budget table access is in the allow-list", () => {
    const users = SOURCE_FILES.filter((f) => read(f).includes(".budget.") && BUDGET_ACCESS_RE.test(read(f))).sort();
    expect(users).toEqual(Object.keys(BUDGET_ACCESS_ALLOW).sort());
  });

  const CONSUMERS = [
    "lib/bill-dates-build.ts",
    "lib/upcoming-ledger-input.ts",
    "lib/recurring-budget-hint-build.ts",
    "lib/notifications.ts",
    "lib/advisor-context.ts",
    "lib/advisor/queries/budgets.ts",
    "app/forecast/page.tsx",
  ];
  it.each(CONSUMERS)("%s reads Budget rows through the loader", (file) => {
    const src = read(file);
    expect(src).toMatch(/budget-carry-forward-build/);
    expect(src).toMatch(/loadEffective(Budget|Schedule)Rows/);
    expect(src).not.toMatch(BUDGET_ACCESS_RE);
  });
});

describe("the carry-forward modules", () => {
  it("the resolver is pure: no database, no clock, no server-only imports", () => {
    const src = read("lib/budget-carry-forward.ts");
    expect(src).not.toMatch(/from "@\/lib\/db"|from "\.\/db"|next\/|next-auth|server-only/);
    expect(src).not.toMatch(/\bnew Date\(|Date\.now\(|process\.env/);
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it("the loader is read-only with explicit selects and no auth side effects", () => {
    const src = read("lib/budget-carry-forward-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect(src).not.toMatch(/\binclude:/);
    expect(src).not.toMatch(/^"use server"/m);
    expect(src).not.toMatch(/next\/cache|revalidatePath|requireAuth|next-auth/);
  });

  it("both new files exist", () => {
    for (const f of ["lib/budget-carry-forward.ts", "lib/budget-carry-forward-build.ts"]) expect(existsSync(join(root, f))).toBe(true);
  });

  it("no client component and no 'use client' file imports them (the resolver pulls in Decimal as a value)", () => {
    const importers = SOURCE_FILES.filter((f) => /budget-carry-forward/.test(read(f)) && !f.startsWith("lib/budget-carry-forward"));
    for (const f of importers) expect(read(f), f).not.toMatch(/^["']use client["']/m);
    expect(importers.filter((f) => f.startsWith("components/"))).toEqual([]);
  });

  it("the Budgets screen, its actions, the Budget CRUD and the tax code never import them", () => {
    const protectedFiles = SOURCE_FILES.filter(
      (f) =>
        f.startsWith("app/budgets/") ||
        f.startsWith("components/budgets/") ||
        f === "actions/budgets.ts" ||
        f === "lib/budget-nesting.ts" ||
        f === "lib/budget.ts" ||
        f.startsWith("lib/tax2025/") ||
        f.startsWith("lib/tax-review/")
    );
    expect(protectedFiles.length).toBeGreaterThan(20);
    for (const f of protectedFiles) expect(read(f), f).not.toMatch(/budget-carry-forward/);
  });

  it("a carried row is never handed to a Budget action: no action file imports the loader or the resolver", () => {
    const importers = SOURCE_FILES.filter((f) => f.startsWith("actions/") && /budget-carry-forward/.test(read(f)));
    expect(importers).toEqual([]);
  });
});

describe("the removed note", () => {
  it("'No budget line for <period>' remains only as the no-row-to-carry fallback in the ledger", () => {
    // (the resolver's header comment quotes the phrase; it is not a note)
    const hits = SOURCE_FILES.filter((f) => f !== "lib/budget-carry-forward.ts" && /No budget line for/.test(read(f)));
    expect(hits).toEqual(["lib/upcoming-ledger.ts"]);
    expect(read("lib/upcoming-ledger.ts")).toMatch(/row\.carriedFrom\) item\.notes\.push\(carriedNote/);
  });
});
