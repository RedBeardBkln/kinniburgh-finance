import { describe, expect, it } from "vitest";
import { buildMonthSpend, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData, describeDayRules, type DrillBuildInput } from "@/lib/dashboard-drill-build";
import {
  budgetedSubline,
  buildDrillView,
  centsText,
  formatDay,
  sumCountedRows,
  sumRowCents,
  type DrillData,
  type DrillTarget,
} from "@/lib/dashboard-drill";
import { D, TAGS, out, randomWorld, resetSeq, septemberLines, septemberTxs, tx } from "./month-spend-fixtures";

const shortOf = (name: string) => name.split(" / ").pop()!;

/** The payload the dashboard page builds, from a set of transactions, tags and line inputs. */
function payload(txs: SpendTx[], tags: SpendTag[], lines: SpendLineInput[], extra: Partial<DrillBuildInput> = {}): DrillData {
  const tagParent = new Map(tags.map((t) => [t.id, t.parentId]));
  // The page derives resolved/explicit amounts from the stored amounts: do the same so the fixtures stay consistent.
  const effective = resolveEffectiveBudgets(
    lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, budgeted: l.explicit })),
    [],
    (id) => tagParent.get(id)
  );
  const withAmounts = lines.map((l) => ({ ...l, resolved: effective.resolvedById.get(l.id) ?? D(0), explicit: effective.explicitById.get(l.id) ?? null }));
  const model = buildMonthSpend(txs, tags, withAmounts);
  return buildDrillData({
    model,
    txs,
    tags: tags.map((t) => ({ ...t, shortName: shortOf(t.name) })),
    budgets: lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, accountName: "Account " + l.accountId, rawBudgeted: l.explicit, rollover: l.rollover })),
    effective,
    accounts: [
      { id: "acc-checking", nickname: "Checking", institutionName: "Test Bank", accountType: "checking", currentBalance: D("1000.50"), currentBalanceAt: new Date("2026-10-09T08:00:00Z") },
      { id: "acc-card", nickname: "Card", institutionName: "Card Bank", accountType: "credit_card", currentBalance: D("250"), currentBalanceAt: null },
      { id: "acc-loan", nickname: "Mortgage loan", institutionName: "Lender", accountType: "mortgage", currentBalance: null, currentBalanceAt: null },
    ],
    transfers: [
      { id: "st1", fromNickname: "Checking", toNickname: "Savings", amount: D("200"), cadence: "semi_monthly", dayRules: { daysOfMonth: [1, 15] }, purpose: "Savings" },
    ],
    period: "2026-09",
    periodLabel: "September 2026",
    bucket: "personal",
    isAllEntities: false,
    periodQuery: "&period=2026-09",
    ...extra,
  });
}

const septData = () => {
  resetSeq(0);
  return payload(septemberTxs(), TAGS, septemberLines());
};

