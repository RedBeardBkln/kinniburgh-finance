// The judgments register (ai-return-reviewer, B3 / B5; plan 5.6): every decision that used to go to "the CPA" is now listed as a
// decision for Eric, with a recommended position, the alternative, the source, the dollar impact the engine can actually compute,
// and who decides (Eric).
//
// The register is built DETERMINISTICALLY from the engine's own state (decisions X1/X2/X3/X5 with their alternatives, every rule
// that returned "needs your decision" or "rule not verified", every answer the owner gave as "not sure", every informational line,
// and the specs/09 "Not verified" items the return touches). The AI pass (e2) may only NARRATE entries that already exist (better
// wording for the recommended position and the alternative); it cannot add, remove or re-price an entry, and an invented dollar
// figure in its text is rejected by the validator. Dollar impact comes ONLY from the engine's alternative effect amounts (deduction
// size) or, once the independent recomputation exists, from its counterfactual tax deltas (an optional input, never invented).
//
// PURE.

import { ownerWording } from "@/lib/tax-wording";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { roundCentsHalfUp } from "@/lib/tax-review/l1/helpers";

export type RegisterOrigin = "decision" | "rule_judgment" | "rule_unverified" | "owner_unsure" | "informational" | "unverified_law";
export type RegisterStatus = "undecided" | "decided" | "noted";

export interface RegisterSource {
  kind: "constant" | "spec09" | "engine" | "source_pack";
  id: string;
  /** Present when the source is a pack quote that verified. */
  quote?: string;
  verified: boolean;
}

export interface RegisterDollarImpact {
  /** Whole dollars, or null = "not quantified". */
  amountDollars: number | null;
  note: string;
}

export interface RegisterEntry {
  id: string;
  topic: string;
  origin: RegisterOrigin;
  recommendedPosition: string;
  alternative: string | null;
  rationale: string | null;
  sources: RegisterSource[];
  dollarImpact: RegisterDollarImpact;
  whoDecides: "Eric";
  status: RegisterStatus;
  /** true = the wording came from the AI pass (validated); false = the engine's own text. */
  narrated: boolean;
  where: string;
}

/** Optional exact tax deltas from the independent recomputation (L2): decision id -> { alternative id -> tax delta in whole dollars }. */
export type Counterfactuals = Readonly<Record<string, Readonly<Record<string, number>>>>;

