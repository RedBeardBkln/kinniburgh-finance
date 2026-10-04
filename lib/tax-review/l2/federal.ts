// L2 oracle: the federal return (Form 1040 and the schedules / forms that feed it), recomputed from the raw facts.
//
// Written from the printed 2025 forms and instructions (Form 1040, Schedules 1, 2, 3, A, B, C, D, SE, 1-A, Forms 8949, 8959, 8960,
// 8995, 6251 and the 1040 instructions' Tax Table, Tax Computation Worksheet and Qualified Dividends and Capital Gain Tax Worksheet).
// It shares no rule code with lib/tax2025/rules/** or lib/tax2025/return.ts: the only engine module it imports is the numeric constants
// registry. A printed line is a whole-dollar amount; a line that sums amounts read from the facts (which carry cents) is summed with
// its cents and rounded once, a line that adds or subtracts other PRINTED lines uses the printed whole-dollar amounts.
//
// What it does NOT recompute is listed on every run (Ledger.abstentions and the coverage table): fact resolution, the GL-account to
// Schedule C line map (the classified amounts are an input), Form 2210, HSA / IRA / saver's credit / foreign tax credit when the facts do
// not state them, and every case that needs a rule the sources do not verify. A line the oracle cannot recompute is null, never 0.

import { K } from "@/lib/tax2025/constants";
import { Ledger, noneGroupOf, type OracleInputs } from "@/lib/tax-review/l2/ledger";
import { addAll, bpOf, dollarsOfCents, max0, roundDivInt, roundMulCents, roundMulDollars, thousandthsOf, type Maybe } from "@/lib/tax-review/l2/money";
import { federalTaxCents, qdcgWorksheet, wholeDollars } from "@/lib/tax-review/l2/tables";

/** Schedule D / 1040 line 7a: sum the exact cents of the cells and round the line once (see computeScheduleD). */
const SCHD_COMBINE_EXACT = true;

