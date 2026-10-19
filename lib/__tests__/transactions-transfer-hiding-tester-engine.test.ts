// Tester (transactions-transfer-hiding): independent checks of the TD mask map, the matcher and the runner.
// - buildTdMaskMap vs an oracle written from the plan's D1 rules (random account sets);
// - matchTransferLegs invariants over random candidates (one-sided legs are exactly the no_counterpart leftovers, never
//   a self mask, never a sign disagreement; pairs are always sign-consistent);
// - the real runner over a STATEFUL fake db that honours the where clauses it is given (pending, archived, TD-only,
//   prefilter), across several runs: gate off then on, idempotent re-run, a pending leg that posts later, an ambiguous
//   mask and a former mask that collides with a current one. Deletes throw. No database is contacted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTdMaskMap, TD_FORMER_MASK_ALIASES } from "@/lib/td-account-masks";
import { decimalSign, matchTransferLegs, normalizeTransferLabel, parseTransferLeg } from "@/lib/transfer-match";

// ── deterministic PRNG ────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ── 1. buildTdMaskMap oracle ──────────────────────────────────────────────────────────────────────────────────────
function oracleMaskMap(rows: { id: string; mask: string | null }[]): Map<string, string> {
  const holders = (mask: string) => rows.filter((r) => r.mask === mask);
  const out = new Map<string, string>();
  for (const r of rows) if (r.mask && holders(r.mask).length === 1) out.set(r.mask, r.id);
  // the one owner-stated alias: 8815 -> the single holder of 3950, unless 8815 is anyone's current mask
  const sav = holders("3950");
  if (sav.length === 1 && holders("8815").length === 0) out.set("8815", sav[0]!.id);
  if (sav.length === 1 && holders("8815").length > 0) out.delete("8815");
  return out;
}

describe("buildTdMaskMap vs an independent oracle (2,000 random account sets)", () => {
  it("the alias table is still the single owner-stated entry this oracle assumes", () => {
    expect(TD_FORMER_MASK_ALIASES.map((a) => [a.formerMask, a.currentMask])).toEqual([["8815", "3950"]]);
  });

  it("matches the oracle on every set", () => {
    const r = rng(20261019);
    const pool = ["3950", "8815", "2566", "3612", "2558", null] as const;
    for (let n = 0; n < 2000; n++) {
      const rows = Array.from({ length: Math.floor(r() * 6) }, (_, i) => ({ id: `a${i}`, mask: pick(r, pool) }));
      const got = [...buildTdMaskMap(rows).entries()].sort();
      const want = [...oracleMaskMap(rows).entries()].sort();
      expect(got, JSON.stringify(rows)).toEqual(want);
      // 8815 can only ever point at the 3950 account or at the account whose CURRENT mask is 8815
      const t = buildTdMaskMap(rows).get("8815");
      if (t !== undefined) {
        const holder = rows.find((x) => x.id === t)!;
        expect(["3950", "8815"]).toContain(holder.mask);
      }
    }
  });

  it("the alias never resolves to a non-Savings account and a current 8815 holder blocks it entirely", () => {
    expect(buildTdMaskMap([{ id: "sav", mask: "3950" }, { id: "x", mask: "8815" }]).has("8815")).toBe(false);
    expect(buildTdMaskMap([{ id: "sav", mask: "3950" }, { id: "x", mask: "8815" }, { id: "y", mask: "8815" }]).has("8815")).toBe(false);
    // without 3950 present, 8815 is just an ordinary current mask (alias inert)
    expect(buildTdMaskMap([{ id: "x", mask: "8815" }]).get("8815")).toBe("x");
  });
});

