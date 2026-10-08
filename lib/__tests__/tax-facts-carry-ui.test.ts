import { describe, it, expect, vi } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CarryForwardReview } from "@/components/tax/facts/carry-forward-review";
import { FactsBrowser } from "@/components/tax/facts/facts-browser";
import { buildCarryScreen } from "@/lib/tax-facts/carry-screen";
import type { CarryRow } from "@/lib/tax-facts/carry-forward";
import {
  FACTS_CARRY_SCREEN_HONESTY,
  FACTS_CARRY_STATUS,
  FACTS_PAGE_HONESTY,
} from "@/lib/tax-facts/format";
import { groupFacts } from "@/lib/tax-facts/group";
import type { TaxFactRow } from "@/lib/tax-facts/types";
import { findCpaWording } from "@/lib/tax-wording";

// The repo's vitest JSX transform needs React in scope (same as tax-facts-tester-probe.test.ts).
(globalThis as unknown as { React: typeof React }).React = React;

// The client leaves import the server actions; stub the auth/db boundary so rendering never touches either.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const T = new Date("2026-10-07T15:00:00Z");

function row(o: Partial<CarryRow> & { factKey: string }): CarryRow {
  return {
    version: 1, category: "household", label: o.factKey, taxYear: 2025, valueKind: "text", valueCents: null, valueText: "val",
    carryPolicy: "reconfirm", changeKind: "established", sourceKind: "owner_statement", confirmedAt: T, ...o,
  };
}

const FIXTURE: CarryRow[] = [
  row({ factKey: "a.stable", label: "Stable fact", carryPolicy: "stable" }),
  row({ factKey: "b.reconfirm", label: "Reconfirm fact" }),
  row({ factKey: "d.year", label: "Year fact", carryPolicy: "year_specific", valueKind: "money_cents", valueCents: 5000, valueText: null }),
  row({ factKey: "e.open", label: "Open question", category: "open_item", valueKind: "open_item", carryPolicy: "stable" }),
  row({ factKey: "decision.x1.a", label: "Decision X1", category: "decision", valueKind: "choice", valueText: "simplified", sourceKind: "decision" }),
  row({ factKey: "decision.x5.b", label: "Decision X5", category: "decision", valueKind: "choice", valueText: "deduct", sourceKind: "decision" }),
];

const html = renderToStaticMarkup(createElement(CarryForwardReview, { screen: buildCarryScreen(FIXTURE, 2026), years: [2026, 2027] }));
const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the carry review renders", () => {
  it("the five sections in order, with the counter", () => {
    const order = ["Needs re-confirmation (3)", "Ask fresh (1)", "Open items (1)", "Carried (stable) (1)", "Already confirmed for TY2026 (0)"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("4 still need your confirmation or answer for TY2026");
  });

  it("the honesty panel says nothing is verified by documents or consumed by the return", () => {
    expect(text).toContain(FACTS_CARRY_SCREEN_HONESTY);
    expect(FACTS_CARRY_SCREEN_HONESTY).toContain("not verified by documents");
    expect(FACTS_CARRY_SCREEN_HONESTY).toContain("do not read this store");
  });

  it("every decision row shows the recall note, and there is no checkbox, select or multi-select anywhere", () => {
    expect(text.match(/Recorded copy for recall; the return uses the decision recorded on the Tax Forms page\./g)).toHaveLength(2);
    expect(html).not.toMatch(/type="checkbox"|<select|<input|multiple/);
  });

  it("every fact row names the year it came from", () => {
    for (const li of html.split("<li").slice(1)) {
      expect(li.replace(/<!-- -->/g, ""), li.slice(0, 120)).toMatch(/TY2025/);
    }
  });

  it("the open item is a question, not a fact: no confirm button, a resolve link", () => {
    expect(text).toContain("Question, not a fact");
    const openLi = html.split("<li").find((l) => l.includes("Open question"))!;
    expect(openLi).not.toContain("<button");
    expect(openLi).toContain('href="/tax/facts"');
  });

  it("ask-fresh values are shown as reference only", () => {
    expect(text).toContain("Reference only: $50");
    expect(text).toContain("shown for reference only; not carried to TY2026");
  });

  it("per-fact buttons only: one 'Still true' per needs-confirmation row, none on stable or ask-fresh rows", () => {
    expect(text.match(/Still true for TY2026/g) ?? []).toHaveLength(3);
    expect(text).toContain("Answer for TY2026");
  });

  it("year chips link to the static carry routes", () => {
    expect(html).toContain('href="/tax/facts/carry/2026"');
    expect(html).toContain('href="/tax/facts/carry/2027"');
  });
});

