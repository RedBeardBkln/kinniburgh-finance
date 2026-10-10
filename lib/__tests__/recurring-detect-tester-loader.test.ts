// TESTER-authored: fail-soft behaviour of lib/upcoming-ledger-build.ts with the recurring-pattern add-on
// (pipeline task: recurring-detection). Everything below the loader is mocked at its boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type { DetectionData } from "@/lib/recurring-detect-build";

const inputMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const cardsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upcoming-ledger-input", () => ({ loadUpcomingLedgerInput: inputMock }));
// loadUpcomingLedger also reads the card projections (read-only DB reads): mocked here so no test touches a real database.
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: cardsMock }));
// ... and the seasonal-estimate plans (also a read-only DB load, step 2): handed in as data, none here.
const seasonalMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/seasonal-energy-build", () => ({ loadSeasonalPlansSafe: seasonalMock }));
vi.mock("@/lib/recurring-detect-build", async (orig) => {
  const real = await orig<typeof import("@/lib/recurring-detect-build")>();
  return { ...real, fetchDetectionData: fetchMock };
});

import { loadUpcomingLedger } from "@/lib/upcoming-ledger-build";

const NOW = new Date("2026-10-08T15:00:00Z");
const FROM = new Date("2026-10-08T00:00:00Z");
const TO = new Date("2026-11-07T00:00:00Z");
const ENT = "ent-1";

function ledgerInput() {
  return {
    input: { from: FROM, days: 30, entityId: ENT, bills: [] as never[] },
    from: FROM,
    to: TO,
    entityNameById: { [ENT]: "Personal" },
    entitySlugById: { [ENT]: "personal" },
    accountNameById: {},
  };
}
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
function history(): DetectionData {
  const dates = ["2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"];
  return {
    rows: dates.map((d) => ({ entityId: ENT, accountId: "a1", accountType: "checking", payee: "zzyzx widgets", amount: new Decimal(-40), postedAt: D(d), tagIds: [] })),
    dismissed: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inputMock.mockResolvedValue(ledgerInput());
  cardsMock.mockResolvedValue({ today: FROM, projections: [], error: false });
  seasonalMock.mockResolvedValue({ plans: [], failed: false });
  fetchMock.mockResolvedValue(history());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("loadUpcomingLedger with the recurring-pattern add-on", () => {
  it("happy path: detection present and the learned row lands only in ledger.learned", async () => {
    const r = await loadUpcomingLedger({ entityId: ENT, days: 30, now: NOW });
    expect(r.detection).not.toBeNull();
    expect(r.detection?.suggestions.map((s) => s.payee)).toEqual(["Zzyzx Widgets"]);
    expect(r.ledger.learned.map((i) => i.label)).toEqual(["Zzyzx Widgets"]);
    expect(r.ledger.items).toEqual([]);
    expect(r.ledger.totals.outflow.toFixed(2)).toBe("0.00");
    expect(r.ledger.learned[0]?.date?.toISOString().slice(0, 10)).toBe("2026-10-10");
  });

  it("the detection read rejecting leaves the ledger complete and detection null (one logged error name only)", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("secret connection string postgres://user:pw@host"), { name: "PrismaClientKnownRequestError" }));
    const r = await loadUpcomingLedger({ entityId: ENT, days: 30, now: NOW });
    expect(r.detection).toBeNull();
    expect(r.ledger.learned).toEqual([]);
    expect(r.ledger.learnedTotals.count).toBe(0);
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).toContain("PrismaClientKnownRequestError");
    expect(logged).not.toContain("postgres://");
    expect(logged).not.toContain("secret");
  });

  it("garbage detection rows (a throw inside the pure detector) also fail soft", async () => {
    fetchMock.mockResolvedValue({ rows: [{ entityId: ENT, accountId: "a", accountType: "checking", payee: "x y z w", amount: null, postedAt: null, tagIds: null }], dismissed: [] });
    const r = await loadUpcomingLedger({ entityId: ENT, days: 30, now: NOW });
    expect(r.detection).toBeNull();
    expect(r.ledger.items).toEqual([]);
  });

  it("a ledger read failing rejects the load (the page catches it) and does not leave an unhandled detection rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    inputMock.mockRejectedValue(new Error("ledger down"));
    fetchMock.mockRejectedValue(new Error("detection down too"));
    await expect(loadUpcomingLedger({ entityId: ENT, days: 30, now: NOW })).rejects.toThrow("ledger down");
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("no history at all: detection is empty (not null) and the ledger is unchanged", async () => {
    fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
    const r = await loadUpcomingLedger({ entityId: ENT, days: 30, now: NOW });
    expect(r.detection).not.toBeNull();
    expect(r.detection?.suggestions).toEqual([]);
    expect(r.ledger.learned).toEqual([]);
  });

  it("the detector is handed the NY date as today, not the raw timestamp", async () => {
    await loadUpcomingLedger({ entityId: ENT, days: 30, now: new Date("2026-10-09T02:30:00Z") }); // 22:30 on Oct 8 in New York
    expect(fetchMock.mock.calls[0]?.[0].today.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });
});
