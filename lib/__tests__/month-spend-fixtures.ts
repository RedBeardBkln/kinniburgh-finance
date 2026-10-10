// Shared synthetic fixtures for the month-spend / drill-down tests. Invented payees and ids only: the CLASSES and
// AMOUNTS mirror what explains the dashboard's old "$4,562.94" for September 2026, but no real transaction list lives here.
import { Decimal } from "@prisma/client/runtime/library";
import type { SpendLineInput, SpendTag, SpendTx } from "@/lib/month-spend";

export const D = (v: string | number) => new Decimal(v);

// ---------------------------------------------------------------------------------------------------------------------
// Tags (ids are the names with spaces dropped, for readability)

const TAG_NAMES = [
  "Food & Drink",
  "Food & Drink / Groceries",
  "Food & Drink / Restaurants",
  "Food & Drink / Farmers Market",
  "Utilities",
  "Utilities / Mortgage",
  "Home & Property",
  "Home & Property / Repairs",
  "Taxes",
  "Taxes / Excise",
  "Travel + Vacation",
  "Bank Fees",
  "Household Goods",
  "Credit Cards",
  "Credit Cards / Credit Card - Eric",
  "Credit Cards / Credit card payment",
  "Credit Cards / Interest paid",
  "Income",
  "Income / Income - Eric",
  "Misc.",
  "Misc. / Income",
  "Transfer In",
  "Transfer Out",
  "Business Expenses",
  "Business Expenses / Eric",
  "Business Expenses / Eric / Eric Kinniburgh Consulting LLC",
  "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Supplies and Materials",
  "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Revenue",
  "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Credit card payment",
];
export const tid = (name: string) => "t:" + name;
export const TAGS: SpendTag[] = TAG_NAMES.map((name) => {
  const i = name.lastIndexOf(" / ");
  return { id: tid(name), name, parentId: i < 0 ? null : tid(name.slice(0, i)) };
});

let seq = 0;
/** Reset the id counter so a describe block gets stable ids. */
export function resetSeq(n: number): void {
  seq = n;
}
export function tx(over: Omit<Partial<SpendTx>, "amount" | "tagIds"> & { amount: string; tags?: string[] }): SpendTx {
  seq += 1;
  const { amount, tags, ...rest } = over;
  return {
    id: `tx${seq}`,
    day: "2026-09-10",
    amount: D(amount),
    payee: "Payee " + seq,
    accountId: "acc-checking",
    accountNickname: "Checking",
    accountType: "checking",
    entityId: "ent-personal",
    entityName: "Personal",
    pending: false,
    transferPairId: null,
    tagIds: (tags ?? []).map((n) => (n.startsWith("t:") ? n : tid(n))),
    ...rest,
  };
}
export const out = (amount: string, ...tags: string[]) => tx({ amount: "-" + amount, tags });
export const inn = (amount: string, ...tags: string[]) => tx({ amount, tags });

// ---------------------------------------------------------------------------------------------------------------------
// September fixture

export function septemberTxs(): SpendTx[] {
  seq = 0;
  const loan = { accountId: "acc-loan", accountNickname: "Mortgage loan", accountType: "mortgage" };
  const card = { accountId: "acc-card", accountNickname: "Card", accountType: "credit_card" };
  return [
    // real spending: 18,098.39 in all
    out("4335.69", "Utilities / Mortgage"),
    out("812.40", "Food & Drink / Groceries"),
    out("582.96", "Food & Drink / Restaurants"),
    out("102.00", "Food & Drink / Farmers Market"),
    out("636.86", "Taxes / Excise"),
    out("929.65", "Travel + Vacation"),
    out("49.00", "Bank Fees"),
    out("1054.57", "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Supplies and Materials"),
    out("9507.14", "Home & Property / Repairs"),
    out("30.12"),
    out("20.00"),
    out("18.00"),
    out("20.00"),
    // refunds: 936.17
    inn("440.78", "Household Goods"),
    inn("269.07", "Travel + Vacation"),
    inn("226.32", "Household Goods"),
    // income: 17,349.23
    inn("3500.00", "Income / Income - Eric"),
    inn("3500.00", "Income / Income - Eric"),
    inn("3500.00", "Income / Income - Eric"),
    inn("3500.00", "Income / Income - Eric"),
    inn("914.74", "Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Revenue"),
    inn("2434.49", "Misc. / Income"),
    // loan account rows: +4,233.86
    tx({ amount: "3255.80", tags: ["Utilities / Mortgage"], ...loan }),
    tx({ amount: "1079.89", tags: ["Utilities / Mortgage"], ...loan }),
    tx({ amount: "-101.83", tags: ["Utilities / Mortgage"], ...loan }),
    // transfers by tag: +310.00
    inn("350.00", "Transfer In"),
    out("10.00", "Transfer Out"),
    out("10.00", "Transfer Out"),
    out("10.00", "Transfer Out"),
    out("10.00", "Transfer Out"),
    // card payments: both legs of two payments cancel, a third has no card-side leg here: -167.93
    out("520.56", "Credit Cards / Credit Card - Eric"),
    tx({ amount: "520.56", tags: ["Credit Cards / Credit card payment"], ...card }),
    out("46.26", "Credit Cards / Credit Card - Eric"),
    tx({ amount: "46.26", tags: ["Credit Cards / Credit card payment"], ...card }),
    out("167.93", "Credit Cards"),
  ];
}

