// TESTER (independent): oracle fuzz for lib/month-spend.ts + the drill payload. The oracle below is written from the
// plan/brief, in integer cents and tag-NAME-PATH terms, and shares no code with the implementation. Every random world
// asserts the parts add up to the headline EXACTLY, class by class, line by line, and that every drill view re-adds.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { buildMonthSpend, classifyTx, currentPeriodNY, periodBounds, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData } from "@/lib/dashboard-drill-build";
import { buildDrillView, sumCountedRows, sumRowCents, type DrillTarget } from "@/lib/dashboard-drill";

// ---------------------------------------------------------------------------------------------------------------------
// tiny seeded rng
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Food & Drink",
  "Food & Drink / Groceries",
  "Food & Drink / Groceries / Farmers Market",
  "Food & Drink / Restaurants",
  "Home",
  "Home / Repairs",
  "Home / Repairs / HVAC",
  "Utilities",
  "Utilities / Mortgage",
  "Taxes",
  "Taxes / Income Tax",
  "Taxes / Excise Tax",
  "Credit Cards",
  "Credit Cards / Credit Card - Eric",
  "Credit Cards / Credit card payment",
  "Credit Cards / Interest paid",
  "Income",
  "Income / Income - Eric",
  "Misc.",
  "Misc. / Income",
  "Misc. / Digital Payments",
  "Misc. / Digital Payments / Venmo",
  "Transfer In",
  "Transfer Out",
  "Business Expenses",
  "Business Expenses / Eric",
  "Business Expenses / Eric / EKC LLC",
  "Business Expenses / Eric / EKC LLC / Supplies",
  "Business Expenses / Eric / EKC LLC / Credit card payment",
  "Business Expenses / Eric / EKC LLC / Credit card interest paid",
  "Business Expenses / Eric / EKC LLC / Revenue",
  "Business Expenses / Eric / EKC LLC / Revenue / Interest earned",
  "Arbor Retreat",
  "Arbor Retreat / Revenue",
  "Pet",
  "Pet / Health and Medical",
];
const tid = (n: string) => "T:" + n;
const TAGS: SpendTag[] = NAMES.map((n) => {
  const i = n.lastIndexOf(" / ");
  return { id: tid(n), name: n, parentId: i < 0 ? null : tid(n.slice(0, i)) };
});
const NAME_OF = new Map(TAGS.map((t) => [t.id, t.name]));

// ---------------------------------------------------------------------------------------------------------------------
// ORACLE (path based, integer cents)
type Cls = "spending" | "refund" | "income" | "own_transfer" | "card_payment" | "loan_account";
const segs = (n: string) => n.split(" / ");
const prefixes = (n: string) => segs(n).map((_, i) => segs(n).slice(0, i + 1).join(" / "));
const isTransfer = (n: string) => prefixes(n).some((p) => p === "Transfer In" || p === "Transfer Out");
function isCard(n: string): boolean {
  if (n === "Credit Cards / Interest paid") return false;
  const last = segs(n)[segs(n).length - 1]!;
  if (last.toLowerCase() === "credit card payment") return true;
  return prefixes(n).some((p) => p === "Credit Cards");
}
const isIncome = (n: string) => prefixes(n).some((p) => p === "Income" || p === "Misc. / Income") || segs(n).some((s) => s === "Revenue");
const isBusiness = (n: string) => segs(n)[0] === "Business Expenses";

const cents = (d: Decimal) => d.times(100).toNumber();

function oracleClass(tx: SpendTx): Cls {
  if (tx.transferPairId) return "own_transfer";
  if (tx.accountType === "mortgage" || tx.accountType === "loan") return "loan_account";
  const names = tx.tagIds.map((id) => NAME_OF.get(id)).filter((n): n is string => !!n);
  if (names.some(isTransfer)) return "own_transfer";
  if (names.some(isCard)) return "card_payment";
  if (names.some(isIncome)) return "income";
  return cents(tx.amount) <= 0 ? "spending" : "refund";
}

interface World {
  txs: SpendTx[];
  lines: SpendLineInput[];
}

