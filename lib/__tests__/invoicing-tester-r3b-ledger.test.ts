// Tester round 3b (ek-consulting-invoicing): independent proof that D-13 (derived ledger after remove-then-reapply) is fixed, with a pure
// oracle written here (not reusing the Coder's lifecycle fuzz), the exact repro through the real owner actions, partial / later-day
// re-apply, void payment, void invoice and fees. Also documents the known "as of 00:00 UTC of the receipt day" caveat.
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_AR, ACCOUNT_CASH, ACCOUNT_FEES, ACCOUNT_UNEARNED, balancesByAccount, deriveLedger, glAccount, isBalanced, type LedgerDoc, type LedgerPayment } from "@/lib/invoicing/ledger";

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const dayStart = (n: number) => new Date(T0 + n * DAY);
const dayEnd = (n: number) => new Date(T0 + (n + 1) * DAY - 1);
const GL = "gl-rev";

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

interface Inv { id: string; total: number; issueDay: number; voidAt: number | null } // voidAt = ms timestamp
interface Al { inv: number; amt: number; appliedDay: number; voidAt: number | null }

function build(invs: Inv[], pay: { recvDay: number; amt: number; fee: number; voidAt: number | null }, als: Al[]) {
  const docs: LedgerDoc[] = invs.map((i) => ({
    id: i.id, kind: "invoice", status: i.voidAt ? "void" : "issued", issueDate: dayStart(i.issueDay), voidedAt: i.voidAt ? new Date(i.voidAt) : null,
    totalCents: i.total, discountCents: 0, lines: [{ glCodeId: GL, lineTotalCents: i.total }],
  }));
  const p: LedgerPayment = {
    id: "P", receivedOn: dayStart(pay.recvDay), amountCents: pay.amt, feeCents: pay.fee, status: pay.voidAt ? "void" : "recorded", voidedAt: pay.voidAt ? new Date(pay.voidAt) : null,
    allocations: als.map((a) => ({ appliedOn: dayStart(a.appliedDay), amountCents: a.amt, voidedAt: a.voidAt ? new Date(a.voidAt) : null })),
  };
  return deriveLedger(docs, [p]);
}

/** Oracle at the END of day D (23:59:59.999): what is true then, computed from first principles. */
function oracle(invs: Inv[], pay: { recvDay: number; amt: number; fee: number; voidAt: number | null }, als: Al[], D: number) {
  const end = dayEnd(D).getTime();
  const inForce = (a: Al) => dayStart(a.appliedDay).getTime() <= end && !(a.voidAt !== null && a.voidAt <= end);
  const payVoided = pay.voidAt !== null && pay.voidAt <= end;
  const payExists = pay.recvDay <= D;
  const applied = als.filter(inForce).reduce((s, a) => s + a.amt, 0);
  const unapplied = !payExists || payVoided ? 0 : pay.amt - applied;
  let ar = 0;
  for (const [idx, i] of invs.entries()) {
    if (i.issueDay > D) continue;
    const voided = i.voidAt !== null && i.voidAt <= end;
    if (voided) continue;
    ar += i.total - als.filter((a) => a.inv === idx && inForce(a)).reduce((s, a) => s + a.amt, 0);
  }
  const cash = payExists && !payVoided ? pay.amt - pay.fee : 0;
  return { unapplied, ar, cash };
}

