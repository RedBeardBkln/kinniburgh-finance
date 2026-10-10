// TESTER (carry-forward-seasonal-energy, step 2 round 1): independent fuzz of the durable "Not heating oil" marks
// (lib/seasonal-energy-marks.ts) over pending -> posted re-id scenarios. The oracle states the REQUIREMENTS (a mark covers
// at most one row, only a same-account / same-cents / alike-payee / +-5 day row can inherit it, a live marked row is never
// taken over, count-again removes id and signature) and is checked against the real module.
import { describe, expect, it } from "vitest";
import {
  MARK_WINDOW_DAYS,
  applyToggle,
  parseMarks,
  payeeKey,
  resolveMarks,
  serializeMarks,
  signatureOf,
  type MarkRow,
  type OilMark,
} from "@/lib/seasonal-energy-marks";

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
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const D0 = Date.UTC(2026, 9, 1);
const day = (n: number) => new Date(D0 + n * 86_400_000);
let idn = 0;
const uid = () => `00000000-0000-4000-8000-${String(++idn).padStart(12, "0")}`;

interface Charge {
  acct: string;
  cents: number;
  payee: string;
  day: number;
}
const PAYEES = ["mccarthy heating oil", "mccarthy heating oil serv 860 4432839 ct", "mccarthy heating & oil", "other oil co"];
const row = (id: string, c: Charge, dayOffset = 0, payee = c.payee): MarkRow => ({ id, accountId: c.acct, amount: String(-c.cents / 100), payee, date: day(c.day + dayOffset) });

describe("pending -> posted re-id, random worlds", () => {
  it("2500 worlds: each mark covers exactly the posted twin of its charge (group-wise), never anything else", () => {
    const r = rng(8675309);
    let ambiguous = 0;
    let inheritedTotal = 0;
    for (let w = 0; w < 2500; w++) {
      const n = ri(r, 1, 7);
      const charges: Charge[] = Array.from({ length: n }, () => ({
        acct: r() < 0.5 ? "acctA" : "acctB",
        cents: r() < 0.5 ? 153950 : ri(r, 1, 4) * 100000 + 75,
        payee: PAYEES[ri(r, 0, 2)]!,
        day: ri(r, 0, 12),
      }));
      // pending rows, owner marks a random subset one click at a time (stale list is empty while all are alive)
      const pendingIds = charges.map(() => uid());
      const alive = new Set(pendingIds);
      let marks: OilMark[] = [];
      const markedIdx: number[] = [];
      charges.forEach((c, i) => {
        if (r() < 0.5) {
          const res = applyToggle(marks, { id: pendingIds[i]!, sig: signatureOf(row(pendingIds[i]!, c)) }, true, alive);
          expect(res.ok).toBe(true);
          if (res.ok) marks = res.value;
          markedIdx.push(i);
        }
      });
      // the bank posts every charge: new id, 0..1 day later, sometimes a longer descriptor; pending ids are gone
      const posted: MarkRow[] = charges.map((c) => row(uid(), c, ri(r, 0, 1), r() < 0.4 ? `${c.payee} extra` : c.payee));
      // shuffle the order the rows are handed over
      const shuffled = [...posted].sort(() => r() - 0.5);
      const res = resolveMarks(marks, shuffled);
      inheritedTotal += res.inherited;
      // never more excluded rows than marks
      expect(res.excludedIds.size, `world ${w}`).toBeLessThanOrEqual(marks.length);
      // every excluded row is a twin of some marked charge (same acct / cents / alike payee, within the window)
      for (const id of res.excludedIds) {
        const p = posted.find((x) => x.id === id)!;
        const ok = markedIdx.some((i) => {
          const c = charges[i]!;
          return p.accountId === c.acct && Math.round(Number(p.amount) * -100) === c.cents && Math.abs(p.date.getTime() - day(c.day).getTime()) <= MARK_WINDOW_DAYS * 86_400_000;
        });
        expect(ok, `world ${w}: excluded a row that is not a twin of any marked charge`).toBe(true);
      }
      // group-wise exactness: for each (acct, cents) group of charges, excluded posted rows == marked charges in the group
      // (the rows are within 12 days, so two charges of one group can be farther than the window: only assert the sum
      // when every charge of the group is within the window of every other, otherwise a lower bound of 0 and upper bound = marks)
      const groups = new Map<string, number[]>();
      charges.forEach((c, i) => groups.set(`${c.acct}|${c.cents}`, [...(groups.get(`${c.acct}|${c.cents}`) ?? []), i]));
      for (const [key, idxs] of groups) {
        const dayspan = Math.max(...idxs.map((i) => charges[i]!.day)) - Math.min(...idxs.map((i) => charges[i]!.day));
        const marked = idxs.filter((i) => markedIdx.includes(i)).length;
        const excl = posted.filter((p, i) => idxs.includes(i) && res.excludedIds.has(p.id)).length;
        if (idxs.length > 1) ambiguous++;
        if (dayspan <= 3 && new Set(idxs.map((i) => charges[i]!.payee)).size === 1) {
          expect(excl, `world ${w} group ${key}: marks ${marked}`).toBe(marked);
        } else {
          expect(excl, `world ${w} group ${key}`).toBeLessThanOrEqual(marked);
        }
      }
    }
    expect(ambiguous).toBeGreaterThan(500);
    expect(inheritedTotal).toBeGreaterThan(2000);
  });
});

