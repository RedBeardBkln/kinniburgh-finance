import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guard (carry-forward-seasonal-energy, step 2). The seasonal model reads existing transactions across
// accounts and (for the Personal house only) across entities, so:
//  1. only the new loader selects that extra data (nothing else matches the supplier payees);
//  2. the model and its helpers are pure; the loader is read-only; only the owner actions write the settings;
//  3. the client leaves stay light (no Decimal-bearing module as a value import);
//  4. every cash-flow consumer that should show an estimate passes the plan, and the screens that must not change do not
//     import the new modules.

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

const NEW_FILES = [
  "lib/seasonal-energy.ts",
  "lib/seasonal-energy-prices.ts",
  "lib/seasonal-energy-marks.ts",
  "lib/seasonal-energy-view.ts",
  "lib/seasonal-energy-build.ts",
  "actions/seasonal-settings.ts",
  "components/forecast/seasonal-card.tsx",
  "components/forecast/oil-price-form.tsx",
  "components/forecast/mccarthy-toggle.tsx",
];

describe("the new files exist", () => {
  it.each(NEW_FILES)("%s", (f) => expect(existsSync(join(root, f))).toBe(true));
});

describe("only the seasonal code looks at the supplier payees", () => {
  it("McCarthy appears only in the model, its view, its loader, the owner action and the card parts", () => {
    const users = SOURCE_FILES.filter((f) => /mccarthy/i.test(read(f))).sort();
    expect(users).toEqual(
      [
        "actions/seasonal-settings.ts",
        "components/forecast/mccarthy-toggle.tsx",
        "components/forecast/seasonal-card.tsx",
        "lib/seasonal-energy-build.ts",
        "lib/seasonal-energy-marks.ts",
        "lib/seasonal-energy-prices.ts",
        "lib/seasonal-energy-view.ts",
        "lib/seasonal-energy.ts",
      ].sort()
    );
  });

  it("the cross-entity inclusion is decided in exactly one place: the site facts + selectSitePayments", () => {
    const hits = SOURCE_FILES.filter((f) => /oilFromEntitySlugs/.test(read(f))).sort();
    expect(hits).toEqual(["actions/seasonal-settings.ts", "lib/seasonal-energy.ts"]);
    // the loader never filters transactions by entity itself: it hands every candidate row to the pure selector
    expect(read("lib/seasonal-energy-build.ts")).not.toMatch(/entityId:\s*\{\s*in:\s*\[?\s*(ekc|ek)/i);
  });

  it("Transaction rows for the model are read by the loader only (the action looks up ONE row to validate it)", () => {
    // the supplier payee terms are matched against Transaction text columns in one file only
    const readers = SOURCE_FILES.filter((f) => /contains:\s*(term\b|"(mccarthy|eversource|firewood)")/i.test(read(f))).sort();
    expect(readers).toEqual(["lib/seasonal-energy-build.ts"]);
  });
});

describe("purity and read-only", () => {
  it.each(["lib/seasonal-energy.ts", "lib/seasonal-energy-prices.ts", "lib/seasonal-energy-view.ts"])("%s has no database, clock or Next.js", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/from "@\/lib\/db"|from "\.\/db"|next\/|next-auth|server-only|@prisma\/client"(?!.*runtime)/);
    expect(src).not.toMatch(/\bnew Date\(\)|Date\.now\(|process\.env|Math\.random/);
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it("the loader is read-only with explicit selects, no auth, no cache calls", () => {
    const src = read("lib/seasonal-energy-build.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect(src).not.toMatch(/\binclude:/);
    expect(src).not.toMatch(/^"use server"/m);
    expect(src).not.toMatch(/next\/cache|revalidatePath|requireAuth|next-auth/);
    // every findMany carries a select
    const calls = src.match(/\.findMany\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c, c.slice(0, 60)).toMatch(/select:/);
  });

  it("only the owner actions write the seasonal settings, and they never write a Transaction", () => {
    const writers = SOURCE_FILES.filter((f) => /oil_price_history|oilPriceKey|oilExcludedKey|REPLACE_DRAWS_KEY/.test(read(f)) && /appSetting\.(upsert|update|create|delete)/.test(read(f)));
    expect(writers).toEqual(["actions/seasonal-settings.ts"]);
    expect(read("actions/seasonal-settings.ts")).not.toMatch(/db\.(transaction|scheduledBill|accrualDraw|accrualEnvelope|budget)\.(update|updateMany|create|createMany|delete|deleteMany|upsert)/);
  });

  it("the model never writes accrual draws, bills or budgets (grep of every new file)", () => {
    for (const f of NEW_FILES.filter((x) => x !== "actions/seasonal-settings.ts")) {
      expect(read(f), f).not.toMatch(/\.(accrualDraw|scheduledBill|accrualEnvelope|budget|transaction)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    }
  });

  it("the action file only exports async functions (a 'use server' rule) and starts with the directive", () => {
    const src = read("actions/seasonal-settings.ts");
    expect(src.startsWith('"use server";')).toBe(true);
    const exports = src.split("\n").filter((l) => l.startsWith("export "));
    expect(exports.length).toBeGreaterThan(0);
    for (const e of exports) expect(e).toMatch(/^export async function /);
  });
});

describe("client leaves stay light", () => {
  it.each(["components/forecast/oil-price-form.tsx", "components/forecast/mccarthy-toggle.tsx"])("%s imports only the action and TYPES from the view", (f) => {
    const src = read(f);
    expect(src.startsWith('"use client";')).toBe(true);
    const imports = [...src.matchAll(/^import (type )?[^;]*from "([^"]+)";/gm)];
    for (const [, isType, mod] of imports) {
      if (/seasonal-energy(?!-?settings)/.test(mod!) || mod!.includes("lib/seasonal-energy")) expect(isType, `${f}: ${mod}`).toBe("type ");
      expect(mod).not.toMatch(/@prisma|seasonal-energy-build|lib\/db/);
    }
  });

  it("no client component imports the model or the loader as a value", () => {
    const clients = SOURCE_FILES.filter((f) => /^["']use client["']/m.test(read(f)));
    for (const f of clients) {
      expect(read(f), f).not.toMatch(/^import (?!type)[^;]*from "@\/lib\/seasonal-energy(-build)?";/m);
    }
  });
});

describe("consumers", () => {
  const PLAN_CONSUMERS = [
    "app/forecast/page.tsx",
    "actions/envelope.ts",
    "lib/account-scheduled-flows.ts",
    "lib/advisor/tools/get-forecast.ts",
    "lib/upcoming-ledger.ts",
  ];
  it.each(PLAN_CONSUMERS)("%s passes a seasonal plan to the bill generator", (f) => {
    const src = read(f);
    expect(src).toMatch(/planForBill\(/);
    expect(src).toMatch(/generateBillOccurrencesBudgetDated/);
  });

  it("the Forecast page passes the plan at all three generator calls and reads the plans once, fail-soft", () => {
    const src = read("app/forecast/page.tsx");
    expect((src.match(/generateBillOccurrencesBudgetDated\(/g) ?? []).length).toBe(3);
    expect((src.match(/planForBill\(seasonalLoad\.plans, b\)/g) ?? []).length).toBe(3);
    expect(src).toMatch(/loadSeasonalPlansSafe\(/);
    expect(src).toMatch(/loadSeasonalEnergySafe\(/);
    expect(src).toMatch(/planForLine\(/); // the Category Spend Pace target
  });

  it("the ledger loader and the assistant read the plans through the Safe loaders", () => {
    expect(read("lib/upcoming-ledger-build.ts")).toMatch(/loadSeasonalPlansSafe\(/);
    expect(read("lib/advisor/queries/forecast.ts")).toMatch(/loadSeasonalPlansSafe\(/);
    expect(read("lib/advisor/queries/budgets.ts")).toMatch(/loadSeasonalPlansSafe\(/);
  });

  it("the screens that must not change never import the new modules: Budgets, the tax code, the review code", () => {
    const protectedFiles = SOURCE_FILES.filter(
      (f) =>
        f.startsWith("app/budgets/") ||
        f.startsWith("components/budgets/") ||
        f === "actions/budgets.ts" ||
        f === "lib/budget-nesting.ts" ||
        f === "lib/budget.ts" ||
        f.startsWith("lib/tax2025/") ||
        f.startsWith("lib/tax-review/") ||
        f.startsWith("lib/tax-facts/")
    );
    expect(protectedFiles.length).toBeGreaterThan(20);
    for (const f of protectedFiles) expect(read(f), f).not.toMatch(/seasonal-energy/);
  });

  it("the pure ledger imports the pure model only (never the loader)", () => {
    expect(read("lib/upcoming-ledger.ts")).not.toMatch(/seasonal-energy-build/);
    expect(read("lib/bill-dates.ts")).not.toMatch(/seasonal-energy-build|seasonal-energy-view/);
  });
});
