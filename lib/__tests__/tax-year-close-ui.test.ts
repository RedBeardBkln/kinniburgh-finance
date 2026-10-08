import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The repo's vitest JSX transform needs React in scope (same as tax-facts-tester-probe.test.ts).
(globalThis as unknown as { React: typeof React }).React = React;

// The card imports the server actions; stub the auth/db boundary so rendering never touches either.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const loadMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tax-year-close-store", () => ({ loadYearCloseStates: loadMock }));

import { YearCloseCard, type YearCloseCardProps } from "@/components/tax/year-close-card";
import { YearStateBadge } from "@/components/tax/year-state-badge";
import { YearNoticeBlock, YearStatusNotice } from "@/components/tax/year-status-notice";
import { FiledYearsStrip } from "@/components/tax/facts/filed-years-strip";
import { TaxEntityWidget } from "@/components/tax/tax-entity-widget";
import { foldAllYears, foldYearState, toYearCloseView } from "@/lib/tax-year-close/state";
import { CLOSE_HONESTY } from "@/lib/tax-year-close/format";
import type { YearCloseEventRow } from "@/lib/tax-year-close/types";
import { findCpaWording } from "@/lib/tax-wording";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const ev = (o: Partial<YearCloseEventRow> & { seq: number; kind: YearCloseEventRow["kind"] }): YearCloseEventRow => ({
  id: `e${o.seq}`, taxYear: 2025, filedOn: o.kind === "closed" ? new Date("2026-10-12T12:00:00Z") : null, note: null,
  byName: "Eric Kinniburgh", at: new Date("2026-10-13T15:00:00Z"), ...o,
});
const OPEN = foldYearState(2025, []);
const CLOSED = foldYearState(2025, [ev({ seq: 1, kind: "closed", note: "e-filed" })]);
const REOPENED = foldYearState(2025, [ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "Corrected a form" })]);

const cardProps = (state: typeof OPEN, o: Partial<YearCloseCardProps> = {}): YearCloseCardProps => ({
  view: toYearCloseView(state), canAct: true, refusal: null, migrationMissing: false, pendingWorkspaces: [], today: "2026-10-13", ...o,
});
const card = (state: typeof OPEN, o: Partial<YearCloseCardProps> = {}) => renderToStaticMarkup(createElement(YearCloseCard, cardProps(state, o)));

beforeEach(() => loadMock.mockReset());

describe("badge", () => {
  it("closed is green with the filing date, reopened is amber, open renders nothing", () => {
    const closed = renderToStaticMarkup(createElement(YearStateBadge, { state: CLOSED }));
    expect(textOf(closed)).toContain("TY2025 filed 2026-10-12");
    expect(closed).toContain("green");
    const reopened = renderToStaticMarkup(createElement(YearStateBadge, { state: REOPENED }));
    expect(textOf(reopened)).toContain("TY2025 reopened for revision");
    expect(reopened).toContain("amber");
    expect(renderToStaticMarkup(createElement(YearStateBadge, { state: OPEN }))).toBe("");
    expect(renderToStaticMarkup(createElement(YearStateBadge, { state: null }))).toBe("");
  });
});

describe("the notice", () => {
  it("renders the banner (and is hidden in print) for closed and reopened years, nothing for open", () => {
    const html = renderToStaticMarkup(createElement(YearNoticeBlock, { state: CLOSED }));
    expect(textOf(html)).toContain("Reopen the year on the Tax Forms page to revise it.");
    expect(html).toContain("print:hidden");
    expect(textOf(renderToStaticMarkup(createElement(YearNoticeBlock, { state: REOPENED })))).toContain("reopened for revision");
    expect(renderToStaticMarkup(createElement(YearNoticeBlock, { state: OPEN }))).toBe("");
  });

  it("YearStatusNotice renders NOTHING (and never throws) for a missing table, no entity, an error or an open year", async () => {
    for (const load of [{ state: "table_missing" }, { state: "no_entity" }, { state: "error" }]) {
      loadMock.mockResolvedValue(load);
      expect(await YearStatusNotice({ year: 2025 })).toBeNull();
    }
    loadMock.mockResolvedValue({ state: "ok", entityId: "p", events: [], byYear: new Map() });
    expect(await YearStatusNotice({ year: 2025 })).toBeNull();
  });

  it("YearStatusNotice renders the block for a closed year only for that year", async () => {
    loadMock.mockResolvedValue({ state: "ok", entityId: "p", events: [], byYear: foldAllYears([ev({ seq: 1, kind: "closed" })]) });
    const el = await YearStatusNotice({ year: 2025 });
    expect(el).not.toBeNull();
    expect(textOf(renderToStaticMarkup(el as React.ReactElement))).toContain("TY2025 is marked filed");
    expect(await YearStatusNotice({ year: 2026 })).toBeNull();
  });
});

