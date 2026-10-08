import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma } from "@prisma/client";

// TESTER: render the REAL carry pages and the facts page (server components) with the auth / db boundary faked, as the owner would
// see them. Nothing here touches a database.
(globalThis as unknown as { React: typeof React }).React = React;

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOTFOUND");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children) }));

const st = vi.hoisted(() => ({ facts: [] as unknown[], events: [] as unknown[], factsError: null as unknown, closeError: null as unknown }));
const mockDb = vi.hoisted(() => ({
  entity: { findFirst: vi.fn() },
  taxFact: { findMany: vi.fn() },
  taxYearCloseEvent: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import TaxFactsCarryPage from "@/app/tax/facts/carry/[year]/page";
import TaxFactsCarryIndexPage from "@/app/tax/facts/carry/page";
import TaxFactsPage from "@/app/tax/facts/page";

const PERSONAL = "22222222-2222-4222-8222-222222222222";

function fact(o: Record<string, unknown>): void {
  st.facts.push({
    id: `f${st.facts.length}`, entityId: PERSONAL, factKey: "household.filing_status", version: 1, category: "household", label: "Filing status",
    taxYear: 2025, valueKind: "choice", valueCents: null, valueText: "mfj", carryPolicy: "reconfirm", changeKind: "established",
    sourceKind: "owner_statement", sourceRef: null, reason: null, confirmedAt: new Date("2026-10-07T15:00:00Z"), setByName: "Eric",
    setAt: new Date("2026-10-07T15:00:00Z"), archivedAt: null, ...o,
  });
}
function closeEv(year: number, seq: number, kind: string): void {
  st.events.push({ id: `e${st.events.length}`, entityId: PERSONAL, taxYear: year, seq, kind, filedOn: kind === "closed" ? new Date("2027-01-12T12:00:00Z") : null, note: null, byId: null, byName: "Eric", at: new Date("2027-01-12T15:00:00Z"), createdAt: new Date() });
}
const p2021 = () => new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "t" });
const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T15:00:00Z"));
  vi.clearAllMocks();
  st.facts = [];
  st.events = [];
  st.factsError = null;
  st.closeError = null;
  authMock.mockResolvedValue({ user: { id: "u1", name: "Eric" } });
  mockDb.entity.findFirst.mockResolvedValue({ id: PERSONAL });
  mockDb.taxFact.findMany.mockImplementation(async () => {
    if (st.factsError) throw st.factsError;
    return st.facts;
  });
  mockDb.taxYearCloseEvent.findMany.mockImplementation(async () => {
    if (st.closeError) throw st.closeError;
    return st.events;
  });
});
afterEach(() => vi.useRealTimers());

const render = async (year: string) => text(await TaxFactsCarryPage({ params: Promise.resolve({ year }) }));