describe("source pins", () => {
  const review = read("components/tax/facts/carry-forward-review.tsx");
  const leaf = read("components/tax/facts/carry-row-actions.tsx");

  it("no bulk confirm vocabulary or mechanism in the two carry components", () => {
    for (const src of [review, leaf]) {
      expect(src).not.toMatch(/Confirm all|Confirm selected|confirm all|checkbox|Promise\.all|\.map\(\s*\(?\w*\)?\s*=>\s*reconfirm/);
    }
  });

  it("the leaf calls one action per click with one factKey", () => {
    expect([...leaf.matchAll(/reconfirmTaxFact\(\{/g)].length).toBe(2);
    expect(leaf).toContain("changeTaxFactForCarry({");
  });

  it("the facts page no longer says the carry screen is not built, has the new h1 and links to the carry screen", () => {
    const page = read("app/tax/facts/page.tsx");
    expect(page).not.toContain("FACTS_CARRY_NOT_BUILT");
    expect(page).toContain("Owner-confirmed facts</h1>");
    expect(page).not.toContain("Facts carried forward");
    expect(page).toContain("/tax/facts/carry/");
    expect(read("lib/tax-facts/format.ts")).not.toContain("FACTS_CARRY_NOT_BUILT");
  });

  it("CLAUDE.md no longer says the carry screen is unbuilt and still says nothing consumes the store", () => {
    const md = read("CLAUDE.md");
    expect(md).not.toContain("Phase 1 only");
    expect(md).not.toContain("is not built");
    expect(md).toContain("nothing (questionnaires, engine, reviewer, fingerprint) consumes the store");
  });

  it("the carry route files are static segments that start with the session check", () => {
    for (const p of ["app/tax/facts/carry/page.tsx", "app/tax/facts/carry/[year]/page.tsx"]) {
      const src = read(p);
      const body = src.slice(src.indexOf("export default async function"));
      expect(body).toMatch(/const session = await auth\(\);\n\s*if \(!session\?\.user\) redirect\("\/login"\);/);
      expect(body.indexOf("auth()")).toBeLessThan(body.indexOf("loadTaxFacts") === -1 ? Infinity : body.indexOf("loadTaxFacts"));
    }
    expect(read("app/tax/facts/carry/[year]/page.tsx")).toContain("notFound()");
  });
});

describe("wording", () => {
  it("passes the owner-wording scan, names the Tax Forms page, and does not say the store feeds the return", () => {
    for (const s of [FACTS_CARRY_STATUS, FACTS_CARRY_SCREEN_HONESTY, FACTS_PAGE_HONESTY, text]) {
      expect(findCpaWording(s), s.slice(0, 60)).toEqual([]);
      expect(s).not.toMatch(/\bClaude\b|\bAI\b/);
    }
    expect(FACTS_CARRY_STATUS).not.toMatch(/not built|not yet/i);
    expect(FACTS_PAGE_HONESTY).toContain("Tax Forms page");
    expect(FACTS_PAGE_HONESTY).not.toMatch(/the Forms page/);
    expect(FACTS_CARRY_STATUS).toContain("no questionnaire, return computation, review or approval reads these facts");
  });
});

describe("history line (cosmetic O2)", () => {
  const mk = (o: Partial<TaxFactRow>): TaxFactRow => ({
    id: "x1", factKey: "a.b", version: 1, category: "household", label: "L", taxYear: 2025, valueKind: "text", valueCents: null, valueText: "v",
    carryPolicy: "reconfirm", changeKind: "established", sourceKind: "owner_statement", sourceRef: null, reason: null,
    confirmedAt: T, setByName: "Eric", setAt: T, archivedAt: null, ...o,
  });

  it("an open item's history line does not say 'recorded' twice; a confirmed fact still says 'confirmed'", () => {
    const open = mk({ id: "o1", factKey: "o.q", category: "open_item", valueKind: "open_item", carryPolicy: "stable" });
    const normal = mk({});
    const out = renderToStaticMarkup(createElement(FactsBrowser, { grouped: groupFacts([open, normal]) })).replace(/<!-- -->/g, "");
    const t = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(t).not.toMatch(/recorded 2026-10-07; recorded by/);
    expect(t).toContain("dated 2026-10-07; recorded by Eric");
    expect(t).toContain("confirmed 2026-10-07; recorded by Eric");
  });
});
