import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Source-reading pins for the assistant's HTTP surface (advisor-ai-chatbot plan sections 8, 12 and 17 A): auth first, route configuration,
// no secrets in components, the one place the API key is read, and the isolation test's rule that nothing under app/api names the year-close.

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const routeFiles = walk(join(ROOT, "app/api/advisor"));

describe("every app/api/advisor handler starts with the auth gate", () => {
  it("finds the chat route", () => {
    expect(routeFiles.map(rel)).toContain("app/api/advisor/chat/route.ts");
  });

  it("each exported handler's first statement is the auth() check, before any other work", () => {
    for (const f of routeFiles.filter((x) => /route\.ts$/.test(x))) {
      const src = stripComments(read(f));
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\([^)]*\)\s*\{/g)];
      expect(handlers.length, rel(f)).toBeGreaterThan(0);
      for (const h of handlers) {
        const body = src.slice(h.index! + h[0].length).trimStart();
        expect(body.startsWith("const session = await auth();"), `${rel(f)} ${h[1]}`).toBe(true);
        const next = body.slice("const session = await auth();".length).trimStart();
        expect(/^if \(!session\?\.user\?\.id\) return jsonError\(401,/.test(next), `${rel(f)} ${h[1]} returns 401 right after`).toBe(true);
      }
    }
  });

  it("the chat route is Node-runtime, dynamic, 60 seconds, and refuses a cross-origin or oversized request before any work", () => {
    const src = read(join(ROOT, "app/api/advisor/chat/route.ts"));
    expect(src).toMatch(/export const runtime = "nodejs";/);
    expect(src).toMatch(/export const dynamic = "force-dynamic";/);
    expect(src).toMatch(/export const maxDuration = 60;/);
    const code = stripComments(src);
    const order = ["await auth()", "isSameOrigin(req.headers)", "content-length", "checkChatRequest(", "prepareTurn(", "streamTurn("].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code).toMatch(/"Content-Type": "application\/x-ndjson; charset=utf-8"/);
    expect(code).toMatch(/"Cache-Control": "no-store, no-transform"/);
    expect(code).toMatch(/"X-Accel-Buffering": "no"/);
  });

  it("the client never supplies the transcript: the route reads only conversationId and message", () => {
    const code = stripComments(read(join(ROOT, "app/api/advisor/chat/route.ts")));
    expect(code).toContain("checked.body.conversationId");
    expect(code).toContain("checked.body.message");
    expect(/\bmessages\b/.test(code)).toBe(false);
  });

  it("imports only the turn wiring, never a tool, query, store or SDK directly", () => {
    const code = stripComments(read(join(ROOT, "app/api/advisor/chat/route.ts")));
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(/@\/lib\/advisor\/(tools|queries|store|anthropic|loop)|@anthropic-ai\/sdk|@\/lib\/db/.test(spec), spec).toBe(false);
    }
  });

  it("nothing under app/api names the tax year-close (the year-close isolation rule)", () => {
    for (const f of routeFiles) expect(/TaxYearClose|taxYearClose|tax-year-close|tax-facts-carry-guard|YearStatusNotice/.test(read(f)), rel(f)).toBe(false);
  });
});

describe("secrets stay on the server", () => {
  const advisorLib = walk(join(ROOT, "lib/advisor"));
  const app = ["app", "components", "lib", "actions"].flatMap((d) => walk(join(ROOT, d))).filter((p) => !p.includes(`${sep}__tests__${sep}`));

  it("only lib/advisor/anthropic.ts reads ANTHROPIC_API_KEY or imports the SDK within the assistant", () => {
    for (const f of [...advisorLib, ...routeFiles, ...walk(join(ROOT, "components/advisor")), join(ROOT, "app/advisor/page.tsx"), join(ROOT, "actions/advisor.ts")]) {
      if (rel(f) === "lib/advisor/anthropic.ts") continue;
      const src = stripComments(read(f));
      expect(/ANTHROPIC_API_KEY/.test(src), rel(f)).toBe(false);
      expect(/@anthropic-ai\/sdk/.test(src), rel(f)).toBe(false);
    }
  });

  it("no component reads the environment or imports the Anthropic adapter", () => {
    for (const f of app.filter((x) => rel(x).startsWith("components/"))) {
      const src = stripComments(read(f));
      expect(/process\.env/.test(src), rel(f)).toBe(false);
      expect(/@\/lib\/advisor\/(anthropic|deps|run-turn|store)/.test(src), rel(f)).toBe(false);
    }
  });

  it("the old transcript-from-the-client implementation is gone", () => {
    expect(existsSync(join(ROOT, "components/advisor/advisor-chat.tsx"))).toBe(false);
    expect(read(join(ROOT, "app/api/advisor/chat/route.ts"))).not.toContain("claude-opus-4-8");
  });
});

describe("the Advisor page", () => {
  const page = stripComments(read(join(ROOT, "app/advisor/page.tsx")));
  it("redirects to /login before reading anything and looks conversations up by the signed-in user id", () => {
    const body = page.slice(page.indexOf("export default async function AdvisorPage"));
    const open = body.indexOf("{\n") + 2;
    expect(body.slice(open).trimStart().startsWith("const session = await auth();")).toBe(true);
    expect(body).toMatch(/if \(!session\?\.user\?\.id\) redirect\("\/login"\);/);
    expect(page).toMatch(/store\.getOwnConversation\(userId, wanted\)/);
    expect(page).toMatch(/store\.loadMessages\(userId, wanted\)/);
  });
  it("every assistant-table read on the page is fail-soft", () => {
    for (const call of ["store.listConversations", "store.listActiveMemory", "store.sumUsageSince"]) {
      expect(page, call).toContain(`store.safeRead(() => ${call}(`);
    }
  });
});
