// TESTER (independent, re-test of the "own-account transfer by statement mask" rule): oracle fuzz inside reconciliation
// worlds, the real mask loader over a db fake that honours `archivedAt: null`, payload privacy, pair-forms-later,
// pending == posted. The oracle is path based and written from the brief; it shares no code with lib/month-spend.ts.
import { describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const db = vi.hoisted(() => ({
  accounts: [] as { id: string; mask: string | null; archivedAt: Date | null }[],
  calls: [] as unknown[],
}));
vi.mock("@/lib/db", () => ({
  db: {
    account: {
      findMany: async (arg: { where?: { archivedAt?: null }; select?: Record<string, boolean> }) => {
        db.calls.push(arg);
        const rows = db.accounts.filter((a) => (arg.where?.archivedAt === null ? a.archivedAt === null : true));
        // honour select: only the selected keys come back
        return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => arg.select?.[k])));
      },
    },
  },
}));

import { buildMonthSpend, classifyTx, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { loadOwnAccountByMask } from "@/lib/own-account-masks-build";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData, displayPayee } from "@/lib/dashboard-drill-build";
import { buildDrillView, sumCountedRows } from "@/lib/dashboard-drill";

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
  "Home",
  "Home / Repairs",
  "Utilities",
  "Utilities / Mortgage",
  "Credit Cards",
  "Credit Cards / Credit card payment",
  "Credit Cards / Interest paid",
  "Income",
  "Income / Income - Eric",
  "Transfer In",
  "Transfer Out",
  "Business Expenses",
  "Business Expenses / Eric",
  "Pet",
];
const tid = (n: string) => "T:" + n;
const TAGS: SpendTag[] = NAMES.map((n) => {
  const i = n.lastIndexOf(" / ");
  return { id: tid(n), name: n, parentId: i < 0 ? null : tid(n.slice(0, i)) };
});
const NAME_OF = new Map(TAGS.map((t) => [t.id, t.name]));

const segs = (n: string) => n.split(" / ");
const prefixes = (n: string) => segs(n).map((_, i) => segs(n).slice(0, i + 1).join(" / "));
const isTransferTag = (n: string) => prefixes(n).some((p) => p === "Transfer In" || p === "Transfer Out");
const isCardTag = (n: string) => (n === "Credit Cards / Interest paid" ? false : segs(n).at(-1)!.toLowerCase() === "credit card payment" || prefixes(n).some((p) => p === "Credit Cards"));
const isIncomeTag = (n: string) => prefixes(n).some((p) => p === "Income" || p === "Misc. / Income") || segs(n).some((s) => s === "Revenue");
const cents = (d: Decimal) => d.times(100).toNumber();

type Acct = { id: string; nick: string; type: string; mask: string | null; archived: boolean };

function makeAccounts(r: () => number): Acct[] {
  return [
    { id: "a-chk", nick: "Primary Checking", type: "checking", mask: "1111", archived: false },
    { id: "a-sav", nick: "Slush Funds", type: "checking", mask: "2222", archived: false },
    { id: "a-cc", nick: "Barclay", type: "credit_card", mask: "3333", archived: false },
    { id: "a-loan", nick: "PennyMac", type: r() < 0.5 ? "mortgage" : "loan", mask: "4444", archived: false },
    { id: "a-arch", nick: "Old Savings", type: "savings", mask: "5555", archived: true },
    { id: "a-dup1", nick: "Dup One", type: "checking", mask: "6666", archived: false },
    { id: "a-dup2", nick: "Dup Two", type: "checking", mask: "6666", archived: false },
    { id: "a-none", nick: "No Mask", type: "checking", mask: null, archived: false },
  ];
}

// independent oracle for the mask map: a mask counts only when exactly ONE active account carries it
function oracleMap(accts: Acct[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of accts) {
    if (!a.mask || a.archived) continue;
    const holders = accts.filter((b) => !b.archived && b.mask === a.mask);
    if (holders.length === 1) out.set(a.mask, a.id);
  }
  return out;
}

