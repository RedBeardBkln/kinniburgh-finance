// L2 independence and purity (plan 5.4): the recalculation must be a SEPARATELY written calculator. It may import from lib/tax2025 only the
// numeric constants registry (constants.ts) and the data-only line catalog (line-catalog.ts), plus TYPES from facts / types / overrides. It
// may not import any rule, the return assembler, the derive / inputs / money helpers, the legacy tax-compute helpers or the DB. It has no
// clock, no network, no random source and no floating point money helpers.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.join(process.cwd(), "lib", "tax-review", "l2");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

interface Import {
  spec: string;
  typeOnly: boolean;
}

function importsOf(text: string): Import[] {
  const out: Import[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const clause = m[3] ?? "";
    // `import { a, type B } from` is a value import (a); only `import type { ... }` is type-only
    out.push({ spec: m[4] as string, typeOnly: m[2] !== undefined && clause !== undefined });
  }
  // side-effect and dynamic imports are not allowed at all
  expect(/(^|\n)\s*import\s+["']/.test(text), "side-effect import").toBe(false);
  expect(/\bimport\(/.test(text), "dynamic import").toBe(false);
  expect(/\brequire\(/.test(text), "require").toBe(false);
  return out;
}

const VALUE_ALLOWED = new Set(["@/lib/tax2025/constants", "@/lib/tax2025/line-catalog", "@/lib/tax-review/types"]);
const TYPE_ALLOWED = new Set(["@/lib/tax2025/facts", "@/lib/tax2025/types", "@/lib/tax2025/overrides", "@/lib/tax2025/line-catalog", "@/lib/tax-review/types"]);

describe("lib/tax-review/l2 is a separately written calculator", () => {
  it("exists with the expected modules", () => {
    expect(files).toEqual(expect.arrayContaining(["money.ts", "tables.ts", "federal.ts", "ct.ts", "diff.ts", "coverage.ts", "run.ts", "ledger.ts", "engine-view.ts"]));
  });

  for (const file of files) {
    const text = readFileSync(path.join(DIR, file), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    it(`${file}: imports only the constants registry, the data-only line catalog, types, and its own modules`, () => {
      for (const imp of importsOf(text)) {
        if (imp.spec.startsWith("@/lib/tax-review/l2/")) continue;
        if (imp.typeOnly) {
          expect(TYPE_ALLOWED.has(imp.spec), `${file} imports type ${imp.spec}`).toBe(true);
        } else {
          expect(VALUE_ALLOWED.has(imp.spec), `${file} imports ${imp.spec}`).toBe(true);
        }
      }
    });

    it(`${file}: no engine rule, assembler, helper, tax-compute, DB, network, clock, random or float-money code`, () => {
      for (const banned of [
        "tax2025/rules",
        "tax2025/return",
        "tax2025/derive",
        "tax2025/inputs",
        "tax2025/money",
        "tax2025/resolve-facts",
        "tax2025/pdf",
        "tax-compute",
        "tax2025-build",
        "@/lib/db",
        "@prisma",
        "decimal.js",
        "node:fs",
        "node:path",
        "node:crypto",
      ]) {
        expect(code.includes(banned), `${file} mentions ${banned}`).toBe(false);
      }
      for (const re of [/\bfetch\(/, /Date\.now\(/, /new Date\(/, /Math\.random\(/, /process\.env/, /\.toFixed\(/, /parseFloat\(/, /\bany\b\s*[;,)>=]/]) {
        expect(re.test(code), `${file} matches ${re}`).toBe(false);
      }
    });
  }

  it("the scanner itself flags a rule import, a value import from a types-only module and a re-export", () => {
    const rule = importsOf(`import { computeScheduleA } from "@/lib/tax2025/rules/schedule-a";`)[0]!;
    expect(rule).toEqual({ spec: "@/lib/tax2025/rules/schedule-a", typeOnly: false });
    expect(VALUE_ALLOWED.has(rule.spec) || TYPE_ALLOWED.has(rule.spec)).toBe(false);
    const value = importsOf(`import { emptyReturnAnswers } from "@/lib/tax2025/facts";`)[0]!;
    expect(value.typeOnly).toBe(false);
    expect(VALUE_ALLOWED.has(value.spec)).toBe(false);
    const type = importsOf(`import type { Ty2025Facts } from "@/lib/tax2025/facts";`)[0]!;
    expect(type.typeOnly).toBe(true);
    expect(TYPE_ALLOWED.has(type.spec)).toBe(true);
    const reexport = importsOf(`export { qdcgWorksheet } from "@/lib/tax2025/rules/tax-calc";`)[0]!;
    expect(VALUE_ALLOWED.has(reexport.spec)).toBe(false);
  });

  it("the L2 constants it uses all exist in the registry (a typo would be a runtime crash on the real return)", async () => {
    const { K } = await import("@/lib/tax2025/constants");
    const used = new Set<string>();
    for (const file of files) {
      const text = readFileSync(path.join(DIR, file), "utf8");
      for (const m of text.matchAll(/\bK\.([A-Z0-9_]+)\b/g)) used.add(m[1] as string);
    }
    expect(used.size).toBeGreaterThan(30);
    for (const id of used) expect(Object.keys(K), id).toContain(id);
  });

  it("repeats no tax constant that the registry already carries as a literal in the federal and Connecticut calculators, except the printed table rows", () => {
    // the printed Tax Computation Worksheet / CT tables are transcribed on purpose (tables.ts); the line-by-line calculators use K only
    for (const file of ["federal.ts", "ct.ts"]) {
      const code = readFileSync(path.join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const literal of ["31_500", "31500", "176_100", "176100", "250_000", "394_600", "137_000", "1_252_700", "239_100", "600_050", "96_700", "24_000", "102_000", "100_500", "70_500"]) {
        expect(code.includes(literal), `${file} repeats ${literal}`).toBe(false);
      }
    }
  });
});
