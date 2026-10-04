// Card-level conclusions for the Forms page (Phase 1c). The Forms page keeps its
// "Needs your input" cards and their questionnaire links; where the TY2025 engine now
// COMPUTES the card's subject (home office, QBI, Additional Medicare Tax, Form 8889,
// Form 8880, Form 2210, Schedule 3, Schedule SE, the child / dependent credits) this
// module turns the engine's verdict into one sentence the card can print, e.g.
// "Computed: Form 8959 not required - Form 8959 is not required (below the ...)".
//
// PURE and read-only. It never touches the card counters (lib/tax-forms.ts owns
// those); it only produces text keyed by the card id.

import {
  hasAmount,
  type FormId,
  type LineKey,
  type RuleStatus,
  type Ty2025Return,
} from "@/lib/tax2025/types";
import { formatSheetMoney, scheduleCUnanswered } from "@/lib/tax2025-sheet";
import { ownerWordingDeep } from "@/lib/tax-wording";

export type ConclusionTone = "computed" | "not_required" | "blocked";

export interface CardConclusion {
  tone: ConclusionTone;
  text: string;
}

function amountOf(ret: Ty2025Return, key: LineKey): number | null {
  const l = ret.lines[key];
  return l !== undefined && hasAmount(l.status) ? l.amount : null;
}

function statusOf(ret: Ty2025Return, key: LineKey): RuleStatus | null {
  return ret.lines[key]?.status ?? null;
}

function reasonOf(ret: Ty2025Return, key: LineKey): string {
  return ret.lines[key]?.reason ?? "inputs are missing";
}

function money(n: number | null): string {
  return n === null ? "not computed" : formatSheetMoney(n);
}

/** Verdict from ret.formsRequired plus an amount clause, in one sentence. */
function formVerdict(ret: Ty2025Return, form: FormId, formName: string, amountClause: () => string): CardConclusion {
  const req = ret.formsRequired[form];
  if (req === undefined) return { tone: "blocked", text: `Not computed: the engine has no verdict for ${formName} yet.` };
  if (req.required === "blocking") return { tone: "blocked", text: `Not final: ${req.reason}` };
  if (req.required === false) return { tone: "not_required", text: `Computed: ${formName} not required - ${req.reason}` };
  const clause = amountClause();
  return { tone: "computed", text: `Computed: ${formName} required - ${req.reason}${clause === "" ? "" : ` ${clause}`}` };
}

/** Conclusion from one line's own status when no form verdict applies. */
function lineVerdict(ret: Ty2025Return, key: LineKey, noun: string, clause: (amount: number) => string): CardConclusion {
  const l = ret.lines[key];
  if (l === undefined) return { tone: "blocked", text: `Not computed: ${noun} is not on the return yet.` };
  if (hasAmount(l.status) && l.amount !== null) {
    return { tone: l.status === "not_applicable" ? "not_required" : "computed", text: `Computed: ${clause(l.amount)}` };
  }
  return { tone: "blocked", text: `Not final (${l.status.replace(/_/g, " ")}): ${reasonOf(ret, key)}` };
}

/**
 * Conclusions keyed by the Forms page card id (lib/tax-forms.ts). Cards the engine does
 * not compute are simply absent.
 */
export function buildCardConclusions(ret: Ty2025Return): Record<string, CardConclusion> {
  // Engine reasons are quoted in the verdict text and may still say "the CPA decides": reword at this boundary.
  return ownerWordingDeep(buildCardConclusionsRaw(ret));
}

