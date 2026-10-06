// L1.C2: double counting (plan section 5.3). The engine counts an exact duplicate document once and raises its own blocking
// item; this check looks for the ways the same money can still reach the return twice:
//   - two documents with the same type, year, payer and amounts (reported here independently of the engine);
//   - the same W-2 listed under both household members (the engine's duplicate key includes the person, so it cannot see it);
//   - the same estimated payment listed twice;
//   - interest on the business bank account (per the books) alongside a 1099-INT from the same bank: by design the engine adds
//     the books interest to Form 1040 line 2b, so this is shown as information with both numbers, never as an error.
//
// SERVER SIDE ONLY (reads the documents); findings carry document ids and amounts only.

import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { usd, roundCentsHalfUp } from "@/lib/tax-review/l1/helpers";
import { dataOf, docSignature, int, isUsableFor2025 } from "@/lib/tax-review/l1/source-docs";
import type { RawDocument } from "@/lib/tax2025/resolve-facts";

function groups(docs: readonly RawDocument[], ignorePerson: boolean, types: readonly string[]): RawDocument[][] {
  const bySig = new Map<string, RawDocument[]>();
  for (const d of docs) {
    if (!types.includes(d.docType) || !isUsableFor2025(d)) continue;
    const sig = docSignature(d, { ignorePerson });
    if (sig === null) continue;
    bySig.set(sig, [...(bySig.get(sig) ?? []), d]);
  }
  return [...bySig.values()].filter((g) => g.length > 1);
}

export const doubleCountCheck: L1Check = {
  id: "L1.C2",
  description: "Possible double counting: duplicate documents, a W-2 under both persons, a repeated estimated payment, books interest next to a 1099-INT",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const docs = ctx.raw?.documents ?? [];
    const seen = new Set<string>();
    const report = (g: RawDocument[], why: string, tag: string): void => {
      const ids = g.map((d) => d.id).sort();
      const key = ids.join("|");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(
        makeFinding({
          layer: "L1",
          check: `L1.C2.${tag}`,
          severity: "high",
          area: "income",
          ruleTag: key,
          message: `${g.length} documents of type ${g[0]?.docType ?? ""} look like the same form: ${why}. The return counts one of them once; if they are two real forms the second is missing, and if it is one form it must be archived.`,
          evidence: ids.slice(0, 6).map((id) => ({ ref: `doc:${id}`, amount: null, status: "possible duplicate" })),
          recommendedAction: "Open the documents and compare them with the paper. Archive the duplicate, or accept this finding with the reason both are genuine.",
          acceptable: true,
        })
      );
    };
    for (const g of groups(docs, false, ["w2", "1099", "mortgage_interest", "form_1098", "property_tax"])) report(g, "same issuer, year and amounts", "duplicate");
    // the same W-2 under two different persons
    for (const g of groups(docs, true, ["w2"])) {
      const persons = new Set(g.map((d) => d.subjectUserId ?? "none"));
      if (persons.size > 1) report(g, "the same W-2 is assigned to different people", "w2-both-persons");
    }
    // the same estimated payment twice
    for (const [name, v] of [["federal", ctx.facts.payments.federalEstimates.value], ["Connecticut", ctx.facts.payments.ctEstimates.value]] as const) {
      const sig = new Map<string, number>();
      for (const e of v ?? []) sig.set(`${e.paidOn}|${e.amountCents}|${e.appliesToTaxYear}`, (sig.get(`${e.paidOn}|${e.amountCents}|${e.appliesToTaxYear}`) ?? 0) + 1);
      const dup = [...sig.entries()].filter(([, n]) => n > 1);
      if (dup.length > 0) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.C2.estimate-repeat",
            severity: "high",
            area: "payments",
            ruleTag: name,
            message: `${dup.length} ${name} estimated payment(s) are listed more than once with the same date and amount, so the payments on the return may be counted twice.`,
            evidence: [{ ref: "check:estimates", amount: dup.length, status: `${name} repeated` }],
            recommendedAction: "Check each payment date and amount against your bank record; remove the repeat, or accept this finding if two equal payments were really made on one day.",
            acceptable: true,
          })
        );
      }
    }
    // books interest next to 1099-INT interest: information with both numbers
    const books = (ctx.ret.scheduleC?.booksInterest ?? []).reduce((n, b) => n + b.amountCents, 0);
    if (books > 0) {
      const int1099 = docs
        .filter((d) => d.docType === "1099" && isUsableFor2025(d))
        .reduce((n, d) => n + (int(dataOf(d)["int_box1Cents"]) ?? 0), 0);
      if (int1099 > 0) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.C2.books-interest",
            severity: "info",
            area: "income",
            message: `Taxable interest includes both 1099-INT interest (${usd(roundCentsHalfUp(int1099))}) and interest on the business bank account from EK Consulting's books (${usd(roundCentsHalfUp(books))}). The return adds both on purpose; make sure the business account does not also issue one of those 1099-INT forms.`,
            evidence: [{ ref: "check:books-interest", amount: roundCentsHalfUp(books), status: "books" }, { ref: "check:1099-interest", amount: roundCentsHalfUp(int1099), status: "documents" }],
            recommendedAction: "Confirm the business account's interest is not on a 1099-INT you also uploaded.",
            acceptable: true,
          })
        );
      }
    }
    // a shared (mixed-use) account on Schedule C next to the actual-expense home office method (Form 8829, which this app does not compute):
    // Form 8829 would also take utilities, so the same service must not be claimed twice
    const shared = ctx.ret.scheduleC?.businessUse ?? [];
    const x1 = ctx.view.decisions.find((d) => d.id === "X1");
    if (shared.length > 0 && x1?.chosen === "actual") {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.C2.business-use-home-office",
          severity: "medium",
          area: "deductions",
          ruleTag: shared[0]?.decisionId ?? "X6",
          message:
            "A shared internet or phone account is deducted on Schedule C at your business-use percentage, and the home office uses the actual-expense method (Form 8829). Form 8829 also takes utilities. This app does not compute Form 8829, so it cannot tell whether the same service is counted in both places.",
          evidence: [{ ref: "check:decision.X1", amount: null, status: "actual method" }, { ref: `check:decision.${shared[0]?.decisionId ?? "X6"}`, amount: null, status: "business-use percentage" }],
          recommendedAction: "When you prepare Form 8829, leave the shared internet and phone service out of its utilities (it is already on Schedule C line 25), or accept this finding with the reason it is not counted twice.",
          acceptable: true,
        })
      );
    }
    return out;
  },
};
