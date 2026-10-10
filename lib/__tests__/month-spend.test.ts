import { describe, expect, it } from "vitest";
import {
  buildMonthSpend,
  classifyTx,
  currentPeriodNY,
  isValidPeriod,
  periodBounds,
  type MonthSpendModel,
  type SpendLineInput,
  type SpendTag,
  type SpendTx,
} from "@/lib/month-spend";
import { D, TAGS, inn, out, randomWorld, resetSeq, septemberLines, septemberTxs, tid, tx } from "./month-spend-fixtures";

// Synthetic fixtures: the CLASSES and AMOUNTS that explain the dashboard's old "$4,562.94" for September 2026 (a signed
// sum of income minus spending with the sign dropped), with invented payees and ids. No real transaction list here.

describe("month spend: September 2026 golden numbers", () => {
  const m = buildMonthSpend(septemberTxs(), TAGS, septemberLines());

  it("reproduces the old headline: a signed sum of +4,562.94 (income minus spending, sign dropped)", () => {
    expect(m.signedTotal.toFixed(2)).toBe("4562.94");
  });

  it("Spent is the real figure: 18,098.39 out minus 936.17 of refunds = 17,162.22", () => {
    expect(m.outflows.toFixed(2)).toBe("18098.39");
    expect(m.refunds.toFixed(2)).toBe("936.17");
    expect(m.refundCount).toBe(3);
    expect(m.spent.toFixed(2)).toBe("17162.22");
  });

  it("income is its own figure and never part of Spent", () => {
    expect(m.income.toFixed(2)).toBe("17349.23");
  });

  it("excluded classes are listed with count and sum", () => {
    const by = Object.fromEntries(m.excluded.map((g) => [g.cls, g]));
    expect(by.own_transfer?.sum.toFixed(2)).toBe("310.00");
    expect(by.own_transfer?.count).toBe(5);
    // both legs of the two card payments cancel; the third payment has no card-side row here
    expect(by.card_payment?.sum.toFixed(2)).toBe("-167.93");
    expect(by.card_payment?.count).toBe(5);
    expect(by.loan_account?.sum.toFixed(2)).toBe("4233.86");
    expect(by.loan_account?.count).toBe(3);
    expect(by.income?.sum.toFixed(2)).toBe("17349.23");
    expect(by.income?.count).toBe(6);
  });

  it("bridges to the old number: signed total = -Spent + every excluded class", () => {
    let bridge = m.spent.negated();
    for (const g of m.excluded) bridge = bridge.plus(g.sum);
    expect(bridge.toFixed(2)).toBe("4562.94");
    expect(bridge.equals(m.signedTotal)).toBe(true);
  });

  it("the mortgage line shows the cash payment, not 0 (loan-account mirror rows do not cancel it)", () => {
    const mortgage = m.lines.find((l) => l.id === "L-mort");
    expect(mortgage?.ownSpend.toFixed(2)).toBe("4335.69");
    expect(mortgage?.rolledSpend.toFixed(2)).toBe("4335.69");
  });

  it("a sub-tag with no line of its own is owned by the nearest budgeted ancestor", () => {
    const food = m.lines.find((l) => l.id === "L-food");
    expect(food?.ownSpend.toFixed(2)).toBe("102.00"); // Farmers Market
    expect(food?.rolledSpend.toFixed(2)).toBe((812.4 + 582.96 + 102).toFixed(2));
    expect(m.lines.find((l) => l.id === "L-groc")?.rolledSpend.toFixed(2)).toBe("812.40");
  });

  it("the credit card line shows 0 spent (payments are not spending), not the card-side inflow", () => {
    expect(m.lines.find((l) => l.id === "L-ccpay")?.rolledSpend.toFixed(2)).toBe("0.00");
  });

  it("untagged and unbudgeted spending are explicit rows, and the parts add up to Spent exactly", () => {
    expect(m.untagged.spend.toFixed(2)).toBe("88.12");
    expect(m.untagged.txIds).toHaveLength(4);
    const tags = m.notInAnyLine.map((b) => b.tagName);
    expect(tags).toContain("Taxes / Excise");
    expect(tags).toContain("Travel + Vacation");
    expect(tags).toContain("Bank Fees");
    expect(m.reconciles).toBe(true);
    expect(m.duplicateAdjustment.isZero()).toBe(true);
    let parts = m.untagged.spend;
    for (const id of m.rootLineIds) parts = parts.plus(m.lines.find((l) => l.id === id)!.rolledSpend);
    for (const b of m.notInAnyLine) parts = parts.plus(b.spend);
    expect(parts.equals(m.spent)).toBe(true);
  });

  it("the refund on Travel reduces that tag's unbudgeted spend", () => {
    const travel = m.notInAnyLine.find((b) => b.tagName === "Travel + Vacation");
    expect(travel?.spend.toFixed(2)).toBe((929.65 - 269.07).toFixed(2));
  });

  it("business-tagged spending is counted where it was paid and labelled", () => {
    expect(m.businessTaggedSpend.toFixed(2)).toBe("1054.57");
  });

  it("every transaction has exactly one class", () => {
    expect(m.verdicts.size).toBe(m.txCount);
  });
});