function buildCardConclusionsRaw(ret: Ty2025Return): Record<string, CardConclusion> {
  const out: Record<string, CardConclusion> = {};

  out["additional-medicare-tax"] = formVerdict(ret, "f8959", "Form 8959", () => {
    const tax = amountOf(ret, "sch2.11");
    const withheld = amountOf(ret, "f1040.25c");
    return `Additional Medicare Tax ${money(tax)} (Schedule 2 line 11); ${money(withheld)} already withheld (Form 1040 line 25c).`;
  });

  out["qbi-deduction"] = formVerdict(ret, "f8995", "Form 8995", () => `Qualified business income deduction ${money(amountOf(ret, "f1040.13a"))} (Form 1040 line 13a).`);
  if (statusOf(ret, "f1040.13a") === "needs_cpa_judgment") {
    out["qbi-deduction"] = { tone: "blocked", text: `Needs your decision (Form 8995 versus 8995-A): ${reasonOf(ret, "f1040.13a")}` };
  }

  out["form-8889"] = formVerdict(ret, "f8889", "Form 8889", () => `HSA deduction ${money(amountOf(ret, "sch1.13"))} (Schedule 1 line 13).`);
  out["form-8880"] = formVerdict(ret, "f8880", "Form 8880", () => `Saver's credit ${money(amountOf(ret, "sch3.4"))} (Schedule 3 line 4).`);

  // Form 2210: "Computed" only when the regular-method estimate itself is computed; the verdict "not required" is an
  // engine constant (the IRS figures the penalty), so with no estimate the card says "Not computed".
  const pen = amountOf(ret, "f2210.19");
  const req2210 = ret.formsRequired.f2210;
  if (req2210 === undefined) {
    out["form-2210"] = { tone: "blocked", text: "Not computed: the engine has no Form 2210 verdict yet." };
  } else if (pen !== null) {
    out["form-2210"] = { tone: "not_required", text: `Computed: Form 2210 not required - ${req2210.reason}` };
  } else {
    out["form-2210"] = {
      tone: "blocked",
      text: `Not computed: the regular-method estimate is not available (${reasonOf(ret, "f2210.19")}). ${req2210.reason}`,
    };
  }

  out["schedule-3-federal"] = formVerdict(
    ret,
    "sch3",
    "Schedule 3",
    () => `Nonrefundable credits ${money(amountOf(ret, "sch3.8"))} (line 8); other payments and refundable credits ${money(amountOf(ret, "sch3.15"))} (line 15).`
  );

  out["schedule-se"] = formVerdict(ret, "schse", "Schedule SE", () => `Self-employment tax ${money(amountOf(ret, "se.12"))} (line 12).`);

  const f8829 = ret.formsRequired.f8829;
  const c30 = ret.lines["schc.30"];
  const x1 = ret.decisions.find((d) => d.id === "X1");
  const open = scheduleCUnanswered(ret);
  if (open.homeOffice !== null) {
    out["form-8829"] = { tone: "blocked", text: `Not decided: the ${open.homeOffice} has not been answered, so it is not known whether a home office deduction (or Form 8829) applies.` };
  } else if (c30 !== undefined && c30.status === "not_applicable") {
    out["form-8829"] = { tone: "not_required", text: `Computed: Form 8829 not required - no home office deduction (Schedule C line 30 is ${money(c30.amount)}). ${f8829?.reason ?? ""}`.trim() };
  } else if (c30 !== undefined && c30.status === "computed") {
    const method = x1 === undefined ? "" : x1.status === "default_undecided" ? " (simplified method in force by default; decision X1 is undecided)" : ` (decision X1: ${x1.chosen})`;
    out["form-8829"] = { tone: "computed", text: `Computed: Schedule C line 30 is ${money(c30.amount)}${method}. ${f8829?.reason ?? ""}`.trim() };
  } else {
    out["form-8829"] = { tone: "blocked", text: `Not computed: Schedule C line 30 (home office) - ${c30 === undefined ? "the line is not on the return" : reasonOf(ret, "schc.30")}` };
  }

  const f4562 = ret.formsRequired.f4562;
  if (open.fixedAssets !== null) {
    out["form-4562"] = { tone: "blocked", text: `Not decided: the ${open.fixedAssets} has not been answered, so Form 4562 cannot be ruled out.` };
  } else if (f4562?.required === false) {
    out["form-4562"] = { tone: "not_required", text: `Computed: Form 4562 not required - ${f4562.reason}` };
  } else {
    out["form-4562"] = { tone: "blocked", text: `Not computed (owner decision X2): ${f4562?.reason ?? "the engine has no verdict."}` };
  }

  out["child-dependent-credits"] = lineVerdict(ret, "f1040.19", "the child tax credit and credit for other dependents", () => `${ret.lines["f1040.19"]?.reason ?? "no child or other-dependent credit."}`);

  return out;
}
