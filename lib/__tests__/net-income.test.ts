import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  employerTokens,
  matchDeposits,
  resolveNetIncome,
  payTimingNote,
  formatMoneyDecimal,
  unreadableNetInfo,
  type DepositRow,
  type IncomeSourceInput,
  type StubRow,
} from "@/lib/net-income";

const TODAY = new Date("2026-10-09T12:00:00Z");
const ACCT = "acct-checking";
const ENT = "ent-personal";

function dep(date: string, amount: string, payee: string | null, accountId = ACCT, entityId = ENT): DepositRow {
  return { postedAt: new Date(`${date}T00:00:00Z`), amount: new Decimal(amount), payee, accountId, entityId };
}

const eric: IncomeSourceInput = {
  id: "src-eric",
  accountId: ACCT,
  entityId: ENT,
  description: "payroll (Alpine Bio Inc)",
  cadence: "semi_monthly",
  dayRules: { daysOfMonth: [15, 31] },
  amount: new Decimal("9000"),
  active: true,
};
const eva: IncomeSourceInput = {
  id: "src-eva",
  accountId: ACCT,
  entityId: ENT,
  description: "payroll (Seacoast Mushrooms LLC)",
  cadence: "biweekly",
  dayRules: { intervalDays: 14, anchorDate: "2026-08-28" },
  amount: new Decimal("2555"),
  active: true,
};

const ericDeposits = [
  dep("2026-07-13", "6064.85", "alpine bio inc payroll"),
  dep("2026-07-29", "6064.86", "alpine bio inc payroll"),
  dep("2026-08-12", "6064.87", "alpine bio inc payroll"),
  dep("2026-08-28", "6064.85", "alpine bio inc payroll"),
  dep("2026-09-14", "6064.86", "alpine bio inc payroll"),
  dep("2026-09-28", "6064.87", "alpine bio inc payroll"),
];
// Eva's real deposits are Wednesdays every 14 days.
const evaDeposits = [
  dep("2026-07-29", "2150.94", "seacoast mushroo payroll"),
  dep("2026-08-12", "1700.68", "seacoast mushroo payroll"),
  dep("2026-08-26", "2089.45", "seacoast mushroo payroll"),
  dep("2026-09-09", "2043.58", "seacoast mushroo payroll"),
  dep("2026-09-23", "2259.28", "seacoast mushroo payroll"),
  dep("2026-10-07", "1817.30", "seacoast mushroo payroll"),
];
const noise = [
  dep("2026-09-20", "943.74", "iaic claim pymt"),
  dep("2026-09-21", "914.74", "venmo"),
];

describe("employerTokens", () => {
  it("takes the parenthetical, lower-cased, without generic company words", () => {
    expect(employerTokens("payroll (Alpine Bio Inc)")).toEqual(["alpine", "bio"]);
    expect(employerTokens("payroll (Seacoast Mushrooms LLC)")).toEqual(["seacoast", "mushrooms"]);
  });
  it("falls back to the stub employer when the description has no parenthetical", () => {
    expect(employerTokens("Eva paycheck", "Seacoast Mushrooms LLC")).toEqual(["seacoast", "mushrooms"]);
  });
  it("gives no tokens for a description with nothing to match", () => {
    expect(employerTokens("Eric payroll")).toEqual([]);
  });
});

describe("matchDeposits", () => {
  it("matches a truncated bank payee (mushroo) and ignores other inflows", () => {
    const rows = matchDeposits(eva, employerTokens(eva.description), [...evaDeposits, ...noise]);
    expect(rows).toHaveLength(6);
  });
  it("does not need the word payroll", () => {
    const rows = matchDeposits(eric, ["alpine", "bio"], [dep("2026-09-14", "6064.86", "alpine bio inc")]);
    expect(rows).toHaveLength(1);
  });
  it("ignores refunds (negative), transfers' other accounts and other entities", () => {
    const rows = matchDeposits(eric, ["alpine", "bio"], [
      dep("2026-09-14", "-6064.86", "alpine bio inc payroll"),
      dep("2026-09-14", "6064.86", "alpine bio inc payroll", "other-account"),
      dep("2026-09-14", "6064.86", "alpine bio inc payroll", ACCT, "other-entity"),
      dep("2026-09-14", "6064.86", null),
    ]);
    expect(rows).toHaveLength(0);
  });
  it("two sources in ONE account do not cross-match", () => {
    const all = [...ericDeposits, ...evaDeposits];
    expect(matchDeposits(eric, ["alpine", "bio"], all)).toHaveLength(6);
    expect(matchDeposits(eva, ["seacoast", "mushrooms"], all)).toHaveLength(6);
    expect(matchDeposits(eva, ["seacoast", "mushrooms"], all).every((d) => d.payee?.startsWith("seacoast"))).toBe(true);
  });
  it("a short payee word (under 5 characters) is not treated as a truncation", () => {
    expect(matchDeposits(eric, ["alpine", "bio"], [dep("2026-09-14", "10", "alpine bi payroll")])).toHaveLength(0);
  });
});

