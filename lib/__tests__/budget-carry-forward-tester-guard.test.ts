// TESTER (carry-forward-seasonal-energy, step 1): a broader source scan than the Coder's guard. Their regex only sees
// the literal `db|tx|prisma .budget.<verb>`; an alias, a bracket access, a destructure, a renamed import, a line break,
// raw SQL on "Budget" or a relation include of `budgets` all slip through. This scanner covers those forms, is proved
// against in-memory probe strings (each form must be detected, the safe forms must not be), and then asserts that the
// real tree reads the Budget table only from the allow-listed files.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

/** Violations a source text contains: every way of reaching the Budget table that the plain regex can miss. */
function budgetTableAccessForms(src: string): string[] {
  const forms: string[] = [];
  const add = (name: string, re: RegExp) => {
    if (re.test(src)) forms.push(name);
  };
  add("dotted", /\b(?:db|tx|trx|prisma|client)\s*\.\s*budget\b(?!\s*[:=(])/);
  add("bracket", /\[\s*["'`]budget["'`]\s*\]/);
  add("destructure", /\{[^}]*\bbudget\b[^}]*\}\s*=\s*(?:db|tx|trx|prisma|client)\b/);
  add("raw-sql", /(?:\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe)[\s\S]{0,400}?["']?Budget["']?\s/);
  add("relation-include", /\bbudgets\s*:\s*(?:true|\{)/);
  return forms;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "__tests__" || ent.name.startsWith("zz-tester")) continue;
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel);
  }
  return out;
}

describe("TESTER: the broader Budget-access scanner detects what the plain regex misses", () => {
  const DETECTED: Record<string, string> = {
    direct: 'await db.budget.findMany({})',
    tx: "await tx.budget.update({})",
    renamedImport: "const r = await client.budget.findMany({})",
    newline: "await db.budget\n  .findMany({})",
    bracket: 'await db["budget"].findMany({})',
    destructure: "const { budget } = db;",
    raw: 'await db.$queryRaw`SELECT * FROM "Budget" WHERE period = ${p}`',
    include: "db.tag.findMany({ include: { budgets: true } })",
    includeObj: "db.entity.findMany({ select: { budgets: { select: { id: true } } } })",
  };
  for (const [name, src] of Object.entries(DETECTED)) {
    it(`detects: ${name}`, () => expect(budgetTableAccessForms(src).length, src).toBeGreaterThan(0));
  }
  const SAFE: Record<string, string> = {
    projectBudget: "const budget = new Decimal(p.budget.toString())",
    keyOnly: "const x = { budget: 3, actual: 4 }",
    dtoField: "d.budget > 0 || d.actual > 0",
    loader: "const rows = await loadEffectiveBudgetRows({ periods: [period] })",
    word: "// the Budget page shows lines",
    stateHook: "const [budget, setBudget] = useState(project.budget.toString())",
  };
  for (const [name, src] of Object.entries(SAFE)) {
    it(`does not flag: ${name}`, () => expect(budgetTableAccessForms(src), src).toEqual([]));
  }
});

describe("TESTER: the real tree reads the Budget table only from the allow-listed files, in ANY form", () => {
  const ALLOW = new Set([
    "lib/budget-carry-forward-build.ts",
    "app/budgets/page.tsx",
    "actions/budgets.ts",
    "actions/recurring-suggestions.ts",
    "actions/reports.ts",
    "app/page.tsx",
    "lib/monthly-review-build.ts",
  ]);
  const files = ["app", "lib", "actions", "components"].flatMap((d) => walk(d));
  it("scans a meaningful number of files", () => expect(files.length).toBeGreaterThan(400));
  it("no other file touches the table (dotted, bracket, destructured, raw SQL or relation include)", () => {
    const hits = files.filter((f) => budgetTableAccessForms(readFileSync(join(root, f), "utf8")).length > 0).sort();
    expect(hits.filter((f) => !ALLOW.has(f)), `unexpected readers: ${hits.join(", ")}`).toEqual([]);
  });
  it("the allow-listed non-loader files are all real-row screens/actions: none of them imports the loader or the resolver", () => {
    for (const f of ALLOW) {
      if (f === "lib/budget-carry-forward-build.ts") continue;
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/budget-carry-forward/);
    }
  });
  it("no server action file and no 'use server' file imports the carry-forward modules (a carried synthetic id can never reach an action)", () => {
    const bad = files.filter((f) => {
      const s = readFileSync(join(root, f), "utf8");
      return /budget-carry-forward/.test(s) && (f.startsWith("actions/") || /^["']use server["']/m.test(s)) && !f.startsWith("lib/budget-carry-forward");
    });
    expect(bad).toEqual([]);
  });
  it("any code that parses a Budget id for an update refuses the synthetic 'carried:' ids at its boundary, or never receives them", () => {
    // The Budgets actions take ids from /budgets rows (real rows only). Pin that /budgets never sees carried rows.
    const page = readFileSync(join(root, "app/budgets/page.tsx"), "utf8");
    expect(page).not.toMatch(/carried|loadEffective/);
  });
});