const clip = (s: string, n: number): string => ownerWording(s).replace(/\s+/g, " ").trim().slice(0, n);
const fmt = (n: number): string => `$${Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

const NOT_QUANTIFIED = "not quantified: the engine does not compute the tax effect of this choice";

const SPEC09_ITEMS: ReadonlyArray<{ id: string; topic: string; position: string; touched: (f: Ty2025Facts, r: Ty2025Return) => boolean }> = [
  {
    id: "charitable_agi_limits",
    topic: "Charitable gifts above 20% of AGI (the 60% / 30% limits were not verified)",
    position: "The return deducts gifts only up to 20% of AGI, the lowest limit that can apply. If your gifts are larger, check the AGI limits in Publication 526 yourself.",
    touched: (f) => f.deductions.donations.length > 0,
  },
  {
    id: "mortgage_points",
    topic: "Points shown on a Form 1098 (box 6)",
    position: "Whether points are deductible in full in the year paid depends on tests a Form 1098 cannot show. Decide from Publication 936.",
    touched: (f) => f.deductions.mortgages.some((m) => (m.pointsCents ?? 0) > 0),
  },
  {
    id: "ct_ss_pension_worksheets",
    topic: "Connecticut Social Security benefit and pension / annuity worksheets",
    position: "These worksheets are not built. If you had Social Security benefits or a pension or annuity, complete them from the CT-1040 instructions.",
    touched: (f) => f.income.otherIncomeBoxes.some((b) => /1099-r|ssa/i.test(b.variant)),
  },
  {
    id: "home_office_actual_and_depreciation",
    topic: "Home office actual method (Form 8829) and depreciation",
    position: "The engine computes the simplified method only. The actual method and depreciation need your decision (see decisions X1 and X2).",
    touched: (f) => f.income.scheduleC.homeOfficeEligibility.value !== null && f.income.scheduleC.homeOfficeEligibility.value !== "no",
  },
  {
    id: "se_health_insurance_eligibility",
    topic: "Self-employed health insurance eligibility (Form 7206)",
    position: "You stated an amount for self-employed health insurance; confirm you are eligible (not eligible for an employer plan) before keeping it.",
    touched: (f) => (f.adjustments.seHealthInsurance.value ?? 0) > 0,
  },
  {
    id: "form_2210_annualized",
    topic: "Underpayment penalty: annualized income method and waivers",
    position: "The engine does not compute the annualized income installment method (Schedule AI) or waivers. If a penalty applies, check whether either lowers it.",
    touched: (_f, r) => r.formsRequired.f2210?.required === true,
  },
];

function decisionEntries(ret: Ty2025Return, counterfactuals: Counterfactuals | undefined): RegisterEntry[] {
  return ret.decisions.map((d): RegisterEntry => {
    const result = ret.results.find((r) => r.decision?.id === d.id);
    const alts = result?.alternatives ?? [];
    const def = alts.find((a) => a.isDefault);
    const inForce = alts.find((a) => a.inForce);
    const others = alts.filter((a) => a !== inForce);
    const decided = d.status === "decided";
    const position = decided
      ? `Recorded choice: ${inForce?.label ?? d.chosen}.`
      : `Use the conservative default until you decide: ${def?.label ?? d.chosen}.`;
    const alternative = others.length === 0 ? null : others.map((a) => a.label).join("; ");
    const amounts = alts.filter((a) => a.effect?.amount !== null && a.effect?.amount !== undefined).map((a) => ({ label: a.label, amount: Number((a.effect?.amount ?? 0).toString()) }));
    const cf = counterfactuals?.[d.id];
    let impact: RegisterDollarImpact = { amountDollars: null, note: NOT_QUANTIFIED };
    if (cf !== undefined && Object.keys(cf).length > 0) {
      const best = Object.entries(cf).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      if (best !== undefined) impact = { amountDollars: Math.abs(best[1]), note: `tax difference between the choices per the independent recomputation (${fmt(best[1])})` };
    } else if (amounts.length >= 2) {
      const hi = Math.max(...amounts.map((a) => a.amount));
      const lo = Math.min(...amounts.map((a) => a.amount));
      impact = { amountDollars: Math.round(hi - lo), note: `deduction size: ${amounts.map((a) => `${a.label} ${fmt(a.amount)}`).join(" vs ")}; the tax effect is not computed` };
    }
    return {
      id: `decision:${d.id}`,
      topic: clip(d.label, 140),
      origin: "decision",
      recommendedPosition: clip(position, 300),
      alternative: alternative === null ? null : clip(alternative, 300),
      rationale: result === undefined ? null : clip(result.reasons[0] ?? "", 400) || null,
      sources: [...(result?.citations ?? []).map((c): RegisterSource => ({ kind: "constant", id: c, verified: true })), { kind: "engine", id: `decision ${d.id}`, verified: true }],
      dollarImpact: impact,
      whoDecides: "Eric",
      status: decided ? "decided" : "undecided",
      narrated: false,
      where: "Forms page: record the decision",
    };
  });
}

function ruleEntries(ret: Ty2025Return): RegisterEntry[] {
  const out: RegisterEntry[] = [];
  for (const r of ret.results) {
    if (r.decision !== undefined) continue; // listed as a decision
    const judgment = r.status === "needs_cpa_judgment";
    const unverified = r.status === "needs_cpa_rule_unverified";
    if (!judgment && !unverified) continue;
    out.push({
      id: `rule:${r.ruleId}`,
      topic: clip(`${r.form}: ${r.ruleId}`, 140),
      origin: judgment ? "rule_judgment" : "rule_unverified",
      recommendedPosition: clip(r.reasons[0] ?? (judgment ? "This needs your decision." : "The rule could not be verified from a primary source."), 300),
      alternative: null,
      rationale: r.reasons.length > 1 ? clip(r.reasons.slice(1, 3).join(" "), 400) : null,
      sources: [...r.citations.map((c): RegisterSource => ({ kind: "constant", id: c, verified: true })), { kind: "engine", id: r.ruleId, verified: true }],
      dollarImpact: { amountDollars: null, note: NOT_QUANTIFIED },
      whoDecides: "Eric",
      status: "undecided",
      narrated: false,
      where: `${r.form}`,
    });
  }
  return out;
}

interface SourcedLike {
  value: unknown;
  basis: string | null;
  refs: unknown;
}

function isSourcedLeaf(v: unknown): v is SourcedLike {
  return v !== null && typeof v === "object" && "value" in v && "basis" in v && "refs" in v;
}

function walkUnsure(node: unknown, path: string, out: string[]): void {
  if (isSourcedLeaf(node)) {
    if (node.value === null && node.basis === "answer_owner") out.push(path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      const slot = v !== null && typeof v === "object" && "slot" in v ? String((v as { slot: unknown }).slot) : String(i);
      walkUnsure(v, `${path}[${slot}]`, out);
    });
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walkUnsure(v, path === "" ? k : `${path}.${k}`, out);
  }
}

function humanPath(path: string): string {
  return path
    .replace(/people\[a\]/, "first person")
    .replace(/people\[b\]/, "second person")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .toLowerCase();
}

function unsureEntries(facts: Ty2025Facts): RegisterEntry[] {
  const paths: string[] = [];
  walkUnsure(facts.returnAnswers, "", paths);
  return paths.map((p): RegisterEntry => ({
    id: `answer:${p}`,
    topic: clip(`You answered "not sure": ${humanPath(p)}`, 140),
    origin: "owner_unsure",
    recommendedPosition: "Find out and answer it in the Return completeness questions; the return stays blocked on this line until you do.",
    alternative: null,
    rationale: null,
    sources: [{ kind: "engine", id: `answer ${p}`, verified: true }],
    dollarImpact: { amountDollars: null, note: NOT_QUANTIFIED },
    whoDecides: "Eric",
    status: "undecided",
    narrated: false,
    where: "Return completeness questions",
  }));
}

function informationalEntries(ret: Ty2025Return): RegisterEntry[] {
  const out: RegisterEntry[] = [];
  for (const line of Object.values(ret.lines)) {
    if (line === undefined || line.informational !== true) continue;
    out.push({
      id: `info:${line.key}`,
      topic: clip(`${line.form} line ${line.formLine}: ${line.label}`, 140),
      origin: "informational",
      recommendedPosition: clip(line.reason ?? "This line is deliberately not estimated; the IRS or Connecticut figures it if it applies.", 300),
      alternative: null,
      rationale: null,
      sources: [{ kind: "engine", id: line.key, verified: true }],
      dollarImpact: { amountDollars: null, note: NOT_QUANTIFIED },
      whoDecides: "Eric",
      status: "noted",
      narrated: false,
      where: `${line.form} line ${line.formLine}`,
    });
  }
  return out;
}

function unverifiedLawEntries(facts: Ty2025Facts, ret: Ty2025Return): RegisterEntry[] {
  return SPEC09_ITEMS.filter((i) => i.touched(facts, ret)).map(
    (i): RegisterEntry => ({
      id: `spec09:${i.id}`,
      topic: i.topic,
      origin: "unverified_law",
      recommendedPosition: i.position,
      alternative: null,
      rationale: null,
      sources: [{ kind: "spec09", id: `specs/09 "Not verified": ${i.id}`, verified: false }],
      dollarImpact: { amountDollars: null, note: NOT_QUANTIFIED },
      whoDecides: "Eric",
      status: "undecided",
      narrated: false,
      where: "Not verified in specs/09",
    })
  );
}

/** The deterministic register. Stable order: decisions, rules, answers, informational lines, unverified-law items. */
export function buildRegister(input: { ret: Ty2025Return; facts: Ty2025Facts; counterfactuals?: Counterfactuals }): RegisterEntry[] {
  return [
    ...decisionEntries(input.ret, input.counterfactuals),
    ...ruleEntries(input.ret),
    ...unsureEntries(input.facts),
    ...informationalEntries(input.ret),
    ...unverifiedLawEntries(input.facts, input.ret),
  ];
}

/** Dollars helper for callers that show an amount from cents. */
export function centsToDollars(cents: number): number {
  return roundCentsHalfUp(cents);
}

/** Entries ordered by dollar impact (largest first, "not quantified" last): what to look at first. */
export function byImpact(entries: readonly RegisterEntry[]): RegisterEntry[] {
  return [...entries].sort((a, b) => (b.dollarImpact.amountDollars ?? -1) - (a.dollarImpact.amountDollars ?? -1) || a.id.localeCompare(b.id));
}
