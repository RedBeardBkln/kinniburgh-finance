// carry-forward-seasonal-energy, step 2, Round 1 (D6/N1): the seasonal data is loaded ONCE per request. In a React Server
// Components render `cache` memoises per request; here `cache` is replaced by a plain memo so the sharing is observable.
// Outside a render scope (an action, a cron job, any other test) `cache` does not memoise, so those callers read afresh.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
      const memo = new Map<string, R>();
      return (...a: A): R => {
        const k = JSON.stringify(a);
        if (!memo.has(k)) memo.set(k, fn(...a));
        return memo.get(k) as R;
      };
    },
  };
});

const mockDb = vi.hoisted(() => ({
  entity: { findMany: vi.fn() },
  budget: { findMany: vi.fn() },
  tag: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn(), findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  scheduledBill: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { loadSeasonalEnergySafe, loadSeasonalPlansSafe } from "@/lib/seasonal-energy-build";

const budgetRow = {
  id: "row-1",
  entityId: "ent-p",
  tagId: "t-ep",
  accountId: "acct",
  period: "2026-10",
  budgeted: new Decimal("172"),
  additionalAmountCents: new Decimal(0),
  payDay: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  annualAmountDue: null,
  rolloverEnabled: false,
  rolloverAmount: null,
  tag: { id: "t-ep", name: "Utilities / Electric (Eversource)", shortName: "Electric (Eversource)", parentId: null },
  entity: { id: "ent-p", name: "Personal", slug: "personal" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.entity.findMany.mockResolvedValue([{ id: "ent-p", name: "Personal", slug: "personal" }]);
  mockDb.budget.findMany.mockResolvedValue([budgetRow]);
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.appSetting.findMany.mockResolvedValue([]);
  mockDb.tag.findMany.mockResolvedValue([]);
  mockDb.scheduledBill.findMany.mockResolvedValue([]);
  mockDb.transaction.findMany.mockResolvedValue([]);
});

describe("one seasonal load per request (per calendar day)", () => {
  it("the Forecast page header, the Seasonal card, the ledger and the assistant share a single read", async () => {
    const day = new Date("2031-03-04T10:00:00Z");
    const [a, b, c, d] = await Promise.all([
      loadSeasonalPlansSafe({ now: day }),
      loadSeasonalEnergySafe({ now: new Date("2031-03-04T10:00:00Z") }),
      loadSeasonalPlansSafe({ now: new Date("2031-03-04T23:59:00Z") }),
      loadSeasonalEnergySafe({ now: day }),
    ]);
    expect(mockDb.transaction.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.entity.findMany).toHaveBeenCalledTimes(1);
    expect(a.failed).toBe(false);
    expect(b.failed).toBe(false);
    expect(c.plans).toBe(a.plans); // the same object, not a copy
    expect(d).toBe(b);
  });

  it("a different calendar day is a different request scope key", async () => {
    await loadSeasonalEnergySafe({ now: new Date("2031-04-04T10:00:00Z") });
    await loadSeasonalEnergySafe({ now: new Date("2031-04-05T10:00:00Z") });
    expect(mockDb.transaction.findMany).toHaveBeenCalledTimes(2);
  });

  it("a failure is shared too and stays fail-soft: failed true, no plans, only err.name logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDb.entity.findMany.mockRejectedValue(Object.assign(new Error("secret postgres://u:p@h"), { name: "PrismaClientKnownRequestError" }));
    const day = new Date("2031-05-06T10:00:00Z");
    const [a, b] = await Promise.all([loadSeasonalPlansSafe({ now: day }), loadSeasonalEnergySafe({ now: day })]);
    expect(a).toEqual({ plans: [], failed: true });
    expect(b.failed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|postgres/);
    spy.mockRestore();
  });

  it("the module wraps ONLY the Safe path in `cache`; the throwing loader stays a plain function", () => {
    const src = readFileSync(resolve(__dirname, "../..", "lib/seasonal-energy-build.ts"), "utf8");
    expect(src).toMatch(/import \{ cache \} from "react";/);
    expect(src).toMatch(/const loadOncePerRequest = cache\(/);
    expect(src).toMatch(/export async function loadSeasonalEnergy\(opts/);
    expect(src).not.toMatch(/next\/cache|unstable_cache/);
  });
});
