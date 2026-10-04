// Turns the "Return completeness" questionnaire (lib/tax-questionnaire-content.ts,
// id `return-completeness`) into typed answers for the TY2025 engine.
//
// PURE and TOTAL: no DB, no clock. Input is the questionnaire's EFFECTIVE answers
// (lib/tax-questionnaire.ts effectiveAnswers) and the household people; output is the
// part of RawAnswers (resolve-facts.ts) that this questionnaire supplies:
//   - estimated payments (federal, CT), extension payments, 2024 overpayments applied,
//     CT tax paid in 2025 for 2024;
//   - the "stated none" statements for the 14 groups of rare lines (none = true, some =
//     false, "not sure" / unanswered = absent, so the engine keeps the line open);
//   - `returnAnswers`: the per-person and household facts the Phase 1b rules read.
//
// Only VISIBLE nodes count (a hidden node's stored answer is ignored, as everywhere
// in the questionnaire engine). A node that is hidden because its parent says "none"
// is turned into the parent's meaning (for example deferrals "none" = 0). Nothing is
// guessed: "Not sure - ask the CPA" becomes an owner-basis leaf with no value (the
// rules turn it into needs_cpa_judgment); an unanswered node stays a missing leaf.
//
// Estimated payments carry the representative date of the payment window the owner
// chose (RC_PAYMENT_WINDOWS): the due date for the first three windows, December 31,
// 2025 and January 15, 2026 for the last two.

