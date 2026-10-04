// Random household generator for the L2 oracle fuzz tests (NOT a test file). Builds a complete-looking Ty2025Facts from the golden
// household (every answer given, every "none" stated) and randomises incomes, documents, deductions, payments and answers across the
// ranges where the 2025 rules change behaviour (Social Security wage base, $200k / $250k Medicare, NIIT, SALT phase-down, QDCG
// bands, Schedule 1-A phase-outs, Connecticut table bands). Synthetic data only.

import type { BrokerBox, Ty2025Facts } from "@/lib/tax2025/facts";
import type { Ty2025Decisions } from "@/lib/tax2025/types";
import { ERIC_ID, EVA_ID, bill, dividend, fullFacts1b, gl, interest, owner, w2 } from "./tax2025-fixtures";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
/** Log-uniform integer between lo and hi (so small and large amounts are both common). */
const logUniform = (r: Rnd, lo: number, hi: number): number => Math.floor(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))));

const EXPENSE_ACCOUNTS: readonly string[] = [
  "Advertising & marketing",
  "Commissions & fees",
  "Contract labor",
  "Insurance:Business insurance",
  "Legal & accounting services:Accounting fees",
  "Office expenses:Office supplies",
  "Repairs & maintenance",
  "Supplies",
  "Business licences",
  "Utilities:Electricity",
  "Building & property rent",
  "Equipment rental",
  "General business expenses:Bank fees & service charges",
  "Interest paid:Business loan interest",
  "Meals",
  "Meals:Travel meals",
  "Travel:Airfare",
];

export interface Generated {
  facts: Ty2025Facts;
  decisions: Ty2025Decisions;
  /** Short tag of the dominant shape, for the coverage guard. */
  tags: string[];
}