const LEG_RE = /^Online Xfer Transfer (to|from) [A-Z]{2} x(\d{4})$/;

function payeeFor(r: () => number): { payee: string; kind: string } {
  const masks = ["1111", "2222", "3333", "4444", "5555", "6666", "7777", "9999"];
  const mask = masks[Math.floor(r() * masks.length)]!;
  const dir = r() < 0.7 ? "to" : "from";
  const roll = r();
  if (roll < 0.4) return { payee: `Online Xfer Transfer ${dir} CK x${mask}`, kind: "leg" };
  if (roll < 0.5) return { payee: `Online Xfer Transfer ${dir} SV x${mask}`, kind: "leg" };
  const near = [
    `Online  Xfer Transfer ${dir} CK x${mask}`, // historical double space: now a recognised leg (the oracle collapses whitespace)
    `online xfer transfer ${dir} CK x${mask}`,
    `Online Xfer Transfer ${dir} CK x${mask.slice(0, 3)}`,
    `Online Xfer Transfer ${dir} CK x${mask} extra`,
    `Online Xfer Transfer ${dir} ck x${mask}`,
    `Online Xfer Transfer ${dir} CKS x${mask}`,
    `Online Xfer Transfers ${dir} CK x${mask}`,
    `Online Xfer Transfer CK x${mask}`,
    `PAYPAL INST XFER`,
    `Venmo Transfer to CK x${mask}`,
  ];
  if (roll < 0.62) return { payee: near[Math.floor(r() * near.length)]!, kind: "near" };
  return { payee: "Merchant " + Math.floor(r() * 50), kind: "plain" };
}

interface World {
  accts: Acct[];
  txs: SpendTx[];
  lines: SpendLineInput[];
  kinds: Map<string, string>;
}
function makeWorld(seed: number): World {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const accts = makeAccounts(r);
  const lines: SpendLineInput[] = [];
  for (const t of TAGS) {
    if (["Transfer In", "Transfer Out"].includes(t.name)) continue;
    if (r() < 0.4) {
      const explicit = r() < 0.7 ? new Decimal(Math.floor(r() * 100000)).div(100) : null;
      lines.push({ id: `L${lines.length}`, tagId: t.id, accountId: pick(accts).id, resolved: explicit ?? new Decimal(0), explicit, rollover: new Decimal(0) });
    }
  }
  // unique (account, tag) like the DB
  const seen = new Set<string>();
  const uniq = lines.filter((l) => (seen.has(l.accountId + l.tagId) ? false : (seen.add(l.accountId + l.tagId), true)));
  const txs: SpendTx[] = [];
  const kinds = new Map<string, string>();
  const n = 40 + Math.floor(r() * 80);
  for (let i = 0; i < n; i++) {
    const acct = pick(accts);
    const { payee, kind } = payeeFor(r);
    const nTags = r() < 0.5 ? 0 : r() < 0.2 ? 2 : 1;
    const tagIds = [...new Set(Array.from({ length: nTags }, () => pick(TAGS).id))];
    const cts = Math.floor(r() * 250000);
    const id = `x${seed}-${i}`;
    kinds.set(id, kind);
    txs.push({
      id,
      day: "2026-10-09",
      amount: new Decimal((r() < 0.78 ? -1 : 1) * cts).div(100),
      payee,
      accountId: acct.id,
      accountNickname: acct.nick,
      accountType: acct.type,
      entityId: "e",
      entityName: "E",
      pending: r() < 0.3,
      transferPairId: r() < 0.05 ? "pair" + i : null,
      tagIds,
    });
  }
  return { accts, txs, lines: uniq, kinds };
}

type Cls = "spending" | "refund" | "income" | "own_transfer" | "card_payment" | "loan_account";
function oracleClass(tx: SpendTx, map: Map<string, string>): Cls {
  if (tx.transferPairId) return "own_transfer";
  if (tx.accountType === "mortgage" || tx.accountType === "loan") return "loan_account";
  const names = tx.tagIds.map((id) => NAME_OF.get(id)).filter((n): n is string => !!n);
  if (names.some(isTransferTag)) return "own_transfer";
  const m = LEG_RE.exec(tx.payee.replace(/\s+/g, " ").trim());
  if (m) {
    const cp = map.get(m[2]!);
    if (cp && cp !== tx.accountId) return "own_transfer";
  }
  if (names.some(isCardTag)) return "card_payment";
  if (names.some(isIncomeTag)) return "income";
  return cents(tx.amount) <= 0 ? "spending" : "refund";
}