import {
  UNSURE_ID,
  describeAnswerSource,
  visibleNodes,
  type AnswerSource,
  type AnswerValue,
  type EffectiveAnswers,
  type QuestionnaireContext,
} from "@/lib/tax-questionnaire";
import { RC_PAYMENT_WINDOWS, RC_PERSONS, RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { emptyReturnAnswers, type EstimatedPayment, type PersonAnswers, type ReturnAnswers } from "@/lib/tax2025/facts";
import { NONE_GROUP_IDS, type NoneGroupId } from "@/lib/tax2025/line-catalog";
import { missingLeaf, sourced, type Ref, type Sourced } from "@/lib/tax2025/types";
import { unsureLeaf } from "@/lib/tax2025/answer-state";

export interface CompletenessParse {
  federalEstimates?: EstimatedPayment[];
  ctEstimates?: EstimatedPayment[];
  federalExtensionPaymentCents?: number;
  ctExtensionPaymentCents?: number;
  federalOverpaymentAppliedCents?: number;
  ctOverpaymentAppliedCents?: number;
  ctPriorYearBalancePaidIn2025Cents?: number;
  /** Schedule 1 line 17 input: No -> 0, Yes -> the amount, Not sure / unanswered -> absent (the line stays blocked). */
  seHealthInsuranceCents?: number;
  /** Schedule 1 line 16 input (SEP / SIMPLE / solo 401(k) for the owner), same mapping. */
  seRetirementCents?: number;
  statedNone: Partial<Record<NoneGroupId, boolean>>;
  returnAnswers: ReturnAnswers;
}

/** The questionnaire context used to decide which nodes are visible (only the year matters for this definition). */
export const RC_CONTEXT: QuestionnaireContext = { year: 2025, entityName: null, ekcActive: true, svActive: false };

type Raw = { kind: "missing" } | { kind: "unsure" } | { kind: "value"; value: AnswerValue };

/** The first-name token of a display name: the first word, and for a hyphenated name its first part ("Eva-Laura Ramirez" -> "eva"). */
export function firstNameToken(name: string): string {
  return (name.trim().toLowerCase().split(/\s+/)[0] ?? "").split("-")[0] ?? "";
}

/** Exact (case-insensitive) first-name token match: "Eva-Laura Ramirez" matches "eva"; "Evan" does not. */
export function matchPerson(name: string, key: string): boolean {
  return firstNameToken(name) === key;
}

/** The ONE household user whose first name is `key`; null when there is none or more than one (ambiguous). */
export function uniquePersonMatch<T extends { name: string }>(people: readonly T[], key: string): T | null {
  const hits = people.filter((u) => matchPerson(u.name, key));
  return hits.length === 1 ? (hits[0] as T) : null;
}

/** Generic (no issuer, EIN or name) label for the document an accepted answer was filled from. */
function sourceDocLabel(field: string): string {
  return field.startsWith("return2024.") ? "2024 federal return" : "W-2";
}

/** The extra refs an answer accepted from a document / Planning answer carries (none for an answer the owner typed). */
function sourceRefs(src: AnswerSource | undefined): Ref[] {
  if (!src) return [];
  if (src.kind === "planning") {
    const key = src.field.replace(/^planning\./, "");
    return [{ kind: "planning", id: key, label: "Planning answer" }];
  }
  return src.docIds.map((docId): Ref => ({ kind: "document", id: docId, label: sourceDocLabel(src.field) }));
}

export function parseCompletenessAnswers(
  effective: EffectiveAnswers,
  people: readonly { userId: string; name: string }[]
): CompletenessParse {
  const def = questionnaireById(RETURN_COMPLETENESS_ID);
  const visible = new Set<string>((def ? visibleNodes(def, RC_CONTEXT, effective) : []).map((n) => n.id));

  const read = (id: string): Raw => {
    if (!visible.has(id)) return { kind: "missing" };
    const a = effective[id];
    if (a === undefined) return { kind: "missing" };
    const v = a.value;
    if (v === UNSURE_ID || (Array.isArray(v) && v.length === 1 && v[0] === UNSURE_ID)) return { kind: "unsure" };
    return { kind: "value", value: v };
  };
  // An answer accepted from a document keeps its basis (answer_owner: the owner accepted it, and every
  // precedence rule is unchanged) but also carries the document ref and a note saying where it came from,
  // so the sheet and the CPA summary can link the answer to the document. No `src` = byte-identical output.
  const ref = (id: string, label: string): Ref[] => [
    { kind: "questionnaire", id: `${RETURN_COMPLETENESS_ID}.${id}`, label },
    ...sourceRefs(effective[id]?.src),
  ];
  const noteOf = (id: string): string | undefined => {
    const a = effective[id];
    if (!a?.at) return undefined;
    const base = `answered ${a.at.slice(0, 10)}`;
    return a.src ? `${base}; ${describeAnswerSource(a.src).replace(/^Filled/, "filled")}` : base;
  };
  const leaf = <T>(value: T, id: string, label: string): Sourced<T> => sourced(value, "answer_owner", ref(id, label), noteOf(id));
  const missing = <T>(): Sourced<T> => missingLeaf<T>();
  const unsure = <T>(id: string, label: string): Sourced<T> => unsureLeaf<T>(ref(id, label), "Not sure - ask the CPA");
  /** A "derived" leaf: the value follows from another answer (for example "none" means 0). */
  const implied = <T>(value: T, id: string, label: string): Sourced<T> => sourced(value, "derived", ref(id, label), "follows from the owner's answer");

  const choice = (id: string): string | "unsure" | null => {
    const r = read(id);
    if (r.kind === "missing") return null;
    if (r.kind === "unsure") return "unsure";
    return typeof r.value === "string" ? r.value : null;
  };
  const cents = (id: string): number | "unsure" | null => {
    const r = read(id);
    if (r.kind === "missing") return null;
    if (r.kind === "unsure") return "unsure";
    return typeof r.value === "number" ? r.value : null;
  };

  /** yes / no / unsure -> boolean leaf. */
  const yn = (id: string, label: string): Sourced<boolean> => {
    const c = choice(id);
    if (c === null) return missing();
    if (c === "unsure") return unsure(id, label);
    return leaf(c === "yes", id, label);
  };
  /** none / some + an amount node. */
  const noneSomeCents = (gate: string, amountId: string, label: string): Sourced<number> => {
    const c = choice(gate);
    if (c === null) return missing();
    if (c === "unsure") return unsure(gate, label);
    if (c === "none") return leaf(0, gate, `${label}: none`);
    const a = cents(amountId);
    if (a === null) return missing();
    if (a === "unsure") return unsure(amountId, label);
    return leaf(a, amountId, label);
  };

  const out: CompletenessParse = { statedNone: {}, returnAnswers: emptyReturnAnswers() };

  // ── people ──────────────────────────────────────────────────────────────────
  const personAnswers: PersonAnswers[] = RC_PERSONS.map((P) => {
    const k = P.key;
    const user = uniquePersonMatch(people, k);
    const base = emptyReturnAnswers([{ slot: P.slot, userId: user?.userId ?? null, name: user?.name ?? P.name }]).people[0] as PersonAnswers;
    const lbl = (what: string) => `${P.name}: ${what}`;
    const iraC = choice(`ira_${k}`);
    const hsaC = choice(`hsa_${k}`);
    const tipsC = choice(`tips_${k}`);
    const otC = choice(`ot_${k}`);
    const p: PersonAnswers = {
      ...base,
      bornBefore1961: yn(`age_${k}`, lbl("born before January 2, 1961")),
      blind: yn(`blind_${k}`, lbl("blind at the end of 2025")),
      coveredByWorkplacePlan: yn(`plan_${k}`, lbl("covered by a retirement plan at work")),
      deferralsCents: noneSomeCents(`def_${k}`, `defamt_${k}`, lbl("elective deferrals")),
      traditionalIraCents: noneSomeCents(`ira_${k}`, `tira_${k}`, lbl("traditional IRA contributions")),
      rothIraCents: iraC === "none" ? implied(0, `ira_${k}`, lbl("Roth IRA contributions")) : noneSomeCents(`ira_${k}`, `roth_${k}`, lbl("Roth IRA contributions")),
      age50Plus: yn(`ira50_${k}`, lbl("age 50 or older at the end of 2025")),
      validSsn: yn(`ssn_${k}`, lbl("Social Security number valid for employment")),
      age55Plus: yn(`hsa55_${k}`, lbl("age 55 or older at the end of 2025")),
      hsaMedicareOrDependent: yn(`hsamed_${k}`, lbl("Medicare or dependent months")),
      hsaEligibleDec1: yn(`hsad1_${k}`, lbl("covered by the HDHP on December 1, 2025")),
      hsaEmployerOtherYear: yn(`hsaemp_${k}`, lbl("employer HSA contributions for another year")),
    };
    // HSA coverage
    if (hsaC === null) p.hsaCoverage = missing();
    else if (hsaC === "unsure") p.hsaCoverage = unsure(`hsa_${k}`, lbl("HDHP coverage"));
    else if (hsaC === "none" || hsaC === "self_only" || hsaC === "family" || hsaC === "changed") p.hsaCoverage = leaf(hsaC, `hsa_${k}`, lbl("HDHP coverage"));
    const months = cents(`hsam_${k}`);
    p.hsaMonthsEligible = months === null ? missing() : months === "unsure" ? unsure(`hsam_${k}`, lbl("months of HDHP coverage")) : leaf(months, `hsam_${k}`, lbl("months of HDHP coverage"));
    const direct = cents(`hsadir_${k}`);
    p.hsaDirectContributionsCents = direct === null ? missing() : direct === "unsure" ? unsure(`hsadir_${k}`, lbl("direct HSA contributions")) : leaf(direct, `hsadir_${k}`, lbl("direct HSA contributions"));
    const distC = choice(`hsadist_${k}`);
    p.hsaDistributions = distC === null ? missing() : distC === "unsure" ? unsure(`hsadist_${k}`, lbl("HSA distributions")) : leaf(distC === "some" ? "some" : "none", `hsadist_${k}`, lbl("HSA distributions"));
    // tips and overtime
    if (tipsC === null) p.tipsChoice = missing();
    else if (tipsC === "unsure") p.tipsChoice = unsure(`tips_${k}`, lbl("tips"));
    else if (tipsC === "some" || tipsC === "ask_employer" || tipsC === "none") p.tipsChoice = leaf(tipsC, `tips_${k}`, lbl("tips"));
    const tipsAmt = cents(`tipsamt_${k}`);
    p.tipsCents = tipsAmt === null ? missing() : tipsAmt === "unsure" ? unsure(`tipsamt_${k}`, lbl("qualified tips amount")) : leaf(tipsAmt, `tipsamt_${k}`, lbl("qualified tips amount"));
    if (otC === null) p.overtimeChoice = missing();
    else if (otC === "unsure") p.overtimeChoice = unsure(`ot_${k}`, lbl("overtime"));
    else if (otC === "premium" || otC === "total" || otC === "ask_employer" || otC === "none") p.overtimeChoice = leaf(otC, `ot_${k}`, lbl("overtime"));
    const otAmt = cents(`otamt_${k}`);
    p.overtimeCents = otAmt === null ? missing() : otAmt === "unsure" ? unsure(`otamt_${k}`, lbl("overtime amount")) : leaf(otAmt, `otamt_${k}`, lbl("overtime amount"));
    return p;
  });

  // ── household ───────────────────────────────────────────────────────────────
  const ra = out.returnAnswers;
  ra.people = personAnswers;
  const noContributions = RC_PERSONS.every((P) => choice(`def_${P.key}`) === "none" && choice(`ira_${P.key}`) === "none");
  ra.retirementDistributionSince2022 = noContributions && choice("rdist") === null ? implied(false, "rdist", "No retirement contributions, so no distribution reduces them") : yn("rdist", "Retirement distribution since 2022");
  ra.studentOrDependent = noContributions && choice("student") === null ? implied(false, "student", "No retirement contributions, so the student / dependent test is not needed") : yn("student", "Student or dependent");
  {
    const c = choice("pr");
    ra.magiExclusionsNone = c === null ? missing() : c === "unsure" ? unsure("pr", "Puerto Rico / Form 2555 / Form 4563 exclusions") : leaf(c === "no", "pr", "No Puerto Rico / Form 2555 / Form 4563 exclusions");
  }
  {
    const c = choice("car");
    ra.carLoan.choice = c === null ? missing() : c === "unsure" ? unsure("car", "New vehicle loan") : leaf(c === "some" ? "some" : "none", "car", "New vehicle loan");
    ra.carLoan.qualifies = yn("carq", "Vehicle and loan meet every condition");
    const paid = cents("carint");
    ra.carLoan.interestPaidCents = paid === null ? missing() : paid === "unsure" ? unsure("carint", "Car-loan interest") : leaf(paid, "carint", "Car-loan interest");
    const els = cents("carelse");
    ra.carLoan.deductedElsewhereCents = els === null ? missing() : els === "unsure" ? unsure("carelse", "Car-loan interest deducted elsewhere") : leaf(els, "carelse", "Car-loan interest deducted elsewhere");
  }
  ra.attestations.digitalAssets = yn("digital", "Digital assets (Form 1040 page 1 question)");
  ra.attestations.foreignAccounts = yn("foreign", "Foreign accounts and trusts (Schedule B Part III)");
  ra.priorYear.filedJoint = yn("pyjoint", "2024 return was joint");
  ra.priorYear.hadExcludedTaxOrRefundable = yn("pyextra", "2024 return had a refundable credit or a Schedule 2 tax for unreported tips (lines 5-7, 13)");
  {
    const c = choice("ut");
    ra.useTax.choice = c === null ? missing() : c === "unsure" ? unsure("ut", "Out-of-state purchases") : leaf(c === "some" ? "some" : "none", "ut", "Out-of-state purchases");
    const buy = cents("utbuy");
    ra.useTax.generalRatePurchasesCents = buy === null ? missing() : buy === "unsure" ? unsure("utbuy", "Use tax purchases") : leaf(buy, "utbuy", "Use tax purchases");
    ra.useTax.otherRateItems = yn("utother", "Items at a special use tax rate");
    const untaxed = cents("utbuy2");
    ra.useTax.untaxedPurchasesCents = untaxed === null ? missing() : untaxed === "unsure" ? unsure("utbuy2", "Untaxed purchases") : leaf(untaxed, "utbuy2", "Untaxed purchases");
    const paidTax = cents("uttax");
    ra.useTax.taxPaidToOtherStateCents = paidTax === null ? missing() : paidTax === "unsure" ? unsure("uttax", "Tax paid to another state") : leaf(paidTax, "uttax", "Tax paid to another state");
  }

  // ── "stated none" statements and the optional amounts ──────────────────────
  for (const g of NONE_GROUP_IDS) {
    const c = choice(`g_${g}`);
    if (c === "none") out.statedNone[g] = true;
    else if (c === "some") {
      out.statedNone[g] = false;
      const a = cents(`ga_${g}`);
      if (typeof a === "number") ra.statedSomeAmounts[g] = leaf(a, `ga_${g}`, `Estimated amount: ${g}`);
    }
  }

  // ── payments ────────────────────────────────────────────────────────────────
  const estimates = (gate: "fe" | "ce"): EstimatedPayment[] | undefined => {
    const c = choice(gate);
    if (c === "none") return [];
    if (c !== "some") return undefined;
    const list: EstimatedPayment[] = [];
    for (const w of RC_PAYMENT_WINDOWS) {
      const a = cents(`${gate}${w.n}`);
      if (typeof a !== "number") return undefined; // an unanswered window: the whole list is not yet known
      if (a > 0) list.push({ paidOn: w.date, amountCents: a, appliesToTaxYear: 2025 });
    }
    return list;
  };
  const fe = estimates("fe");
  if (fe !== undefined) out.federalEstimates = fe;
  const ce = estimates("ce");
  if (ce !== undefined) out.ctEstimates = ce;
  const stated = (gate: string, amountId: string): number | undefined => {
    const c = choice(gate);
    if (c === "none") return 0;
    if (c !== "some") return undefined;
    const a = cents(amountId);
    return typeof a === "number" ? a : undefined;
  };
  /** yes / no gate + amount: no -> 0, yes -> the amount, not sure / unanswered -> undefined. */
  const yesNoAmount = (gate: string, amountId: string): number | undefined => {
    const c = choice(gate);
    if (c === "no") return 0;
    if (c !== "yes") return undefined;
    const a = cents(amountId);
    return typeof a === "number" ? a : undefined;
  };
  const fext = stated("fext", "fextamt");
  if (fext !== undefined) out.federalExtensionPaymentCents = fext;
  const cext = stated("cext", "cextamt");
  if (cext !== undefined) out.ctExtensionPaymentCents = cext;
  const fov = stated("fov", "fovamt");
  if (fov !== undefined) out.federalOverpaymentAppliedCents = fov;
  const cov = stated("cov", "covamt");
  if (cov !== undefined) out.ctOverpaymentAppliedCents = cov;
  const sehi = yesNoAmount("sehi", "sehiamt");
  if (sehi !== undefined) out.seHealthInsuranceCents = sehi;
  const serp = yesNoAmount("serp", "serpamt");
  if (serp !== undefined) out.seRetirementCents = serp;
  const cpy = stated("cpy", "cpyamt");
  if (cpy !== undefined) out.ctPriorYearBalancePaidIn2025Cents = cpy;
  return out;
}