// ── 2. matchTransferLegs invariants ───────────────────────────────────────────────────────────────────────────────
describe("matchTransferLegs invariants (3,000 random candidate sets)", () => {
  const ACCTS = [
    { id: "p", mask: "2566" },
    { id: "s", mask: "3612" },
    { id: "v", mask: "3950" },
  ];
  const map = buildTdMaskMap(ACCTS);
  const masks = ["2566", "3612", "3950", "8815", "0000"];
  const spaces = [" ", "  ", "\t", "  "];

  it("one-sided = the no_counterpart leftovers, each with a resolvable non-self mask and an agreeing sign", () => {
    const r = rng(7);
    for (let n = 0; n < 3000; n++) {
      const cands = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => {
        const dir = pick(r, ["to", "from"] as const);
        const sp = pick(r, spaces);
        const amt = pick(r, ["5.00", "10.00", "0.00"]);
        const sign = pick(r, ["-", "", "+"]);
        return {
          id: `t${i}`,
          accountId: pick(r, ACCTS).id,
          postedAt: new Date(Date.UTC(2026, 3, 6 + Math.floor(r() * 2))),
          amount: `${sign}${amt}`,
          payeeRaw: pick(r, [
            `Online${sp}Xfer Transfer ${dir} CK x${pick(r, masks)}`,
            `online Xfer Transfer ${dir} CK x2566`, // wrong case: never a transfer
            "STOP & SHOP",
          ]),
        };
      });
      const { pairs, unmatched, oneSided } = matchTransferLegs(cands, map);
      const byId = new Map(cands.map((c) => [c.id, c]));
      const seen = new Set<string>();
      for (const p of pairs) for (const id of [p.outgoingTxId, p.incomingTxId]) { expect(seen.has(id)).toBe(false); seen.add(id); }
      for (const u of unmatched) { expect(seen.has(u.txId)).toBe(false); seen.add(u.txId); }
      // never-transfer-shaped rows appear nowhere
      for (const c of cands) if (!parseTransferLeg(normalizeTransferLabel(c.payeeRaw))) expect(seen.has(c.id)).toBe(false);
      // one-sided ids == no_counterpart ids
      expect(oneSided.map((o) => o.txId).sort()).toEqual(unmatched.filter((u) => u.reason === "no_counterpart").map((u) => u.txId).sort());
      for (const o of oneSided) {
        const c = byId.get(o.txId)!;
        const parsed = parseTransferLeg(normalizeTransferLabel(c.payeeRaw))!;
        expect(o.direction).toBe(parsed.direction);
        expect(o.counterpartAccountId).toBe(map.get(parsed.mask));
        expect(o.counterpartAccountId).not.toBe(c.accountId);
        expect(decimalSign(c.amount)).toBe(o.direction === "to" ? -1 : 1);
      }
      for (const p of pairs) {
        const out = byId.get(p.outgoingTxId)!;
        const inn = byId.get(p.incomingTxId)!;
        expect(decimalSign(out.amount)).toBe(-1);
        expect(decimalSign(inn.amount)).toBe(1);
        expect(out.accountId).toBe(p.fromAccountId);
        expect(inn.accountId).toBe(p.toAccountId);
        expect(p.fromAccountId).not.toBe(p.toAccountId);
        expect(out.postedAt.toISOString().slice(0, 10)).toBe(inn.postedAt.toISOString().slice(0, 10));
      }
    }
  });
});

// ── 3. runner over a stateful fake db ─────────────────────────────────────────────────────────────────────────────
interface Acct { id: string; mask: string | null; institution: string; archivedAt: Date | null }
interface Tx {
  id: string; accountId: string; postedAt: Date; amount: string; payeeRaw: string | null; description: string | null;
  pending: boolean; archivedAt: Date | null; transferPairId: string | null; ownTransferAccountId: string | null;
  scheduledTransferId: string | null; tags: Set<string>;
}