describe("drill-down payload: September 2026", () => {
  const data = septData();

  it("headline figures match the model", () => {
    expect(data.spentCents).toBe(1716222);
    expect(data.refundsCents).toBe(93617);
    expect(data.incomeCents).toBe(1734923);
    expect(data.totalBudgetedCents).toBe(590000); // top-level lines: Food 700 + Mortgage 4700 + Repairs 200 + Credit cards 300
    expect(data.overspentCount).toBe(data.lines.filter((l) => l.countsAsOverspent).length);
  });

  it("Spent view: the counted rows add up to the headline, and the footer says so", () => {
    const v = buildDrillView(data, { kind: "spent" });
    expect(v.headline.cents).toBe(1716222);
    expect(v.expected).toEqual({ cents: 1716222, unit: "money" });
    expect(sumCountedRows(v)).toBe(1716222);
  });

  it("Spent view lists every excluded class with its count and bank sum, and never counts them", () => {
    const v = buildDrillView(data, { kind: "spent" });
    const byTitle = Object.fromEntries(v.excludedSections.map((s) => [s.title, s]));
    expect(Object.keys(byTitle).sort()).toEqual(["Credit card payments", "Income", "Mortgage and loan account entries", "Transfers between your own accounts"]);
    expect(byTitle["Transfers between your own accounts"]!.subtotalCents).toBe(31000);
    expect(byTitle["Credit card payments"]!.subtotalCents).toBe(-16793);
    expect(byTitle["Mortgage and loan account entries"]!.subtotalCents).toBe(423386);
    expect(byTitle["Income"]!.subtotalCents).toBe(1734923);
    for (const s of v.excludedSections) {
      expect(s.rows.every((r) => !r.counts)).toBe(true);
      expect(s.rows.reduce((t, r) => t + r.cents, 0)).toBe(s.subtotalCents);
      expect(s.subtitle).toMatch(/\d+ (entry|entries)\./);
    }
  });

  it("Spent view shows untagged and not-in-any-line spending as explicit rows", () => {
    const v = buildDrillView(data, { kind: "spent" });
    const untagged = v.sections.find((s) => s.key === "untagged")!;
    expect(untagged.rows).toHaveLength(4);
    expect(untagged.subtotalCents).toBe(8812);
    expect(v.sections.find((s) => s.heading === "Not in any budget line")).toBeTruthy();
    expect(v.sections.some((s) => s.title === "Taxes / Excise")).toBe(true);
  });

  it("every transaction is either in a counted row or in an excluded row, never both, never neither", () => {
    const v = buildDrillView(data, { kind: "spent" });
    const counted = v.sections.flatMap((s) => s.rows).map((r) => r.txId).filter((x): x is string => !!x);
    const excluded = v.excludedSections.flatMap((s) => s.rows).map((r) => r.txId).filter((x): x is string => !!x);
    expect(new Set(counted).size).toBe(counted.length); // no repeats (no multi-tag txs in this month)
    expect(counted.filter((id) => excluded.includes(id))).toEqual([]);
    expect(new Set([...counted, ...excluded]).size).toBe(data.txs.length);
  });

  it("notes the refunds, labels business spending and shows income only as information", () => {
    const v = buildDrillView(data, { kind: "spent" });
    expect(v.notes.join(" ")).toMatch(/Net of 3 refunds/);
    expect(v.infoRows.map((r) => r.label).join("|")).toMatch(/Business Expenses/);
    const income = v.infoRows.find((r) => r.label.startsWith("Income this month"));
    expect(income?.value).toBe("$17,349.23");
    expect(v.sections.flatMap((s) => s.rows).some((r) => r.chips.includes("Refund") && r.tone === "credit")).toBe(true);
  });

  it("Mortgage line view shows the cash payment, not 0", () => {
    const mort = data.lines.find((l) => l.id === "L-mort")!;
    const v = buildDrillView(data, { kind: "line", lineId: mort.id });
    expect(v.headline.cents).toBe(433569);
    expect(sumCountedRows(v)).toBe(433569);
    expect(v.lineEdit).toEqual({ budgetId: "L-mort", rawCents: 470000, resolvedCents: 470000 });
  });

  it("a parent line view shows its nested lines, and the rows add up to the parent's total", () => {
    const food = data.lines.find((l) => l.id === "L-food")!;
    const v = buildDrillView(data, { kind: "line", lineId: food.id });
    expect(v.sections.map((s) => s.title)).toEqual(["Food & Drink", "Groceries", "Restaurants"]);
    expect(v.sections.map((s) => s.depth)).toEqual([0, 1, 1]);
    expect(sumCountedRows(v)).toBe(food.rolledCents);
    expect(food.rolledCents).toBe(149736);
    expect(v.lineEdit?.rawCents).toBeNull(); // auto-sum parent: the editor starts blank
    expect(v.sections.flatMap((s) => s.rows).every((r) => r.tagIds !== null)).toBe(true); // rows can be re-tagged
  });

  it("the credit card line explains why it shows no spending", () => {
    const v = buildDrillView(data, { kind: "line", lineId: "L-ccpay" });
    expect(v.headline.cents).toBe(0);
    expect(v.notes.join(" ")).toMatch(/not counted as spending/);
  });

  it("Total Budgeted view lists every line and adds up top-level lines only", () => {
    const v = buildDrillView(data, { kind: "budgeted" });
    expect(sumCountedRows(v)).toBe(data.totalBudgetedCents);
    const rows = v.sections.flatMap((s) => s.rows);
    expect(rows.length).toBe(data.lines.length);
    expect(rows.filter((r) => !r.counts).map((r) => r.label).sort()).toEqual(["Groceries", "Restaurants"]);
  });

  it("Overspent view lists exactly the counted lines", () => {
    const v = buildDrillView(data, { kind: "overspent" });
    expect(v.expected).toEqual({ cents: data.overspentCount, unit: "count" });
    expect(sumCountedRows(v)).toBe(data.overspentCount);
    expect(v.sections[0]!.rows.length).toBe(data.overspentCount);
  });

  it("Account view lists every entry on the account, as the bank records it, with the balance", () => {
    const v = buildDrillView(data, { kind: "account", accountId: "acc-checking" });
    const net = data.txs.filter((t) => t.accountId === "acc-checking").reduce((s, t) => s + t.cents, 0);
    expect(sumRowCents(v)).toBe(net);
    expect(v.infoRows[0]).toEqual({ label: "Balance", value: "$1,000.50 as of Oct 9" });
    expect(v.links[0]!.href).toBe("/transactions?bucket=personal&accountId=acc-checking&tab=all");
    const card = buildDrillView(data, { kind: "account", accountId: "acc-card" });
    expect(card.headline.label).toBe("Balance owed");
    const loan = buildDrillView(data, { kind: "account", accountId: "acc-loan" });
    expect(loan.infoRows[0]!.value).toBe("not set for this account");
    expect(buildDrillView(data, { kind: "account", accountId: "nope" }).notes[0]).toMatch(/not part of the view/);
  });

  it("Transfer views show the plan in plain words and link to Envelope", () => {
    const one = buildDrillView(data, { kind: "transfer", transferId: "st1" });
    expect(one.sections[0]!.rows[0]!.sub).toBe("semi monthly · on the 1st and 15th · Savings");
    expect(one.links[0]!.href).toBe("/envelope?bucket=personal");
    expect(buildDrillView(data, { kind: "transfers" }).headline).toEqual({ label: "Scheduled", cents: 1, unit: "count" });
  });

  it("links keep the bucket and the month", () => {
    expect(data.hrefs.budgets).toBe("/budgets?bucket=personal&period=2026-09");
    expect(buildDrillView(data, { kind: "budgeted" }).links[0]!.href).toBe("/budgets?bucket=personal&period=2026-09");
  });

  it("the payload carries no account numbers, tokens or free-text descriptions", () => {
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/"mask"|"description"|"notes"|"plaid|accessToken|routing/i);
    expect(Object.keys(data.accounts[0]!).sort()).toEqual(["balanceAt", "balanceCents", "id", "institution", "nickname", "type"]);
    expect(Object.keys(data.txs[0]!).sort()).toEqual(["account", "accountId", "cents", "cls", "day", "entity", "id", "payee", "pending", "reason", "tagIds", "tagPaths", "targets"]);
  });
});

