// The TY2025 return assembler: Ty2025Facts + recorded decisions -> Ty2025Return.
//
// PURE and TOTAL: it never throws on missing data (every gap becomes a line status
// and an open item). Every printed money line in the catalog (line-catalog.ts) ends
// up in `lines` with an explicit status; nothing is ever a silent 0:
//   - a line a rule emits keeps that rule's status and amount;
//   - a plain-sum subtotal is computed from its component keys, or is blocked with the
//     worst status among them;
//   - a rare-situation line (other income types, other credits ...) is
//     not_applicable 0 only when the owner/CPA stated "none" for its group, otherwise
//     not_yet_computed (see line-catalog.ts);
//   - the Phase 1b lines (Schedule 1-A, HSA, IRA, saver's credit, foreign tax credit,
//     the Form 2210 estimate, CT use tax) are COMPUTED by their rules from the owner's
//     "Return completeness" answers (facts.returnAnswers) and the documents; an
//     unanswered input gives missing_input, "not sure" gives needs_cpa_judgment. A
//     stated amount on facts.adjustments / facts.credits still overrides the rule
//     (a CPA / owner override path) and is cited as stated.
//
// Amounts: every line is a whole-dollar integer (roundLine); lines that add several
// items sum the cents first inside their rule, lines that add other LINES use the
// rounded line values, as a filer who rounds does.
//
// A second ("provisional") pass treats every unresolved input as $0 / none and lists
// exactly what it assumed, so the sheet can show best-known numbers without ever
// presenting them as computed.