function makeWorld(seed: number): World {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const accounts = [
    { id: "a-chk", nick: "Checking", type: "checking" },
    { id: "a-sav", nick: "Savings", type: "savings" },
    { id: "a-cc", nick: "Card", type: "credit_card" },
    { id: "a-loan", nick: "PennyMac", type: r() < 0.5 ? "mortgage" : "loan" },
  ];
  // lines: any subset of tags, one per (account, tag) -- the same tag may have lines in two accounts
  const lines: SpendLineInput[] = [];
  const bookable = TAGS.filter((t) => !["Transfer In", "Transfer Out"].includes(t.name));
  for (const t of bookable) {
    for (const acc of ["a-chk", "a-sav", "a-cc"]) {
      if (r() < 0.22) {
        const explicit = r() < 0.65 ? new Decimal(Math.floor(r() * 150000)).div(100) : null;
        lines.push({
          id: `L${lines.length}`,
          tagId: t.id,
          accountId: acc,
          resolved: explicit ?? new Decimal(Math.floor(r() * 500)),
          explicit,
          rollover: new Decimal(r() < 0.25 ? Math.floor(r() * 5000) - 2000 : 0).div(100),
        });
      }
    }
  }
  const txs: SpendTx[] = [];
  const n = 30 + Math.floor(r() * 110);
  for (let i = 0; i < n; i++) {
    const acc = pick(accounts);
    const mag = Math.floor(r() * (r() < 0.1 ? 40000000 : 300000)); // cents, sometimes huge
    const sign = r() < 0.7 ? -1 : 1;
    const nTags = r() < 0.12 ? 0 : r() < 0.18 ? 2 : r() < 0.03 ? 3 : 1;
    const tagIds: string[] = [];
    for (let k = 0; k < nTags; k++) tagIds.push(r() < 0.03 ? "T:ghost" : pick(TAGS).id);
    txs.push({
      id: `x${seed}-${i}`,
      day: "2026-09-15",
      amount: new Decimal(sign * mag).div(100),
      payee: "p" + i,
      accountId: acc.id,
      accountNickname: acc.nick,
      accountType: acc.type,
      entityId: pick(["e1", "e2"]),
      entityName: "E",
      pending: r() < 0.12,
      transferPairId: r() < 0.06 ? "pair" + i : null,
      tagIds: [...new Set(tagIds)],
    });
  }
  return { txs, lines };
}

function runOracle(w: World) {
  const byTag = new Map<string, SpendLineInput>();
  for (const l of w.lines) if (!byTag.has(l.tagId)) byTag.set(l.tagId, l); // first line per tag owns it (plan decision 6)
  const lineAt = new Map(w.lines.map((l) => [`${l.accountId}|${l.tagId}`, l]));
  const parentTagOf = (id: string) => TAGS.find((t) => t.id === id)?.parentId ?? null;

  const own = new Map<string, number>(w.lines.map((l) => [l.id, 0]));
  const buckets = new Map<string, number>();
  let untagged = 0;
  let spent = 0;
  let refunds = 0;
  let refundCount = 0;
  let pending = 0;
  let income = 0;
  let signed = 0;
  let biz = 0;
  let dup = 0;
  const excl = new Map<Cls, { n: number; sum: number }>();
  for (const tx of w.txs) {
    const c = cents(tx.amount);
    signed += c;
    const cls = oracleClass(tx);
    if (cls !== "spending" && cls !== "refund") {
      const g = excl.get(cls) ?? { n: 0, sum: 0 };
      g.n++;
      g.sum += c;
      excl.set(cls, g);
      if (cls === "income") income += c;
      continue;
    }
    const spend = -c;
    spent += spend;
    if (cls === "refund") {
      refunds += c;
      refundCount++;
    }
    if (tx.pending) pending++;
    const targets = new Set<string>();
    let business = false;
    for (const id of tx.tagIds) {
      const nm = NAME_OF.get(id);
      if (!nm) continue;
      if (isBusiness(nm)) business = true;
      // nearest budgeted ancestor-or-self
      let cur: string | null = id;
      let owner: SpendLineInput | undefined;
      while (cur) {
        owner = byTag.get(cur);
        if (owner) break;
        cur = parentTagOf(cur);
      }
      targets.add(owner ? "L:" + owner.id : "B:" + id);
    }
    if (targets.size === 0) targets.add("U");
    if (business) biz += spend;
    dup += spend * (targets.size - 1);
    for (const t of targets) {
      if (t === "U") untagged += spend;
      else if (t.startsWith("L:")) own.set(t.slice(2), own.get(t.slice(2))! + spend);
      else buckets.set(t.slice(2), (buckets.get(t.slice(2)) ?? 0) + spend);
    }
  }
  // nesting: direct parent tag's line in the SAME account
  const parent = new Map<string, string | null>();
  for (const l of w.lines) {
    const p = parentTagOf(l.tagId);
    const pl = p ? lineAt.get(`${l.accountId}|${p}`) : undefined;
    parent.set(l.id, pl && pl.id !== l.id ? pl.id : null);
  }
  const kids = new Map<string, string[]>();
  for (const [id, p] of parent) if (p) kids.set(p, [...(kids.get(p) ?? []), id]);
  const rolled = (id: string): number => own.get(id)! + (kids.get(id) ?? []).reduce((s, k) => s + rolled(k), 0);
  let parts = untagged;
  for (const l of w.lines) if (!parent.get(l.id)) parts += rolled(l.id);
  for (const v of buckets.values()) parts += v;
  return { own, parent, kids, rolled, buckets, untagged, spent, refunds, refundCount, pending, income, signed, biz, dup, excl, parts };
}