describe("month spend: October-style month (pending rows, an untagged row, a tagged transfer)", () => {
  resetSeq(100);
  const txs = [
    tx({ amount: "-120.00", pending: true, tags: [tid("Food & Drink / Groceries")] }),
    tx({ amount: "-80.00", pending: true, tags: [tid("Food & Drink / Groceries")] }),
    tx({ amount: "-2350.15" }),
    tx({ amount: "-10.00", tags: [tid("Transfer Out")] }),
    tx({ amount: "1817.30", tags: [tid("Income / Income - Eric")] }),
  ];
  const m = buildMonthSpend(txs, TAGS, septemberLines());

  it("counts pending rows and says how many", () => {
    expect(m.pendingCount).toBe(2);
    expect(m.spent.toFixed(2)).toBe("2550.15");
  });
  it("shows the untagged row on its own", () => {
    expect(m.untagged.spend.toFixed(2)).toBe("2350.15");
    expect(m.untagged.txIds).toHaveLength(1);
  });
  it("leaves the tagged transfer and the income out of Spent", () => {
    expect(m.excluded.map((g) => g.cls).sort()).toEqual(["income", "own_transfer"]);
    expect(m.reconciles).toBe(true);
  });
});

describe("month spend: classification", () => {
  const tagById = new Map(TAGS.map((t) => [t.id, t]));
  const cls = (t: SpendTx) => classifyTx(t, tagById).cls;

  it("a paired transfer is an own transfer whatever its tags", () => {
    expect(cls(tx({ amount: "-500", transferPairId: "pair-1", tags: [tid("Food & Drink / Groceries")] }))).toBe("own_transfer");
  });
  it("a mortgage or loan account row is a loan-account row", () => {
    expect(cls(tx({ amount: "1079.89", accountType: "mortgage", tags: [tid("Utilities / Mortgage")] }))).toBe("loan_account");
    expect(cls(tx({ amount: "-200", accountType: "loan" }))).toBe("loan_account");
  });
  it("Credit Cards subtree is a card payment, either leg", () => {
    expect(cls(out("100", "Credit Cards / Credit Card - Eric"))).toBe("card_payment");
    expect(cls(inn("100", "Credit Cards / Credit card payment"))).toBe("card_payment");
    expect(cls(out("100", "Credit Cards"))).toBe("card_payment");
  });
  it("a business 'Credit card payment' tag is a card payment too", () => {
    expect(cls(out("100", "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Credit card payment"))).toBe("card_payment");
  });
  it("card interest is a real cost, not a payment", () => {
    expect(cls(out("25", "Credit Cards / Interest paid"))).toBe("spending");
  });
  it("income and revenue tags are income", () => {
    expect(cls(inn("10", "Income / Income - Eric"))).toBe("income");
    expect(cls(inn("10", "Misc. / Income"))).toBe("income");
    expect(cls(inn("10", "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Revenue"))).toBe("income");
  });
  it("Taxes / Income Tax is not income (it only contains the word)", () => {
    const tags: SpendTag[] = [...TAGS, { id: "t:Taxes / Income Tax", name: "Taxes / Income Tax", parentId: tid("Taxes") }];
    expect(classifyTx(out("10", "Taxes / Income Tax"), new Map(tags.map((t) => [t.id, t]))).cls).toBe("spending");
  });
  it("money out is spending, money in on an ordinary tag is a refund, untagged money in is a refund too (no guessing)", () => {
    expect(cls(out("10", "Bank Fees"))).toBe("spending");
    expect(cls(inn("10", "Household Goods"))).toBe("refund");
    expect(cls(tx({ amount: "10" }))).toBe("refund");
  });
  it("does not guess from payee text", () => {
    expect(cls(tx({ amount: "-50", payee: "CAPITAL ONE-CRCARDPMT" }))).toBe("spending");
  });
});

