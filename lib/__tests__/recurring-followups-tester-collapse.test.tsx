import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("@/actions/recurring-suggestions", () => ({
  addSuggestedRecurringExpense: vi.fn(),
  dismissSuggestion: vi.fn(),
  restoreSuggestion: vi.fn(),
}));

import { buildUpcomingLedger, todayForNewYork, type LearnedSeriesRow } from "@/lib/upcoming-ledger";
import { collapseLearned, toUiDetection, toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { detectRecurring, applyDismissals, type TxRow } from "@/lib/recurring-detect";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";

(globalThis as unknown as { React: typeof React }).React = React;

// Tester: independent oracle + fuzz for "one row per learned series" and the past-due wording.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const FROM = d("2026-10-08");
const P = "ent-p";
const S = "ent-s";
const E = "ent-e";
const NAMES: Record<string, string> = { [P]: "Personal", [S]: "Sudden Valley", [E]: "EK Consulting" };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const ctx = (isAggregate: boolean, days: number): UiContext => ({
  days,
  bucketSlug: "personal",
  isAggregate,
  entityNameById: NAMES,
  entitySlugById: { [P]: "personal", [S]: "sudden-valley", [E]: "ek-consulting" },
  accountNameById: {},
  includeTransfers: false,
});

const WORD = { weekly: "weekly", biweekly: "every two weeks", monthly: "monthly", quarterly: "quarterly", annual: "yearly" } as const;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthlyOracle(amount: string, cadence: LearnedSeriesRow["cadence"]): Decimal {
  const c = new Decimal(amount).times(100);
  const f = cadence === "weekly" ? c.times(52).div(12) : cadence === "biweekly" ? c.times(26).div(12) : cadence === "quarterly" ? c.div(3) : cadence === "annual" ? c.div(12) : c;
  return f.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

function randomRows(r: () => number, days: number): LearnedSeriesRow[] {
  const out: LearnedSeriesRow[] = [];
  const n = int(r, 0, 12);
  for (let i = 0; i < n; i++) {
    const cadence = pick(r, ["weekly", "biweekly", "monthly", "quarterly", "annual"] as const);
    const dates = new Set<string>();
    const base = int(r, -10, days + 20); // some outside the window
    const step = cadence === "weekly" ? 7 : cadence === "biweekly" ? 14 : cadence === "monthly" ? 30 : 91;
    for (let k = 0; k < int(r, 0, 14); k++) dates.add(new Date(FROM.getTime() + (base + k * step) * 86_400_000).toISOString().slice(0, 10));
    out.push({
      key: `${pick(r, [P, S, E])}|a${i}|out|payee ${i}`,
      entityId: pick(r, [P, S, E]),
      accountId: null,
      payee: `Payee ${i}`,
      kind: pick(r, ["outflow", "outflow", "outflow", "inflow"] as const),
      cadence,
      amount: pick(r, [0, 2.0, 4.25, 15, 21.26, 33.33, 65.95, 250, 1234.56]),
      minAmount: 1,
      maxAmount: 1500,
      amountMode: pick(r, ["fixed", "varies"] as const),
      confidence: pick(r, ["low", "medium", "high", "high"] as const),
      why: "Seen 6 times",
      dates: [...dates].sort(() => r() - 0.5).map(d),
    });
  }
  // series must have unique keys
  return out.map((row, i) => ({ ...row, key: `${row.entityId}|a${i}|out|payee ${i}` }));
}

function agendaMarkup(ledger: ReturnType<typeof toUiLedger>) {
  return renderToStaticMarkup(<UpcomingAgenda ledger={ledger} bucketSlug="personal" horizon={90} showTransfers={false} />);
}

describe("tester: collapseLearned vs an independent oracle (fuzz)", () => {
  it("one row per series; next date, amount, phrase, monthly figure, heading count and totals all match", () => {
    const r = rng(2026_1009);
    let rowsSeen = 0;
    for (let round = 0; round < 400; round++) {
      const days = pick(r, [30, 60, 90]);
      const scope = pick<string | null>(r, [null, P, S]);
      const learned = randomRows(r, days);
      const to = new Date(FROM.getTime() + days * 86_400_000);
      const ledger = buildUpcomingLedger({ from: FROM, days, entityId: scope, learned });
      const ui = toUiLedger(ledger, ctx(scope === null, days));

      // oracle
      const expected = learned
        .filter((l) => l.kind === "outflow" && l.cadence !== "annual" && l.confidence !== "low" && Number(l.amount) > 0 && (scope === null || l.entityId === scope))
        .map((l) => ({ l, inWin: l.dates.filter((x) => x.getTime() >= FROM.getTime() && x.getTime() < to.getTime()).sort((a, b) => a.getTime() - b.getTime()) }))
        .filter((x) => x.inWin.length > 0);

      expect(ui.learnedSeries.map((s) => s.key).sort()).toEqual(expected.map((x) => x.l.key).sort());
      expect(new Set(ui.learnedSeries.map((s) => s.key)).size).toBe(ui.learnedSeries.length); // exactly one row per series
      rowsSeen += ui.learnedSeries.length;

      let monthly = new Decimal(0);
      for (const x of expected) {
        const row = ui.learnedSeries.find((s) => s.key === x.l.key)!;
        const first = x.inWin[0]!;
        const iso = first.toISOString().slice(0, 10);
        const amt = new Decimal(x.l.amount).toFixed(2);
        expect(row.nextDateIso).toBe(iso);
        expect(row.amount).toBe(amt);
        expect(row.datesInWindow).toBe(x.inWin.length);
        expect(row.cadence).toBe(x.l.cadence);
        expect(row.phrase).toBe(`${WORD[x.l.cadence]}, ~$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(Number(amt))}, next ${MON[first.getUTCMonth()]} ${first.getUTCDate()}`);
        const m = monthlyOracle(amt, x.l.cadence);
        expect(row.monthly).toBe(m.div(100).toFixed(2));
        monthly = monthly.plus(m);
      }
      expect(ui.learnedMonthly).toBe(monthly.div(100).toFixed(2));

      // counted fields are untouched by the learned rows (compare against the same ledger without them)
      const bare = toUiLedger(buildUpcomingLedger({ from: FROM, days, entityId: scope }), ctx(scope === null, days));
      const strip = (u: typeof ui) => {
        const rest: Record<string, unknown> = { ...u };
        for (const k of ["learned", "learnedTotal", "learnedSeries", "learnedMonthly", "learnedEntityCounts"]) delete rest[k];
        return JSON.stringify(rest);
      };
      expect(strip(ui)).toBe(strip(bare));

      // markup: heading count == <li> rows; monthly figure only in a scoped view; aggregate shows counts, no money
      const html = agendaMarkup(ui);
      const block = /<section[^>]*data-testid="learned-block"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
      if (expected.length === 0) {
        expect(block).toBe("");
        continue;
      }
      const h = /<h3[^>]*>([^<]*)<\/h3>/.exec(block)?.[1] ?? "";
      const count = Number(/\((\d+) pattern/.exec(h)?.[1]);
      expect(count).toBe(expected.length);
      expect((block.match(/<li[ >]/g) ?? []).length).toBe(expected.length);
      if (scope === null) {
        expect(h).not.toContain("$");
        expect(block).toContain('data-testid="learned-entity-counts"');
        const perEntity = new Map<string, number>();
        for (const x of expected) perEntity.set(NAMES[x.l.entityId] as string, (perEntity.get(NAMES[x.l.entityId] as string) ?? 0) + 1);
        const line = [...perEntity.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, c]) => `${n}: ${c}`).join(", ");
        expect(block).toContain(line);
      } else {
        const fig = /~\$([\d,]+\.\d{2}) a month/.exec(h)?.[1];
        if (monthly.gt(0)) expect(fig?.replace(/,/g, "")).toBe(monthly.div(100).toFixed(2));
        expect(block).toContain("it is not an amount due");
        expect(block).not.toContain('data-testid="learned-entity-counts"');
      }
      // never presented as a due amount: the only "due"-style wording is the explicit denial
      expect(block.replace("it is not an amount due", "")).not.toMatch(/\bdue\b/i);
    }
    expect(rowsSeen).toBeGreaterThan(300);
  });

  it("collapseLearned never reads an item without a cadence, date or amount (defensive)", () => {
    const ledger = buildUpcomingLedger({ from: FROM, days: 30, entityId: P, learned: [] });
    expect(collapseLearned(ledger.learned, ctx(false, 30))).toEqual({ learnedSeries: [], learnedMonthly: "0.00", learnedEntityCounts: [] });
  });

  it("an entity missing from the name map is labelled, never undefined or blended", () => {
    const row: LearnedSeriesRow = {
      key: "ghost|a|out|x", entityId: "ghost", accountId: null, payee: "X", kind: "outflow", cadence: "monthly", amount: 10,
      minAmount: 10, maxAmount: 10, amountMode: "fixed", confidence: "high", why: "w", dates: [d("2026-10-20")],
    };
    const ledger = buildUpcomingLedger({ from: FROM, days: 30, entityId: null, learned: [row] });
    const out = collapseLearned(ledger.learned, ctx(true, 30));
    expect(out.learnedEntityCounts).toEqual([{ entityName: "Unknown entity", count: 1 }]);
  });
});

describe("tester: past-due wording boundaries with the REAL detector", () => {
  const rows = (day: number, n = 8, payee = "google one"): TxRow[] =>
    Array.from({ length: n }, (_, i) => ({
      entityId: P,
      accountId: "a1",
      accountType: "checking",
      accountName: "Primary Checking",
      payee,
      amount: new Decimal("-21.26"),
      postedAt: new Date(Date.UTC(2026, 1 + i, day)),
      tagIds: [],
    }));
  const bundleFor = (today: string, history = rows(6)) => applyDismissals(detectRecurring({ rows: history, modelled: [], today: d(today) }), []);

  it("only a date strictly before today flips the wording; today and the future never do", () => {
    const b = bundleFor("2026-10-08"); // next expected Oct 6, last row Sep 6
    const s = b.suggestions[0]!;
    expect(s.nextExpected.toISOString().slice(0, 10)).toBe("2026-10-06");
    const label = (today: string | undefined) => toUiDetection(b, NAMES, today).suggestions[0]!.nextLabel;
    expect(label("2026-10-05")).toBe("Next expected around Oct 6");
    expect(label("2026-10-06")).toBe("Next expected around Oct 6"); // equal = not past
    expect(label("2026-10-07")).toBe("Expected around Oct 6, not posted yet");
    expect(label("2026-12-31")).toBe("Expected around Oct 6, not posted yet");
    expect(label(undefined)).toBe("Next expected around Oct 6");
    expect(label("")).toBe("Next expected around Oct 6"); // empty string behaves like no date
  });

  it("a series the late rule flagged keeps the 'Next expected' label (the Heads up line carries the message)", () => {
    // six months of day-6 payments, today well past the grace window -> late flag with that series' key
    const b = bundleFor("2026-10-20");
    expect(b.flags.some((f) => f.type === "late" && f.seriesKey === b.suggestions[0]!.key)).toBe(true);
    expect(toUiDetection(b, NAMES, "2026-10-20").suggestions[0]!.nextLabel).toMatch(/^Next expected around /);
  });

  it("medium-confidence (never late-flagged) past dates use the not-posted wording; weak/annual stay undated", () => {
    // a weekly-ish payee with a spread day: medium or low; whatever the detector says, a dated row past today is never 'Next expected'
    for (const day of [3, 12, 21, 28]) {
      const b = bundleFor("2026-10-29", rows(day, 7));
      for (const s of b.suggestions) {
        const ui = toUiDetection(b, NAMES, "2026-10-29").suggestions.find((u) => u.key === s.key)!;
        const iso = s.nextExpected.toISOString().slice(0, 10);
        if (ui.nextLabel === null) continue;
        const flagged = b.flags.some((f) => f.type === "late" && f.seriesKey === s.key);
        if (iso < "2026-10-29" && !flagged) expect(ui.nextLabel).toBe(`Expected around ${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, not posted yet`);
        else expect(ui.nextLabel).toMatch(/^Next expected around /);
      }
    }
  });

  it("New York vs UTC day edge: the ledger's from date (NY) is what the pages pass", () => {
    // 2026-10-09T02:30Z is still Oct 8 in New York
    const now = new Date("2026-10-09T02:30:00Z");
    const today = todayForNewYork(now);
    expect(today.toISOString().slice(0, 10)).toBe("2026-10-08");
    const ui = toUiLedger(buildUpcomingLedger({ from: today, days: 30, entityId: P }), ctx(false, 30));
    expect(ui.fromIso).toBe("2026-10-08");
    const b = bundleFor("2026-10-08");
    // Oct 6 is past on the NY date; a UTC-based "Oct 9" would say the same, but an Oct 8 expectation must NOT flip on Oct 8
    const s = b.suggestions[0]!;
    const moved = { ...b, suggestions: [{ ...s, nextExpected: d("2026-10-08") }] };
    expect(toUiDetection(moved, NAMES, ui.fromIso).suggestions[0]!.nextLabel).toBe("Next expected around Oct 8");
    expect(toUiDetection(moved, NAMES, "2026-10-09").suggestions[0]!.nextLabel).toBe("Expected around Oct 8, not posted yet");
  });
});
