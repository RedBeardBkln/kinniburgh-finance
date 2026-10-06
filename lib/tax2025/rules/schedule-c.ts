// Schedule C (EK Consulting, LLC; single-member, disregarded) for TY2025.
//
// Built from the GL-coded P&L (books), the approved-by-owner/CPA GL-to-line map
// (lib/tax2025/gl-schedule-c-map.ts, a PROPOSAL until approved), the mileage log,
// the home-office answers and the fixed-asset register. Nothing is guessed:
//   - a GL account with no map entry is UNMAPPED -> its side (income / expenses) is
//     missing_input;
//   - clearing / personal / other-form accounts (needs_cpa) and cost of goods sold
//     with a non-zero balance -> needs_cpa_judgment;
//   - meals are deducted at the verified 50%;
//   - line 9: standard mileage from the log, or a confirmed $0 when the owner states
//     there was no business mileage; mileage entries together with actual vehicle
//     expenses, or a log that contradicts the "no mileage" answer, are a CPA call;
//   - line 13: the fixed-asset register is the input to Form 4562 (Phase 2, decision
//     X2): with assets on the register the line is not_yet_computed, never 0;
//   - line 30: home office, decision X1: simplified ($5 x up to 300 sq ft, computed)
//     versus actual (Form 8829, Phase 2: listed as an alternative, not computed). The simplified
//     amount is capped at the gross income limitation, Schedule C line 29 (floored at 0). The
//     conservative simplified method is used, marked "default, undecided", until a
//     decision is recorded. Under the simplified method the home-office GL accounts
//     (actual-method inputs) are NOT part of Schedule C profit.
//
//   - mixed-use accounts (lib/tax2025/business-use.ts, decisions X6 ...): the line total applies the owner's
//     business-use percentage to those accounts; the personal portion is informational only (nothing is booked).
//     Rounded ONCE from cents on the line total (the IRS "include cents when adding, round only the total" rule).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { BUSINESS_USE_ACCOUNTS, BUSINESS_USE_CENTS_TENTHS_PER_DOLLAR, BUSINESS_USE_DEFAULT_TENTHS, BUSINESS_USE_MAX_TENTHS, formatBusinessUsePercent, type BusinessUseAccount } from "@/lib/tax2025/business-use";
import { K } from "@/lib/tax2025/constants";
import type { FixedAssetFact, GlLineFact } from "@/lib/tax2025/facts";
import { findGlMapEntry } from "@/lib/tax2025/gl-schedule-c-map";
import { D, ZERO, amountLine, blockedLine, centsToDollars, dollarsToCents, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import {
  aggregateStatus,
  scheduleCLineKey,
  worstBlocked,
  type Decided,
  type DecidedPercent,
  type LineKey,
  type RuleAlternative,
  type RuleDecision,
  type RuleLine,
  type RuleResult,
  type Ref,
  type RuleStatus,
  type ScheduleCAccountDetail,
  type ScheduleCBusinessUse,
  type ScheduleCDetail,
  type ScheduleCLineId,
} from "@/lib/tax2025/types";

export interface ScheduleCInput {
  glLines: GlLineFact[];
  /** True when the entity has no GL-coded P&L activity at all. */
  booksEmpty: boolean;
  /** 2025 EKC transactions with no GL code (invisible to the P&L). More than 0 blocks lines 28 / 29 / 31. Absent = 0. */
  uncodedTransactionCount?: number;
  mileage: { miles: number; ratePerMile: string; dateIso: string }[];
  mileageNoneConfirmed: boolean;
  homeOfficeEligibility: "yes_exclusive" | "yes_shared" | "no" | null;
  homeOfficeSqft: number | null;
  fixedAssets: FixedAssetFact[];
  fixedAssetsNoneConfirmed: boolean;
  homeOfficeDecision?: Decided<"simplified" | "actual">;
  /** Recorded business-use percentages (X6 ...) keyed by the BUSINESS_USE_ACCOUNTS `key`; absent = undecided (100%, flagged). */
  businessUseDecisions?: Readonly<Record<string, DecidedPercent>>;
}

const CITATIONS = ["MEALS_DEDUCTIBLE_FRACTION", "MILEAGE_RATE", "HOME_OFFICE_RATE_PER_SQFT", "HOME_OFFICE_MAX_SQFT", "HOME_OFFICE_GROSS_INCOME_LIMIT"];

const LINE_LABELS: Record<ScheduleCLineId, string> = {
  "1": "Gross receipts or sales",
  "2": "Returns and allowances",
  "3": "Gross receipts minus returns and allowances",
  "4": "Cost of goods sold (from line 42)",
  "5": "Gross profit",
  "6": "Other income",
  "7": "Gross income",
  "8": "Advertising",
  "9": "Car and truck expenses",
  "10": "Commissions and fees",
  "11": "Contract labor",
  "12": "Depletion",
  "13": "Depreciation and section 179 expense deduction",
  "14": "Employee benefit programs",
  "15": "Insurance (other than health)",
  "16a": "Interest: mortgage",
  "16b": "Interest: other",
  "17": "Legal and professional services",
  "18": "Office expense",
  "19": "Pension and profit-sharing plans",
  "20a": "Rent or lease: vehicles, machinery and equipment",
  "20b": "Rent or lease: other business property",
  "21": "Repairs and maintenance",
  "22": "Supplies",
  "23": "Taxes and licenses",
  "24a": "Travel",
  "24b": "Deductible meals",
  "25": "Utilities",
  "26": "Wages",
  "27a": "Energy efficient commercial buildings deduction",
  "27b": "Other expenses (from line 48)",
  "28": "Total expenses before business use of home",
  "29": "Tentative profit or (loss)",
  "30": "Expenses for business use of your home",
  "31": "Net profit or (loss)",
  "35": "Inventory at beginning of year",
  "36": "Purchases less cost of items withdrawn for personal use",
  "37": "Cost of labor",
  "38": "Materials and supplies",
  "39": "Other costs",
  "40": "Total of lines 35 through 39",
  "41": "Inventory at end of year",
  "42": "Cost of goods sold",
  "48": "Total other expenses",
};

/** Expense lines 8 through 27b except the group lines 12 and 27a (stated-none, filled by the assembler). */
const EXPENSE_LINE_IDS: readonly ScheduleCLineId[] = [
  "8", "9", "10", "11", "13", "14", "15", "16a", "16b", "17", "18", "19", "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "27b",
];

const PART_III_IDS: readonly ScheduleCLineId[] = ["35", "36", "37", "38", "39", "40", "41", "42"];

function lbl(id: ScheduleCLineId): string {
  return LINE_LABELS[id];
}

function formLineOf(id: ScheduleCLineId): string {
  return `Sch C line ${id}`;
}

function leafName(name: string): string {
  return name.split(":").pop() ?? name;
}

/** Exact dollars of `rawCents` at `tenths` tenths of a percent (cents x tenths / 100,000): no intermediate rounding. */
function scaledDollars(rawCents: number, tenths: number): Decimal {
  return D(rawCents).times(tenths).div(BUSINESS_USE_CENTS_TENTHS_PER_DOLLAR);
}

function validTenths(p: DecidedPercent | undefined): p is DecidedPercent {
  return p !== undefined && Number.isInteger(p.percentTenths) && p.percentTenths >= 0 && p.percentTenths <= BUSINESS_USE_MAX_TENTHS;
}

export function computeScheduleC(input: ScheduleCInput): {
  result: RuleResult;
  detail: ScheduleCDetail;
  /** One result per mixed-use account present with a booked amount (each hosts its own decision, X6 ...). */
  businessUseResults: RuleResult[];
} {
  const detail: ScheduleCDetail = {
    lines: [],
    otherExpenseItems: [],
    unmapped: [],
    needsCpa: [],
    homeOfficeActualCandidates: [],
    booksInterest: [],
    vehicleActual: [],
    mileage: { entries: 0, miles: 0, deductionCents: 0 },
    cogsTotalCents: 0,
    businessUse: [],
  };
  const base = { ruleId: "schedule-c", form: "Schedule C", citations: CITATIONS, inputsUsed: [] };
  const reasons: string[] = [];
  const missing: string[] = [];

  // ── Books present? ──────────────────────────────────────────────────────────
  if (input.booksEmpty && input.glLines.length === 0) {
    const reason =
      "EK Consulting has no GL-coded income or expense transactions for 2025, so Schedule C cannot be built from the books (zero activity is not assumed).";
    const keys: ScheduleCLineId[] = ["1", "7", "28", "29", "31"];
    return {
      result: {
        ...base,
        status: "missing_input",
        lines: keys.map((id) => blockedLine(scheduleCLineKey(id), lbl(id), formLineOf(id), "missing_input", reason)),
        reasons: [reason],
        inputsMissing: ["GL-coded EK Consulting transactions for 2025"],
      },
      detail,
      businessUseResults: [],
    };
  }

  // ── Map every GL line ──────────────────────────────────────────────────────
  const lineAccounts = new Map<ScheduleCLineId, ScheduleCAccountDetail[]>();
  const addToLine = (id: ScheduleCLineId, acct: ScheduleCAccountDetail) => {
    lineAccounts.set(id, [...(lineAccounts.get(id) ?? []), acct]);
  };
  let cogsCents = 0;
  let depreciationCents = 0;
  let unmappedRevenue = false;
  let unmappedExpense = false;
  let needsCpaRevenue = false;
  let needsCpaExpense = false;
  /** Mixed-use accounts that reached a plain `line` target with a booked amount (the list entry, the line, the accounts). */
  const flagged = new Map<string, { def: BusinessUseAccount; line: ScheduleCLineId; accounts: ScheduleCAccountDetail[] }>();

  for (const g of input.glLines) {
    if (g.totalCents === 0) continue;
    const entry = findGlMapEntry(g.name);
    // S5: a revenue code netting negative / an expense code netting positive (except Returns and allowances) is a sign flip:
    // the P&L's abs() total would count it in the wrong direction, so it is a CPA call, never silently used.
    const flipped = g.signedCents !== undefined && (g.glType === "revenue" ? g.signedCents < 0 : g.signedCents > 0);
    const isReturns = entry?.target.kind === "line" && entry.target.line === "2";
    if (flipped && !isReturns) {
      detail.needsCpa.push({
        code: g.code,
        name: g.name,
        totalCents: g.totalCents,
        reason: `This ${g.glType} account nets ${g.signedCents! < 0 ? "negative" : "positive"} for the year (opposite to its type); the P&L's absolute total would count it in the wrong direction.`,
      });
      if (g.glType === "revenue") needsCpaRevenue = true;
      else needsCpaExpense = true;
      continue;
    }
    if (!entry) {
      detail.unmapped.push({ code: g.code, name: g.name, totalCents: g.totalCents, glType: g.glType });
      if (g.glType === "revenue") unmappedRevenue = true;
      else unmappedExpense = true;
      continue;
    }
    const t = entry.target;
    switch (t.kind) {
      case "line": {
        const deductibleCents = t.meals
          ? dollarsToCents(roundLine(centsToDollars(g.totalCents).times(K.MEALS_DEDUCTIBLE_FRACTION.value)))
          : g.totalCents;
        // the 50% is applied per account here only for the detail; the LINE total applies it once (see below)
        const def = t.meals ? null : (BUSINESS_USE_ACCOUNTS.find((a) => a.mapAccount === entry.account) ?? null);
        if (def) {
          const rec = input.businessUseDecisions?.[def.key];
          const tenths = validTenths(rec) ? rec.percentTenths : BUSINESS_USE_DEFAULT_TENTHS;
          const acct: ScheduleCAccountDetail = {
            code: g.code,
            name: g.name,
            rawCents: g.totalCents,
            deductibleCents: dollarsToCents(scaledDollars(g.totalCents, tenths)),
            businessUseDecisionId: def.decisionId,
            businessUsePercentTenths: tenths,
          };
          addToLine(t.line, acct);
          const prev = flagged.get(def.key);
          if (prev) prev.accounts.push(acct);
          else flagged.set(def.key, { def, line: t.line, accounts: [acct] });
          break;
        }
        addToLine(t.line, { code: g.code, name: g.name, rawCents: g.totalCents, deductibleCents });
        break;
      }
      case "cogs":
        cogsCents += g.totalCents;
        break;
      case "depreciation":
        depreciationCents += g.totalCents;
        break;
      case "vehicle_actual":
        detail.vehicleActual.push({ code: g.code, name: g.name, totalCents: g.totalCents });
        break;
      case "home_office_actual":
        detail.homeOfficeActualCandidates.push({ code: g.code, name: g.name, totalCents: g.totalCents });
        break;
      case "interest_to_1040_2b":
        // Not Schedule C income: reported as taxable interest (1040 line 2b / Schedule B) by the assembler.
        detail.booksInterest.push({ code: g.code, name: g.name, amountCents: g.totalCents });
        break;
      case "needs_cpa":
        detail.needsCpa.push({ code: g.code, name: g.name, totalCents: g.totalCents, reason: t.reason });
        if (g.glType === "revenue") needsCpaRevenue = true;
        else needsCpaExpense = true;
        break;
      case "balance_sheet":
        detail.needsCpa.push({
          code: g.code,
          name: g.name,
          totalCents: g.totalCents,
          reason: "This account is typed as income/expense in the app but is a balance-sheet account in the QuickBooks chart.",
        });
        if (g.glType === "revenue") needsCpaRevenue = true;
        else needsCpaExpense = true;
        break;
    }
  }
  detail.cogsTotalCents = cogsCents;

  /**
   * Exact dollars of a line with each mixed-use account at `tenthsOf(account)` (cents kept, no rounding): the caller
   * rounds ONCE. Accounts that are not mixed-use enter at 100%.
   */
  const lineExact = (id: ScheduleCLineId, tenthsOf: (a: ScheduleCAccountDetail) => number | undefined): Decimal =>
    (lineAccounts.get(id) ?? []).reduce((acc, a) => {
      const tenths = a.businessUseDecisionId === undefined ? undefined : tenthsOf(a);
      return acc.plus(tenths === undefined ? centsToDollars(a.rawCents) : scaledDollars(a.rawCents, tenths));
    }, ZERO);
  const inForce = (a: ScheduleCAccountDetail): number | undefined => a.businessUsePercentTenths;

  const lineTotal = (id: ScheduleCLineId): Decimal => {
    const accts = lineAccounts.get(id) ?? [];
    if (id === "24b") {
      // meals: one 50% on the line total ("include cents when adding, round only the total")
      return roundLine(accts.reduce((s, a) => s.plus(centsToDollars(a.rawCents)), ZERO).times(K.MEALS_DEDUCTIBLE_FRACTION.value));
    }
    // mixed-use accounts enter at their business-use percentage, the rest at 100%; ONE rounding on the total
    return roundLine(lineExact(id, inForce));
  };

  // Provenance of a line carrying a mixed-use account: the books accounts plus the owner's decision (X6 ...), never "verified".
  const glRefs: Ref[] = input.glLines.map((g) => ({ kind: "gl", id: g.code, label: g.name }));
  const businessUseNote = (id: ScheduleCLineId): { reason: string; refs: Ref[] } | null => {
    const here = [...flagged.values()].filter((f) => f.line === id);
    if (here.length === 0) return null;
    const sentences: string[] = [];
    const refs: Ref[] = [...glRefs];
    for (const f of here) {
      const rec = input.businessUseDecisions?.[f.def.key];
      const raw = f.accounts.reduce((n, a) => n + a.rawCents, 0);
      const deductible = f.accounts.reduce((n, a) => n + a.deductibleCents, 0);
      if (validTenths(rec)) {
        const pct = formatBusinessUsePercent(rec.percentTenths);
        sentences.push(
          `Includes the shared account(s) at ${pct} business use (decision ${f.def.decisionId}, the owner's statement, not verified by documents): ${fmt(centsToDollars(raw))} booked, ${fmt(centsToDollars(raw - deductible))} personal and not deducted.`
        );
        refs.push({ kind: "decision", id: f.def.decisionId, label: `Owner decision ${f.def.decisionId}: ${pct} business use, the owner's statement, not verified by documents` });
      } else {
        sentences.push(
          `Includes the shared account(s) at 100% business use: default, undecided (decision ${f.def.decisionId}); record the business-use percentage on the review sheet.`
        );
        refs.push({ kind: "decision", id: f.def.decisionId, label: `Owner decision ${f.def.decisionId}: default 100% business use, undecided` });
      }
    }
    return { reason: sentences.join(" "), refs };
  };

  const lines: RuleLine[] = [];
  const amounts = new Map<ScheduleCLineId, Decimal>();
  const emit = (id: ScheduleCLineId, exact: Decimal, reason?: string, refs?: Ref[]) => {
    const line = amountLine(scheduleCLineKey(id), lbl(id), formLineOf(id), exact, "computed", reason);
    if (refs !== undefined) line.refs = refs;
    lines.push(line);
    amounts.set(id, line.amount as Decimal);
  };
  const block = (id: ScheduleCLineId, status: Exclude<RuleStatus, "computed" | "not_applicable">, reason: string) => {
    lines.push(blockedLine(scheduleCLineKey(id), lbl(id), formLineOf(id), status, reason));
  };

  // unmapped / needs-CPA accounts explained once
  if (detail.unmapped.length > 0) {
    const list = detail.unmapped.map((u) => `${u.name} (${fmt(centsToDollars(u.totalCents))})`).join(", ");
    reasons.push(`GL account(s) with no Schedule C line in the proposed map: ${list}. Approve or extend the map (lib/tax2025/gl-schedule-c-map.ts).`);
    missing.push("Schedule C line for GL account(s): " + detail.unmapped.map((u) => u.name).join(", "));
  }
  for (const n of detail.needsCpa) {
    reasons.push(`${n.name} (${fmt(centsToDollars(n.totalCents))}): ${n.reason}`);
  }

  // ── Income side (lines 1-7) and cost of goods sold ─────────────────────────
  const l1 = lineTotal("1");
  const l2 = lineTotal("2");
  const l6 = lineTotal("6");
  const incomeBlockedMissing = unmappedRevenue;
  const incomeBlockedCpa = needsCpaRevenue;
  const incomeReason = incomeBlockedMissing
    ? "An income GL account has no Schedule C line in the proposed map."
    : "An income GL account needs the CPA (clearing / other-form item).";
  const incomeStatus: "missing_input" | "needs_cpa_judgment" = incomeBlockedMissing ? "missing_input" : "needs_cpa_judgment";
  if (incomeBlockedMissing || incomeBlockedCpa) {
    for (const id of ["1", "2", "3", "5", "6", "7"] as const) block(id, incomeStatus, incomeReason);
  } else {
    emit("1", l1);
    emit("2", l2);
    emit("3", l1.minus(l2));
  }

  // cost of goods sold
  let cogsOk = false;
  if (cogsCents === 0) {
    cogsOk = true;
    emit("4", ZERO, "The books show no cost of goods sold.");
    for (const id of PART_III_IDS) {
      lines.push({
        key: scheduleCLineKey(id),
        label: lbl(id),
        formLine: formLineOf(id),
        amount: ZERO,
        exact: ZERO,
        status: "not_applicable",
        reason: "Part III is not needed: the books show no cost of goods sold.",
      });
    }
  } else {
    const reason = `The books show ${fmt(centsToDollars(cogsCents))} of cost of goods sold; Part III (inventory, purchases) is not modeled, so the CPA must complete it.`;
    block("4", "needs_cpa_judgment", reason);
    for (const id of PART_III_IDS) block(id, "needs_cpa_judgment", reason);
    reasons.push(reason);
  }

  if (!incomeBlockedMissing && !incomeBlockedCpa) {
    emit("6", l6);
    if (cogsOk) {
      const l3 = amounts.get("1")!.minus(amounts.get("2")!);
      const l5 = l3.minus(amounts.get("4")!);
      emit("5", l5);
      emit("7", l5.plus(amounts.get("6")!));
    } else {
      block("5", "needs_cpa_judgment", "Cost of goods sold is not modeled.");
      block("7", "needs_cpa_judgment", "Cost of goods sold is not modeled.");
    }
  }

  // ── Expense lines 8-27b ─────────────────────────────────────────────────────
  const expenseBlocked: Exclude<RuleStatus, "computed" | "not_applicable"> | null = unmappedExpense
    ? "missing_input"
    : needsCpaExpense
      ? "needs_cpa_judgment"
      : null;
  let allExpensesComputed = expenseBlocked === null;
  const expenseAmounts: Decimal[] = [];

  for (const id of EXPENSE_LINE_IDS) {
    if (id === "9" || id === "13" || id === "27b") continue; // special lines handled below
    const note = businessUseNote(id);
    emit(id, lineTotal(id), note?.reason, note?.refs);
    expenseAmounts.push(amounts.get(id)!);
  }

  // line 9: car and truck
  const rate = D(K.MILEAGE_RATE.value);
  const mileageTotal = input.mileage.reduce((s, m) => s.plus(D(m.miles).times(D(m.ratePerMile))), ZERO);
  detail.mileage = {
    entries: input.mileage.length,
    miles: input.mileage.reduce((s, m) => s + m.miles, 0),
    deductionCents: dollarsToCents(mileageTotal),
  };
  const vehicleActualCents = detail.vehicleActual.reduce((s, v) => s + v.totalCents, 0);
  if (input.mileage.length > 0 && input.mileageNoneConfirmed) {
    block("9", "needs_cpa_judgment", "The owner states there was no business mileage, but mileage entries exist in the log: resolve which is right.");
    allExpensesComputed = false;
  } else if (input.mileage.length > 0 && vehicleActualCents > 0) {
    block("9", "needs_cpa_judgment", "Both mileage entries and actual vehicle expenses exist; only one method can be used for a vehicle.");
    allExpensesComputed = false;
  } else if (input.mileage.length > 0) {
    emit("9", mileageTotal, `Standard mileage: ${detail.mileage.miles} miles from the log.`);
    expenseAmounts.push(amounts.get("9")!);
    const odd = input.mileage.filter((m) => !D(m.ratePerMile).equals(rate));
    if (odd.length > 0) {
      reasons.push(`${odd.length} mileage entr${odd.length === 1 ? "y uses" : "ies use"} a rate other than the 2025 standard rate of ${rate.toString()} dollars per mile; they are used as logged.`);
    }
  } else if (vehicleActualCents > 0) {
    block(
      "9",
      "needs_cpa_judgment",
      `Actual vehicle expenses of ${fmt(centsToDollars(vehicleActualCents))} are booked but there is no mileage log: the method, business-use percentage and Part IV vehicle information are a CPA call.`
    );
    allExpensesComputed = false;
  } else if (input.mileageNoneConfirmed) {
    emit("9", ZERO, "Owner states there was no business mileage in 2025 (a confirmed $0).");
    expenseAmounts.push(ZERO);
  } else {
    block("9", "missing_input", "No mileage log entries and no statement that there was no business mileage: answer the business-mileage question.");
    missing.push("business mileage (log or 'none' answer)");
    allExpensesComputed = false;
  }

  // line 13: depreciation
  const assetsOnRegister = input.fixedAssets.length;
  if (assetsOnRegister > 0) {
    block(
      "13",
      "not_yet_computed",
      `${assetsOnRegister} fixed asset(s) are on the register: depreciation, Section 179 and bonus (Form 4562, decision X2) are computed in a later phase and are never shown as 0.`
    );
    allExpensesComputed = false;
  } else if (!input.fixedAssetsNoneConfirmed) {
    block("13", "missing_input", "The fixed-asset register is empty and the owner has not confirmed there are no depreciable assets.");
    missing.push("fixed-asset register (or 'none' confirmation)");
    allExpensesComputed = false;
  } else if (depreciationCents > 0) {
    block("13", "needs_cpa_judgment", `Depreciation of ${fmt(centsToDollars(depreciationCents))} is booked but the fixed-asset register is empty.`);
    allExpensesComputed = false;
  } else {
    emit("13", ZERO, "No fixed assets (owner confirmed) and no booked depreciation.");
    expenseAmounts.push(ZERO);
  }

  // line 27b + Part V
  const otherAccts = lineAccounts.get("27b") ?? [];
  for (const a of otherAccts) {
    detail.otherExpenseItems.push({ code: a.code, name: leafName(a.name), amountCents: a.rawCents });
  }
  const l27b = lineTotal("27b");
  emit("27b", l27b);
  expenseAmounts.push(amounts.get("27b")!);
  lines.push(amountLine(scheduleCLineKey("48"), lbl("48"), formLineOf("48"), l27b));

  // ── Totals 28, 29 ───────────────────────────────────────────────────────────
  const statusOfId = (id: ScheduleCLineId): RuleStatus | undefined =>
    lines.find((l) => l.key === scheduleCLineKey(id))?.status;
  if (allExpensesComputed) {
    emit("28", expenseAmounts.reduce((s, a) => s.plus(a), ZERO));
  } else {
    const why = expenseBlocked ?? worstBlocked(EXPENSE_LINE_IDS.map(statusOfId)) ?? "missing_input";
    block("28", why, "An expense line is not computed (see the lines above).");
  }
  const l7 = amounts.get("7");
  const l28 = amounts.get("28");
  if (l7 !== undefined && l28 !== undefined) emit("29", l7.minus(l28));
  else block("29", worstBlocked([statusOfId("7"), statusOfId("28")]) ?? "missing_input", "Gross income or total expenses are not computed.");

  // ── Line 30: business use of home (decision X1) ─────────────────────────────
  const homeCandidatesCents = detail.homeOfficeActualCandidates.reduce((s, h) => s + h.totalCents, 0);
  let decision: RuleDecision | undefined;
  let alternatives: RuleAlternative[] | undefined;
  let line30: Decimal | null = null;
  const elig = input.homeOfficeEligibility;
  if (elig === null) {
    block("30", "missing_input", "Home office eligibility (exclusive use) has not been answered.");
    missing.push("home office eligibility answer");
  } else if (elig === "no" || elig === "yes_shared") {
    line30 = ZERO;
    lines.push({
      key: scheduleCLineKey("30"),
      label: lbl("30"),
      formLine: formLineOf("30"),
      amount: ZERO,
      exact: ZERO,
      status: "not_applicable",
      reason: elig === "no" ? "Owner states no home office use." : "The space is not used exclusively for business, so no home office deduction.",
    });
    if (homeCandidatesCents > 0) {
      reasons.push(
        `${fmt(centsToDollars(homeCandidatesCents))} is booked to home-office accounts but the owner states there is no qualifying home office: those amounts are left out of Schedule C.`
      );
    }
  } else if (input.homeOfficeSqft === null) {
    block("30", "missing_input", "Home office square footage has not been answered.");
    missing.push("home office square footage");
  } else {
    const sqft = D(input.homeOfficeSqft);
    const capped = minD(sqft, D(K.HOME_OFFICE_MAX_SQFT.value));
    const simplifiedBeforeLimit = capped.times(K.HOME_OFFICE_RATE_PER_SQFT.value);
    // Simplified Method Worksheet line 1 (Schedule C instructions / Pub 587): the deduction cannot exceed the gross
    // income limitation = Schedule C line 29 (no 8949 / 4797 gains or losses are modeled); "if zero or less, enter -0-".
    const tentativeProfit = amounts.get("29");
    const grossIncomeLimit = tentativeProfit === undefined ? null : maxD(ZERO, tentativeProfit);
    const simplified = grossIncomeLimit === null ? simplifiedBeforeLimit : minD(simplifiedBeforeLimit, grossIncomeLimit);
    const limitedByIncome = grossIncomeLimit !== null && simplifiedBeforeLimit.greaterThan(grossIncomeLimit);
    const chosen = input.homeOfficeDecision?.chosen ?? "simplified";
    decision = {
      id: "X1",
      label: "Home office: simplified method or actual expenses (Form 8829)",
      chosen,
      status: input.homeOfficeDecision ? "decided" : "default_undecided",
      ...(input.homeOfficeDecision ? { decidedBy: input.homeOfficeDecision.by, decidedAt: input.homeOfficeDecision.at } : {}),
    };
    const limitReason = limitedByIncome
      ? `Limited by the gross income limitation (Schedule C line 29 ${fmt(tentativeProfit ?? ZERO)}): ${fmt(simplifiedBeforeLimit)} before the limit, ${fmt(simplified)} allowed (the deduction cannot create a loss).`
      : undefined;
    const simplifiedLine = amountLine(scheduleCLineKey("30"), lbl("30"), formLineOf("30"), simplified, "computed", limitReason);
    alternatives = [
      {
        id: "simplified",
        label: `Simplified method: ${fmt(capped)} of space x ${fmt(D(K.HOME_OFFICE_RATE_PER_SQFT.value))} (max ${K.HOME_OFFICE_MAX_SQFT.value} sq ft; the election is irrevocable for the year)`,
        status: grossIncomeLimit === null ? "not_yet_computed" : "computed",
        isDefault: true,
        inForce: chosen === "simplified",
        lines: [simplifiedLine],
        effect: { amount: simplifiedLine.amount, note: `Deduction ${fmt(simplifiedLine.amount as Decimal)} on Schedule C line 30; no Form 8829 is filed with this method.` },
        reasons: [
          sqft.greaterThan(K.HOME_OFFICE_MAX_SQFT.value)
            ? `${input.homeOfficeSqft} sq ft entered; only ${K.HOME_OFFICE_MAX_SQFT.value} sq ft count under this method.`
            : `${input.homeOfficeSqft} sq ft entered.`,
          ...(limitReason ? [limitReason] : []),
          ...(grossIncomeLimit === null ? ["The gross income limitation (Schedule C line 29) is not known yet, so the allowed amount cannot be figured."] : []),
        ],
      },
      {
        id: "actual",
        label: "Actual expenses (Form 8829)",
        status: "not_yet_computed",
        isDefault: false,
        inForce: chosen === "actual",
        lines: [],
        effect: null,
        reasons: [
          "Form 8829 (area percentage, expenses, depreciation of the business share) is computed in a later phase.",
          homeCandidatesCents > 0
            ? `Booked home-office accounts total ${fmt(centsToDollars(homeCandidatesCents))} (inputs to this method).`
            : "No home-office accounts are booked.",
        ],
      },
    ];
    if (chosen === "simplified" && grossIncomeLimit === null) {
      block(
        "30",
        worstBlocked([statusOfId("29")]) ?? "missing_input",
        "The simplified home office deduction is limited to Schedule C line 29 (gross income limitation), which is not computed yet."
      );
    } else if (chosen === "simplified") {
      line30 = simplifiedLine.amount;
      lines.push(simplifiedLine);
      if (limitReason) reasons.push(limitReason);
      if (homeCandidatesCents > 0) {
        reasons.push(
          `Simplified home-office method in force: the ${fmt(centsToDollars(homeCandidatesCents))} booked to home-office accounts is left out of Schedule C (those actual expenses are not deductible with this method).`
        );
      }
    } else {
      block("30", "not_yet_computed", "The CPA chose the actual-expense method (Form 8829); it is computed in a later phase.");
    }
  }

  // ── Line 31 net profit ──────────────────────────────────────────────────────
  const l29 = amounts.get("29");
  if (l29 !== undefined && line30 !== null) {
    emit("31", l29.minus(line30));
    reasons.push(`Net profit ${fmt(amounts.get("31")!)}: gross income ${fmt(l7 ?? ZERO)} minus expenses ${fmt(l28 ?? ZERO)} minus home office ${fmt(line30)}.`);
  } else {
    block("31", worstBlocked([statusOfId("29"), statusOfId("30")]) ?? "missing_input", "Tentative profit or the home office deduction is not computed.");
  }

  // B1: transactions with no GL code are invisible to the P&L: the totals cannot be trusted, never a silent number.
  const uncoded = input.uncodedTransactionCount ?? 0;
  if (uncoded > 0) {
    const why = `${uncoded} 2025 EK Consulting transaction(s) have no GL code, so the books are incomplete (the P&L only sees coded transactions).`;
    for (const id of ["28", "29", "31"] as const) {
      const idx = lines.findIndex((l) => l.key === scheduleCLineKey(id));
      const blockedLn = blockedLine(scheduleCLineKey(id), lbl(id), formLineOf(id), "missing_input", why);
      if (idx >= 0) lines[idx] = blockedLn;
      else lines.push(blockedLn);
      amounts.delete(id);
    }
    for (let i = reasons.length - 1; i >= 0; i--) if (reasons[i]!.startsWith("Net profit ")) reasons.splice(i, 1);
    reasons.push(why);
    missing.push("GL code on every EK Consulting 2025 transaction");
  }

  // detail lines
  for (const id of EXPENSE_LINE_IDS) {
    const accts = lineAccounts.get(id) ?? [];
    if (accts.length === 0) continue;
    detail.lines.push({ lineId: id, amountCents: dollarsToCents(amounts.get(id) ?? ZERO), accounts: accts });
  }
  for (const id of ["1", "2", "6"] as const) {
    const accts = lineAccounts.get(id) ?? [];
    if (accts.length === 0) continue;
    detail.lines.push({ lineId: id, amountCents: dollarsToCents(amounts.get(id) ?? ZERO), accounts: accts });
  }

  // ── Mixed-use accounts (decisions X6 ...): one result per list entry that has a booked amount ────────────────
  const businessUseResults: RuleResult[] = [];
  for (const def of BUSINESS_USE_ACCOUNTS) {
    const f = flagged.get(def.key);
    if (!f) continue;
    const rec = input.businessUseDecisions?.[def.key];
    const decided = validTenths(rec);
    const tenths = validTenths(rec) ? rec.percentTenths : BUSINESS_USE_DEFAULT_TENTHS;
    const pct = formatBusinessUsePercent(tenths);
    const lineKey = scheduleCLineKey(f.line);
    const mine = (a: ScheduleCAccountDetail) => a.businessUseDecisionId === def.decisionId;
    const atFull = amountLine(lineKey, lbl(f.line), formLineOf(f.line), lineExact(f.line, (a) => (mine(a) ? BUSINESS_USE_DEFAULT_TENTHS : a.businessUsePercentTenths)));
    const atRecorded = amountLine(lineKey, lbl(f.line), formLineOf(f.line), lineExact(f.line, inForce));
    const rawCents = f.accounts.reduce((n, a) => n + a.rawCents, 0);
    const deductibleCents = f.accounts.reduce((n, a) => n + a.deductibleCents, 0);
    const personalCents = rawCents - deductibleCents;
    const otherAccountsOnLine = (lineAccounts.get(f.line) ?? []).some((a) => !mine(a));
    const alsoNote = otherAccountsOnLine ? " (the line's other accounts as they are in force)" : "";
    const lineWhere = `Schedule C line ${f.line}`;
    const fullAmount = atFull.amount as Decimal;
    const recordedAmount = atRecorded.amount as Decimal;
    const fullInForce = !decided || tenths === BUSINESS_USE_DEFAULT_TENTHS;
    const status: RuleDecision["status"] = decided ? "decided" : "default_undecided";
    const businessUseDecision: RuleDecision = {
      id: def.decisionId,
      label: def.label,
      chosen: pct,
      status,
      ...(decided && rec ? { decidedBy: rec.by, decidedAt: rec.at } : {}),
    };
    const alts: RuleAlternative[] = [
      {
        id: "full",
        label: "100% business use (no split)",
        status: "computed",
        isDefault: true,
        inForce: fullInForce,
        lines: [atFull],
        effect: { amount: fullAmount, note: `${lineWhere} would be ${fmt(fullAmount)}${alsoNote}; nothing is treated as personal.` },
        reasons: [`The whole ${fmt(centsToDollars(rawCents))} booked to the shared account(s) is deducted.`],
      },
    ];
    if (decided && tenths !== BUSINESS_USE_DEFAULT_TENTHS) {
      alts.push({
        id: "recorded",
        label: `${pct} business use (your recorded share)`,
        status: "computed",
        isDefault: false,
        inForce: true,
        lines: [atRecorded],
        effect: {
          amount: recordedAmount,
          note: `${lineWhere} is ${fmt(recordedAmount)}${alsoNote}: ${pct} of the ${fmt(centsToDollars(rawCents))} booked. The other ${fmt(centsToDollars(personalCents))} is personal: not deducted, not a Schedule C amount (informational; nothing is changed in the books).`,
        },
        reasons: [`${pct} is the owner's own statement of the business share; no document supports it.`],
      });
    } else if (!decided) {
      alts.push({
        id: "recorded",
        label: "A recorded business-use share (none recorded yet)",
        status: "not_yet_computed",
        isDefault: false,
        inForce: false,
        lines: [],
        effect: null,
        reasons: ["No percentage is recorded yet."],
      });
    }
    businessUseResults.push({
      ruleId: `schedule-c-business-use:${def.key}`,
      form: "Schedule C",
      status: "computed",
      lines: [],
      reasons: [
        decided
          ? `Business-use share ${pct} (decision ${def.decisionId}, the owner's statement, not verified by documents): ${fmt(centsToDollars(deductibleCents))} of the ${fmt(centsToDollars(rawCents))} booked is deducted on ${lineWhere}; ${fmt(centsToDollars(personalCents))} is personal (informational, nothing is booked).`
          : `No business-use percentage is recorded for ${def.what}: 100% is used (the booked ${fmt(centsToDollars(rawCents))} on ${lineWhere}), flagged default, undecided.`,
      ],
      citations: [],
      inputsUsed: [],
      inputsMissing: [],
      decision: businessUseDecision,
      alternatives: alts,
    });
    for (const a of f.accounts) {
      detail.businessUse.push({
        decisionId: def.decisionId,
        accountCode: a.code,
        accountName: a.name,
        rawCents: a.rawCents,
        percentTenths: a.businessUsePercentTenths ?? BUSINESS_USE_DEFAULT_TENTHS,
        deductibleCents: a.deductibleCents,
        personalCents: a.rawCents - a.deductibleCents,
        status,
        ...(decided && rec ? { decidedBy: rec.by, decidedAt: rec.at } : {}),
        lineId: f.line,
        lineAtFullDollars: fullAmount.toNumber(),
        lineDollars: recordedAmount.toNumber(),
      } satisfies ScheduleCBusinessUse);
    }
  }

  return {
    result: {
      ...base,
      status: aggregateStatus(lines),
      lines,
      reasons,
      inputsMissing: missing,
      ...(decision ? { decision } : {}),
      ...(alternatives ? { alternatives } : {}),
    },
    detail,
    businessUseResults,
  };
}

/** Schedule C line keys a rule result carries (helper for tests / assembler). */
export function scheduleCKeys(): LineKey[] {
  return Object.keys(LINE_LABELS).map((id) => scheduleCLineKey(id as ScheduleCLineId));
}

