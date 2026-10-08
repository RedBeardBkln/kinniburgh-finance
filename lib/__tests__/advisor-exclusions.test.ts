import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ALLOWED_RAW_USES, FORBIDDEN_FIELDS, FORBIDDEN_MODELS, USER_DELEGATE_FILE } from "@/lib/advisor/exclusions";

// The assistant's data boundary, enforced on the SOURCE of every tool and query module (advisor-ai-chatbot plan section 4.4). The shaper
// tests with poisoned rows live next to each tool's tests; this file reads the code itself.

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Source without comments (a `://` URL is kept). */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");

const toolFiles = [...walk(join(ROOT, "lib/advisor/tools")), ...walk(join(ROOT, "lib/advisor/queries"))];
const advisorLib = walk(join(ROOT, "lib/advisor"));

/** The argument text of every Prisma call `db.<model>.<method>(...)` (balanced parentheses). */
function prismaCalls(src: string): { model: string; method: string; args: string }[] {
  const out: { model: string; method: string; args: string }[] = [];
  const re = /\b(?:db|tx)\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|groupBy|aggregate|count|create|createMany|update|updateMany|delete|deleteMany|upsert)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push({ model: m[1]!, method: m[2]!, args: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

describe("the scan is not vacuous", () => {
  it("sees the tool and query modules", () => {
    expect(toolFiles.length).toBeGreaterThanOrEqual(18);
    expect(toolFiles.some((f) => rel(f) === USER_DELEGATE_FILE)).toBe(true);
    expect(toolFiles.flatMap((f) => prismaCalls(stripComments(read(f)))).length).toBeGreaterThanOrEqual(9);
  });
});

describe("no tool or query reaches an excluded model or field", () => {
  it("never touches Vault, Plaid, session, token, push or review-link delegates", () => {
    for (const f of toolFiles) {
      const src = stripComments(read(f));
      for (const model of FORBIDDEN_MODELS.filter((x) => x !== "user")) {
        expect(new RegExp(`\\b(?:db|tx)\\.${model}\\b`).test(src), `${rel(f)} uses ${model}`).toBe(false);
        expect(new RegExp(`prisma\\.${model}\\b`).test(src), `${rel(f)} uses prisma.${model}`).toBe(false);
      }
    }
  });

  it("reads the user table only in queries/people.ts, and only id and name", () => {
    for (const f of toolFiles) {
      const src = stripComments(read(f));
      const users = prismaCalls(src).filter((c) => c.model === "user");
      if (rel(f) === USER_DELEGATE_FILE) {
        expect(users).toHaveLength(1);
        expect(users[0]!.args.replace(/\s+/g, " ")).toContain("select: { id: true, name: true }");
      } else {
        expect(users, rel(f)).toHaveLength(0);
        expect(/\b(?:db|tx)\.user\b/.test(src), rel(f)).toBe(false);
      }
    }
  });

  it("names none of the forbidden fields (outside the documented raw-extraction allowance)", () => {
    for (const f of toolFiles) {
      const src = stripComments(read(f));
      const allowed = ALLOWED_RAW_USES[rel(f)] ?? [];
      for (const field of FORBIDDEN_FIELDS) {
        if (allowed.includes(field)) continue;
        expect(new RegExp(`\\b${field}\\b`).test(src), `${rel(f)} names ${field}`).toBe(false);
      }
    }
  });

  it("allows raw-extraction fields in exactly one file: the document-values query", () => {
    expect(ALLOWED_RAW_USES).toEqual({
      "lib/advisor/queries/document-values.ts": ["extractionData", "extractionCorrections", "extractionConfirmedAt", "extractionStatus"],
    });
  });

  it("the document-values query reads extraction values only through resolveTaxDocForCompute, names the raw columns only inside select blocks, and never iterates the extraction object", () => {
    const f = join(ROOT, "lib/advisor/queries/document-values.ts");
    expect(existsSync(f)).toBe(true);
    const src = stripComments(read(f));
    expect(src).toMatch(/import \{[^}]*\bresolveTaxDocForCompute\b[^}]*\} from "@\/lib\/tax-extraction-policy"/);
    expect(src).toMatch(/\bresolveTaxDocForCompute\(/);
    // every mention of a raw column sits inside a `select: { ... }` block
    const selects = [...src.matchAll(/select:\s*\{/g)].map((m) => {
      let depth = 1;
      let i = m.index! + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      return [m.index!, i] as const;
    });
    for (const col of ["extractionData", "extractionCorrections"]) {
      const hits = [...src.matchAll(new RegExp(`\\b${col}\\b`, "g"))];
      expect(hits.length, col).toBeGreaterThan(0);
      // inside a select block, or the property of the RESOLVED (effective) result: `resolved.extractionData`
      for (const h of hits) {
        const inSelect = selects.some(([a, b]) => h.index! >= a && h.index! < b);
        const onResolved = src.slice(Math.max(0, h.index! - "resolved.".length), h.index!) === "resolved.";
        expect(inSelect || onResolved, `${col} outside a select block`).toBe(true);
      }
      if (col === "extractionCorrections") expect(hits.every((h) => selects.some(([a, b]) => h.index! >= a && h.index! < b)), "corrections are never read outside the select").toBe(true);
    }
    expect(/JSON\.stringify|Object\.(keys|entries|values)|for\s*\(\s*(const|let)\s+\w+\s+(in|of)/.test(src)).toBe(false);
  });

  it("no other advisor file (tools, queries or lib) names the raw extraction value columns", () => {
    for (const f of advisorLib) {
      // exclusions.ts is the boundary-as-data file: it lists these names to forbid them.
      if (rel(f) === "lib/advisor/queries/document-values.ts" || rel(f) === "lib/advisor/exclusions.ts") continue;
      const src = stripComments(read(f));
      for (const col of ["extractionData", "extractionCorrections", "extractionRaw", "ocrRaw"]) {
        expect(new RegExp(`\\b${col}\\b`).test(src), `${rel(f)} names ${col}`).toBe(false);
      }
    }
  });

  it("imports nothing from the Vault, Plaid, encryption or session modules, and reads no environment", () => {
    for (const f of advisorLib) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
        expect(/vault|plaid|encrypt|@\/lib\/auth|next-auth|supabase-storage/i.test(m[1]!), `${rel(f)} imports ${m[1]}`).toBe(false);
      }
      if (rel(f) !== "lib/advisor/config.ts" && rel(f) !== "lib/advisor/anthropic.ts") {
        expect(/process\.env/.test(src), `${rel(f)} reads process.env`).toBe(false);
      }
    }
  });
});

describe("every query selects explicitly", () => {
  it("each find* call has a select, and include is banned", () => {
    for (const f of toolFiles) {
      const src = stripComments(read(f));
      expect(/\binclude\s*:/.test(src), `${rel(f)} uses include`).toBe(false);
      for (const c of prismaCalls(src)) {
        if (/^find/.test(c.method)) expect(/\bselect\s*:/.test(c.args), `${rel(f)}: ${c.model}.${c.method} has no select`).toBe(true);
      }
    }
  });
});

describe("raw SQL", () => {
  it("is used only in queries/spend.ts, only as tagged templates", () => {
    for (const f of advisorLib) {
      const src = stripComments(read(f));
      expect(/\$queryRawUnsafe|\$executeRaw|\$executeRawUnsafe/.test(src), `${rel(f)} unsafe/executing raw SQL`).toBe(false);
      if (rel(f) !== "lib/advisor/queries/spend.ts") expect(/\$queryRaw/.test(src), `${rel(f)} uses $queryRaw`).toBe(false);
    }
    const spend = stripComments(read(join(ROOT, "lib/advisor/queries/spend.ts")));
    const uses = [...spend.matchAll(/\$queryRaw/g)].length;
    const tagged = [...spend.matchAll(/\$queryRaw<[^`]*?>`/g)].length;
    expect(uses).toBeGreaterThanOrEqual(7);
    expect(tagged).toBe(uses);
  });

  it("the SQL names no excluded table or field", () => {
    const spend = stripComments(read(join(ROOT, "lib/advisor/queries/spend.ts")));
    const sql = [...spend.matchAll(/\$queryRaw<[^`]*?>`([\s\S]*?)`/g)].map((m) => m[1]!).join("\n");
    expect(sql.length).toBeGreaterThan(1_000);
    for (const field of FORBIDDEN_FIELDS) expect(new RegExp(`\\b${field}\\b`).test(sql), field).toBe(false);
    for (const model of FORBIDDEN_MODELS) {
      const table = model[0]!.toUpperCase() + model.slice(1);
      expect(new RegExp(`"${table}"`).test(sql), table).toBe(false);
    }
    // Only these tables are read.
    const tables = new Set([...sql.matchAll(/(?:FROM|JOIN)\s+"(\w+)"/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(["Account", "Entity", "Tag", "Transaction", "TransactionTag"]);
  });
});

describe("the assistant's tools and queries never write", () => {
  it("has no create / update / delete / upsert in tools/** or queries/**", () => {
    for (const f of toolFiles) {
      const src = stripComments(read(f));
      expect(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(src), rel(f)).toBe(false);
    }
  });

  it("only lib/advisor/store.ts writes anywhere in lib/advisor (conversation / message / usage / memory / audit tables only)", () => {
    for (const f of advisorLib) {
      const src = stripComments(read(f));
      const writes = prismaCalls(src).filter((c) => /^(create|createMany|update|updateMany|delete|deleteMany|upsert)$/.test(c.method));
      if (rel(f) === "lib/advisor/store.ts") {
        expect(writes.length).toBeGreaterThan(5);
        for (const w of writes) expect(["advisorConversation", "advisorMessage", "advisorMemory", "advisorUsage", "auditLog"], `store writes ${w.model}`).toContain(w.model);
      } else {
        expect(writes, rel(f)).toHaveLength(0);
      }
    }
  });
});