import { Decimal } from "@prisma/client/runtime/library";
import { MISSING, ans, answered, mapAns, type Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import {
  aggregateInvestments,
  aggregateW2s,
  estimatesForYear,
  estimatesPaidInYear,
  leafDollars,
  scheduleAInputs,
  scheduleDInput,
  section1256Present,
  sumCentsStrict,
} from "@/lib/tax2025/inputs";
import { LINE_CATALOG, NONE_GROUP_TEXT, lineMeta, type NoneGroupId } from "@/lib/tax2025/line-catalog";
import { D, ZERO, centsToDollars, fmt, maxD, roundLine } from "@/lib/tax2025/money";
import { computeCtPayments, computeExcessSocialSecurity, computeFederalPayments } from "@/lib/tax2025/rules/payments";
import { computeCtBalance, computeCtPropertyTaxCredit, computeCtTax } from "@/lib/tax2025/rules/ct";
import { CT_CREDIT_LINES, computeCtOtherCredits } from "@/lib/tax2025/rules/ct-credits";
import { computeCtSettlement } from "@/lib/tax2025/rules/ct-settlement";
import { computeFederalOverpayment, federalPenaltyExceedsOverpayment } from "@/lib/tax2025/rules/overpayment-federal";
import {
  CT_SCH1_ADDITION_KEYS,
  CT_SCH1_GROUPS,
  CT_SCH1_SUBTRACTION_KEYS,
  computeCtSchedule1,
  type CtFederalLead,
  type CtSchedule1Input,
} from "@/lib/tax2025/rules/ct-schedule1";
import { computeCtUseTax } from "@/lib/tax2025/rules/ct-use-tax";
import { computeForeignTaxCredit } from "@/lib/tax2025/rules/foreign-tax";
import { computeHsa8889, type HsaPersonInput } from "@/lib/tax2025/rules/hsa-8889";
import { computeIraDeduction, type IraPersonInput } from "@/lib/tax2025/rules/ira-deduction";
import { computePenalty2210 } from "@/lib/tax2025/rules/penalty-2210";
import { computeQbi8995 } from "@/lib/tax2025/rules/qbi-8995";
import { computeScheduleA } from "@/lib/tax2025/rules/schedule-a";
import { computeSaversCredit } from "@/lib/tax2025/rules/saver-8880";
import { computeStandardDeduction } from "@/lib/tax2025/rules/standard-deduction";
import { computeSchedule1a } from "@/lib/tax2025/rules/schedule-1a";
import { computeSchedule3Summary } from "@/lib/tax2025/rules/schedule-3";
import { computeScheduleC } from "@/lib/tax2025/rules/schedule-c";
import { computeStateRefund } from "@/lib/tax2025/rules/state-refund";
import { carryoverOutOpenItem, computeCapitalLossCarryoverOut, computeScheduleD, type ScheduleDOutput } from "@/lib/tax2025/rules/schedule-d";
import { computeForm8959, computeScheduleSe } from "@/lib/tax2025/rules/se-medicare";
import { computeAmtScreen } from "@/lib/tax2025/rules/screens";
import { FORM_8960_KEYS, computeForm8960, type Form8960Lead } from "@/lib/tax2025/rules/form-8960";
import { computeForm8606 } from "@/lib/tax2025/rules/form-8606";
import { computeIncomeTax } from "@/lib/tax2025/rules/tax-calc";
import {
  LINE_KEYS,
  hasAmount,
  worstBlocked,
  type FactConflict,
  type AttestationAnswer,
  type FormId,
  type FormRequirement,
  type Headline,
  type HeadlineAmount,
  type LineKey,
  type OpenItem,
  type ProvisionalHeadline,
  type Ref,
  type ReturnLine,
  type RuleDecision,
  type RuleLine,
  type RuleResult,
  type RuleStatus,
  type ScheduleCDetail,
  type ScheduleDDetail,
  type Sourced,
  type Ty2025Decisions,
  type Ty2025Return,
} from "@/lib/tax2025/types";

/** Bumped whenever a rule, the constants or the line catalog changes (stale-output detection for stored overrides / PDFs). */
export const TY2025_ENGINE_VERSION = "ty2025-1b.10";

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

interface Gate {
  groups: readonly NoneGroupId[];
  lines: readonly LineKey[] | "all";
}

/** Rule outputs that include lines which depend on a "none" group the owner has not stated yet. */
const GATES: Readonly<Record<string, readonly Gate[]>> = {
  "schedule-se": [{ groups: ["se_other"], lines: "all" }],
  "addl-medicare-8959": [{ groups: ["se_other"], lines: "all" }],
  "schedule-a": [
    { groups: ["sch_a_other"], lines: ["scha.14"] },
    { groups: ["medical_expenses", "sch_a_other"], lines: ["scha.17"] },
    // 12e = max(itemized, standard); the standard deduction itself (+$1,600 per age 65+ / blind box) comes from standard-deduction.ts
    { groups: ["medical_expenses", "sch_a_other"], lines: ["f1040.12e"] },
  ],
  "qbi-8995": [{ groups: ["qbi_carryforwards"], lines: "all" }],
  "schedule-c": [{ groups: ["sch_c_other_lines"], lines: ["schc.28", "schc.29", "schc.31"] }],
  "payments-federal": [{ groups: ["other_refundable_credits"], lines: ["sch3.15", "f1040.31", "f1040.33"] }],
  // Form 1040 line 16 also holds the tax on a section 962 election, the recapture of an education credit, a Form 8621 section 1291 fund
  // and a Form 8978 amount (2025 Form 1040 instructions, "Line 16"): the same statement that clears Schedule 2 Part I covers them.
  "tax-calc": [{ groups: ["other_taxes"], lines: ["f1040.16"] }],
};

const NO_AMOUNT_ZERO_REASON = "Assumed $0 in the provisional estimate.";

class Assembly {
  readonly lines = new Map<LineKey, ReturnLine>();
  readonly results: RuleResult[] = [];
  readonly assumedZero = new Set<LineKey>();
  readonly assumedFacts: string[] = [];
  readonly duplicates: LineKey[] = [];
  readonly citations = new Set<string>();
  readonly decisions: RuleDecision[] = [];
  readonly resultLineKeys = new Map<string, LineKey[]>();
  scheduleC: ScheduleCDetail | null = null;
  scheduleD: ScheduleDDetail | null = null;
  scheduleDItems: OpenItem[] = [];
  /** Advisory items raised by the overpayment rule (a printed penalty above the overpayment). */
  overpaymentItems: OpenItem[] = [];
  /** The Schedule D Tax Worksheet would be needed (not implemented): Form 1040 line 16 is blocked with this. */
  scheduleDTaxBlock: ScheduleDOutput["taxBlock"] = null;

  constructor(
    readonly facts: Ty2025Facts,
    readonly fill: boolean
  ) {}

  // ── reading ────────────────────────────────────────────────────────────────

  private amountOf(key: LineKey): Decimal | null {
    const l = this.lines.get(key);
    return l !== undefined && hasAmount(l.status) && l.amount !== null ? new Decimal(l.amount) : null;
  }

  statusOf(key: LineKey): RuleStatus | undefined {
    return this.lines.get(key)?.status;
  }

  /** A line's amount WITHOUT the provisional fill (informational reads must not pollute the assumed-zero list). */
  peek(key: LineKey): Decimal | null {
    return this.amountOf(key);
  }

  /** A line's whole-dollar amount; null when blocked. In the provisional pass a blocked line reads as 0 and is recorded. */
  num(key: LineKey): Decimal | null {
    const a = this.amountOf(key);
    if (a !== null) return a;
    if (this.fill) {
      this.assumedZero.add(key);
      return ZERO;
    }
    return null;
  }

  /** In the provisional pass a missing INPUT is replaced and recorded; strict mode keeps null. */
  assume<T>(value: T | null, fallback: T, what: string): T | null {
    if (value !== null) return value;
    if (!this.fill) return null;
    this.assumedFacts.push(what);
    return fallback;
  }

  // ── writing ────────────────────────────────────────────────────────────────

  put(line: ReturnLine): void {
    if (this.lines.has(line.key)) {
      this.duplicates.push(line.key);
      return;
    }
    this.lines.set(line.key, line);
  }

  private line(
    key: LineKey,
    status: RuleStatus,
    amount: Decimal | null,
    reason: string | null,
    ruleId: string,
    citations: string[] = [],
    refs: Ref[] = [],
    exact: Decimal | null = amount
  ): void {
    const meta = lineMeta(key);
    this.put({
      key,
      form: meta.form,
      formLine: meta.formLine,
      label: meta.label,
      status,
      amount: hasAmount(status) && amount !== null ? roundLine(amount).toNumber() : null,
      exact: hasAmount(status) && exact !== null ? exact.toString() : null,
      reason,
      ruleId,
      citations,
      refs,
    });
  }

  fixed(key: LineKey, amount: Decimal, status: "computed" | "not_applicable", reason: string | null, ruleId: string, refs: Ref[] = []): void {
    this.line(key, status, amount, reason, ruleId, [], refs);
  }

  blocked(key: LineKey, status: Blocked, reason: string, ruleId: string, informational = false): void {
    this.line(key, status, null, reason, ruleId);
    if (informational) {
      const l = this.lines.get(key);
      if (l) this.lines.set(key, { ...l, informational: true });
    }
  }

  /** Registers a rule result: its lines enter the return (first writer of a key wins), gated by "none" statements. */
  register(
    result: RuleResult,
    opts: { refs?: Ref[]; skip?: readonly LineKey[]; owns?: readonly LineKey[] } = {}
  ): RuleResult {
    let working = result;
    const gates = GATES[result.ruleId];
    if (gates && !this.fill) {
      const gated = result.lines.map((l): RuleLine => {
        const missingGroups = new Set<NoneGroupId>();
        for (const g of gates) {
          if (g.lines !== "all" && !g.lines.includes(l.key)) continue;
          for (const grp of g.groups) if (this.facts.statedNone[grp]?.value !== true) missingGroups.add(grp);
        }
        const status = l.status ?? result.status;
        if (missingGroups.size === 0 || !hasAmount(status)) return l;
        const why = [...missingGroups].map((grp) => NONE_GROUP_TEXT[grp]).join(" ");
        const statedFalse = [...missingGroups].some((grp) => this.facts.statedNone[grp]?.value === false);
        return {
          ...l,
          amount: null,
          exact: null,
          status: statedFalse ? "needs_cpa_judgment" : "not_yet_computed",
          reason: `Needs an owner/CPA statement before this line is final. ${why}`,
        };
      });
      const changed = gated.some((g, i) => g !== result.lines[i]);
      working = {
        ...result,
        lines: gated,
        status: aggregateGated(gated, result.status),
        reasons: changed
          ? ["Not final yet: some lines wait for owner/CPA \"none\" statements (see the statement items); the computed figures are shown in the provisional estimate.", ...result.reasons]
          : result.reasons,
      };
    }
    this.results.push(working);
    for (const c of working.citations) this.citations.add(c);
    const keys: LineKey[] = [];
    for (const l of working.lines) {
      if (opts.skip?.includes(l.key)) continue;
      const status = l.status ?? working.status;
      this.put({
        key: l.key,
        form: lineMeta(l.key).form,
        formLine: lineMeta(l.key).formLine,
        label: lineMeta(l.key).label,
        status,
        amount: hasAmount(status) && l.amount !== null ? l.amount.toNumber() : null,
        exact: hasAmount(status) && l.exact !== undefined && l.exact !== null ? l.exact.toString() : hasAmount(status) && l.amount !== null ? l.amount.toString() : null,
        reason: l.reason ?? null,
        ...(l.informational ? { informational: true } : {}),
        ruleId: working.ruleId,
        citations: working.citations,
        refs: l.refs ?? opts.refs ?? [],
      });
      keys.push(l.key);
    }
    // Lines the rule owns but did not emit (it stopped early): carry the rule's blocking status.
    for (const key of opts.owns ?? []) {
      if (this.lines.has(key) || keys.includes(key)) continue;
      const st: Blocked = worstBlocked([working.status]) ?? "missing_input";
      this.line(key, st, null, working.reasons[0] ?? "Not computed.", working.ruleId, working.citations, opts.refs ?? []);
      keys.push(key);
    }
    this.resultLineKeys.set(working.ruleId, keys);
    if (working.decision) this.decisions.push(working.decision);
    return working;
  }

  /** key = fn(rounded component amounts); blocked with the worst component status when a component has no amount. */
  derive(key: LineKey, deps: readonly LineKey[], fn: (v: Decimal[]) => Decimal, refs: Ref[] = []): void {
    const missingDeps = deps.filter((d) => this.amountOf(d) === null && !this.fill);
    if (missingDeps.length > 0) {
      const status = worstBlocked(missingDeps.map((d) => this.statusOf(d))) ?? "missing_input";
      this.blocked(key, status, `Depends on lines not computed yet: ${missingDeps.map((d) => `${lineMeta(d).form} ${lineMeta(d).formLine}`).join(", ")}.`, "derive");
      return;
    }
    const values = deps.map((d) => this.num(d) ?? ZERO);
    this.line(key, "computed", fn(values), `From ${depList(deps)}.`, "derive", [], this.inheritedRefs(deps, refs));
  }

  /** Provenance of a derived line: the references of every line it is built from (deduplicated). */
  private inheritedRefs(deps: readonly LineKey[], extra: Ref[] = []): Ref[] {
    const seen = new Set<string>();
    const out: Ref[] = [];
    for (const r of [...extra, ...deps.flatMap((d) => this.lines.get(d)?.refs ?? [])]) {
      const id = `${r.kind}:${r.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
      if (out.length >= 25) break;
    }
    return out;
  }

  sum(key: LineKey, deps: readonly LineKey[], refs: Ref[] = []): void {
    this.derive(key, deps, (v) => v.reduce((a, b) => a.plus(b), ZERO), refs);
  }

  copy(key: LineKey, from: LineKey, refs: Ref[] = []): void {
    const src = this.lines.get(from);
    if (src !== undefined && hasAmount(src.status) && src.amount !== null) {
      this.line(
        key,
        src.status === "not_applicable" ? "not_applicable" : "computed",
        new Decimal(src.amount),
        src.status === "not_applicable" ? src.reason : `Copied from ${depList([from])}.`,
        "derive",
        [],
        this.inheritedRefs([from], refs)
      );
      return;
    }
    if (this.fill) {
      this.assumedZero.add(from);
      this.line(key, "computed", ZERO, `Copied from ${depList([from])} (assumed $0).`, "derive", [], refs);
      return;
    }
    this.blocked(key, worstBlocked([src?.status]) ?? "missing_input", `Depends on ${lineMeta(from).form} ${lineMeta(from).formLine}, which is not computed yet.`, "derive");
  }

  /** A line whose value is a STATED amount (cents) from the owner/CPA; null leaf -> the given blocking status. */
  stated(key: LineKey, leaf: Sourced<number>, whenNull: { status: Blocked; reason: string }): void {
    if (leaf.value !== null) {
      this.line(key, "computed", centsToDollars(leaf.value), `Stated by ${leaf.basis === "answer_cpa" ? "the CPA" : "the owner"}.`, "stated", [], leaf.refs);
      return;
    }
    if (this.fill) {
      this.assumedFacts.push(`${lineMeta(key).form} ${lineMeta(key).formLine}: no amount stated, assumed $0`);
      this.line(key, "computed", ZERO, NO_AMOUNT_ZERO_REASON, "stated");
      return;
    }
    this.blocked(key, whenNull.status, whenNull.reason, "stated");
  }
}

function depList(keys: readonly LineKey[]): string {
  return keys.map((k) => `${lineMeta(k).form} ${lineMeta(k).formLine}`).join(", ");
}

function aggregateGated(lines: readonly RuleLine[], fallback: RuleStatus): RuleStatus {
  const statuses = lines.map((l) => l.status ?? fallback);
  const worst = worstBlocked(statuses);
  if (worst !== null) return worst;
  return statuses.length > 0 && statuses.every((s) => s === "not_applicable") ? "not_applicable" : "computed";
}

// ── The assembly proper ───────────────────────────────────────────────────────

function dollarsOrNull(leaf: Sourced<number>): Decimal | null {
  return leaf.value === null ? null : centsToDollars(leaf.value);
}

function assemble(facts: Ty2025Facts, decisions: Ty2025Decisions, fill: boolean): Assembly {
  const A = new Assembly(facts, fill);
  const sc = facts.income.scheduleC;
  const w2 = aggregateW2s(facts);
  const inv = aggregateInvestments(facts);
  const w2Refs = facts.income.w2s.flatMap((w) => w.refs);
  const interestRefs = facts.income.interest.flatMap((i) => i.refs);
  const dividendRefs = facts.income.dividends.flatMap((d) => d.refs);
  const bookRefs: Ref[] = sc.glLines.map((g) => ({ kind: "gl", id: g.code, label: g.name }));
  const ra = facts.returnAnswers;
  const dollarsAns = (leaf: Sourced<number>): Ans<Decimal> => mapAns(ans(leaf), centsToDollars);
  const refsFrom = (...leaves: Sourced<unknown>[]): Ref[] => {
    const seen = new Set<string>();
    const out: Ref[] = [];
    for (const l of leaves) {
      for (const r of l.refs) {
        const id = `${r.kind}:${r.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(r);
      }
    }
    return out;
  };
  const personRefs = (p: (typeof ra.people)[number]): Ref[] =>
    refsFrom(p.bornBefore1961, p.blind, p.validSsn, p.coveredByWorkplacePlan, p.deferralsCents, p.traditionalIraCents, ...(p.priorBasisCents === undefined ? [] : [p.priorBasisCents]), p.rothIraCents, p.age50Plus, p.age55Plus, p.hsaCoverage, p.hsaMonthsEligible, p.hsaEligibleDec1, p.hsaMedicareOrDependent, p.hsaDirectContributionsCents, p.hsaEmployerOtherYear, p.hsaDistributions, p.tipsChoice, p.tipsCents, p.overtimeChoice, p.overtimeCents);
  const w2sOf = (userId: string | null) => (userId === null ? [] : facts.income.w2s.filter((w) => w.personUserId === userId));
  /** W-2 box 12 code W (employer HSA contributions) for a person; null when unknowable (no person match or an older-format W-2). */
  const employerHsa = (userId: string | null): Decimal | null => {
    if (userId === null) return null;
    const mine = w2sOf(userId);
    if (mine.some((w) => w.legacyFormat)) return null;
    return mine.reduce((acc, w) => acc.plus(centsToDollars(w.box12.filter((e) => e.code === "W").reduce((a, e) => a + e.amountCents, 0))), ZERO);
  };

  // 0a. The owner's "other income" was (partly) a state income tax refund: Schedule 1 line 1 is computed by the refund worksheet rule
  const oi = ra.otherIncome;
  const oiKinds = oi?.kinds.value ?? null;
  const refundRuleOn = oi !== undefined && oiKinds !== null && oiKinds.includes("refund") && facts.statedNone.other_income?.value === false;
  const refundOnly = refundRuleOn && oiKinds !== null && oiKinds.every((k) => k === "refund");
  if (refundRuleOn && oi !== undefined) {
    const refundResult = computeStateRefund({
      refund: dollarsAns(oi.refundCents),
      deduction2024: ans(oi.deduction2024),
      filedJoint2024: ans(ra.priorYear.filedJoint),
      sch5d: dollarsAns(oi.sch5dCents),
      sch5e: dollarsAns(oi.sch5eCents),
      sch17: dollarsAns(oi.sch17Cents),
      boxes2024: ans(oi.boxes2024),
      exceptionApplies: ans(oi.exceptionApplies),
    });
    A.register(refundResult, { refs: refsFrom(oi.kinds, oi.refundCents, oi.deduction2024, oi.sch5dCents, oi.sch5eCents, oi.sch17Cents, oi.boxes2024, oi.exceptionApplies, ra.priorYear.filedJoint) });
  }
  const carriedAmount = (group: NoneGroupId): string => {
    const a = ra.statedSomeAmounts[group]?.value;
    return a === null || a === undefined ? "" : ` (about ${fmt(centsToDollars(a))})`;
  };

  // 0. "none" group lines (statement-driven; overridden when an uncomputed document box says otherwise)
  for (const meta of LINE_CATALOG) {
    if (!meta.group) continue;
    if (meta.key === "sch1.1" && refundRuleOn) continue;
    const stmt = facts.statedNone[meta.group];
    const forcedCpa =
      (meta.group === "retirement_ss_income" && inv.hasRetirementOrSsBoxes) ||
      (meta.group === "other_income" && inv.hasOtherIncomeBoxes) ||
      // Section 1256 contracts (Form 6781) feed Schedule D lines 4 and 11: never computed, whatever the owner stated
      (meta.group === "capital_gain_other" && section1256Present(facts));
    if (fill) {
      A.fixed(meta.key, ZERO, "not_applicable", "Assumed none in the provisional estimate.", "none-group");
      if (stmt?.value !== true) A.assumedZero.add(meta.key);
    } else if (forcedCpa) {
      A.blocked(meta.key, "needs_cpa_judgment", "A 1099 document reports income of this kind that the engine does not compute (see the open items).", "none-group");
    } else if (stmt?.value === true) {
      A.fixed(meta.key, ZERO, "not_applicable", `Stated: ${NONE_GROUP_TEXT[meta.group]}`, "none-group", stmt.refs);
    } else if (stmt?.value === false && meta.group === "other_income" && refundOnly) {
      A.fixed(meta.key, ZERO, "not_applicable", "The owner's other income was only a state income tax refund, reported on Schedule 1 line 1 (see that line).", "none-group", stmt.refs);
    } else if (stmt?.value === false) {
      A.blocked(meta.key, "needs_cpa_judgment", `The owner answered Yes for this group${carriedAmount(meta.group)}: the CPA must classify and report it (the amounts are not computed here). The statement that does not hold: ${NONE_GROUP_TEXT[meta.group]}`, "none-group");
    } else {
      A.blocked(meta.key, "not_yet_computed", `Needs an owner/CPA statement: ${NONE_GROUP_TEXT[meta.group]}`, "none-group");
    }
  }

  // Two lines the 2025 instructions say to leave blank ("Leave line 24z blank", "Leave line 6z blank"): zero whatever the owner states.
  A.fixed("sch1.24z", ZERO, "not_applicable", "The 2025 instructions say to leave Schedule 1 line 24z blank.", "irs-leave-blank");
  A.fixed("sch3.6z", ZERO, "not_applicable", "The 2025 instructions say to leave Schedule 3 line 6z blank.", "irs-leave-blank");

  // 1. Schedule C
  const noMileage = sc.mileageNoneConfirmed.value;
  const schedCInput = {
    glLines: sc.glLines,
    booksEmpty: sc.booksEmpty,
    uncodedTransactionCount: fill ? 0 : (sc.uncodedTransactionCount ?? 0),
    mileage: sc.mileage,
    mileageNoneConfirmed: fill ? (noMileage ?? sc.mileage.length === 0) : noMileage === true,
    homeOfficeEligibility: sc.homeOfficeEligibility.value ?? (fill ? ("no" as const) : null),
    homeOfficeSqft: sc.homeOfficeSqft.value ?? (fill ? 0 : null),
    fixedAssets: sc.fixedAssets,
    fixedAssetsNoneConfirmed: fill ? sc.fixedAssetsNoneConfirmed || sc.fixedAssets.length === 0 : sc.fixedAssetsNoneConfirmed,
    ...(decisions.homeOfficeMethod ? { homeOfficeDecision: decisions.homeOfficeMethod } : {}),
    ...(decisions.businessUse ? { businessUseDecisions: decisions.businessUse } : {}),
  };
  if (fill) {
    if (sc.mileageNoneConfirmed.value === null && sc.mileage.length === 0) A.assumedFacts.push("No business mileage (not stated)");
    if (sc.homeOfficeEligibility.value === null) A.assumedFacts.push("No home office deduction (eligibility not answered)");
    if (!sc.fixedAssetsNoneConfirmed && sc.fixedAssets.length === 0) A.assumedFacts.push("No depreciable EK Consulting assets (not confirmed)");
  }
  if (fill && (sc.uncodedTransactionCount ?? 0) > 0) {
    A.assumedFacts.push(`${sc.uncodedTransactionCount} uncoded EK Consulting transaction(s) ignored (not in any Schedule C total)`);
  }
  const schedC = computeScheduleC(schedCInput);
  A.scheduleC = schedC.detail;
  A.register(schedC.result, { refs: bookRefs });
  // Mixed-use accounts (X6 ...): each hosts its own decision (one decision per result is an invariant of every consumer)
  for (const r of schedC.businessUseResults) A.register(r);
  A.copy("sch1.3", "schc.31", bookRefs);

  // 2. Self-employment tax and Form 8959
  const ownerLabel = facts.household.people.find((p) => p.userId === sc.ownerUserId.value)?.name ?? "the Schedule C owner";
  const netProfit = A.num("schc.31");
  const ownerSs = A.assume(w2.ownerSsWagesAndTips, ZERO, "Schedule C owner's W-2 Social Security wages (box 3 + 7), assumed $0 (overstates SE tax)");
  const se = computeScheduleSe({ netProfit, ssWagesAndTips: ownerSs, ownerLabel });
  A.register(se, { refs: [...bookRefs, ...facts.income.w2s.filter((w) => w.personUserId === sc.ownerUserId.value).flatMap((w) => w.refs)] });
  A.copy("se.2", "schc.31");
  A.sum("se.8d", ["se.8a", "se.8b", "se.8c"]);
  const seNetEarnings = A.num("se.6");
  const medWages = A.assume(w2.medicareWages, ZERO, "W-2 Medicare wages (box 5), assumed $0");
  const largestBox5 = A.assume(w2.largestBox5, ZERO, "Largest W-2 Medicare wages, assumed $0");
  const medWithheld = A.assume(w2.medicareWithheld, ZERO, "W-2 Medicare tax withheld (box 6), assumed $0");
  const f8959 = computeForm8959({
    medicareWages: medWages,
    largestBox5,
    medicareWithheld: medWithheld,
    seNetEarnings: seNetEarnings,
  });
  const f8959r = A.register(f8959, { refs: w2Refs, skip: ["f1040.25c"], owns: ["f8959.18", "sch2.11", "f8959.24"] });

  // 3. Income lines
  const wagesAgg = A.assume(w2.wages, ZERO, "W-2 wages, assumed $0");
  if (wagesAgg !== null) A.fixed("f1040.1a", wagesAgg, "computed", null, "income", w2Refs);
  else
    A.blocked("f1040.1a", "missing_input", facts.income.w2s.length === 0 ? "No W-2 documents are on file for 2025." : "A W-2 has no wages (box 1) read.", "income");
  A.sum("f1040.1z", ["f1040.1a", "f1040.1b", "f1040.1c", "f1040.1d", "f1040.1e", "f1040.1f", "f1040.1g", "f1040.1h"], w2Refs);

  // Interest earned on the business bank account (books) is taxable interest, not Schedule C income: added here, cents first.
  const booksInterestCents = (A.scheduleC?.booksInterest ?? []).reduce((n, b) => n + b.amountCents, 0);
  const booksInterestRefs: Ref[] = (A.scheduleC?.booksInterest ?? []).map((b) => ({ kind: "gl", id: b.code, label: `${b.name} (books)` }));
  const docInterest = A.assume(inv.interest, ZERO, "Taxable interest, assumed $0");
  const interest = docInterest === null ? null : docInterest.plus(centsToDollars(booksInterestCents));
  const dividends = A.assume(inv.ordinaryDividends, ZERO, "Ordinary dividends, assumed $0");
  const qualified = A.assume(inv.qualifiedDividends, ZERO, "Qualified dividends, assumed $0");
  const taxExempt = A.assume(inv.taxExempt, ZERO, "Tax-exempt interest, assumed $0");
  const noInvestmentDocsReason = (what: string) =>
    `No 1099 ${what} income is on file and the owner has not confirmed there is none.`;
  if (taxExempt !== null) A.fixed("f1040.2a", taxExempt, "computed", null, "income", [...interestRefs, ...dividendRefs]);
  else A.blocked("f1040.2a", "missing_input", noInvestmentDocsReason("interest or dividend"), "income");
  const interestNote =
    booksInterestCents > 0
      ? "Interest box 1 plus box 3 (US savings bond / Treasury interest, taxable federally) plus interest earned on the business bank account per the books (provenance: books)."
      : "Interest box 1 plus box 3 (US savings bond / Treasury interest, taxable federally).";
  if (interest !== null) A.fixed("f1040.2b", interest, "computed", interestNote, "income", [...interestRefs, ...booksInterestRefs]);
  else A.blocked("f1040.2b", "missing_input", noInvestmentDocsReason("interest"), "income");
  if (qualified !== null) A.fixed("f1040.3a", qualified, "computed", null, "income", dividendRefs);
  else A.blocked("f1040.3a", "missing_input", noInvestmentDocsReason("dividend"), "income");
  if (dividends !== null) A.fixed("f1040.3b", dividends, "computed", null, "income", dividendRefs);
  else A.blocked("f1040.3b", "missing_input", noInvestmentDocsReason("dividend"), "income");
  // Schedule D (and the Form 8949 summary rows): the capital gain figures. It owns schd.*, 1040 line 7a and the QDCG worksheet line 3
  // (qdcg.3: the smaller of Schedule D line 15 or 16, NOT line 7a, once Schedule D is filed).
  const schedD = computeScheduleD(scheduleDInput(facts, inv, fill));
  A.scheduleD = schedD.detail;
  A.scheduleDItems = schedD.openItems;
  A.scheduleDTaxBlock = fill ? null : schedD.taxBlock;
  for (const what of schedD.assumptions) A.assumedFacts.push(what);
  A.register(schedD.result, { refs: dividendRefs });
  // 1040 line 7b: no verified meaning, left explicitly uncomputed
  A.blocked("f1040.7b", "not_yet_computed", "Not collected: see the 2025 Form 1040 instructions for line 7b.", "income", true);

  // Schedule B (payer rows are a table; the totals are lines)
  if (interest !== null) A.fixed("schb.2", interest, "computed", booksInterestCents > 0 ? "Includes one payer row 'Interest from business bank account (per EK Consulting books)'." : null, "income", [...interestRefs, ...booksInterestRefs]);
  else A.blocked("schb.2", "missing_input", noInvestmentDocsReason("interest"), "income");
  A.derive("schb.4", ["schb.2", "schb.3"], (v) => v[0]!.minus(v[1]!), interestRefs);
  if (dividends !== null) A.fixed("schb.6", dividends, "computed", null, "income", dividendRefs);
  else A.blocked("schb.6", "missing_input", noInvestmentDocsReason("dividend"), "income");

  // 4. Schedule 1 and the adjustments
  A.sum("sch1.9", ["sch1.8a", "sch1.8b", "sch1.8c", "sch1.8d", "sch1.8e", "sch1.8f", "sch1.8g", "sch1.8h", "sch1.8i", "sch1.8j", "sch1.8k", "sch1.8l", "sch1.8m", "sch1.8n", "sch1.8o", "sch1.8p", "sch1.8q", "sch1.8r", "sch1.8s", "sch1.8t", "sch1.8u", "sch1.8v", "sch1.8z"]);
  A.sum("sch1.10", ["sch1.1", "sch1.2a", "sch1.3", "sch1.4", "sch1.5", "sch1.6", "sch1.7", "sch1.9"]);
  A.copy("f1040.8", "sch1.10");
  if (facts.adjustments.hsa.value !== null) {
    A.stated("sch1.13", facts.adjustments.hsa, { status: "missing_input", reason: "HSA deduction." });
  } else {
    const hsa = computeHsa8889({
      people: ra.people.map(
        (p): HsaPersonInput => ({
          slot: p.slot,
          name: p.name,
          coverage: ans(p.hsaCoverage),
          monthsEligible: ans(p.hsaMonthsEligible),
          eligibleDec1: ans(p.hsaEligibleDec1),
          medicareOrDependent: ans(p.hsaMedicareOrDependent),
          age55Plus: ans(p.age55Plus),
          directContributions: dollarsAns(p.hsaDirectContributionsCents),
          employerOtherYear: ans(p.hsaEmployerOtherYear),
          distributions: ans(p.hsaDistributions),
          employerContributionsW2: employerHsa(p.userId),
        })
      ),
    });
    A.register(hsa, { refs: [...ra.people.flatMap(personRefs), ...facts.income.w2s.flatMap((w) => w.refs)] });
  }
  const unverifiedAdj = "Eligibility and plan-establishment rules for this self-employed deduction are not verified (specs/09); state the amount (0 if none) or the CPA decides.";
  // 0 (the owner states none) unblocks the line; a POSITIVE owner-stated amount is not deducted because the eligibility rules are not verified
  // (a CPA-stated amount is used as given).
  const seStated = (key: "sch1.16" | "sch1.17", leaf: Sourced<number>): void => {
    if (leaf.value !== null && leaf.value > 0 && leaf.basis !== "answer_cpa" && !fill) {
      A.blocked(key, "needs_cpa_rule_unverified", `The owner states ${fmt(centsToDollars(leaf.value))}; ${unverifiedAdj}`, "stated");
      return;
    }
    A.stated(key, leaf, { status: "needs_cpa_rule_unverified", reason: unverifiedAdj });
  };
  seStated("sch1.16", facts.adjustments.seRetirement);
  seStated("sch1.17", facts.adjustments.seHealthInsurance);
  A.sum("sch1.25", ["sch1.24a", "sch1.24b", "sch1.24c", "sch1.24d", "sch1.24e", "sch1.24f", "sch1.24g", "sch1.24h", "sch1.24i", "sch1.24j", "sch1.24k", "sch1.24z"]);
  A.sum("f1040.9", ["f1040.1z", "f1040.2b", "f1040.3b", "f1040.4b", "f1040.5b", "f1040.6b", "f1040.7a", "f1040.8"]);
  /** Provenance of one person's Form 8606 lines: their own answers, their W-2s and their retirement statement (Form 5498). */
  const form8606Refs = (slot: "a" | "b"): Ref[] => {
    const p = ra.people.find((x) => x.slot === slot);
    if (p === undefined) return [];
    const stmts = (facts.income.retirementStatements ?? []).filter((r) => p.userId !== null && r.personUserId === p.userId).flatMap((r) => r.refs);
    return [...personRefs(p), ...w2sOf(p.userId).flatMap((w) => w.refs), ...stmts];
  };
  const ndKeyOf = { a: "ira.a.nd", b: "ira.b.nd" } as const;
  if (facts.adjustments.ira.value !== null) {
    A.stated("sch1.20", facts.adjustments.ira, { status: "missing_input", reason: "IRA deduction." });
    // A STATED deduction replaces the IRA rule, so the part of a recorded traditional contribution that is not deducted (Form 8606 line 1)
    // is not figured: blocked. A person with no recorded contribution (answered 0, or the question is unanswered while the deduction is
    // stated, like the other per-person IRA lines) has no Form 8606 amount to figure.
    for (const slot of ["a", "b"] as const) {
      const p = ra.people.find((x) => x.slot === slot);
      if (p === undefined) A.fixed(ndKeyOf[slot], ZERO, "not_applicable", "No second person on this return.", "ira-deduction", []);
      else if (p.traditionalIraCents.value === null) A.fixed(ndKeyOf[slot], ZERO, "not_applicable", "The IRA deduction is stated and no traditional IRA contribution is recorded (the question is unanswered), so no Form 8606 amount is figured here.", "ira-deduction", form8606Refs(slot));
      else if (p.traditionalIraCents.value === 0) A.fixed(ndKeyOf[slot], ZERO, "not_applicable", "No traditional IRA contribution for 2025 (owner answer), so no Form 8606.", "ira-deduction", form8606Refs(slot));
      else A.blocked(ndKeyOf[slot], "needs_cpa_judgment", `${p.name}: the IRA deduction is stated, not computed, so the part of the contribution that is not deducted (Form 8606 line 1) is not figured. You decide it.`, "ira-deduction");
    }
  } else {
    // Pub. 590-A Worksheet 1-1 / the 1040 IRA worksheet: Form 1040 line 9 minus Schedule 1 lines 11 through 19a, 23 and 25.
    const total = A.num("f1040.9");
    const parts = (["sch1.11", "sch1.12", "sch1.13", "sch1.14", "sch1.15", "sch1.16", "sch1.17", "sch1.18", "sch1.19a", "sch1.23", "sch1.25"] as const).map((k) => A.num(k));
    const iraMagi = total !== null && parts.every((x) => x !== null) ? total.minus(parts.reduce<Decimal>((acc, x) => acc.plus(x as Decimal), ZERO)) : null;
    /** Compensation for the IRA limit: the person's W-2 box 1 wages plus, for the Schedule C owner, net profit less Schedule 1 lines 15 and 16. */
    const compensation = (userId: string | null): Decimal | null => {
      if (userId === null || w2.unattributedW2Count > 0) return null;
      const wages = sumCentsStrict(w2sOf(userId).map((w) => w.wagesCents));
      if (wages === null) return null;
      if (sc.ownerUserId.value !== userId) return wages;
      const profit = A.num("schc.31");
      const half = A.num("sch1.15");
      const retirement = A.num("sch1.16");
      if (profit !== null && half !== null && retirement !== null) return wages.plus(maxD(ZERO, profit.minus(half).minus(retirement)));
      // The self-employment part is not known: wages alone are enough only when they already reach the highest IRA limit.
      return wages.greaterThanOrEqualTo(K.IRA_LIMIT_AGE_50.value) ? wages : null;
    };
    const ira = computeIraDeduction({
      people: ra.people.map(
        (p): IraPersonInput => ({
          slot: p.slot,
          name: p.name,
          traditional: dollarsAns(p.traditionalIraCents),
          roth: dollarsAns(p.rothIraCents),
          age50Plus: ans(p.age50Plus),
          covered: ans(p.coveredByWorkplacePlan),
          compensation: compensation(p.userId),
        })
      ),
      magi: iraMagi,
      noSocialSecurityBenefits: facts.statedNone.retirement_ss_income?.value ?? null,
    });
    // Form 8606 line 1 (ira.<slot>.nd) cites the person's own answers, W-2s and retirement statement.
    const iraWithRefs: RuleResult = {
      ...ira,
      lines: ira.lines.map((l) => (l.key === "ira.a.nd" ? { ...l, refs: form8606Refs("a") } : l.key === "ira.b.nd" ? { ...l, refs: form8606Refs("b") } : l)),
    };
    A.register(iraWithRefs, { refs: [...ra.people.flatMap(personRefs), ...facts.income.w2s.flatMap((w) => w.refs)] });
  }
  // Form 8606 (nondeductible IRAs), Part I: lines 1, 2, 3 and 14 per person (rules/form-8606.ts). The provisional pass assumes the unanswered
  // statements and an unanswered earlier-year basis amount (no earlier basis); the strict pass never does.
  {
    let basis = facts.statedNone.ira_basis_other?.value ?? null;
    let distNone = facts.statedNone.retirement_ss_income?.value ?? null;
    if (fill && basis === null) {
      basis = true;
      A.assumedFacts.push("No IRA distribution, Roth conversion, recharacterization or returned contribution in 2025 (Form 8606 lines 4-18, not stated)");
    }
    if (fill && distNone === null) distNone = true;
    let assumedNoPriorBasis = false;
    const f8606 = computeForm8606({
      people: ra.people.map((p) => {
        let priorBasis: Ans<Decimal> = p.priorBasisCents === undefined ? MISSING : dollarsAns(p.priorBasisCents);
        if (fill && priorBasis.state === "missing" && (p.traditionalIraCents.value ?? 0) > 0) {
          priorBasis = answered(ZERO);
          assumedNoPriorBasis = true;
        }
        return {
          slot: p.slot,
          name: p.name,
          nondeductible: { amount: A.peek(ndKeyOf[p.slot]), status: A.statusOf(ndKeyOf[p.slot]), reason: A.lines.get(ndKeyOf[p.slot])?.reason ?? null },
          priorBasis,
        };
      }),
      noEarlierBasisOrOtherIraEvent: basis,
      noIraDistributions: distNone,
    });
    if (assumedNoPriorBasis) A.assumedFacts.push("No earlier-year basis in traditional IRAs (Form 8606 line 2: the amount on line 14 of the 2024 Form 8606, not answered)");
    const f8606WithRefs: RuleResult = {
      ...f8606,
      lines: f8606.lines.map((l) => (l.key.startsWith("f8606a.") ? { ...l, refs: form8606Refs("a") } : l.key.startsWith("f8606b.") ? { ...l, refs: form8606Refs("b") } : l)),
    };
    A.register(f8606WithRefs);
  }
  A.sum("sch1.26", ["sch1.11", "sch1.12", "sch1.13", "sch1.14", "sch1.15", "sch1.16", "sch1.17", "sch1.18", "sch1.19a", "sch1.20", "sch1.21", "sch1.23", "sch1.25"]);
  A.copy("f1040.10", "sch1.26");

  A.derive("f1040.11a", ["f1040.9", "f1040.10"], (v) => v[0]!.minus(v[1]!));
  A.copy("f1040.11b", "f1040.11a");
  A.copy("scha.2", "f1040.11b");

  // 5. Standard deduction (line 12d boxes), Schedule A and the standard-vs-itemized choice
  const stdRule = computeStandardDeduction({
    people: ra.people.map((p) => ({ name: p.name, bornBefore1961: ans(p.bornBefore1961), blind: ans(p.blind) })),
  });
  A.register(stdRule, { refs: ra.people.flatMap(personRefs) });
  const stdAmount = A.peek("std.total");
  const std: Decimal | null = stdAmount ?? (fill ? D(K.STANDARD_DEDUCTION_MFJ.value) : null);
  if (fill && stdAmount === null) A.assumedFacts.push("No additional standard deduction (age 65 / blind boxes not answered)");
  const agi = A.num("f1040.11a");
  // Paystub withholding is NOT added: the W-2 is the year-end source and adding both double counts (resolver flags any paystub amount).
  const ctWithholding = A.assume(w2.ctWithholding, ZERO, "CT income tax withheld (W-2 box 17), assumed $0");
  const ctEstList = facts.payments.ctEstimates.value ?? (fill ? [] : null);
  if (fill && facts.payments.ctEstimates.value === null) A.assumedFacts.push("CT estimated payments, assumed none");
  const ctPaidIn2025 = estimatesPaidInYear(ctEstList, 2025);
  const priorBalance = A.assume(leafDollars(facts.payments.ctPriorYearBalancePaidIn2025), ZERO, "2024 CT balance paid in 2025, assumed $0");
  const sa = scheduleAInputs(facts);
  const bills = fill
    ? sa.propertyBills.map((b) => ({ ...b, kind: b.kind === "unclassified" ? ("other_personal_property" as const) : b.kind, paid: b.paid ?? ZERO }))
    : sa.propertyBills;
  if (fill) {
    if (sa.propertyBills.some((b) => b.kind === "unclassified" || b.paid === null)) A.assumedFacts.push("Unclassified / unpaid property tax bills, assumed $0");
    if (sa.mortgages.some((m) => m.interest === null || m.principal === null)) A.assumedFacts.push("Missing Form 1098 boxes, assumed $0");
    if (sa.mortgages.some((m) => m.needsReview)) A.assumedFacts.push("Form 1098 interest for a property that is not (or cannot be shown to be) the primary residence treated as primary-residence Schedule A interest");
  }
  const mortgages = fill ? sa.mortgages.map((m) => ({ ...m, interest: m.interest ?? ZERO, principal: m.principal ?? ZERO, needsReview: false })) : sa.mortgages;
  const donationsNone = facts.deductions.noDonationsConfirmed.value === true || (fill && sa.donations.length === 0);
  const propertyNone = facts.deductions.noPropertyTaxConfirmed.value === true || (fill && bills.length === 0);
  if (fill && sa.donations.length === 0 && facts.deductions.noDonationsConfirmed.value !== true) A.assumedFacts.push("No charitable gifts (not confirmed)");
  if (fill && bills.length === 0 && facts.deductions.noPropertyTaxConfirmed.value !== true) A.assumedFacts.push("No property tax paid (not confirmed)");
  const schedA = computeScheduleA({
    agi,
    ctWithholding,
    ctEstimatesPaidIn2025: ctPaidIn2025,
    ctPriorYearBalancePaidIn2025: priorBalance,
    propertyBills: bills,
    propertyTaxNoneConfirmed: propertyNone,
    mortgages,
    donations: sa.donations,
    donationsNoneConfirmed: donationsNone,
    ...(decisions.arborRoadPropertyTax ? { arborDecision: decisions.arborRoadPropertyTax } : {}),
    standardDeduction: std,
    ...(stdRule.status === "needs_cpa_judgment" ? { standardDeductionStatus: "needs_cpa_judgment" as const } : {}),
  });
  const schedARefs = [...facts.deductions.mortgages.flatMap((m) => m.refs), ...facts.deductions.propertyTaxBills.flatMap((b) => b.refs), ...w2Refs];
  A.register(schedA, { refs: schedARefs });
  A.sum("scha.7", ["scha.5e", "scha.6"]);
  A.sum("scha.8e", ["scha.8a", "scha.8b", "scha.8c"]);
  A.sum("scha.10", ["scha.8e", "scha.9"]);

  // 6. Schedule 1-A (stated), QBI deduction, taxable income
  if (facts.adjustments.sch1a.value !== null) {
    A.stated("f1040.13b", facts.adjustments.sch1a, { status: "missing_input", reason: "Schedule 1-A total." });
  } else {
    const s1a = computeSchedule1a({
      magi: A.num("f1040.11b"),
      magiExclusionsNone: ans(ra.magiExclusionsNone),
      people: ra.people.map((p) => ({
        name: p.name,
        bornBefore1961: ans(p.bornBefore1961),
        validSsn: ans(p.validSsn),
        tips: ans(p.tipsChoice),
        tipsAmount: dollarsAns(p.tipsCents),
        overtime: ans(p.overtimeChoice),
        overtimeAmount: dollarsAns(p.overtimeCents),
      })),
      carLoan: {
        choice: ans(ra.carLoan.choice),
        qualifies: ans(ra.carLoan.qualifies),
        interestPaid: dollarsAns(ra.carLoan.interestPaidCents),
        deductedElsewhere: dollarsAns(ra.carLoan.deductedElsewhereCents),
      },
      tipsEmployers: (() => {
        const box7 = facts.income.w2s.map((w) => w.socialSecurityTipsCents ?? 0).filter((c) => c > 0);
        return { employersWithBox7: box7.length, box7Total: centsToDollars(box7.reduce((a, c) => a + c, 0)) };
      })(),
      scheduleCOwnerTips: (() => {
        const owner = ra.people.find((p) => p.userId !== null && p.userId === sc.ownerUserId.value);
        return owner === undefined ? null : ans(owner.tipsChoice);
      })(),
    });
    const s1aRefs = [...ra.people.flatMap(personRefs), ...refsFrom(ra.magiExclusionsNone, ra.carLoan.choice, ra.carLoan.qualifies, ra.carLoan.interestPaidCents, ra.carLoan.deductedElsewhereCents)];
    A.register(s1a, { refs: s1aRefs });
    A.copy("f1040.13b", "sch1a.38", s1aRefs);
  }
  const ded12 = A.num("f1040.12e");
  const sch1a = A.num("f1040.13b");
  const agi2 = A.num("f1040.11b");
  const tiBeforeQbi =
    agi2 !== null && ded12 !== null && sch1a !== null ? maxD(ZERO, agi2.minus(ded12).minus(sch1a)) : null;
  const seHealth = A.assume(A.peek("sch1.17"), ZERO, "Self-employed health insurance, assumed $0");
  const seRetire = A.assume(A.peek("sch1.16"), ZERO, "Self-employed retirement contributions, assumed $0");
  const qbi = computeQbi8995({
    scheduleCNetProfit: netProfit,
    deductibleHalfSeTax: A.num("sch1.15"),
    seHealthInsurance: seHealth,
    seRetirement: seRetire,
    taxableIncomeBeforeQbi: tiBeforeQbi,
    qualifiedDividends: A.num("f1040.3a"),
    netCapitalGain: A.num("qdcg.3"),
    section199aDividends: A.assume(inv.section199aDividends, ZERO, "Section 199A dividends, assumed $0"),
    // Lines 3 and 7 are the "none" group qbi_carryforwards: 0 once the owner states none, no amount (so 0 here) until then.
    priorQbiLossCarryforward: A.peek("f8995.3") ?? ZERO,
    priorReitPtpLossCarryforward: A.peek("f8995.7") ?? ZERO,
    ...(decisions.qbiForm ? { decision: decisions.qbiForm } : {}),
  });
  A.register(qbi, { refs: [...bookRefs, ...dividendRefs], owns: ["f1040.13a", "f8995.16", "f8995.17"] });
  A.sum("f1040.14", ["f1040.12e", "f1040.13a", "f1040.13b"]);
  A.derive("f1040.15", ["f1040.11b", "f1040.14"], (v) => maxD(ZERO, v[0]!.minus(v[1]!)));
  if (!fill && A.scheduleD !== null) {
    // Capital loss carried to 2026 (provisional: the Capital Loss Carryover Worksheet logic on the 2025 figures)
    const [sd7, sd15, sd16, sd21, i11b, i14] = (["schd.7", "schd.15", "schd.16", "schd.21", "f1040.11b", "f1040.14"] as const).map((k) => A.peek(k));
    if (sd7 && sd15 && sd16 && sd21 && i11b && i14 && sd16.lessThan(0)) {
      const co = computeCapitalLossCarryoverOut({ line7: sd7, line15: sd15, line21: sd21, taxableIncomeBeforeFloor: i11b.minus(i14) });
      if (co !== null) {
        A.scheduleD = { ...A.scheduleD, carryoverOut: co };
        A.scheduleDItems.push(carryoverOutOpenItem(co));
      }
    }
  }

  // 7. Tax on taxable income
  const tax = computeIncomeTax({
    taxableIncome: A.num("f1040.15"),
    qualifiedDividends: A.num("f1040.3a"),
    netCapitalGain: A.num("qdcg.3"),
    ...(A.scheduleDTaxBlock !== null ? { scheduleDTaxWorksheet: A.scheduleDTaxBlock } : {}),
  });
  A.register(tax, { refs: [], owns: ["f1040.16"] });
  if (!A.lines.has("qdcg.25")) {
    A.fixed("qdcg.25", ZERO, "not_applicable", "The Qualified Dividends and Capital Gain Tax Worksheet is not used: no qualified dividends or capital gain on this return.", "tax-calc");
  }

  // 8. AMT and NIIT screens, Schedule 2
  const itemizing = (() => {
    const l17 = A.lines.get("scha.17");
    return l17 !== undefined && hasAmount(l17.status) && l17.amount !== null && std !== null ? new Decimal(l17.amount).greaterThan(std) : null;
  })();
  // Form 6251 line 1a subtracts Schedule 1-A line 37 (the senior deduction). A stated Schedule 1-A TOTAL has no line 37: it is 0 only when
  // that total is 0 (otherwise the split is unknown and the screen says so instead of guessing).
  const sch1aLine37: Decimal | null = (() => {
    const l37 = A.peek("sch1a.37");
    if (l37 !== null) return l37;
    if (facts.adjustments.sch1a.value !== null) return (A.peek("f1040.13b") ?? ZERO).isZero() ? ZERO : null;
    return null;
  })();
  const amtScreen = computeAmtScreen({
    agi: A.num("f1040.11b"),
    deductionsLine14: A.num("f1040.14"),
    seniorDeduction: A.assume(sch1aLine37, ZERO, "Schedule 1-A line 37 (senior deduction), assumed $0"),
    itemizing,
    scheduleATaxes: A.num("scha.7"),
    standardDeduction: std,
    privateActivityBondInterest: A.assume(inv.privateActivityBondInterest, ZERO, "Private activity bond interest, assumed $0"),
    regularTax: A.num("f1040.16"),
    hasPreferentialIncome: (A.num("f1040.3a") ?? ZERO).greaterThan(0) || (A.num("qdcg.3") ?? ZERO).greaterThan(0),
  });
  A.register(amtScreen, { owns: ["f6251.amti", "f6251.tmt", "f6251.amt", "sch2.2"] });
  // Form 8960: every printed line of Parts I-III (rules/form-8960.ts). The provisional pass assumes the unanswered statements.
  const leadOf = (key: LineKey): Form8960Lead => ({ amount: A.num(key), status: A.statusOf(key) });
  const niitOtherStated = facts.statedNone.niit_other?.value ?? undefined;
  if (fill && niitOtherStated === undefined) A.assumedFacts.push("No foreign corporation stock, estate or trust distribution, net operating loss, recovered deduction or trading business (Form 8960 lines 6, 7 and 10, not stated)");
  const niit = computeForm8960({
    agi: leadOf("f1040.11a"),
    magiExclusionsNone: ans(ra.magiExclusionsNone),
    interest: leadOf("f1040.2b"),
    dividends: leadOf("f1040.3b"),
    pensions: leadOf("f1040.5b"),
    gain7a: leadOf("f1040.7a"),
    sch1Line3: leadOf("sch1.3"),
    sch1Line4: leadOf("sch1.4"),
    sch1Line5: leadOf("sch1.5"),
    sch1Line6: leadOf("sch1.6"),
    schA5a: leadOf("scha.5a"),
    schA5d: leadOf("scha.5d"),
    schA5e: leadOf("scha.5e"),
    schA9: leadOf("scha.9"),
    itemizing,
    itemizingStatus: A.statusOf("scha.17"),
    statedNoCapitalOther: facts.statedNone.capital_gain_other?.value ?? undefined,
    niitOther: fill ? (niitOtherStated ?? true) : niitOtherStated,
    otherInvestmentIncomePresent: inv.hasOtherIncomeBoxes || scheduleDUnmodeledInvestmentIncome(facts, inv),
  });
  A.register(niit, { owns: FORM_8960_KEYS });
  A.sum("sch2.1z", ["sch2.1a", "sch2.1b", "sch2.1c", "sch2.1d", "sch2.1e", "sch2.1f", "sch2.1y"]);
  A.sum("sch2.3", ["sch2.1z", "sch2.2"]);
  A.sum("sch2.7", ["sch2.5", "sch2.6"]);
  A.sum("sch2.18", ["sch2.17a", "sch2.17b", "sch2.17c", "sch2.17d", "sch2.17e", "sch2.17f", "sch2.17g", "sch2.17h", "sch2.17i", "sch2.17j", "sch2.17k", "sch2.17l", "sch2.17m", "sch2.17n", "sch2.17o", "sch2.17p", "sch2.17q", "sch2.17z"]);
  A.sum("sch2.21", ["sch2.4", "sch2.7", "sch2.8", "sch2.9", "sch2.11", "sch2.12", "sch2.13", "sch2.14", "sch2.15", "sch2.16", "sch2.18", "sch2.19"]);

  // 9. Schedule 3 nonrefundable credits, child credit, tax lines
  if (facts.credits.foreignTax.value !== null) {
    A.stated("sch3.1", facts.credits.foreignTax, { status: "missing_input", reason: "Foreign tax credit." });
  } else {
    const ftc = computeForeignTaxCredit({ foreignTaxPaid: A.assume(inv.foreignTaxPaid, ZERO, "Foreign tax paid on 1099s, assumed $0") });
    A.register(ftc, { refs: [...interestRefs, ...dividendRefs] });
  }
  A.copy("f1040.17", "sch2.3");
  A.sum("f1040.18", ["f1040.16", "f1040.17"]);
  if (facts.credits.savers.value !== null) {
    A.stated("sch3.4", facts.credits.savers, { status: "missing_input", reason: "Saver's credit." });
  } else {
    const otherKeys = ["sch3.1", "sch3.2", "sch3.3", "sch3.6d", "sch3.6l"] as const;
    const others = otherKeys.map((k) => A.num(k));
    const saver = computeSaversCredit({
      agi: A.num("f1040.11a"),
      people: ra.people.map((p) => ({
        name: p.name,
        iraContributions: (() => {
          const t = dollarsAns(p.traditionalIraCents);
          const r = dollarsAns(p.rothIraCents);
          if (t.state !== "answered") return t;
          if (r.state !== "answered") return r;
          return { state: "answered", value: t.value.plus(r.value) } as const;
        })(),
        deferrals: dollarsAns(p.deferralsCents),
      })),
      distributionsSince2022: ans(ra.retirementDistributionSince2022),
      studentOrDependent: ans(ra.studentOrDependent),
      taxBeforeCredits: A.num("f1040.18"),
      otherCredits: others.every((x) => x !== null) ? others.reduce<Decimal>((acc, x) => acc.plus(x as Decimal), ZERO) : null,
    });
    A.register(saver, { refs: [...ra.people.flatMap(personRefs), ...refsFrom(ra.retirementDistributionSince2022, ra.studentOrDependent)] });
  }
  A.sum("sch3.7", ["sch3.6a", "sch3.6b", "sch3.6c", "sch3.6d", "sch3.6f", "sch3.6g", "sch3.6h", "sch3.6i", "sch3.6j", "sch3.6k", "sch3.6l", "sch3.6m", "sch3.6z"]);
  A.sum("sch3.8", ["sch3.1", "sch3.2", "sch3.3", "sch3.4", "sch3.5a", "sch3.5b", "sch3.7"]);
  A.sum("sch3.14", ["sch3.13a", "sch3.13b", "sch3.13c", "sch3.13d", "sch3.13z"]);
  const nd = facts.household.noDependents.value;
  if (fill || nd === true) {
    A.fixed("f1040.19", ZERO, "not_applicable", fill && nd !== true ? "Assumed no dependents in the provisional estimate." : "The owner states there are no dependents (Planning answer): no child tax credit or credit for other dependents.", "dependents", facts.household.noDependents.refs);
    if (fill && nd !== true) A.assumedFacts.push("No dependents (not recorded)");
  } else if (nd === false) {
    A.blocked("f1040.19", "needs_cpa_judgment", "The owner reports dependents: the child and other-dependent credits (Schedule 8812) are not computed by this engine.", "dependents");
  } else {
    A.blocked("f1040.19", "missing_input", "Whether the household has dependents is not recorded (Planning answer household_members).", "dependents");
  }
  A.copy("f1040.20", "sch3.8");
  A.sum("f1040.21", ["f1040.19", "f1040.20"]);
  A.derive("f1040.22", ["f1040.18", "f1040.21"], (v) => maxD(ZERO, v[0]!.minus(v[1]!)));
  A.copy("f1040.23", "sch2.21");
  A.sum("f1040.24", ["f1040.22", "f1040.23"]);

  // 10. Payments
  const ss = computeExcessSocialSecurity({ people: w2.people, unattributedW2Count: w2.unattributedW2Count });
  const ssr = A.register(ss, { refs: w2Refs, skip: ["sch3.11"] });
  const fedEst = facts.payments.federalEstimates.value ?? (fill ? [] : null);
  if (fill && facts.payments.federalEstimates.value === null) A.assumedFacts.push("Federal estimated payments, assumed none");
  const fedPay = computeFederalPayments({
    w2Withheld: A.assume(w2.fedWithheld, ZERO, "Federal income tax withheld (W-2 box 2), assumed $0"),
    hasW2: w2.hasW2 || fill,
    form1099Withheld: centsToDollars(facts.payments.federal1099WithheldCents),
    additionalMedicareWithheld: A.assume(lineAmount(f8959r, "f1040.25c"), ZERO, "Additional Medicare Tax withheld (Form 8959 line 24), assumed $0"),
    estimates: estimatesForYear(fedEst, 2025),
    priorYearOverpaymentApplied: A.assume(leafDollars(facts.payments.federalPriorYearOverpaymentApplied), ZERO, "2024 overpayment applied to 2025, assumed $0"),
    extensionPayment: A.assume(leafDollars(facts.payments.federalExtensionPayment), ZERO, "Amount paid with Form 4868, assumed $0"),
    excessSocialSecurity: A.assume(lineAmount(ssr, "sch3.11"), ZERO, "Excess Social Security tax withheld, assumed $0"),
  });
  A.register(fedPay, { refs: w2Refs });
  A.sum("f1040.32", ["f1040.27a", "f1040.28", "f1040.29", "f1040.30", "f1040.31"]);
  A.derive("f1040.34", ["f1040.33", "f1040.24"], (v) => maxD(ZERO, v[0]!.minus(v[1]!)));
  A.derive("f1040.37", ["f1040.24", "f1040.33"], (v) => maxD(ZERO, v[0]!.minus(v[1]!)));
  // Lines 35a and 36 (the split of line 34): the owner's decision X7, registered after line 38 below
  {
    const sumKeys = (keys: LineKey[]): Decimal | null => {
      let t = ZERO;
      for (const k of keys) {
        const v = A.peek(k);
        if (v === null) return null;
        t = t.plus(v);
      }
      return t;
    };
    const w25d = A.peek("f1040.25d");
    const e11 = A.peek("sch3.11");
    const pen = computePenalty2210({
      line1: A.peek("f1040.22"),
      line2: sumKeys(K.FORM_2210_LINE2_SCH2_LINES.value.map((id) => `sch2.${id}` as LineKey)),
      line3: sumKeys(K.FORM_2210_LINE3_LINES.value as LineKey[]),
      line6: w25d !== null && e11 !== null ? w25d.plus(e11) : null,
      prior: {
        totalTax: leafDollars(facts.priorYear.totalTaxCents),
        agi: leafDollars(facts.priorYear.agiCents),
        filingStatus: facts.priorYear.filingStatus.value,
        filedJoint: ans(ra.priorYear.filedJoint),
        hadExcludedTaxOrRefundable: ans(ra.priorYear.hadExcludedTaxOrRefundable),
      },
      estimates:
        facts.payments.federalEstimates.value === null
          ? null
          : facts.payments.federalEstimates.value.filter((e) => e.appliesToTaxYear === 2025).map((e) => ({ paidOn: e.paidOn, amount: centsToDollars(e.amountCents) })),
      priorYearOverpaymentApplied: leafDollars(facts.payments.federalPriorYearOverpaymentApplied),
    });
    const penRefs = [...facts.priorYear.totalTaxCents.refs, ...facts.payments.federalEstimates.refs, ...refsFrom(ra.priorYear.filedJoint, ra.priorYear.hadExcludedTaxOrRefundable)];
    A.register(pen, { refs: penRefs });
    // Line 38 is informational: the estimate when it can be computed, otherwise an explicit "not estimated" (the IRS figures it)
    if (A.peek("f2210.19") !== null) A.copy("f1040.38", "f2210.19", penRefs);
    else A.blocked("f1040.38", "not_yet_computed", `The Form 2210 estimate is not available (${A.lines.get("f2210.19")?.reason ?? "inputs missing"}); the IRS figures any underpayment penalty itself.`, "election", true);
    // Lines 35a / 36: decision X7 (rules/overpayment-federal.ts). "Lines 35a, 36, and 38 must equal line 34": the penalty printed on line 38 is taken out first.
    const over34 = A.peek("f1040.34");
    if (over34 === null) {
      // informational, as before: the split cannot be figured until line 34 is (and the owner records decision X7)
      for (const key of ["f1040.35a", "f1040.36"] as const) A.blocked(key, "not_yet_computed", "Depends on Form 1040 line 34, which is not computed yet; the owner then records decision X7 (refund or apply to 2026).", "derive", true);
    } else {
      const printed38 = A.peek("f1040.38");
      A.register(computeFederalOverpayment({ line34: over34, line38: printed38, ...(decisions.federalOverpayment ? { decision: decisions.federalOverpayment } : {}) }));
      if (federalPenaltyExceedsOverpayment(over34, printed38) && !fill) {
        A.overpaymentItems.push({
          id: "overpayment-penalty-exceeds",
          severity: "advisory",
          message: `The line 38 penalty estimate (${fmt(printed38 ?? ZERO)}) is more than the line 34 overpayment (${fmt(over34)}): the Form 1040 instructions say to enter -0- on lines 35a and 36 and to subtract line 34 from line 38 and enter the result on line 37. This return prints 0 on lines 35a and 36 and does not add the penalty to line 37.`,
          action: "Check line 37 by hand, or leave line 38 blank and let the IRS figure the penalty.",
          lineKeys: ["f1040.34", "f1040.38", "f1040.35a", "f1040.36", "f1040.37"],
          refs: [],
        });
      }
    }
    A.register(
      computeSchedule3Summary({
        foreignTax: A.peek("sch3.1"),
        savers: A.peek("sch3.4"),
        total8: A.peek("sch3.8"),
        extensionPayment: A.peek("sch3.10"),
        excessSocialSecurity: A.peek("sch3.11"),
        total15: A.peek("sch3.15"),
        total8Status: A.statusOf("sch3.8"),
        total15Status: A.statusOf("sch3.15"),
      })
    );
  }

  // 11. Connecticut
  // 11a. CT-1040 Schedule 1 detail lines (rules/ct-schedule1.ts), then the line 38 / line 50 totals
  const fedLead = (key: LineKey): CtFederalLead => {
    const l = A.lines.get(key);
    return { amount: A.peek(key), status: l?.status, ...(l !== undefined && l.refs.length > 0 ? { refs: l.refs } : {}) };
  };
  const ctStated: CtSchedule1Input["stated"] = {};
  const ctStatedAmounts: NonNullable<CtSchedule1Input["statedSomeAmounts"]> = {};
  const ctGroupRefs: NonNullable<NonNullable<CtSchedule1Input["refs"]>["groups"]> = {};
  for (const g of [...CT_SCH1_GROUPS, "savings_bond_exclusion"] as const) {
    const leaf = facts.statedNone[g];
    if (leaf !== undefined && leaf.value !== null) {
      ctStated[g] = leaf.value;
      ctGroupRefs[g] = leaf.refs;
    }
    const some = ra.statedSomeAmounts[g]?.value;
    if (g !== "savings_bond_exclusion" && some !== null && some !== undefined) ctStatedAmounts[g] = centsToDollars(some);
  }
  const ctSch1 = computeCtSchedule1({
    exemptInterestBox8: inv.exemptInterestBox8,
    exemptDividends: inv.exemptDividends,
    usGovInterestBox3: inv.usGovInterestBox3,
    fed: {
      refund: fedLead("sch1.1"),
      trustsPartnerships: fedLead("sch1.5"),
      depreciation: fedLead("schc.13"),
      ira: fedLead("f1040.4b"),
      pension: fedLead("f1040.5b"),
      ss: fedLead("f1040.6b"),
    },
    stated: ctStated,
    statedSomeAmounts: ctStatedAmounts,
    otherAdditions: dollarsOrNull(facts.ct.additions),
    otherSubtractions: dollarsOrNull(facts.ct.subtractions),
    refs: { interest: interestRefs, dividends: dividendRefs, groups: ctGroupRefs, otherAdditions: facts.ct.additions.refs, otherSubtractions: facts.ct.subtractions.refs },
  });
  A.register(ctSch1, { refs: [...interestRefs, ...dividendRefs], owns: [...CT_SCH1_ADDITION_KEYS, ...CT_SCH1_SUBTRACTION_KEYS] });
  /** Sum of whole-dollar detail lines (a filer adds the printed lines); null when any is not final (provisional pass: a blocked line reads as $0 and is listed). */
  const sumCtLines = (keys: readonly LineKey[]): { total: Decimal | null; open: LineKey[] } => {
    const parts = keys.map((k) => A.num(k));
    const open = keys.filter((_, i) => parts[i] === null);
    return { total: open.length > 0 ? null : parts.reduce<Decimal>((acc, v) => acc.plus(v ?? ZERO), ZERO), open };
  };
  const ctAdd = sumCtLines(CT_SCH1_ADDITION_KEYS);
  const ctSub = sumCtLines(CT_SCH1_SUBTRACTION_KEYS);
  const ctOpen = [...ctAdd.open, ...ctSub.open];
  // Lines 7, 13 and 20a-20d: credits this engine does not compute; the owner's "none" statements decide (rules/ct-credits.ts)
  const statedBool = (g: NoneGroupId): boolean | undefined => facts.statedNone[g]?.value ?? undefined;
  A.register(
    computeCtOtherCredits({
      otherStateTax: statedBool("ct_other_state_tax"),
      otherCredits: statedBool("ct_other_credits"),
      nonCtStateWithholdingPresent: w2.nonCtStateWithholdingPresent,
      refs: { otherStateTax: facts.statedNone.ct_other_state_tax?.refs ?? [], otherCredits: facts.statedNone.ct_other_credits?.refs ?? [] },
    }),
    { refs: w2Refs, owns: CT_CREDIT_LINES }
  );
  const line7 = A.lines.get("ct1040.7");
  const ctTax = computeCtTax({
    federalAgi: A.num("f1040.11a"),
    additions: ctAdd.total,
    subtractions: ctSub.total,
    ...(ctOpen.length > 0
      ? {
          modificationsBlock: {
            status: worstBlocked(ctOpen.map((k) => A.statusOf(k))) ?? ("missing_input" as const),
            reason: `CT AGI is not final: CT-1040 Schedule 1 line${ctOpen.length === 1 ? "" : "s"} ${ctOpen.map((k) => k.slice("ct1040.s1.".length)).join(", ")} ${ctOpen.length === 1 ? "is" : "are"} not computed (see the Schedule 1 item).`,
          },
        }
      : {}),
    federalAmt: A.num("sch2.2"),
    otherJurisdictionCredit: A.num("ct1040.7"),
    ...(line7 !== undefined && !hasAmount(line7.status)
      ? { otherJurisdictionBlock: { status: worstBlocked([line7.status]) ?? ("missing_input" as const), reason: line7.reason ?? "Line 7 is not final." } }
      : {}),
  });
  A.register(ctTax, { refs: w2Refs, owns: ["ct1040.1", "ct1040.additions", "ct1040.subtractions", "ct1040.3", "ct1040.ctAgi", "ct1040.6", "ct1040.8", "ct1040.9", "ct1040.10"] });
  const credit = computeCtPropertyTaxCredit({
    ctAgi: A.num("ct1040.ctAgi"),
    bills: bills.map((b) => ({ docId: b.docId, label: b.label, kind: b.kind, paid: b.paid })),
    ctTaxBeforeCredits: A.num("ct1040.10"),
  });
  A.register(credit, { refs: facts.deductions.propertyTaxBills.flatMap((b) => b.refs), owns: ["ct1040.11", "ct1040.s3.63", "ct1040.s3.65", "ct1040.s3.67"] });
  const ctPay = computeCtPayments({
    withholding: ctWithholding,
    withholdingRows: w2.ctWithholdingRows,
    hasW2: w2.hasW2 || fill,
    estimates: estimatesForYear(ctEstList, 2025),
    priorYearOverpaymentApplied: A.assume(leafDollars(facts.payments.ctPriorYearOverpaymentApplied), ZERO, "2024 CT overpayment applied, assumed $0"),
    extensionPayment: A.assume(leafDollars(facts.payments.ctExtensionPayment), ZERO, "CT-1040 EXT payment, assumed $0"),
  });
  A.register(ctPay, { refs: w2Refs });
  const useTaxStated = dollarsOrNull(facts.ct.useTax);
  const useTaxRule =
    useTaxStated !== null
      ? null
      : computeCtUseTax({
          choice: ans(ra.useTax.choice),
          generalRatePurchases: dollarsAns(ra.useTax.generalRatePurchasesCents),
          otherRateItems: ans(ra.useTax.otherRateItems),
          taxPaidToOtherState: dollarsAns(ra.useTax.taxPaidToOtherStateCents),
          ...(ra.useTax.untaxedPurchasesCents ? { untaxedPurchases: dollarsAns(ra.useTax.untaxedPurchasesCents) } : {}),
        });
  const useTaxValue = useTaxStated ?? (useTaxRule !== null && useTaxRule.ok ? useTaxRule.amount : null);
  const ctBalance = computeCtBalance({
    useTax: A.assume(useTaxValue, ZERO, "CT use tax, assumed $0"),
    ...(useTaxStated !== null ? { useTaxReason: "Stated by the owner / CPA." } : useTaxRule !== null && useTaxRule.ok ? { useTaxReason: useTaxRule.reason } : {}),
    ...(useTaxRule !== null && !useTaxRule.ok ? { useTaxBlock: { status: useTaxRule.status === "needs_cpa_judgment" ? ("needs_cpa_judgment" as const) : ("missing_input" as const), reason: useTaxRule.reason } } : {}),
    useTaxFromRule: useTaxStated === null && useTaxRule !== null && useTaxRule.ok,
  });
  A.register(ctBalance, { owns: ["ct1040.15", "ct1040.s4.69b"], refs: refsFrom(ra.useTax.choice, ra.useTax.generalRatePurchasesCents, ra.useTax.otherRateItems, ra.useTax.taxPaidToOtherStateCents, facts.ct.useTax) });

  // 11b. The CT-1040 arithmetic spine (each line is the form's own instruction over the rounded printed lines):
  //   12 = 10 - 11 (not below 0), 14 = 12 - 13 (not below 0), 16 = 14 + 15, 17 = 16, 21 = 18 + 19 + 20 + 20a-20d,
  //   22 = 21 - 17 when more, 26 = 17 - 21 when more; `balance` is the signed headline (positive = due) = 17 - 21.
  const notBelowZero = (v: Decimal[]): Decimal => maxD(ZERO, (v[0] ?? ZERO).minus(v[1] ?? ZERO));
  A.derive("ct1040.12", ["ct1040.10", "ct1040.11"], notBelowZero);
  A.derive("ct1040.14", ["ct1040.12", "ct1040.13"], notBelowZero);
  A.sum("ct1040.16", ["ct1040.14", "ct1040.15"]);
  A.copy("ct1040.17", "ct1040.16");
  A.sum("ct1040.21", ["ct1040.18", "ct1040.19", "ct1040.20", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"]);
  A.derive("ct1040.22", ["ct1040.21", "ct1040.17"], notBelowZero);
  A.derive("ct1040.26", ["ct1040.17", "ct1040.21"], notBelowZero);
  A.derive("ct1040.balance", ["ct1040.17", "ct1040.21"], (v) => (v[0] ?? ZERO).minus(v[1] ?? ZERO));
  // Lines 25, 27, 28, 29, 30 (rules/ct-settlement.ts): only when every input is known
  const settleDeps: LineKey[] = ["ct1040.14", "ct1040.18", "ct1040.20c", "ct1040.22", "ct1040.26"];
  const settleVals = settleDeps.map((k) => A.num(k));
  if (settleVals.every((v) => v !== null)) {
    A.register(computeCtSettlement({ line14: settleVals[0] ?? ZERO, line18: settleVals[1] ?? ZERO, line20c: settleVals[2] ?? ZERO, line22: settleVals[3] ?? ZERO, line26: settleVals[4] ?? ZERO, ...(decisions.ctOverpayment ? { decision: decisions.ctOverpayment } : {}) }));
  } else {
    const open = settleDeps.filter((_, i) => settleVals[i] === null);
    const status = worstBlocked(open.map((k) => A.statusOf(k))) ?? "missing_input";
    for (const key of ["ct1040.23", "ct1040.25", "ct1040.27", "ct1040.28", "ct1040.29", "ct1040.30"] as const) {
      A.blocked(key, status, `Depends on lines not computed yet: ${open.map((k) => `${lineMeta(k).form} ${lineMeta(k).formLine}`).join(", ")}.`, "derive");
    }
  }

  // 12. Anything in the catalog that nothing filled: explicit, never 0
  for (const meta of LINE_CATALOG) {
    if (!A.lines.has(meta.key)) {
      A.blocked(meta.key, "not_yet_computed", "No rule or stated input fills this line yet.", "unfilled");
    }
  }
  return A;
}

/** Capital items that are NOT in Schedule D's computed figures (so net investment income is incomplete): an unread 1099-B or Section 1256 contracts. */
function scheduleDUnmodeledInvestmentIncome(facts: Ty2025Facts, inv: ReturnType<typeof aggregateInvestments>): boolean {
  const sales = facts.income.brokerSales;
  // a 1099-B that has no sales-summary entry at all (facts built before the capture side) is still an unread 1099-B
  const legacyUnread = inv.hasCapitalTransactionBoxes && facts.income.otherIncomeBoxes.some((b) => b.variant === "1099-B" && !sales.some((d) => d.docId === b.docId));
  return legacyUnread || section1256Present(facts) || sales.some((d) => !d.summaryRead && (d.signalled1099B || d.forms1099DaPresent));
}

function lineAmount(result: RuleResult, key: LineKey): Decimal | null {
  const l = result.lines.find((x) => x.key === key);
  return l && hasAmount(l.status ?? result.status) && l.amount !== null ? l.amount : null;
}

// ── Headline ──────────────────────────────────────────────────────────────────

function headlineAmount(A: Assembly, key: LineKey): HeadlineAmount {
  const l = A.lines.get(key);
  if (l === undefined) return { status: "not_yet_computed", amount: null, reason: "Line not present." };
  return { status: l.status, amount: hasAmount(l.status) ? l.amount : null, reason: l.reason };
}

function combineAmount(a: HeadlineAmount, b: HeadlineAmount, op: (x: number, y: number) => number): HeadlineAmount {
  if (a.amount !== null && b.amount !== null) return { status: "computed", amount: op(a.amount, b.amount), reason: null };
  const status = worstBlocked([a.status, b.status]) ?? "missing_input";
  return { status, amount: null, reason: a.amount === null ? a.reason : b.reason };
}

function buildHeadline(A: Assembly, blockingItemCount: number, provisional: ProvisionalHeadline | null, openItems: readonly OpenItem[] = []): Headline {
  const unverifiedDocumentCount = openItems.filter((o) => o.id.startsWith("doc-unverified:")).length;
  const derivedInputCount = openItems.filter((o) => o.id === "schedule-c-owner-derived" || o.id === "primary-residence-derived").length;
  const undecidedDecisionCount = A.decisions.filter((d) => d.status === "default_undecided").length;
  const caveats: string[] = [];
  if (unverifiedDocumentCount > 0) caveats.push(`${unverifiedDocumentCount} document(s) counted in the numbers are unverified AI reads.`);
  for (const o of openItems) if (o.id === "schedule-c-owner-derived" || o.id === "primary-residence-derived") caveats.push(o.message);
  if (undecidedDecisionCount > 0) caveats.push(`${undecidedDecisionCount} decision(s) are at their default alternative (default, undecided).`);
  for (const o of openItems) if (o.id.startsWith("info:")) caveats.push(o.message);
  const owe = headlineAmount(A, "f1040.37");
  const over = headlineAmount(A, "f1040.34");
  const federalBalance = combineAmount(owe, over, (o, v) => o - v);
  const c18 = headlineAmount(A, "ct1040.18");
  const c19 = headlineAmount(A, "ct1040.19");
  const c20 = headlineAmount(A, "ct1040.20");
  const ctPayments = combineAmount(combineAmount(c18, c19, (x, y) => x + y), c20, (x, y) => x + y);
  const federal = {
    agi: headlineAmount(A, "f1040.11a"),
    taxableIncome: headlineAmount(A, "f1040.15"),
    totalTax: headlineAmount(A, "f1040.24"),
    totalPayments: headlineAmount(A, "f1040.33"),
    balance: federalBalance,
  };
  const connecticut = {
    ctAgi: headlineAmount(A, "ct1040.ctAgi"),
    tax: headlineAmount(A, "ct1040.6"),
    totalPayments: ctPayments,
    balance: headlineAmount(A, "ct1040.balance"),
  };
  const all = [...Object.values(federal), ...Object.values(connecticut)];
  return {
    // complete = every headline amount is computed AND no blocking item (unresolved duplicates, unassigned W-2 ...) remains
    complete: all.every((h) => h.status === "computed" || h.status === "not_applicable") && blockingItemCount === 0,
    federal,
    connecticut,
    blockingItemCount,
    unverifiedDocumentCount,
    derivedInputCount,
    undecidedDecisionCount,
    caveats,
    provisional,
  };
}

function provisionalFrom(A: Assembly): ProvisionalHeadline {
  const get = (k: LineKey): number | null => {
    const l = A.lines.get(k);
    return l !== undefined && hasAmount(l.status) ? l.amount : null;
  };
  const owe = get("f1040.37");
  const over = get("f1040.34");
  const c = [get("ct1040.18"), get("ct1040.19"), get("ct1040.20")];
  return {
    note:
      "Provisional estimate, NOT a computed return: every input that is missing or not yet computed is treated as $0 / none and listed below. Use it only to see the size of the numbers.",
    assumedZeroLines: [...A.assumedZero],
    assumedFacts: [...new Set(A.assumedFacts)],
    agi: get("f1040.11a"),
    taxableIncome: get("f1040.15"),
    totalTax: get("f1040.24"),
    totalPayments: get("f1040.33"),
    federalBalance: owe === null || over === null ? null : owe - over,
    ctTax: get("ct1040.6"),
    ctPayments: c.every((x) => x !== null) ? c.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    ctBalance: get("ct1040.balance"),
    lines: Object.fromEntries(
      [...A.lines.values()].filter((l) => hasAmount(l.status) && l.amount !== null).map((l) => [l.key, l.amount])
    ) as Partial<Record<LineKey, number>>,
  };
}

// ── Open items ────────────────────────────────────────────────────────────────

function ruleOpenItems(A: Assembly): OpenItem[] {
  const out: OpenItem[] = [];
  for (const r of A.results) {
    if (r.status === "computed" || r.status === "not_applicable") continue;
    const keys = (A.resultLineKeys.get(r.ruleId) ?? []).filter((k) => {
      const l = A.lines.get(k);
      return l !== undefined && !hasAmount(l.status);
    });
    out.push({
      id: `rule:${r.ruleId}`,
      severity: r.informational === true ? "advisory" : "blocking",
      message: r.reasons[0] ?? `${r.form}: ${r.status.replace(/_/g, " ")}.`,
      action:
        r.status === "missing_input"
          ? `Provide: ${r.inputsMissing.join("; ") || "the missing input"}.`
          : r.status === "not_yet_computed"
            ? "Computed in a later phase (or state the amount)."
            : "The CPA decides or supplies the rule.",
      lineKeys: keys.slice(0, 40),
      refs: [],
    });
  }
  return out;
}

/** Informational lines (amount deliberately not estimated) become one advisory item each; they never block. */
function informationalOpenItems(A: Assembly): OpenItem[] {
  const out: OpenItem[] = [];
  for (const l of A.lines.values()) {
    if (l.informational !== true || hasAmount(l.status)) continue;
    out.push({
      id: `info:${l.key}`,
      severity: "advisory",
      message: `${l.form} ${l.formLine} (${l.label}) is informational and not estimated: ${l.reason ?? ""}`.trim(),
      action: "The CPA figures it if it applies.",
      lineKeys: [l.key],
      refs: [],
    });
  }
  return out;
}

function noneGroupOpenItems(A: Assembly): OpenItem[] {
  const out: OpenItem[] = [];
  const byGroup = new Map<NoneGroupId, LineKey[]>();
  for (const meta of LINE_CATALOG) {
    if (!meta.group) continue;
    const l = A.lines.get(meta.key);
    if (l !== undefined && !hasAmount(l.status)) byGroup.set(meta.group, [...(byGroup.get(meta.group) ?? []), meta.key]);
  }
  for (const [group, keys] of byGroup) {
    const answeredYes = A.facts.statedNone[group]?.value === false;
    const carried = A.facts.returnAnswers.statedSomeAmounts[group]?.value;
    out.push({
      id: `none:${group}`,
      severity: "blocking",
      message: answeredYes
        ? `The owner answered Yes${carried === null || carried === undefined ? "" : ` (about ${fmt(centsToDollars(carried))})`}: the CPA must classify and report this income. The statement that does not hold: ${NONE_GROUP_TEXT[group]}`
        : `Needs an owner/CPA statement: ${NONE_GROUP_TEXT[group]}`,
      action: answeredYes ? "Give the CPA the documents for this income (Form 1099-G, 1099-MISC, W-2G ...); this engine does not compute it." : "Confirm 'none' (or enter the amounts) so these lines can be completed.",
      lineKeys: keys.slice(0, 40),
      refs: [],
    });
  }
  return out;
}

/** The state tax refund worksheet inputs and result, plus the Connecticut consequence (CT-1040 Schedule 1 line 42). */
function stateRefundOpenItems(A: Assembly): OpenItem[] {
  const r = A.results.find((x) => x.ruleId === "state-refund");
  if (r === undefined) return [];
  const l = A.lines.get("sch1.1");
  const amount = l !== undefined && hasAmount(l.status) && l.amount !== null ? l.amount : null;
  return [
    {
      id: "state-refund-worksheet",
      severity: "advisory",
      message: `${r.reasons[0] ?? "State income tax refund."}${amount !== null ? ` Connecticut: the taxable refund of ${fmt(new Decimal(amount))} is subtracted on CT-1040 Schedule 1 line 42 (part of line 50, CT-1040 line 4).` : ""}`,
      action: "Check the worksheet inputs against the 2024 return and Form 1099-G.",
      lineKeys: ["sch1.1"],
      refs: l?.refs ?? [],
    },
  ];
}

function decisionOpenItems(decisions: readonly RuleDecision[]): OpenItem[] {
  return decisions
    .filter((d) => d.status === "default_undecided")
    .map((d) => ({
      id: `decision:${d.id}`,
      severity: "advisory" as const,
      message: `${d.label}: no decision is recorded, so the default alternative ("${d.chosen}") is in force (default, undecided).`,
      action: "The CPA records the decision; the alternatives are shown side by side.",
      lineKeys: [],
      refs: [],
    }));
}

const STANDING_ADVISORIES: readonly OpenItem[] = [
  {
    id: "solar-5695",
    severity: "advisory",
    message:
      "Form 5695 / the residential clean energy credit is not a 2025 item for this household (system installed in 2022 and the credit already taken, owner statement). No 2025 credit is computed.",
    action: "Read any Form 5695 carryforward from the uploaded 2024 return and tell the CPA.",
    lineKeys: ["sch3.5a"],
    refs: [],
  },
  {
    id: "assumptions-no-ct-sales-tax-or-other",
    severity: "advisory",
    message:
      "Not modeled and not asked: Form 4952 investment interest, sales-tax election in place of state income tax, Schedule 1 other adjustments beyond those listed on the sheet.",
    action: "CPA to confirm none apply.",
    lineKeys: [],
    refs: [],
  },
];

// ── Forms required (C7) ───────────────────────────────────────────────────────

export function computeFormsRequired(
  ret: Pick<Ty2025Return, "lines" | "results" | "decisions"> & { scheduleD?: ScheduleDDetail | null },
  facts: Ty2025Facts
): Partial<Record<FormId, FormRequirement>> {
  const L = ret.lines;
  const amount = (k: LineKey): number | null => {
    const l = L[k];
    return l !== undefined && hasAmount(l.status) ? l.amount : null;
  };
  const blockedStatus = (k: LineKey): boolean => {
    const l = L[k];
    return l === undefined || !hasAmount(l.status);
  };
  const decide = (keys: LineKey[], reasonOn: string, reasonOff: string): FormRequirement => {
    if (keys.some((k) => (amount(k) ?? 0) !== 0)) return { required: true, reason: reasonOn };
    if (keys.some((k) => blockedStatus(k))) return { required: "blocking", reason: "Cannot tell until a blocking item is resolved." };
    return { required: false, reason: reasonOff };
  };
  const out: Partial<Record<FormId, FormRequirement>> = {
    f1040: { required: true, reason: "The return." },
    ct1040: { required: true, reason: "Connecticut resident return." },
  };
  out.schc = decide(["schc.1", "schc.7", "schc.28", "schc.31"], "EK Consulting has Schedule C income or expenses.", "No Schedule C activity.");
  out.sch1 = decide(["sch1.10", "sch1.26"], "There is Schedule 1 income or an adjustment.", "No Schedule 1 amounts.");
  const se4c = amount("se.4c");
  out.schse = blockedStatus("se.4c") && se4c === null ? { required: "blocking", reason: "Net earnings from self-employment are not computed yet." } : (se4c ?? 0) >= K.SE_FLOOR.value ? { required: true, reason: "Net earnings from self-employment are at least the $400 floor." } : { required: false, reason: "Net earnings from self-employment are under the $400 floor." };
  out.sch2 = decide(["sch2.3", "sch2.21"], "There is additional tax (self-employment tax, Additional Medicare Tax, ...).", "No Schedule 2 amounts.");
  out.sch3 = decide(["sch3.8", "sch3.15"], "There are Schedule 3 credits or payments.", "No Schedule 3 amounts.");
  const l17 = amount("scha.17");
  const l12 = amount("f1040.12e");
  const stdTotal = amount("std.total");
  out.scha =
    l17 === null || l12 === null || stdTotal === null
      ? { required: "blocking", reason: "Standard versus itemized is not decided until Schedule A and the standard deduction (age 65 / blind boxes) are computed." }
      : l17 > stdTotal
        ? { required: true, reason: "Itemized deductions exceed the standard deduction." }
        : { required: false, reason: "The standard deduction is larger." };
  const interest = amount("schb.2");
  const dividends = amount("schb.6");
  out.schb =
    interest === null || dividends === null
      ? { required: "blocking", reason: "Interest or dividends are not computed yet." }
      : interest > K.SCH_B_THRESHOLD.value || dividends > K.SCH_B_THRESHOLD.value
        ? { required: true, reason: "Interest or ordinary dividends exceed the Schedule B threshold." }
        : { required: false, reason: "Interest and dividends are under the Schedule B threshold." };
  const r8959 = ret.results.find((r) => r.ruleId === "addl-medicare-8959");
  out.f8959 =
    r8959 === undefined
      ? { required: "blocking", reason: "Form 8959 was not evaluated." }
      : r8959.status === "not_applicable"
        ? { required: false, reason: "Form 8959 is not required (below the Additional Medicare Tax thresholds)." }
        : r8959.status === "computed"
          ? { required: true, reason: "Form 8959 is required." }
          : { required: "blocking", reason: "Cannot tell until Form 8959 inputs are resolved." };
  // Form 8995 is where a qualified business loss is carried to the next year (lines 16 and 17) and where a loss carried in is used
  // (lines 3 and 7), so it is attached when there is a deduction OR a loss carried out or in (Instructions for Form 8995, lines 3, 4, 16, 17).
  const qbiLossOut = Math.min(amount("f8995.16") ?? 0, 0) + Math.min(amount("f8995.17") ?? 0, 0);
  const qbiLossIn = (amount("f8995.3") ?? 0) !== 0 || (amount("f8995.7") ?? 0) !== 0;
  // The dollar amount is stated once per screen or page (the open item `qbi-carryforward-out` and the review-sheet card), not in this reason.
  const qbiCarryText = qbiLossOut < 0 ? " A qualified business loss is carried forward to 2026: Form 8995 lines 16 and 17 record it." : "";
  out.f8995 =
    (amount("f1040.13a") ?? 0) > 0
      ? { required: true, reason: `A qualified business income deduction is claimed.${qbiCarryText}` }
      : qbiLossOut < 0
        ? { required: true, reason: qbiCarryText.trim() }
        : qbiLossIn
          ? { required: true, reason: "A qualified business loss carried in from 2024 is used on Form 8995 lines 3 and 7." }
          : blockedStatus("f1040.13a")
            ? { required: "blocking", reason: "The QBI deduction is not computed yet." }
            : { required: false, reason: "No QBI deduction and no qualified business loss carryforward." };
  const amt = amount("sch2.2");
  out.f6251 =
    amt === null ? { required: "blocking", reason: "The AMT screen is not computed yet." } : amt > 0 ? { required: true, reason: "AMT applies." } : { required: false, reason: "The AMT screen shows no AMT." };
  // Form 8960 is attached when the MAGI is over the threshold (line 15 > 0) and there is investment income (line 8 > 0); a return whose
  // tax rounds to $0 still files it (Instructions for Form 8960, "Who Must File").
  const nii15 = amount("f8960.15");
  const nii8 = amount("f8960.8");
  out.f8960 =
    nii15 === null
      ? { required: "blocking", reason: "The modified adjusted gross income for the net investment income tax is not final yet." }
      : nii15 === 0
        ? { required: false, reason: "No net investment income tax: the modified adjusted gross income is not over the threshold." }
        : nii8 === null
          ? { required: "blocking", reason: "The modified adjusted gross income is over the threshold; Form 8960 cannot be ruled out until total investment income (line 8) is resolved." }
          : nii8 > 0
            ? { required: true, reason: "The modified adjusted gross income is over the threshold and there is net investment income: Form 8960 is attached." }
            : { required: false, reason: "No net investment income (Form 8960 line 8 is not above zero)." };
  const noncash = facts.deductions.donations.filter((d) => d.kind === "noncash").reduce((s, d) => s + d.amountCents, 0);
  out.f8283 = noncash > K.FORM_8283_NONCASH_THRESHOLD.value * 100 ? { required: true, reason: "Noncash gifts are over $500." } : { required: false, reason: "Noncash gifts are not over $500." };
  const s1a = amount("sch1a.38");
  out.sch1a =
    s1a !== null && s1a > 0
      ? { required: true, reason: "A Schedule 1-A deduction (tips, overtime, car-loan interest or seniors) is claimed." }
      : blockedStatus("sch1a.38")
        ? { required: "blocking", reason: "Schedule 1-A is not final until its inputs are answered." }
        : { required: false, reason: "No Schedule 1-A deduction." };
  const hsaAmounts = (["f8889a.2", "f8889a.9", "f8889a.13", "f8889b.2", "f8889b.9", "f8889b.13"] as LineKey[]).map((k) => amount(k));
  const hasW = facts.income.w2s.some((w) => w.box12.some((e) => e.code === "W"));
  // A stated sch1.13 override (facts.adjustments.hsa) rules the form in or out by itself; otherwise the Form 8889 lines decide.
  const hsaKeys: LineKey[] = facts.adjustments.hsa.value !== null ? ["sch1.13"] : ["f8889a.13", "f8889b.13", "sch1.13"];
  out.f8889 = hsaAmounts.some((v) => v !== null && v > 0)
    ? { required: true, reason: "HSA contributions or employer HSA contributions are reported (one Form 8889 per spouse)." }
    : hsaKeys.some((k) => blockedStatus(k))
      ? { required: "blocking", reason: hasW ? "A W-2 shows box 12 code W (HSA contributions): Form 8889 cannot be ruled out until the HSA questions are answered." : "Cannot tell until the HSA questions are answered." }
      : { required: false, reason: "No HSA activity." };
  const nd8606 = (["f8606a.1", "f8606b.1"] as LineKey[]).map((k) => amount(k));
  out.f8606 = nd8606.some((v) => v !== null && v > 0)
    ? { required: true, reason: `A nondeductible contribution was made to a traditional IRA (one Form 8606 per person; the IRS penalty for not filing is $${K.FORM_8606_NOT_FILED_PENALTY.value}).` }
    : (["f8606a.1", "f8606b.1"] as LineKey[]).some((k) => blockedStatus(k))
      ? { required: "blocking", reason: "Cannot tell until the IRA questions are answered." }
      : { required: false, reason: "No nondeductible traditional IRA contribution." };
  const saver = amount("f8880.12");
  out.f8880 =
    saver !== null && saver > 0
      ? { required: true, reason: "A saver's credit is claimed." }
      : blockedStatus("sch3.4")
        ? { required: "blocking", reason: "The saver's credit is not decided until its inputs are answered." }
        : { required: false, reason: "No saver's credit (ineligible or no qualified contributions)." };
  const pen = amount("f2210.19");
  out.f2210 = {
    required: false,
    reason:
      pen !== null && pen > 0
        ? `The IRS figures any underpayment penalty itself; the regular-method estimate is $${pen}. Form 2210 is attached only to request a waiver or another method.`
        : "The IRS figures any underpayment penalty itself; Form 2210 is attached only to request a waiver or another method.",
  };
  // Forms this engine does not compute: listed so the packet never silently omits them (the CPA decides).
  out.f5695 = facts.statedNone.solar_credit?.value === true
    ? { required: false, reason: "The owner states there is no 2025 residential clean energy credit (any carryforward is read from the 2024 return)." }
    : { required: "blocking", reason: "Whether a Form 5695 credit or carryforward applies is not stated." };
  out.f4562 = facts.income.scheduleC.fixedAssets.length > 0
    ? { required: "blocking", reason: "Depreciable assets are on the register: Form 4562 (decision X2) is a CPA call and is not computed yet." }
    : { required: false, reason: "No depreciable EK Consulting assets on the register." };
  // Form 8829 is the ACTUAL-expense home office method (decision X1); it is not filed under the simplified method. This packet does not
  // generate it (the engine does not compute the actual method: it needs the area percentage, home basis and land value, insurance, utilities,
  // repairs and prior-year carryovers, none of which the app holds), so a CPA choice of "actual" is listed on the cover as required but not generated.
  const x1 = ret.decisions.find((d) => d.id === "X1");
  const homeEligibility = facts.income.scheduleC.homeOfficeEligibility.value;
  out.f8829 =
    homeEligibility !== "yes_exclusive"
      ? { required: false, reason: "No home office deduction claimed." }
      : x1 === undefined
        ? { required: "blocking", reason: "A home office is claimed: Form 8829 is needed only if the CPA chooses the actual method (decision X1), which cannot be formed until the home office answers (square footage) are complete." }
        : x1.chosen === "actual"
          ? { required: true, reason: "The CPA chose the actual home-office method (decision X1): Form 8829 is required. This packet does not generate it and Schedule C line 30 is not computed." }
          : {
              required: false,
              reason: `The simplified home-office method is in force (decision X1, ${x1.status === "decided" ? "decided" : "default, undecided"}): no Form 8829 is filed and Schedule C line 30 comes from the simplified worksheet. Form 8829 is needed only if the CPA chooses the actual method.`,
            };
  const sd = ret.scheduleD;
  if (sd === undefined || sd === null) {
    // Schedule D was not assessed (an older caller): a 1099-B in the facts cannot be ruled out
    out.schd = facts.income.otherIncomeBoxes.some((b) => b.variant === "1099-B")
      ? { required: "blocking", reason: "A 1099-B was read: Schedule D / Form 8949 are not computed by this engine." }
      : { required: false, reason: "No 1099-B sales on file (capital gain distributions go directly on 1040 line 7a)." };
    out.f8949 = out.schd.required === "blocking" ? { required: "blocking", reason: "A 1099-B was read: Form 8949 cannot be ruled out." } : { required: false, reason: "No capital transactions to report on Form 8949." };
    return out;
  }
  out.schd =
    sd.required === true
      ? { required: true, reason: "Capital transactions, a capital loss carryover or another capital item are present: Schedule D is required." }
      : sd.required === "blocking"
        ? { required: "blocking", reason: "Cannot tell whether Schedule D is required until the capital gain inputs (unread 1099-B summary, carryover, other sales or capital items) are resolved." }
        : { required: false, reason: "No capital transactions: only capital gain distributions, which go directly on 1040 line 7a (Exception 1); check the line 7b \"Schedule D not required\" box." };
  out.f8949 =
    sd.form8949Required === true
      ? { required: true, reason: "Some sales have a wash sale adjustment, no basis reported to the IRS (boxes B / E / H / K) or a 1099-DA: they go on Form 8949 (a summary row per broker with the broker's pages attached as the statement)." }
      : sd.form8949Required === "blocking"
        ? { required: "blocking", reason: "Cannot tell whether Form 8949 is needed until the sales summary, the owner's adjustment answers and the missing figures are resolved." }
        : { required: false, reason: sd.categories.length === 0 ? "No capital transactions are on file to report on Form 8949." : "Every sale has basis reported to the IRS and no adjustment: the totals go directly on Schedule D lines 1a / 8a (no Form 8949)." };
  return out;
}

// ── Header attestations ───────────────────────────────────────────────────────

function attestationOf(leaf: Sourced<boolean>, where: string): AttestationAnswer {
  return { value: leaf.value, status: leaf.value !== null ? "answered" : leaf.basis === null ? "missing" : "unsure", where, refs: leaf.refs };
}

function attestationsOf(facts: Ty2025Facts): Ty2025Return["attestations"] {
  return {
    digitalAssets: attestationOf(facts.returnAnswers.attestations.digitalAssets, "Form 1040 page 1, digital assets question"),
    foreignAccounts: attestationOf(facts.returnAnswers.attestations.foreignAccounts, "Schedule B Part III, foreign accounts and trusts"),
  };
}

function attestationOpenItems(att: Ty2025Return["attestations"]): OpenItem[] {
  const out: OpenItem[] = [];
  const item = (id: string, a: AttestationAnswer, yes: string): void => {
    if (a.status === "missing") {
      out.push({ id: `attest:${id}`, severity: "blocking", message: `The question "${a.where}" has not been answered.`, action: "Answer it in the Return completeness questionnaire.", lineKeys: [], refs: [] });
    } else if (a.status === "unsure") {
      out.push({ id: `attest:${id}`, severity: "blocking", message: `The owner is not sure how to answer "${a.where}".`, action: "The CPA decides the answer.", lineKeys: [], refs: a.refs });
    } else if (a.value === true) {
      out.push({ id: `attest:${id}`, severity: "blocking", message: yes, action: "Give the details to the CPA; this engine does not prepare it.", lineKeys: [], refs: a.refs });
    }
  };
  item("digital", att.digitalAssets, "The owner answers Yes to the digital assets question, so gain or loss goes on Form 8949 / Schedule D, which this engine does not compute.");
  item("foreign", att.foreignAccounts, "The owner answers Yes to the foreign account / foreign trust question: Schedule B Part III, FinCEN Form 114 and Form 8938 are the CPA's.");
  return out;
}

// ── Public entry point ────────────────────────────────────────────────────────

function blockedWholeReturn(facts: Ty2025Facts, status: string): Ty2025Return {
  const lines: Partial<Record<LineKey, ReturnLine>> = {};
  for (const meta of LINE_CATALOG) {
    lines[meta.key] = {
      key: meta.key,
      form: meta.form,
      formLine: meta.formLine,
      label: meta.label,
      status: "needs_cpa_judgment",
      amount: null,
      exact: null,
      reason: `The Planning answer for filing status is "${status}"; this engine computes married filing jointly only.`,
      ruleId: "filing-status",
      citations: [],
      refs: facts.household.filingStatus.refs,
    };
  }
  const blockedAmount: HeadlineAmount = { status: "needs_cpa_judgment", amount: null, reason: "MFJ only." };
  return {
    engineVersion: TY2025_ENGINE_VERSION,
    taxYear: 2025,
    filingStatus: "mfj",
    lines,
    results: [],
    conflicts: [],
    openItems: [],
    decisions: [],
    headline: {
      complete: false,
      federal: { agi: blockedAmount, taxableIncome: blockedAmount, totalTax: blockedAmount, totalPayments: blockedAmount, balance: blockedAmount },
      connecticut: { ctAgi: blockedAmount, tax: blockedAmount, totalPayments: blockedAmount, balance: blockedAmount },
      blockingItemCount: 1,
      unverifiedDocumentCount: 0,
      derivedInputCount: 0,
      undecidedDecisionCount: 0,
      caveats: [],
      provisional: null,
    },
    citations: [],
    scheduleC: null,
    scheduleD: null,
    formsRequired: {},
    attestations: attestationsOf(facts),
  };
}

export interface ResolvedExtras {
  conflicts?: FactConflict[];
  openItems?: OpenItem[];
}

/**
 * Computes the TY2025 return. `decisions` are the recorded CPA/owner choices (an
 * absent entry means undecided: the conservative alternative is used and marked).
 * `extras` carries the conflicts and open items resolveFacts() produced.
 */
export function computeTy2025Return(facts: Ty2025Facts, decisions: Ty2025Decisions = {}, extras: ResolvedExtras = {}): Ty2025Return {
  const status = facts.household.filingStatus.value;
  if (status !== null && status !== "mfj") {
    const ret = blockedWholeReturn(facts, status);
    return { ...ret, conflicts: extras.conflicts ?? [], openItems: extras.openItems ?? [] };
  }
  const A = assemble(facts, decisions, false);
  const lines: Partial<Record<LineKey, ReturnLine>> = {};
  for (const key of LINE_KEYS) {
    const l = A.lines.get(key);
    if (l !== undefined) lines[key] = l;
  }
  const attestations = attestationsOf(facts);
  const openItems: OpenItem[] = [
    ...(extras.openItems ?? []),
    ...ruleOpenItems(A),
    ...A.scheduleDItems,
    ...A.overpaymentItems,
    ...attestationOpenItems(attestations),
    ...informationalOpenItems(A),
    ...stateRefundOpenItems(A),
    ...noneGroupOpenItems(A),
    ...decisionOpenItems(A.decisions),
    ...STANDING_ADVISORIES,
  ];
  const conflicts: FactConflict[] = [...(extras.conflicts ?? [])];
  const booksInterest = A.scheduleC?.booksInterest ?? [];
  if (booksInterest.length > 0) {
    const cents = booksInterest.reduce((n, b) => n + b.amountCents, 0);
    openItems.push({
      id: "books-interest-routed",
      severity: "advisory",
      message: `Interest earned on the business bank account per the books ($${(cents / 100).toFixed(2)}, ${booksInterest.map((b) => b.name).join(", ")}) is reported as taxable interest on Form 1040 line 2b / Schedule B, NOT as Schedule C income (Schedule B instructions: report all taxable interest; Schedule C line 6 covers interest on notes and accounts receivable only).`,
      action: "CPA to confirm. If the same bank also issued a 1099-INT, the books interest may duplicate it: nothing is subtracted automatically.",
      lineKeys: ["f1040.2b", "schb.2"],
      refs: booksInterest.map((b) => ({ kind: "gl" as const, id: b.code, label: b.name })),
    });
    if (facts.income.interest.length > 0) {
      conflicts.push({
        factKey: "income.interest.books",
        candidates: [
          { basis: "books", label: "Interest earned per the EK Consulting books", value: cents, refs: booksInterest.map((b) => ({ kind: "gl" as const, id: b.code, label: b.name })) },
          ...facts.income.interest.map((i) => ({ basis: i.basis, label: `1099-INT${i.payer ? ` from ${i.payer}` : ""}`, value: i.box1Cents, refs: i.refs })),
        ],
        chosen: "both counted",
        reason: "Both the books interest and the 1099-INT interest are included in line 2b; if they are the same interest (the business bank issued the 1099-INT) it is counted twice. Nothing is subtracted automatically.",
      });
    }
  }
  // Form 1098 box 5 mortgage insurance premiums: not deductible for 2025 (Pub. 936 (2025)); shown so the CPA sees the amount
  const mipDocs = facts.deductions.mortgages.filter((m) => (m.mortgageInsuranceCents ?? 0) > 0);
  if (mipDocs.length > 0) {
    const mipCents = mipDocs.reduce((n, m) => n + (m.mortgageInsuranceCents ?? 0), 0);
    openItems.push({
      id: "scha-mortgage-insurance-not-deductible",
      severity: "advisory",
      message: `Form 1098 box 5 mortgage insurance premiums of ${fmt(centsToDollars(mipCents))} are not deducted: the itemized deduction for them has expired for 2025 ("You can no longer claim the deduction", Pub. 936 (2025), ${K.MORTGAGE_INSURANCE_PREMIUM_DEDUCTION_TY2025.url}) and the 2025 Schedule A has no line for them.`,
      action: "CPA to confirm; nothing is deducted for it.",
      lineKeys: ["scha.8a"],
      refs: mipDocs.flatMap((m) => m.refs),
    });
  }
  // CT Schedule 1 lines 37 / 49 "Other - specify": the printed form wants a description and the overlay has no text field for it
  const ctOther: LineKey[] = (["ct1040.s1.37", "ct1040.s1.49"] as const).filter((k) => (A.peek(k) ?? ZERO).greaterThan(0));
  if (ctOther.length > 0) {
    openItems.push({
      id: "ct-schedule1-other-specify",
      severity: "advisory",
      message: `CT-1040 Schedule 1 ${ctOther.map((k) => `line ${k.slice("ct1040.s1.".length)}`).join(" and ")} (Other) has a stated amount: the printed form requires a description ("Other - specify"), which this packet does not print.`,
      action: "The CPA adds the description on the form.",
      lineKeys: ctOther,
      refs: [],
    });
  }
  // Schedule 1-A rests on owner statements the app cannot verify (the occupation behind qualified tips, the character of the overtime)
  const sch1aTotal = A.peek("sch1a.38");
  if (sch1aTotal !== null && sch1aTotal.greaterThan(0)) {
    const vin = (A.peek("sch1a.23") ?? ZERO).greaterThan(0);
    openItems.push({
      id: "sch1a-owner-statements",
      severity: "advisory",
      message: `Schedule 1-A (${fmt(sch1aTotal)} on Form 1040 line 13b) rests on owner statements the app cannot verify: that the qualified tips were received in an occupation listed at IRS.gov/TippedOccupations (the app records neither the occupation nor its code), that they are cash, voluntary tips and not automatic service charges, that the overtime is FLSA overtime premium only (an employer's W-2 box 14 "OT PREMIUM" amount may be relied on; the divide-by-three method is right only for time-and-a-half pay), and, for line 4a, that W-2 box 5 is not above the Social Security wage base and no tips beyond box 7 apply${vin ? "; Part IV also needs the vehicle identification number(s) (line 22), which the app does not store" : ""}.`,
      action: "CPA to confirm the occupation, the tip and overtime character and the amounts with the owner.",
      lineKeys: ["sch1a.38"],
      refs: [],
    });
  }
  // Form 8960 assumptions the owner / CPA should see (only when the form is attached)
  const f8960Required = (A.peek("f8960.15") ?? ZERO).greaterThan(0) && (A.peek("f8960.8") ?? ZERO).greaterThan(0);
  if (f8960Required) {
    const sch3 = A.peek("sch1.3");
    if (sch3 !== null && !sch3.isZero()) {
      openItems.push({
        id: "niit-sch-c-nonpassive",
        severity: "advisory",
        message: `Form 8960 line 4b assumes the owner materially participates in EK Consulting, so its Schedule C result (${fmt(sch3)}) is income of a trade or business that is not passive and is NOT net investment income (it is reversed on line 4b). If the business were passive, that result would instead enter net investment income.`,
        action: "CPA to confirm material participation in EK Consulting (the owner does the work).",
        lineKeys: ["f8960.4a", "f8960.4b"],
        refs: [],
      });
    }
    const b9 = A.results.find((r) => r.ruleId === "niit-8960")?.reasons.find((x) => x.startsWith("Line 9b"));
    if (b9 !== undefined) {
      openItems.push({
        id: "niit-allocation-9b",
        severity: "advisory",
        message: b9,
        action: "CPA to confirm the allocation method for Form 8960 line 9b (a CPA override of the line is possible).",
        lineKeys: ["f8960.9b"],
        refs: [],
      });
    }
  }
  // A qualified business loss carried to 2026 (Form 8995 line 16 / 17): the owner needs the amount for next year's return
  const qbiOut16 = A.peek("f8995.16");
  const qbiOut17 = A.peek("f8995.17");
  const qbiLoss16 = qbiOut16 !== null && qbiOut16.lessThan(0);
  const qbiLoss17 = qbiOut17 !== null && qbiOut17.lessThan(0);
  if (qbiLoss16 || qbiLoss17) {
    const parts: string[] = [];
    if (qbiLoss16 && qbiOut16 !== null) parts.push(`A qualified business loss of ${fmt(qbiOut16.negated())} carries forward to 2026. It is on Form 8995 line 16. It reduces your 2026 qualified business income (2026 Form 8995 line 3).`);
    if (qbiLoss17 && qbiOut17 !== null) parts.push(`A qualified REIT dividend / publicly traded partnership loss of ${fmt(qbiOut17.negated())} carries forward to 2026. It is on Form 8995 line 17 (2026 Form 8995 line 7).`);
    openItems.push({
      id: "qbi-carryforward-out",
      severity: "advisory",
      message: `${parts.join(" ")} It does not change your 2025 tax. This assumes no loss was carried into 2025 from 2024 (you said none).`,
      action: "Read your 2024 Form 8995 (or 8995-A): if it showed a loss on line 16 or 17, tell your tax preparer, because it belongs on 2025 line 3 or 7. Then keep this Form 8995 with your 2025 return and give the carryforward amount to whoever prepares your 2026 return.",
      lineKeys: [...(qbiLoss16 ? (["f8995.16"] as LineKey[]) : []), ...(qbiLoss17 ? (["f8995.17"] as LineKey[]) : [])],
      refs: [],
    });
  }
  // Form 8606: line 14 is next year's starting point; and a hint when the IRA already held money (so "no earlier basis" deserves a second look)
  const basisKeys = (["f8606a.14", "f8606b.14"] as LineKey[]).filter((k) => (A.peek(k) ?? ZERO).greaterThan(0));
  if (basisKeys.length > 0) {
    openItems.push({
      id: "f8606-basis-record",
      severity: "advisory",
      message: `Form 8606 line 14 (your total basis in traditional IRAs for 2025 and earlier years) is next year's starting point: it is 2026 Form 8606 line 2. ${basisKeys.map((k) => `${lineMeta(k).form}: ${fmt(A.peek(k) ?? ZERO)}`).join("; ")}.`,
      action: "Check that you keep a copy of the filed Form 8606 with your tax records (2025 Form 8606 instructions, What Records Must I Keep).",
      lineKeys: basisKeys,
      refs: [],
    });
  }
  // Form 8606 line 2 is the owner's answer (line 14 of the 2024 Form 8606): say where it comes from, that nothing in the app checks it, and that the
  // Form 5498 year-end value is information only (the form skips line 6 when there is no distribution or conversion).
  {
    const entries = facts.returnAnswers.people.flatMap((p) => {
      const key = p.slot === "a" ? "f8606a.2" : "f8606b.2";
      const amt = p.priorBasisCents?.value ?? null;
      if (amt === null || amt < 0 || A.statusOf(key) !== "computed") return [];
      const trad = p.traditionalIraCents.value ?? 0;
      const stmt = (facts.income.retirementStatements ?? []).find((r) => p.userId !== null && r.personUserId === p.userId && r.fairMarketValueCents !== null);
      return [{ p, key: key as LineKey, amt, stmt, heldMore: stmt !== undefined && (stmt.fairMarketValueCents ?? 0) > trad }];
    });
    if (entries.length > 0) {
      const parts = entries.map(({ p, amt, stmt, heldMore }) => {
        const own = `${p.name}: line 2 is ${fmt(centsToDollars(amt))}, your answer from the 2024 Form 8606 line 14.`;
        const fmv = stmt === undefined ? "" : ` The year-end value on the Form 5498 (box 5: ${fmt(centsToDollars(stmt.fairMarketValueCents ?? 0))}) is information only: Form 8606 does not use it when there was no distribution or conversion.`;
        const zero = amt === 0 && heldMore ? " You entered 0 although the IRA already held more than this year's contribution at year end; check that no earlier contribution was left undeducted." : "";
        return `${own}${fmv}${zero}`;
      });
      openItems.push({
        id: "f8606-prior-basis-check",
        severity: "advisory",
        message: `${parts.join(" ")} The app holds only adjusted gross income and tax from your 2024 return, so it cannot check the 2024 Form 8606 figure.`,
        action: "Check that the line 2 amount matches line 14 of your 2024 Form 8606 (2025 Form 8606 instructions, Line 2 and the Total Basis Chart).",
        lineKeys: entries.map((e) => e.key),
        refs: entries.flatMap(({ p, stmt }) => [...(p.priorBasisCents?.refs ?? []), ...(stmt?.refs ?? [])]),
      });
    }
  }
  const blockingItemCount = openItems.filter((o) => o.severity === "blocking").length;
  const strictHeadline = buildHeadline(A, blockingItemCount, null, openItems);
  const provisional = strictHeadline.complete ? null : provisionalFrom(assemble(facts, decisions, true));
  const headline = { ...strictHeadline, provisional };
  const ret: Ty2025Return = {
    engineVersion: TY2025_ENGINE_VERSION,
    taxYear: 2025,
    filingStatus: "mfj",
    lines,
    results: A.results,
    conflicts,
    openItems,
    decisions: A.decisions,
    headline,
    citations: [...A.citations].sort(),
    scheduleC: A.scheduleC,
    scheduleD: A.scheduleD,
    formsRequired: {},
    attestations,
  };
  ret.formsRequired = computeFormsRequired(ret, facts);
  return ret;
}

/** Test hook: the keys any rule emitted more than once (a bug: each key has exactly one owner). */
export function duplicateEmissions(facts: Ty2025Facts, decisions: Ty2025Decisions = {}): LineKey[] {
  return assemble(facts, decisions, false).duplicates;
}

