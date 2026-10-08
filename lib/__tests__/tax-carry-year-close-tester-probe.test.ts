import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { Prisma } from "@prisma/client";

// TESTER probe for tax-carry-screen-and-year-close. Independent oracles + adversarial inputs against the REAL pure code, the REAL
// actions and the REAL store, with a db boundary fake that RECORDS EVERY property access (so "no database call" means no access at all).
(globalThis as unknown as { React: typeof React }).React = React;

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));

type Row = Record<string, unknown> & { id: string; entityId: string; factKey: string; version: number; archivedAt: Date | null };
const state = vi.hoisted(() => ({
  facts: [] as unknown[],
  events: [] as unknown[],
  nextId: 1,
  accessed: [] as string[],
  closeFindError: null as unknown,
  yieldInCreate: false,
}));

const base = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  entity: { findFirst: vi.fn() },
  taxFact: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  taxYearCloseEvent: { findMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
// Every top-level property read of `db` is logged: a refused request must leave this empty.
vi.mock("@/lib/db", () => ({
  db: new Proxy(base, {
    get(target, prop) {
      state.accessed.push(String(prop));
      return (target as Record<string | symbol, unknown>)[prop];
    },
  }),
}));

import { reconfirmTaxFact } from "@/actions/tax-facts";
import { changeTaxFactForCarry } from "@/actions/tax-facts-carry";
import { closeTaxYear, reopenTaxYear } from "@/actions/tax-year-close";
import { buildCarryScreen } from "@/lib/tax-facts/carry-screen";
import { resolveCarryForward, type CarryRow } from "@/lib/tax-facts/carry-forward";
import { carryTargetYears, checkCarryTarget, currentCalendarYear, defaultCarryTarget } from "@/lib/tax-facts/carry-target";
import { TAX_FACTS_SEED_TY2025 } from "@/lib/tax-facts/seed-ty2025";
import { CarryForwardReview } from "@/components/tax/facts/carry-forward-review";
import { YearStatusNotice } from "@/components/tax/year-status-notice";
import { insertCloseEvent, loadYearCloseStates, readLatestClosedYear } from "@/lib/tax-year-close-store";
import { foldYearState } from "@/lib/tax-year-close/state";
import { parseFiledOn, validateCloseNote, validateReopenReason } from "@/lib/tax-year-close/validate";
import { findCpaWording } from "@/lib/tax-wording";
import type { YearCloseEventRow } from "@/lib/tax-year-close/types";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const ERIC = "11111111-1111-4111-8111-111111111111";
const EVA = "33333333-3333-4333-8333-333333333333";
const PERSONAL = "22222222-2222-4222-8222-222222222222";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (typeof v === "object" && v !== null && "in" in v) {
      if (!(v as { in: unknown[] }).in.includes(r[k])) return false;
    } else if (r[k] !== v) return false;
  }
  return true;
}

const facts = () => state.facts as Row[];
const events = () => state.events as Array<Record<string, unknown> & { taxYear: number; seq: number; kind: string }>;

function seedFact(o: Partial<Row>): void {
  state.facts.push({
    id: `fact-${state.nextId++}`, entityId: PERSONAL, factKey: "household.filing_status", version: 1, category: "household",
    label: "Filing status", taxYear: 2025, valueKind: "choice", valueCents: null, valueText: "mfj", carryPolicy: "reconfirm",
    changeKind: "established", sourceKind: "owner_statement", sourceRef: null, reason: null,
    confirmedAt: new Date("2026-10-07T15:00:00Z"), setByName: "Eric", setAt: new Date("2026-10-07T15:00:00Z"), archivedAt: null, ...o,
  });
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" });
}
function p2021() {
  return new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "t" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T15:00:00Z"));
  vi.clearAllMocks();
  state.facts = [];
  state.events = [];
  state.nextId = 1;
  state.accessed = [];
  state.closeFindError = null;
  state.yieldInCreate = false;
  authMock.mockResolvedValue({ user: { id: ERIC } });
  base.user.findUnique.mockResolvedValue({ name: "Eric Kinniburgh" });
  base.user.findMany.mockResolvedValue([
    { id: ERIC, name: "Eric Kinniburgh" },
    { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
  ]);
  base.entity.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    args.where.slug === "ek-consulting" ? { id: "ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", navLabel: null, type: "business" } : { id: PERSONAL }
  );
  base.auditLog.create.mockResolvedValue({});
  base.$transaction.mockImplementation(async (fn: (tx: typeof base) => Promise<unknown>) => fn(base));
  base.taxFact.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    facts().filter((r) => matches(r, args.where)).sort((a, b) => b.version - a.version)
  );
  base.taxFact.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    facts().filter((r) => matches(r, args.where)).sort((a, b) => b.version - a.version)[0] ?? null
  );
  base.taxFact.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `fact-${state.nextId++}`, archivedAt: null, setAt: new Date(), ...args.data } as unknown as Row;
    state.facts.push(row);
    return row;
  });
  base.taxFact.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of facts()) if (matches(r, args.where)) { Object.assign(r, args.data); count += 1; }
    return { count };
  });
  base.taxYearCloseEvent.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (state.closeFindError) throw state.closeFindError;
    return events().filter((e) => matches(e, args.where)).sort((a, b) => a.taxYear - b.taxYear || a.seq - b.seq).map((e) => ({ ...e }));
  });
  base.taxYearCloseEvent.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (state.yieldInCreate) await Promise.resolve();
    const d = args.data as { entityId: string; taxYear: number; seq: number; kind: string };
    if (events().some((e) => e.entityId === d.entityId && e.taxYear === d.taxYear && e.seq === d.seq)) throw p2002();
    const row = { id: `ev-${state.nextId++}`, at: new Date(), createdAt: new Date(), ...args.data } as unknown as Record<string, unknown> & { taxYear: number; seq: number; kind: string };
    state.events.push(row);
    return row;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------------------------------------------------------------------