function scenario(seed: number) {
  const r = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const recvDay = int(0, 3);
  const amt = int(500, 100000);
  const fee = r() < 0.3 ? int(1, Math.floor(amt / 3)) : 0;
  const nInv = int(1, 3);
  const invs: Inv[] = Array.from({ length: nInv }, (_, k) => ({ id: `I${k}`, total: int(300, 90000), issueDay: int(0, recvDay), voidAt: null }));
  const als: Al[] = [];
  const pay = { recvDay, amt, fee, voidAt: null as number | null };
  const checks: { D: number }[] = [];
  let clock = dayStart(recvDay).getTime() + 3_600_000; // 01:00 on the receipt day
  const activeOf = (a: Al) => a.voidAt === null;
  const used = () => als.filter(activeOf).reduce((s, a) => s + a.amt, 0);
  const open = (idx: number) => invs[idx]!.total - als.filter((a) => a.inv === idx && activeOf(a)).reduce((s, a) => s + a.amt, 0);
  const steps = int(1, 14);
  for (let s = 0; s < steps; s++) {
    clock += int(0, 1) === 0 ? int(1, 3) * 600_000 : int(1, 3) * DAY; // same-day minutes, or whole days later
    const day = Math.floor((clock - T0) / DAY);
    const op = r();
    if (op < 0.45) {
      const idx = int(0, nInv - 1);
      const inv = invs[idx]!;
      if (inv.voidAt !== null || inv.issueDay > day) continue;
      const room = Math.min(open(idx), pay.amt - used());
      if (pay.voidAt !== null || room <= 0) continue;
      const a = int(1, room);
      als.push({ inv: idx, amt: a, appliedDay: day, voidAt: null }); // appliedOn = event day (>= receipt day, >= issue day)
    } else if (op < 0.7) {
      const act = als.filter(activeOf);
      if (!act.length) continue;
      act[int(0, act.length - 1)]!.voidAt = clock; // remove the application at this moment
    } else if (op < 0.82) {
      if (pay.voidAt === null && used() === 0) pay.voidAt = clock;
    } else {
      const idx = int(0, nInv - 1);
      const inv = invs[idx]!;
      if (inv.voidAt === null && als.every((a) => a.inv !== idx || !activeOf(a)) && inv.issueDay <= day) inv.voidAt = clock;
    }
    checks.push({ D: day });
  }
  // an allocation applied on a day must not predate the payment record: fine by construction (event day >= recvDay)
  return { invs, pay, als, checks, recvDay };
}