describe("drill-down payload: tags, repeats and views of other shapes", () => {
  it("a multi-tag transaction shows under each tag and a correction row takes the repeat out", () => {
    resetSeq(900);
    const data = payload(
      [tx({ amount: "-60", tags: ["Food & Drink / Groceries", "Bank Fees"] }), out("40", "Food & Drink / Restaurants")],
      TAGS,
      septemberLines()
    );
    const v = buildDrillView(data, { kind: "spent" });
    expect(data.spentCents).toBe(10000);
    expect(data.duplicateCents).toBe(6000);
    expect(v.sections.find((s) => s.key === "duplicates")!.rows[0]!.cents).toBe(-6000);
    expect(sumCountedRows(v)).toBe(10000);
  });

  it("no correction row when nothing repeats", () => {
    resetSeq(910);
    const v = buildDrillView(payload([out("40", "Bank Fees")], TAGS, []), { kind: "spent" });
    expect(v.sections.some((s) => s.key === "duplicates")).toBe(false);
  });

  it("an empty month still builds every view", () => {
    const data = payload([], TAGS, []);
    for (const target of [{ kind: "spent" }, { kind: "budgeted" }, { kind: "overspent" }, { kind: "transfers" }] as DrillTarget[]) {
      const v = buildDrillView(data, target);
      expect(v.sections.length).toBeGreaterThanOrEqual(0);
    }
    expect(buildDrillView(data, { kind: "spent" }).headline.cents).toBe(0);
  });

  it("an unknown line id is a calm notice, not a crash", () => {
    const v = buildDrillView(septData(), { kind: "line", lineId: "gone" });
    expect(v.notes[0]).toMatch(/not part of the month/);
  });

  it("the all-entities view adds a per-entity split of Spent, as information", () => {
    resetSeq(920);
    const data = payload(
      [tx({ amount: "-50", tags: ["Bank Fees"] }), tx({ amount: "-70", tags: ["Bank Fees"], entityId: "e2", entityName: "Sudden Valley" })],
      TAGS,
      [],
      { isAllEntities: true, bucket: "all" }
    );
    expect(data.entityBreakdown).toEqual([
      { entity: "Sudden Valley", spentCents: 7000 },
      { entity: "Personal", spentCents: 5000 },
    ]);
    const v = buildDrillView(data, { kind: "spent" });
    expect(v.infoRows.map((r) => r.label)).toEqual(expect.arrayContaining(["Spent in Sudden Valley", "Spent in Personal"]));
  });
});