// A. Carry screen vs an independent oracle
// ------------------------------------------------------------------------------------------------------------------------------

const POLICIES = ["stable", "reconfirm", "year_specific", "derived"] as const;
const KINDS = ["established", "changed", "reconfirmed", "retired", "resolved"] as const;

function randomRows(r: () => number): CarryRow[] {
  const out: CarryRow[] = [];
  const nKeys = 3 + Math.floor(r() * 9);
  for (let k = 0; k < nKeys; k += 1) {
    const isOpen = r() < 0.2;
    let year = 2023 + Math.floor(r() * 3);
    const nVersions = 1 + Math.floor(r() * 4);
    for (let v = 1; v <= nVersions; v += 1) {
      if (r() < 0.5) year += Math.floor(r() * 3);
      out.push({
        factKey: `k${k}`, version: v, category: isOpen ? "open_item" : k % 4 === 0 ? "decision" : "household", label: `L${k}`, taxYear: year,
        valueKind: isOpen ? "open_item" : "text", valueCents: null, valueText: `v${k}.${v}`,
        carryPolicy: POLICIES[Math.floor(r() * POLICIES.length)] as CarryRow["carryPolicy"],
        changeKind: v === 1 ? "established" : (KINDS[Math.floor(r() * KINDS.length)] as CarryRow["changeKind"]),
        sourceKind: "owner_statement", confirmedAt: new Date("2026-10-07T15:00:00Z"),
      });
    }
  }
  return out;
}

function shuffle<T>(a: readonly T[], r: () => number): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j] as T, b[i] as T]; }
  return b;
}

describe("A. buildCarryScreen equals an independent oracle on random histories", () => {
  it("600 random histories x targets 2026..2028: membership, flags, source version and value, no synthesis", () => {
    const r = rng(20261007);
    for (let i = 0; i < 600; i += 1) {
      const rows = shuffle(randomRows(r), r);
      const target = 2026 + Math.floor(r() * 3);
      const screen = buildCarryScreen(rows, target);
      // Oracle: per key the highest version with taxYear <= target.
      const best = new Map<string, CarryRow>();
      for (const row of rows) {
        if (row.taxYear > target) continue;
        const cur = best.get(row.factKey);
        if (!cur || row.version > cur.version) best.set(row.factKey, row);
      }
      const expected: Record<string, string[]> = { needs: [], fresh: [], open: [], carried: [], already: [] };
      for (const row of best.values()) {
        if (row.changeKind === "retired" || row.changeKind === "resolved") continue;
        if (row.valueKind === "open_item") expected.open?.push(row.factKey);
        else if (row.taxYear === target) expected.already?.push(row.factKey);
        else if (row.carryPolicy === "stable") expected.carried?.push(row.factKey);
        else if (row.carryPolicy === "year_specific") expected.fresh?.push(row.factKey);
        else expected.needs?.push(row.factKey);
      }
      const got = {
        needs: screen.needsReconfirmation.items, fresh: screen.askFresh.items, open: screen.openItems.items,
        carried: screen.carried.items, already: screen.alreadyConfirmed.items,
      };
      for (const name of Object.keys(got) as Array<keyof typeof got>) {
        expect(got[name].map((x) => x.factKey).sort(), `${name} @${target} #${i}`).toEqual([...(expected[name] ?? [])].sort());
      }
      // Flags per bucket
      for (const it of got.needs) expect([it.canStillTrue, it.canChange, it.canAnswer, it.canSameAnswer, it.resolveHref]).toEqual([true, true, false, false, null]);
      for (const it of got.fresh) expect([it.canStillTrue, it.canChange, it.canAnswer, it.canSameAnswer, it.referenceOnly]).toEqual([false, false, true, true, true]);
      for (const it of got.open) expect([it.canStillTrue, it.canChange, it.canAnswer, it.canSameAnswer, it.resolveHref]).toEqual([false, false, false, false, "/tax/facts"]);
      for (const it of [...got.carried, ...got.already]) expect([it.canStillTrue, it.canChange, it.canAnswer, it.canSameAnswer]).toEqual([false, true, false, false]);
      // Source version and value are exactly the stored row's: nothing synthesised.
      for (const it of Object.values(got).flat()) {
        const src = best.get(it.factKey) as CarryRow;
        expect([it.fromTaxYear, it.fromVersion, it.valueText, it.valueCents]).toEqual([src.taxYear, src.version, src.valueText, src.valueCents]);
        expect(it.isDecision).toBe(src.category === "decision");
      }
      // The same as the resolver the page is documented to mirror.
      const res = resolveCarryForward(rows, target);
      expect(screen.needsReconfirmation.items.map((x) => x.factKey)).toEqual(res.needsReconfirmation.map((x) => x.factKey));
      expect(screen.askFresh.items.map((x) => x.factKey)).toEqual(res.askFresh.map((x) => x.factKey));
      // Only an ask-fresh item is ever reference-only; a stable key is never offered a confirmation.
      for (const it of [...got.carried, ...got.already, ...got.needs, ...got.open]) expect(it.referenceOnly).toBe(false);
    }
  });
});