describe("the owner card", () => {
  it("open + owner: offers Mark as filed, shows the honesty sentence, no reopen", () => {
    const t = textOf(card(OPEN));
    expect(t).toContain("Mark TY2025 as filed");
    expect(t).toContain("not marked filed");
    expect(t).toContain(CLOSE_HONESTY);
    expect(t).not.toContain("Reopen for revision");
  });

  it("closed + owner: green block with the date, who and the note, and Reopen for revision", () => {
    const html = card(CLOSED);
    const t = textOf(html);
    expect(t).toContain("TY2025 filed 2026-10-12");
    expect(t).toContain("Recorded by Eric Kinniburgh");
    expect(t).toContain("Note: e-filed");
    expect(t).toContain("Reopen for revision");
    expect(t).not.toContain("Mark TY2025 as filed");
    expect(html).toContain("green");
  });

  it("reopened + owner: amber block with the reason, and Mark filed again", () => {
    const html = card(REOPENED);
    const t = textOf(html);
    expect(t).toContain("TY2025 reopened for revision");
    expect(t).toContain("Reason: Corrected a form");
    expect(t).toContain("Mark filed again");
    expect(html).toContain("amber");
  });

  it("a non-owner sees the state read-only with the refusal reason and no action button", () => {
    const html = card(CLOSED, { canAct: false, refusal: "Only the owner's own account can mark a tax year filed or reopen it." });
    const t = textOf(html);
    expect(t).toContain("TY2025 filed 2026-10-12");
    expect(t).toContain("Only the owner's own account can mark a tax year filed or reopen it.");
    expect(html).not.toContain("<button");
  });

  it("an unapplied migration says so and offers no button", () => {
    const html = card(OPEN, { migrationMissing: true });
    expect(textOf(html)).toContain("migration has not been applied");
    expect(html).not.toContain("<button");
  });

  it("the history lists every event, oldest first", () => {
    const t = textOf(card(REOPENED));
    expect(t).toContain("History (2 events)");
    expect(t.indexOf("#1")).toBeLessThan(t.indexOf("#2"));
  });

  it("every string the card renders passes the owner-wording scan and makes no acceptance or certification claim", () => {
    for (const s of [OPEN, CLOSED, REOPENED]) {
      const t = textOf(card(s, { pendingWorkspaces: ["EK Consulting"] }));
      expect(findCpaWording(t)).toEqual([]);
      expect(t).not.toMatch(/accepted by|\bClaude\b|\bAI\b|certif/i);
    }
  });

  it("the card source has no confirmation-number field and no window.confirm", () => {
    const src = read("components/tax/year-close-card.tsx");
    expect(src).not.toMatch(/window\.confirm|confirmation number"|confirmationNumber/);
    expect(src).toContain("ModalShell");
  });
});

describe("the strip and the widget", () => {
  it("the facts strip lists filed and reopened years and renders nothing otherwise", () => {
    const html = renderToStaticMarkup(createElement(FiledYearsStrip, { states: [CLOSED, foldYearState(2026, [])] }));
    expect(textOf(html)).toContain("TY2025 filed 2026-10-12");
    expect(html).toContain('href="/tax/forms/2025"');
    expect(renderToStaticMarkup(createElement(FiledYearsStrip, { states: [OPEN] }))).toBe("");
  });

  it("the entity widget shows Reopened for a reopened year and Filed for a closed one", () => {
    const base = {
      entityId: "p", entityName: "Eric", entityShortName: "Eric", entityType: "personal", taxYear: 2025, workspaceId: "w", status: null,
      deadline: null, totalIncome: null, totalExpenses: null, documentCount: 0, completedItems: 0, totalItems: 0, plUrl: null,
      balanceSheetUrl: null, workspaceHref: null,
    };
    expect(textOf(renderToStaticMarkup(createElement(TaxEntityWidget, { data: { ...base, status: "reopened" } })))).toContain("Reopened");
    expect(textOf(renderToStaticMarkup(createElement(TaxEntityWidget, { data: { ...base, status: "filed" } })))).toContain("Filed");
  });
});

describe("source pins: every page that shows a year carries the indicator", () => {
  const withNotice = [
    "app/tax/forms/[year]/return/page.tsx",
    "app/tax/forms/[year]/final-review/page.tsx",
    "app/tax/forms/[year]/cpa-summary/page.tsx",
    "app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx",
    "app/tax/personal/[year]/page.tsx",
    "app/tax/donations/[year]/page.tsx",
    "app/tax/fixed-assets/[year]/page.tsx",
    "app/tax/[workspaceId]/page.tsx",
  ];
  for (const f of withNotice) {
    it(`${f} renders <YearStatusNotice`, () => {
      expect(read(f)).toMatch(/<YearStatusNotice year=\{/);
    });
  }

  it("the Tax Forms hub has the badge, the owner card and the check marks; the workspaces list has the badge and the derived widget status", () => {
    const hub = read("app/tax/forms/[year]/page.tsx");
    expect(hub).toContain("<YearStateBadge");
    expect(hub).toContain("<YearCloseCard");
    expect(hub).toContain("closedYears.has(y)");
    const list = read("app/tax/page.tsx");
    expect(list).toContain("<YearStateBadge");
    expect(list).toContain("widgetStatus(entity.type");
  });

  it("the facts pages show the filed-years strip", () => {
    expect(read("app/tax/facts/page.tsx")).toContain("<FiledYearsStrip");
    expect(read("app/tax/facts/carry/[year]/page.tsx")).toContain("<FiledYearsStrip");
  });

  it("the existing return surfaces gained one JSX line and one import each, no logic", () => {
    for (const f of withNotice.slice(0, 4)) {
      const src = read(f);
      expect([...src.matchAll(/YearStatusNotice/g)]).toHaveLength(2);
    }
  });
});
