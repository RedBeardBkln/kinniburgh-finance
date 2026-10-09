import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Tester: independent static checks of the Suspense restructure (both pages) with in-memory mutants. The checker is
// run on the real source (must report nothing) and on each mutated copy (must report something): no source file is edited.

const root = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

type Kind = "dashboard" | "forecast";

function check(src: string, kind: Kind): string[] {
  const v: string[] = [];
  const section = kind === "dashboard" ? "UpcomingWidgetSection" : "UpcomingSections";
  const fnIdx = src.indexOf(`async function ${section}(`);
  if (fnIdx < 0) return ["section component missing"];
  const body = src.slice(0, fnIdx);
  const fn = src.slice(fnIdx);

  // auth first, redirect after it, both before any Suspense / loader
  const authIdx = src.indexOf("await auth()");
  const suspenseIdx = src.indexOf("<Suspense");
  if (authIdx < 0) v.push("no auth()");
  if (suspenseIdx < 0) v.push("no Suspense");
  if (authIdx >= 0 && suspenseIdx >= 0 && authIdx > suspenseIdx) v.push("auth() after Suspense");
  const redirectIdx = src.indexOf('redirect("/login")');
  if (redirectIdx < 0 || redirectIdx < authIdx || redirectIdx > suspenseIdx) v.push("redirect not between auth and Suspense");

  // the loader is called exactly once, inside the section component, never in the page body
  if (/loadUpcomingLedger\(/.test(body.replace(/^import .*$/gm, ""))) v.push("loader called in page body");
  if ((fn.match(/loadUpcomingLedger\(/g) ?? []).length !== 1) v.push("loader not called exactly once in the section");
  if (/loadRecurringDetection\(|fetchDetectionData\(/.test(body)) v.push("detection read in page body");

  // render site: gated (dashboard), keyed, skeleton fallback
  const renderIdx = body.search(new RegExp("<" + section + "\\s"));
  const susp = body.lastIndexOf("<Suspense", renderIdx);
  if (renderIdx < 0 || susp < 0) v.push("section not rendered inside Suspense");
  else {
    const tag = body.slice(susp, renderIdx);
    if (!/key=\{/.test(tag)) v.push("Suspense has no key");
    if (!/fallback=\{<Upcoming(Widget|Agenda)Skeleton/.test(tag)) v.push("Suspense fallback is not the skeleton");
    if (kind === "dashboard" && !body.slice(0, susp).trimEnd().endsWith("{isCurrentPeriod && (")) v.push("dashboard widget not gated by isCurrentPeriod");
  }

  // section: types, ordering, try/catch layering, logging
  if (!/let upcoming: UiLedger \| null = null;/.test(fn)) v.push("upcoming contract changed");
  if (!/let upcomingDetection: UiDetection \| null \| undefined;/.test(fn)) v.push("detection undefined/null contract changed");
  const outerTry = fn.indexOf("try {");
  const load = fn.indexOf("loadUpcomingLedger(");
  const ui = fn.indexOf("toUiLedger(");
  const innerTry = fn.indexOf("try {", ui);
  const det = fn.indexOf("toUiDetection(");
  if (!(outerTry >= 0 && outerTry < load && load < ui && ui < innerTry && innerTry < det)) v.push("try/load/toUiLedger/inner try/toUiDetection order broken");
  const innerCatch = fn.indexOf("catch (err)", det);
  const innerCatchBody = fn.slice(innerCatch, fn.indexOf("}", innerCatch + 40));
  if (!/upcomingDetection = null;/.test(innerCatchBody)) v.push("inner catch does not reset detection to null");
  if (!/toUiDetection\(loaded\.detection, loaded\.entityNameById, upcoming\.fromIso\)/.test(fn)) v.push("todayIso not passed from the ledger's fromIso");
  const logs = fn.match(/console\.error\([^;]*\);/g) ?? [];
  if (logs.length < 2) v.push("expected two console.error calls in the section");
  for (const l of logs) if (!/err instanceof Error \? err\.name : "UnknownError"\)/.test(l) || /err\.message|, err\)/.test(l)) v.push(`unsafe log: ${l}`);
  if (/\berr\.(message|stack)\b/.test(fn)) v.push("message/stack referenced");
  return v;
}

const dash = read("app/page.tsx");
const fore = read("app/forecast/page.tsx");

describe("tester: Suspense restructure, static checks on the real pages", () => {
  it("dashboard passes every check", () => expect(check(dash, "dashboard")).toEqual([]));
  it("forecast passes every check", () => expect(check(fore, "forecast")).toEqual([]));
});

describe("tester: the checker kills in-memory mutants (no file is touched)", () => {
  const mutants: { name: string; kind: Kind; edit: (s: string) => string }[] = [
    { name: "dashboard: auth() removed", kind: "dashboard", edit: (s) => s.replace("await auth()", "null") },
    { name: "dashboard: loader awaited in the page body", kind: "dashboard", edit: (s) => s.replace("{/* Next 30 days (current month only) */}", "{/* x */}") .replace("export default async function DashboardPage({ searchParams }: PageProps) {", "export default async function DashboardPage({ searchParams }: PageProps) {\n  void loadUpcomingLedger({ entityId: null, days: 30, now: new Date() });") },
    { name: "dashboard: Suspense key dropped", kind: "dashboard", edit: (s) => s.replace("<Suspense key={bucket} ", "<Suspense ") },
    { name: "dashboard: fallback removed", kind: "dashboard", edit: (s) => s.replace("fallback={<UpcomingWidgetSkeleton days={30} />}", "fallback={null}") },
    { name: "dashboard: isCurrentPeriod gate removed", kind: "dashboard", edit: (s) => s.replace("{isCurrentPeriod && (\n          <Suspense", "{(\n          <Suspense") },
    { name: "dashboard: err.name -> err.message", kind: "dashboard", edit: (s) => s.replace('console.error("Upcoming ledger unavailable", err instanceof Error ? err.name : "UnknownError")', 'console.error("Upcoming ledger unavailable", err instanceof Error ? err.message : "UnknownError")') },
    { name: "dashboard: whole error object logged", kind: "dashboard", edit: (s) => s.replace('console.error("Recurring pattern view unavailable", err instanceof Error ? err.name : "UnknownError")', 'console.error("Recurring pattern view unavailable", err)') },
    { name: "dashboard: inner try/catch around toUiDetection removed", kind: "dashboard", edit: (s) => s.replace("upcomingDetection = loaded.detection ? toUiDetection(loaded.detection, loaded.entityNameById, upcoming.fromIso) : null;\n    } catch (err) {\n      upcomingDetection = null;", "upcomingDetection = loaded.detection ? toUiDetection(loaded.detection, loaded.entityNameById, upcoming.fromIso) : null;\n    } catch (err) {\n      upcomingDetection = undefined;") },
    { name: "dashboard: todayIso dropped", kind: "dashboard", edit: (s) => s.replace("loaded.entityNameById, upcoming.fromIso)", "loaded.entityNameById)") },
    { name: "dashboard: detection contract widened (no undefined)", kind: "dashboard", edit: (s) => s.replace("let upcomingDetection: UiDetection | null | undefined;", "let upcomingDetection: UiDetection | null = null;") },
    { name: "forecast: Suspense key dropped", kind: "forecast", edit: (s) => s.replace("key={`${bucket}|${upcomingHorizon}|${showTransfers ? 1 : 0}`}", "") },
    { name: "forecast: skeleton replaced", kind: "forecast", edit: (s) => s.replace("fallback={<UpcomingAgendaSkeleton horizon={upcomingHorizon} />}", "fallback={<div />}") },
    { name: "forecast: err.name -> err.message", kind: "forecast", edit: (s) => s.replace('console.error("Upcoming ledger unavailable", err instanceof Error ? err.name : "UnknownError")', 'console.error("Upcoming ledger unavailable", err instanceof Error ? err.message : "UnknownError")') },
    { name: "forecast: auth() after the Suspense", kind: "forecast", edit: (s) => s.replace("await auth()", "null").replace("<Suspense\n", "<Suspense\n") + "\n// await auth()" },
    { name: "forecast: todayIso dropped", kind: "forecast", edit: (s) => s.replace("loaded.entityNameById, upcoming.fromIso)", "loaded.entityNameById)") },
  ];
  for (const m of mutants) {
    it(`kills: ${m.name}`, () => {
      const src = m.kind === "dashboard" ? dash : fore;
      const mutated = m.edit(src);
      expect(mutated).not.toBe(src); // the mutation really applied
      expect(check(mutated, m.kind).length).toBeGreaterThan(0);
    });
  }
});

describe("tester: where the loader may be imported", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".git", ".claude"].includes(name)) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("only the two pages import lib/upcoming-ledger-build (outside tests)", () => {
    const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "components")), ...walk(path.join(root, "actions")), ...walk(path.join(root, "lib"))]
      .filter((f) => !f.includes("__tests__") && !f.includes("zz-tester"))
      .filter((f) => /from "@\/lib\/upcoming-ledger-build"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).replace(/\\/g, "/"))
      .sort();
    expect(files).toEqual(["app/forecast/page.tsx", "app/page.tsx"]);
  });
  it("the new budget-hint loader is imported only by the forecast page and has no write verbs", () => {
    const importers = [...walk(path.join(root, "app")), ...walk(path.join(root, "components")), ...walk(path.join(root, "actions")), ...walk(path.join(root, "lib"))]
      .filter((f) => !f.includes("__tests__") && !f.includes("zz-tester"))
      .filter((f) => /from "@\/lib\/recurring-budget-hint-build"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).replace(/\\/g, "/"));
    expect(importers).toEqual(["app/forecast/page.tsx"]);
    const src = read("lib/recurring-budget-hint-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    // the Budget read moved to the shared effective-budget loader (lib/budget-carry-forward-build.ts)
    expect((src.match(/\.findMany\(/g) ?? []).length).toBe(2);
    expect((src.match(/select:/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/include:/);
  });
});

describe("tester: skeleton accessibility and anchors", () => {
  const sk = read("components/upcoming/upcoming-skeleton.tsx");
  it("one polite busy status per card with sr-only text; bars are aria-hidden; pulse respects reduced motion", () => {
    expect(sk).toMatch(/role="status" aria-live="polite" aria-busy="true"/);
    expect(sk).toMatch(/aria-hidden="true"/);
    expect(sk).toMatch(/motion-safe:animate-pulse/);
    expect(sk.replace(/motion-safe:animate-pulse/g, "")).not.toContain("animate-pulse");
    expect(sk).toContain('id="upcoming"');
    expect(sk).toContain('id="looks-recurring"');
    expect(sk).not.toMatch(/<a |<Link|href=/); // no data, no links
  });
});