describe("D-13 fixed: independent oracle over 4,000 random lifecycles (pure ledger)", () => {
  it("balanced, Unearned = unapplied deposit, A/R = open balances, cash = net, at the end of every day from the receipt day to 3 days after the last event", () => {
    const problems: string[] = [];
    for (let n = 1; n <= 4000; n++) {
      const sc = scenario(n * 104729);
      const entries = build(sc.invs, sc.pay, sc.als);
      if (!isBalanced(entries)) problems.push(`#${n} unbalanced`);
      const lastDay = Math.max(sc.recvDay, ...sc.checks.map((c) => c.D)) + 3;
      for (let D = sc.recvDay; D <= lastDay; D++) {
        const bal = balancesByAccount(entries, dayEnd(D));
        const o = oracle(sc.invs, sc.pay, sc.als, D);
        const un = 0 - (bal.get(ACCOUNT_UNEARNED) ?? 0);
        if (un !== o.unapplied) problems.push(`#${n} day ${D}: Unearned ${un} vs ${o.unapplied}`);
        if ((bal.get(ACCOUNT_AR) ?? 0) !== o.ar) problems.push(`#${n} day ${D}: A/R ${bal.get(ACCOUNT_AR) ?? 0} vs ${o.ar}`);
        if ((bal.get(ACCOUNT_CASH) ?? 0) !== o.cash) problems.push(`#${n} day ${D}: cash`);
        const fees = sc.pay.voidAt !== null && sc.pay.voidAt <= dayEnd(D).getTime() ? 0 : sc.pay.fee;
        if ((bal.get(ACCOUNT_FEES) ?? 0) !== fees) problems.push(`#${n} day ${D}: fees`);
        if (un < 0) problems.push(`#${n} day ${D}: negative deposit ${un}`);
      }
      if (problems.length > 20) break;
    }
    expect(problems).toEqual([]);
  });

  it("the exact repro numbers: $100 invoice, $100 payment received day 0 fully applied, removed, applied again (same day, and a later day)", () => {
    const invs: Inv[] = [{ id: "I0", total: 10000, issueDay: 0, voidAt: null }];
    const pay = { recvDay: 0, amt: 10000, fee: 0, voidAt: null };
    for (const reDay of [0, 1, 5]) {
      const als: Al[] = [
        { inv: 0, amt: 10000, appliedDay: 0, voidAt: dayStart(0).getTime() + 3_600_000 },
        { inv: 0, amt: 10000, appliedDay: reDay, voidAt: null },
      ];
      const e = build(invs, pay, als);
      expect(isBalanced(e), `re-apply day ${reDay}`).toBe(true);
      const b = balancesByAccount(e, dayEnd(reDay + 1));
      expect(b.get(ACCOUNT_UNEARNED) ?? 0).toBe(0);
      expect(b.get(ACCOUNT_AR) ?? 0).toBe(0);
      expect(b.get(ACCOUNT_CASH)).toBe(10000);
      expect(0 - (b.get(glAccount(GL)) ?? 0)).toBe(10000);
    }
    // partial re-apply: 100 applied, removed, 60 applied again -> 40 unapplied, A/R 40
    const als: Al[] = [{ inv: 0, amt: 10000, appliedDay: 0, voidAt: dayStart(0).getTime() + 3_600_000 }, { inv: 0, amt: 6000, appliedDay: 0, voidAt: null }];
    const e = build(invs, pay, als);
    const b = balancesByAccount(e, dayEnd(0));
    expect(isBalanced(e)).toBe(true);
    expect(0 - (b.get(ACCOUNT_UNEARNED) ?? 0)).toBe(4000);
    expect(b.get(ACCOUNT_AR)).toBe(4000);
    // void payment after removing everything, with a fee
    const feePay = { recvDay: 0, amt: 10000, fee: 300, voidAt: dayStart(1).getTime() + 1000 };
    const e2 = build(invs, feePay, [{ inv: 0, amt: 10000, appliedDay: 0, voidAt: dayStart(0).getTime() + 3_600_000 }, { inv: 0, amt: 10000, appliedDay: 0, voidAt: dayStart(0).getTime() + 7_200_000 }]);
    expect(isBalanced(e2)).toBe(true);
    const b2 = balancesByAccount(e2, dayEnd(2));
    expect(b2.get(ACCOUNT_UNEARNED) ?? 0).toBe(0);
    expect(b2.get(ACCOUNT_CASH) ?? 0).toBe(0);
    expect(b2.get(ACCOUNT_FEES) ?? 0).toBe(0);
    expect(b2.get(ACCOUNT_AR)).toBe(10000); // invoice still open
    // void the invoice too
    const e3 = build([{ ...invs[0]!, voidAt: dayStart(2).getTime() }], feePay, [{ inv: 0, amt: 10000, appliedDay: 0, voidAt: dayStart(0).getTime() + 3_600_000 }]);
    expect(isBalanced(e3)).toBe(true);
    const b3 = balancesByAccount(e3, dayEnd(3));
    expect(b3.get(ACCOUNT_AR) ?? 0).toBe(0);
    expect(b3.get(glAccount(GL)) ?? 0).toBe(0);
  });

  it("CAVEAT (known, pre-existing): as of 00:00 UTC of the receipt day, a same-day removal is not yet visible, so that one instant shows the old application AND the new one", () => {
    const invs: Inv[] = [{ id: "I0", total: 10000, issueDay: 0, voidAt: null }];
    const pay = { recvDay: 0, amt: 10000, fee: 0, voidAt: null };
    const als: Al[] = [{ inv: 0, amt: 10000, appliedDay: 0, voidAt: dayStart(0).getTime() + 3_600_000 }, { inv: 0, amt: 10000, appliedDay: 0, voidAt: null }];
    const b = balancesByAccount(build(invs, pay, als), dayStart(0)); // exactly midnight: events dated midnight are in, the 01:00 void is not
    // not a state any real day-end view can show; recorded here so a task 1.12 consumer uses END of day
    expect((b.get(ACCOUNT_AR) ?? 0)).toBe(10000 - 20000);
    expect(isBalanced(build(invs, pay, als), )).toBe(true);
  });
});
