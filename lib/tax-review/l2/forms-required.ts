// L2 oracle: which forms the return needs, recomputed from the recalculated lines and compared with `formsRequired` (the engine's packet plan).
// Each predicate is written from the form's own "who must file" text or its line logic; a form whose inputs the oracle could not produce is
// not predicted (null), never assumed. Pure.

import { K } from "@/lib/tax2025/constants";
import type { Ty2025Return } from "@/lib/tax2025/types";
import type { Ledger } from "@/lib/tax-review/l2/ledger";
import type { Maybe } from "@/lib/tax-review/l2/money";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

export interface FormPrediction {
  /** The engine's FormId. */
  form: string;
  label: string;
  required: Maybe<boolean>;
  why: string;
}

export function predictForms(L: Ledger): FormPrediction[] {
  const v = (k: string): Maybe<number> => L.get(k);
  const out: FormPrediction[] = [];
  const add = (form: string, label: string, required: Maybe<boolean>, why: string): void => {
    out.push({ form, label, required, why });
  };
  const interest = v("schb.2");
  const dividends = v("schb.6");
  add(
    "schb",
    "Schedule B",
    interest === null || dividends === null ? null : interest > K.SCH_B_THRESHOLD.value || dividends > K.SCH_B_THRESHOLD.value,
    `taxable interest and ordinary dividends are tested against $${K.SCH_B_THRESHOLD.value.toLocaleString("en-US")} each`
  );
  add("schse", "Schedule SE", v("se.12") === null ? null : L.lines.has("se.6"), "net earnings from self-employment of $400 or more");
  add("f8959", "Form 8959", v("sch2.11") === null ? null : L.lines.has("f8959.18"), "Medicare wages over $200,000 on one W-2, or wages plus self-employment income over the threshold");
  const niit = v("f8960.niit");
  add("f8960", "Form 8960", niit === null ? null : niit > 0 || ((v("f8960.15") ?? 0) > 0 && (v("f8960.nii") ?? 0) > 0), "investment income and modified AGI over the threshold");
  add("schd", "Schedule D", L.lines.has("schd.16") ? true : v("f1040.7a") === null ? null : false, "capital transactions or a capital loss carryover");
  const itemized = v("scha.17");
  const standard = v("std.total");
  add("scha", "Schedule A", itemized === null || standard === null ? null : itemized > standard, "itemized deductions larger than the standard deduction");
  const sch1a = v("sch1a.38");
  add("sch1a", "Schedule 1-A", sch1a === null ? null : sch1a > 0, "a tips, overtime, car loan interest or seniors deduction is claimed");
  add("f8949", "Form 8949", [...L.lines.keys()].some((k) => /^schd\.(1b|2|3|8b|9|10)\./.test(k)) ? true : L.lines.has("schd.16") ? false : v("f1040.7a") === null ? null : false, "a sales category reported through a Form 8949 summary row");
  const l31 = v("schc.31");
  add("f8606", "Form 8606", L.formHints["f8606"] ?? null, "a traditional IRA contribution larger than the IRA deduction on Schedule 1 line 20 (the rest is nondeductible; one Form 8606 per person)");
  add("schc", "Schedule C", l31 === null ? null : (v("schc.1") ?? 0) !== 0 || (v("schc.28") ?? 0) !== 0, "business income or expenses");
  const amt = v("f6251.amt");
  add("f6251", "Form 6251", amt === null ? null : amt > 0, "alternative minimum tax is owed");
  const qbi = v("f1040.13a");
  // Form 8995 is also where a qualified business loss is carried to the next year (lines 16 and 17: "Combine lines 2 and 3 ... if greater than zero, enter 0")
  // and where a loss carried in is used (lines 3 and 7), so a loss-only year or a non-zero carry-in needs the form without any deduction (Instructions for Form 8995).
  const lossOut = (v("f8995.16") ?? 0) < 0 || (v("f8995.17") ?? 0) < 0;
  const lossIn = (v("f8995.3") ?? 0) !== 0 || (v("f8995.7") ?? 0) !== 0;
  add("f8995", "Form 8995", qbi === null ? null : qbi > 0 || lossOut || lossIn, "a qualified business income deduction is claimed, or a qualified business loss is carried to 2026 (lines 16 / 17) or was carried in (lines 3 / 7)");
  return out;
}

export interface FormsDiff {
  checked: number;
  differing: number;
  findings: Finding[];
}

/** Compares the predictions with `ret.formsRequired` ("blocking" means the return cannot tell yet and is not compared). */
export function diffForms(L: Ledger, ret: Ty2025Return): FormsDiff {
  let checked = 0;
  const findings: Finding[] = [];
  for (const p of predictForms(L)) {
    if (p.required === null) continue;
    const theirs = ret.formsRequired[p.form as keyof typeof ret.formsRequired]?.required;
    if (theirs === "blocking") continue;
    checked += 1;
    const engine = theirs === true;
    if (engine === p.required) continue;
    findings.push(
      makeFinding({
        layer: "L2",
        check: `L2.forms.${p.form}`,
        severity: "medium",
        area: "forms",
        formKey: p.form,
        message: `Independent recalculation: the return says ${p.label} is ${engine ? "required" : "not required"}, but recomputing from the same facts says it is ${p.required ? "required" : "not required"} (${p.why}).`,
        recommendedAction: "Check which forms belong in the package; accept with a written reason if the recalculation is the one that is off.",
        acceptable: true,
      })
    );
  }
  return { checked, differing: findings.length, findings };
}
