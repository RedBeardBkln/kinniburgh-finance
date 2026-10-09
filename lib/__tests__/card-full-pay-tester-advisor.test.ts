import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";
import { buildForecastView } from "@/lib/advisor/tools/get-forecast";
import type { ForecastInputs } from "@/lib/advisor/queries/forecast";
import type { CardProjection } from "@/lib/card-next-statement";

// TESTER-authored (pipeline task: credit-card-full-pay). D1 (advisor get_forecast hard-coded the funding account) was fixed in
// round 1; these tests pin the fixed behaviour.

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const dec = (s: string) => new Decimal(s);

describe("advisor get_forecast: no hard-coded card funding account (D1, fixed in round 1)", () => {
  it("a jetBlue-like card is drawn from its INFERRED paying account (Primary Checking), not from the account named 'Credit Cards' (D1 fixed)", () => {
    const inputs: ForecastInputs = {
      accounts: [
        { id: "pc", nickname: "Primary Checking", mask: "1111", currentBalance: dec("5000"), currentBalanceAt: new Date("2026-10-09T10:00:00Z"), minimumBalance: dec("250") },
        { id: "cc", nickname: "Credit Cards", mask: "2631", currentBalance: dec("499.09"), currentBalanceAt: new Date("2026-10-09T10:00:00Z"), minimumBalance: dec("250") },
      ],
      transfers: [],
      incomes: [],
      bills: [],
      cardProjections: [
        {
          cardId: "j",
          nickname: "jetBlue",
          entityId: "e",
          funding: { accountId: "pc", accountNickname: "Primary Checking", matches: 6, of: 6 },
          onFile: { dueDate: new Date("2026-10-12T00:00:00Z"), amount: dec("51.26"), paid: null, isFuture: true },
          estimates: [],
          skipReasons: [],
        },
      ],
      cardProjectionsFailed: false,
      entityNameById: {},
    };
    const d = buildForecastView(inputs, new Date("2026-10-09T12:00:00Z"), 30).data as { events: { description: string; account: string }[] };
    const jet = d.events.find((e) => e.description === "jetBlue statement payment");
    expect(jet?.account).toBe("Primary Checking");
  });

  it("the advisor forecast tool does not name a funding account by nickname (should use the inferred paying account)", () => {
    const s = src("lib/advisor/tools/get-forecast.ts");
    expect(s).not.toMatch(/CARD_FUNDING_NICKNAME|"Credit Cards"/);
  });
});

// ── Round 1 re-test: the advisor forecast uses the same card logic as the Forecast page ──