async function mapFor(accts: Acct[]): Promise<Map<string, string>> {
  db.accounts = accts.map((a) => ({ id: a.id, mask: a.mask, archivedAt: a.archived ? new Date("2026-01-01") : null }));
  return loadOwnAccountByMask();
}

describe("tester: own-account transfer rule, oracle fuzz in reconciliation worlds", () => {
  it("500 worlds: real loader == independent mask oracle; class, Spent, parts and drill views all agree", async () => {
    const seen = { maskOwn: 0, unknown: 0, archived: 0, shared: 0, self: 0, near: 0, pairWithMask: 0, tagAndMask: 0, inflowLeg: 0, pendingLeg: 0, postedLeg: 0 };
    for (let seed = 1; seed <= 500; seed++) {
      const w = makeWorld(seed);
      const map = await mapFor(w.accts);
      const om = oracleMap(w.accts);
      expect([...map.entries()].sort(), `seed ${seed} mask map`).toEqual([...om.entries()].sort());

      const model = buildMonthSpend(w.txs, TAGS, w.lines.map((l) => ({ ...l })), { ownAccountByMask: map });
      let spent = 0;
      for (const tx of w.txs) {
        const cls = oracleClass(tx, om);
        expect(model.verdicts.get(tx.id)!.cls, `seed ${seed} ${tx.id} ${tx.payee}`).toBe(cls);
        if (cls === "spending" || cls === "refund") spent += -cents(tx.amount);
        // branch accounting
        const m = LEG_RE.exec(tx.payee.replace(/\s+/g, " ").trim());
        if (m && !tx.transferPairId && tx.accountType !== "mortgage" && tx.accountType !== "loan") {
          const hasTransferTag = tx.tagIds.some((id) => isTransferTag(NAME_OF.get(id)!));
          const mk = m[2]!;
          const holder = w.accts.find((a) => a.mask === mk);
          if (om.get(mk) && om.get(mk) !== tx.accountId) {
            seen.maskOwn++;
            if (m[1] === "from") seen.inflowLeg++;
            if (tx.pending) seen.pendingLeg++;
            else seen.postedLeg++;
            if (hasTransferTag) seen.tagAndMask++;
          } else if (om.get(mk) === tx.accountId) seen.self++;
          else if (holder?.archived) seen.archived++;
          else if (mk === "6666") seen.shared++;
          else seen.unknown++;
        }
        if (m && tx.transferPairId) seen.pairWithMask++;
        if (w.kinds.get(tx.id) === "near") seen.near++;
      }
      expect(cents(model.spent), `seed ${seed} spent`).toBe(spent);
      expect(model.reconciles, `seed ${seed} reconciles`).toBe(true);
      expect(model.verdicts.size).toBe(w.txs.length);

      // pending and posted are treated the same
      const flipped = w.txs.map((t) => ({ ...t, pending: !t.pending }));
      const m2 = buildMonthSpend(flipped, TAGS, w.lines.map((l) => ({ ...l })), { ownAccountByMask: map });
      expect(m2.spent.equals(model.spent), `seed ${seed} pending flip`).toBe(true);
      for (const t of w.txs) expect(m2.verdicts.get(t.id)!.cls).toBe(model.verdicts.get(t.id)!.cls);

      // a pair that forms later: the row keeps ONE class ("Paired transfer"), Spent is unchanged by the pairing
      const paired = w.txs.map((t) => (model.verdicts.get(t.id)!.cls === "own_transfer" && !t.transferPairId ? { ...t, transferPairId: "p-" + t.id } : t));
      const m3 = buildMonthSpend(paired, TAGS, w.lines.map((l) => ({ ...l })), { ownAccountByMask: map });
      expect(m3.spent.equals(model.spent), `seed ${seed} pair formed later`).toBe(true);
      for (const t of paired) {
        const v3 = m3.verdicts.get(t.id)!;
        if (t.transferPairId && model.verdicts.get(t.id)!.cls === "own_transfer") {
          expect(v3.cls).toBe("own_transfer");
          expect(v3.reason).toBe("Paired transfer between your own accounts");
        }
      }
      const g1 = model.excluded.find((g) => g.cls === "own_transfer");
      const g3 = m3.excluded.find((g) => g.cls === "own_transfer");
      expect(g3?.count ?? 0).toBe(g1?.count ?? 0); // no row is counted twice or dropped
      expect((g3?.sum ?? new Decimal(0)).equals(g1?.sum ?? new Decimal(0))).toBe(true);

      // without a map the rule is OFF (opt-in), the legacy classes are untouched
      const off = buildMonthSpend(w.txs, TAGS, w.lines.map((l) => ({ ...l })));
      for (const t of w.txs) {
        const legacy = oracleClass(t, new Map());
        expect(off.verdicts.get(t.id)!.cls).toBe(legacy);
      }
      expect(off.reconciles).toBe(true);
      // the rule only ever moves a row OUT of spending/refund into own_transfer, never anywhere else
      for (const t of w.txs) {
        const a = off.verdicts.get(t.id)!.cls;
        const b = model.verdicts.get(t.id)!.cls;
        if (a !== b) {
          expect(["spending", "refund", "card_payment", "income"]).toContain(a);
          expect(b).toBe("own_transfer");
        }
      }

      // drill payload: every view re-adds; no statement mask leaves the server for a recognised transfer label
      if (seed % 5 === 0) {
        const parent = new Map(TAGS.map((t) => [t.id, t.parentId]));
        const eff = resolveEffectiveBudgets(w.lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, budgeted: l.explicit })), [], (id) => parent.get(id));
        const lines = w.lines.map((l) => ({ ...l, resolved: eff.resolvedById.get(l.id)!, explicit: eff.explicitById.get(l.id) ?? null }));
        const model2 = buildMonthSpend(w.txs, TAGS, lines, { ownAccountByMask: map });
        const drill = buildDrillData({
          model: model2,
          txs: w.txs,
          tags: TAGS.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! })),
          budgets: lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, accountName: w.accts.find((a) => a.id === l.accountId)!.nick, rawBudgeted: l.explicit, rollover: new Decimal(0) })),
          effective: eff,
          accounts: w.accts.filter((a) => !a.archived).map((a) => ({ id: a.id, nickname: a.nick, institutionName: "Bank", accountType: a.type, currentBalance: null, currentBalanceAt: null })),
          transfers: [],
          period: "2026-10",
          periodLabel: "October 2026",
          bucket: "personal",
          isAllEntities: false,
          periodQuery: "",
          ownAccountByMask: map,
        });
        for (const target of [{ kind: "spent" as const }, { kind: "budgeted" as const }, { kind: "overspent" as const }]) {
          const v = buildDrillView(drill, target);
          expect(sumCountedRows(v), `seed ${seed} ${target.kind}`).toBe(v.expected!.cents);
        }
        const strings: string[] = [];
        (function walk(o: unknown) {
          if (typeof o === "string") strings.push(o);
          else if (o && typeof o === "object") for (const k of Object.keys(o)) walk((o as Record<string, unknown>)[k]);
        })(drill);
        // recognised wording ("Online Xfer Transfer to CK xNNNN", single spaces): never a mask in the payload
        for (const t of drill.txs) {
          if (LEG_RE.test(t.payee)) throw new Error(`seed ${seed}: payload still carries a leg-shaped payee ${t.payee}`);
        }
        void strings;
      }
    }
    for (const [k, v] of Object.entries(seen)) expect(v, `branch ${k} exercised`).toBeGreaterThan(50);
  });
});

