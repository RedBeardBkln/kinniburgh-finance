import { describe, expect, it } from "vitest";
import { buildMonthSpend, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData, describeDayRules, displayPayee, type DrillBuildInput } from "@/lib/dashboard-drill-build";
import {
  budgetedSubline,
  buildDrillView,
  cadenceText,
  centsText,
  formatDay,
  groupLabel,
  sumCountedRows,
  sumRowCents,
  type DrillData,
  type DrillTarget,
} from "@/lib/dashboard-drill";
import { D, TAGS, out, randomWorld, resetSeq, septemberLines, septemberTxs, tid, tx } from "./month-spend-fixtures";

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
  const model = buildMonthSpend(txs, tags, withAmounts, { ownAccountByMask: extra.ownAccountByMask });
  return buildDrillData({
    model,
    txs,
    tags: tags.map((t) => ({ ...t, shortName: shortOf(t.name) })),
    budgets: lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, accountName: "Account " + l.accountId, entityName: l.accountId === "acc-b" ? "Sudden Valley" : "Personal", rawBudgeted: l.explicit, rollover: l.rollover })),
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
    expect(one.sections[0]!.rows[0]!.sub).toBe("Semi-monthly · on the 1st and 15th · Savings"); // plain cadence, never the raw semi_monthly
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
    expect(Object.keys(data.accounts[0]!).sort()).toEqual(["balanceAt", "balanceCents", "entity", "id", "institution", "nickname", "type"]);
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

// ---------------------------------------------------------------------------------------------------------------------
// Browser-check fixes

describe("browser-check fixes: own transfers in the dialog", () => {
  const masks = new Map([
    ["2558", "acc-loan"],
    ["1001", "acc-checking"],
  ]);
  function transferData() {
    resetSeq(2000);
    const txs = [
      tx({ amount: "-400", payee: "Online Xfer Transfer to CK x2558", pending: true }),
      tx({ amount: "400", payee: "Online Xfer Transfer from CK x1001", pending: true, accountId: "acc-loan", accountNickname: "Mortgage loan" }),
      tx({ amount: "-10", payee: "Online Xfer Transfer to SV x8815", pending: true, tags: ["Transfer Out"] }),
      out("30", "Bank Fees"),
    ];
    return payload(txs, TAGS, [], { ownAccountByMask: masks, isCurrentPeriod: true });
  }

  it("pending and unpaired transfers are not in Spent, are listed as excluded, with the reason on every row", () => {
    const data = transferData();
    expect(data.spentCents).toBe(3000);
    const v = buildDrillView(data, { kind: "spent" });
    expect(sumCountedRows(v)).toBe(3000);
    const group = v.excludedSections.find((s) => s.title === "Transfers between your own accounts")!;
    expect(group.rows).toHaveLength(3);
    expect(group.rows.map((r) => r.sub).sort()).toEqual([
      "Tagged Transfer In or Transfer Out",
      "Transfer from your own account, not counted",
      "Transfer to your own account, not counted",
    ]);
  });

  it("the account mask is never displayed: a known counterpart is named, an unknown one is hidden", () => {
    const data = transferData();
    const labels = data.txs.map((t) => t.payee);
    expect(labels).toContain("Transfer to Mortgage loan");
    expect(labels).toContain("Transfer from Checking");
    expect(labels).toContain("Online Xfer Transfer to SV x****");
    expect(labels.join(" | ")).not.toMatch(/\bx\d{4}\b/);
  });

  it("displayPayee leaves ordinary payees alone", () => {
    expect(displayPayee("Corner Market", masks, new Map())).toBe("Corner Market");
    expect(displayPayee("Online Xfer Transfer to CK x2558", masks, new Map())).toBe("Online Xfer Transfer to CK x****");
  });

  it("the Spent dialog title matches the card: 'Spent This Month' for the current month, 'Spent in <month>' for a past one", () => {
    expect(buildDrillView(transferData(), { kind: "spent" }).title).toBe("Spent This Month");
    expect(buildDrillView(septData(), { kind: "spent" }).title).toBe("Spent in September 2026");
  });
});

