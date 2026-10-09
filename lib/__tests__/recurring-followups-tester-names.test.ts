import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { detectRecurring, type TxRow } from "@/lib/recurring-detect";
import type { ModelledRef } from "@/lib/upcoming-ledger";

// Tester: gaps the mutation runner found in the account-qualified naming rules (each test kills a surviving mutant), plus
// the negative controls for genuine duplicate detection.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const TODAY = d("2026-10-08");
const E = "ent-1";

function months(day: number, n: number, last = "2026-09"): string[] {
  const [y, m] = last.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - i, day)).toISOString().slice(0, 10)).reverse();
}
function rows(payee: string, amount: number, day: number, accountId: string, accountName: string, last = "2026-09", n = 6): TxRow[] {
  return months(day, n, last).map((date) => ({ entityId: E, accountId, accountType: "checking", accountName, payee, amount: new Decimal(-amount), postedAt: d(date), tagIds: [] }));
}
function rec(label: string, over: Partial<ModelledRef> = {}): ModelledRef {
  return {
    source: "recurring_expense", sourceId: "r1", entityId: E, accountId: null, label, direction: "outflow", tagKey: null,
    monthly: new Decimal(15), day: 3, cadence: "monthly", expectedAmount: new Decimal(15), ...over,
  };
}
const offered = (r: TxRow[], m: ModelledRef[] = []) => detectRecurring({ rows: r, modelled: m, today: TODAY }).suggestions.map((s) => s.payee).sort();