describe("drill-down reconciliation over random worlds", () => {
  it("for every kind, the rows add up to the number clicked (250 seeded worlds)", () => {
    for (let seed = 1; seed <= 250; seed++) {
      const w = randomWorld(seed);
      const data = payload(w.txs, w.tags, w.lines);

      const spent = buildDrillView(data, { kind: "spent" });
      expect(sumCountedRows(spent), `seed ${seed}: spent`).toBe(data.spentCents);

      // counted and excluded rows together are exactly the month's transactions
      const countedIds = new Set(spent.sections.flatMap((s) => s.rows).map((r) => r.txId).filter((x): x is string => !!x));
      const excludedIds = new Set(spent.excludedSections.flatMap((s) => s.rows).map((r) => r.txId).filter((x): x is string => !!x));
      expect(countedIds.size + excludedIds.size, `seed ${seed}: coverage`).toBe(data.txs.length);
      for (const s of spent.excludedSections) expect(s.rows.reduce((t, r) => t + r.cents, 0), `seed ${seed}: excluded ${s.title}`).toBe(s.subtotalCents);

      for (const line of data.lines) {
        const lv = buildDrillView(data, { kind: "line", lineId: line.id });
        expect(sumCountedRows(lv), `seed ${seed}: line ${line.id}`).toBe(line.rolledCents);
      }
      expect(sumCountedRows(buildDrillView(data, { kind: "budgeted" })), `seed ${seed}: budgeted`).toBe(data.totalBudgetedCents);
      expect(sumCountedRows(buildDrillView(data, { kind: "overspent" })), `seed ${seed}: overspent`).toBe(data.overspentCount);
      for (const a of data.accounts) {
        const av = buildDrillView(data, { kind: "account", accountId: a.id });
        const net = data.txs.filter((t) => t.accountId === a.id).reduce((s, t) => s + t.cents, 0);
        expect(sumRowCents(av), `seed ${seed}: account ${a.id}`).toBe(net);
      }
    }
  });
});

describe("drill-down helpers", () => {
  it("formats a calendar day as text, with no time zone in play", () => {
    expect(formatDay("2026-09-01")).toBe("Sep 1");
    expect(formatDay("2026-12-31")).toBe("Dec 31");
    expect(formatDay("2026-09-30")).toBe("Sep 30");
  });
  it("formats cents exactly", () => {
    expect(centsText(1716222)).toBe("$17,162.22");
    expect(centsText(-16793)).toBe("-$167.93");
    expect(centsText(5)).toBe("$0.05");
    expect(centsText(0)).toBe("$0.00");
  });
  it("describes scheduled transfer day rules", () => {
    expect(describeDayRules({ dayOfWeek: 1 })).toBe("on Mondays");
    expect(describeDayRules({ daysOfMonth: [1, 15] })).toBe("on the 1st and 15th");
    expect(describeDayRules({ dayOfMonth: 22 })).toBe("on the 22nd");
    expect(describeDayRules({ dayOfMonth: 11 })).toBe("on the 11th");
    expect(describeDayRules(null)).toBe("");
    expect(describeDayRules({ weird: true })).toBe("");
  });
  it("the footer arithmetic would show a mismatch if rows and headline ever disagreed", () => {
    const data = septData();
    const v = buildDrillView(data, { kind: "spent" });
    const first = v.sections.find((s) => s.rows.length > 0)!;
    first.rows[0]!.cents += 1; // tamper with one row
    expect(sumCountedRows(v)).not.toBe(v.expected!.cents);
  });
});

describe("review round 1: All Entities labelling", () => {
  it("the Total Budgeted sub-line says 'all entities combined' only in the All Entities view, like the Spent card", () => {
    expect(budgetedSubline(true)).toBe("Top-level lines · click for the lines · all entities combined");
    expect(budgetedSubline(false)).toBe("Top-level lines · click for the lines");
    expect(budgetedSubline(false)).not.toMatch(/combined/);
  });
});