describe("matcher edges (hand cases)", () => {
  const base: Charge = { acct: "acctA", cents: 103675, payee: "mccarthy heating oil", day: 8 };
  const marks = (): OilMark[] => [{ id: "00000000-0000-4000-8000-0000000000aa", sig: signatureOf(row("00000000-0000-4000-8000-0000000000aa", base)) }];
  const excl = (rows: MarkRow[]) => [...resolveMarks(marks(), rows).excludedIds];

  it("window: day +5 and -5 inherit, +6 and -6 do not", () => {
    for (const [off, ok] of [[0, true], [5, true], [-5, true], [6, false], [-6, false]] as const) {
      expect(excl([row("p1", base, off)]).length, `offset ${off}`).toBe(ok ? 1 : 0);
    }
  });
  it("different account, different cents (even by 1 cent), unrelated payee: no inheritance", () => {
    expect(excl([row("p1", { ...base, acct: "acctB" })])).toEqual([]);
    expect(excl([row("p1", { ...base, cents: 103676 })])).toEqual([]);
    expect(excl([row("p1", { ...base, cents: 103674 })])).toEqual([]);
    expect(excl([row("p1", base, 0, "valero oil")])).toEqual([]);
    expect(excl([row("p1", base, 0, "mccarthy heatingoil")])).toEqual([]); // not a whole-word prefix
  });
  it("payee alike in both directions (whole-word prefix), case and punctuation insensitive", () => {
    expect(excl([row("p1", base, 0, "MCCARTHY HEATING OIL SERV 860 4432839 CT")])).toHaveLength(1);
    const longMark: OilMark[] = [{ id: "00000000-0000-4000-8000-0000000000bb", sig: signatureOf(row("x", base, 0, "McCarthy Heating & Oil Serv 860")) }];
    expect(resolveMarks(longMark, [row("p1", base, 0, "mccarthy heating oil")]).excludedIds.size).toBe(1); // "&" is punctuation: the key is a whole-word prefix
    expect(payeeKey("McCarthy Heating-Oil, Inc.")).toBe("mccarthy heating oil inc");
  });
  it("two identical charges, ONE mark: exactly one posted row is excluded, whichever order they arrive", () => {
    const a = row("p1", base, 1);
    const b = row("p2", base, 1);
    expect(excl([a, b])).toHaveLength(1);
    expect(excl([b, a])).toHaveLength(1);
    // the choice is deterministic regardless of the order handed in
    expect(excl([a, b])).toEqual(excl([b, a]));
  });
  it("two identical charges, TWO marks: both excluded; THREE rows with two marks: two excluded", () => {
    const m2: OilMark[] = [...marks(), { id: "00000000-0000-4000-8000-0000000000cc", sig: signatureOf(row("y", base, 1)) }];
    expect(resolveMarks(m2, [row("p1", base, 1), row("p2", base, 1)]).excludedIds.size).toBe(2);
    expect(resolveMarks(m2, [row("p1", base, 1), row("p2", base, 0), row("p3", base, 2)]).excludedIds.size).toBe(2);
  });
  it("a live marked row keeps its own mark and a look-alike posted row is NOT swallowed by it", () => {
    const live = row("00000000-0000-4000-8000-0000000000aa", base, 0);
    const lookAlike = row("p9", base, 1);
    const r = resolveMarks(marks(), [live, lookAlike]);
    expect([...r.excludedIds]).toEqual([live.id]);
    expect(r.inherited).toBe(0);
  });
  it("legacy bare-id storage: read as a mark by id, never inherited (no signature)", () => {
    const parsed = parseMarks(JSON.stringify(["00000000-0000-4000-8000-0000000000aa", { id: "00000000-0000-4000-8000-0000000000dd" }, "nope", 7, null]));
    expect(parsed.marks.map((m) => m.id)).toEqual(["00000000-0000-4000-8000-0000000000aa", "00000000-0000-4000-8000-0000000000dd"]);
    expect(resolveMarks(parsed.marks, [row("00000000-0000-4000-8000-0000000000aa", base)]).excludedIds.size).toBe(1);
    expect(resolveMarks(parsed.marks, [row("other", base)]).excludedIds.size).toBe(0);
  });
  it("a malformed signature is dropped, the id is kept; unique ids; capped at 200", () => {
    const raw = JSON.stringify([{ id: "00000000-0000-4000-8000-0000000000aa", sig: { a: "", c: -1, p: 5, on: "x" } }, "00000000-0000-4000-8000-0000000000aa"]);
    const p = parseMarks(raw);
    expect(p.marks).toEqual([{ id: "00000000-0000-4000-8000-0000000000aa" }]);
    const many = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`);
    expect(parseMarks(JSON.stringify(many)).marks).toHaveLength(200);
  });
});

describe("applyToggle sequences", () => {
  const A = { acct: "acctA", cents: 153950, payee: "mccarthy heating oil", day: 8 };
  const sig = (id: string, c: Charge = A, off = 0) => signatureOf(row(id, c, off));
  const P1 = "00000000-0000-4000-8000-0000000000a1";
  const Q1 = "00000000-0000-4000-8000-0000000000b1";

  it("marking the posted twin of a STALE entry replaces the slot (length unchanged, old id gone)", () => {
    const stored: OilMark[] = [{ id: P1, sig: sig(P1) }];
    const res = applyToggle(stored, { id: Q1, sig: sig(Q1, A, 1) }, true, new Set<string>());
    expect(res.ok && res.value).toEqual([{ id: Q1, sig: sig(Q1, A, 1) }]);
  });
  it("a LIVE marked entry is never taken over by a look-alike: the look-alike gets its own entry", () => {
    const stored: OilMark[] = [{ id: P1, sig: sig(P1) }];
    const res = applyToggle(stored, { id: Q1, sig: sig(Q1, A, 1) }, true, new Set([P1]));
    expect(res.ok && res.value.map((m) => m.id)).toEqual([P1, Q1]);
  });
  it("count it again removes id AND signature: by own id, or by the stale twin; a live look-alike's entry survives", () => {
    const stored: OilMark[] = [{ id: P1, sig: sig(P1) }];
    expect(applyToggle(stored, { id: P1, sig: sig(P1) }, false, new Set([P1]))).toEqual({ ok: true, value: [] });
    expect(applyToggle(stored, { id: Q1, sig: sig(Q1, A, 1) }, false, new Set<string>())).toEqual({ ok: true, value: [] });
    expect(applyToggle(stored, { id: Q1, sig: sig(Q1, A, 1) }, false, new Set([P1]))).toEqual({ ok: true, value: stored });
  });
  it("idempotent: marking twice and counting twice change nothing the second time", () => {
    let m: OilMark[] = [];
    const t = { id: Q1, sig: sig(Q1) };
    const a = applyToggle(m, t, true, new Set());
    if (a.ok) m = a.value;
    const b = applyToggle(m, t, true, new Set([Q1]));
    expect(b.ok && serializeMarks(b.value)).toBe(serializeMarks(m));
    const c = applyToggle(m, t, false, new Set([Q1]));
    const d = c.ok ? applyToggle(c.value, t, false, new Set()) : c;
    expect(d.ok && d.value).toEqual([]);
  });
  it("cap 200: a new unrelated entry is refused, but the posted twin of a stale entry still replaces its slot", () => {
    const full: OilMark[] = Array.from({ length: 200 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(5000 + i).padStart(12, "0")}`, sig: sig("x", { ...A, cents: 100 + i }) }));
    full[17] = { id: P1, sig: sig(P1) };
    const alive = new Set(full.filter((m) => m.id !== P1).map((m) => m.id));
    expect(applyToggle(full, { id: "00000000-0000-4000-8000-0000000000ff", sig: sig("n", { ...A, cents: 9 }) }, true, alive).ok).toBe(false);
    const rep = applyToggle(full, { id: Q1, sig: sig(Q1, A, 1) }, true, alive);
    expect(rep.ok && rep.value).toHaveLength(200);
    expect(rep.ok && rep.value[17]!.id).toBe(Q1);
  });
  it("an old id-only entry for the same row is upgraded with its signature on the next click (no duplicate)", () => {
    const res = applyToggle([{ id: Q1 }], { id: Q1, sig: sig(Q1) }, true, new Set([Q1]));
    expect(res.ok && res.value).toEqual([{ id: Q1, sig: sig(Q1) }]);
  });
  it("stale entries from DIFFERENT charges are not merged: other cents or other account or >5 days apart", () => {
    const stored: OilMark[] = [{ id: P1, sig: sig(P1) }];
    for (const c of [{ ...A, cents: A.cents + 1 }, { ...A, acct: "acctB" }, { ...A, day: A.day + 6 }]) {
      const res = applyToggle(stored, { id: Q1, sig: sig(Q1, c) }, true, new Set<string>());
      expect(res.ok && res.value.map((m) => m.id)).toEqual([P1, Q1]);
    }
  });
});