describe("account qualifier is not payee text", () => {
  const history = [
    ...rows("maintenance fee", 15, 3, "a-card", "Credit Cards"),
    ...rows("maintenance fee", 15, 5, "a-slush", "Slush Funds"),
    ...rows("credit karma", 9.99, 19, "a-chk", "Primary Checking"),
  ];
  it("baseline: three series, the fee suffixed on both accounts, Credit Karma plain", () => {
    expect(offered(history)).toEqual(["Credit Karma", "Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
  });
  it("a hand-typed 'Maintenance Fee (Credit Cards)' hides that account's fee only; the words 'credit'/'cards' never hide Credit Karma", () => {
    expect(offered(history, [rec("Maintenance Fee (Credit Cards)")])).toEqual(["Credit Karma", "Maintenance Fee (Slush Funds)"]);
  });
  it("an account NICKNAME that happens to be a payee word never hides that payee (nickname 'Netflix Fund')", () => {
    const h = [
      ...rows("maintenance fee", 15, 3, "a-nf", "Netflix Fund"),
      ...rows("maintenance fee", 15, 5, "a-slush", "Slush Funds"),
      ...rows("netflix", 21.26, 19, "a-nf", "Netflix Fund"), // same account as the fee: only the stripped qualifier keeps them apart
    ];
    expect(offered(h)).toEqual(["Maintenance Fee (Netflix Fund)", "Maintenance Fee (Slush Funds)", "Netflix"]);
    expect(offered(h, [rec("Maintenance Fee (Netflix Fund)")])).toEqual(["Maintenance Fee (Slush Funds)", "Netflix"]);
  });
  it("a single-series payee is not hidden by a record qualified for ANOTHER known account", () => {
    // only the Slush Funds fee exists as a series; the Credit Cards account is known from its other rows
    const h = [...rows("maintenance fee", 15, 5, "a-slush", "Slush Funds"), ...rows("some other thing", 77, 11, "a-card", "Credit Cards")];
    expect(offered(h)).toContain("Maintenance Fee");
    expect(offered(h, [rec("Maintenance Fee (Credit Cards)")])).toContain("Maintenance Fee");
    // while a record qualified for ITS OWN account does hide it (genuine duplicate)
    expect(offered(h, [rec("Maintenance Fee (Slush Funds)")])).not.toContain("Maintenance Fee");
    // and an unqualified record still does
    expect(offered(h, [rec("Maintenance Fee")])).not.toContain("Maintenance Fee");
  });
});

describe("a trailing '(...)' that is NOT an account keeps the old behaviour (late flag uses all rows)", () => {
  it("Amica - Home insurance (Arbor Retreat) is still matched against its history on any account", () => {
    const h = rows("amica home insurance", 167.9, 5, "a-chk", "Primary Checking", "2026-09", 6);
    const late = (label: string, rowsIn: TxRow[]) =>
      detectRecurring({
        rows: rowsIn,
        modelled: [rec(label, { monthly: new Decimal("167.9"), expectedAmount: new Decimal("167.9"), day: 5 })],
        today: d("2026-10-12"),
      }).flags.some((f) => f.type === "late" && f.modelled !== null && f.text.includes("Amica"));
    expect(late("Amica - Home insurance", h)).toBe(true); // control: the plain name is flagged
    expect(late("Amica - Home insurance (Arbor Retreat)", h)).toBe(true);
  });
  it("whereas a record naming a DIFFERENT known account does not read that account's history", () => {
    const h = [...rows("amica home insurance", 167.9, 5, "a-chk", "Primary Checking", "2026-09", 6), ...rows("other", 40, 9, "a-slush", "Slush Funds")];
    const late = (label: string) =>
      detectRecurring({
        rows: h,
        modelled: [rec(label, { monthly: new Decimal("167.9"), expectedAmount: new Decimal("167.9"), day: 5 })],
        today: d("2026-10-12"),
      }).flags.some((f) => f.type === "late" && f.modelled !== null && f.text.includes("Amica"));
    expect(late("Amica - Home insurance")).toBe(true);
    expect(late("Amica - Home insurance (Slush Funds)")).toBe(false);
    expect(late("Amica - Home insurance (Primary Checking)")).toBe(true);
  });
});

describe("genuine duplicates stay detected (negative controls)", () => {
  it("Amica vs Progressive and Toyota vs Lexus records do not hide each other's series", () => {
    const h = [
      ...rows("amica auto insurance", 120, 5, "a-chk", "Primary Checking"),
      ...rows("progressive motorcycle", 11, 26, "a-chk", "Primary Checking"),
      ...rows("toyota", 420, 28, "a-car", "Car"),
      ...rows("lexus financial", 250, 3, "a-car", "Car"),
    ];
    expect(offered(h)).toEqual(["Amica Auto Insurance", "Lexus Financial", "Progressive Motorcycle", "Toyota"]);
    expect(offered(h, [rec("Amica - Auto insurance", { day: 5, monthly: new Decimal(120), expectedAmount: new Decimal(120) })])).toEqual(["Lexus Financial", "Progressive Motorcycle", "Toyota"]);
    expect(offered(h, [rec("Lexus Financial", { day: 3, monthly: new Decimal(250), expectedAmount: new Decimal(250) })])).toEqual(["Amica Auto Insurance", "Progressive Motorcycle", "Toyota"]);
  });
  it("the three historical pairs: 'Electric (Eversource)' / 'Regions/EnerBank - Solar loan' / 'PennyMac - Mortgage' still hide their detected twin", () => {
    const h = [
      ...rows("eversource", 184, 20, "a-chk", "Primary Checking"),
      ...rows("enerbank usa", 506, 20, "a-chk", "Primary Checking"),
      ...rows("pennymac", 4700, 1, "a-chk", "Primary Checking"),
    ];
    const all = offered(h);
    expect(all).toHaveLength(3);
    const m = [
      rec("Electric (Eversource)", { sourceId: "b1", day: 20, monthly: new Decimal(172), expectedAmount: new Decimal(172) }),
      rec("Regions/EnerBank - Solar loan", { sourceId: "b2", day: 20, monthly: new Decimal(506), expectedAmount: new Decimal(506) }),
      rec("PennyMac - Mortgage", { sourceId: "b3", day: 1, monthly: new Decimal(4700), expectedAmount: new Decimal(4700) }),
    ];
    expect(offered(h, m)).toEqual([]);
  });
});
