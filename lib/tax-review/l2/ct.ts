// L2 oracle: the Connecticut resident return (Form CT-1040) recomputed from the facts and the federal lines the oracle already holds.
// Written from the CT-1040 instructions and the CT-1040 TCS (Rev. 12/25): lines 1-26, Schedule 1 totals, Schedule 3 (property tax credit),
// the Tax Calculation Schedule and Tables A-E. Lines 27-30 (late payment penalty, interest, underpayment interest) are informational in the
// engine and are not recomputed.

import { K } from "@/lib/tax2025/constants";
import { Ledger, type OracleInputs } from "@/lib/tax-review/l2/ledger";
import { addAll, dollarsOfCents, max0, type Maybe } from "@/lib/tax-review/l2/money";
import { ctPropertyTaxDecimalHundredths, ctTaxCalculationSchedule } from "@/lib/tax-review/l2/tables";

const CT_ADDITION_LINES = ["31", "32", "33", "34", "35", "36", "36a", "37"] as const;
const CT_SUBTRACTION_LINES = ["39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "48a", "48b", "48c", "48d", "49"] as const;

export function computeCt(inp: OracleInputs, L: Ledger): void {
  const { facts } = inp;
  const v = (k: string): Maybe<number> => L.get(k);
  const nz = (x: number | null | undefined): number => x ?? 0;
  const statedNone = (g: string): boolean => (facts.statedNone as Record<string, { value: boolean | null } | undefined>)[g]?.value === true;
  const sumKeys = (keys: readonly string[]): Maybe<number> => addAll(...keys.map(v));

  // ── Lines 1-5: Connecticut adjusted gross income ────────────────────────────
  L.put("ct1040.1", v("f1040.11a"), ["f1040.11a"]);
  const eng = (key: string, note: string): void => {
    L.engineInput(key, inp.engineAmount(key), note);
  };
  // Schedule 1 additions (lines 31-37) and subtractions (lines 39-49): the numeric facts are recomputed; the rest are inputs
  const int8 = facts.income.interest.reduce((a, i) => a + nz(i.box8Cents), 0);
  const div11 = facts.income.dividends.reduce((a, d) => a + nz(d.box11Cents), 0);
  const int3 = facts.income.interest.reduce((a, i) => a + nz(i.box3Cents), 0);
  for (const id of CT_ADDITION_LINES) {
    const key = `ct1040.s1.${id}`;
    if (id === "37") {
      const stated = facts.ct.additions.value;
      if (stated !== null) L.put(key, dollarsOfCents(stated), [], "stated by the owner");
      else eng(key, "Connecticut Schedule 1 line taken from the engine");
    } else if (id === "31" && int8 === 0) L.put(key, 0, [], "no tax-exempt interest");
    else if (id === "32" && div11 === 0) L.put(key, 0, [], "no exempt-interest dividends");
    else eng(key, "Connecticut Schedule 1 line taken from the engine");
  }
  for (const id of CT_SUBTRACTION_LINES) {
    const key = `ct1040.s1.${id}`;
    if (id === "39") L.put(key, dollarsOfCents(int3), [], "interest on U.S. obligations (1099-INT box 3)");
    else if (id === "42") L.put(key, v("sch1.1"), ["sch1.1"], "repeats federal Schedule 1 line 1");
    else if (id === "49") {
      const stated = facts.ct.subtractions.value;
      if (stated !== null) L.put(key, dollarsOfCents(stated), [], "stated by the owner");
      else eng(key, "Connecticut Schedule 1 line taken from the engine");
    } else eng(key, "Connecticut Schedule 1 line taken from the engine");
  }
  const addKeys = CT_ADDITION_LINES.map((id) => `ct1040.s1.${id}`);
  const subKeys = CT_SUBTRACTION_LINES.map((id) => `ct1040.s1.${id}`);
  L.put("ct1040.additions", sumKeys(addKeys), addKeys);
  L.put("ct1040.3", addAll(v("ct1040.1"), v("ct1040.additions")), ["ct1040.1", "ct1040.additions"]);
  L.put("ct1040.subtractions", sumKeys(subKeys), subKeys);
  const l3 = v("ct1040.3");
  const sub = v("ct1040.subtractions");
  const ctAgi = L.put("ct1040.ctAgi", l3 === null || sub === null ? null : l3 - sub, ["ct1040.3", "ct1040.subtractions"]);

  // ── Line 6: income tax (zero at or below $24,000; the Tax Calculation Schedule above $102,000) ──
  let l6: Maybe<number> = null;
  if (ctAgi !== null) {
    if (ctAgi <= K.CT_ZERO_TAX_AGI_MFJ.value) l6 = 0;
    else if (ctAgi > K.CT_TAX_TABLE_AGI_LIMIT.value) l6 = ctTaxCalculationSchedule(ctAgi).l10;
    else L.abstain("CT-1040 line 6", "Connecticut AGI is between $24,001 and $102,000: the DRS Tax Tables (not in the source pack) apply, so line 6 is not recomputed");
  }
  L.put("ct1040.6", l6, ["ct1040.ctAgi"]);
  if (statedNone("ct_other_state_tax")) L.put("ct1040.7", 0, [], "the owner stated none");
  else eng("ct1040.7", "credit for taxes paid to other jurisdictions taken from the engine");
  const l7 = v("ct1040.7");
  L.put("ct1040.8", l6 === null || l7 === null ? null : max0(l6 - l7), ["ct1040.6", "ct1040.7"]);
  // line 9 (Connecticut minimum tax) is zero when there is no federal alternative minimum tax
  if (L.get("f6251.amt") === 0) L.put("ct1040.9", 0, ["f6251.amt"]);
  else {
    L.put("ct1040.9", null);
    L.abstain("CT-1040 line 9", "federal alternative minimum tax is not recomputed here");
  }
  L.put("ct1040.10", addAll(v("ct1040.8"), v("ct1040.9")), ["ct1040.8", "ct1040.9"]);

  // ── Schedule 3 / line 11: property tax credit ───────────────────────────────
  let l11: Maybe<number> = null;
  const l10 = v("ct1040.10");
  if (ctAgi !== null && l10 !== null) {
    const decimal = ctPropertyTaxDecimalHundredths(ctAgi);
    let blocked = false;
    let homeC = 0;
    let hasHome = false;
    const vehicles: number[] = [];
    for (const b of facts.deductions.propertyTaxBills) {
      if (b.kind === "unclassified") {
        blocked = true;
        break;
      }
      if (b.kind === "primary_residence" || b.kind === "motor_vehicle") {
        if (b.paidInYearCents === null) {
          blocked = true;
          break;
        }
        if (b.kind === "primary_residence") {
          hasHome = true;
          homeC += b.paidInYearCents;
        } else vehicles.push(dollarsOfCents(b.paidInYearCents));
      }
    }
    if (blocked) {
      L.abstain("CT-1040 line 11", "a property tax bill has no kind or no amount paid in 2025");
    } else if (decimal >= 100) {
      l11 = 0; // above the top of the Property Tax Credit Table: no credit
    } else if (l10 === 0) {
      l11 = 0;
    } else {
      const rows = [...(hasHome ? [dollarsOfCents(homeC)] : []), ...vehicles.sort((a, b) => b - a).slice(0, K.CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ.value)];
      const l63 = rows.reduce((a, x) => a + x, 0);
      const l65 = Math.min(l63, K.CT_PROPERTY_TAX_CREDIT_MAX.value);
      const l67 = Math.floor((l65 * decimal + 50) / 100);
      L.put("ct1040.s3.63", l63);
      L.put("ct1040.s3.65", l65, ["ct1040.s3.63"]);
      L.put("ct1040.s3.67", l67, ["ct1040.s3.65"]);
      l11 = Math.min(l65 - l67, l10);
    }
  }
  L.put("ct1040.11", l11, ["ct1040.ctAgi", "ct1040.10"]);
  L.put("ct1040.12", addAll(v("ct1040.10"), v("ct1040.11") === null ? null : -(v("ct1040.11") as number)) === null ? null : max0((v("ct1040.10") as number) - (v("ct1040.11") as number)), ["ct1040.10", "ct1040.11"]);
  if (statedNone("ct_other_credits")) L.put("ct1040.13", 0, [], "the owner stated none");
  else eng("ct1040.13", "allowable credits taken from the engine");
  const l12 = v("ct1040.12");
  const l13 = v("ct1040.13");
  L.put("ct1040.14", l12 === null || l13 === null ? null : max0(l12 - l13), ["ct1040.12", "ct1040.13"]);

  // ── Line 15: use tax ────────────────────────────────────────────────────────
  const useTax = facts.ct.useTax.value;
  if (useTax !== null) L.put("ct1040.15", dollarsOfCents(useTax));
  else if (facts.returnAnswers.useTax.choice.value === "none") L.put("ct1040.15", 0, [], "the owner answered no out-of-state purchases");
  else {
    L.put("ct1040.15", null);
    L.abstain("CT-1040 line 15", "use tax from the purchases worksheet is not recomputed");
  }
  L.put("ct1040.16", addAll(v("ct1040.14"), v("ct1040.15")), ["ct1040.14", "ct1040.15"]);
  L.put("ct1040.17", v("ct1040.16"), ["ct1040.16"]);

  // ── Payments ────────────────────────────────────────────────────────────────
  // line 18: the Column C amounts are whole dollars, one per Form W-2
  const ctRows = facts.income.w2s.map((w) => (w.ctWithheldCents === null ? null : dollarsOfCents(w.ctWithheldCents)));
  const ctPaystub = dollarsOfCents(facts.payments.ctPaystubWithheldCents);
  L.put("ct1040.18", addAll(...ctRows, ctPaystub));
  const est = facts.payments.ctEstimates.value;
  const prior = facts.payments.ctPriorYearOverpaymentApplied.value;
  if (est === null || prior === null) L.put("ct1040.19", null);
  else L.put("ct1040.19", dollarsOfCents(est.filter((e) => e.appliesToTaxYear === 2025).reduce((a, e) => a + e.amountCents, 0) + prior));
  const ext = facts.payments.ctExtensionPayment.value;
  L.put("ct1040.20", ext === null ? null : dollarsOfCents(ext));
  for (const id of ["20a", "20b", "20c", "20d"]) {
    if (statedNone("ct_other_credits")) L.put(`ct1040.${id}`, 0, [], "the owner stated none");
    else eng(`ct1040.${id}`, "credit taken from the engine");
  }
  const l21Keys = ["ct1040.18", "ct1040.19", "ct1040.20", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"];
  const l21 = L.put("ct1040.21", sumKeys(l21Keys), l21Keys);
  const l17 = v("ct1040.17");
  const l22 = L.put("ct1040.22", l21 === null || l17 === null ? null : max0(l21 - l17), ["ct1040.21", "ct1040.17"]);
  const l26 = L.put("ct1040.26", l21 === null || l17 === null ? null : max0(l17 - l21), ["ct1040.17", "ct1040.21"]);
  L.put("ct1040.balance", l22 === null || l26 === null ? null : l26 - l22, ["ct1040.22", "ct1040.26"]);
}
