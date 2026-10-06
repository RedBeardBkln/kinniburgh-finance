// TESTER (independent) coverage for the business-use percentage decision (X6, engine ty2025-1b.9).
// Own BigInt oracle for line 25 (no import of any engine rounding helper), a random sweep of multi-account lines, a
// differential of the downstream lines against the same facts at 100%, a percent-text matrix, the non-canonical stored-row
// pitfall of applyOverrides, and the default-decision gate flipping after recording.

import { describe, expect, it } from "vitest";
import { BUSINESS_USE_ACCOUNTS, formatBusinessUsePercent, parseBusinessUsePercent } from "@/lib/tax2025/business-use";
import { applyOverrides, decisionsFromOverrides, type OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { unresolvedChoicesCheck } from "@/lib/tax-review/l1/engine-state";
import { isGatingFinding } from "@/lib/tax-review/gate";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { previewBusinessUse } from "@/lib/tax2025/override-input";
import type { L1Context } from "@/lib/tax-review/l1/context";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { LineKey } from "@/lib/tax2025/types";
import { fullFacts1b, gl } from "./tax2025-fixtures";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const NAME_ORIG = "Utilities:Internet & TV services";
const NAME_ALIAS = "Utilities:Internet & Phone";

interface Acct {
  code: string;
  name: string;
  cents: number;
  flagged: boolean;
}

function factsOf(accts: Acct[], revenueCents = 6_000_000): Ty2025Facts {
  const f = fullFacts1b();
  const sc = f.income.scheduleC;
  sc.glLines = [gl("4000", "Services", "revenue", revenueCents), ...sc.glLines.filter((g) => g.code !== "4000"), ...accts.map((a) => gl(a.code, a.name, "expense", a.cents))];
  return f;
}

/** Independent oracle: sum(raw cents x tenths) over the line (others x 1000), divided by 100,000, half up, ONCE (safe integers: < 2^53). */
function oracleOnce(accts: Acct[], tenths: number): number {
  let n = 0;
  for (const a of accts) n += a.cents * (a.flagged ? tenths : 1000);
  return Math.floor((n + 50_000) / 100_000);
}
/** The WRONG way (round per account) - used only to prove the sweep can tell the two apart. */
function oraclePerAccount(accts: Acct[], tenths: number): number {
  let s = 0;
  for (const a of accts) s += Math.floor((a.cents * (a.flagged ? tenths : 1000) + 50_000) / 100_000);
  return s;
}

const PERCENTS = [0, 1, 333, 500, 700, 705, 999, 1000];
const AMOUNTS = [261_017, 100_100, 100_030, 1, 49, 50, 99, 100, 101, 12_345, 999_999, 5_000_000];

describe("TESTER: line 25 against an independent integer oracle", () => {
  it("every (amount, percent) pair on the single shared account: engine == oracle, also with another utilities account at 100%", () => {
    for (const cents of AMOUNTS) {
      for (const t of PERCENTS) {
        for (const other of [0, 10_040, 50]) {
          const accts: Acct[] = [{ code: "6100", name: NAME_ALIAS, cents, flagged: true }];
          if (other > 0) accts.push({ code: "6200", name: "Utilities:Electricity", cents: other, flagged: false });
          const r = computeTy2025Return(factsOf(accts), { businessUse: { internet_phone: { percentTenths: t, ...WHO } } });
          expect(r.lines["schc.25"]?.amount, `${cents}c @${t} other ${other}`).toBe(oracleOnce(accts, t));
        }
      }
    }
  });

  it("random multi-account lines (1-3 shared GL codes under both names + 0-3 plain utilities): engine == once-rounded oracle, never per-account", () => {
    let seed = 20261006;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const plainNames = ["Utilities:Electricity", "Utilities:Phone service", "Utilities:Water"];
    let onceDiffersFromPerAccount = 0;
    for (let i = 0; i < 250; i++) {
      const accts: Acct[] = [];
      const nFlag = 1 + rnd(3);
      for (let k = 0; k < nFlag; k++) accts.push({ code: `61${k}0`, name: k % 2 === 0 ? NAME_ALIAS : NAME_ORIG, cents: 1 + rnd(400_000), flagged: true });
      const nPlain = rnd(4);
      for (let k = 0; k < nPlain; k++) accts.push({ code: `62${k}0`, name: plainNames[k % plainNames.length]!, cents: 1 + rnd(200_000), flagged: false });
      const t = [0, 1, 250, 333, 500, 505, 700, 705, 999, 1000][rnd(10)]!;
      const f = factsOf(accts);
      const r = computeTy2025Return(f, { businessUse: { internet_phone: { percentTenths: t, ...WHO } } });
      const r100 = computeTy2025Return(f, {});
      const want = oracleOnce(accts, t);
      const want100 = oracleOnce(accts, 1000);
      if (want !== oraclePerAccount(accts, t)) onceDiffersFromPerAccount++;
      expect(r.lines["schc.25"]?.amount, `iter ${i} ${JSON.stringify(accts)} @${t}`).toBe(want);
      expect(r100.lines["schc.25"]?.amount, `iter ${i} @100`).toBe(want100);
      // differential: every downstream Schedule C line moves by exactly the line 25 difference
      const d = want100 - want;
      expect((r.lines["schc.31"]?.amount ?? NaN) - (r100.lines["schc.31"]?.amount ?? NaN), `iter ${i} schc.31`).toBe(d);
      expect((r.lines["schc.28"]?.amount ?? NaN) - (r100.lines["schc.28"]?.amount ?? NaN), `iter ${i} schc.28`).toBe(0 - d + 0);
      // booked = deductible + personal to the cent, for every shared account
      for (const row of r.scheduleC?.businessUse ?? []) expect(row.deductibleCents + row.personalCents).toBe(row.rawCents);
      expect(r.scheduleC?.businessUse.length).toBe(nFlag);
    }
    // the sweep is able to distinguish "round once" from "round per account"
    expect(onceDiffersFromPerAccount).toBeGreaterThan(5);
  });

  it("the plan's hand table: 2,610 / 1,827 / 1,840 / 869 / 0 / 501 / 601", () => {
    const one = (cents: number, t: number, extra: Acct[] = []): number | null | undefined =>
      computeTy2025Return(factsOf([{ code: "6100", name: NAME_ALIAS, cents, flagged: true }, ...extra]), { businessUse: { internet_phone: { percentTenths: t, ...WHO } } }).lines["schc.25"]?.amount;
    expect(one(261_017, 1000)).toBe(2610);
    expect(one(261_017, 700)).toBe(1827);
    expect(one(261_017, 705)).toBe(1840);
    expect(one(261_017, 333)).toBe(869);
    expect(one(261_017, 0)).toBe(0);
    expect(one(100_100, 500)).toBe(501);
    expect(one(100_030, 500, [{ code: "6200", name: "Utilities:Electricity", cents: 10_040, flagged: false }])).toBe(601);
  });

  it("the personal-portion note is plain: informational, nothing changed in the books, no bookkeeping 'owner draw' wording", () => {
    const r = computeTy2025Return(factsOf([{ code: "6100", name: NAME_ALIAS, cents: 261_017, flagged: true }]), { businessUse: { internet_phone: { percentTenths: 700, ...WHO } } });
    const rec = r.results.find((x) => x.decision?.id === "X6")?.alternatives?.find((a) => a.id === "recorded");
    expect(rec?.effect?.note).toContain("The other $783.05 is personal: not deducted, not a Schedule C amount (informational; nothing is changed in the books).");
    expect(JSON.stringify(r.results)).not.toMatch(/owner.?draw/i);
  });

  it("a recorded 62.50 reaches the engine as 62.5% (canonical), like 62.5", () => {
    const parsed = parseBusinessUsePercent("62.50");
    expect(parsed.ok && parsed.canonical).toBe("62.5");
    const tenths = parsed.ok ? parsed.tenths : -1;
    const r = computeTy2025Return(factsOf([{ code: "6100", name: NAME_ALIAS, cents: 261_017, flagged: true }]), { businessUse: { internet_phone: { percentTenths: tenths, ...WHO } } });
    expect(r.decisions.find((d) => d.id === "X6")?.chosen).toBe("62.5%");
    expect(r.lines["schc.25"]?.amount).toBe(oracleOnce([{ code: "6100", name: NAME_ALIAS, cents: 261_017, flagged: true }], 625));
  });
});


describe("TESTER: percent text parse / canonical (the one rule the dialog and the server action share)", () => {
  const ok = (text: string, tenths: number, canonical: string): void => {
    const p = parseBusinessUsePercent(text);
    expect(p.ok, JSON.stringify(text)).toBe(true);
    if (p.ok) {
      expect(p.tenths, JSON.stringify(text)).toBe(tenths);
      expect(p.canonical, JSON.stringify(text)).toBe(canonical);
    }
  };
  const bad = (text: string): void => {
    const p = parseBusinessUsePercent(text);
    expect(p.ok, JSON.stringify(text)).toBe(false);
    if (!p.ok) expect(p.error).toBe("Enter a percentage from 0 to 100, with at most one decimal.");
  };
  it("accepts and canonicalises", () => {
    ok("70", 700, "70");
    ok("70.0", 700, "70");
    ok(" 70 ", 700, "70");
    ok("70%", 700, "70");
    ok(" 70 % ", 700, "70");
    ok("070", 700, "70");
    ok("70.5", 705, "70.5");
    ok("0", 0, "0");
    ok("0.0", 0, "0");
    ok("000.5", 5, "0.5");
    ok("100", 1000, "100");
    ok("100.0", 1000, "100");
    ok("0.1", 1, "0.1");
    ok("99.9", 999, "99.9");
    ok("33.3", 333, "33.3");
    ok("70\n", 700, "70");
    // a trailing zero is not a second decimal: 62.50 is 62.5 (stored canonically), 70.00 is 70
    ok("62.50", 625, "62.5");
    ok("70.50", 705, "70.5");
    ok("70.00", 700, "70");
    ok("100.00", 1000, "100");
    ok("0.50", 5, "0.5");
  });
  it("refuses everything else with the one plain message", () => {
    for (const t of ["", " ", "abc", "-1", "-0", "+70", "101", "100.1", "100.01", "100.50", "1000", "70.55", "70.505", "70.05","1e1", "1e2", ".5", "70.", "70,5", "1,0", "7 0", "70 .5", "NaN", "Infinity", "0x46", "70%%", "%70", "٧٠", "７０", "70٪", "70 percent", "7O", "70.5.1", "--70", "null", "undefined"]) bad(t);
  });
  it("format reads back what parse stored", () => {
    for (let t = 0; t <= 1000; t++) {
      const f = formatBusinessUsePercent(t);
      const p = parseBusinessUsePercent(f);
      expect(p.ok && p.tenths).toBe(t);
    }
    expect(formatBusinessUsePercent(705)).toBe("70.5%");
    expect(formatBusinessUsePercent(1000)).toBe("100%");
    expect(formatBusinessUsePercent(0)).toBe("0%");
  });
});

describe("TESTER: stored rows that are not canonical never raise a false blocking 'not reflected' item", () => {
  const row = (valueText: string): OverrideRow => ({
    id: "r1",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: "businessUse.internet_phone",
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText,
    computedSnapshot: { status: "default_undecided", cents: null, engineVersion: "ty2025-1b.9" },
    authority: "owner",
    reason: "Bill split and usage log.",
    setByName: "Eric",
    setAt: new Date("2026-10-06T16:00:00.000Z"),
    archivedAt: null,
  });
  const f = factsOf([{ code: "6100", name: NAME_ALIAS, cents: 261_017, flagged: true }]);
  it("'70', '70%', '070', '70.0', ' 70 ' all apply 70% and the effective view has no blocking override item", () => {
    for (const v of ["70", "70%", "070", "70.0", " 70 "]) {
      const rows = [row(v)];
      const base = computeTy2025Return(f, decisionsFromOverrides(rows));
      const eff = applyOverrides(base, rows);
      expect(base.lines["schc.25"]?.amount, v).toBe(1827);
      expect(eff.openItems.filter((i) => i.severity === "blocking" && i.id.startsWith("override-")), v).toEqual([]);
      expect(eff.orphans, v).toEqual([]);
      expect(eff.decisions.find((d) => d.id === "X6")?.status, v).toBe("decided");
    }
  });
  it("two rows for the list key with different versions: the highest version wins and the lower never leaks in", () => {
    const v1 = { ...row("70"), id: "a", version: 1, archivedAt: new Date("2026-10-06T17:00:00.000Z") };
    const v2 = { ...row("50"), id: "b", version: 2 };
    const d = decisionsFromOverrides([v1, v2]);
    expect(d.businessUse?.internet_phone?.percentTenths).toBe(500);
  });
});

describe("TESTER: the default-decision gate flips red -> green once a percentage is recorded", () => {
  const f = factsOf([{ code: "6100", name: NAME_ALIAS, cents: 261_017, flagged: true }]);
  const gate = async (decisions: Parameters<typeof computeTy2025Return>[1]): Promise<boolean> => {
    const ret = computeTy2025Return(f, decisions);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Test" });
    const out = await unresolvedChoicesCheck.run({ ret, view, facts: f, raw: null } as unknown as L1Context);
    return out.some((x) => x.check.startsWith("L1.D2.decision") && x.ruleTag === "X6" && isGatingFinding(x));
  };
  it("undecided: gating; 0 / 70 / 100 recorded: not gating", async () => {
    expect(await gate({})).toBe(true);
    for (const t of [0, 700, 1000]) expect(await gate({ businessUse: { internet_phone: { percentTenths: t, ...WHO } } }), String(t)).toBe(false);
  });
});

describe("TESTER: no change to a return without the account (byte-identical lines, no X6)", () => {
  it("fullFacts1b without the account has no X6, no businessUse rows and an unchanged line set", () => {
    const r = computeTy2025Return(fullFacts1b(), {});
    expect(r.decisions.some((d) => d.id === "X6")).toBe(false);
    expect(r.scheduleC?.businessUse ?? []).toEqual([]);
    expect(r.results.some((x) => x.ruleId.startsWith("schedule-c-business-use"))).toBe(false);
    expect(BUSINESS_USE_ACCOUNTS.map((a) => a.decisionId)).toEqual(["X6"]);
    const keys = Object.keys(r.lines) as LineKey[];
    expect(keys.length).toBeGreaterThan(400);
  });
});

describe("TESTER: the dialog's live preview equals the engine (integer helper vs Decimal rule)", () => {
  it("previewBusinessUse.lineDollars / atFullDollars / personalCents == the engine's line 25, line at 100% and detail, on a random sweep incl. half-cent edges", () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const flagged = i < 40 ? [1, 2, 3, 5, 49, 50, 51, 99, 100, 101][i % 10]! : 1 + rnd(900_000);
      const other = rnd(3) === 0 ? 0 : 1 + rnd(300_000);
      const t = i < 40 ? [1, 5, 25, 50, 125, 500, 505, 995][i % 8]! : rnd(1001);
      const accts: Acct[] = [{ code: "6100", name: NAME_ALIAS, cents: flagged, flagged: true }];
      if (other > 0) accts.push({ code: "6200", name: "Utilities:Electricity", cents: other, flagged: false });
      const r = computeTy2025Return(factsOf(accts), { businessUse: { internet_phone: { percentTenths: t, ...WHO } } });
      const p = previewBusinessUse({ flaggedCents: flagged, otherCents: other, tenths: t, lineLabel: "Schedule C line 25" });
      const row = r.scheduleC?.businessUse[0];
      expect(p.lineDollars, `#${i} ${flagged}/${other}@${t}`).toBe(r.lines["schc.25"]?.amount);
      expect(p.atFullDollars, `#${i} full`).toBe(row?.lineAtFullDollars);
      expect(p.personalCents, `#${i} personal`).toBe(row?.personalCents);
    }
  });
});
