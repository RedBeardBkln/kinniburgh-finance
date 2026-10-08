import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { OWNER_STATEMENTS_VERSION } from "@/lib/tax-review/llm/owner-statements";
import { FINGERPRINT_PART_NAMES } from "@/lib/tax-review/fingerprint";
import { TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";

// The assistant reads the platform; nothing in the TY2025 engine, the fingerprint, the AI reviewer, the PDFs, the approval flow or the
// year-close ever imports it (advisor-ai-chatbot plan 4.4 item 8). Pure source-reading tests.

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
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
const importsOf = (src: string): string[] => [...src.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!);

const allFiles = ["lib", "actions", "app", "components"].flatMap((d) => walk(join(ROOT, d))).map(rel);
const isProtected = (f: string) =>
  f.startsWith("lib/tax2025/") ||
  f.startsWith("lib/tax-review/") ||
  f.startsWith("lib/tax-year-close/") ||
  /^lib\/tax2025-[^/]*\.ts$/.test(f) ||
  /^lib\/tax-review-[^/]*\.ts$/.test(f) ||
  /^actions\/tax-review[^/]*\.ts$/.test(f) ||
  /^actions\/tax-return[^/]*\.ts$/.test(f) ||
  f.startsWith("app/api/tax/forms/") ||
  f === "lib/tax-compute.ts";

const advisorFiles = allFiles.filter((f) => f.startsWith("lib/advisor/") || /^actions\/advisor[^/]*\.ts$/.test(f) || f.startsWith("app/api/advisor/") || f.startsWith("components/advisor/") || f === "app/advisor/page.tsx");

describe("no protected tax file imports the assistant", () => {
  it("sees the protected trees and the advisor tree (the scan is not vacuous)", () => {
    expect(allFiles.filter(isProtected).length).toBeGreaterThan(80);
    expect(advisorFiles.length).toBeGreaterThan(15);
  });

  it("imports nothing from lib/advisor, actions/advisor, components/advisor or app/api/advisor", () => {
    for (const f of allFiles.filter(isProtected)) {
      for (const spec of importsOf(read(join(ROOT, f)))) {
        expect(/advisor/i.test(spec) && !/advisor-context/.test(spec), `${f} imports ${spec}`).toBe(false);
      }
    }
  });

  it("does not mention the assistant's modules by path or name", () => {
    for (const f of allFiles.filter(isProtected)) {
      const src = read(join(ROOT, f));
      expect(/lib\/advisor\/|actions\/advisor|components\/advisor|api\/advisor|AdvisorMemory|AdvisorConversation|runTurn/.test(src), f).toBe(false);
    }
  });
});

describe("the assistant stays on the read side of the tax code", () => {
  it("never imports the AI reviewer's owner statements or reads them", () => {
    for (const f of advisorFiles) {
      const src = read(join(ROOT, f));
      for (const spec of importsOf(src)) expect(spec.includes("owner-statements"), `${f} imports ${spec}`).toBe(false);
      expect(/\.ownerStatements|OWNER_STATEMENTS/.test(src.replace(/\/\/.*$/gm, "")), f).toBe(false);
    }
  });

  it("no component imports a server-only advisor module or reads the environment", () => {
    const serverOnly = /@\/lib\/advisor\/(anthropic|store|loop|run-turn|queries|tools\/(?!types))/;
    for (const f of allFiles.filter((x) => x.startsWith("components/"))) {
      const src = read(join(ROOT, f));
      for (const spec of importsOf(src)) expect(serverOnly.test(spec), `${f} imports ${spec}`).toBe(false);
      if (f.startsWith("components/advisor/")) expect(/process\.env/.test(src), f).toBe(false);
    }
  });
});

describe("approved-return inputs are unchanged", () => {
  it("OWNER_STATEMENTS_VERSION is still 5 and the engine version is still ty2025-1b.11", () => {
    expect(OWNER_STATEMENTS_VERSION).toBe(5);
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.11");
  });

  it("the fingerprint still has exactly the nine parts", () => {
    expect([...FINGERPRINT_PART_NAMES]).toEqual(["engine", "view", "answers", "header", "facts", "documents", "questionnaires", "overrides", "decisions"]);
  });
});