describe("KNOWN LOW LIMITATION (pinned with it.fails): the matcher is greedy, not a best overall assignment", () => {
  it.fails("two marks on identical cents, whose posted descriptors differ, both land on a row when each has a row of its own", () => {
    const base: Charge = { acct: "acctA", cents: 50000, payee: "mccarthy heating oil", day: 3 };
    const m1: OilMark = { id: "00000000-0000-4000-8000-0000000000e1", sig: signatureOf(row("x1", base, 0, "mccarthy heating oil")) };
    const m2: OilMark = { id: "00000000-0000-4000-8000-0000000000e2", sig: signatureOf(row("x2", base, 0, "mccarthy heating oil serv 860")) };
    const r2 = row("aaa-2", base, 1, "mccarthy heating oil serv 860"); // lowest id, matches BOTH marks
    const r1 = row("zzz-1", base, 1, "mccarthy heating oil extra"); // matches only m1
    expect(resolveMarks([m1, m2], [r1, r2]).excludedIds.size).toBe(2);
  });
});

describe("D1b (FIXED in Round 2, was an it.fails pin): the matcher compares ONE descriptor, not the joined text", () => {
  // Round 1 built the payee as [payeeNormalized, payeeRaw, description].join(" "), doubling it, so the pending
  // "Mccarthy Heating Oil" and the posted "Mccarthy Heating Oil Ser" were never whole-word prefixes of each other.
  // Round 2: the loader and the action hand the matcher ONE descriptor (descriptorOf), so the real shapes are single strings.
  const base: Charge = { acct: "Heating & Electric", cents: 18080, payee: "", day: 8 };
  const join = (n: string) => n; // the single descriptor
  it("a mark on the pending '... Oil' row is inherited by the posted '... Oil Ser' row of the same account and amount", () => {
    const pending = row("00000000-0000-4000-8000-0000000000f1", base, 0, join("Mccarthy Heating Oil"));
    const posted = row("posted-1", base, 1, join("Mccarthy Heating Oil Ser"));
    const m: OilMark = { id: pending.id, sig: signatureOf(pending) };
    expect(resolveMarks([m], [posted]).excludedIds.has(posted.id)).toBe(true);
  });
  it("control: the same descriptor on both sides (the Barclay case) is inherited", () => {
    const pending = row("00000000-0000-4000-8000-0000000000f2", { ...base, cents: 103675 }, 0, join("Mccarthy Heating Oil"));
    const posted = row("posted-2", { ...base, cents: 103675 }, 1, join("Mccarthy Heating Oil"));
    expect(resolveMarks([{ id: pending.id, sig: signatureOf(pending) }], [posted]).excludedIds.has("posted-2")).toBe(true);
  });
});

describe("empty payees", () => {
  it("two rows with no payee text never count as alike, so a signature with an empty payee inherits nothing", () => {
    const c: Charge = { acct: "acctA", cents: 100, payee: "", day: 2 };
    const m: OilMark = { id: "00000000-0000-4000-8000-0000000000e9", sig: signatureOf(row("x", c, 0, "")) };
    expect(resolveMarks([m], [row("p1", c, 0, "")]).excludedIds.size).toBe(0);
  });
});