export function septemberLines(): SpendLineInput[] {
  // Food & Drink is an auto-sum parent (null) over Groceries and Restaurants; the others state their own amount.
  const line = (id: string, tag: string, resolved: string, explicit: string | null, rollover = "0", accountId = "acc-checking"): SpendLineInput => ({
    id,
    tagId: tid(tag),
    accountId,
    resolved: D(resolved),
    explicit: explicit === null ? null : D(explicit),
    rollover: D(rollover),
  });
  return [
    line("L-food", "Food & Drink", "700", null),
    line("L-groc", "Food & Drink / Groceries", "400", "400"),
    line("L-rest", "Food & Drink / Restaurants", "300", "300"),
    line("L-mort", "Utilities / Mortgage", "4700", "4700"),
    line("L-repair", "Home & Property / Repairs", "200", "200"),
    line("L-ccpay", "Credit Cards / Credit card payment", "300", "300"),
  ];
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomWorld(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  // a random tag forest, up to depth 3
  const tags: SpendTag[] = [];
  const roots = 4 + Math.floor(rnd() * 3);
  for (let r = 0; r < roots; r++) {
    tags.push({ id: `r${r}`, name: `Root${r}`, parentId: null });
    const kids = Math.floor(rnd() * 3);
    for (let k = 0; k < kids; k++) {
      tags.push({ id: `r${r}k${k}`, name: `Root${r} / Kid${k}`, parentId: `r${r}` });
      if (rnd() < 0.5) tags.push({ id: `r${r}k${k}g`, name: `Root${r} / Kid${k} / Grand`, parentId: `r${r}k${k}` });
    }
  }
  // special tags so every class can occur
  tags.push({ id: "ti", name: "Transfer In", parentId: null }, { id: "cc", name: "Credit Cards", parentId: null }, { id: "inc", name: "Income", parentId: null });

  const accounts = ["a1", "a2", "a3"];
  const lines: SpendLineInput[] = [];
  const usedTags = new Set<string>();
  for (const t of tags) {
    if (["ti", "cc", "inc"].includes(t.id)) continue;
    if (rnd() < 0.55 && !usedTags.has(t.id)) {
      usedTags.add(t.id);
      const explicit = rnd() < 0.6 ? D(Math.floor(rnd() * 1000)) : null;
      lines.push({ id: `L${lines.length}`, tagId: t.id, accountId: pick(accounts), resolved: explicit ?? D(0), explicit, rollover: D(rnd() < 0.2 ? 25 : 0) });
    }
  }

  const tagIds = tags.map((t) => t.id);
  const txs: SpendTx[] = [];
  const n = 40 + Math.floor(rnd() * 80);
  for (let i = 0; i < n; i++) {
    const cents = Math.floor(rnd() * 200000) + 1;
    const sign = rnd() < 0.75 ? -1 : 1;
    const nTags = rnd() < 0.15 ? 0 : rnd() < 0.2 ? 2 : 1;
    const tg = Array.from({ length: nTags }, () => pick(tagIds));
    txs.push({
      id: `x${seed}-${i}`,
      day: "2026-09-15",
      amount: D(sign * cents).div(100),
      payee: "p",
      accountId: pick(accounts),
      accountNickname: "n",
      accountType: rnd() < 0.1 ? "mortgage" : "checking",
      entityId: "e",
      entityName: "E",
      pending: rnd() < 0.1,
      transferPairId: rnd() < 0.05 ? "pair" : null,
      tagIds: [...new Set(tg)],
    });
  }
  return { tags, lines, txs };
}