export function randomHousehold(seed: number): Generated {
  const r = mulberry32(seed);
  const f = fullFacts1b();
  const tags: string[] = [];
  const decisions: Ty2025Decisions = {};

  // ── wages ──
  const level = pick(r, ["mid", "mid", "mid", "high", "very_high"] as const);
  tags.push(level);
  const wageMax = level === "mid" ? 200_000 : level === "high" ? 450_000 : 900_000;
  const docs = [] as ReturnType<typeof w2>[];
  let n = 0;
  for (const person of [ERIC_ID, EVA_ID]) {
    const jobs = pick(r, [0, 1, 1, 1, 2]);
    for (let j = 0; j < jobs; j++) {
      n += 1;
      const wages = logUniform(r, 5_000, Math.max(6_000, wageMax)) * 100 + int(r, 0, 99);
      const deferral = r() < 0.3 ? int(r, 0, 23_500) * 100 : 0;
      const box3 = wages + deferral;
      const ssBase = 17_610_000;
      const ss = Math.min(box3, ssBase);
      const medWages = box3;
      const med6 = Math.round(medWages * 0.0145) + (medWages > 20_000_000 ? Math.round((medWages - 20_000_000) * 0.009) : 0);
      docs.push(
        w2({
          docId: `w2-${n}`,
          employer: `Employer ${n}`,
          employerEin: `${10 + n}-${1000000 + n}`,
          personUserId: person,
          wagesCents: wages,
          fedWithheldCents: Math.round(wages * (0.05 + r() * 0.2)),
          socialSecurityWagesCents: ss,
          socialSecurityWithheldCents: Math.round(ss * 0.062),
          medicareWagesCents: medWages,
          medicareWithheldCents: med6,
          ctWithheldCents: Math.round(wages * r() * 0.05) + (r() < 0.2 ? 50 : 0),
          box12: deferral > 0 ? [{ code: "D", amountCents: deferral }] : [],
          retirementPlan: deferral > 0 ? true : null,
        })
      );
    }
  }
  if (docs.length === 0) {
    docs.push(w2({ docId: "w2-0", employer: "Employer 0", employerEin: "10-1000000", personUserId: EVA_ID, wagesCents: 4_000_000, socialSecurityWagesCents: 4_000_000, socialSecurityWithheldCents: 248_000, medicareWagesCents: 4_000_000, medicareWithheldCents: 58_000, ctWithheldCents: 100_000 }));
  }
  // the engine does not price Connecticut AGI between $24,001 and $102,000 (the DRS tables are not transcribed): keep the household above it
  const total = docs.reduce((a, d) => a + (d.wagesCents ?? 0), 0);
  if (total < 12_000_000) {
    const first = docs[0];
    if (first !== undefined) {
      const add = 12_000_000 - total;
      first.wagesCents = (first.wagesCents ?? 0) + add;
      first.socialSecurityWagesCents = Math.min((first.socialSecurityWagesCents ?? 0) + add, 17_610_000);
      first.socialSecurityWithheldCents = Math.round((first.socialSecurityWagesCents ?? 0) * 0.062);
      first.medicareWagesCents = (first.medicareWagesCents ?? 0) + add;
      first.medicareWithheldCents = Math.round((first.medicareWagesCents ?? 0) * 0.0145);
    }
  }
  f.income.w2s = docs;

  // ── interest and dividends ──
  const nInt = pick(r, [0, 1, 1, 2]);
  f.income.interest = [];
  for (let i = 0; i < nInt; i++) {
    f.income.interest.push(interest({ docId: `int-${i}`, box1Cents: logUniform(r, 1_000, 3_000_000) + int(r, 0, 99), box3Cents: r() < 0.15 ? int(r, 100, 90_000) : 0 }));
  }
  f.income.noInterestConfirmed = nInt === 0 ? owner(true) : { value: null, basis: null, refs: [] };
  const nDiv = pick(r, [0, 1, 1, 2]);
  f.income.dividends = [];
  for (let i = 0; i < nDiv; i++) {
    const a = logUniform(r, 1_000, 6_000_000) + int(r, 0, 99);
    const q = r() < 0.7 ? Math.floor(a * r()) : 0;
    f.income.dividends.push(dividend({ docId: `div-${i}`, box1aCents: a, box1bCents: q, box2aCents: r() < 0.25 ? logUniform(r, 1_000, 1_500_000) : 0, box5Cents: r() < 0.1 ? int(r, 100, 60_000) : 0 }));
  }
  f.income.noDividendsConfirmed = nDiv === 0 ? owner(true) : { value: null, basis: null, refs: [] };
  f.income.dividendBoxes2b2dConfirmedZero = true;

  // ── broker sales and carryovers ──
  const nBroker = pick(r, [0, 0, 1, 1, 2]);
  f.income.brokerSales = [];
  const adjustments = false; // the engine blocks on 'the broker could not know of an adjustment'
  for (let i = 0; i < nBroker; i++) {
    const boxes = (["A", "B", "D", "E"] as BrokerBox[]).filter(() => r() < 0.45);
    if (boxes.length === 0) boxes.push(pick(r, ["A", "D"] as BrokerBox[]));
    f.income.brokerSales.push({
      docId: `broker-${i}`,
      payer: `Broker ${i}`,
      basis: "doc_verified",
      legacyFormat: false,
      refs: [{ kind: "document", id: `broker-${i}`, label: "1099-B" }],
      summaryRead: true,
      signalled1099B: true,
      rows: boxes.map((box) => {
        const proceeds = logUniform(r, 1_000, 40_000_000) + int(r, 0, 99);
        const cost = Math.floor(proceeds * (0.3 + r() * 1.1));
        const wash = r() < 0.2 ? int(r, 100, Math.max(101, Math.floor(proceeds * 0.05))) : 0;
        return { form: "1099-B" as const, box, proceedsCents: proceeds, costCents: cost, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: wash, gainLossCents: null };
      }),
      sec1256AggregateCents: 0,
      forms1099DaPresent: false,
    });
  }
  const carryS = r() < 0.15 ? int(r, 100, 800_000) : 0;
  const carryL = r() < 0.15 ? int(r, 100, 800_000) : 0;
  f.returnAnswers.capitalGains = { carryoverShortCents: owner(carryS), carryoverLongCents: owner(carryL), salesComplete: owner(true), brokerAdjustments: owner(adjustments) };
  if (nBroker > 0 || carryS > 0 || carryL > 0) tags.push("schd");

  // ── Schedule C ──
  const sc = f.income.scheduleC;
  const revenue = r() < 0.1 ? 0 : logUniform(r, 1_000, 400_000) * 100 + int(r, 0, 99);
  const glLines = [gl("4000", "Services", "revenue", revenue)];
  const nExp = pick(r, [0, 1, 2, 3, 5, 8]);
  const used = new Set<string>();
  for (let i = 0; i < nExp; i++) {
    const name = pick(r, EXPENSE_ACCOUNTS);
    if (used.has(name)) continue;
    used.add(name);
    const cap = r() < 0.2 ? revenue * 1.4 + 500_000 : revenue * 0.4 + 200_000;
    glLines.push(gl(String(5000 + i), name, "expense", Math.max(100, Math.floor(r() * cap)) + int(r, 0, 99)));
  }
  if (r() < 0.15) glLines.push(gl("7000", "Other income:Interest earned", "revenue", int(r, 100, 90_000)));
  sc.glLines = glLines;
  sc.booksEmpty = false;
  const mileage = r() < 0.3;
  if (mileage) {
    sc.mileage = [
      { miles: int(r, 10, 9000), ratePerMile: "0.700", dateIso: "2025-03-01" },
      { miles: int(r, 10, 4000), ratePerMile: pick(r, ["0.700", "0.700", "0.67"]), dateIso: "2025-08-01" },
    ];
    sc.mileageNoneConfirmed = owner(false);
  }
  const home = pick(r, ["no", "no", "yes_exclusive"] as const);
  sc.homeOfficeEligibility = owner(home);
  if (home === "yes_exclusive") sc.homeOfficeSqft = owner(int(r, 50, 450));
  if (revenue > 0) tags.push("schc");

  // ── itemized deductions ──
  f.deductions.mortgages = [];
  {
    f.deductions.mortgages.push({
      docId: "m-1",
      lender: "Lender",
      basis: "doc_verified",
      legacyFormat: false,
      refs: [{ kind: "document", id: "m-1", label: "1098" }],
      interestCents: logUniform(r, 2_000, 60_000) * 100 + int(r, 0, 99),
      principalCents: int(r, 100_000, 700_000) * 100,
      originationDate: "2020-06-01",
      mortgageInsuranceCents: r() < 0.2 ? int(r, 10_000, 90_000) : null,
      pointsCents: r() < 0.1 ? int(r, 1_000, 300_000) : null,
      box10Cents: null,
      propertyAddress: "27 Old Barry Rd",
    });
  }
  const bills = [bill({ docId: "pt-1", label: "Town", address: "27 Old Barry Rd", paidInYearCents: logUniform(r, 1_000, 14_000) * 100 + int(r, 0, 99), kind: "primary_residence" })];
  const nVeh = pick(r, [0, 0, 1, 2, 3]);
  for (let i = 0; i < nVeh; i++) bills.push(bill({ docId: `pt-v${i}`, label: "Auto", address: null, paidInYearCents: int(r, 5_000, 90_000), kind: "motor_vehicle", taxType: "motor_vehicle" }));
  if (r() < 0.3) {
    bills.push(bill({ docId: "pt-arbor", label: "Arbor Rd", address: "56 Arbor Rd", paidInYearCents: int(r, 100_000, 1_400_000), kind: "other_real_estate" }));
    decisions.arborRoadPropertyTax = { chosen: pick(r, ["schedule_a", "capitalize"] as const), by: "t", at: "2026-10-01T00:00:00.000Z" };
    tags.push("arbor");
  }
  f.deductions.propertyTaxBills = bills;
  f.deductions.noDonationsConfirmed = owner(true);
  f.deductions.donations = [];
  if (r() < 0.4) {
    f.deductions.noDonationsConfirmed = { value: null, basis: null, refs: [] };
    const nd = pick(r, [1, 2, 3]);
    for (let i = 0; i < nd; i++) {
      f.deductions.donations.push({ id: `d${i}`, dateIso: "2025-06-01", recipient: "Charity", kind: pick(r, ["cash", "noncash"] as const), amountCents: int(r, 1_000, 900_000), substantiation: "receipt", receiptDocumentId: null });
    }
  }

  // ── answers: age / blind, tips, overtime, car loan ──
  for (const p of f.returnAnswers.people) {
    p.bornBefore1961 = owner(r() < 0.25);
    p.blind = owner(r() < 0.05);
    if (p.userId === EVA_ID && r() < 0.25) {
      p.tipsChoice = owner("some");
      p.tipsCents = owner(int(r, 100, 3_000_000));
    }
    const ot = r();
    if (ot < 0.2) {
      p.overtimeChoice = owner("premium");
      p.overtimeCents = owner(int(r, 100, 2_000_000));
    } else if (ot < 0.3) {
      p.overtimeChoice = owner("total");
      p.overtimeCents = owner(int(r, 300, 5_000_000));
    }
    p.validSsn = owner(r() < 0.9);
  }
  f.returnAnswers.magiExclusionsNone = owner(true);
  if (r() < 0.2) {
    f.returnAnswers.carLoan = { choice: owner("some"), qualifies: owner(true), interestPaidCents: owner(int(r, 10_000, 1_800_000)), deductedElsewhereCents: owner(r() < 0.2 ? int(r, 0, 5_000) : 0) };
  }

  // ── payments ──
  const estimates = [] as { paidOn: string; amountCents: number; appliesToTaxYear: number }[];
  if (r() < 0.5) {
    const k = pick(r, [1, 2, 4]);
    for (let i = 0; i < k; i++) estimates.push({ paidOn: pick(r, ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"]), amountCents: int(r, 10_000, 4_000_000), appliesToTaxYear: 2025 });
  }
  f.payments.federalEstimates = owner(estimates);
  f.payments.federalPriorYearOverpaymentApplied = owner(r() < 0.15 ? int(r, 100, 500_000) : 0);
  f.payments.federalExtensionPayment = owner(r() < 0.1 ? int(r, 100, 900_000) : 0);
  const ctEst = [] as { paidOn: string; amountCents: number; appliesToTaxYear: number }[];
  if (r() < 0.4) {
    const k = pick(r, [1, 2, 4]);
    for (let i = 0; i < k; i++) ctEst.push({ paidOn: pick(r, ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"]), amountCents: int(r, 10_000, 1_500_000), appliesToTaxYear: 2025 });
  }
  f.payments.ctEstimates = owner(ctEst);
  f.payments.ctPriorYearOverpaymentApplied = owner(r() < 0.15 ? int(r, 100, 300_000) : 0);
  f.payments.ctExtensionPayment = owner(r() < 0.1 ? int(r, 100, 500_000) : 0);
  f.payments.ctPriorYearBalancePaidIn2025 = owner(r() < 0.1 ? int(r, 100, 400_000) : 0);

  // ── Connecticut ──
  f.ct.useTax = owner(r() < 0.3 ? int(r, 100, 90_000) : 0);
  f.ct.additions = owner(r() < 0.1 ? int(r, 100, 900_000) : 0);
  f.ct.subtractions = owner(r() < 0.1 ? int(r, 100, 900_000) : 0);
  void sc;
  return { facts: f, decisions, tags };
}