describe("tester: own-account transfer rule, named cases", () => {
  const tagById = new Map(TAGS.map((t) => [t.id, t]));
  const map = new Map([
    ["1111", "a-chk"],
    ["2222", "a-sav"],
  ]);
  const base = (over: Partial<SpendTx>): SpendTx => ({
    id: "t",
    day: "2026-10-09",
    amount: new Decimal("-400"),
    payee: "Online Xfer Transfer to CK x2222",
    accountId: "a-chk",
    accountNickname: "Primary Checking",
    accountType: "checking",
    entityId: "e",
    entityName: "E",
    pending: true,
    transferPairId: null,
    tagIds: [],
    ...over,
  });

  it("pending and posted, outgoing and incoming, are own transfers; the reason names the direction", () => {
    expect(classifyTx(base({}), tagById, map)).toEqual({ cls: "own_transfer", reason: "Transfer to your own account, not counted" });
    expect(classifyTx(base({ pending: false }), tagById, map).cls).toBe("own_transfer");
    expect(classifyTx(base({ payee: "Online Xfer Transfer from SV x1111", accountId: "a-sav", amount: new Decimal("400") }), tagById, map)).toEqual({
      cls: "own_transfer",
      reason: "Transfer from your own account, not counted",
    });
  });

  it("unknown, archived, shared, own-account and malformed wording all stay spending", () => {
    for (const payee of [
      "Online Xfer Transfer to CK x9999", // unknown
      "Online Xfer Transfer to CK x5555", // archived (absent from the map)
      "Online Xfer Transfer to CK x6666", // shared (absent from the map)
      "Online Xfer Transfer to CK x1111", // the row's own account
      "Online Xfer Transfer to CK x22222",
      "online xfer transfer to CK x2222",
      "Online Xfer Transfer to CK x2222 note",
      "x2222",
    ]) {
      expect(classifyTx(base({ payee }), tagById, map).cls, payee).toBe("spending");
    }
    // trimmed variant: recognised (harmless: still the exact bank wording)
    expect(classifyTx(base({ payee: "  Online Xfer Transfer to CK x2222 " }), tagById, map).cls).toBe("own_transfer");
    // the historical double-space wording is recognised too (whitespace runs are collapsed first; case and anchoring stay exact)
    expect(classifyTx(base({ payee: "Online  Xfer Transfer to CK x2222" }), tagById, map).cls).toBe("own_transfer");
  });

  it("no map = rule off; paired row keeps its own reason; loan-account entry stays a loan row", () => {
    expect(classifyTx(base({}), tagById).cls).toBe("spending");
    expect(classifyTx(base({ transferPairId: "p" }), tagById, map).reason).toBe("Paired transfer between your own accounts");
    expect(classifyTx(base({ accountType: "mortgage" }), tagById, map).cls).toBe("loan_account");
  });
});