describe("resolveNetIncome - deposits", () => {
  it("Eric-like stable deposits: median 6064.86, not 'about'", () => {
    const info = resolveNetIncome(eric, [...ericDeposits, ...evaDeposits, ...noise], [], TODAY);
    expect(info.basis).toBe("deposits");
    expect(info.net.toFixed(2)).toBe("6064.86");
    expect(info.net).toBeInstanceOf(Decimal);
    expect(info.variable).toBe(false);
    expect(info.samples).toBe(6);
    expect(info.assumption).toBe(false);
    expect(info.label).toBe("take-home $6,064.86, from your last 6 deposits");
    expect(info.label).not.toMatch(/about/);
    expect(info.gross.toFixed(2)).toBe("9000.00");
  });
  it("Eva-like variable deposits: median of 6, range, 'about'", () => {
    const info = resolveNetIncome(eva, [...ericDeposits, ...evaDeposits, ...noise], [], TODAY);
    expect(info.basis).toBe("deposits");
    expect(info.net.toFixed(2)).toBe("2066.52");
    expect(info.variable).toBe(true);
    expect(info.min!.toFixed(2)).toBe("1700.68");
    expect(info.max!.toFixed(2)).toBe("2259.28");
    expect(info.label).toBe(
      "about $2,066.52 take-home (usually $1,700.68 to $2,259.28), median of your last 6 deposits"
    );
  });
  it("uses only the 6 newest deposits and an odd count takes the middle value", () => {
    const older = dep("2026-06-01", "5000", "alpine bio inc payroll");
    const info = resolveNetIncome(eric, [older, ...ericDeposits.slice(0, 5)], [], TODAY);
    expect(info.samples).toBe(6);
    expect(info.min!.toFixed(2)).toBe("5000.00");
    const odd = resolveNetIncome(eric, ericDeposits.slice(0, 5), [], TODAY);
    expect(odd.samples).toBe(5);
    expect(odd.net.toFixed(2)).toBe("6064.86");
  });
  it("needs at least 3 deposits", () => {
    const info = resolveNetIncome(eric, ericDeposits.slice(0, 2), [], TODAY);
    expect(info.basis).toBe("gross_unknown");
  });
  it("a stale newest deposit is not used", () => {
    const old = ericDeposits.map((d) => ({ ...d, postedAt: new Date(d.postedAt.getTime() - 120 * 86400000) }));
    expect(resolveNetIncome(eric, old, [], TODAY).basis).toBe("gross_unknown");
  });
  it("a deposit above gross (or far below it) is ignored", () => {
    const info = resolveNetIncome(
      eric,
      [...ericDeposits.slice(3, 6), dep("2026-10-01", "9800", "alpine bio inc payroll"), dep("2026-10-02", "100", "alpine bio inc payroll")],
      [],
      TODAY
    );
    expect(info.samples).toBe(3);
    expect(info.max!.toFixed(2)).toBe("6064.87");
  });
  it("Decimal arithmetic: no float drift in the median of two middle values", () => {
    const d = [
      dep("2026-09-01", "0.10", "alpine bio inc"),
      dep("2026-09-02", "0.20", "alpine bio inc"),
      dep("2026-09-03", "0.20", "alpine bio inc"),
      dep("2026-09-04", "0.30", "alpine bio inc"),
    ];
    const src = { ...eric, amount: new Decimal("0.5") };
    const info = resolveNetIncome(src, d, [], TODAY);
    expect(info.net.toString()).toBe("0.2");
  });
});

describe("resolveNetIncome - paystub and gross fallback", () => {
  const ericStub: StubRow = {
    employerName: "Alpine Bio Inc",
    payDate: new Date("2026-09-28T00:00:00Z"),
    payFrequency: "semi_monthly",
    grossPayCents: 900000,
    netPayCents: 606485,
    depositAccountId: null,
  };
  it("2 deposits fall back to the confirmed stub", () => {
    const info = resolveNetIncome(eric, ericDeposits.slice(0, 2), [ericStub], TODAY);
    expect(info.basis).toBe("paystub");
    expect(info.net.toFixed(2)).toBe("6064.85");
    expect(info.label).toBe("take-home $6,064.85 from your confirmed paystub of Sep 28 (no recent deposits matched)");
    expect(info.assumption).toBe(false);
  });
  it("a stub whose gross is not the source's amount is not used", () => {
    const info = resolveNetIncome(eric, [], [{ ...ericStub, grossPayCents: 800000 }], TODAY);
    expect(info.basis).toBe("gross_unknown");
  });
  it("a stub naming another deposit account is not used", () => {
    const info = resolveNetIncome(eric, [], [{ ...ericStub, depositAccountId: "someone-else" }], TODAY);
    expect(info.basis).toBe("gross_unknown");
  });
  it("matches a stub by gross and frequency when the description has no employer", () => {
    const src = { ...eric, description: "Eric paycheck" };
    const info = resolveNetIncome(src, [], [ericStub], TODAY);
    expect(info.basis).toBe("paystub");
  });
  it("uses the stub employer to find deposits for a description without one", () => {
    const src = { ...eric, description: "Eric paycheck" };
    const info = resolveNetIncome(src, ericDeposits, [ericStub], TODAY);
    expect(info.basis).toBe("deposits");
  });
  it("a stub with no net pay is ignored", () => {
    const info = resolveNetIncome(eric, [], [{ ...ericStub, netPayCents: null }], TODAY);
    expect(info.basis).toBe("gross_unknown");
  });
  it("newest stub wins", () => {
    const older = { ...ericStub, payDate: new Date("2026-08-01T00:00:00Z"), netPayCents: 500000 };
    const info = resolveNetIncome(eric, [], [older, ericStub], TODAY);
    expect(info.net.toFixed(2)).toBe("6064.85");
  });
  it("nothing known: gross, flagged as an assumption", () => {
    const info = resolveNetIncome(eric, [], [], TODAY);
    expect(info.basis).toBe("gross_unknown");
    expect(info.net.toFixed(2)).toBe("9000.00");
    expect(info.assumption).toBe(true);
    expect(info.label).toContain("take-home unknown");
    expect(info.label).toContain("gross $9,000.00");
    // the phrase appears once in the label (the Forecast row prints the label as is, with no prefix of its own)
    expect(info.label.split("take-home unknown").length).toBe(2);
  });
  it("unreadableNetInfo is gross, flagged, with its own label", () => {
    const info = unreadableNetInfo(eric);
    expect(info.assumption).toBe(true);
    expect(info.label).toContain("could not be read");
  });
});