const st = vi.hoisted(() => ({
  accounts: [] as unknown[],
  txs: [] as unknown[],
  settings: new Map<string, string>(),
  tags: [
    { id: "tag-out", name: "Transfer Out" },
    { id: "tag-in", name: "Transfer In" },
  ],
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === "AND") { if (!(cond as Record<string, unknown>[]).every((w) => matches(row, w))) return false; continue; }
    if (k === "institution") { if (row.institution !== (cond as { name: string }).name) return false; continue; }
    const v = row[k];
    if (cond === null) { if (v !== null) return false; continue; }
    if (typeof cond === "object" && cond !== null && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown; startsWith?: string; contains?: string };
      if (c.in && !c.in.includes(v)) return false;
      if ("not" in c && c.not === null && v === null) return false;
      if (c.startsWith !== undefined && !(typeof v === "string" && v.startsWith(c.startsWith))) return false;
      if (c.contains !== undefined && !(typeof v === "string" && v.includes(c.contains))) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}
function lazy<T>(fn: () => T) {
  let done = false; let val: T;
  const run = () => { if (!done) { val = fn(); done = true; } return val; };
  return { run, then: (res: (v: T) => unknown, rej: (e: unknown) => unknown) => { try { return Promise.resolve(res(run())); } catch (e) { return Promise.resolve(rej(e)); } } };
}
function boom(): never { throw new Error("DELETE CALLED"); }

vi.mock("@/lib/db", () => {
  const txs = () => st.txs as Tx[];
  const project = (t: Tx, select: Record<string, unknown>) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(select)) o[k] = k === "tags" ? [...t.tags].map((tagId) => ({ tagId })) : k === "amount" ? { toString: () => t.amount } : (t as unknown as Record<string, unknown>)[k];
    return o;
  };
  const transaction = {
    findMany: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, unknown> }) =>
      txs().filter((t) => matches(t as unknown as Record<string, unknown>, where)).map((t) => project(t, select)),
    update: ({ where, data }: { where: { id: string }; data: Partial<Tx> }) =>
      lazy(() => { const t = txs().find((x) => x.id === where.id)!; Object.assign(t, data); return t; }),
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Partial<Tx> }) =>
      lazy(() => { const hit = txs().filter((t) => matches(t as unknown as Record<string, unknown>, where)); for (const t of hit) Object.assign(t, data); return { count: hit.length }; }),
    delete: boom, deleteMany: boom,
  };
  const transactionTag = {
    createMany: ({ data, skipDuplicates }: { data: { transactionId: string; tagId: string }[]; skipDuplicates?: boolean }) =>
      lazy(() => {
        let count = 0;
        for (const d of data) {
          const t = txs().find((x) => x.id === d.transactionId)!;
          if (t.tags.has(d.tagId)) { if (!skipDuplicates) throw new Error("unique violation"); continue; }
          t.tags.add(d.tagId); count++;
        }
        return { count };
      }),
    delete: boom, deleteMany: boom,
  };
  const db = {
    account: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        (st.accounts as Acct[]).filter((a) => matches(a as unknown as Record<string, unknown>, where)).map((a) => ({ id: a.id, mask: a.mask })),
    },
    transaction,
    transactionTag,
    tag: { findFirst: async ({ where }: { where: { name: string } }) => st.tags.find((t) => t.name === where.name) ?? null },
    scheduledTransfer: { findMany: async () => [] },
    appSetting: { findUnique: async ({ where }: { where: { key: string } }) => (st.settings.has(where.key) ? { key: where.key, value: st.settings.get(where.key) } : null) },
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) return arg.map((p: { run: () => unknown }) => p.run());
      return (arg as (tx: unknown) => Promise<unknown>)({ transaction, transactionTag });
    },
  };
  return { db };
});

import { ONE_SIDED_SETTING_KEY, runTransferMatchingEngine } from "@/lib/transfer-match-runner";

const day = (s: string) => new Date(`${s}T00:00:00Z`);
function tx(o: Partial<Tx> & Pick<Tx, "id" | "accountId" | "amount" | "payeeRaw">): Tx {
  return {
    postedAt: day("2026-04-06"), description: null, pending: false, archivedAt: null, transferPairId: null,
    ownTransferAccountId: null, scheduledTransferId: null, tags: new Set(), ...o,
  };
}
const T = () => st.txs as Tx[];
const get = (id: string) => T().find((t) => t.id === id)!;
const snapshot = () => JSON.stringify(T().map((t) => ({ ...t, tags: [...t.tags].sort() })));

