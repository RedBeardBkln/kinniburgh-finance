import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard (net-income-budget-dates). Two owner rules:
//  1. Forecasts use NET take-home pay, never the stored gross IncomeSource.amount. The ONLY module that reads
//     `incomeSource` rows for forecasting is lib/net-income-build.ts (the shared loader); every forecast, ledger,
//     notification and advisor path gets its paychecks from it.
//  2. A bill linked to a Budget line is dated by the Budget row. The ONLY module that calls the plain bill generator
//     is lib/bill-dates.ts (the month-by-month wrapper); lib/forecast.ts defines it.

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

/** A read of income sources: a direct query, or an include of the relation. */
const INCOME_READ_RE = /incomeSource\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|aggregate|groupBy)|incomeSources:\s*(\{|true)/;
const GENERATOR_CALL_RE = /\bgenerateBillOccurrences\s*\(/;

/** Files that may read income sources directly, and why. */
const INCOME_READ_ALLOW: Record<string, string> = {
  "lib/net-income-build.ts": "the shared take-home loader (the one forecast-side reader)",
  "actions/income-sources.ts": "CRUD of the stored GROSS amount (Income page / Settings)",
  "actions/paystubs.ts": "writer: syncs the stored gross amount from a confirmed paystub",
  "app/settings/income-sources/page.tsx": "Settings > Income sources edits the stored gross amount",
  "app/personal/income/page.tsx": "the Income page shows the stored gross amount (header says 'Gross per paycheck')",
};

describe("no forecast path reads the gross IncomeSource.amount directly", () => {
  it("only the shared loader and the gross-amount screens read incomeSource rows", () => {
    // (cheap substring test first: the repo has several hundred source files)
    const readers = SOURCE_FILES.filter((f) => read(f).includes("ncomeSource") && INCOME_READ_RE.test(read(f))).sort();
    expect(readers).toEqual(Object.keys(INCOME_READ_ALLOW).sort());
  });

  const INCOME_CONSUMERS = [
    "app/forecast/page.tsx",
    "lib/account-scheduled-flows.ts",
    "lib/upcoming-ledger-input.ts",
    "lib/notifications.ts",
    "actions/envelope.ts",
    "lib/advisor/queries/forecast.ts",
    "lib/advisor/queries/schedule.ts",
    "lib/advisor-context.ts",
  ];
  it.each(INCOME_CONSUMERS)("%s gets paychecks from loadNetIncomeSources", (file) => {
    const src = read(file);
    expect(src).toContain("loadNetIncomeSources");
    expect(src).not.toMatch(INCOME_READ_RE);
  });

  it("the pure ledger / forecast / notification / advisor modules never touch the relation", () => {
    for (const file of ["lib/forecast.ts", "lib/upcoming-ledger.ts", "lib/upcoming-ledger-view.ts", "lib/advisor/tools/get-forecast.ts", "lib/advisor/tools/list-recurring-and-scheduled.ts"]) {
      expect(read(file)).not.toMatch(INCOME_READ_RE);
    }
  });

  it("the flagged gross-unknown row prints the label once: the Forecast page adds no prefix of its own", () => {
    const page = read("app/forecast/page.tsx");
    expect(page).not.toContain("Gross used, take-home unknown: ");
    expect(page).toContain("{s.netInfo.label}");
  });

  it("no screen says the forecast uses the gross amount: Settings and paystub copy point to take-home", () => {
    expect(read("app/settings/income-sources/page.tsx")).toContain("the forecast uses your take-home");
    for (const f of ["components/settings/add-income-source-form.tsx", "components/settings/edit-income-source-button.tsx"]) {
      expect(read(f)).toContain("Gross amount per paycheck ($)");
      expect(read(f)).not.toContain(">Amount ($)<");
    }
    expect(read("components/income/paystub-confirm-form.tsx")).not.toContain("forecast now uses this cadence and amount");
    expect(read("components/income/paystub-confirm-form.tsx")).not.toContain("reflects real take-home");
  });

  it("the Income page and Settings still show the STORED amount, labelled gross", () => {
    expect(read("components/income/income-sources-card.tsx")).toContain("Gross per paycheck");
    expect(read("app/forecast/page.tsx")).toContain("Gross amount per paycheck");
  });

  it("the loader is read-only and has no auth or clock dependence beyond `now`", () => {
    const src = read("lib/net-income-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toMatch(/\$executeRaw|\$queryRaw|\$transaction/);
    expect(src).not.toMatch(/next\/cache|@\/lib\/auth|next-auth/);
    expect(src).not.toMatch(/\binclude:/); // explicit selects only
  });

  it("the resolver is pure: no database, no clock, no network", () => {
    const src = read("lib/net-income.ts");
    expect(src).not.toMatch(/@\/lib\/db|PrismaClient|fetch\(|Date\.now\(\)|new Date\(\)/);
  });
});

describe("a Budget-linked bill is dated by its Budget row", () => {
  it("only lib/bill-dates.ts calls the plain bill generator (lib/forecast.ts defines it)", () => {
    const callers = SOURCE_FILES.filter((f) => read(f).includes("generateBillOccurrences") && GENERATOR_CALL_RE.test(read(f))).sort();
    // lib/forecast.ts matches because of the `export function generateBillOccurrences(` definition itself.
    expect(callers).toEqual(["lib/bill-dates.ts", "lib/forecast.ts"]);
  });

  const BILL_CONSUMERS = [
    "app/forecast/page.tsx",
    "lib/account-scheduled-flows.ts",
    "lib/advisor/tools/get-forecast.ts",
    "lib/notifications.ts",
    "actions/envelope.ts",
    "lib/upcoming-ledger.ts",
  ];
  it.each(BILL_CONSUMERS)("%s dates bills through lib/bill-dates", (file) => {
    const src = read(file);
    expect(src).toMatch(/generateBillOccurrencesBudgetDated|effectiveSchedule/);
    expect(src).not.toMatch(GENERATOR_CALL_RE);
  });

  it("the Budget index loader is read-only with an explicit select and fail-soft", () => {
    const src = read("lib/bill-dates-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toMatch(/\binclude:/);
    expect(src).toMatch(/failed: true/);
    expect(src).not.toMatch(/budgeted/); // never reads amounts
  });

  it("lib/forecast.ts is untouched by this feature: it has no import of the new modules", () => {
    const src = read("lib/forecast.ts");
    expect(src).not.toMatch(/bill-dates|net-income/);
  });

  it("the new files exist", () => {
    for (const f of ["lib/net-income.ts", "lib/net-income-build.ts", "lib/bill-dates.ts", "lib/bill-dates-build.ts"]) expect(existsSync(join(root, f))).toBe(true);
  });

  it("the tax engine, the reviewer and the advisor tax tools do not import the new modules", () => {
    const tax = SOURCE_FILES.filter((f) => f.startsWith("lib/tax2025/") || f.startsWith("lib/tax-review/"));
    for (const f of tax) expect(read(f)).not.toMatch(/net-income|bill-dates/);
  });
});
