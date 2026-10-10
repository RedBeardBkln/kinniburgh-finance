import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard (carry-forward-seasonal-energy step 1, updated deliberately by budget-auto-carry-ui). Owner rule:
// a month with no Budget row for a line uses the latest earlier row of that line, at READ time, everywhere a month is
// read, /budgets, the dashboard, the monthly review and the CSV export included; the first edit of such a month saves
// the carried set as real rows in the same transaction (copy-on-first-edit). So:
//  1. The only files that touch the Budget table are the shared loader (reads), the write module
//     lib/budget-materialize-build.ts and the Budget actions (writes, on `tx` inside one transaction), and the
//     recurring-suggestion existence checks. Every screen and report reads through the loader;
//  2. The carry-forward modules are pure / read-only; client components, the nesting/total libs and the tax code never
//     import them; an action takes a LOCATOR (entity, tag, month), never a Budget id, so a synthetic carried id can
//     never reach one.

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
  "lib/budget-carry-forward-build.ts": "the shared effective-budget loader (the one reader of Budget rows for the screens and reports)",
  "lib/budget-materialize-build.ts": "the write helpers of copy-on-first-edit: tx only, createMany skipDuplicates, deleteMany only to end a line",
  "actions/budgets.ts": "Budget CRUD by the unique (tag, entity, month) key, inside the one locked transaction",
  "actions/recurring-suggestions.ts": "existence checks for a category before linking a recurring expense (any month)",
  // REMOVED on purpose (budget-auto-carry-ui): app/budgets/page.tsx, app/page.tsx, lib/monthly-review-build.ts and
  // actions/reports.ts read real rows only before; the screens now show the effective view, so they use the loader.
};

describe("only the shared loader reads Budget rows for forward months", () => {
  it("every direct Budget table access is in the allow-list", () => {
    const users = SOURCE_FILES.filter((f) => read(f).includes(".budget.") && BUDGET_ACCESS_RE.test(read(f))).sort();
    expect(users).toEqual(Object.keys(BUDGET_ACCESS_ALLOW).sort());
  });

  const CONSUMERS = [
    // moved here from the real-rows allow-list by budget-auto-carry-ui
    "app/budgets/page.tsx",
    "app/page.tsx",
    "lib/monthly-review-build.ts",
    "actions/reports.ts",
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

  it("the loader may also be imported by the Budgets page (server component), never by a client component", () => {
    expect(read("app/budgets/page.tsx")).toMatch(/from "@\/lib\/budget-carry-forward-build"/);
    expect(read("app/budgets/page.tsx")).not.toMatch(/^["']use client["']/m);
  });

  it("no client component and no 'use client' file imports them (the resolver pulls in Decimal as a value)", () => {
    const importers = SOURCE_FILES.filter((f) => /budget-carry-forward/.test(read(f)) && !f.startsWith("lib/budget-carry-forward"));
    for (const f of importers) expect(read(f), f).not.toMatch(/^["']use client["']/m);
    expect(importers.filter((f) => f.startsWith("components/"))).toEqual([]);
  });

  it("client components, the nesting / total libs and the tax code never import them", () => {
    // Narrowed deliberately (budget-auto-carry-ui): app/budgets/page.tsx and actions/budgets.ts now use the carry modules
    // (the page the loader, the actions the planner), so only the pure arithmetic libs, every component and the tax
    // code stay out of it.
    const protectedFiles = SOURCE_FILES.filter(
      (f) =>
        f.startsWith("components/") ||
        f === "lib/budget-nesting.ts" ||
        f === "lib/budget.ts" ||
        f === "lib/budget-effective.ts" ||
        f.startsWith("lib/tax2025/") ||
        f.startsWith("lib/tax-review/")
    );
    expect(protectedFiles.length).toBeGreaterThan(20);
    for (const f of protectedFiles) expect(read(f), f).not.toMatch(/budget-carry-forward/);
  });

  it("no action imports the resolver or the planner directly; only actions/reports.ts reads the loader and only actions/budgets.ts writes through the materialize modules", () => {
    const actions = SOURCE_FILES.filter((f) => f.startsWith("actions/"));
    const resolver = actions.filter((f) => /["']@\/lib\/budget-carry-forward["']/.test(read(f)));
    expect(resolver).toEqual([]);
    const loader = actions.filter((f) => /budget-carry-forward-build/.test(read(f)));
    expect(loader).toEqual(["actions/reports.ts"]);
    const materialize = actions.filter((f) => /budget-materialize/.test(read(f)));
    expect(materialize).toEqual(["actions/budgets.ts"]);
  });

  it("the Budget actions take a locator (entity, tag, month), never a Budget id, and every export starts with requireAuth()", () => {
    const src = read("actions/budgets.ts").replace(/\r\n/g, "\n"); // the file is CRLF in the working tree
    expect(src).toMatch(/const LocatorSchema = z\.object\(\{\s*entityId: z\.string\(\)\.uuid\(\),\s*tagId: z\.string\(\)\.uuid\(\),/);
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const exported = code.split(/\nexport async function /).slice(1);
    expect(exported.map((b) => b.slice(0, b.indexOf("("))).sort()).toEqual(
      ["createBudget", "deleteBudget", "updateBudget", "updateBudgetAdditionalAmount", "updateBudgetLine"]
    );
    for (const block of exported) {
      const name = block.slice(0, block.indexOf("("));
      const body = block.slice(block.indexOf("{\n", block.indexOf(")")) + 2);
      expect(body.trimStart(), name).toMatch(/^(?:const user = )?await requireAuth\(\);/);
      const params = block.slice(block.indexOf("(") + 1, block.indexOf("{\n"));
      expect(params, name).not.toMatch(/\b(budgetId|id)\s*:\s*string/);
    }
    // the writes run inside ONE interactive transaction, the lock taken first, and revalidate the dashboard too
    expect(src).toMatch(/db\.\$transaction\(async \(tx\) => \{\s*await lockBudgetWrites\(tx\);/);
    expect(src).toMatch(/revalidatePath\("\/"\)/);
    expect(src).not.toMatch(/\bdb\.budget\.|\bdb\.scheduledBill\./);
  });

  it("the materialize planner is pure and the write module is create-only plus the one end-line delete", () => {
    const planner = read("lib/budget-materialize.ts");
    expect(planner).not.toMatch(/from "@\/lib\/db"|from "\.\/db"|next\/|next-auth|server-only|\$transaction/);
    expect(planner).not.toMatch(/\bnew Date\(\)|Date\.now\(|process\.env/);
    expect(planner).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    // (comment lines are dropped: the header explains the pattern and names db.$transaction / requireAuth)
    const writer = read("lib/budget-materialize-build.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(writer).not.toMatch(/\bdb\.|from "@\/lib\/db"|requireAuth|next\/cache|revalidatePath|\$queryRaw/);
    expect(writer).toMatch(/skipDuplicates: true/);
    expect(writer).not.toMatch(/\.(upsert|updateMany|update)\(|\.delete\(/);
    const deleteIdx = writer.indexOf(".deleteMany(");
    expect(deleteIdx).toBeGreaterThan(writer.indexOf("export async function endLine("));
    expect((writer.match(/\.deleteMany\(/g) ?? []).length).toBe(1);
    // the carried set is saved without ever overwriting: no data copies rollover or the additional amount
    expect(read("lib/budget-materialize.ts")).toMatch(/additionalAmountCents: 0,/);
    expect(read("lib/budget-materialize.ts")).toMatch(/rolloverAmount: null,/);
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
