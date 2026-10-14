import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeTocId, buildTocEntries, sameEntries } from "@/lib/page-contents";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("buildTocEntries", () => {
  it("keeps document order, tidies labels and reads the level", () => {
    expect(
      buildTocEntries([
        { id: "a", label: "  Current   balances ", level: null },
        { id: "b", label: "Oil (McCarthy)", level: "2" },
        { id: "c", label: "Income sources", level: "1" },
      ]),
    ).toEqual([
      { id: "a", label: "Current balances", level: 1 },
      { id: "b", label: "Oil (McCarthy)", level: 2 },
      { id: "c", label: "Income sources", level: 1 },
    ]);
  });

  it("drops nodes without an id or label and repeated ids", () => {
    expect(
      buildTocEntries([
        { id: "", label: "No id", level: null },
        { id: "x", label: "  ", level: null },
        { id: null, label: "Null id", level: null },
        { id: "y", label: "First", level: null },
        { id: "y", label: "Second", level: null },
      ]),
    ).toEqual([{ id: "y", label: "First", level: 1 }]);
  });
});

describe("activeTocId", () => {
  const tops = [
    { id: "a", top: -400 },
    { id: "b", top: 20 },
    { id: "c", top: 600 },
  ];
  it("is the last section whose top has reached the threshold", () => {
    expect(activeTocId(tops, 96)).toBe("b");
  });
  it("is the first section before any has reached the threshold, and null for none", () => {
    expect(activeTocId([{ id: "a", top: 300 }, { id: "b", top: 900 }], 96)).toBe("a");
    expect(activeTocId([], 96)).toBeNull();
  });
});

describe("sameEntries", () => {
  it("compares id, label and level", () => {
    const a = [{ id: "a", label: "A", level: 1 as const }];
    expect(sameEntries(a, [{ id: "a", label: "A", level: 1 }])).toBe(true);
    expect(sameEntries(a, [{ id: "a", label: "A", level: 2 }])).toBe(false);
    expect(sameEntries(a, [])).toBe(false);
  });
});

describe("forecast page wiring", () => {
  const files = [
    "app/forecast/page.tsx",
    "components/upcoming/upcoming-agenda.tsx",
    "components/upcoming/upcoming-skeleton.tsx",
    "components/upcoming/recurring-suggestions.tsx",
    "components/forecast/seasonal-card.tsx",
    "components/forecast/usage-history.tsx",
  ];

  it("every data-toc-label sits next to an id", () => {
    for (const f of files) {
      const src = read(f);
      const marks = [...src.matchAll(/data-toc-label/g)];
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks) {
        const near = src.slice(Math.max(0, (m.index ?? 0) - 260), (m.index ?? 0) + 260);
        expect(near).toMatch(/\bid=|\bid:/);
      }
    }
  });

  it("the page marks the main sections", () => {
    const page = read("app/forecast/page.tsx");
    for (const id of [
      "forecast-balances",
      "forecast-breaches",
      "forecast-projections",
      "forecast-card-funding",
      "forecast-next-14-days",
      "forecast-spend-pace",
      "forecast-recurring-expenses",
      "forecast-income-sources",
      "rental-bookings",
    ]) {
      expect(page).toContain(`"${id}"`);
    }
    expect(read("components/upcoming/upcoming-agenda.tsx")).toContain('id="upcoming"');
  });

  it("the sidebar shows the list only under the active Forecast item", () => {
    const side = read("components/app-sidebar.tsx");
    expect(side).toMatch(/base === "\/forecast" && isActive\(base\) && <ForecastContents/);
  });
});