describe("tester: month-spend oracle fuzz", () => {
  it("600 random worlds: headline, classes, lines, parts all agree with the independent oracle", () => {
    const seen = { own_transfer: 0, card_payment: 0, loan_account: 0, income: 0, refund: 0, dupWorlds: 0, nonRoot: 0, ghost: 0, pendingWorlds: 0, overspent: 0 };
    for (let seed = 1; seed <= 600; seed++) {
      const w = makeWorld(seed);
      const o = runOracle(w);
      const m = buildMonthSpend(w.txs, TAGS, w.lines);

      expect(cents(m.spent), `seed ${seed} spent`).toBe(o.spent);
      expect(cents(m.refunds), `seed ${seed} refunds`).toBe(o.refunds);
      expect(m.refundCount).toBe(o.refundCount);
      expect(cents(m.income)).toBe(o.income);
      expect(cents(m.signedTotal)).toBe(o.signed);
      expect(m.pendingCount, `seed ${seed} pending`).toBe(o.pending);
      expect(cents(m.businessTaggedSpend), `seed ${seed} biz`).toBe(o.biz);
      expect(cents(m.duplicateAdjustment), `seed ${seed} dup`).toBe(o.dup);
      expect(cents(m.untagged.spend)).toBe(o.untagged);
      expect(m.txCount).toBe(w.txs.length);
      // per-class (count and signed sum), and no class missing or extra
      expect(m.excluded.map((g) => g.cls).sort()).toEqual([...o.excl.keys()].sort());
      for (const g of m.excluded) {
        expect(g.count).toBe(o.excl.get(g.cls)!.n);
        expect(cents(g.sum), `seed ${seed} ${g.cls}`).toBe(o.excl.get(g.cls)!.sum);
        expect(g.txIds.length).toBe(g.count);
        seen[g.cls as "own_transfer" | "card_payment" | "loan_account" | "income"]++;
      }
      if (m.refundCount > 0) seen.refund++;
      // per-tx verdict class equals the oracle's, and classifyTx agrees with the verdict
      const tagById = new Map(TAGS.map((t) => [t.id, t]));
      for (const tx of w.txs) {
        expect(m.verdicts.get(tx.id)!.cls, `seed ${seed} ${tx.id}`).toBe(oracleClass(tx));
        expect(classifyTx(tx, tagById).cls).toBe(oracleClass(tx));
      }
      // lines
      for (const l of m.lines) {
        expect(cents(l.ownSpend), `seed ${seed} own ${l.id}`).toBe(o.own.get(l.id));
        expect(cents(l.rolledSpend), `seed ${seed} rolled ${l.id}`).toBe(o.rolled(l.id));
        expect(l.parentLineId).toBe(o.parent.get(l.id));
        const input = w.lines.find((x) => x.id === l.id)!;
        const hasKids = (o.kids.get(l.id) ?? []).length > 0;
        const over = o.rolled(l.id) - cents(input.resolved.plus(input.rollover));
        const counts = (!hasKids || input.explicit !== null) && over > 0;
        expect(l.countsAsOverspent, `seed ${seed} overspent ${l.id}`).toBe(counts);
        if (counts) seen.overspent++;
        if (l.parentLineId) seen.nonRoot++;
      }
      // notInAnyLine per tag
      expect(m.notInAnyLine.length).toBe(o.buckets.size);
      for (const b of m.notInAnyLine) expect(cents(b.spend)).toBe(o.buckets.get(b.tagId));
      // THE invariant: the parts add up to the headline, exactly
      expect(o.parts - o.dup, `oracle parts seed ${seed}`).toBe(o.spent);
      expect(m.reconciles, `reconciles seed ${seed}`).toBe(true);
      let modelParts = m.untagged.spend;
      for (const id of m.rootLineIds) modelParts = modelParts.plus(m.lines.find((l) => l.id === id)!.rolledSpend);
      for (const b of m.notInAnyLine) modelParts = modelParts.plus(b.spend);
      expect(modelParts.minus(m.duplicateAdjustment).equals(m.spent)).toBe(true);
      // outflows - refunds == spent
      expect(m.outflows.minus(m.refunds).equals(m.spent)).toBe(true);
      if (o.dup !== 0) seen.dupWorlds++;
      if (m.pendingCount > 0) seen.pendingWorlds++;
      if (w.txs.some((t) => t.tagIds.includes("T:ghost"))) seen.ghost++;
    }
    // branch coverage guard: the fuzz must really have exercised each path
    for (const [k, v] of Object.entries(seen)) expect(v, `branch ${k} exercised`).toBeGreaterThan(50);
  });

  it("every tx sits in exactly one class, and class sums + spent parts re-add to the signed total", () => {
    for (let seed = 1000; seed < 1200; seed++) {
      const w = makeWorld(seed);
      const m = buildMonthSpend(w.txs, TAGS, w.lines);
      const exclSum = m.excluded.reduce((s, g) => s.plus(g.sum), new Decimal(0));
      // signed total = excluded signed + (refunds - outflows) = excluded - spent
      expect(m.signedTotal.equals(exclSum.minus(m.spent)), `seed ${seed}`).toBe(true);
      expect(m.verdicts.size).toBe(w.txs.length);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("tester: named classification cases from the brief", () => {
  const tagById = new Map(TAGS.map((t) => [t.id, t]));
  let n = 0;
  const mk = (amount: string, tags: string[], over: Partial<SpendTx> = {}): SpendTx => ({
    id: "c" + ++n,
    day: "2026-09-10",
    amount: new Decimal(amount),
    payee: "x",
    accountId: "a-chk",
    accountNickname: "Checking",
    accountType: "checking",
    entityId: "e",
    entityName: "E",
    pending: false,
    transferPairId: null,
    tagIds: tags.map(tid),
    ...over,
  });
  const cls = (t: SpendTx) => classifyTx(t, tagById).cls;

  it("tags ending 'Credit card payment' are card payments (any depth, any case); 'Credit Cards / Interest paid' is spending", () => {
    expect(cls(mk("-50", ["Credit Cards / Credit card payment"]))).toBe("card_payment");
    expect(cls(mk("50", ["Credit Cards / Credit card payment"]))).toBe("card_payment");
    expect(cls(mk("-50", ["Credit Cards / Credit Card - Eric"]))).toBe("card_payment");
    expect(cls(mk("-50", ["Credit Cards"]))).toBe("card_payment");
    expect(cls(mk("-50", ["Business Expenses / Eric / EKC LLC / Credit card payment"]))).toBe("card_payment");
    expect(cls(mk("-12", ["Credit Cards / Interest paid"]))).toBe("spending");
    expect(cls(mk("-12", ["Business Expenses / Eric / EKC LLC / Credit card interest paid"]))).toBe("spending");
    // an interest charge tagged together with a payment tag is still a card payment (any tag decides)
    expect(cls(mk("-12", ["Credit Cards / Interest paid", "Credit Cards / Credit card payment"]))).toBe("card_payment");
  });

  it("income, transfers, loan rows, pairs; precedence pair > loan > transfer > card > income", () => {
    expect(cls(mk("100", ["Income / Income - Eric"]))).toBe("income");
    expect(cls(mk("100", ["Business Expenses / Eric / EKC LLC / Revenue / Interest earned"]))).toBe("income");
    expect(cls(mk("100", ["Arbor Retreat / Revenue"]))).toBe("income");
    expect(cls(mk("-100", ["Taxes / Income Tax"]))).toBe("spending"); // contains the word Income but is a cost
    expect(cls(mk("100", ["Transfer In"]))).toBe("own_transfer");
    expect(cls(mk("-100", ["Transfer Out"]))).toBe("own_transfer");
    expect(cls(mk("-100", ["Food & Drink"], { transferPairId: "p" }))).toBe("own_transfer");
    expect(cls(mk("100", ["Utilities / Mortgage"], { accountType: "mortgage" }))).toBe("loan_account");
    expect(cls(mk("-100", ["Transfer Out"], { accountType: "loan" }))).toBe("loan_account");
    expect(cls(mk("-100", ["Transfer Out", "Income"]))).toBe("own_transfer");
    expect(cls(mk("-100", ["Credit Cards", "Income"]))).toBe("card_payment");
  });

  it("untagged inflow is a refund, untagged outflow is spending, zero is spending, unknown tag id is untagged", () => {
    expect(cls(mk("25.00", []))).toBe("refund");
    expect(cls(mk("-25.00", []))).toBe("spending");
    expect(cls(mk("0.00", []))).toBe("spending");
    const m = buildMonthSpend([mk("-10", ["ghost-tag-id".replace(/^/, "")])], TAGS, []);
    expect(m.untagged.spend.toFixed(2)).toBe("10.00");
    expect(m.reconciles).toBe(true);
  });

  it("PennyMac mirror rows are loan-account rows; the cash payment lands on the Mortgage line; cents exact", () => {
    const loan = { accountId: "a-loan", accountNickname: "PennyMac", accountType: "mortgage" };
    const txs = [
      mk("-4335.69", ["Utilities / Mortgage"]),
      mk("3255.80", ["Utilities / Mortgage"], loan),
      mk("1079.89", ["Utilities / Mortgage"], loan),
      mk("-101.83", ["Utilities / Mortgage"], loan),
    ];
    const line: SpendLineInput = { id: "Lm", tagId: tid("Utilities / Mortgage"), accountId: "a-chk", resolved: new Decimal(4700), explicit: new Decimal(4700), rollover: new Decimal(0) };
    const m = buildMonthSpend(txs, TAGS, [line]);
    expect(m.spent.toFixed(2)).toBe("4335.69");
    expect(m.lines[0]!.rolledSpend.toFixed(2)).toBe("4335.69");
    expect(m.excluded.find((g) => g.cls === "loan_account")!.sum.toFixed(2)).toBe("4233.86");
    expect(m.reconciles).toBe(true);
  });

  it("business-tagged spend stays counted where paid (in its line / bucket) and is only labelled", () => {
    const biz = tid("Business Expenses / Eric / EKC LLC / Supplies");
    const t = mk("-1054.57", ["Business Expenses / Eric / EKC LLC / Supplies"]);
    const m = buildMonthSpend([t, mk("-10", ["Pet"])], TAGS, []);
    expect(m.spent.toFixed(2)).toBe("1064.57");
    expect(m.businessTaggedSpend.toFixed(2)).toBe("1054.57");
    expect(m.notInAnyLine.find((b) => b.tagId === biz)!.spend.toFixed(2)).toBe("1054.57");
    // a business line that exists as an ANCESTOR claims it (nearest budgeted ancestor)
    const parentLine: SpendLineInput = { id: "Lb", tagId: tid("Business Expenses"), accountId: "a-chk", resolved: new Decimal(150), explicit: new Decimal(150), rollover: new Decimal(0) };
    const m2 = buildMonthSpend([t], TAGS, [parentLine]);
    expect(m2.lines[0]!.rolledSpend.toFixed(2)).toBe("1054.57");
    expect(m2.lines[0]!.countsAsOverspent).toBe(true);
    expect(m2.businessTaggedSpend.toFixed(2)).toBe("1054.57");
  });

  it("a multi-tag transaction counts once in the headline, is listed under each target, and the correction is exact", () => {
    const t = mk("-100.00", ["Food & Drink / Restaurants", "Pet"]);
    const m = buildMonthSpend([t], TAGS, []);
    expect(m.spent.toFixed(2)).toBe("100.00");
    expect(m.notInAnyLine.length).toBe(2);
    expect(m.duplicateAdjustment.toFixed(2)).toBe("100.00");
    expect(m.reconciles).toBe(true);
    // two tags that resolve to the SAME line count once there (no correction)
    const l: SpendLineInput = { id: "Lf", tagId: tid("Food & Drink"), accountId: "a-chk", resolved: new Decimal(10), explicit: new Decimal(10), rollover: new Decimal(0) };
    const m2 = buildMonthSpend([mk("-100.00", ["Food & Drink / Restaurants", "Food & Drink / Groceries"])], TAGS, [l]);
    expect(m2.duplicateAdjustment.toFixed(2)).toBe("0.00");
    expect(m2.lines[0]!.rolledSpend.toFixed(2)).toBe("100.00");
  });

  it("pending rows count in Spent and are disclosed; a pending excluded row is not counted as pending", () => {
    const m = buildMonthSpend(
      [mk("-10", ["Pet"], { pending: true }), mk("5", [], { pending: true }), mk("-99", ["Credit Cards"], { pending: true }), mk("-1", ["Pet"])],
      TAGS,
      []
    );
    expect(m.spent.toFixed(2)).toBe("6.00");
    expect(m.pendingCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("tester: month boundaries (UTC midnight) and the New York evening edge", () => {
  it("periodBounds is [first of month 00:00Z, first of next 00:00Z), across Dec/Jan and leap February", () => {
    expect(periodBounds("2026-09")).toEqual({ start: new Date("2026-09-01T00:00:00.000Z"), end: new Date("2026-10-01T00:00:00.000Z") });
    expect(periodBounds("2026-12").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(periodBounds("2028-02").end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
    const { start, end } = periodBounds("2026-09");
    const inRange = (iso: string) => new Date(iso) >= start && new Date(iso) < end;
    expect(inRange("2026-09-01T00:00:00.000Z")).toBe(true);
    expect(inRange("2026-08-31T23:59:59.999Z")).toBe(false);
    expect(inRange("2026-09-30T23:59:59.999Z")).toBe(true);
    expect(inRange("2026-10-01T00:00:00.000Z")).toBe(false);
  });

  // independent oracle for America/New_York: US DST starts 2nd Sunday of March 02:00 local (07:00Z), ends 1st Sunday of
  // November 02:00 local (06:00Z).
  function nthSunday(year: number, month0: number, nth: number): number {
    const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (nth - 1);
  }
  function oracleNY(now: Date): string {
    const y = now.getUTCFullYear();
    const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7, 0, 0);
    const dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6, 0, 0);
    const offsetH = now.getTime() >= dstStart && now.getTime() < dstEnd ? -4 : -5;
    const local = new Date(now.getTime() + offsetH * 3600_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  it("currentPeriodNY: the last evening in New York is still the old month, in summer and winter", () => {
    expect(currentPeriodNY(new Date("2026-10-01T03:59:59Z"))).toBe("2026-09"); // 23:59:59 EDT Sep 30
    expect(currentPeriodNY(new Date("2026-10-01T04:00:00Z"))).toBe("2026-10");
    expect(currentPeriodNY(new Date("2026-12-01T04:59:59Z"))).toBe("2026-11"); // EST
    expect(currentPeriodNY(new Date("2026-12-01T05:00:00Z"))).toBe("2026-12");
    expect(currentPeriodNY(new Date("2027-01-01T04:59:59Z"))).toBe("2026-12"); // year edge
    expect(currentPeriodNY(new Date("2027-01-01T05:00:00Z"))).toBe("2027-01");
    expect(currentPeriodNY(new Date("2028-03-01T04:59:59Z"))).toBe("2028-02"); // leap
    expect(currentPeriodNY(new Date("2026-09-30T20:00:00Z"))).toBe("2026-09"); // 4 PM NY on the 30th
  });

  it("currentPeriodNY matches an independent DST oracle on 4000 random instants and every month edge +-1 s", () => {
    const r = rng(7);
    for (let i = 0; i < 4000; i++) {
      const t = new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 7 * 365 * 86400_000));
      expect(currentPeriodNY(t), t.toISOString()).toBe(oracleNY(t));
    }
    for (let y = 2025; y <= 2029; y++) {
      for (let m = 0; m < 12; m++) {
        for (const off of [-1000, 0, 1000]) {
          for (const hours of [4, 5]) {
            const t = new Date(Date.UTC(y, m, 1, hours, 0, 0) + off);
            expect(currentPeriodNY(t), t.toISOString()).toBe(oracleNY(t));
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The full pipeline: real resolveEffectiveBudgets -> buildMonthSpend -> buildDrillData -> buildDrillView
describe("tester: drill payload fuzz (every view re-adds; rows + exclusions cover every transaction)", () => {
  function oracleBudget(lines: { id: string; tagId: string; accountId: string; budgeted: Decimal | null }[], recurring: Map<string, number>, add: Map<string, number>) {
    const parentTag = (id: string) => TAGS.find((t) => t.id === id)?.parentId ?? null;
    const byAcc = new Map<string, typeof lines>();
    for (const l of lines) byAcc.set(l.accountId, [...(byAcc.get(l.accountId) ?? []), l]);
    let total = 0;
    for (const group of byAcc.values()) {
      const tagSet = new Set(group.map((l) => l.tagId));
      const val = (l: (typeof group)[number]): number => {
        if (recurring.has(l.tagId)) return (add.get(l.id) ?? 0) + recurring.get(l.tagId)!;
        if (l.budgeted !== null) return cents(l.budgeted);
        return group.filter((k) => parentTag(k.tagId) === l.tagId).reduce((s, k) => s + val(k), 0);
      };
      for (const l of group) {
        const p = parentTag(l.tagId);
        if (!(p && tagSet.has(p))) total += val(l);
      }
    }
    return total;
  }

  it("300 random worlds", () => {
    for (let seed = 2000; seed < 2300; seed++) {
      const w = makeWorld(seed);
      const r = rng(seed * 3);
      const parent = new Map(TAGS.map((t) => [t.id, t.parentId]));
      // budget rows (budgeted from the world's explicit; recurring link on one random tag)
      const budgets = w.lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, budgeted: l.explicit }));
      const recTag = budgets.length > 0 && r() < 0.5 ? budgets[Math.floor(r() * budgets.length)]!.tagId : null;
      const recurring = recTag ? [{ tagId: recTag, amountCents: 2800, frequency: "monthly" }] : [];
      const eff = resolveEffectiveBudgets(
        budgets.map((b) => ({ ...b, additionalAmountCents: new Decimal(0) })),
        recurring,
        (id) => parent.get(id)
      );
      const lines: SpendLineInput[] = w.lines.map((l) => ({ ...l, resolved: eff.resolvedById.get(l.id)!, explicit: eff.explicitById.get(l.id) ?? null }));
      const model = buildMonthSpend(w.txs, TAGS, lines);
      const accNames: Record<string, string> = { "a-chk": "Checking", "a-sav": "Savings", "a-cc": "Card" };
      const drill = buildDrillData({
        model,
        txs: w.txs,
        tags: TAGS.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! })),
        budgets: w.lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, accountName: accNames[l.accountId]!, rawBudgeted: l.explicit, rollover: l.rollover })),
        effective: eff,
        accounts: Object.entries(accNames).map(([id, nickname]) => ({ id, nickname, institutionName: "Bank", accountType: "checking", currentBalance: null, currentBalanceAt: null })),
        transfers: [],
        period: "2026-09",
        periodLabel: "September 2026",
        bucket: "personal",
        isAllEntities: false,
        periodQuery: "",
      });

      // independent Total Budgeted (own recursion, own recurring arithmetic)
      const recMap = new Map<string, number>(recTag ? [[recTag, 2800]] : []);
      expect(drill.totalBudgetedCents, `seed ${seed} total budgeted`).toBe(oracleBudget(budgets, recMap, new Map()));
      // page total counts ROOT lines only: the groups' budget sums add up to it
      expect(drill.groups.reduce((s, g) => s + g.budgetCents, 0)).toBe(drill.totalBudgetedCents);
      // the same for spend: the groups' root spend + outside-lines + untagged - dup = spent
      const rootSpend = drill.groups.reduce((s, g) => s + g.spentCents, 0);
      const outside = drill.notInLine.reduce((s, b) => s + b.cents, 0);
      expect(rootSpend + outside + drill.untagged.cents - drill.duplicateCents, `seed ${seed} payload parts`).toBe(drill.spentCents);

      const targets: DrillTarget[] = [{ kind: "spent" }, { kind: "budgeted" }, { kind: "overspent" }, ...drill.lines.map((l) => ({ kind: "line" as const, lineId: l.id }))];
      for (const t of targets) {
        const v = buildDrillView(drill, t);
        expect(v.expected, `${seed} ${t.kind}`).not.toBeNull();
        expect(sumCountedRows(v), `seed ${seed} ${t.kind} ${"lineId" in t ? t.lineId : ""}`).toBe(v.expected!.cents);
        expect(v.headline.cents).toBe(v.expected!.cents);
      }
      // spent view: coverage of every transaction, exactly once per target, excluded exactly once, never both
      const sv = buildDrillView(drill, { kind: "spent" });
      const inSections = new Map<string, number>();
      for (const s of sv.sections) for (const row of s.rows) if (row.txId) inSections.set(row.txId, (inSections.get(row.txId) ?? 0) + 1);
      const inExcluded = new Map<string, number>();
      for (const s of sv.excludedSections) {
        expect(s.rows.every((row) => row.counts === false)).toBe(true); // context only, never added
        for (const row of s.rows) if (row.txId) inExcluded.set(row.txId, (inExcluded.get(row.txId) ?? 0) + 1);
        expect(s.subtotalCents).toBe(model.excluded.find((g) => `excluded:${g.cls}` === s.key)!.sum.times(100).toNumber());
      }
      for (const tx of w.txs) {
        const verdict = model.verdicts.get(tx.id)!;
        if (verdict.cls === "spending" || verdict.cls === "refund") {
          expect(inSections.get(tx.id), `seed ${seed} ${tx.id} in spent`).toBe(verdict.targets.length);
          expect(inExcluded.has(tx.id)).toBe(false);
        } else {
          expect(inExcluded.get(tx.id), `seed ${seed} ${tx.id} excluded`).toBe(1);
          expect(inSections.has(tx.id)).toBe(false);
        }
      }
      // account views: rows are every tx on the account, sum = net activity as recorded
      for (const a of drill.accounts) {
        const v = buildDrillView(drill, { kind: "account", accountId: a.id });
        const expected = w.txs.filter((t) => t.accountId === a.id).reduce((s, t) => s + cents(t.amount), 0);
        expect(sumRowCents(v), `seed ${seed} account ${a.id}`).toBe(expected);
        expect(v.sections[0]!.rows.length).toBe(w.txs.filter((t) => t.accountId === a.id).length);
      }
      // overspent headline = lines flagged by the model
      expect(drill.overspentCount).toBe(model.lines.filter((l) => l.countsAsOverspent).length);

      // payload fidelity per line: what the table shows (budget incl. rollover, spent, remaining) is the model's figure
      const o = runOracle(w);
      for (const dl of drill.lines) {
        const ml = model.lines.find((l) => l.id === dl.id)!;
        const input = lines.find((l) => l.id === dl.id)!;
        expect(dl.budgetCents, `seed ${seed} budget ${dl.id}`).toBe(cents(input.resolved));
        expect(dl.rolloverCents).toBe(cents(input.rollover));
        expect(dl.effectiveCents, `seed ${seed} effective ${dl.id}`).toBe(cents(ml.effectiveBudget));
        expect(dl.ownCents).toBe(o.own.get(dl.id));
        expect(dl.rolledCents).toBe(o.rolled(dl.id));
        expect(dl.remainingCents).toBe(dl.effectiveCents - dl.rolledCents);
        expect(dl.overspent).toBe(dl.remainingCents < 0);
        expect(dl.overByCents).toBe(cents(ml.overBy));
        expect(dl.hasChildren).toBe((o.kids.get(dl.id) ?? []).length > 0);
        expect(dl.childIds.slice().sort()).toEqual((o.kids.get(dl.id) ?? []).slice().sort());
      }
      // spent view: each line section's subtotal is the rolled (parent) or own (leaf) figure and its rows add up to the
      // line's OWN spend; the multi-tag correction row appears exactly when the correction is non-zero, with the sign
      // that makes the sections add up.
      for (const s of sv.sections) {
        if (!s.key.startsWith("line:")) continue;
        const dl = drill.lines.find((l) => `line:${l.id}` === s.key)!;
        expect(s.subtotalCents, `seed ${seed} ${s.key}`).toBe(dl.hasChildren ? dl.rolledCents : dl.ownCents);
        expect(s.rows.reduce((a, row) => a + row.cents, 0)).toBe(dl.ownCents);
      }
      const dupSection = sv.sections.find((s) => s.key === "duplicates");
      expect(!!dupSection).toBe(drill.duplicateCents !== 0);
      if (dupSection) expect(dupSection.subtotalCents).toBe(-drill.duplicateCents);
      // budgeted view: per-account subtotal = sum of its counted (top-level) rows
      const bv = buildDrillView(drill, { kind: "budgeted" });
      for (const s of bv.sections) {
        expect(s.rows.filter((row) => row.counts).reduce((a, row) => a + row.cents, 0)).toBe(s.subtotalCents);
      }
    }
  });
});