describe("formatMoneyDecimal", () => {
  it("formats with commas and cents", () => {
    expect(formatMoneyDecimal(new Decimal("1234567.5"))).toBe("$1,234,567.50");
    expect(formatMoneyDecimal(new Decimal("0"))).toBe("$0.00");
    expect(formatMoneyDecimal(new Decimal("-12.345"))).toBe("-$12.35");
  });
});

describe("payTimingNote", () => {
  it("Eva: Wednesday deposits against a Friday anchor -> offset 2 days, suggests Wed Aug 26, nothing changed", () => {
    const before = JSON.stringify(eva.dayRules);
    const info = resolveNetIncome(eva, evaDeposits, [], TODAY);
    const t = info.timing;
    expect(t?.kind).toBe("offset");
    if (t?.kind !== "offset") throw new Error("expected offset");
    expect(t.depositWeekday).toBe(3);
    expect(t.scheduleWeekday).toBe(5);
    expect(t.days).toBe(2);
    expect(t.suggestedAnchor).toBe("2026-08-26");
    expect(t.text).toContain("2 days after");
    expect(t.text).toContain("Nothing was changed");
    // When the schedule lands AFTER the money, the near-term double count is stated once.
    expect(t.text).toContain(
      "Until then, the first paycheck shown after today may already be in your balance, so near-term projections can be too high by about one paycheck."
    );
    expect(t.text.split("Until then").length).toBe(2);
    expect(JSON.stringify(eva.dayRules)).toBe(before);
  });
  it("Eric: deposits 1 to 3 days before the stated day -> irregular, informational", () => {
    const info = resolveNetIncome(eric, ericDeposits, [], TODAY);
    expect(info.timing?.kind).toBe("irregular");
    expect(info.timing?.text).toBe("Deposits arrive 1 to 3 days before the stated day; the forecast uses the stated day.");
  });
  it("needs at least 4 deposits", () => {
    expect(payTimingNote(eva, evaDeposits.slice(0, 3))).toBeNull();
  });
  it("no note when the deposit weekday equals the schedule weekday", () => {
    const src = { ...eva, dayRules: { intervalDays: 14, anchorDate: "2026-08-26" } };
    expect(payTimingNote(src, evaDeposits)).toBeNull();
  });
  it("no offset note when deposits do not share one weekday", () => {
    const mixed = evaDeposits.map((d, i) => (i === 0 ? { ...d, postedAt: new Date("2026-07-30T00:00:00Z") } : d));
    expect(payTimingNote(eva, mixed)).toBeNull();
  });
  it("same weekday but a different cycle phase is reported as irregular, not as an offset", () => {
    const src = { ...eva, dayRules: { intervalDays: 14, anchorDate: "2026-09-04" } }; // Friday, other week
    expect(payTimingNote(src, evaDeposits)?.kind).toBe("irregular");
  });
  it("monthly source with a constant lead is 'early'", () => {
    const src: IncomeSourceInput = { ...eric, cadence: "monthly", dayRules: { dayOfMonth: 15 } };
    const d = [
      dep("2026-06-12", "6000", "alpine bio inc"),
      dep("2026-07-12", "6000", "alpine bio inc"),
      dep("2026-08-12", "6000", "alpine bio inc"),
      dep("2026-09-12", "6000", "alpine bio inc"),
    ];
    const t = payTimingNote(src, d);
    expect(t?.kind).toBe("early");
    expect(t?.text).toBe("Deposits arrive 3 days before the stated day; the forecast uses the stated day.");
  });
});