beforeEach(() => {
  st.settings.clear();
  st.accounts = [
    { id: "primary", mask: "2566", institution: "TD Bank", archivedAt: null },
    { id: "slush", mask: "3612", institution: "TD Bank", archivedAt: null },
    { id: "savings", mask: "3950", institution: "TD Bank", archivedAt: null },
    { id: "cu", mask: "7777", institution: "Credit Union", archivedAt: null },
  ];
  st.txs = [
    // historical imported leg: double space + description, with a Plaid counterpart -> pairs
    tx({ id: "imp", accountId: "primary", amount: "-100.00", payeeRaw: "Online  Xfer Transfer to CK x3612", description: "imported" }),
    tx({ id: "pl", accountId: "slush", amount: "100.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
    // weekly $10 to the former Savings number, already tagged Transfer Out by the owner -> one-sided, no new tag
    tx({ id: "wk", accountId: "primary", amount: "-10.00", payeeRaw: "Online  Xfer Transfer to SV x8815", description: "imported", tags: new Set(["tag-out"]) }),
    // owner-tagged row (another tag) that is a valid one-sided leg -> marked, transfer tag added BESIDE it
    tx({ id: "own-tag", accountId: "primary", amount: "-55.00", payeeRaw: "Online  Xfer Transfer to CK x3612", postedAt: day("2026-03-02"), tags: new Set(["tag-groceries"]) }),
    // external / unknown mask -> stays visible and untagged
    tx({ id: "ext", accountId: "primary", amount: "-30.00", payeeRaw: "Online Xfer Transfer to CK x0000" }),
    // flipped sign -> never touched
    tx({ id: "flip", accountId: "primary", amount: "40.00", payeeRaw: "Online  Xfer Transfer to CK x3612", postedAt: day("2026-02-02") }),
    // pending leg and its posted counterpart: pending is never marked; the posted side is one-sided for now
    tx({ id: "pend", accountId: "primary", amount: "-20.00", payeeRaw: "Online Xfer Transfer to CK x3612", pending: true, postedAt: day("2026-04-20") }),
    tx({ id: "slush-in", accountId: "slush", amount: "20.00", payeeRaw: "Online Xfer Transfer from CK x2566", postedAt: day("2026-04-20") }),
    // archived and non-TD rows are never candidates
    tx({ id: "arch", accountId: "primary", amount: "-9.00", payeeRaw: "Online Xfer Transfer to CK x3612", archivedAt: day("2026-04-01") }),
    tx({ id: "nontd", accountId: "cu", amount: "-9.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
  ];
});

describe("runner lifecycle on a stateful fake db", () => {
  it("gate off: pairs the double-space leg, marks nothing, adds only the pair tags", async () => {
    const s = await runTransferMatchingEngine("cron");
    expect(s.matchedPairs).toBe(1);
    expect(get("imp").transferPairId).toBe(get("pl").transferPairId);
    expect(get("imp").transferPairId).not.toBeNull();
    expect(T().filter((t) => t.ownTransferAccountId !== null)).toEqual([]);
    expect(s.oneSided.ran).toBe(false);
    expect([...get("own-tag").tags]).toEqual(["tag-groceries"]);
    expect(get("ext").tags.size).toBe(0);
    expect(s.unmatchedByReason).toEqual({ unresolvable_mask: 1, sign_mismatch: 1, no_counterpart: 3 });
  });

  it("gate on: marks exactly the valid one-sided legs; pending/archived/non-TD/external/flipped untouched; re-run is a no-op", async () => {
    st.settings.set(ONE_SIDED_SETTING_KEY, "1");
    const s1 = await runTransferMatchingEngine("cron");
    const marked = Object.fromEntries(T().filter((t) => t.ownTransferAccountId).map((t) => [t.id, t.ownTransferAccountId]));
    expect(marked).toEqual({ wk: "savings", "own-tag": "slush", "slush-in": "primary" });
    expect(s1.oneSided).toEqual({ ran: true, marked: 3, tagsAdded: 2, alreadyMarked: 0, alreadyHadOtherTag: 1, tagMissing: 0 });
    expect([...get("own-tag").tags].sort()).toEqual(["tag-groceries", "tag-out"]);
    expect([...get("wk").tags]).toEqual(["tag-out"]);
    expect([...get("slush-in").tags]).toEqual(["tag-in"]);
    for (const id of ["pend", "arch", "nontd", "ext", "flip"]) {
      expect(get(id).ownTransferAccountId, id).toBeNull();
      expect(get(id).transferPairId, id).toBeNull();
      expect(get(id).tags.size, id).toBe(0);
    }
    const snap = snapshot();
    const s2 = await runTransferMatchingEngine("cron");
    expect(s2.oneSided).toMatchObject({ ran: true, marked: 0, alreadyMarked: 3, tagsAdded: 0 });
    expect(snapshot()).toBe(snap);
  });

  it("the pending leg posts later (new id, pending row archived): it pairs with the marked side and the marker is cleared", async () => {
    st.settings.set(ONE_SIDED_SETTING_KEY, "1");
    await runTransferMatchingEngine("cron");
    expect(get("slush-in").ownTransferAccountId).toBe("primary");
    get("pend").archivedAt = day("2026-04-21");
    T().push(tx({ id: "posted", accountId: "primary", amount: "-20.00", payeeRaw: "Online Xfer Transfer to CK x3612", postedAt: day("2026-04-20") }));
    const s = await runTransferMatchingEngine("cron");
    expect(s.matchedPairs).toBe(1);
    expect(get("posted").transferPairId).toBe(get("slush-in").transferPairId);
    expect(get("slush-in").ownTransferAccountId).toBeNull();
    expect(get("posted").ownTransferAccountId).toBeNull();
    expect(get("slush-in").tags.has("tag-in")).toBe(true); // never removed
    expect(get("pend").ownTransferAccountId).toBeNull();
  });

  it("a mask held by two active TD accounts fails closed: nothing to/from it is paired or marked", async () => {
    st.settings.set(ONE_SIDED_SETTING_KEY, "1");
    (st.accounts as Acct[]).push({ id: "dup", mask: "3612", institution: "TD Bank", archivedAt: null });
    const s = await runTransferMatchingEngine("cron");
    expect(s.matchedPairs).toBe(0);
    for (const id of ["imp", "own-tag", "flip"]) expect(get(id).ownTransferAccountId, id).toBeNull();
    expect(get("imp").transferPairId).toBeNull();
    // the Slush legs ("from CK x2566") still resolve to Primary and are one-sided
    expect(get("pl").ownTransferAccountId).toBe("primary");
  });

  it("an archived duplicate mask holder does not make the mask ambiguous", async () => {
    (st.accounts as Acct[]).push({ id: "old", mask: "3612", institution: "TD Bank", archivedAt: day("2025-01-01") });
    expect((await runTransferMatchingEngine("cron")).matchedPairs).toBe(1);
  });

  it("a non-TD account holding 3950 does not feed the alias; a TD account holding 8815 drops it", async () => {
    st.settings.set(ONE_SIDED_SETTING_KEY, "1");
    (st.accounts as Acct[]).push({ id: "cu2", mask: "8815", institution: "Credit Union", archivedAt: null });
    await runTransferMatchingEngine("cron");
    expect(get("wk").ownTransferAccountId).toBe("savings"); // non-TD 8815 holder is out of scope
    // reset and add a TD holder of 8815
    get("wk").ownTransferAccountId = null;
    (st.accounts as Acct[]).push({ id: "td8815", mask: "8815", institution: "TD Bank", archivedAt: null });
    await runTransferMatchingEngine("cron");
    expect(get("wk").ownTransferAccountId).toBeNull();
  });

  it("deleting the setting stops future marking but leaves earlier marks in place", async () => {
    st.settings.set(ONE_SIDED_SETTING_KEY, "1");
    await runTransferMatchingEngine("cron");
    st.settings.delete(ONE_SIDED_SETTING_KEY);
    T().push(tx({ id: "new", accountId: "primary", amount: "-10.00", payeeRaw: "Online Xfer Transfer to SV x8815", postedAt: day("2026-10-12") }));
    const s = await runTransferMatchingEngine("cron");
    expect(s.oneSided.ran).toBe(false);
    expect(get("new").ownTransferAccountId).toBeNull();
    expect(get("wk").ownTransferAccountId).toBe("savings");
  });
});