describe("A. the real seed rendered through the real component", () => {
  const seedRows: CarryRow[] = TAX_FACTS_SEED_TY2025.map((s) => ({
    factKey: s.factKey, version: 1, category: s.category, label: s.label, taxYear: s.taxYear, valueKind: s.valueKind,
    valueCents: s.valueCents ?? null, valueText: s.valueText ?? null, carryPolicy: s.carryPolicy, changeKind: "established",
    sourceKind: s.sourceKind, confirmedAt: new Date("2026-10-07T15:00:00Z"),
  }));
  const render = (target: number) => {
    const html = renderToStaticMarkup(createElement(CarryForwardReview, { screen: buildCarryScreen(seedRows, target), years: [2026, 2027] }));
    const rowsHtml = html.split("<li ").slice(1).map((s) => "<li " + s.split("</li>")[0]);
    return { html, rowsHtml };
  };

  it("TY2026: decision rows X1/X5/X6/X7/X8 are individual, keep the recall note, and no bulk control exists", () => {
    const { html, rowsHtml } = render(2026);
    const plain = (s: string) => s.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const decisionKeys = ["decision.x1.home_office_method", "decision.x5.arbor_rd_property_tax", "decision.x6.internet_phone_business_pct", "decision.x7.federal_overpayment", "decision.x8.ct_overpayment"];
    for (const k of decisionKeys) {
      const li = rowsHtml.filter((x) => x.includes(`data-fact-key="${k}"`));
      expect(li, k).toHaveLength(1);
      expect(plain(li[0] as string)).toContain("Recorded copy for recall; the return uses the decision recorded on the Tax Forms page.");
      expect((li[0] as string).match(/<button/g)?.length, k).toBe(2); // exactly "Still true" + "It changed"
    }
    expect(html).not.toMatch(/type="checkbox"|<select|<input|multiple|Confirm all|Confirm selected|confirm all|Select all/i);
    // one Still-true button per needs-confirmation row, nowhere else
    const screen = buildCarryScreen(seedRows, 2026);
    expect((html.match(/Still true for TY2026/g) ?? []).length).toBe(screen.needsConfirmationCount);
    expect(screen.totalCount).toBe(seedRows.length); // every seed row is in some bucket for 2026, none dropped, none invented
  });

  it("open items get no button; ask-fresh rows are reference only with Answer, no Still true; every row names its TY2025 source", () => {
    const { rowsHtml } = render(2026);
    const openKeys = seedRows.filter((r) => r.valueKind === "open_item").map((r) => r.factKey);
    expect(openKeys.length).toBeGreaterThan(0);
    for (const k of openKeys) {
      const li = rowsHtml.find((x) => x.includes(`data-fact-key="${k}"`)) as string;
      expect(li).toBeDefined();
      expect(li).not.toContain("<button");
      expect(li).toContain("Question, not a fact");
    }
    const freshKeys = seedRows.filter((r) => r.carryPolicy === "year_specific" && r.valueKind !== "open_item").map((r) => r.factKey);
    expect(freshKeys.length).toBeGreaterThan(0);
    for (const k of freshKeys) {
      const li = rowsHtml.find((x) => x.includes(`data-fact-key="${k}"`)) as string;
      expect(li).toContain("Reference only:");
      expect(li).toContain("Answer for TY2026");
      expect(li).not.toContain("Still true");
    }
    for (const li of rowsHtml.filter((x) => x.includes("data-fact-key"))) expect(li).toMatch(/TY20(25|26)/);
  });

  it("TY2027: nothing is silently marked confirmed; a TY2026-only reconfirmation of one key leaves the other 2025 rows needing confirmation", () => {
    const rows2 = [...seedRows, { ...seedRows.find((r) => r.carryPolicy === "reconfirm" && r.valueKind !== "open_item") as CarryRow, version: 2, taxYear: 2026, changeKind: "reconfirmed" as const }];
    const s26 = buildCarryScreen(rows2, 2026);
    const s27 = buildCarryScreen(rows2, 2027);
    const b26 = buildCarryScreen(seedRows, 2026);
    const b27 = buildCarryScreen(seedRows, 2027);
    // (the seed itself has a few rows stamped 2026, so compare against the unreconfirmed baseline)
    expect(s26.alreadyConfirmed.items).toHaveLength(b26.alreadyConfirmed.items.length + 1);
    expect(s26.needsConfirmationCount).toBe(b26.needsConfirmationCount - 1);
    expect(s27.needsConfirmationCount).toBe(b27.needsConfirmationCount); // the 2026 reconfirmation does not carry: asked again for 2027
    expect(s27.alreadyConfirmed.items).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// A. Carry target year
// ------------------------------------------------------------------------------------------------------------------------------

describe("A. carry target years, America/New_York", () => {
  function nyYear(d: Date): number {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour12: false }).formatToParts(d);
    return Number(p.find((x) => x.type === "year")?.value);
  }
  it("random instants 2025..2030: currentCalendarYear and the offered range match an independent computation", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i += 1) {
      const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 6 * 365 * 86400000));
      const closed = r() < 0.5 ? null : 2025 + Math.floor(r() * 4);
      expect(currentCalendarYear(d)).toBe(nyYear(d));
      const first = Math.max(2026, (closed ?? 0) + 1);
      const last = nyYear(d) + 1;
      const years = carryTargetYears({ latestClosedYear: closed, now: d });
      expect(years).toEqual(Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => first + k));
      expect(defaultCarryTarget({ latestClosedYear: closed, now: d })).toBe(first);
      for (const y of [2024, 2025, 2026, 2027, 2028, 2029, 2030]) {
        const ok = checkCarryTarget(y, { latestClosedYear: closed, now: d }).ok;
        expect(ok, `${y} closed=${String(closed)} now=${d.toISOString()}`).toBe(y >= 2026 && (closed === null || y > closed) && y <= last);
      }
    }
  });
  it("the New Year's boundary: 2026-12-31 23:59:59 ET is still 2026; 2027-01-01 00:00:00 ET is 2027", () => {
    expect(checkCarryTarget(2028, { latestClosedYear: null, now: new Date("2027-01-01T04:59:59Z") }).ok).toBe(false);
    expect(checkCarryTarget(2028, { latestClosedYear: null, now: new Date("2027-01-01T05:00:00Z") }).ok).toBe(true);
  });
  it("non-integers and extremes are refused", () => {
    for (const y of [Number.NaN, 2025.5, Infinity, -Infinity, 2026.0000001]) expect(checkCarryTarget(y, { latestClosedYear: null, now: new Date() }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// A. The two carry writers: refusal leaves the database UNTOUCHED (every property read is logged)
// ------------------------------------------------------------------------------------------------------------------------------

describe("A. writers refuse TY2025 and earlier with zero database property access", () => {
  const BAD_YEARS: unknown[] = [2025, 2024, 2000, 1999, 1900, 0, -1, 2025.5, Number.NaN, Infinity, "2025", null, undefined, [2025], { y: 2025 }, 2999, 2028];
  it("reconfirmTaxFact", async () => {
    seedFact({});
    for (const taxYear of BAD_YEARS) {
      const res = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: taxYear as number });
      expect(res.ok, String(taxYear)).toBe(false);
    }
    expect(state.accessed).toEqual([]);
    expect(facts()).toHaveLength(1);
  });
  it("changeTaxFactForCarry", async () => {
    seedFact({});
    for (const taxYear of BAD_YEARS) {
      const res = await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: taxYear as number, valueText: "mfs", reason: "Filing separately now" });
      expect(res.ok, String(taxYear)).toBe(false);
    }
    expect(state.accessed).toEqual([]);
    expect(facts()).toHaveLength(1);
  });
  it("a decision fact for TY2025 through either writer is refused with nothing read", async () => {
    seedFact({ factKey: "decision.x7.federal_overpayment", category: "decision", valueText: "refund" });
    expect((await reconfirmTaxFact({ factKey: "decision.x7.federal_overpayment", taxYear: 2025 })).ok).toBe(false);
    expect((await changeTaxFactForCarry({ factKey: "decision.x7.federal_overpayment", taxYear: 2025, valueText: "apply", reason: "Changed my mind" })).ok).toBe(false);
    expect(state.accessed).toEqual([]);
  });
  it("a private-looking reason/value is refused before ANY database access, even for a valid year", async () => {
    seedFact({});
    for (const t of ["123-45-6789", "ssn 123456789", "EIN 12-3456789", "acct 1234567890", "date of birth 1/2/1980"]) {
      expect((await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: t })).ok).toBe(false);
      expect((await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: t, reason: "A fine reason" })).ok).toBe(false);
      expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026, reason: t })).ok).toBe(false);
    }
    expect(state.accessed).toEqual([]);
  });
  it("a valid 2026 reconfirm appends v2 for 2026 and only sets archivedAt on v1", async () => {
    seedFact({});
    const res = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 });
    expect(res.ok).toBe(true);
    const v1 = facts().find((f) => f.version === 1) as Row;
    const v2 = facts().find((f) => f.version === 2) as Row;
    expect(v1.archivedAt).toBeInstanceOf(Date);
    expect([v2.taxYear, v2.changeKind, v2.valueText, v2.archivedAt]).toEqual([2026, "reconfirmed", "mfj", null]);
    expect(v1.valueText).toBe("mfj");
    expect(v1.taxYear).toBe(2025);
  });
  it("an open item cannot be reconfirmed or changed via the carry writers", async () => {
    seedFact({ factKey: "open.q", category: "open_item", valueKind: "open_item", valueText: "Question?" });
    expect((await reconfirmTaxFact({ factKey: "open.q", taxYear: 2026 })).ok).toBe(false);
    expect(facts()).toHaveLength(1);
  });
});