describe("browser-check fixes: exclusion signs, labels, cadence", () => {
  it("every excluded group says how much came in, how much went out and the net, all in the bank's signs", () => {
    const data = septData();
    const v = buildDrillView(data, { kind: "spent" });
    for (const s of v.excludedSections) {
      expect(s.moneyInCents).toBeGreaterThanOrEqual(0);
      expect(s.moneyOutCents).toBeLessThanOrEqual(0);
      expect((s.moneyInCents ?? 0) + (s.moneyOutCents ?? 0)).toBe(s.subtotalCents);
    }
    const cards = v.excludedSections.find((s) => s.title === "Credit card payments")!;
    expect(cards.subtotalCents).toBe(-16793);
    expect(cards.moneyInCents).toBe(56682); // the card-side credits
    expect(cards.moneyOutCents).toBe(-73475); // the payments out of checking
    expect(cards.subtotalNote).toMatch(/\+ money in, - money out/);
  });

  it("cadence reads in plain words", () => {
    expect(cadenceText("semi_monthly")).toBe("Semi-monthly");
    expect(cadenceText("weekly")).toBe("Weekly");
    expect(cadenceText("monthly")).toBe("Monthly");
    expect(cadenceText("biweekly")).toBe("Every two weeks");
    expect(cadenceText("every_other_day")).toBe("Every other day");
  });

  it("the scheduled transfer detail uses the plain cadence", () => {
    const data = septData();
    expect(data.transfers[0]!.cadence).toBe("Semi-monthly");
    expect(JSON.stringify(data)).not.toContain("semi_monthly");
  });
});

