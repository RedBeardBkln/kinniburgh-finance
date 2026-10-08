import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { OWNER_STATEMENTS_VERSION } from "@/lib/tax-review/llm/owner-statements";
import { FINGERPRINT_PART_NAMES } from "@/lib/tax-review/fingerprint";
import { TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";

// The carry screen must not touch the TY2025 return: no protected file mentions it, it imports none of the engine, the
// review or the owner statements, and the fingerprint inputs are unchanged. Pure source-reading tests.

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".claude" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const CARRY_FILES = [
  "lib/tax-facts/carry-target.ts",
  "lib/tax-facts/carry-screen.ts",
  "actions/tax-facts-carry.ts",
  "app/tax/facts/carry/page.tsx",
  "app/tax/facts/carry/[year]/page.tsx",
  "components/tax/facts/carry-forward-review.tsx",
  "components/tax/facts/carry-row-actions.tsx",
];

describe("protected trees never mention the carry screen", () => {
  const files = ["lib", "actions", "app", "components"].flatMap((d) => walk(join(ROOT, d))).map(rel);
  const protectedFile = (f: string) =>
    f.startsWith("lib/tax2025/") ||
    f.startsWith("lib/tax-review/") ||
    /^lib\/tax2025-[^/]*\.ts$/.test(f) ||
    /^lib\/tax-review-[^/]*\.ts$/.test(f) ||
    /^actions\/tax-review[^/]*\.ts$/.test(f) ||
    /^actions\/tax-return[^/]*\.ts$/.test(f) ||
    f.startsWith("app/api/tax/forms/");

  it("scans a non-vacuous protected set", () => {
    expect(files.filter(protectedFile).length).toBeGreaterThan(50);
  });

  it("no protected file mentions tax-facts, carry-target, carry-screen or changeTaxFactForCarry", () => {
    for (const f of files.filter(protectedFile)) {
      expect(/tax-facts|taxFact|TaxFact|carry-target|carry-screen|changeTaxFactForCarry/.test(read(join(ROOT, f))), f).toBe(false);
    }
  });
});

describe("the carry files import none of the engine, the review or the owner statements", () => {
  it("every carry file exists", () => {
    for (const f of CARRY_FILES) expect(read(join(ROOT, f)).length, f).toBeGreaterThan(100);
  });

  it("imports nothing from lib/tax2025, lib/tax-review, tax-review actions or owner-statements", () => {
    for (const f of CARRY_FILES) {
      const imports = [...read(join(ROOT, f)).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec.includes("owner-statements"), `${f} imports ${spec}`).toBe(false);
        expect(spec.startsWith("@/lib/tax2025"), `${f} imports ${spec}`).toBe(false);
        expect(spec.startsWith("@/lib/tax-review"), `${f} imports ${spec}`).toBe(false);
        expect(/@\/actions\/tax-(review|return)/.test(spec), `${f} imports ${spec}`).toBe(false);
      }
    }
  });
});

describe("auth gates", () => {
  it("the server action starts with requireAuth()", () => {
    const src = read(join(ROOT, "actions/tax-facts-carry.ts"));
    const open = src.indexOf("{\n", src.indexOf("export async function changeTaxFactForCarry")) + 2;
    expect(src.slice(open, open + 40).trimStart().startsWith("await requireAuth();")).toBe(true);
  });

  it("both carry pages check the session and redirect to /login before anything else", () => {
    for (const f of ["app/tax/facts/carry/page.tsx", "app/tax/facts/carry/[year]/page.tsx"]) {
      const src = read(join(ROOT, f));
      const open = src.indexOf("{\n", src.indexOf("export default async function")) + 2;
      expect(src.slice(open, open + 90).replace(/\s+/g, " ").trimStart(), f).toMatch(/^const session = await auth\(\); if \(!session\?\.user\) redirect\("\/login"\);/);
    }
  });

  it("the carry pages and components write nothing directly (no db import, no prisma call)", () => {
    for (const f of CARRY_FILES.filter((x) => x !== "actions/tax-facts-carry.ts")) {
      const src = read(join(ROOT, f));
      expect(src, f).not.toMatch(/@\/lib\/db"|\bdb\./);
      expect(src, f).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/);
    }
  });
});

describe("append-only: the carry code has no destructive taxFact call", () => {
  it("walks the carry files and the whole tree", () => {
    for (const f of CARRY_FILES) {
      expect(/taxFact\s*\.\s*(delete|deleteMany|upsert|update|updateMany|create|createMany)\b/.test(read(join(ROOT, f))), f).toBe(false);
    }
    const all = ["lib", "actions", "app", "components"].flatMap((d) => walk(join(ROOT, d))).filter((p) => !p.includes(`${sep}__tests__${sep}`));
    expect(all.some((p) => rel(p) === "actions/tax-facts-carry.ts")).toBe(true);
    for (const p of all) expect(/taxFact\s*\.\s*(delete|deleteMany|upsert)\b/.test(read(p)), rel(p)).toBe(false);
  });
});

describe("approved-return inputs are unchanged", () => {
  it("OWNER_STATEMENTS_VERSION is still 5 and the fingerprint still has the nine parts", () => {
    expect(OWNER_STATEMENTS_VERSION).toBe(5);
    expect([...FINGERPRINT_PART_NAMES]).toEqual([
      "engine", "view", "answers", "header", "facts", "documents", "questionnaires", "overrides", "decisions",
    ]);
  });

  it("the engine version is the pinned literal", () => {
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.11");
  });
});