const SCH2_RARE_KEYS = ["1a", "1b", "1c", "1d", "1e", "1f", "1y", "5", "6", "8", "9", "13", "14", "15", "16", "17a", "17b", "17c", "17d", "17e", "17f", "17g", "17h", "17i", "17j", "17k", "17l", "17m", "17n", "17o", "17p", "17q", "17z", "19"] as const;
const SCH1_PART1_RARE = ["1", "2a", "4", "5", "6", "7"] as const;
const SCH1_LINE8 = ["8a", "8b", "8c", "8d", "8e", "8f", "8g", "8h", "8i", "8j", "8k", "8l", "8m", "8n", "8o", "8p", "8q", "8r", "8s", "8t", "8u", "8v", "8z"] as const;
const SCH1_LINE24 = ["24a", "24b", "24c", "24d", "24e", "24f", "24g", "24h", "24i", "24j", "24k", "24z"] as const;
const SCH1_OTHER_ADJ = ["11", "12", "14", "18", "19a", "21", "23"] as const;
const SCH3_LINE6 = ["6a", "6b", "6c", "6d", "6f", "6g", "6h", "6i", "6j", "6k", "6l", "6m", "6z"] as const;
const SCH3_LINE13 = ["13a", "13b", "13c", "13d", "13z"] as const;
const SCHC_EXPENSE_LINES = ["8", "9", "10", "11", "13", "14", "15", "16a", "16b", "17", "18", "19", "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "27b"] as const;

type BoxKey = "A" | "B" | "C" | "D" | "E" | "F";
const SHORT_BOXES: readonly BoxKey[] = ["A", "B", "C"];

export function computeFederal(inp: OracleInputs): Ledger {
  const L = new Ledger();
  const { facts, decisions } = inp;
  const v = (k: string): Maybe<number> => L.get(k);

  /** A line the owner may state "none" for (or that is a rare item): 0 when stated none, otherwise the engine's amount as an input. */
  const rare = (key: string): Maybe<number> => {
    const g = noneGroupOf(key);
    if (g !== null) {
      const stated = (facts.statedNone as Record<string, { value: boolean | null } | undefined>)[g];
      if (stated?.value === true) return L.put(key, 0, [], `the owner stated "none" for ${g}`);
    }
    return L.engineInput(key, inp.engineAmount(key), "rare line taken from the engine");
  };
  const sumKeys = (keys: readonly string[]): Maybe<number> => addAll(...keys.map(v));
  const statedDollars = (leaf: { value: number | null }): Maybe<number> => (leaf.value === null ? null : dollarsOfCents(leaf.value));
  const nz = (x: number | null | undefined): number => x ?? 0;

  const ownerId = facts.income.scheduleC.ownerUserId.value;
  const w2s = facts.income.w2s;

  // ── Form 1040 lines 1a-1z: wages ────────────────────────────────────────────
  const wagesC = addAll(...w2s.map((w) => w.wagesCents));
  L.put("f1040.1a", wagesC === null ? null : dollarsOfCents(wagesC));
  const earnedKeys = ["1b", "1c", "1d", "1e", "1f", "1g", "1h", "1i"].map((id) => `f1040.${id}`);
  for (const k of earnedKeys) rare(k);
  L.put("f1040.1z", addAll(v("f1040.1a"), ...earnedKeys.slice(0, 7).map(v)), ["f1040.1a", ...earnedKeys.slice(0, 7)]);

  // ── Lines 2a-3b: interest and dividends (Schedule B) ────────────────────────
  const booksIntC = inp.schC === null ? null : inp.schC.booksInterest.reduce((a, b) => a + b.amountCents, 0);
  const int1 = addAll(...facts.income.interest.map((i) => i.box1Cents));
  const int3 = facts.income.interest.reduce((a, i) => a + nz(i.box3Cents), 0);
  const int8 = facts.income.interest.reduce((a, i) => a + nz(i.box8Cents), 0);
  const int9 = facts.income.interest.reduce((a, i) => a + nz(i.box9Cents), 0);
  const div1a = addAll(...facts.income.dividends.map((d) => d.box1aCents));
  const div1b = facts.income.dividends.reduce((a, d) => a + nz(d.box1bCents), 0);
  const div2a = facts.income.dividends.reduce((a, d) => a + nz(d.box2aCents), 0);
  const div5 = facts.income.dividends.reduce((a, d) => a + nz(d.box5Cents), 0);
  const div11 = facts.income.dividends.reduce((a, d) => a + nz(d.box11Cents), 0);
  L.put("f1040.2a", dollarsOfCents(int8 + div11));
  const interestTotalC = int1 === null || booksIntC === null ? null : int1 + int3 + booksIntC;
  L.put("schb.2", interestTotalC === null ? null : dollarsOfCents(interestTotalC));
  rare("schb.3");
  L.put("schb.4", addAll(v("schb.2"), v("schb.3") === null ? null : -(v("schb.3") as number)), ["schb.2", "schb.3"]);
  L.put("f1040.2b", v("schb.4"), ["schb.4"]);
  L.put("f1040.3a", dollarsOfCents(div1b));
  L.put("schb.6", div1a === null ? null : dollarsOfCents(div1a));
  L.put("f1040.3b", v("schb.6"), ["schb.6"]);
  for (const id of ["4a", "4b", "5a", "5b", "6a", "6b"]) rare(`f1040.${id}`);

  // ── Schedule D / Form 8949 and 1040 line 7a ─────────────────────────────────
  const capDistC = div2a;
  const carryS = facts.returnAnswers.capitalGains.carryoverShortCents.value;
  const carryL = facts.returnAnswers.capitalGains.carryoverLongCents.value;
  const schD = computeScheduleD();
  function computeScheduleD(): { required: boolean; qdcgLine3: Maybe<number> } | null {
    const bs = facts.income.brokerSales;
    for (const b of bs) {
      if (!b.summaryRead && b.signalled1099B) {
        L.abstain("Schedule D / Form 8949", "a 1099-B whose sales summary was never read");
        return null;
      }
      if (b.forms1099DaPresent) {
        L.abstain("Schedule D / Form 8949", "Form 1099-DA reporting is not recomputed");
        return null;
      }
      if (b.sec1256AggregateCents !== null && b.sec1256AggregateCents !== 0) {
        L.abstain("Schedule D / Form 8949", "section 1256 contracts are not recomputed");
        return null;
      }
    }
    const cats = new Map<BoxKey, { proceeds: number; cost: number; wash: number }>();
    for (const b of bs) {
      for (const r of b.rows) {
        if (r.form !== "1099-B" || r.box === null || !["A", "B", "C", "D", "E", "F"].includes(r.box) || r.proceedsCents === null || r.costCents === null) {
          L.abstain("Schedule D / Form 8949", "a sales row is incomplete, not a 1099-B category, or prints no basis");
          return null;
        }
        if (nz(r.accruedMarketDiscountCents) !== 0) {
          L.abstain("Schedule D / Form 8949", "accrued market discount (Form 8949 code D) is not recomputed");
          return null;
        }
        const key = r.box as BoxKey;
        const cur = cats.get(key) ?? { proceeds: 0, cost: 0, wash: 0 };
        cur.proceeds += r.proceedsCents;
        cur.cost += r.costCents;
        cur.wash += nz(r.washSaleLossDisallowedCents);
        cats.set(key, cur);
      }
    }
    if (cats.size > 0 && (carryS === null || carryL === null)) {
      L.abstain("Schedule D / Form 8949", "the capital loss carryover answers are missing");
      return null;
    }
    const carryShort = carryS ?? 0;
    const carryLong = carryL ?? 0;
    const required = cats.size > 0 || carryShort > 0 || carryLong > 0;
    if (!required) {
      // Exception 1: Schedule D is not filed; line 7a is the capital gain distributions (1099-DIV box 2a)
      L.put("f1040.7a", dollarsOfCents(capDistC), [], "Schedule D not required: line 7a is the capital gain distributions");
      return { required: false, qdcgLine3: v("f1040.7a") };
    }
    const adjustments = facts.returnAnswers.capitalGains.brokerAdjustments.value;
    let stExact = 0;
    let ltExact = 0;
    for (const [box, c] of cats) {
      const gain = c.proceeds - c.cost + c.wash; // Form 8949 column (h) = (d) - (e) + (g)
      const short = SHORT_BOXES.includes(box);
      if (short) stExact += gain;
      else ltExact += gain;
      // lines 1a / 8a: basis reported and no adjustments (no Form 8949); every other category goes through a Form 8949 summary row
      const direct = (box === "A" || box === "D") && adjustments === false && c.wash === 0;
      const line = box === "A" ? (direct ? "1a" : "1b") : box === "B" ? "2" : box === "C" ? "3" : box === "D" ? (direct ? "8a" : "8b") : box === "E" ? "9" : "10";
      L.put(`schd.${line}.d`, dollarsOfCents(c.proceeds));
      L.put(`schd.${line}.e`, dollarsOfCents(c.cost));
      if (line !== "1a" && line !== "8a") L.put(`schd.${line}.g`, dollarsOfCents(c.wash));
      L.put(`schd.${line}.h`, dollarsOfCents(gain));
    }
    for (const id of ["4", "5", "11", "12", "18", "19"]) rare(`schd.${id}`);
    const l4 = nz(v("schd.4"));
    const l5 = nz(v("schd.5"));
    const l11 = nz(v("schd.11"));
    const l12 = nz(v("schd.12"));
    if (v("schd.4") === null || v("schd.5") === null || v("schd.11") === null || v("schd.12") === null) {
      L.abstain("Schedule D / Form 8949", "lines 4, 5, 11 and 12 are neither stated nor computed");
      return null;
    }
    L.put("schd.6", dollarsOfCents(carryShort));
    L.put("schd.14", dollarsOfCents(carryLong));
    L.put("schd.13", dollarsOfCents(div2a));
    const stNetC = stExact - carryShort + (l4 + l5) * 100;
    const ltNetC = ltExact + div2a - carryLong + (l11 + l12) * 100;
    const l7 = L.put("schd.7", dollarsOfCents(stNetC));
    const l15 = L.put("schd.15", dollarsOfCents(ltNetC));
    const l16 = L.put("schd.16", SCHD_COMBINE_EXACT ? dollarsOfCents(stNetC + ltNetC) : l7 === null || l15 === null ? null : l7 + l15);
    if (l16 === null || l15 === null) return null;
    // Schedule D line 21: the smaller of the loss on line 16 or $3,000 (shown as a positive amount); 1040 line 7a
    if (l16 < 0) {
      const l21 = Math.min(-l16, K.CAPITAL_LOSS_LIMIT_MFJ.value);
      L.put("schd.21", l21, ["schd.16"]);
      L.put("f1040.7a", -l21, ["schd.21"]);
    } else {
      L.put("f1040.7a", l16, ["schd.16"]);
    }
    const bothGains = l15 > 0 && l16 > 0;
    if (bothGains && (v("schd.18") !== 0 || v("schd.19") !== 0)) {
      L.abstain("Schedule D / Form 8949", "the Schedule D Tax Worksheet (28% rate gain / unrecaptured section 1250 gain) is not recomputed");
      return null;
    }
    return { required: true, qdcgLine3: bothGains ? Math.min(l15, l16) : 0 };
  }
  if (schD === null && !L.lines.has("f1040.7a")) L.put("f1040.7a", null);

  // ── Schedule C (net profit) ─────────────────────────────────────────────────
  const sc = facts.income.scheduleC;
  const det = inp.schC;
  let schCDone = false;
  if (det === null) {
    L.abstain("Schedule C", "the engine classified no Schedule C detail");
  } else if (det.unmapped.length > 0 || det.needsCpa.length > 0) {
    L.abstain("Schedule C", "some GL accounts are unmapped or need a decision, so the classified amounts are not final");
  } else if (det.cogsTotalCents !== 0) {
    L.abstain("Schedule C", "cost of goods sold (inventory) is not recomputed");
  } else if (det.vehicleActual.length > 0) {
    L.abstain("Schedule C", "actual vehicle expenses are not recomputed");
  } else if (sc.fixedAssets.length > 0 && !sc.fixedAssetsNoneConfirmed) {
    L.abstain("Schedule C", "depreciation of fixed assets (Form 4562) is not recomputed");
  } else {
    schCDone = true;
    const lineCents = (id: string): number => det.lines.filter((l) => l.lineId === id).reduce((a, l) => a + l.amountCents, 0);
    const l1 = L.put("schc.1", dollarsOfCents(lineCents("1")));
    const l2 = L.put("schc.2", dollarsOfCents(lineCents("2")));
    const l3 = L.put("schc.3", l1 === null || l2 === null ? null : l1 - l2, ["schc.1", "schc.2"]);
    const l4 = L.put("schc.4", 0, [], "no cost of goods sold");
    L.put("schc.5", l3 === null ? null : l3 - (l4 ?? 0), ["schc.3", "schc.4"]);
    const l6 = L.put("schc.6", dollarsOfCents(lineCents("6")));
    L.put("schc.7", addAll(v("schc.5"), l6), ["schc.5", "schc.6"]);
    rare("schc.12");
    rare("schc.27a");
    for (const id of SCHC_EXPENSE_LINES) {
      const key = `schc.${id}`;
      if (id === "24b") {
        // meals: 50% of the booked amount, applied once to the cent-accurate total
        const raw = det.lines.filter((l) => l.lineId === "24b").reduce((a, l) => a + l.accounts.reduce((s, x) => s + x.rawCents, 0), 0);
        L.put(key, roundMulCents(raw, bpOf(K.MEALS_DEDUCTIBLE_FRACTION.value)));
      } else if (id === "9") {
        // booked line 9 amounts plus the standard mileage deduction (miles x the rate captured with each entry)
        let tenthsOfCents = lineCents("9") * 10;
        let bad = false;
        for (const m of sc.mileage) {
          const th = thousandthsOf(m.ratePerMile);
          if (th === null) bad = true;
          else tenthsOfCents += m.miles * th;
        }
        if (bad) {
          L.abstain("Schedule C", "a mileage entry has a rate that is not a plain decimal");
          L.put(key, null);
        } else L.put(key, roundDivInt(tenthsOfCents, 1000));
      } else {
        L.put(key, dollarsOfCents(lineCents(id)));
      }
    }
    // line 27b is Part V line 48
    L.put("schc.48", v("schc.27b"), ["schc.27b"]);
    const expenseKeys = [...SCHC_EXPENSE_LINES.map((id) => `schc.${id}`), "schc.12", "schc.27a"];
    const l28 = L.put("schc.28", sumKeys(expenseKeys), expenseKeys);
    const l29 = L.put("schc.29", addAll(v("schc.7"), l28 === null ? null : -l28), ["schc.7", "schc.28"]);
    // line 30: business use of home. Simplified method only (decision X1 "simplified"): $5 per square foot up to 300, limited to line 29
    let l30: Maybe<number> = null;
    const elig = sc.homeOfficeEligibility.value;
    if (decisions.homeOffice !== "simplified") {
      L.abstain("Schedule C line 30", "the actual-expense method (Form 8829) is not recomputed");
    } else if (elig === "no") {
      l30 = 0;
    } else if (elig === "yes_exclusive" && sc.homeOfficeSqft.value !== null) {
      const simplified = Math.min(sc.homeOfficeSqft.value, K.HOME_OFFICE_MAX_SQFT.value) * K.HOME_OFFICE_RATE_PER_SQFT.value;
      l30 = l29 === null ? null : Math.min(simplified, max0(l29));
    } else {
      L.abstain("Schedule C line 30", "home office eligibility is shared use or not answered");
    }
    L.put("schc.30", l30, ["schc.29"]);
    L.put("schc.31", addAll(l29, l30 === null ? null : -l30), ["schc.29", "schc.30"]);
  }
  if (!schCDone) L.put("schc.31", null);

  // ── Schedule SE (the Schedule C owner) ──────────────────────────────────────
  let seTax: Maybe<number> = null;
  let seHalf: Maybe<number> = null;
  let seLine6: Maybe<number> = null;
  const profit = v("schc.31");
  if (ownerId === null) {
    L.abstain("Schedule SE", "the Schedule C owner is not identified");
  } else if (profit !== null) {
    L.put("se.2", profit, ["schc.31"]);
    for (const id of ["1a", "1b", "4b", "5a", "5b", "8b", "8c"]) rare(`se.${id}`);
    const l3 = L.put("se.3", profit + nz(v("se.1a")) + nz(v("se.1b")), ["se.2"]);
    const l4a = L.put("se.4a", l3 !== null && l3 > 0 ? roundMulDollars(l3, bpOf(K.SE_NET_EARNINGS_FACTOR.value)) : l3, ["se.3"]);
    const l4c = L.put("se.4c", l4a === null ? null : l4a + nz(v("se.4b")), ["se.4a"]);
    if (l4c !== null && l4c < K.SE_FLOOR.value) {
      // under $400: stop; no self-employment tax and no Schedule SE
      seTax = L.put("se.12", 0, ["se.4c"]);
      seHalf = L.put("se.13", 0, ["se.4c"]);
      seLine6 = 0;
      for (const id of ["4a", "4c", "6", "7", "8a", "8d", "9", "10", "11"]) L.lines.delete(`se.${id}`);
    } else if (l4c !== null) {
      seLine6 = L.put("se.6", l4c + nz(v("se.5b")), ["se.4c"]);
      L.put("se.7", K.SE_WAGE_BASE.value);
      const ownerW2 = w2s.filter((w) => w.personUserId === ownerId);
      const ssC = addAll(...ownerW2.map((w) => w.socialSecurityWagesCents));
      const tipsC = ownerW2.reduce((a, w) => a + nz(w.socialSecurityTipsCents), 0);
      const l8a = L.put("se.8a", ssC === null ? null : dollarsOfCents(ssC + tipsC));
      const l8d = L.put("se.8d", l8a === null ? null : l8a + nz(v("se.8b")) + nz(v("se.8c")), ["se.8a"]);
      const l9 = L.put("se.9", l8d === null ? null : max0(K.SE_WAGE_BASE.value - l8d), ["se.8d"]);
      const l10 = L.put("se.10", l9 === null || seLine6 === null ? null : l9 <= 0 ? 0 : roundMulDollars(Math.min(seLine6, l9), bpOf(K.SE_OASDI_RATE.value)), ["se.6", "se.9"]);
      const l11 = L.put("se.11", seLine6 === null ? null : roundMulDollars(seLine6, bpOf(K.SE_MEDICARE_RATE.value)), ["se.6"]);
      seTax = L.put("se.12", l10 === null || l11 === null ? null : l10 + l11, ["se.10", "se.11"]);
      seHalf = L.put("se.13", seTax === null ? null : roundMulDollars(seTax, 5000), ["se.12"]);
    }
  }

  // ── Schedule 1 ──────────────────────────────────────────────────────────────
  L.put("sch1.3", v("schc.31"), ["schc.31"]);
  for (const id of SCH1_PART1_RARE) rare(`sch1.${id}`);
  for (const id of SCH1_LINE8) rare(`sch1.${id}`);
  L.put("sch1.9", sumKeys(SCH1_LINE8.map((id) => `sch1.${id}`)), SCH1_LINE8.map((id) => `sch1.${id}`));
  const part1 = ["sch1.1", "sch1.2a", "sch1.3", "sch1.4", "sch1.5", "sch1.6", "sch1.7", "sch1.9"];
  L.put("sch1.10", sumKeys(part1), part1);
  L.put("f1040.8", v("sch1.10"), ["sch1.10"]);
  L.put("sch1.15", seHalf, ["se.13"]);
  // stated by the owner when the facts carry a value; otherwise the engine's own computation (Form 8889, the IRA worksheet) is taken as an input
  const adj = facts.adjustments;
  const stateOrEngine = (key: string, leaf: { value: number | null }): void => {
    if (leaf.value !== null) L.put(key, statedDollars(leaf), [], "stated by the owner");
    else L.engineInput(key, inp.engineAmount(key), "computed by the engine (not recomputed here)");
  };
  stateOrEngine("sch1.13", adj.hsa);
  stateOrEngine("sch1.16", adj.seRetirement);
  stateOrEngine("sch1.17", adj.seHealthInsurance);
  stateOrEngine("sch1.20", adj.ira);
  for (const id of SCH1_OTHER_ADJ) rare(`sch1.${id}`);
  for (const id of SCH1_LINE24) rare(`sch1.${id}`);
  L.put("sch1.25", sumKeys(SCH1_LINE24.map((id) => `sch1.${id}`)), SCH1_LINE24.map((id) => `sch1.${id}`));
  const adjKeys = ["sch1.11", "sch1.12", "sch1.13", "sch1.14", "sch1.15", "sch1.16", "sch1.17", "sch1.18", "sch1.19a", "sch1.20", "sch1.21", "sch1.23", "sch1.25"];
  L.put("sch1.26", sumKeys(adjKeys), adjKeys);

  // ── Total income, AGI ───────────────────────────────────────────────────────
  const incomeKeys = ["f1040.1z", "f1040.2b", "f1040.3b", "f1040.4b", "f1040.5b", "f1040.6b", "f1040.7a", "f1040.8"];
  L.put("f1040.9", sumKeys(incomeKeys), incomeKeys);
  L.put("f1040.10", v("sch1.26"), ["sch1.26"]);
  const agi = L.put("f1040.11a", addAll(v("f1040.9"), v("f1040.10") === null ? null : -(v("f1040.10") as number)), ["f1040.9", "f1040.10"]);
  L.put("f1040.11b", agi, ["f1040.11a"]);

  // ── Standard deduction ──────────────────────────────────────────────────────
  let stdTotal: Maybe<number> = null;
  {
    const people = facts.returnAnswers.people;
    let boxes: Maybe<number> = 0;
    for (const p of people) {
      if (p.bornBefore1961.value === null || p.blind.value === null) boxes = null;
      else if (boxes !== null) boxes += (p.bornBefore1961.value ? 1 : 0) + (p.blind.value ? 1 : 0);
    }
    if (boxes !== null) {
      const additional = boxes * K.STANDARD_DEDUCTION_ADDITIONAL_MFJ.value;
      L.put("std.additional", additional);
      stdTotal = L.put("std.total", K.STANDARD_DEDUCTION_MFJ.value + additional, ["std.additional"]);
    }
  }

  // ── Schedule A ──────────────────────────────────────────────────────────────
  let itemized: Maybe<number> = null;
  scheduleA();
  function scheduleA(): void {
    L.put("scha.2", agi, ["f1040.11b"]);
    rare("scha.1");
    const med = v("scha.1");
    if (med !== null && med > 0) {
      // Schedule A line 3: 7.5% of line 2 (printed on the form)
      const l3 = L.put("scha.3", agi === null ? null : roundMulDollars(agi, 750), ["scha.2"]);
      L.put("scha.4", l3 === null ? null : max0(med - l3), ["scha.1", "scha.3"]);
    } else if (med === 0) {
      L.put("scha.3", 0);
      L.put("scha.4", 0);
    } else {
      L.put("scha.3", null);
      L.put("scha.4", null);
    }
    // 5a: state income taxes paid in 2025: Connecticut withholding, Connecticut estimated payments paid in 2025, the 2024 balance paid in 2025
    const ctWh = addAll(...w2s.map((w) => w.ctWithheldCents));
    const ctEst = facts.payments.ctEstimates.value;
    const ctBal = facts.payments.ctPriorYearBalancePaidIn2025.value;
    let l5a: Maybe<number> = null;
    if (ctWh !== null && ctEst !== null && ctBal !== null) {
      const paid2025 = ctEst.filter((e) => e.paidOn.startsWith("2025")).reduce((a, e) => a + e.amountCents, 0);
      l5a = dollarsOfCents(ctWh + facts.payments.ctPaystubWithheldCents + paid2025 + ctBal);
    }
    L.put("scha.5a", l5a);
    // 5b / 5c: real estate and personal property taxes actually paid in 2025
    let l5b: Maybe<number> = 0;
    let l5c: Maybe<number> = 0;
    let realC = 0;
    let personalC = 0;
    for (const b of facts.deductions.propertyTaxBills) {
      if (b.kind === "unclassified" || b.paidInYearCents === null) {
        l5b = null;
        l5c = null;
        L.abstain("Schedule A lines 5b / 5c", "a property tax bill has no kind or no amount paid in 2025");
        break;
      }
      if (b.kind === "primary_residence") realC += b.paidInYearCents;
      else if (b.kind === "other_real_estate") {
        if (decisions.arbor === "schedule_a") realC += b.paidInYearCents;
      } else personalC += b.paidInYearCents; // motor_vehicle, other_personal_property
    }
    if (l5b !== null) l5b = dollarsOfCents(realC);
    if (l5c !== null) l5c = dollarsOfCents(personalC);
    L.put("scha.5b", l5b);
    L.put("scha.5c", l5c);
    const l5d = L.put("scha.5d", addAll(l5a, l5b, l5c), ["scha.5a", "scha.5b", "scha.5c"]);
    // 5e: State and Local Tax Deduction Worksheet (the $40,000 limit shrinks by 30% of MAGI over $500,000, never below $10,000)
    let l5e: Maybe<number> = null;
    if (l5d !== null && agi !== null) {
      if (l5d <= K.SALT_FLOOR.value) l5e = l5d;
      else {
        const over = max0(agi - K.SALT_PHASE_DOWN_THRESHOLD_MFJ.value);
        const cap = Math.max(K.SALT_FLOOR.value, K.SALT_CAP_MFJ.value - roundMulDollars(over, bpOf(K.SALT_PHASE_DOWN_RATE.value)));
        l5e = Math.min(l5d, cap);
      }
    }
    L.put("scha.5e", l5e, ["scha.5d", "scha.2"]);
    rare("scha.6");
    L.put("scha.7", addAll(l5e, v("scha.6")), ["scha.5e", "scha.6"]);
    // 8a: Form 1098 box 1 interest and box 6 points (mortgage insurance premiums, box 5, are not deductible for 2025)
    const mort = facts.deductions.mortgages;
    let l8a: Maybe<number> = 0;
    if (mort.some((m) => m.interestCents === null)) l8a = null;
    else if (mort.reduce((a, m) => a + nz(m.principalCents), 0) > K.MORTGAGE_DEBT_LIMIT.value * 100) {
      L.abstain("Schedule A line 8a", "the $750,000 home mortgage debt limit applies (proration not recomputed)");
      l8a = null;
    } else l8a = dollarsOfCents(mort.reduce((a, m) => a + nz(m.interestCents) + nz(m.pointsCents), 0));
    L.put("scha.8a", l8a);
    rare("scha.8b");
    rare("scha.8c");
    L.put("scha.8e", sumKeys(["scha.8a", "scha.8b", "scha.8c"]), ["scha.8a", "scha.8b", "scha.8c"]);
    rare("scha.9");
    L.put("scha.10", sumKeys(["scha.8e", "scha.9"]), ["scha.8e", "scha.9"]);
    // gifts: totals only when under the lowest AGI limit (20%): the percentage limits are not recomputed
    const cash = facts.deductions.donations.filter((d) => d.kind === "cash").reduce((a, d) => a + d.amountCents, 0);
    const noncash = facts.deductions.donations.filter((d) => d.kind === "noncash").reduce((a, d) => a + d.amountCents, 0);
    L.put("scha.11", dollarsOfCents(cash));
    L.put("scha.12", dollarsOfCents(noncash));
    rare("scha.13");
    const l14 = L.put("scha.14", sumKeys(["scha.11", "scha.12", "scha.13"]), ["scha.11", "scha.12", "scha.13"]);
    if (l14 !== null && agi !== null && l14 * 10_000 > agi * bpOf(K.CHARITY_LOWEST_AGI_LIMIT.value)) {
      L.abstain("Schedule A lines 11-14", "gifts exceed the lowest AGI percentage limit, so the limits are not recomputed");
      L.put("scha.14", null);
    }
    rare("scha.15");
    rare("scha.16");
    const total = ["scha.4", "scha.7", "scha.10", "scha.14", "scha.15", "scha.16"];
    itemized = L.put("scha.17", sumKeys(total), total);
  }

  // line 12e: the larger of the standard deduction and the itemized deductions
  const f12e = L.put("f1040.12e", itemized === null || stdTotal === null ? null : Math.max(itemized, stdTotal), ["scha.17", "std.total"]);
  const itemizes = itemized !== null && stdTotal !== null && itemized > stdTotal;

  // ── Schedule 1-A and line 13b ───────────────────────────────────────────────
  scheduleOneA();
  function scheduleOneA(): void {
    const stated = facts.adjustments.sch1a.value;
    if (stated !== null) {
      L.put("f1040.13b", dollarsOfCents(stated), [], "stated by the owner");
      return;
    }
    const ra = facts.returnAnswers;
    let unknown = false;
    // qualified tips and overtime (cents) and seniors, per person with a valid Social Security number
    let tipsC = 0;
    let otThirds = 0; // thirds of a cent: a 'total' overtime amount is divided by three, a 'premium' amount is taken as stated
    let seniors = 0;
    for (const p of ra.people) {
      const tc = p.tipsChoice.value;
      const oc = p.overtimeChoice.value;
      const born = p.bornBefore1961.value;
      if (born === null || (tc !== "none" && tc !== "some") || (oc !== "none" && oc !== "premium" && oc !== "total")) {
        unknown = true;
        continue;
      }
      const claims = tc === "some" || oc === "premium" || oc === "total" || born;
      if (!claims) continue;
      const ssn = p.validSsn.value;
      if (ssn === null) {
        unknown = true;
        continue;
      }
      if (!ssn) continue;
      if (born) seniors += 1;
      if (tc === "some") {
        if (p.tipsCents.value === null) unknown = true;
        else tipsC += p.tipsCents.value;
      }
      if (oc === "premium" || oc === "total") {
        if (p.overtimeCents.value === null) unknown = true;
        else otThirds += oc === "premium" ? 3 * p.overtimeCents.value : p.overtimeCents.value;
      }
    }
    // car loan interest
    const car = ra.carLoan;
    let carC = 0;
    if (car.choice.value === "some") {
      if (car.qualifies.value !== true || car.interestPaidCents.value === null || car.deductedElsewhereCents.value === null) unknown = true;
      else carC = Math.max(0, car.interestPaidCents.value - car.deductedElsewhereCents.value);
    } else if (car.choice.value !== "none") unknown = true;
    if (unknown || agi === null) {
      L.abstain("Schedule 1-A", "an answer for tips, overtime, car loan interest, age or Social Security number is missing / not sure");
      L.put("f1040.13b", null);
      return;
    }
    const tips6 = dollarsOfCents(tipsC);
    const ot14 = roundDivInt(otThirds, 300);
    const car23 = dollarsOfCents(carC);
    if (tips6 <= 0 && ot14 <= 0 && car23 <= 0 && seniors === 0) {
      // nothing is claimed: every part of Schedule 1-A is zero, whatever the income
      for (const k of ["sch1a.13", "sch1a.21", "sch1a.30", "sch1a.37", "sch1a.38"]) L.put(k, 0);
      L.put("f1040.13b", 0, ["sch1a.38"]);
      return;
    }
    if (ra.magiExclusionsNone.value !== true) {
      L.abstain("Schedule 1-A", "income excluded for Puerto Rico / Forms 2555 and 4563 is not stated as none");
      L.put("f1040.13b", null);
      return;
    }
    const magi = agi; // line 3 = line 1 (Form 1040 line 11b) + the excluded income on lines 2a-2e (none)
    L.put("sch1a.1", agi, ["f1040.11b"]);
    L.put("sch1a.3", magi, ["sch1a.1"]);
    // Part II tips
    let l13 = 0;
    if (tips6 > 0) {
      L.put("sch1a.4c", tips6);
      L.put("sch1a.6", tips6, ["sch1a.4c"]);
      const l7 = L.put("sch1a.7", Math.min(tips6, K.SCH1A_TIPS_MAX.value), ["sch1a.6"]) as number;
      const over = magi - K.SCH1A_TIPS_MAGI_START_MFJ.value;
      if (over <= 0) l13 = l7;
      else {
        const l11 = Math.floor(over / K.SCH1A_REDUCTION_STEP.value);
        const l12 = l11 * K.SCH1A_TIPS_REDUCTION_PER_1000.value;
        L.put("sch1a.10", over, ["sch1a.3"]);
        L.put("sch1a.11", l11, ["sch1a.10"]);
        L.put("sch1a.12", l12, ["sch1a.11"]);
        l13 = max0(l7 - l12);
      }
    }
    L.put("sch1a.13", l13, tips6 > 0 ? ["sch1a.7"] : []);
    // Part III overtime
    let l21 = 0;
    if (ot14 > 0) {
      L.put("sch1a.14c", ot14);
      const l15 = L.put("sch1a.15", Math.min(ot14, K.SCH1A_OVERTIME_MAX_MFJ.value), ["sch1a.14c"]) as number;
      const over = magi - K.SCH1A_OVERTIME_MAGI_START_MFJ.value;
      if (over <= 0) l21 = l15;
      else {
        const l19 = Math.floor(over / K.SCH1A_REDUCTION_STEP.value);
        const l20 = l19 * K.SCH1A_OVERTIME_REDUCTION_PER_1000.value;
        L.put("sch1a.18", over, ["sch1a.3"]);
        L.put("sch1a.19", l19, ["sch1a.18"]);
        L.put("sch1a.20", l20, ["sch1a.19"]);
        l21 = max0(l15 - l20);
      }
    }
    L.put("sch1a.21", l21, ot14 > 0 ? ["sch1a.15"] : []);
    // Part IV car loan interest
    let l30 = 0;
    if (car23 > 0) {
      L.put("sch1a.23", car23);
      const l24 = L.put("sch1a.24", Math.min(car23, K.SCH1A_CAR_LOAN_MAX.value), ["sch1a.23"]) as number;
      const over = magi - K.SCH1A_CAR_LOAN_MAGI_START_MFJ.value;
      if (over <= 0) l30 = l24;
      else {
        const l28 = Math.ceil(over / K.SCH1A_REDUCTION_STEP.value);
        const l29 = l28 * K.SCH1A_CAR_LOAN_REDUCTION_PER_1000.value;
        L.put("sch1a.27", over, ["sch1a.3"]);
        L.put("sch1a.28", l28, ["sch1a.27"]);
        L.put("sch1a.29", l29, ["sch1a.28"]);
        l30 = max0(l24 - l29);
      }
    }
    L.put("sch1a.30", l30, car23 > 0 ? ["sch1a.24"] : []);
    // Part V seniors: $6,000 each, less 6% of MAGI over $150,000
    let l37 = 0;
    if (seniors > 0) {
      const over = magi - K.SCH1A_SENIOR_MAGI_START_MFJ.value;
      const l35 = over <= 0 ? K.SCH1A_SENIOR_AMOUNT.value : max0(K.SCH1A_SENIOR_AMOUNT.value - roundMulDollars(over, bpOf(K.SCH1A_SENIOR_REDUCTION_RATE.value)));
      L.put("sch1a.35", l35, ["sch1a.3"]);
      l37 = l35 * seniors;
    }
    L.put("sch1a.37", l37, seniors > 0 ? ["sch1a.35"] : []);
    L.put("sch1a.38", l13 + l21 + l30 + l37, ["sch1a.13", "sch1a.21", "sch1a.30", "sch1a.37"]);
    L.put("f1040.13b", v("sch1a.38"), ["sch1a.38"]);
  }

  // ── Form 8995 (QBI) and line 13a ────────────────────────────────────────────
  const qdTotalDollars = dollarsOfCents(div1b);
  qbi();
  function qbi(): void {
    if (!schCDone || agi === null || f12e === null || v("f1040.13b") === null) {
      L.abstain("Form 8995", "needs the Schedule C profit, AGI, line 12e and line 13b");
      L.put("f1040.13a", null);
      return;
    }
    // taxable income before the QBI deduction: line 11a minus lines 12e and 13b (instructions, line 11); shown as zero when negative, as taxable income is
    const l11 = L.put("f8995.11", max0(agi - f12e - (v("f1040.13b") as number)), ["f1040.11a", "f1040.12e", "f1040.13b"]) as number;
    const profitNow = v("schc.31") as number;
    const qbiAmt = profitNow - nz(v("sch1.15")) - nz(v("sch1.16")) - nz(v("sch1.17"));
    const reit = dollarsOfCents(div5);
    if (decisions.qbiForm === "8995a" || l11 > K.QBI_8995_THRESHOLD_MFJ.value) {
      L.abstain("Form 8995", "taxable income is above the Form 8995 threshold (or Form 8995-A was chosen): Form 8995-A is not recomputed");
      L.lines.delete("f8995.11");
      L.put("f1040.13a", null);
      return;
    }
    if (profitNow === 0 && reit === 0 && qbiAmt === 0) {
      L.put("f1040.13a", 0, [], "no qualified business income");
      L.lines.delete("f8995.11");
      return;
    }
    rare("f8995.3");
    rare("f8995.7");
    const l2 = L.put("f8995.2", qbiAmt, ["schc.31", "sch1.15", "sch1.16", "sch1.17"]) as number;
    L.put("f8995.1i", qbiAmt, ["schc.31", "sch1.15", "sch1.16", "sch1.17"]);
    const l4 = L.put("f8995.4", Math.max(0, l2 + nz(v("f8995.3"))), ["f8995.2", "f8995.3"]) as number;
    const l5 = L.put("f8995.5", roundMulDollars(l4, bpOf(K.QBI_RATE.value)), ["f8995.4"]) as number;
    L.put("f8995.6", reit);
    const l8 = L.put("f8995.8", Math.max(0, reit + nz(v("f8995.7"))), ["f8995.6", "f8995.7"]) as number;
    const l9 = L.put("f8995.9", roundMulDollars(l8, bpOf(K.QBI_RATE.value)), ["f8995.8"]) as number;
    const l10 = L.put("f8995.10", l5 + l9, ["f8995.5", "f8995.9"]) as number;
    const qdcgLine3 = schD === null ? null : schD.qdcgLine3;
    if (qdcgLine3 === null) {
      L.abstain("Form 8995", "needs the net capital gain from Schedule D");
      L.put("f1040.13a", null);
      return;
    }
    const l12 = L.put("f8995.12", qdTotalDollars + qdcgLine3, ["f1040.3a", "schd.15", "schd.16"]) as number;
    const l13 = L.put("f8995.13", max0(l11 - l12), ["f8995.11", "f8995.12"]) as number;
    const l14 = L.put("f8995.14", roundMulDollars(l13, bpOf(K.QBI_RATE.value)), ["f8995.13"]) as number;
    const l15 = L.put("f8995.15", Math.min(l10, l14), ["f8995.10", "f8995.14"]) as number;
    L.put("f8995.16", Math.min(0, l2 + nz(v("f8995.3"))), ["f8995.2", "f8995.3"]);
    L.put("f8995.17", Math.min(0, reit + nz(v("f8995.7"))), ["f8995.6", "f8995.7"]);
    L.put("f1040.13a", l15, ["f8995.15"]);
  }

  // ── Taxable income and tax ──────────────────────────────────────────────────
  const l14sum = L.put("f1040.14", addAll(v("f1040.12e"), v("f1040.13a"), v("f1040.13b")), ["f1040.12e", "f1040.13a", "f1040.13b"]);
  const ti = L.put("f1040.15", addAll(v("f1040.11a"), l14sum === null ? null : -l14sum) === null ? null : max0((v("f1040.11a") as number) - (l14sum as number)), ["f1040.11b", "f1040.14"]);
  let tax: Maybe<number> = null;
  if (ti !== null && schD !== null && schD.qdcgLine3 !== null) {
    const line3 = schD.qdcgLine3;
    const l3a = v("f1040.3a") as number;
    if (l3a > 0 || line3 > 0) {
      const w = qdcgWorksheet(ti, l3a, line3);
      L.put("qdcg.3", line3, ["schd.15", "schd.16"]);
      L.put("qdcg.25", w.l25, ["f1040.15", "f1040.3a", "qdcg.3"]);
      tax = w.l25;
    } else tax = wholeDollars(federalTaxCents(ti));
  } else if (ti !== null && schD === null) {
    L.abstain("Form 1040 line 16", "Schedule D could not be recomputed, so the capital gain part of the tax worksheet is unknown");
  }
  L.put("f1040.16", tax, ["f1040.15", "qdcg.25"]);

  // ── Form 8959 (Additional Medicare Tax) ─────────────────────────────────────
  form8959();
  function form8959(): void {
    const box5 = addAll(...w2s.map((w) => w.medicareWagesCents));
    const box6 = addAll(...w2s.map((w) => w.medicareWithheldCents));
    if (box5 === null || box6 === null || seLine6 === null) {
      L.abstain("Form 8959", "Medicare wages / tax withheld or the Schedule SE amount is missing");
      return;
    }
    const wages = dollarsOfCents(box5);
    const largest = Math.max(0, ...w2s.map((w) => nz(w.medicareWagesCents)));
    const seIncome = max0(seLine6);
    const thr = K.ADDL_MEDICARE_THRESHOLD_MFJ.value;
    const required = largest > K.ADDL_MEDICARE_W2_TRIGGER.value * 100 || wages + seIncome > thr;
    if (!required) {
      L.put("sch2.11", 0, [], "Form 8959 not required");
      L.put("f1040.25c", 0, [], "Form 8959 not required");
      return;
    }
    const rate = bpOf(K.ADDL_MEDICARE_RATE.value);
    L.put("f8959.1", wages);
    const l4 = L.put("f8959.4", wages, ["f8959.1"]) as number;
    L.put("f8959.5", thr);
    const l6 = L.put("f8959.6", max0(l4 - thr), ["f8959.4", "f8959.5"]) as number;
    const l7 = L.put("f8959.7", roundMulDollars(l6, rate), ["f8959.6"]) as number;
    L.put("f8959.8", seIncome, seLine6 > 0 ? ["se.6"] : []);
    L.put("f8959.9", thr);
    L.put("f8959.10", l4, ["f8959.4"]);
    const l11 = L.put("f8959.11", max0(thr - l4), ["f8959.9", "f8959.10"]) as number;
    const l12 = L.put("f8959.12", max0(seIncome - l11), ["f8959.8", "f8959.11"]) as number;
    const l13 = L.put("f8959.13", roundMulDollars(l12, rate), ["f8959.12"]) as number;
    const l18 = L.put("f8959.18", l7 + l13, ["f8959.7", "f8959.13"]) as number;
    const l19 = L.put("f8959.19", dollarsOfCents(box6));
    L.put("f8959.20", wages, ["f8959.1"]);
    const l21 = L.put("f8959.21", roundMulDollars(wages, bpOf(K.MEDICARE_EMPLOYEE_RATE.value)), ["f8959.20"]) as number;
    const l22 = L.put("f8959.22", max0((l19 as number) - l21), ["f8959.19", "f8959.21"]) as number;
    L.put("f8959.24", l22, ["f8959.22"]);
    L.put("sch2.11", l18, ["f8959.18"]);
    L.put("f1040.25c", l22, ["f8959.24"]);
  }

  // ── Form 8960 (Net Investment Income Tax) ───────────────────────────────────
  form8960();
  function form8960(): void {
    const l1 = v("f1040.2b");
    const l2 = v("f1040.3b");
    const gain = v("f1040.7a");
    if (l1 === null || l2 === null || gain === null || agi === null || v("sch1.3") === null || v("sch1.4") === null || v("sch1.5") === null || v("sch1.6") === null || v("f1040.5b") === null) {
      L.abstain("Form 8960", "an input line (interest, dividends, gain, Schedule 1 income, annuities) is not available");
      return;
    }
    if (nz(v("sch1.5")) !== 0 || nz(v("sch1.6")) !== 0 || nz(v("sch1.4")) !== 0) {
      L.abstain("Form 8960", "rental / partnership / farm income or other gains are present: lines 4a-4c and 5a are not recomputed");
      return;
    }
    rare("f8960.3");
    L.put("f8960.1", l1, ["f1040.2b"]);
    L.put("f8960.2", l2, ["f1040.3b"]);
    // line 4a: Schedule 1 lines 3, 5, 6; line 4b removes the non-passive trade or business (self-employment income): line 4c is zero
    const sc3 = v("sch1.3") as number;
    L.put("f8960.4a", sc3, ["sch1.3"]);
    L.put("f8960.4b", -sc3, ["sch1.3"]);
    L.put("f8960.4c", 0, ["f8960.4a", "f8960.4b"]);
    const l5a = L.put("f8960.5a", gain + nz(v("sch1.4")), ["f1040.7a", "sch1.4"]) as number;
    L.put("f8960.5d", l5a, ["f8960.5a"]);
    const l8 = L.put("f8960.8", l1 + l2 + nz(v("f8960.3")) + 0 + l5a, ["f8960.1", "f8960.2", "f8960.3", "f8960.5d"]) as number;
    // line 9b: the state income tax deducted on Schedule A (line 5a), allocated to investment income by line 8 over AGI, when itemizing
    let l9b = 0;
    if (itemizes) {
      const l5a_ = v("scha.5a");
      const l5d = v("scha.5d");
      const l5e = v("scha.5e");
      if (l5a_ === null || l5d === null || l5e === null) {
        L.abstain("Form 8960 line 9b", "Schedule A taxes are not available");
        return;
      }
      if (l5d > l5e) {
        L.abstain("Form 8960 line 9b", "the SALT limit binds, so the split of the deducted state tax is not specified by the instructions");
        return;
      }
      if (l8 > 0 && agi > 0) l9b = roundDivInt(l5a_ * Math.min(l8, agi), agi);
    }
    const l9a = itemizes ? nz(v("scha.9")) : 0;
    L.put("f8960.9a", l9a);
    L.put("f8960.9b", l9b, ["scha.5a", "f8960.8"]);
    L.put("f8960.9c", 0, [], "miscellaneous investment expenses are not deductible");
    const l9d = L.put("f8960.9d", l9a + l9b, ["f8960.9a", "f8960.9b", "f8960.9c"]) as number;
    L.put("f8960.11", l9d, ["f8960.9d"]);
    const l12 = L.put("f8960.nii", max0(l8 - l9d), ["f8960.8", "f8960.11"]) as number;
    const thr = K.NIIT_THRESHOLD_MFJ.value;
    L.put("f8960.13", agi, ["f1040.11a"]);
    L.put("f8960.14", thr);
    const l15 = L.put("f8960.15", max0(agi - thr), ["f8960.13", "f8960.14"]) as number;
    const l16 = L.put("f8960.16", Math.min(l12, l15), ["f8960.nii", "f8960.15"]) as number;
    L.put("f8960.niit", roundMulDollars(l16, bpOf(K.NIIT_RATE.value)), ["f8960.16"]);
    L.put("sch2.12", v("f8960.niit"), ["f8960.niit"]);
  }

  // ── Form 6251 screen (the regular tax is compared with the tentative minimum tax at ordinary AMT rates) ──
  let amt: Maybe<number> = null;
  amtScreen();
  function amtScreen(): void {
    const l16 = v("f1040.16");
    if (l16 === null || ti === null || agi === null || l14sum === null || f12e === null) {
      L.abstain("Form 6251", "the regular tax or the deductions are not available");
      return;
    }
    if (facts.adjustments.sch1a.value !== null) {
      L.abstain("Form 6251", "Schedule 1-A is a stated total, so the enhanced deduction for seniors (added back for AMT) is not known");
      return;
    }
    // line 1a: Form 1040 line 14 less Schedule 1-A line 37 (the enhanced deduction for seniors is added back for AMT: Form 6251 instructions, "Line 1a")
    const sch1a37 = nz(v("sch1a.37"));
    const l1a = l14sum - sch1a37;
    const l1b = agi - l1a;
    const l2a = itemizes ? nz(v("scha.7")) : f12e;
    const refund = nz(v("sch1.1"));
    const l4 = L.put("f6251.amti", l1b + l2a - refund + dollarsOfCents(int9), ["f1040.11b", "f1040.14", "f1040.12e", "scha.7"]) as number;
    const exemptionStart = K.AMT_PHASEOUT_START_MFJ.value;
    const exemption = l4 <= exemptionStart ? K.AMT_EXEMPTION_MFJ.value : max0(K.AMT_EXEMPTION_MFJ.value - roundMulDollars(l4 - exemptionStart, 2500));
    const l6 = max0(l4 - exemption);
    const hi = K.AMT_28_PERCENT_THRESHOLD.value;
    const r26 = bpOf(K.AMT_RATE_LOW.value);
    const r28 = bpOf(K.AMT_RATE_HIGH.value);
    const l7 = l6 <= hi ? roundMulDollars(l6, r26) : roundMulDollars(l6, r28) - roundMulDollars(hi, r28 - r26);
    L.put("f6251.tmt", l7, ["f6251.amti"]);
    const l10 = max0(l16 + nz(v("sch2.1z")) - nz(v("sch3.1")));
    amt = l7 <= l10 ? L.put("f6251.amt", 0, ["f6251.tmt", "f1040.16"]) : null;
    if (amt === null) L.abstain("Form 6251", "the tentative minimum tax at ordinary rates exceeds the regular tax: Part III (maximum capital gains rates) is not recomputed");
  }

  // ── Schedule 2 ──────────────────────────────────────────────────────────────
  for (const id of SCH2_RARE_KEYS) rare(`sch2.${id}`);
  const s2a = ["1a", "1b", "1c", "1d", "1e", "1f", "1y"].map((id) => `sch2.${id}`);
  L.put("sch2.1z", sumKeys(s2a), s2a);
  L.put("sch2.2", amt, ["f6251.amt"]);
  L.put("sch2.3", addAll(v("sch2.1z"), v("sch2.2")), ["sch2.1z", "sch2.2"]);
  L.put("sch2.4", seTax, ["se.12"]);
  L.put("sch2.7", sumKeys(["sch2.5", "sch2.6"]), ["sch2.5", "sch2.6"]);
  const s2b = ["17a", "17b", "17c", "17d", "17e", "17f", "17g", "17h", "17i", "17j", "17k", "17l", "17m", "17n", "17o", "17p", "17q", "17z"].map((id) => `sch2.${id}`);
  L.put("sch2.18", sumKeys(s2b), s2b);
  const s221 = ["sch2.4", "sch2.7", "sch2.8", "sch2.9", "sch2.11", "sch2.12", "sch2.13", "sch2.14", "sch2.15", "sch2.16", "sch2.18", "sch2.19"];
  L.put("sch2.21", sumKeys(s221), s221);

  // ── Schedule 3 ──────────────────────────────────────────────────────────────
  stateOrEngine("sch3.1", facts.credits.foreignTax);
  stateOrEngine("sch3.4", facts.credits.savers);
  rare("sch3.2");
  rare("sch3.3");
  rare("sch3.5a");
  rare("sch3.5b");
  for (const id of SCH3_LINE6) rare(`sch3.${id}`);
  L.put("sch3.7", sumKeys(SCH3_LINE6.map((id) => `sch3.${id}`)), SCH3_LINE6.map((id) => `sch3.${id}`));
  const s38 = ["sch3.1", "sch3.2", "sch3.3", "sch3.4", "sch3.5a", "sch3.5b", "sch3.7"];
  L.put("sch3.8", sumKeys(s38), s38);
  rare("sch3.9");
  const ext = facts.payments.federalExtensionPayment.value;
  L.put("sch3.10", ext === null ? null : dollarsOfCents(ext));
  // line 11: Social Security tax withheld above the maximum, for a person with two or more employers
  {
    let excessC: Maybe<number> = 0;
    const maxWithheld = Math.round((K.SE_WAGE_BASE.value * 100 * bpOf(K.SE_OASDI_RATE.value)) / 2 / 10_000);
    const byPerson = new Map<string, { employers: Set<string>; withheld: number }>();
    for (const w of w2s) {
      if (w.socialSecurityWithheldCents === null) {
        excessC = null;
        break;
      }
      const pid = w.personUserId ?? `doc:${w.docId}`;
      const cur = byPerson.get(pid) ?? { employers: new Set<string>(), withheld: 0 };
      cur.employers.add(w.employerEin ?? w.employer ?? `doc:${w.docId}`);
      cur.withheld += w.socialSecurityWithheldCents;
      byPerson.set(pid, cur);
    }
    if (excessC !== null) {
      for (const p of byPerson.values()) if (p.employers.size >= 2) excessC += Math.max(0, p.withheld - maxWithheld);
    }
    L.put("sch3.11", excessC === null ? null : dollarsOfCents(excessC));
  }
  rare("sch3.12");
  for (const id of SCH3_LINE13) rare(`sch3.${id}`);
  L.put("sch3.14", sumKeys(SCH3_LINE13.map((id) => `sch3.${id}`)), SCH3_LINE13.map((id) => `sch3.${id}`));
  const s315 = ["sch3.9", "sch3.10", "sch3.11", "sch3.12", "sch3.14"];
  L.put("sch3.15", sumKeys(s315), s315);

  // ── Form 1040 lines 16-24 ───────────────────────────────────────────────────
  L.put("f1040.17", v("sch2.3"), ["sch2.3"]);
  L.put("f1040.18", addAll(v("f1040.16"), v("f1040.17")), ["f1040.16", "f1040.17"]);
  if (facts.household.noDependents.value === true) L.put("f1040.19", 0, [], "no dependents");
  else L.engineInput("f1040.19", inp.engineAmount("f1040.19"), "taken from the engine");
  L.put("f1040.20", v("sch3.8"), ["sch3.8"]);
  L.put("f1040.21", addAll(v("f1040.19"), v("f1040.20")), ["f1040.19", "f1040.20"]);
  const l18 = v("f1040.18");
  const l21 = v("f1040.21");
  L.put("f1040.22", l18 === null || l21 === null ? null : max0(l18 - l21), ["f1040.18", "f1040.21"]);
  L.put("f1040.23", v("sch2.21"), ["sch2.21"]);
  L.put("f1040.24", addAll(v("f1040.22"), v("f1040.23")), ["f1040.22", "f1040.23"]);

  // ── Payments ────────────────────────────────────────────────────────────────
  const fedW2 = addAll(...w2s.map((w) => w.fedWithheldCents));
  L.put("f1040.25a", fedW2 === null ? null : dollarsOfCents(fedW2 + facts.payments.federalPaystubWithheldCents));
  L.put("f1040.25b", dollarsOfCents(facts.payments.federal1099WithheldCents));
  L.put("f1040.25d", addAll(v("f1040.25a"), v("f1040.25b"), v("f1040.25c")), ["f1040.25a", "f1040.25b", "f1040.25c"]);
  {
    const est = facts.payments.federalEstimates.value;
    const prior = facts.payments.federalPriorYearOverpaymentApplied.value;
    if (est === null || prior === null) L.put("f1040.26", null);
    else L.put("f1040.26", dollarsOfCents(est.filter((e) => e.appliesToTaxYear === 2025).reduce((a, e) => a + e.amountCents, 0) + prior));
  }
  for (const id of ["27a", "28", "29", "30"]) rare(`f1040.${id}`);
  L.put("f1040.31", v("sch3.15"), ["sch3.15"]);
  const l32 = ["f1040.27a", "f1040.28", "f1040.29", "f1040.30", "f1040.31"];
  L.put("f1040.32", sumKeys(l32), l32);
  L.put("f1040.33", addAll(v("f1040.25d"), v("f1040.26"), v("f1040.32")), ["f1040.25d", "f1040.26", "f1040.32"]);
  const t24 = v("f1040.24");
  const p33 = v("f1040.33");
  L.put("f1040.34", t24 === null || p33 === null ? null : max0(p33 - t24), ["f1040.24", "f1040.33"]);
  L.put("f1040.37", t24 === null || p33 === null ? null : max0(t24 - p33), ["f1040.24", "f1040.33"]);
  return L;
}