describe("month spend: card double counting", () => {
  it("a 100 charge, the 100 payment from checking and the 100 'payment received' on the card count 100 once", () => {
    resetSeq(200);
    const txs = [
      tx({ amount: "-100", accountId: "acc-card", accountType: "credit_card", accountNickname: "Card", tags: [tid("Food & Drink / Restaurants")] }),
      out("100", "Credit Cards / Credit Card - Eric"),
      tx({ amount: "100", accountId: "acc-card", accountType: "credit_card", accountNickname: "Card", tags: [tid("Credit Cards / Credit card payment")] }),
    ];
    const m = buildMonthSpend(txs, TAGS, []);
    expect(m.spent.toFixed(2)).toBe("100.00");
    expect(m.excluded.find((g) => g.cls === "card_payment")?.count).toBe(2);
    expect(m.excluded.find((g) => g.cls === "card_payment")?.sum.toFixed(2)).toBe("0.00");
  });
});

describe("month spend: a transaction with several tags", () => {
  it("counts once in Spent and removes the repeat with a correcting amount", () => {
    resetSeq(300);
    const m = buildMonthSpend(
      [tx({ amount: "-60", tags: [tid("Food & Drink / Groceries"), tid("Bank Fees")] })],
      TAGS,
      septemberLines()
    );
    expect(m.spent.toFixed(2)).toBe("60.00");
    expect(m.duplicateAdjustment.toFixed(2)).toBe("60.00");
    expect(m.lines.find((l) => l.id === "L-groc")?.rolledSpend.toFixed(2)).toBe("60.00");
    expect(m.notInAnyLine[0]?.spend.toFixed(2)).toBe("60.00");
    expect(m.reconciles).toBe(true);
  });
  it("two tags that resolve to the same line are counted once for that line", () => {
    resetSeq(310);
    const m = buildMonthSpend(
      [tx({ amount: "-60", tags: [tid("Food & Drink"), tid("Food & Drink / Farmers Market")] })],
      TAGS,
      septemberLines()
    );
    expect(m.lines.find((l) => l.id === "L-food")?.ownSpend.toFixed(2)).toBe("60.00");
    expect(m.duplicateAdjustment.isZero()).toBe(true);
    expect(m.reconciles).toBe(true);
  });
  it("shows no correction when nothing repeats", () => {
    resetSeq(320);
    const m = buildMonthSpend([tx({ amount: "-60", tags: [tid("Bank Fees")] })], TAGS, []);
    expect(m.duplicateAdjustment.isZero()).toBe(true);
  });
});

describe("month spend: overspent rule", () => {
  const lines = (over: Partial<Record<string, string>> = {}): SpendLineInput[] => septemberLines().map((l) => ({ ...l, resolved: D(over[l.id] ?? l.resolved.toString()) }));

  it("a detailed line over its budget counts", () => {
    resetSeq(400);
    const m = buildMonthSpend([out("450", "Food & Drink / Groceries")], TAGS, lines());
    const groc = m.lines.find((l) => l.id === "L-groc")!;
    expect(groc.countsAsOverspent).toBe(true);
    expect(groc.overBy.toFixed(2)).toBe("50.00");
  });
  it("an auto-sum parent is not counted even if its total is over", () => {
    resetSeq(410);
    const m = buildMonthSpend([out("450", "Food & Drink / Groceries"), out("350", "Food & Drink / Restaurants")], TAGS, lines());
    const food = m.lines.find((l) => l.id === "L-food")!;
    expect(food.rolledSpend.toFixed(2)).toBe("800.00");
    expect(food.rolledSpend.greaterThan(food.effectiveBudget)).toBe(true);
    expect(food.countsAsOverspent).toBe(false);
    expect(m.lines.filter((l) => l.countsAsOverspent).map((l) => l.id).sort()).toEqual(["L-groc", "L-rest"]);
  });
  it("a parent with a stated amount counts", () => {
    resetSeq(420);
    const stated = septemberLines().map((l) => (l.id === "L-food" ? { ...l, explicit: D("500"), resolved: D("500") } : l));
    const m = buildMonthSpend([out("300", "Food & Drink / Groceries"), out("300", "Food & Drink / Restaurants")], TAGS, stated);
    expect(m.lines.find((l) => l.id === "L-food")!.countsAsOverspent).toBe(true);
  });
  it("rollover raises the line's effective budget", () => {
    resetSeq(430);
    const withRollover = septemberLines().map((l) => (l.id === "L-groc" ? { ...l, rollover: D("100") } : l));
    const m = buildMonthSpend([out("450", "Food & Drink / Groceries")], TAGS, withRollover);
    expect(m.lines.find((l) => l.id === "L-groc")!.countsAsOverspent).toBe(false);
    expect(m.lines.find((l) => l.id === "L-groc")!.effectiveBudget.toFixed(2)).toBe("500.00");
  });
  it("spending exactly at the budget is not overspent", () => {
    resetSeq(440);
    const m = buildMonthSpend([out("400", "Food & Drink / Groceries")], TAGS, lines());
    expect(m.lines.find((l) => l.id === "L-groc")!.countsAsOverspent).toBe(false);
  });
});

