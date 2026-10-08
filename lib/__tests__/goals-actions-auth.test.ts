import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// actions/goals.ts used to have no auth gate at all (a server action is addressable by id, so the page redirect is not
// a boundary). Every export must now start with the file-local requireAuth() call. Pure source-reading test.

const SRC = readFileSync(resolve(__dirname, "../../actions/goals.ts"), "utf8").replace(/\r\n/g, "\n");

function exportedBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export async function (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Walk from the opening "(" to its matching ")" (parameter types may contain braces), then take the next "{".
    let depth = 0;
    let i = src.indexOf("(", m.index);
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const bodyStart = src.indexOf("{", i);
    out.push({ name: m[1]!, body: src.slice(bodyStart + 1, bodyStart + 80) });
  }
  return out;
}

describe("actions/goals.ts auth gate", () => {
  const exportsFound = exportedBodies(SRC);

  it("finds all five exports (not vacuous)", () => {
    expect(exportsFound.map((e) => e.name)).toEqual(["listGoals", "createGoal", "updateGoal", "updateGoalStatus", "deleteGoal"]);
  });

  it("every export starts with await requireAuth()", () => {
    for (const e of exportsFound) {
      expect(e.body.trimStart().startsWith("await requireAuth();"), e.name).toBe(true);
    }
  });

  it("requireAuth is file-local, not exported, and throws without a session user id", () => {
    expect(SRC).toMatch(/\nasync function requireAuth\(\): Promise<\{ id: string \}> \{/);
    expect(SRC).not.toMatch(/export (async )?function requireAuth/);
    expect(SRC).toMatch(/if \(!session\?\.user\?\.id\) throw new Error\("Unauthorized"\);/);
  });
});
