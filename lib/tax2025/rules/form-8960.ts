// Form 8960 (Net Investment Income Tax, individuals), TY2025, MFJ. EVERY printed money line of Parts I-III for an
// individual has an engine line (the PDF layer never computes anything): 1, 2, 3, 4a-4c, 5a-5d, 6, 7, 8, 9a-9d, 10, 11,
// 12 (key f8960.nii), 13-16 and 17 (key f8960.niit); Schedule 2 line 12 repeats line 17. Parts IV and V (lines 18a-21) are for
// estates and trusts and are not part of an individual return.
//
// Sources (primary, registered in constants.ts and specs/09): the 2025 Form 8960 and its instructions
// (https://www.irs.gov/pub/irs-pdf/i8960.pdf, dated Feb 4, 2026):
//   NIIT = 3.8% x the SMALLER of net investment income (line 12) or the MAGI over the threshold (line 15); MFJ threshold $250,000.
//   Part I: interest (line 1 = Form 1040 line 2b) and dividends (line 2 = 3b) are net investment income unless derived in the ordinary
//     course of a trade or business that is not passive. Line 3 is non-qualified annuities. Line 4a = Schedule 1 lines 3 + 5 + 6
//     (income of Schedules C, E and F); line 4b reverses, with the opposite sign, the part that comes from a trade or business that is
//     NOT passive (a sole proprietor's Schedule C income when the owner materially participates is not investment income). Line 5a =
//     Form 1040 line 7a (a capital loss already limited to -$3,000 by Schedule D) + Schedule 1 line 4. Lines 6 and 7 (foreign
//     corporations, trust distributions, net operating losses ...) cannot be read from any document: an owner statement ("niit_other")
//     decides them.
//   Part II: line 9a = Schedule A line 9 (investment interest) when itemizing. Line 9b = state and local INCOME tax deducted on Schedule A
//     that is attributable to net investment income, by "any reasonable method"; the instructions' own example is the ratio of gross
//     investment income (line 8) to AGI, which is what this rule uses (constant NIIT_ALLOCATION_METHOD; the CPA may change it). Real
//     estate tax is not allocated here. Line 9c: miscellaneous investment expenses are no longer deductible (P.L. 119-21 sec. 70110).
//   Part III: line 12 is not below zero; line 13 = AGI (+ Puerto Rico / Form 2555 / Form 4563 exclusions, which the owner states none);
//     line 15 not below zero.
//
// Every line is one of: a whole-dollar amount derived from the whole-dollar lines above it (like a person filling in the form, so the
// printed form foots), a not_applicable zero that states why, or blocked (missing_input / needs_cpa_judgment / the status of the line it
// waits for). Nothing is a silent 0.
//
// MAGI not over the threshold: the form is not required, lines 13-17 are computed (15 = 16 = 17 = 0), and every Part I / II line that
// cannot be resolved is a not_applicable zero ("Form 8960 is not required"), so nothing blocks.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { NONE_GROUP_TEXT, lineMeta } from "@/lib/tax2025/line-catalog";
import { D, ZERO, amountLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import { block, makeEmitters, mergeBlocked, type Blocked, type Val } from "@/lib/tax2025/rules/line-emit";
import { aggregateStatus, worstBlocked, type LineKey, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

/** A line already on the return: its whole-dollar amount (null when blocked) and its status. */
export interface Form8960Lead {
  amount: Decimal | null;
  status: RuleStatus | undefined;
}

export interface Form8960Input {
  /** Form 1040 line 11a (adjusted gross income). */
  agi: Form8960Lead;
  /** True = no Puerto Rico excluded income and no Form 2555 / 4563 (MAGI equals AGI). */
  magiExclusionsNone: Ans<boolean>;
  /** Form 1040 line 2b, 3b, 5b and 7a (7a signed: a capital loss is limited to -3,000 by Schedule D). */
  interest: Form8960Lead;
  dividends: Form8960Lead;
  pensions: Form8960Lead;
  gain7a: Form8960Lead;
  /** Schedule 1 lines 3 (business income), 4 (other gains), 5 (rental, partnership ...) and 6 (farm). */
  sch1Line3: Form8960Lead;
  sch1Line4: Form8960Lead;
  sch1Line5: Form8960Lead;
  sch1Line6: Form8960Lead;
  /** Schedule A lines 5a (state and local income tax), 5d (before the cap), 5e (after the cap) and 9 (investment interest). */
  schA5a: Form8960Lead;
  schA5d: Form8960Lead;
  schA5e: Form8960Lead;
  schA9: Form8960Lead;
  /** true = itemizing, false = the standard deduction wins, null = not decided (then `itemizingStatus` says why). */
  itemizing: boolean | null;
  itemizingStatus: RuleStatus | undefined;
  /** Owner statements: true = "none", false = answered Yes, undefined = not answered. */
  statedNoCapitalOther: boolean | undefined;
  niitOther: boolean | undefined;
  /** True when the return has investment income this engine does not compute (Section 1256 / 1099-DA / unread 1099-B, other 1099 boxes, K-1). */
  otherInvestmentIncomePresent: boolean;
}

const CITATIONS = ["NIIT_RATE", "NIIT_THRESHOLD_MFJ", "NIIT_ALLOCATION_METHOD", "NIIT_MISC_INVESTMENT_EXPENSES_DEDUCTIBLE"];

/** Every key of this rule (the assembler owns them all). */
export const FORM_8960_KEYS = [
  "f8960.1",
  "f8960.2",
  "f8960.3",
  "f8960.4a",
  "f8960.4b",
  "f8960.4c",
  "f8960.5a",
  "f8960.5b",
  "f8960.5c",
  "f8960.5d",
  "f8960.6",
  "f8960.7",
  "f8960.8",
  "f8960.9a",
  "f8960.9b",
  "f8960.9c",
  "f8960.9d",
  "f8960.10",
  "f8960.11",
  "f8960.nii",
  "f8960.13",
  "f8960.14",
  "f8960.15",
  "f8960.16",
  "f8960.niit",
  "sch2.12",
] as const satisfies readonly LineKey[];

/** The keys of Parts I and II and line 12: when the form is not required, the ones that cannot be resolved become not_applicable. */
const PART_I_II_KEYS: readonly LineKey[] = FORM_8960_KEYS.slice(0, FORM_8960_KEYS.indexOf("f8960.nii") + 1);

/** A line already on the return as a value, or the reason it has none. */
function lead(l: Form8960Lead, what: string): Val {
  if (l.amount !== null) return { ok: true, v: roundLine(l.amount) };
  const status = (worstBlocked([l.status]) ?? "missing_input") as Blocked;
  return block(status, `${what} is not computed yet.`, what);
}

export function computeForm8960(input: Form8960Input): RuleResult {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing = new Set<string>();
  const h = makeEmitters(lines, missing);
  const threshold = D(K.NIIT_THRESHOLD_MFJ.value);
  const rate = D(K.NIIT_RATE.value);

  // ── MAGI (line 13) decides whether the form is needed at all ────────────────
  const agi = lead(input.agi, "Form 1040 line 11a (adjusted gross income)");
  const excl = input.magiExclusionsNone;
  // The exclusions question is only asked when a Schedule 1-A part applies, so an UNANSWERED question is read as "no exclusion reported" (as
  // the net investment income screen always did); an owner "Yes" or "not sure" is a CPA matter.
  const magi: Val = !agi.ok
    ? agi
    : excl.state === "unsure" || (excl.state === "answered" && excl.value === false)
      ? block("needs_cpa_judgment", "The owner is not sure about, or reports, excluded income (Puerto Rico, Form 2555, Form 4563): the CPA adds it to AGI to get the modified adjusted gross income (Form 8960 line 13).", "Puerto Rico / Form 2555 / Form 4563 exclusions")
      : agi;
  const over: boolean | null = magi.ok ? magi.v.greaterThan(threshold) : null;
  /** The Part I / II inputs that need an owner statement are only asked when the form can apply. */
  const needed = over !== false;

  // ── Part I: investment income ───────────────────────────────────────────────
  const fromLead = (key: LineKey, l: Form8960Lead, what: string, reason: string): Val => {
    const v = lead(l, what);
    return v.ok ? h.amt(key, v.v, "computed", reason) : h.blk(key, v);
  };
  const l1 = fromLead("f8960.1", input.interest, "Form 1040 line 2b (taxable interest)", "Form 1040 line 2b, taxable interest (interest of a trade or business that is not passive would go on line 7; none is stated).");
  const l2 = fromLead("f8960.2", input.dividends, "Form 1040 line 3b (ordinary dividends)", "Form 1040 line 3b, ordinary dividends.");

  const pensions = lead(input.pensions, "Form 1040 line 5b (pensions and annuities)");
  const l3: Val = !pensions.ok
    ? h.blk("f8960.3", pensions)
    : !pensions.v.isZero()
      ? h.blk("f8960.3", block("needs_cpa_judgment", `Form 1040 line 5b shows ${fmt(pensions.v)} of pensions and annuities: only non-qualified annuities (Form 1099-R code D) are net investment income, so the CPA classifies the amount.`, "Form 8960 line 3 (annuities)"))
      : h.na("f8960.3", "No pension or annuity amount on Form 1040 line 5b (the owner states no IRA distributions, pensions or annuities).");

  const s3 = lead(input.sch1Line3, "Schedule 1 line 3 (business income or loss)");
  const s4 = lead(input.sch1Line4, "Schedule 1 line 4 (other gains or losses)");
  const s5 = lead(input.sch1Line5, "Schedule 1 line 5 (rental, partnership, S corporation, trust income)");
  const s6 = lead(input.sch1Line6, "Schedule 1 line 6 (farm income or loss)");
  const l4a = h.calc("f8960.4a", [s3, s5, s6], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Schedule 1 lines 3, 5 and 6 (the total income of Schedules C, E and F).");
  const l4b: Val = (() => {
    const bad = [s3, s5, s6].filter((x): x is Extract<Val, { ok: false }> => !x.ok);
    if (bad.length > 0) return h.blk("f8960.4b", mergeBlocked(bad));
    const c = (s3 as { ok: true; v: Decimal }).v;
    const other = (s5 as { ok: true; v: Decimal }).v.plus((s6 as { ok: true; v: Decimal }).v);
    if (!other.isZero()) {
      return h.blk("f8960.4b", block("needs_cpa_judgment", `Schedule 1 shows ${fmt(other)} of rental, partnership, S corporation, trust or farm income: whether it comes from a passive activity (net investment income) or a non-passive trade or business is not known to the engine, so the CPA completes line 4b.`, "Form 8960 line 4b (passive or non-passive split)"));
    }
    if (c.isZero()) return h.na("f8960.4b", "No Schedule C income or loss to adjust.");
    return h.amt("f8960.4b", ZERO.minus(c), "computed", `Schedule C result ${fmt(c)} is income or loss of a trade or business that is not passive (assumed: the owner materially participates in EK Consulting), so it is entered with the opposite sign and is not net investment income.`);
  })();
  const l4c = h.calc("f8960.4c", [l4a, l4b], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Line 4a plus line 4b.");

  const gain = lead(input.gain7a, "Form 1040 line 7a (capital gain or loss)");
  const l5a: Val =
    needed && input.otherInvestmentIncomePresent
      ? h.blk("f8960.5a", block("needs_cpa_judgment", `MAGI is over ${fmt(threshold)} and the return has investment income this engine does not compute (1099-B / other 1099 boxes / K-1), so net investment income is incomplete; the CPA must figure Form 8960.`, "Form 8960 line 5a (investment income the engine does not compute)"))
      : h.calc("f8960.5a", [gain, s4], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Form 1040 line 7a (capital gain or loss; a capital loss is already limited to $3,000 by Schedule D line 21) plus Schedule 1 line 4.");

  /** A "none" statement decides the line: true -> 0, Yes -> CPA, unanswered -> missing. */
  const statement = (key: LineKey, flags: ReadonlyArray<readonly [string, boolean | undefined]>, zeroReason: string): Val => {
    const yes = flags.filter(([, v]) => v === false).map(([name]) => name);
    if (yes.length > 0) return h.blk(key, block("needs_cpa_judgment", `The owner answered Yes to: ${yes.join("; ")}. The CPA classifies it for Form 8960.`, `Form 8960 line ${lineMeta(key).formLine}`));
    const unanswered = flags.filter(([, v]) => v === undefined).map(([name]) => name);
    if (unanswered.length > 0) return h.blk(key, block("missing_input", `Needs an owner statement: ${unanswered.join("; ")}.`, unanswered.join("; ")));
    return h.na(key, zeroReason);
  };
  const CAPITAL_OTHER = "no installment sale, casualty loss, Section 1256 contract, like-kind exchange or Schedule K-1 capital gain (Return completeness: other capital gain and loss items)";
  const l5b: Val = !s4.ok
    ? h.blk("f8960.5b", s4)
    : !s4.v.isZero()
      ? h.blk("f8960.5b", block("needs_cpa_judgment", `Schedule 1 line 4 shows ${fmt(s4.v)}: the part from property held in a non-passive trade or business is not net investment income, so the CPA splits it.`, "Form 8960 line 5b"))
      : statement("f8960.5b", [[CAPITAL_OTHER, input.statedNoCapitalOther]], "No gain or loss from property that is not subject to net investment income tax (the owner states no other gains or capital items).");
  // 5c: a partnership interest or S corporation stock sold. The Schedule 1 line 5 amount (partnership / S corporation income) must be 0 and the
  // owner must state no Schedule K-1 capital items; an "other income: Yes" for something else (a state tax refund) is not a reason to ask the CPA.
  const l5c: Val = !s5.ok
    ? h.blk("f8960.5c", s5)
    : !s5.v.isZero()
      ? h.blk("f8960.5c", block("needs_cpa_judgment", `Schedule 1 line 5 shows ${fmt(s5.v)} of rental, partnership, S corporation or trust income: whether an interest or stock was also sold (Form 8960 line 5c) is the CPA's call.`, "Form 8960 line 5c"))
      : statement("f8960.5c", [[CAPITAL_OTHER, input.statedNoCapitalOther]], "No partnership interest or S corporation stock was sold (Schedule 1 line 5 is 0 and the owner states no Schedule K-1 capital items).");
  const l5d = h.calc("f8960.5d", [l5a, l5b, l5c], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Lines 5a through 5c.");

  /** Lines 6, 7 and 10: foreign corporations, trust distributions, net operating loss, recoveries, trading expenses. */
  const otherNone = (key: LineKey): Val => {
    if (!needed) return h.na(key, `Form 8960 is not required: MAGI is not over ${fmt(threshold)}.`);
    // MAGI itself is not final: whether Form 8960 applies is unknown, so the statement is not asked yet (a cascade, not owner homework)
    if (!magi.ok) return h.blk(key, magi);
    if (input.niitOther === true) return h.na(key, `Stated: ${NONE_GROUP_TEXT.niit_other}`);
    if (input.niitOther === false) {
      return h.blk(key, block("needs_cpa_judgment", `The owner answered Yes: the CPA must work Form 8960 lines 6, 7 and 10 (the amounts are not computed here). The statement that does not hold: ${NONE_GROUP_TEXT.niit_other}`, "Form 8960 lines 6, 7 and 10"));
    }
    return h.blk(key, block("missing_input", `Needs an owner/CPA statement: ${NONE_GROUP_TEXT.niit_other}`, "the Form 8960 lines 6, 7 and 10 statement (Return completeness)"));
  };
  const l6 = otherNone("f8960.6");
  const l7 = otherNone("f8960.7");
  const l8 = h.calc("f8960.8", [l1, l2, l3, l4c, l5d, l6, l7], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Lines 1, 2, 3, 4c, 5d, 6 and 7.");

  // ── Part II: investment expenses ────────────────────────────────────────────
  const itemizing = input.itemizing;
  const itemBlock = block((worstBlocked([input.itemizingStatus]) ?? "missing_input") as Blocked, "Whether the return itemizes (Schedule A line 17 against the standard deduction) is not decided yet.", "standard versus itemized deduction");
  const l9a: Val =
    itemizing === null
      ? h.blk("f8960.9a", itemBlock)
      : !itemizing
        ? h.na("f8960.9a", "The standard deduction is in force: no investment interest is deducted on Schedule A, so none is deducted here.")
        : (() => {
            const a = lead(input.schA9, "Schedule A line 9 (investment interest)");
            return a.ok ? h.amt("f8960.9a", a.v, a.v.isZero() ? "not_applicable" : "computed", "Investment interest expense deducted on Schedule A line 9.") : h.blk("f8960.9a", a);
          })();
  const l9c: Val = K.NIIT_MISC_INVESTMENT_EXPENSES_DEDUCTIBLE.value === false
    ? h.na("f8960.9c", "Miscellaneous investment expenses are no longer deductible (Form 8960 instructions, line 9c: P.L. 119-21 section 70110), so none is deducted.")
    : h.blk("f8960.9c", block("needs_cpa_rule_unverified", "The deductibility of miscellaneous investment expenses is not verified for this year; the CPA decides.", "Form 8960 line 9c"));
  const l10 = otherNone("f8960.10");

  let allocation: { amount: Decimal; base: Decimal; agi: Decimal; alt: Decimal | null } | null = null;
  const l9b: Val = (() => {
    if (itemizing === null) return h.blk("f8960.9b", itemBlock);
    if (!itemizing) return h.na("f8960.9b", "The standard deduction is in force: state and local income tax is not deducted for income tax, so it is not deducted for net investment income either.");
    const a5 = lead(input.schA5a, "Schedule A line 5a (state and local income tax)");
    const d5 = lead(input.schA5d, "Schedule A line 5d (state and local taxes before the cap)");
    const e5 = lead(input.schA5e, "Schedule A line 5e (state and local taxes after the cap)");
    const bad = [a5, d5, e5, l8, agi].filter((x): x is Extract<Val, { ok: false }> => !x.ok);
    if (bad.length > 0) return h.blk("f8960.9b", mergeBlocked(bad));
    const [a, d, e, base, income] = [a5, d5, e5, l8, agi].map((x) => (x as { ok: true; v: Decimal }).v) as [Decimal, Decimal, Decimal, Decimal, Decimal];
    if (e.lessThan(d)) {
      return h.blk("f8960.9b", block("needs_cpa_judgment", `The state and local tax cap limits Schedule A line 5e (${fmt(e)}) below line 5d (${fmt(d)}); the instructions do not say how the capped amount splits between income tax and real estate tax, so the CPA allocates line 9b.`, "Form 8960 line 9b (state tax cap)"));
    }
    if (income.lessThanOrEqualTo(0) || base.lessThanOrEqualTo(0)) {
      return h.na("f8960.9b", `No state income tax is allocated: total investment income (line 8) is ${fmt(base)} and AGI is ${fmt(income)}.`);
    }
    // Reasonable method (Form 8960 instructions, Part II): state and local income tax x (line 8 / AGI), ratio capped at 1.
    const exact = a.times(minD(base, income)).div(income);
    let alt: Decimal | null = null;
    if (l9a.ok && l9c.ok && l10.ok && magi.ok) {
      const l12 = maxD(ZERO, base.minus(l9a.v).minus(l9c.v).minus(l10.v));
      alt = roundLine(minD(l12, maxD(ZERO, magi.v.minus(threshold))).times(rate));
    }
    const v = h.amt("f8960.9b", exact, "computed", `State and local income tax ${fmt(a)} (Schedule A line 5a) x total investment income ${fmt(base)} (line 8) / AGI ${fmt(income)} = ${fmt(roundLine(exact))}: the allocation method the instructions give as an example (any reasonable method is allowed).${alt === null ? "" : ` With no allocation the tax would be ${fmt(alt)}.`}`);
    allocation = { amount: a, base, agi: income, alt };
    return v;
  })();
  const l9d = h.calc("f8960.9d", [l9a, l9b, l9c], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Lines 9a, 9b and 9c.");
  const l11 = h.calc("f8960.11", [l9d, l10], (v) => v.reduce((a, b) => a.plus(b), ZERO), "Lines 9d and 10.");
  const l12 = h.calc("f8960.nii", [l8, l11], (v) => maxD(ZERO, (v[0] ?? ZERO).minus(v[1] ?? ZERO)), "Line 8 minus line 11; if zero or less, 0.");

  // ── Part III: tax computation ───────────────────────────────────────────────
  const l13: Val = magi.ok
    ? h.amt("f8960.13", magi.v, "computed", excl.state === "answered" ? "Form 1040 line 11a (the owner states no Puerto Rico, Form 2555 or Form 4563 exclusion)." : "Form 1040 line 11a (no Puerto Rico, Form 2555 or Form 4563 exclusion is reported; the question is not answered).")
    : h.blk("f8960.13", magi);
  const l14 = h.amt("f8960.14", threshold, "computed", `The threshold for married filing jointly (${fmt(threshold)}).`);
  const l15 = h.calc("f8960.15", [l13, l14], (v) => maxD(ZERO, (v[0] ?? ZERO).minus(v[1] ?? ZERO)), "Line 13 minus line 14; if zero or less, 0.");
  const l16: Val =
    over === false
      ? h.amt("f8960.16", ZERO, "computed", "Line 15 is 0, so the smaller of line 12 or line 15 is 0.")
      : h.calc("f8960.16", [l12, l15], (v) => minD(v[0] ?? ZERO, v[1] ?? ZERO), "The smaller of line 12 or line 15.");
  const l17 = h.calc("f8960.niit", [l16], (v) => (v[0] ?? ZERO).times(rate), "Line 16 times 3.8%.");
  if (l17.ok) h.amt("sch2.12", l17.v, "computed", "Net investment income tax from Form 8960 line 17.");
  else h.blk("sch2.12", l17);

  // ── Form not required: what cannot be resolved is not applicable ────────────
  if (over === false) {
    const why = `Form 8960 is not required: MAGI ${fmt(magi.ok ? magi.v : ZERO)} is not over the ${fmt(threshold)} threshold.`;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] as RuleLine;
      if (!PART_I_II_KEYS.includes(l.key) || (l.status !== undefined && (l.status === "computed" || l.status === "not_applicable"))) continue;
      lines[i] = amountLine(l.key, l.label, l.formLine, ZERO, "not_applicable", why);
    }
    reasons.push(`No net investment income tax: MAGI ${fmt(magi.ok ? magi.v : ZERO)} is not over the ${fmt(threshold)} threshold.`);
  } else if (l17.ok && l12.ok && l15.ok) {
    reasons.push(`NIIT: 3.8% of the lesser of net investment income ${fmt(l12.v)} (line 12) or MAGI over the threshold ${fmt(l15.v)} (line 15) = ${fmt(l17.v)}.`);
  }
  const alloc = allocation as { amount: Decimal; base: Decimal; agi: Decimal; alt: Decimal | null } | null;
  if (alloc !== null && l9b.ok && l17.ok) {
    reasons.push(
      `Line 9b allocates the state and local income tax deducted on Schedule A (${fmt(alloc.amount)}) to investment income by line 8 / AGI (${fmt(alloc.base)} / ${fmt(alloc.agi)}) = ${fmt(l9b.v)}; any reasonable method is allowed and the CPA may change it.${alloc.alt === null ? "" : ` With no allocation (line 9b = 0) line 17 would be ${fmt(alloc.alt)} instead of ${fmt(l17.v)}.`}`
    );
  }

  const status = aggregateStatus(lines, "computed");
  if (status !== "computed" && status !== "not_applicable") {
    const worst = lines.filter((l) => (l.status ?? status) === status && l.reason !== undefined);
    const first = worst[0]?.reason;
    if (first !== undefined) reasons.unshift(first);
  }
  const result: RuleResult = {
    ruleId: "niit-8960",
    form: "Form 8960",
    status,
    lines,
    reasons,
    citations: CITATIONS,
    inputsUsed: [],
    inputsMissing: [...missing],
  };
  if (over === false) result.conclusion = "ineligible";
  else if (l17.ok) result.conclusion = "eligible";
  return result;
}