describe("month spend: periods", () => {
  it("stays on September until midnight in New York (03:30Z on Oct 1 is still Sept 30 evening)", () => {
    expect(currentPeriodNY(new Date("2026-10-01T03:30:00Z"))).toBe("2026-09");
    expect(currentPeriodNY(new Date("2026-10-01T04:00:00Z"))).toBe("2026-10");
  });
  it("handles winter time (UTC-5) at the turn of a month", () => {
    expect(currentPeriodNY(new Date("2026-12-01T04:59:00Z"))).toBe("2026-11");
    expect(currentPeriodNY(new Date("2026-12-01T05:00:00Z"))).toBe("2026-12");
  });
  it("periodBounds are UTC month bounds", () => {
    const b = periodBounds("2026-09");
    expect(b.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodBounds("2026-12").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("validates YYYY-MM", () => {
    expect(isValidPeriod("2026-09")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("2026-9")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Property test: random worlds

describe("month spend: reconciliation property over random worlds", () => {
  const checkWorld = (seed: number): MonthSpendModel => {
    const { tags, lines, txs } = randomWorld(seed);
    const m = buildMonthSpend(txs, tags, lines);

    // 1. independent recomputation of Spent from the verdict classes
    let spent = D(0);
    for (const t of txs) {
      const v = m.verdicts.get(t.id)!;
      if (v.cls === "spending" || v.cls === "refund") spent = spent.minus(t.amount);
    }
    expect(m.spent.equals(spent), `seed ${seed}: spent`).toBe(true);

    // 2. the parts add up to Spent (roots + not-in-any-line + untagged - repeats)
    let parts = m.untagged.spend;
    for (const l of m.lines) if (l.parentLineId === null) parts = parts.plus(l.rolledSpend);
    for (const b of m.notInAnyLine) parts = parts.plus(b.spend);
    expect(parts.minus(m.duplicateAdjustment).equals(m.spent), `seed ${seed}: parts`).toBe(true);
    expect(m.reconciles, `seed ${seed}: reconciles`).toBe(true);

    // 3. the bridge to a naive signed sum
    let bridge = m.spent.negated();
    for (const g of m.excluded) bridge = bridge.plus(g.sum);
    expect(bridge.equals(m.signedTotal), `seed ${seed}: bridge`).toBe(true);

    // 4. a parent's rolled spend is its own plus its nested lines'
    for (const l of m.lines) {
      let sum = l.ownSpend;
      for (const k of m.lines) if (k.parentLineId === l.id) sum = sum.plus(k.rolledSpend);
      expect(sum.equals(l.rolledSpend), `seed ${seed}: roll ${l.id}`).toBe(true);
    }

    // 5. each tx is in exactly one class and excluded counts add up
    expect(m.verdicts.size).toBe(txs.length);
    const excludedCount = m.excluded.reduce((s, g) => s + g.count, 0);
    const spendCount = [...m.verdicts.values()].filter((v) => v.cls === "spending" || v.cls === "refund").length;
    expect(excludedCount + spendCount).toBe(txs.length);
    return m;
  };

  it("holds for 300 seeded random worlds (trees, lines, multi-tag, every class)", () => {
    let sawDuplicates = 0;
    let sawNested = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const m = checkWorld(seed);
      if (!m.duplicateAdjustment.isZero()) sawDuplicates += 1;
      if (m.lines.some((l) => l.parentLineId !== null)) sawNested += 1;
    }
    // the generator really exercises the hard cases
    expect(sawDuplicates).toBeGreaterThan(20);
    expect(sawNested).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Browser-check fix: bank-labelled transfers between own accounts that have no pair yet (pending) or never got one

describe("own-account transfers recognised by the bank wording and a household account mask", () => {
  // mask -> account id: exactly the ACTIVE, unambiguous accounts (the loader builds this; masks are never shown)
  const masks = new Map([
    ["2558", "acc-mortgage"],
    ["3612", "acc-slush"],
    ["1001", "acc-checking"],
  ]);
  const xfer = (amount: string, payee: string, over: Omit<Partial<SpendTx>, "amount" | "tagIds"> & { tags?: string[] } = {}) => tx({ amount, payee, ...over });
  const run = (txs: SpendTx[], withMasks = true) => buildMonthSpend(txs, TAGS, septemberLines(), withMasks ? { ownAccountByMask: masks } : {});

  it("a PENDING untagged transfer to an own account is not spending and says why", () => {
    resetSeq(1000);
    const t = xfer("-400", "Online Xfer Transfer to CK x2558", { pending: true });
    const m = run([t, out("30", "Bank Fees")]);
    expect(m.spent.toFixed(2)).toBe("30.00");
    expect(m.pendingCount).toBe(0); // the pending transfer is not a counted pending row
    const g = m.excluded.find((x) => x.cls === "own_transfer")!;
    expect(g.count).toBe(1);
    expect(g.sum.toFixed(2)).toBe("-400.00");
    expect(m.verdicts.get(t.id)).toMatchObject({ cls: "own_transfer", reason: "Transfer to your own account, not counted" });
    expect(m.reconciles).toBe(true);
  });

  it("a POSTED unpaired transfer is excluded the same way, in both directions", () => {
    resetSeq(1010);
    const to = xfer("-2350", "Online Xfer Transfer to CK x3612");
    const from = xfer("2350", "Online Xfer Transfer from CK x1001", { accountId: "acc-slush" });
    const m = run([to, from]);
    expect(m.spent.isZero()).toBe(true);
    expect(m.refunds.isZero()).toBe(true); // the incoming leg is not a refund
    expect(m.verdicts.get(from.id)?.reason).toBe("Transfer from your own account, not counted");
    expect(m.excluded.find((x) => x.cls === "own_transfer")?.count).toBe(2);
    expect(m.excluded.find((x) => x.cls === "own_transfer")?.sum.toFixed(2)).toBe("0.00");
  });

  it("without the mask map the old behaviour is unchanged (the rule is opt-in)", () => {
    resetSeq(1020);
    const m = run([xfer("-400", "Online Xfer Transfer to CK x2558", { pending: true })], false);
    expect(m.spent.toFixed(2)).toBe("400.00");
  });

  it("an unknown mask stays spending", () => {
    resetSeq(1030);
    const m = run([xfer("-400", "Online Xfer Transfer to CK x9999", { pending: true })]);
    expect(m.spent.toFixed(2)).toBe("400.00");
    expect(m.excluded.length).toBe(0);
  });

  it("a mask that belongs to an archived or foreign account (so it is not in the map) stays spending", () => {
    resetSeq(1040);
    // 4444 is, say, an archived account: the loader leaves it out of the map, so it cannot classify anything
    const m = run([xfer("-75", "Online Xfer Transfer to SV x4444")]);
    expect(m.spent.toFixed(2)).toBe("75.00");
  });

  it("a transfer whose mask is the row's OWN account is not a transfer to an own account", () => {
    resetSeq(1050);
    const m = run([xfer("-60", "Online Xfer Transfer to CK x2558", { accountId: "acc-mortgage" })]);
    expect(m.spent.toFixed(2)).toBe("60.00");
  });

  it("only the exact bank wording counts: other text that mentions a mask is not a transfer", () => {
    resetSeq(1060);
    for (const payee of ["Payment to x2558", "CORFCU CK WEBXFR TRANSFER", "Online Xfer Transfer to CK x2558 extra", "online xfer transfer to ck x2558"]) {
      const m = run([xfer("-10", payee)]);
      expect(m.spent.toFixed(2), payee).toBe("10.00");
    }
  });

  it("no double exclusion when the pair is formed later: the paired row is one own transfer, counted once", () => {
    resetSeq(1070);
    const paired = [
      xfer("-400", "Online Xfer Transfer to CK x2558", { transferPairId: "pair-9" }),
      xfer("400", "Online Xfer Transfer from CK x1001", { transferPairId: "pair-9", accountId: "acc-mortgage" }),
    ];
    const m = run(paired);
    const g = m.excluded.find((x) => x.cls === "own_transfer")!;
    expect(g.count).toBe(2);
    expect(g.sum.toFixed(2)).toBe("0.00");
    expect(m.verdicts.get(paired[0]!.id)?.reason).toBe("Paired transfer between your own accounts");
    // the same rows unpaired give the same totals
    const unpaired = paired.map((p) => ({ ...p, id: p.id + "u", transferPairId: null }));
    const m2 = run(unpaired);
    expect(m2.spent.toFixed(2)).toBe(m.spent.toFixed(2));
    expect(m2.excluded.find((x) => x.cls === "own_transfer")?.count).toBe(2);
  });

  it("a transfer that is also tagged Transfer Out is still one own transfer", () => {
    resetSeq(1080);
    const m = run([xfer("-10", "Online Xfer Transfer to CK x2558", { tags: ["Transfer Out"] })]);
    expect(m.excluded.find((x) => x.cls === "own_transfer")?.count).toBe(1);
    expect(m.spent.isZero()).toBe(true);
  });

  it("the parts still add up to Spent exactly with transfers mixed in (200 random worlds)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const w = randomWorld(seed);
      const txs = w.txs.map((t, i) =>
        i % 5 === 0 ? { ...t, payee: i % 10 === 0 ? "Online Xfer Transfer to CK x2558" : "Online Xfer Transfer from CK x3612", accountId: "a1" } : t
      );
      const m = buildMonthSpend(txs, w.tags, w.lines, { ownAccountByMask: masks });
      expect(m.reconciles, `seed ${seed}`).toBe(true);
      let bridge = m.spent.negated();
      for (const g of m.excluded) bridge = bridge.plus(g.sum);
      expect(bridge.equals(m.signedTotal), `seed ${seed}: bridge`).toBe(true);
      expect(m.verdicts.size).toBe(txs.length);
      const rowCount = m.excluded.reduce((s, g) => s + g.count, 0) + [...m.verdicts.values()].filter((v) => v.cls === "spending" || v.cls === "refund").length;
      expect(rowCount, `seed ${seed}: each tx counted once`).toBe(txs.length);
    }
  });
});

describe("whitespace-tolerant bank wording (historical rows use 'Online  Xfer')", () => {
  const masks = new Map([["2558", "acc-mortgage"]]);
  const run = (payee: string) => {
    resetSeq(6000);
    return buildMonthSpend([tx({ amount: "-100", payee })], TAGS, [], { ownAccountByMask: masks });
  };

  it.each([
    "Online  Xfer Transfer to CK x2558",
    "Online   Xfer  Transfer   to  CK  x2558",
    "Online\tXfer Transfer to CK x2558",
    " Online Xfer Transfer to CK x2558 ",
    "Online Xfer\u00a0Transfer to CK x2558",
  ])("is an own transfer: %j", (payee) => {
    const m = run(payee);
    expect(m.spent.isZero()).toBe(true);
    expect(m.excluded.find((g) => g.cls === "own_transfer")?.count).toBe(1);
  });

  it.each([
    "online  xfer transfer to ck x2558", // case is still exact
    "Online  Xfer Transfer to CK x2558 extra",
    "Online  Xfer Transfer to C x2558",
    "Online  Xfer Transfer to CK x255",
    "Online  Xfer Transfer to CK x9999", // unknown mask
    "Online  Xfer Transfer CK x2558", // direction missing
  ])("stays spending: %j", (payee) => {
    expect(run(payee).spent.toFixed(2)).toBe("100.00");
  });
});

describe("a transfer to an own account of a DIFFERENT entity (reviewer decision: still an own transfer)", () => {
  it("is classed own_transfer, kept out of Spent and listed under the excluded transfers with its reason", () => {
    resetSeq(6100);
    // Personal checking pays the LLC's operating account (a household account of another entity)
    const masks = new Map([["8888", "acc-llc-operating"]]);
    const t = tx({ amount: "-500", payee: "Online Xfer Transfer to CK x8888", entityId: "ent-personal", entityName: "Personal" });
    const m = buildMonthSpend([t, tx({ amount: "-25", tags: ["Bank Fees"] })], TAGS, [], { ownAccountByMask: masks });
    expect(m.spent.toFixed(2)).toBe("25.00");
    const g = m.excluded.find((x) => x.cls === "own_transfer")!;
    expect(g.count).toBe(1);
    expect(g.sum.toFixed(2)).toBe("-500.00");
    expect(m.verdicts.get(t.id)).toMatchObject({ cls: "own_transfer", reason: "Transfer to your own account, not counted" });
    expect(m.reconciles).toBe(true);
  });
});
