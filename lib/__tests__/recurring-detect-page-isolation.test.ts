import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Source-reading pins for the two pages that show the Upcoming ledger and the recurring-pattern checks.
//
// Review round 1: the recurring-pattern view must be built AFTER the ledger and inside its own try/catch so a throw in
// toUiDetection can never blank the agenda.
// Suspense follow-up: the loading moved out of the page body into an async server component rendered inside a
// <Suspense> boundary. The pins below follow the code to its new place in the SAME file and still pin the same
// properties (auth before any load, separate try/catch, ordering, undefined/null semantics, err.name-only logging) plus
// the new ones (the page body no longer awaits the loader; the boundary has a fallback).
const PAGES = [
  { file: "app/page.tsx", section: "UpcomingWidgetSection", fallback: "UpcomingWidgetSkeleton" },
  { file: "app/forecast/page.tsx", section: "UpcomingSections", fallback: "UpcomingAgendaSkeleton" },
];

for (const { file, section, fallback } of PAGES) {
  describe(`${file}: recurring view fail-soft isolation`, () => {
    const src = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
    const calls = src.split("toUiDetection(").length - 1;

    it("calls toUiDetection exactly once", () => {
      expect(calls).toBe(1);
    });

    it("builds it after toUiLedger, inside its own try whose catch resets it to null", () => {
      const ledgerAt = src.indexOf("upcoming = toUiLedger(");
      const callAt = src.indexOf("toUiDetection(");
      expect(ledgerAt).toBeGreaterThan(-1);
      expect(callAt).toBeGreaterThan(ledgerAt);
      const between = src.slice(ledgerAt, callAt);
      expect(between).toMatch(/try \{\s*upcomingDetection = loaded\.detection\s*\?\s*$/);
      const after = src.slice(callAt, callAt + 400);
      expect(after).toMatch(/\} catch \(err\) \{\s*upcomingDetection = null;/);
    });
  });

  describe(`${file}: Suspense boundary`, () => {
    const src = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
    const sectionAt = src.indexOf(`async function ${section}(`);
    const body = sectionAt === -1 ? "" : src.slice(sectionAt);
    const page = sectionAt === -1 ? src : src.slice(0, sectionAt);

    it("auth() runs in the page, before the boundary and before any load", () => {
      expect(sectionAt).toBeGreaterThan(-1);
      const authAt = page.indexOf("await auth()");
      const redirectAt = page.indexOf('redirect("/login")');
      const boundaryAt = page.search(/<Suspense\s+key=/);
      expect(authAt).toBeGreaterThan(-1);
      expect(redirectAt).toBeGreaterThan(authAt);
      expect(boundaryAt).toBeGreaterThan(redirectAt);
      // The page body never loads the ledger itself, and only the section component does.
      expect(page).not.toContain("loadUpcomingLedger(");
      expect(body.split("loadUpcomingLedger(").length - 1).toBe(1);
    });

    it("renders the section inside <Suspense> with a skeleton fallback and a key that re-shows it on navigation", () => {
      expect(page).toMatch(new RegExp(String.raw`<Suspense[\s\S]{0,300}?fallback=\{<${fallback}`));
      expect(page).toMatch(/<Suspense[\s\S]{0,300}?key=/);
      // The element sits inside the boundary (the JSX, not the explanatory comments that mention both names).
      expect(page).toMatch(new RegExp(String.raw`<Suspense\s[\s\S]{0,400}?<${section}\s`));
    });

    it("keeps the ledger try/catch and the undefined = ledger failed / null = only pattern checks failed contract", () => {
      expect(body).toMatch(/let upcoming: UiLedger \| null = null;/);
      expect(body).toMatch(/let upcomingDetection: UiDetection \| null \| undefined;/);
      // loader + toUiLedger sit in the OUTER try; its catch logs and falls through with the defaults.
      const outerTry = body.indexOf("try {");
      const loadAt = body.indexOf("await loadUpcomingLedger(");
      expect(outerTry).toBeGreaterThan(-1);
      expect(loadAt).toBeGreaterThan(outerTry);
      expect(body).toMatch(/console\.error\("Upcoming ledger unavailable", err instanceof Error \? err\.name : "UnknownError"\)/);
      expect(body).toMatch(/console\.error\("Recurring pattern view unavailable", err instanceof Error \? err\.name : "UnknownError"\)/);
    });

    it("logs the error NAME only, never the error object or message", () => {
      expect(body).not.toMatch(/console\.error\([^)]*,\s*err\s*\)/);
      expect(body).not.toMatch(/err\.message/);
    });
  });
}