describe("browser-check fixes: account groups and line subtitles", () => {
  const lineIn = (id: string, tag: string, accountId: string) => ({ id, tagId: tid(tag), accountId, resolved: D(100), explicit: D(100), rollover: D(0) });
  function allEntitiesData() {
    resetSeq(3000);
    const txs = [out("20", "Food & Drink / Groceries"), out("30", "Bank Fees")];
    return payload(txs, TAGS, [lineIn("LA", "Food & Drink / Groceries", "acc-a"), lineIn("LB", "Bank Fees", "acc-b")], { isAllEntities: true, bucket: "all" });
  }

  it("the All Entities view labels EVERY account group with its entity (spent view, budgeted view)", () => {
    const data = allEntitiesData();
    expect(data.groups.map((g) => g.entityName).sort()).toEqual(["Personal", "Sudden Valley"]);
    const spent = buildDrillView(data, { kind: "spent" });
    const headings = spent.sections.map((s) => s.heading).filter((h): h is string => !!h && h.startsWith("Account"));
    expect(headings.sort()).toEqual(["Account acc-a · Personal", "Account acc-b · Sudden Valley"]);
    const budgeted = buildDrillView(data, { kind: "budgeted" });
    expect(budgeted.sections.map((s) => s.title).sort()).toEqual(["Account acc-a · Personal", "Account acc-b · Sudden Valley"]);
    expect(groupLabel(data, data.groups[0]!)).toMatch(/ · (Personal|Sudden Valley)$/);
  });

  it("a single-entity view stays unlabelled", () => {
    const data = payload([out("20", "Bank Fees")], TAGS, [lineIn("LB", "Bank Fees", "acc-b")]);
    expect(buildDrillView(data, { kind: "budgeted" }).sections[0]!.title).toBe("Account acc-b");
  });

  it("a line's subtitle names the account it is budgeted on, and the other accounts its spending is on", () => {
    resetSeq(3100);
    const data = payload(
      [
        out("20", "Food & Drink / Groceries"),
        tx({ amount: "-35", tags: ["Food & Drink / Groceries"], accountId: "acc-card", accountNickname: "Barclay" }),
        tx({ amount: "-5", tags: ["Food & Drink / Groceries"], accountId: "acc-card", accountNickname: "Barclay" }),
      ],
      TAGS,
      [lineIn("LG", "Food & Drink / Groceries", "acc-checking")]
    );
    expect(buildDrillView(data, { kind: "line", lineId: "LG" }).subtitle).toBe("Budgeted on the Account acc-checking account · spending also on Barclay");
  });

  it("a line whose spending is all on its own account just names that account", () => {
    resetSeq(3110);
    const data = payload([out("20", "Bank Fees")], TAGS, [lineIn("LB", "Bank Fees", "acc-checking")]);
    expect(buildDrillView(data, { kind: "line", lineId: "LB" }).subtitle).toBe("Budgeted on the Account acc-checking account");
  });

  it("every row shows the account its own transaction is on", () => {
    const data = septData();
    const byId = new Map(data.txs.map((t) => [t.id, t]));
    const targets: DrillTarget[] = [{ kind: "spent" }, { kind: "account", accountId: "acc-card" }, { kind: "account", accountId: "acc-loan" }, { kind: "line", lineId: "L-mort" }];
    let checked = 0;
    for (const target of targets) {
      const v = buildDrillView(data, target);
      for (const row of [...v.sections, ...v.excludedSections].flatMap((s) => s.rows)) {
        if (!row.txId) continue;
        expect(row.account, `${target.kind} ${row.txId}`).toBe(byId.get(row.txId)!.account);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
    // and the fixture really has rows on more than one account
    expect(new Set(data.txs.map((t) => t.account)).size).toBeGreaterThan(2);
  });
});

describe("final pass: whitespace variants, near-miss forms and the cross-entity transfer in the dialog", () => {
  const masks = new Map([
    ["2558", "acc-loan"],
    ["1001", "acc-checking"],
  ]);
  const nick = new Map([
    ["acc-loan", "Mortgage loan"],
    ["acc-checking", "Checking"],
  ]);

  it("a double-space label with a known counterpart is named, never shown with its digits", () => {
    expect(displayPayee("Online  Xfer Transfer to CK x2558", masks, nick)).toBe("Transfer to Mortgage loan");
    expect(displayPayee("Online   Xfer  Transfer from  CK x1001", masks, nick)).toBe("Transfer from Checking");
  });

  it("every near-miss transfer form keeps its wording but loses the digits", () => {
    const forms = [
      "Online  Xfer Transfer to SV x8815",
      "online xfer transfer to ck x2558",
      "Online Xfer Transfer to CK x2558 extra",
      "ONLINE XFER TRANSFER FROM CK X2558",
      "Online\tXfer Transfer to SV x8815",
      "Online Xfer Transfer to CK x9999",
      "Xfer to x1234",
    ];
    for (const f of forms) {
      const out = displayPayee(f, masks, nick);
      expect(out, f).not.toMatch(/\bx\d{4}\b/i);
      expect(out, f).toContain("****");
    }
    expect(displayPayee("Online  Xfer Transfer to SV x8815", masks, nick)).toBe("Online  Xfer Transfer to SV x****");
  });

  it("text without a transfer wording is left alone, and wordings with no digits are unchanged", () => {
    expect(displayPayee("PAYPAL INST XFER", masks, nick)).toBe("PAYPAL INST XFER");
    expect(displayPayee("COREPLUS FCU ACH XFER", masks, nick)).toBe("COREPLUS FCU ACH XFER");
    expect(displayPayee("Hardware store x1234", masks, nick)).toBe("Hardware store x1234");
  });

  it("the dialog lists a double-space own transfer under 'Not counted' with its reason and no digits", () => {
    resetSeq(7000);
    const txs = [tx({ amount: "-300", payee: "Online  Xfer Transfer to CK x2558" }), out("30", "Bank Fees")];
    const data = payload(txs, TAGS, [], { ownAccountByMask: masks });
    expect(data.spentCents).toBe(3000);
    const v = buildDrillView(data, { kind: "spent" });
    const group = v.excludedSections.find((s) => s.title === "Transfers between your own accounts")!;
    expect(group.rows).toHaveLength(1);
    expect(group.rows[0]!.label).toBe("Transfer to Mortgage loan");
    expect(group.rows[0]!.sub).toBe("Transfer to your own account, not counted");
    expect(JSON.stringify(data)).not.toMatch(/"x\d{4}|\bx\d{4}\b/);
  });

  it("a transfer to an own account of ANOTHER entity stays listed under 'Not counted'", () => {
    resetSeq(7100);
    const data = payload([tx({ amount: "-500", payee: "Online Xfer Transfer to CK x2558" }), out("25", "Bank Fees")], TAGS, [], { ownAccountByMask: masks });
    const v = buildDrillView(data, { kind: "spent" });
    expect(data.spentCents).toBe(2500);
    const group = v.excludedSections.find((s) => s.title === "Transfers between your own accounts")!;
    expect(group.subtotalCents).toBe(-50000);
    expect(group.rows.map((r) => r.sub)).toEqual(["Transfer to your own account, not counted"]);
    expect(sumCountedRows(v)).toBe(2500);
  });
});