describe("tester: payload privacy", () => {
  it("displayPayee names a known counterpart and hides the digits of any other transfer label", () => {
    const nick = new Map([["a-sav", "Slush Funds"]]);
    const map = new Map([["2222", "a-sav"]]);
    expect(displayPayee("Online Xfer Transfer to CK x2222", map, nick)).toBe("Transfer to Slush Funds");
    expect(displayPayee("Online Xfer Transfer from SV x2222", map, nick)).toBe("Transfer from Slush Funds");
    expect(displayPayee("Online Xfer Transfer to SV x8815", map, nick)).toBe("Online Xfer Transfer to SV x****");
    expect(displayPayee("Online Xfer Transfer to CK x2222", undefined, nick)).toBe("Online Xfer Transfer to CK x****");
    expect(displayPayee("Merchant 4455", map, nick)).toBe("Merchant 4455");
  });

  // The historical double-space wording ("Online  Xfer ...", May 2025 to Apr 2026) is now masked too (was an it.fails pin).
  it("a double-space variant of the transfer wording is masked too", () => {
    const out = displayPayee("Online  Xfer Transfer to CK x2222", new Map([["2222", "a-sav"]]), new Map([["a-sav", "Slush Funds"]]));
    expect(out).not.toMatch(/x\d{4}/);
  });
});
