// L1.B4: checkbox / answer agreement (plan section 5.3).
//   (a) every checkbox and answer-text field of every PDF equals the answer the view holds for it;
//   (b) the answers the view holds (filing status, digital assets, foreign accounts, Schedule D "not required", the QOF box)
//       are re-derived here from the engine's return and facts (NOT from the adapter), and must agree;
//   (c) exactly one filing-status box is checked on Form 1040, and it is married filing jointly (the only status this return
//       is computed for);
//   (d) the Form 1040 line 7b "Schedule D not required" box is checked only when Exception 1 really applies.

import { safeText } from "@/lib/tax2025/pdf/safe-text";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { bindFiles, evidenceRefForField, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";

type Answers = Readonly<Record<string, string | boolean | null | undefined>>;

function mismatch(check: string, ruleTag: string, message: string, ref: string, status: string, action = "Do not file this PDF. Fix the source answer, rebuild the packet and run the review again."): Finding {
  return makeFinding({
    layer: "L1",
    check,
    severity: "blocker",
    area: "forms",
    ruleTag,
    message,
    evidence: [{ ref, amount: null, status }],
    recommendedAction: action,
    acceptable: false,
  });
}

/** The answers the engine's own return supports, derived independently of the adapter. */
export function derivedAnswers(ctx: Pick<L1Context, "ret" | "facts">): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  const att = ctx.ret.attestations;
  out["filingStatus"] = ctx.ret.filingStatus;
  out["digitalAssets"] = att.digitalAssets.status === "answered" && att.digitalAssets.value !== null ? (att.digitalAssets.value ? "yes" : "no") : undefined;
  const fa = att.foreignAccounts;
  const foreignNo = fa.status === "answered" && fa.value === false;
  out["foreignAccounts"] = foreignNo ? "no" : undefined;
  out["foreignTrust"] = foreignNo ? "no" : undefined;
  out["fincenRequired"] = foreignNo ? "no" : undefined;
  const sd = ctx.ret.scheduleD;
  out["schdNotRequired"] = sd ? sd.exception1 && !sd.boxes2b2dUnconfirmed : undefined;
  out["schd.qof"] = ctx.facts.statedNone["capital_special_rates"]?.value === true ? "no" : undefined;
  return out;
}

export const pdfAnswersCheck: L1Check = {
  id: "L1.B4",
  description: "Checkboxes and answers match the return (filing status, digital assets, foreign accounts, Schedule D boxes)",
  async run(ctx: L1Context): Promise<Finding[]> {
    const out: Finding[] = [];
    // (b) the view's answers against the engine
    const want = derivedAnswers(ctx);
    for (const [key, expected] of Object.entries(want)) {
      const have = (ctx.view.answers as Answers)[key];
      const normalisedHave = have === null ? undefined : have;
      if (normalisedHave !== expected) {
        out.push(
          mismatch(
            "L1.B4.answer",
            key,
            key === "filingStatus"
              ? `The filing status on the forms is "${String(have)}" but the return is computed as "${String(expected)}". Every figure on the return depends on it.`
              : `The answer "${key}" printed on the forms (${have === undefined ? "none" : String(have)}) does not match what the return supports (${expected === undefined ? "none" : String(expected)}).`,
            `check:answer.${key}`,
            have === undefined ? "none" : String(have)
          )
        );
      }
    }
    // (a) + (c) + (d) the PDFs
    const files = ctx.read ?? (await readPacketFiles(ctx.packet.files));
    for (const { file, map, view } of bindFiles(ctx, files)) {
      if (map === null || view === null) continue;
      const answers = view.answers as Answers;
      for (const entry of map.lines) {
        if (entry.kind === "check") {
          const answer = answers[entry.choice];
          const shouldCheck = answer !== undefined && answer !== null && answer === entry.equals;
          const printed = file.fields.get(entry.field) === true;
          if (shouldCheck !== printed) {
            out.push(
              mismatch(
                "L1.B4.box",
                `${file.name}|${entry.field}`,
                `${file.name}: the "${entry.label ?? entry.choice}" box is ${printed ? "checked" : "not checked"} but the answer says it should be ${shouldCheck ? "checked" : "unchecked"}.`,
                evidenceRefForField(file.formId, entry.field),
                printed ? "checked" : "unchecked"
              )
            );
          }
        } else if (entry.kind === "text") {
          const answer = answers[entry.answer];
          const wantText = typeof answer === "string" ? safeText(answer).text.trim() : "";
          const got = file.fields.get(entry.field);
          const gotText = typeof got === "string" ? got.trim() : "";
          if (wantText !== gotText) {
            out.push(mismatch("L1.B4.text", `${file.name}|${entry.field}`, `${file.name}: the "${entry.label ?? entry.answer}" entry does not match the answer.`, evidenceRefForField(file.formId, entry.field), gotText === "" ? "blank" : "printed"));
          }
        }
      }
      // (c) one filing-status box, and it is MFJ
      const statusBoxes = map.lines.filter((l) => l.kind === "check" && l.choice === "filingStatus");
      if (statusBoxes.length > 0) {
        const checked = statusBoxes.filter((b) => b.kind === "check" && file.fields.get(b.field) === true);
        const onlyMfj = checked.length === 1 && checked[0]?.kind === "check" && checked[0].equals === "mfj";
        if (!onlyMfj) {
          out.push(
            mismatch(
              "L1.B4.filing-status",
              file.name,
              `${file.name}: ${checked.length === 0 ? "no filing status box is checked" : checked.length > 1 ? `${checked.length} filing status boxes are checked` : "the box checked is not married filing jointly"}. This return is computed for married filing jointly only.`,
              `form:${file.formId}`,
              `${checked.length} checked`
            )
          );
        }
      }
    }
    return out;
  },
};