describe("carry page", () => {
  it("unauthenticated -> redirect to /login before any read", async () => {
    authMock.mockResolvedValue(null);
    await expect(TaxFactsCarryPage({ params: Promise.resolve({ year: "2026" }) })).rejects.toThrow("REDIRECT:/login");
    await expect(TaxFactsCarryIndexPage()).rejects.toThrow("REDIRECT:/login");
    await expect(TaxFactsPage()).rejects.toThrow("REDIRECT:/login");
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
    expect(mockDb.taxFact.findMany).not.toHaveBeenCalled();
    expect(mockDb.taxYearCloseEvent.findMany).not.toHaveBeenCalled();
  });

  it("non-year segments are 404 and read nothing", async () => {
    for (const y of ["abc", "2026x", "20266", "026", "", "-2026", "2026.5", "%32026", " 2026"]) {
      await expect(TaxFactsCarryPage({ params: Promise.resolve({ year: y }) }), JSON.stringify(y)).rejects.toThrow("NOTFOUND");
    }
    expect(mockDb.taxFact.findMany).not.toHaveBeenCalled();
  });

  it("TY2025, TY2024, TY2000 and TY2099 render a refusal message and NEVER load the facts", async () => {
    fact({});
    for (const y of ["2025", "2024", "2000", "2099"]) {
      const t = await render(y);
      expect(t, y).toMatch(y === "2099" ? /too far ahead/ : /TY2025 and earlier are the returns being filed or already filed/);
      expect(t).not.toContain("Needs re-confirmation");
      expect(t).not.toMatch(/Still true|It changed|Answer for/);
    }
    expect(mockDb.taxFact.findMany).not.toHaveBeenCalled();
  });

  it("TY2026 with facts: five sections, chips 2026 and 2027, decision rows keep the note, no bulk control", async () => {
    fact({});
    fact({ factKey: "decision.x7.federal_overpayment", category: "decision", label: "Decision X7", valueText: "refund" });
    fact({ factKey: "mileage.business", category: "business", label: "Business miles", carryPolicy: "year_specific", valueKind: "money_cents", valueCents: 123400, valueText: null });
    fact({ factKey: "open.q1", category: "open_item", valueKind: "open_item", label: "Open Q", valueText: "Why?" });
    const t = await render("2026");
    for (const s of ["Needs re-confirmation (2)", "Ask fresh (1)", "Open items (1)", "Carried (stable) (0)", "Already confirmed for TY2026 (0)"]) expect(t).toContain(s);
    expect(t).toContain("TY2026");
    expect(t).toContain("TY2027");
    expect(t).not.toContain("TY2028");
    expect(t).toContain("Recorded copy for recall; the return uses the decision recorded on the Tax Forms page.");
    expect(t).not.toMatch(/confirm all|select all|Confirm selected/i);
    expect(t).toContain("Reference only:");
    expect(t).toContain("Question, not a fact");
  });

  it("TY2028 (more than next calendar year) is refused", async () => {
    fact({});
    expect(await render("2028")).toContain("too far ahead");
  });

  it("closed TY2026: the strip shows it, TY2026 is refused naming the Tax Forms page, TY2027 is offered", async () => {
    fact({});
    closeEv(2026, 1, "closed");
    const t26 = await render("2026");
    expect(t26).toContain("TY2026 filed 2027-01-12");
    expect(t26).toContain("is marked filed");
    expect(t26).toContain("Tax Forms page");
    expect(t26).not.toContain("Needs re-confirmation");
    const t27 = await render("2027");
    expect(t27).toContain("Needs re-confirmation (1)");
    expect(t27).not.toMatch(/Carry into: TY2026/);
  });

  it("reopened TY2026 no longer blocks and shows the amber strip", async () => {
    fact({});
    closeEv(2026, 1, "closed");
    closeEv(2026, 2, "reopened");
    const t = await render("2026");
    expect(t).toContain("TY2026 reopened for revision");
    expect(t).toContain("Needs re-confirmation (1)");
  });

  it("table missing for the close events: page works as if nothing is closed (display fail-soft)", async () => {
    fact({});
    st.closeError = p2021();
    expect(await render("2026")).toContain("Needs re-confirmation (1)");
  });

  it("an unreadable close state shows the 'saving will refuse' note but still renders the facts", async () => {
    fact({});
    st.closeError = new Error("x");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await render("2026");
    spy.mockRestore();
    expect(t).toContain("could not be checked just now");
    expect(t).toContain("Needs re-confirmation (1)");
  });

  it("facts table missing -> the migration message, not a crash; no rows -> points at the facts page, seeds nothing", async () => {
    st.factsError = p2021();
    expect(await render("2026")).toContain("migration has not been applied");
    st.factsError = null;
    const t = await render("2026");
    expect(t).toContain("No facts are recorded yet");
    expect(mockDb.taxFact.findMany).toHaveBeenCalled();
  });
});

describe("carry index and facts page", () => {
  it("index redirects to the first offered year: 2026, or the year after the latest closed year", async () => {
    await expect(TaxFactsCarryIndexPage()).rejects.toThrow("REDIRECT:/tax/facts/carry/2026");
    closeEv(2026, 1, "closed");
    await expect(TaxFactsCarryIndexPage()).rejects.toThrow("REDIRECT:/tax/facts/carry/2027");
    st.closeError = p2021();
    await expect(TaxFactsCarryIndexPage()).rejects.toThrow("REDIRECT:/tax/facts/carry/2026");
  });

  it("the facts page: new h1, no 'not built', link card only when facts exist, strip when a year is closed", async () => {
    const empty = text(await TaxFactsPage());
    expect(empty).toContain("Owner-confirmed facts");
    expect(empty).not.toContain("Facts carried forward");
    expect(empty).not.toMatch(/not built/i);
    expect(empty).not.toContain("carry-forward review");
    fact({});
    closeEv(2025, 1, "closed");
    const t = text(await TaxFactsPage());
    expect(t).toContain("Start the TY2026 carry-forward review");
    expect(t).toContain("TY2025 filed 2027-01-12");
    expect(t).toContain("Nothing re-confirms a fact for you");
    expect(t).not.toMatch(/feeds the return|used by the return/i);
    // a closed 2026 moves the link
    closeEv(2026, 1, "closed");
    expect(text(await TaxFactsPage())).toContain("Start the TY2027 carry-forward review");
  });

  it("the facts page survives a missing close table and a close-read error", async () => {
    fact({});
    st.closeError = p2021();
    expect(text(await TaxFactsPage())).toContain("Start the TY2026 carry-forward review");
    st.closeError = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(text(await TaxFactsPage())).toContain("Start the TY2026 carry-forward review");
    spy.mockRestore();
  });
});
