import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Source-reading pins for the global launcher and slide-over (advisor-ai-chatbot-phase2 plan, section 6, acceptance 11): where it is mounted,
// where it hides, that print hides it, and that nothing in a client bundle reaches server-only assistant code. The interactive behaviour
// (open / close / Escape / restore) has no DOM test infrastructure here and is on the Tester's manual list.

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".claude") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("AppShell mounts the launcher", () => {
  const shell = strip(read("components/app-shell.tsx"));

  it("once, and only when there is a session", () => {
    expect([...shell.matchAll(/<AdvisorLauncher\b/g)]).toHaveLength(1);
    expect(shell).toMatch(/\{session\?\.user\?\.id && <AdvisorLauncher \/>\}/);
    expect(shell).toMatch(/import \{ AdvisorLauncher \} from "@\/components\/advisor\/advisor-launcher"/);
  });

  it("the public review page (/queue/[token]) does not render AppShell, so it never shows the launcher", () => {
    const files = walk(join(ROOT, "app/queue")).map((f) => strip(readFileSync(f, "utf8")));
    expect(files.length).toBeGreaterThan(0);
    for (const src of files) expect(/<AppShell|app-shell|AdvisorLauncher/.test(src)).toBe(false);
  });
});

describe("the launcher", () => {
  const src = strip(read("components/advisor/advisor-launcher.tsx"));

  it('is a client component that renders nothing on the Advisor page, and is hidden in print', () => {
    expect(read("components/advisor/advisor-launcher.tsx").startsWith('"use client";')).toBe(true);
    expect(src).toMatch(/pathname === "\/advisor" \|\| pathname\.startsWith\("\/advisor\/"\)\) return null/);
    expect(src).toMatch(/print:hidden/);
  });

  it("loads the panel lazily, client side only, after the first open", () => {
    expect(src).toMatch(/dynamic\(\(\) => import\("@\/components\/advisor\/advisor-slideover"\)[^)]*\)[^;]*\{ ssr: false \}\)/);
    expect(src).toMatch(/\{everOpened && <AdvisorSlideover /);
  });

  it("the button has a visible name and the dialog state", () => {
    expect(src).toContain("Ask the assistant");
    expect(src).toMatch(/aria-expanded=\{open\}/);
    expect(src).toMatch(/aria-haspopup="dialog"/);
  });
});

describe("the slide-over", () => {
  const raw = read("components/advisor/advisor-slideover.tsx");
  const src = strip(raw);

  it("is a labelled, non-modal dialog that closes on Escape and is inert (unreachable) while closed", () => {
    expect(raw.startsWith('"use client";')).toBe(true);
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="false"');
    expect(src).toContain('aria-label="Assistant"');
    expect(src).toMatch(/inert=\{!open\}/);
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toMatch(/print:hidden/);
    expect(src).toMatch(/w-full[^"]*md:w-\[26rem\]/); // full width on small screens
  });

  it("keeps the conversation id in sessionStorage under a UUID-validated key and restores it through the ownership-checked action", () => {
    expect(src).toContain('"advisor.slideover.conversation"');
    expect(src).toMatch(/UUID\.test\(v\)/);
    expect(src).toMatch(/getMyConversation\(storedId\)/);
    expect(src).toMatch(/Open in Advisor/);
    expect(src).toContain("`/advisor?c=${activeId}`");
  });

  it("shows only the closed-set page label, computed by the pure parser", () => {
    expect(src).toMatch(/parsePageContext\(pathname\)/);
    expect(src).toMatch(/Looking at: \{contextChipText\(context\)\}/);
  });

  it("the hook sends the pathname and nothing else as the page context", () => {
    const hookSrc = strip(read("components/advisor/use-advisor-chat.ts"));
    expect(strip(raw)).toMatch(/getPageContext: \(\) => \(\{ path: window\.location\.pathname \}\)/);
    expect(hookSrc).toMatch(/\.\.\.\(pageContext !== undefined \? \{ pageContext \} : \{\}\)/);
    expect(hookSrc).toMatch(/JSON\.stringify\(\{ conversationId: activeId, message,/);
  });
});

describe("client components never reach server-only assistant code", () => {
  const clientFiles = [...walk(join(ROOT, "components/advisor")), ...walk(join(ROOT, "components"))].filter((f, i, a) => a.indexOf(f) === i);
  const banned = /@\/lib\/advisor\/(anthropic|store|loop|run-turn|deps|request|prompt|tools|queries|exclusions|scrub|wording|config)\b|@anthropic-ai\/sdk|@\/lib\/db|@\/lib\/auth/;

  it("no advisor component imports the SDK, the store, the tools, the queries, the loop, the prompt or the scrubber", () => {
    const own = clientFiles.filter((f) => f.includes(`${sep}advisor${sep}`));
    expect(own.length).toBeGreaterThanOrEqual(12);
    for (const f of own) {
      const src = strip(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/from "([^"]+)"/g)) {
        // composer / slide-over / workspace read client-safe constants from config (LIMITS); that one import is the only exception
        if (m[1] === "@/lib/advisor/config") continue;
        expect(banned.test(m[1]!), `${relative(ROOT, f)} imports ${m[1]}`).toBe(false);
      }
    }
  });

  it("only the server action modules (use server) and the allowed client-safe helpers are imported by the slide-over and hook", () => {
    for (const f of ["components/advisor/advisor-slideover.tsx", "components/advisor/use-advisor-chat.ts", "components/advisor/advisor-launcher.tsx", "components/advisor/memory-proposal-chip.tsx"]) {
      const specs = [...strip(read(f)).matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const s of specs) {
        if (!s.startsWith("@/")) continue;
        expect(/^@\/(actions\/advisor(-usage)?|components\/|lib\/advisor\/(chat-state|stream-protocol|page-context|usage-format|starters|memory-categories|config))/.test(s), `${f} imports ${s}`).toBe(true);
      }
    }
  });
});
