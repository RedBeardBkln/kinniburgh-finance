// carry-forward-seasonal-energy, step 2, Round 1 fixes: D2 (other-entity count), D3 (CLAUDE.md), D5 (price lower bound),
// S2 (no low-confidence estimate in the card-funding notification), S3 (caption on carried figures), S4 (alert wording),
// N2 (basis sentence), N3 (service-like rows are listed to check). The database boundary is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";

const m = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    scheduledTransfer: { findMany: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn() },
  },
  plans: vi.fn(),
  budgetRows: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/gl-code-resolver", () => ({ autoAssignGlCodes: vi.fn() }));
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: vi.fn() }));
vi.mock("@/lib/net-income-build", () => ({ loadNetIncomeSources: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/bill-dates-build", () => ({ loadBudgetScheduleIndex: vi.fn().mockResolvedValue({ index: new Map(), failed: false }) }));
vi.mock("@/lib/seasonal-energy-build", () => ({ loadSeasonalPlansSafe: m.plans, loadSeasonalEnergySafe: vi.fn() }));
vi.mock("@/lib/budget-carry-forward-build", () => ({ loadEffectiveBudgetRows: m.budgetRows }));

import { loadScheduledFlows } from "@/lib/account-scheduled-flows";
import { checkBudgetOverspend, checkBudgetPace } from "@/lib/notifications";
import { budgetAlertNote, ENERGY_SITE_FACTS, oilEstimate, oilFacts, type BillSeasonalPlan, type EnergyPayment } from "@/lib/seasonal-energy";
import { carriedCaption } from "@/lib/budget-carry-forward";
import { normalizePrice, OIL_PRICE_MIN, validateOilPriceInput } from "@/lib/seasonal-energy-prices";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const read = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf8");

function plan(confidence: "low" | "medium" | "high", over: Partial<BillSeasonalPlan> = {}): BillSeasonalPlan {
  return {
    kind: "electric",
    entityId: "ent-p",
    lineKey: "ent-p|t-elec",
    lineLabel: "Electric (Eversource)",
    monthly: Array(12).fill(new Decimal(400)),
    confidence,
    basis: "b",
    shortBasis: "sb",
    replaceDraws: false,
    ...over,
  };
}

// ── S2 ──────────────────────────────────────────────────────────────────────────

describe("S2: a low-confidence estimate never reaches the card-funding notification", () => {
  const bill = {
    id: "b-elec",
    accountId: "acct-main",
    entityId: "ent-p",
    budgetTagId: "t-elec",
    budgetEntityId: "ent-p",
    payee: "Electric (Eversource)",
    amountType: "static",
    expectedAmount: new Decimal("172"),
    autopayDay: 20,
    annualBudget: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    accrualEnvelope: null,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    m.db.scheduledTransfer.findMany.mockResolvedValue([]);
    m.db.scheduledBill.findMany.mockResolvedValue([bill]);
  });
  const flows = async () => (await loadScheduledFlows("acct-main", D("2026-10-10"), D("2026-11-30")))!.map((f) => `${f.date.toISOString().slice(0, 10)} ${f.amount.toFixed(2)}`);

  it("no plan, or only a low-confidence plan: the flat bill amount (what the cron used before)", async () => {
    m.plans.mockResolvedValue({ plans: [], failed: false });
    expect(await flows()).toEqual(["2026-10-20 -172.00", "2026-11-20 -172.00"]);
    m.plans.mockResolvedValue({ plans: [plan("low")], failed: false });
    expect(await flows()).toEqual(["2026-10-20 -172.00", "2026-11-20 -172.00"]);
  });

  it("a medium or high plan re-amounts the bill", async () => {
    for (const c of ["medium", "high"] as const) {
      m.plans.mockResolvedValue({ plans: [plan(c)], failed: false });
      expect(await flows(), c).toEqual(["2026-10-20 -400.00", "2026-11-20 -400.00"]);
    }
  });

  it("the Forecast page and the envelope forecast still pass ALL plans (source pin)", () => {
    expect(read("app/forecast/page.tsx")).toMatch(/planForBill\(seasonalLoad\.plans, b\)/);
    expect(read("actions/envelope.ts")).toMatch(/planForBill\(seasonal\.plans, b\)/);
    expect(read("lib/account-scheduled-flows.ts")).toMatch(/confidence !== "low"/);
  });
});

// ── S3 ──────────────────────────────────────────────────────────────────────────

describe("S3: a caption on carried figures", () => {
  const row = (carriedFrom: string | null, shortName: string, variable = false) => ({ carriedFrom, variable, tag: { shortName } });

  it("null when every row is the month's own", () => {
    expect(carriedCaption([row(null, "Repairs"), row(null, "Insurance")])).toBeNull();
    expect(carriedCaption([])).toBeNull();
  });

  it("names the source period in the existing quiet wording and counts the lines", () => {
    const c = carriedCaption([row("2026-12", "Repairs"), row("2026-12", "Insurance"), row(null, "Taxes")])!;
    expect(c).toBe("Budget figure carried forward from 2026-12 for the months that have no budget row of their own (2 lines).");
  });

  it("names the flat-carried seasonal lines (Sudden Valley Oil and Electricity)", () => {
    const c = carriedCaption([row("2026-12", "Oil", true), row("2026-12", "Electricity", true), row("2026-12", "Repairs"), row("2026-12", "Oil", true)])!;
    expect(c).toMatch(/\(3 lines\)\./);
    expect(c).toMatch(/This includes the seasonal lines Electricity, Oil: their flat figure stands in until a seasonal estimate is available\./);
  });

  it("several source periods are listed", () => {
    expect(carriedCaption([row("2026-09", "Utilities"), row("2026-12", "Repairs")])).toMatch(/carried forward from 2026-09, 2026-12 for/);
  });

  it("the Forecast page shows it for the business buckets from the effective rows (source pin)", () => {
    const src = read("app/forecast/page.tsx");
    expect(src).toMatch(/businessCarriedCaption = carriedCaption\(budgetRows\)/);
    expect(src).toMatch(/isBusinessBucket && businessCarriedCaption/);
    expect(src).toMatch(/data-testid="carried-caption"/);
  });
});

// ── S4 ──────────────────────────────────────────────────────────────────────────

describe("S4: budget alerts say where their figure comes from", () => {
  it("budgetAlertNote: nothing for an own row without an estimate", () => {
    expect(budgetAlertNote(null, null, 11)).toBe("");
    expect(budgetAlertNote(undefined, null, 11)).toBe("");
  });
  it("a carried row says so", () => {
    expect(budgetAlertNote("2026-12", null, 1)).toBe("Based on a budget carried forward from 2026-12.");
  });
  it("a seasonal line with an estimate says the Seasonal card expects a different amount", () => {
    expect(budgetAlertNote(null, plan("low"), 11)).toBe(
      "The Seasonal bills card expects about $400.00 for this month (estimate, low confidence), which is a different amount from the budget figure."
    );
    expect(budgetAlertNote("2026-12", plan("medium"), 1)).toMatch(/^Based on a budget carried forward from 2026-12\. The Seasonal bills card expects about \$400\.00/);
  });
  it("a month with no outflow estimate adds no sentence", () => {
    const monthly = Array(12).fill(new Decimal(400)) as Array<Decimal | null>;
    monthly[10] = null;
    expect(budgetAlertNote(null, plan("low", { monthly }), 11)).toBe("");
  });

  describe("the notifications themselves", () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: "carried:b1:2027-01",
      entityId: "ent-p",
      tagId: "t-elec",
      accountId: "acct",
      period: "2027-01",
      budgeted: new Decimal("172"),
      rolloverAmount: null,
      additionalAmountCents: new Decimal(0),
      tag: { id: "t-elec", name: "Utilities / Electric (Eversource)", shortName: "Electric (Eversource)", parentId: null },
      carriedFrom: "2026-12",
      source: "carried",
      variable: true,
      ...over,
    });
    beforeEach(() => {
      vi.clearAllMocks();
      m.db.notification.findFirst.mockResolvedValue(null);
      m.db.notification.create.mockResolvedValue({ id: "n1" });
      m.db.notification.update.mockResolvedValue({});
      m.db.user.findMany.mockResolvedValue([{ id: "u1", notificationPrefs: null }]);
      m.plans.mockResolvedValue({ plans: [], failed: false });
      m.budgetRows.mockResolvedValue([row()]);
      m.db.$queryRaw.mockResolvedValue([{ tagId: "t-elec", total: "-200" }]);
    });
    const body = () => (m.db.notification.create.mock.calls[0]![0] as { data: { payload: { body: string } } }).data.payload.body;

    it("overspend on a carried row says the budget was carried forward", async () => {
      expect(await checkBudgetOverspend("2027-01")).toBe(1);
      expect(body()).toMatch(/Electric \(Eversource\) is at \$200 of \$172 \(116%\)/);
      expect(body()).toMatch(/Based on a budget carried forward from 2026-12\.$/);
    });

    it("overspend on a seasonal line with an estimate also says the Seasonal card expects another amount", async () => {
      m.plans.mockResolvedValue({ plans: [plan("low")], failed: false });
      await checkBudgetOverspend("2027-01");
      expect(body()).toMatch(/Based on a budget carried forward from 2026-12\. The Seasonal bills card expects about \$400\.00 for this month \(estimate, low confidence\)/);
    });

    it("an own (not carried) row without an estimate keeps the old wording exactly", async () => {
      m.budgetRows.mockResolvedValue([row({ carriedFrom: null, source: "own", id: "b1" })]);
      await checkBudgetOverspend("2027-01");
      expect(body()).toMatch(/\(116%\)(?: — \d+ days left this month)?\.$/);
      expect(body()).not.toMatch(/carried|Seasonal/);
    });

    it("an unreadable seasonal load (fail-soft, no plans) leaves the carried wording only", async () => {
      m.plans.mockResolvedValue({ plans: [], failed: true });
      await checkBudgetOverspend("2027-01");
      expect(body()).toMatch(/carried forward from 2026-12\.$/);
      expect(body()).not.toMatch(/Seasonal/);
    });

    it("the pace alert source appends the same note", () => {
      const src = read("lib/notifications.ts");
      expect(src).toMatch(/budgetAlertNote\(budget\.carriedFrom, planForLine\(seasonal\.plans, budget\.entityId, budget\.tagId\), month\)/g);
      expect((src.match(/budgetAlertNote\(/g) ?? []).length).toBe(2);
      expect(src).toMatch(/\(paceNote \? `/);
      expect(typeof checkBudgetPace).toBe("function");
    });
  });
});

// ── D5 ──────────────────────────────────────────────────────────────────────────

describe("D5: the oil price has a lower bound as well", () => {
  it("the bound is $1.00 a gallon", () => {
    expect(OIL_PRICE_MIN).toBe(1);
    expect(normalizePrice("1.00")).toEqual({ ok: true, value: "1.00" });
    expect(normalizePrice("1")).toEqual({ ok: true, value: "1.00" });
    expect(normalizePrice("0.9999")).toMatchObject({ ok: false });
    expect(normalizePrice("0.50")).toMatchObject({ ok: false });
  });
  it("0.35 (for 3.50) gets a clear typo message; zero keeps its own message", () => {
    const r = normalizePrice("0.35");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/under \$1\.00 a gallon is probably a typing slip \(for example 0\.35 for 3\.50\)/);
    }
    const z = normalizePrice("0");
    expect(z.ok === false && z.error).toMatch(/greater than zero/);
  });
  it("validateOilPriceInput passes the message through, and the upper bound is unchanged", () => {
    const today = D("2026-10-10");
    const low = validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "0.35" }, today);
    expect(low.ok === false && low.error).toMatch(/typing slip/);
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "20" }, today).ok).toBe(true);
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "20.01" }, today).ok).toBe(false);
  });
});

// ── D2, N2, N3 ──────────────────────────────────────────────────────────────────

const PERSONAL = ENERGY_SITE_FACTS["personal"]!;
const SV = ENERGY_SITE_FACTS["sudden-valley"]!;
const pay = (id: string, date: string, outflow: string, over: Partial<EnergyPayment> = {}): EnergyPayment => ({
  id,
  date: D(date),
  amount: new Decimal(outflow).negated(),
  payee: "mccarthy heating oil",
  account: "Acct",
  fromOtherEntity: null,
  tagPaths: ["Utilities / Oil"],
  ...over,
});

describe("D2: the other-entity count covers only the payments in the oil history", () => {
  const EKC = "Eric Kinniburgh Consulting, LLC";
  const rows = [
    pay("svc", "2025-12-20", "292.46", { fromOtherEntity: EKC }),
    pay("a", "2026-01-12", "679.65", { fromOtherEntity: EKC }),
    pay("marked", "2026-02-12", "300", { fromOtherEntity: EKC }),
    pay("b", "2026-05-12", "700"),
    pay("c", "2026-07-12", "720"),
  ];
  const entries = [{ id: "1", effectiveOn: "2025-10-01", pricePerGal: "3.00" }, { id: "2", effectiveOn: "2026-09-01", pricePerGal: "3.50" }];
  it("the service charge and a marked row are not counted, but every EK row read is reported separately", () => {
    const f = oilFacts(rows, D("2026-10-10"), PERSONAL, { excludedIds: new Set(["marked"]), oilTagName: "Utilities / Oil" });
    expect(f.otherEntityCount).toBe(1);
    expect(f.otherEntityRows).toBe(3);
    const e = oilEstimate({ payments: rows, entries, now: D("2026-10-10"), site: PERSONAL, excludedIds: new Set(["marked"]), oilTagName: "Utilities / Oil" });
    if (e.status !== "estimate") throw new Error("expected an estimate");
    expect(e.basis).toMatch(/\b1 of the payments sit on another entity's books/);
  });
});

describe("N2: the basis says prices between entries are assumed unchanged", () => {
  it("is in the oil basis", () => {
    const entries = [{ id: "1", effectiveOn: "2025-10-01", pricePerGal: "3.00" }, { id: "2", effectiveOn: "2026-09-01", pricePerGal: "3.50" }];
    const e = oilEstimate({ payments: [pay("a", "2026-05-12", "700")], entries, now: D("2026-10-10"), site: PERSONAL });
    if (e.status !== "estimate") throw new Error("expected an estimate");
    expect(e.basis).toMatch(/Prices between your entries are assumed unchanged until the next entry, so two entries a long way apart are not a measured trend\./);
  });
});

describe("N3: a service-like row is listed under 'Check these McCarthy charges' (the service rule itself is an exact-cents match)", () => {
  const delivery = (id: string, date: string, amt: string) => pay(id, date, amt);
  const base = [delivery("d1", "2026-01-05", "820"), delivery("d2", "2026-02-05", "790"), delivery("d3", "2026-03-05", "810")];

  it("exactly the confirmed amount is service (left out, not listed); a nearby amount is listed, not silently counted as oil", () => {
    const f = oilFacts([...base, pay("exact", "2026-04-05", "292.46"), pay("near", "2026-05-05", "310.00"), pay("nearlow", "2026-06-05", "240.00")], D("2026-10-10"), PERSONAL, { oilTagName: "Utilities / Oil" });
    expect(f.service?.dates).toEqual(["2026-04-05"]);
    expect(f.counted.map((p) => p.id)).toContain("near");
    expect(f.check.map((p) => p.id).sort()).toEqual(["near", "nearlow"]);
    expect(f.check.find((p) => p.id === "near")!.checkWhy.join(" ")).toMatch(/close to the yearly furnace service amount \(\$292\.46\); it may be the next yearly furnace service, not oil/);
  });

  it("the boundary is 20% of the known amount, and a delivery-sized row is untouched", () => {
    const at = (amt: string) => oilFacts([...base, pay("x", "2026-05-05", amt)], D("2026-10-10"), PERSONAL, { oilTagName: "Utilities / Oil" }).check.map((p) => p.id);
    expect(at("350.95")).toEqual(["x"]); // 292.46 x 1.2 = 350.952
    expect(at("350.96")).toEqual([]);
    expect(at("233.97")).toEqual(["x"]); // 292.46 x 0.8 = 233.968
    expect(at("233.96")).toEqual([]);
    expect(at("800")).toEqual([]);
  });

  it("Sudden Valley has no confirmed service amount, so no row is judged service-like there", () => {
    const f = oilFacts([...base, pay("x", "2026-05-05", "292.46"), pay("y", "2026-06-05", "300")], D("2026-10-10"), SV, { oilTagName: "Arbor Retreat / Oil" });
    expect(f.service).toBeNull();
    expect(f.check.every((p) => p.checkWhy.every((w) => !/furnace/.test(w)))).toBe(true);
  });
});

// ── D3 ──────────────────────────────────────────────────────────────────────────

describe("D3: CLAUDE.md describes what the seasonal work does and does not change", () => {
  const claude = read("CLAUDE.md");
  it("the dashboard widget is stated to show the estimate; only the dashboard budget screens are unchanged", () => {
    expect(claude).toMatch(/the dashboard budget screens \(the dashboard 'Next 30 days' widget reads the Upcoming ledger and therefore DOES show the Electric estimate\)/);
    expect(claude).not.toMatch(/\/budgets, the dashboard\./);
  });
  it("mentions the durable marks, the once-per-request load, the notification rule and the alert wording", () => {
    expect(claude).toMatch(/durable signature/);
    expect(claude).toMatch(/loaded once per server request/);
    expect(claude).toMatch(/a low-confidence estimate never triggers a notification/);
    expect(claude).toMatch(/overspend \/ pace notifications say when their figure is a budget carried forward/);
  });
  it("is still ASCII-only in the paragraph and keeps CRLF (the file is CRLF throughout)", () => {
    const i = claude.indexOf("**Seasonal bills**");
    const j = claude.indexOf("**Testing pattern**");
    const para = claude.slice(i, j);
    expect(para.length).toBeGreaterThan(1000);
    expect(/^[\x00-\x7f]*$/.test(para)).toBe(true);
    expect(claude.split("\n").every((l, idx, a) => idx === a.length - 1 || l.endsWith("\r"))).toBe(true);
  });
});