describe("B. the carry guard: closed year, reopened year, unreadable state", () => {
  function closedEvent(year: number, seq = 1, kind: "closed" | "reopened" = "closed") {
    state.events.push({ id: `ev-${state.nextId++}`, entityId: PERSONAL, taxYear: year, seq, kind, filedOn: kind === "closed" ? new Date("2027-01-12T12:00:00Z") : null, note: null, byId: ERIC, byName: "Eric", at: new Date(), createdAt: new Date() });
  }
  it("closed 2026 refuses 2026 in both writers with no taxFact access and no transaction; 2027 is allowed", async () => {
    seedFact({});
    closedEvent(2026);
    state.accessed = [];
    expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).ok).toBe(false);
    expect((await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "reason!" })).ok).toBe(false);
    expect(state.accessed).not.toContain("taxFact");
    expect(state.accessed).not.toContain("$transaction");
    expect(facts()).toHaveLength(1);
    expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2027 })).ok).toBe(true);
  });
  it("an EARLIER target than the latest closed year is refused (closed 2027, target 2026)", async () => {
    seedFact({});
    closedEvent(2027);
    expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).ok).toBe(false);
  });
  it("closed then reopened 2026 no longer blocks", async () => {
    seedFact({});
    closedEvent(2026, 1, "closed");
    closedEvent(2026, 2, "reopened");
    expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).ok).toBe(true);
  });
  it("a generic read error refuses and writes nothing; only a missing table (P2021) reads as 'nothing closed'", async () => {
    seedFact({});
    state.closeFindError = new Error("connection reset");
    const a = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 });
    const b = await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "reason!" });
    expect([a.ok, b.ok]).toEqual([false, false]);
    expect(base.taxFact.create).not.toHaveBeenCalled();
    expect(base.taxFact.updateMany).not.toHaveBeenCalled();
    state.closeFindError = p2021();
    expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).ok).toBe(true);
  });
  it("an entity lookup that throws is also fail-closed for the guard", async () => {
    seedFact({});
    base.entity.findFirst.mockRejectedValue(new Error("pool down"));
    const a = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 });
    expect(a.ok).toBe(false);
    expect(base.taxFact.create).not.toHaveBeenCalled();
  });
  it("a stored event with an unknown kind makes the guard refuse (state unknowable), the display an error", async () => {
    seedFact({});
    state.events.push({ id: "e", entityId: PERSONAL, taxYear: 2026, seq: 1, kind: "weird", filedOn: null, note: null, byId: null, byName: "x", at: new Date(), createdAt: new Date() });
    expect((await readLatestClosedYear()).ok).toBe(false);
    expect((await loadYearCloseStates()).state).toBe("error");
    expect((await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// B. Year close: sequence fuzz against an oracle through the real action + store, racing tabs, parse/privacy matrices
// ------------------------------------------------------------------------------------------------------------------------------

describe("B. close/reopen sequence fuzz through the real actions", () => {
  it("random op sequences by Eric and Eva: state follows the oracle, seq is contiguous, rows are never changed", async () => {
    const r = rng(99);
    for (let round = 0; round < 25; round += 1) {
      state.events = [];
      let oracle: "open" | "closed" | "reopened" = "open";
      let seq = 0;
      for (let step = 0; step < 14; step += 1) {
        const eva = r() < 0.2;
        authMock.mockResolvedValue({ user: { id: eva ? EVA : ERIC } });
        const doClose = r() < 0.5;
        const shortReason = r() < 0.15;
        const before = JSON.stringify(events());
        const res = doClose
          ? await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: r() < 0.5 ? "federal e-filed" : null })
          : await reopenTaxYear({ taxYear: 2025, reason: shortReason ? "x" : "Found a missed 1099-INT" });
        const expectOk = !eva && (doClose ? oracle !== "closed" : oracle === "closed" && !shortReason);
        expect(res.ok, `round ${round} step ${step} close=${doClose} eva=${eva} oracle=${oracle} -> ${JSON.stringify(res)}`).toBe(expectOk);
        if (res.ok) {
          seq += 1;
          expect(res.seq).toBe(seq);
          oracle = doClose ? "closed" : "reopened";
        } else {
          expect(JSON.stringify(events())).toBe(before);
        }
        const rows = events();
        expect(rows.map((e) => e.seq)).toEqual(Array.from({ length: seq }, (_, i) => i + 1));
        const folded = foldYearState(2025, rows as unknown as YearCloseEventRow[]);
        expect(folded.status).toBe(oracle);
      }
    }
  });

  it("two tabs racing a close: exactly one row, the loser gets code conflict (never a duplicate seq)", async () => {
    state.yieldInCreate = true;
    const [a, b] = await Promise.all([
      closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" }),
      closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.code).toBe("conflict");
    expect(events()).toHaveLength(1);
    // the losing transaction wrote no audit row either: one audit row per committed event in this fake means exactly 1 from the winner
    expect(base.auditLog.create.mock.calls.length).toBe(1);
  });

  it("racing close then reopen from stale state: both tabs read 'closed', both reopen -> one conflict", async () => {
    await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    state.yieldInCreate = true;
    const [a, b] = await Promise.all([reopenTaxYear({ taxYear: 2025, reason: "Amend for 1099" }), reopenTaxYear({ taxYear: 2025, reason: "Amend for 1099 again" })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(events().map((e) => e.seq)).toEqual([1, 2]);
  });

  it("audit rows: exact key set, no note/reason/date/name; the stored note never leaks into audit", async () => {
    const NOTE = "ZZNOTEMARKER filed via the web";
    const REASON = "ZZREASONMARKER amended";
    expect((await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: NOTE })).ok).toBe(true);
    expect((await reopenTaxYear({ taxYear: 2025, reason: REASON })).ok).toBe(true);
    expect(base.auditLog.create).toHaveBeenCalledTimes(2);
    for (const call of base.auditLog.create.mock.calls) {
      const data = (call[0] as { data: { changeType: string; before: unknown; after: Record<string, unknown> } }).data;
      expect(Object.keys(data.after).sort()).toEqual(["id", "kind", "seq", "taxYear"]);
      const s = JSON.stringify(data);
      for (const bad of ["ZZNOTEMARKER", "ZZREASONMARKER", "2026-10-12", "Eric", "Kinniburgh", "filed via"]) expect(s).not.toContain(bad);
    }
    expect((base.auditLog.create.mock.calls.map((c) => (c[0] as { data: { changeType: string } }).data.changeType))).toEqual(["tax_year_close", "tax_year_reopen"]);
    // and the note really was stored (the record exists where it belongs)
    expect(events()[0]?.note).toBe(NOTE);
    expect(events()[1]?.note).toBe(REASON);
  });

  it("the real action never calls update/delete/upsert on the close table or touches taxWorkspace / taxFact", async () => {
    await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    await reopenTaxYear({ taxYear: 2025, reason: "Amend" });
    expect(state.accessed.filter((p) => !["user", "entity", "taxYearCloseEvent", "auditLog", "$transaction"].includes(p))).toEqual([]);
  });

  it("insertCloseEvent: an unrecognised stored kind refuses the insert", async () => {
    state.events.push({ id: "e", entityId: PERSONAL, taxYear: 2025, seq: 1, kind: "weird", filedOn: null, note: null, byId: null, byName: "x", at: new Date(), createdAt: new Date() });
    const res = await insertCloseEvent(PERSONAL, { id: ERIC, name: "Eric" }, { kind: "closed", taxYear: 2025, filedOn: "2026-10-12" }, new Date());
    expect(res.ok).toBe(false);
    expect(events()).toHaveLength(1);
  });

  it("a non-P2002 create failure is not mapped to a fake success (it propagates)", async () => {
    base.taxYearCloseEvent.create.mockRejectedValueOnce(new Error("boom"));
    await expect(closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" })).rejects.toThrow("boom");
    expect(events()).toHaveLength(0);
  });
});

describe("B. parseFiledOn / note / reason matrices", () => {
  const T = (iso: string) => new Date(iso);
  it("calendar and timezone boundaries", () => {
    // 2026-10-13T02:00Z is still Oct 12 in New York
    expect(parseFiledOn("2026-10-12", 2025, T("2026-10-13T02:00:00Z")).ok).toBe(true);
    expect(parseFiledOn("2026-10-13", 2025, T("2026-10-13T02:00:00Z")).ok).toBe(false);
    expect(parseFiledOn("2026-10-13", 2025, T("2026-10-13T05:00:00Z")).ok).toBe(true);
    // DST fall-back day: 2026-11-01 05:30Z is 01:30 EDT, 06:30Z is 01:30 EST: both Nov 1 in NY
    expect(parseFiledOn("2026-11-01", 2025, T("2026-11-01T05:30:00Z")).ok).toBe(true);
    expect(parseFiledOn("2026-11-02", 2025, T("2026-11-01T06:30:00Z")).ok).toBe(false);
    // Jan 1 floor
    expect(parseFiledOn("2026-01-01", 2025, T("2026-10-13T15:00:00Z")).ok).toBe(true);
    expect(parseFiledOn("2025-12-31", 2025, T("2026-10-13T15:00:00Z")).ok).toBe(false);
    // leap day
    expect(parseFiledOn("2028-02-29", 2027, T("2028-03-01T15:00:00Z")).ok).toBe(true);
    expect(parseFiledOn("2027-02-29", 2026, T("2027-03-01T15:00:00Z")).ok).toBe(false);
    expect(parseFiledOn("2026-02-29", 2025, T("2026-10-13T15:00:00Z")).ok).toBe(false);
    expect(parseFiledOn("2026-04-31", 2025, T("2026-10-13T15:00:00Z")).ok).toBe(false);
    expect(parseFiledOn("2026-13-01", 2025, T("2026-10-13T15:00:00Z")).ok).toBe(false);
    expect(parseFiledOn("2026-00-10", 2025, T("2026-10-13T15:00:00Z")).ok).toBe(false);
  });
  it("junk shapes are refused; the stored date is noon UTC (the same New York day)", () => {
    for (const bad of ["", " ", "2026/10/12", "2026-1-5", "26-10-12", "2026-10-12T00:00:00Z", "2026-10-12 ", "٢٠٢٦-١٠-١٢", "２０２６-１０-１２", "0000-01-01", "9999-12-31", "2026-10-12\n2026-10-13"]) {
      const r = parseFiledOn(bad, 2025, T("2026-10-13T15:00:00Z"));
      // surrounding whitespace is trimmed by design; everything else must refuse
      if (bad === "2026-10-12 ") expect(r.ok).toBe(true);
      else expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const ok = parseFiledOn("2026-10-12", 2025, T("2026-10-13T15:00:00Z"));
    expect(ok.ok && ok.value.toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });
  it("private text is refused in the note and in the reason; ordinary text is accepted (no over-blocking of legitimate notes)", () => {
    const bad = ["123-45-6789", "SSN 123456789", "12-3456789", "confirmation 483920", "conf # 1234567", "acct 123456789012", "DOB 1/2/1980", "date of birth: Jan 2", "１２３-４５-６７８９"];
    for (const t of bad) {
      expect(validateCloseNote(t).ok, t).toBe(false);
      expect(validateReopenReason(t).ok, t).toBe(false);
      const r = validateCloseNote(t);
      const digits = t.replace(/\D/g, "").slice(0, 6);
      if (!r.ok && digits.length > 0) expect(r.error).not.toContain(digits);
    }
    const good = ["Federal e-filed via the IRS site, Connecticut by mail", "Form 1040-X to follow for line 25", "Filed Oct 12 2026 ($1,234 refund)", "Added 1099-INT from the estate; amended 8606 line 14"];
    for (const t of good) {
      expect(validateCloseNote(t).ok, t).toBe(true);
      expect(validateReopenReason(t).ok, t).toBe(true);
    }
    expect(validateReopenReason("ab").ok).toBe(false);
    expect(validateReopenReason("   ").ok).toBe(false);
    expect(validateReopenReason("abc").ok).toBe(true);
    expect(validateReopenReason("a".repeat(500)).ok).toBe(true);
    expect(validateReopenReason("a".repeat(501)).ok).toBe(false);
    expect(validateCloseNote("n".repeat(501)).ok).toBe(false);
  });
  it("action-level: a zod-valid but private note leaves the db untouched (no property access)", async () => {
    for (const t of ["123-45-6789", "ssn 123456789"]) expect((await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: t })).ok).toBe(false);
    expect((await reopenTaxYear({ taxYear: 2025, reason: "123-45-6789" })).ok).toBe(false);
    expect(state.accessed).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// B. Display: fail-soft and the owner gate
// ------------------------------------------------------------------------------------------------------------------------------

describe("B. YearStatusNotice and loaders never throw", () => {
  const html = async (year: number) => renderToStaticMarkup(await YearStatusNotice({ year }));
  it("missing table, generic error, no entity: empty markup, no throw", async () => {
    state.closeFindError = p2021();
    expect(await html(2025)).toBe("");
    expect((await loadYearCloseStates()).state).toBe("table_missing");
    state.closeFindError = new Error("x");
    expect(await html(2025)).toBe("");
    expect((await loadYearCloseStates()).state).toBe("error");
    state.closeFindError = null;
    base.entity.findFirst.mockResolvedValue(null);
    expect(await html(2025)).toBe("");
    expect((await loadYearCloseStates()).state).toBe("no_entity");
    base.entity.findFirst.mockRejectedValue(new Error("down"));
    expect(await html(2025)).toBe("");
  });
  it("an open year renders nothing; closed shows 'TY2025 filed <date>'; reopened shows the amber text; only the asked year", async () => {
    expect(await html(2025)).toBe("");
    await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: "web" });
    const closed = await html(2025);
    expect(closed).toContain("TY2025 filed 2026-10-12");
    expect(closed).toContain("print:hidden");
    expect(await html(2026)).toBe("");
    await reopenTaxYear({ taxYear: 2025, reason: "Amend for the estate 1099" });
    const re = await html(2025);
    expect(re).toContain("TY2025 reopened for revision");
    expect(re).not.toContain("TY2025 filed");
    for (const h of [closed, re]) {
      const plain = h.replace(/<[^>]+>/g, " ");
      expect(findCpaWording(plain)).toEqual([]);
      expect(plain).not.toMatch(/accepted|received by|approved|verified|certif|Claude|\bAI\b/i);
      expect(plain).toContain("Tax Forms");
    }
  });
  it("a close-time error from the DB while rendering a non-owner page does not leak error text", async () => {
    state.closeFindError = new Error("password=hunter2 host=db.internal");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await html(2025)).toBe("");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("hunter2");
    spy.mockRestore();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Source-reading pins independent of the Coder's
// ------------------------------------------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", ".claude", "__tests__"].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

describe("source pins", () => {
  const files = ["app", "components", "lib", "actions"].flatMap((d) => walk(resolve(ROOT, d)));
  const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, "/");

  it("reconfirmTaxFact is called only from the carry leaf (and tests); changeTaxFactForCarry only from the carry leaf; closeTaxYear/reopenTaxYear only from the card", () => {
    const callers = (sym: string) => files.filter((f) => new RegExp(`\\b${sym}\\(`).test(readFileSync(f, "utf8")) && !/actions[\\/]/.test(f) ).map(rel);
    expect(callers("reconfirmTaxFact")).toEqual(["components/tax/facts/carry-row-actions.tsx"]);
    expect(callers("changeTaxFactForCarry")).toEqual(["components/tax/facts/carry-row-actions.tsx"]);
    expect(callers("closeTaxYear")).toEqual(["components/tax/year-close-card.tsx"]);
    expect(callers("reopenTaxYear")).toEqual(["components/tax/year-close-card.tsx"]);
  });

  it("no code anywhere (outside tests) writes taxYearCloseEvent other than the one create in the store; none touches it from app/ or components/", () => {
    const hits = files.filter((f) => /taxYearCloseEvent/.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual(["lib/tax-year-close-store.ts"]);
    const store = read("lib/tax-year-close-store.ts");
    expect(store.match(/taxYearCloseEvent\.(\w+)/g)?.sort()).toEqual(["taxYearCloseEvent.create", "taxYearCloseEvent.findMany", "taxYearCloseEvent.findMany"]);
  });

  it("close code never reads or writes TaxWorkspace.status/filedAt or TaxDeadline", () => {
    for (const f of ["lib/tax-year-close-store.ts", "lib/tax-year-close-owner.ts", "actions/tax-year-close.ts", "components/tax/year-close-card.tsx", "components/tax/year-status-notice.tsx", "components/tax/year-state-badge.tsx", ...walk(resolve(ROOT, "lib/tax-year-close")).map(rel)]) {
      expect(read(f), f).not.toMatch(/taxWorkspace|filedAt|taxDeadline|TaxDeadline|TaxWorkspace/);
    }
  });

  it("no bulk affordance anywhere in the carry code (buttons, selection, array params, batch calls)", () => {
    const carry = ["components/tax/facts/carry-row-actions.tsx", "components/tax/facts/carry-forward-review.tsx", "actions/tax-facts-carry.ts", "lib/tax-facts/carry-screen.ts", "app/tax/facts/carry/[year]/page.tsx", "app/tax/facts/carry/page.tsx"];
    for (const f of carry) {
      // comments may discuss the forbidden vocabulary ("no confirm all"); only code is scanned
      const s = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(s, f).not.toMatch(/checkbox|Promise\.all|Promise\.allSettled|\.map\(\s*(async)?[^)]*reconfirmTaxFact|forEach\([^)]*reconfirm|for \(const [^)]*\) *\{[^}]*reconfirmTaxFact|selectAll|confirm ?all|confirm ?selected|Select all|factKeys|keys:\s*string\[\]|string\[\]/i);
    }
    const rowActions = read("components/tax/facts/carry-row-actions.tsx");
    expect((rowActions.match(/reconfirmTaxFact\(/g) ?? []).length).toBe(2);
    expect((rowActions.match(/changeTaxFactForCarry\(/g) ?? []).length).toBe(1);
  });

  it("the open-item branch in the review component renders no CarryRowActions; the fresh-answer modal input starts empty", () => {
    const review = read("components/tax/facts/carry-forward-review.tsx");
    const openBranch = review.slice(review.indexOf("isOpenItem ? ("), review.indexOf(") : ("));
    expect(openBranch).not.toContain("CarryRowActions");
    const leaf = read("components/tax/facts/carry-row-actions.tsx");
    expect(leaf).toContain('const initial = fresh ? "" :');
  });

  it("each page the plan lists renders YearStatusNotice with the page's own year; the sidebar and default filing year are untouched by close code", () => {
    const pages: Array<[string, RegExp]> = [
      ["app/tax/forms/[year]/return/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/forms/[year]/final-review/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/forms/[year]/cpa-summary/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/personal/[year]/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/donations/[year]/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/fixed-assets/[year]/page.tsx", /<YearStatusNotice year=\{year\}/],
      ["app/tax/[workspaceId]/page.tsx", /<YearStatusNotice year=\{workspace\.taxYear\}/],
    ];
    for (const [f, re] of pages) expect(read(f), f).toMatch(re);
    expect(read("app/tax/forms/[year]/page.tsx")).toContain("<YearCloseCard");
    expect(read("app/tax/forms/[year]/page.tsx")).toContain("<YearStateBadge");
    expect(read("app/tax/page.tsx")).toContain("<YearStateBadge");
    for (const f of ["components/app-sidebar.tsx", "lib/tax-default-year.ts", "components/tax/forms/year-notice.tsx"]) expect(read(f), f).not.toMatch(/tax-year-close|YearStatusNotice|TaxYearClose/);
  });

  it("the forms hub passes the card only the view model, never raw events with other users' data beyond names; and `today` is a New York date", () => {
    const hub = read("app/tax/forms/[year]/page.tsx");
    expect(hub).toContain("today={formatFactDate(new Date())}");
    expect(hub).toContain("toYearCloseView(");
  });
});