describe("advisor get_forecast card payments (round 1)", () => {
  const NOW = new Date("2026-10-09T12:00:00Z");
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const acct = (id: string, nickname: string, balance: string, entityId = "ent-p") => ({
    id, entityId, nickname, mask: "1111", currentBalance: dec(balance), currentBalanceAt: new Date("2026-10-09T10:00:00Z"), minimumBalance: dec("250"),
  });
  const est = (due: string, amount: string, confidence: "high" | "medium" | "low", kind: "cycle_to_date" | "typical_month" = "cycle_to_date") => ({
    kind, dueDate: d(due), amount: dec(amount), confidence, why: "basis", closeDate: null, daysToClose: 2, upTo: null,
  });
  const proj = (over: Partial<CardProjection> & { acct?: string | null }): CardProjection => {
    const { acct: a, ...rest } = over;
    return {
      cardId: "x", nickname: "X", entityId: "ent-p",
      funding: a === null || a === undefined ? null : { accountId: a, accountNickname: a, matches: 6, of: 6 },
      onFile: null, estimates: [], skipReasons: [], ...rest,
    };
  };
  const base = (cardProjections: CardProjection[], extra: Partial<ForecastInputs> = {}): ForecastInputs => ({
    accounts: [acct("pc", "Primary Checking", "5000"), acct("cc", "Credit Cards", "1000")],
    transfers: [], incomes: [], bills: [], cardProjections, cardProjectionsFailed: false,
    entityNameById: { "ent-p": "Personal", "ent-ek": "Eric Kinniburgh Consulting, LLC" }, ...extra,
  });
  type View = { accounts: { account: string; projected_minimum_balance: number; ending_balance: number }[]; events: { date: string; description: string; amount: number; account: string; estimate?: boolean }[]; cards_without_paying_account?: string[]; notes: string[]; events_truncated?: boolean; event_count?: number };
  const view = (i: ForecastInputs, days = 90, filter?: string) => buildForecastView(i, NOW, days, filter).data as View;

  const fixture = () => base([
    proj({ cardId: "b", nickname: "Barclay", acct: "cc", onFile: { dueDate: d("2026-10-20"), amount: dec("623.19"), paid: { date: d("2026-10-04"), amount: dec("623.19"), rule: "payment_inflows", via: "x" }, isFuture: true }, estimates: [est("2026-11-05", "2914.91", "high")] }),
    proj({ cardId: "c", nickname: "Capital One", entityId: "ent-ek", acct: "cc", onFile: { dueDate: d("2026-10-12"), amount: dec("792.68"), paid: null, isFuture: true }, estimates: [est("2026-11-12", "72.56", "medium")] }),
    proj({ cardId: "j", nickname: "jetBlue", acct: "pc", onFile: { dueDate: d("2026-10-12"), amount: dec("51.26"), paid: null, isFuture: true } }),
    proj({ cardId: "q", nickname: "Quiet", acct: null, onFile: { dueDate: d("2026-10-15"), amount: dec("10"), paid: { date: d("2026-10-08"), amount: dec("10"), rule: "payment_inflows", via: "x" }, isFuture: true } }), // undetermined but nothing to place: not listed
    proj({ cardId: "m", nickname: "Mystery", acct: null, onFile: { dueDate: d("2026-10-15"), amount: dec("10"), paid: null, isFuture: true }, estimates: [est("2026-11-15", "30", "low")] }),
  ]);

  it("paid statement skipped, estimates flagged, other-entity card labelled, funding by inference, undetermined card unassigned and named", () => {
    const v = view(fixture());
    const card = v.events.filter((e) => /statement payment/.test(e.description));
    const row = (t: string) => card.filter((e) => e.description.includes(t));
    expect(row("Barclay").map((e) => [e.date, e.amount, e.account, e.estimate === true])).toEqual([["2026-11-05", -2914.91, "Credit Cards", true]]); // the paid Oct 20 statement is absent
    expect(row("Capital One").map((e) => [e.date, e.amount, e.account, e.estimate === true])).toEqual([["2026-10-12", -792.68, "Credit Cards", false], ["2026-11-12", -72.56, "Credit Cards", true]]);
    expect(row("Capital One").every((e) => e.description.includes("(Eric Kinniburgh Consulting, LLC card)"))).toBe(true);
    expect(row("Barclay").some((e) => e.description.includes("card)"))).toBe(false);
    expect(row("jetBlue").map((e) => [e.account, e.amount])).toEqual([["Primary Checking", -51.26]]);
    expect(row("Mystery")).toEqual([]);
    expect(v.cards_without_paying_account).toEqual(["Mystery"]);
    expect(v.notes.join(" ")).toContain("cards_without_paying_account");
    // balance math: Credit Cards 1000 - 792.68 - 2914.91 - 72.56
    const cc = v.accounts.find((a) => a.account === "Credit Cards")!;
    expect(cc.projected_minimum_balance).toBeCloseTo(1000 - 792.68 - 2914.91 - 72.56, 2);
    expect(cc.ending_balance).toBeCloseTo(1000 - 792.68 - 2914.91 - 72.56, 2);
  });

  it("an account filter shows only that account's cards; a load failure is stated; the horizon limits far-out estimates", () => {
    const v = view(fixture(), 30, "primary checking");
    expect(v.events.map((e) => e.description)).toEqual(["jetBlue statement payment"]);
    const failed = view(base([], { cardProjectionsFailed: true }));
    expect(failed.notes.join(" ")).toContain("could not be loaded");
    const short = view(fixture(), 7);
    expect(short.events.filter((e) => /Barclay/.test(e.description))).toEqual([]);
  });

  it("the 60-event cap says so (events_truncated + event_count) while the balance projection still includes the dropped events", () => {
    const weekly = Array.from({ length: 1 }, (_, i) => ({ id: `t${i}`, fromAccountId: "pc", toAccountId: "cc", amount: dec("1.00"), cadence: "weekly", dayRules: { dayOfWeek: 1 }, purpose: "x", active: true }));
    const daily = Array.from({ length: 70 }, (_, i) => ({ id: `i${i}`, accountId: "pc", description: `Pay ${i}`, cadence: "monthly", dayRules: { dayOfMonth: (i % 27) + 1 }, amount: dec("1.00"), active: true }));
    const inputs = base([proj({ cardId: "b", nickname: "Barclay", acct: "cc", estimates: [est("2027-01-05", "500", "low", "typical_month")] })], { transfers: weekly, incomes: daily });
    const v = view(inputs, 90);
    expect(v.events_truncated).toBe(true);
    expect(v.event_count!).toBeGreaterThan(60);
    expect(v.events).toHaveLength(60);
    // the Jan 5 estimate is past the cap in the list but inside the balance (ending balance lower than start by >= 500)
    const cc = v.accounts.find((a) => a.account === "Credit Cards")!;
    expect(cc.ending_balance).toBeLessThan(1000 - 400);
  });
});
