// The footing and cross-form link rules of L1 (plan section 5.3, L1.F1 / L1.F2): "a printed total equals the sum of the
// printed parts", "a line carried from one form to another equals its source". Authored from the PRINTED 2025 forms:
// every `quote` below is text of the form itself (the AcroForm description of the field, data/forms/2025/catalog/*), checked
// verbatim by lib/__tests__/tax-review-l1-footing.test.ts, so the rule says what the form says and not what the engine
// does. CT-1040 is a flat form: its quote is the engine's own printed-line label (lib/tax2025/line-catalog.ts, derived from
// the form) and its arithmetic was cross-checked against the independent CT-1040 tester oracle.
//
// What these rules deliberately do NOT do: no tax rate, threshold, cap or table is repeated here (the second implementation
// of the arithmetic with rates, L2, owns that). A rule says only how lines add up.
//
// The rules are evaluated on the EFFECTIVE view (overrides applied): CLAUDE.md notes that totals are not recomputed under a
// line override, so a pinned part that its total does not reflect shows up here as a footing break.
//
// Pure data + types.

import type { LineKey } from "@/lib/tax2025/line-catalog";
import type { FormId } from "@/lib/tax2025/types";
import type { FindingArea } from "@/lib/tax-review/types";

export interface Term {
  key: LineKey;
  /** +1 (default) adds the part, -1 subtracts it. */
  sign?: 1 | -1;
}

export interface FootingRule {
  /** Unique, stable: used in the finding's check id ("L1.F1.<id>"). */
  id: string;
  /** "footing": total = sum of parts on one form. "link": a line carried from another form (one part). */
  category: "footing" | "link";
  /** The PDF map form id the rule is printed on (the form that must be in the packet for it to be visible). */
  form: string;
  /** The engine form id, so a form with no PDF yet is still checked when the engine says it is required. */
  engineForm?: FormId;
  total: LineKey;
  parts: readonly Term[];
  /** The form says "if zero or less, enter 0": total = max(0, sum). */
  floor0?: boolean;
  /** Allowed difference in whole dollars (default 0). */
  tolerance?: number;
  toleranceReason?: string;
  /** Verbatim printed text the rule is taken from. */
  quote: string;
  /** The form whose printed text the quote is taken from, when it is not `form` (a carried line quotes its SOURCE form). */
  quoteForm?: string;
  /** Where the quote comes from, e.g. "f1040:9" (map form id : printed line). */
  sourceId: string;
  area: FindingArea;
}

const p = (...keys: LineKey[]): Term[] => keys.map((key) => ({ key }));

function sum(
  id: string,
  form: string,
  engineForm: FormId,
  total: LineKey,
  parts: readonly Term[],
  quote: string,
  area: FindingArea,
  over: Partial<Pick<FootingRule, "floor0" | "tolerance" | "toleranceReason" | "category">> = {}
): FootingRule {
  return { id, category: "footing", form, engineForm, total, parts, quote, sourceId: `${form}:${total.split(".").slice(1).join(".")}`, area, ...over };
}

function link(
  id: string,
  form: string,
  engineForm: FormId,
  total: LineKey,
  source: LineKey,
  quote: string,
  area: FindingArea,
  over: Partial<Pick<FootingRule, "floor0" | "tolerance" | "quoteForm">> = {}
): FootingRule {
  return { id, category: "link", form, engineForm, total, parts: p(source), quote, sourceId: `${over.quoteForm ?? form}:${source.split(".").slice(1).join(".")}`, area, ...over };
}

const SCHD_ROUNDING =
  "each Schedule D line is rounded to whole dollars once from the cents (IRS: include cents when adding the amounts and round off only the total), so a total of rounded lines can differ by $1";

// ── Form 1040 ─────────────────────────────────────────────────────────────────

const F1040: FootingRule[] = [
  sum("f1040.1z", "f1040", "f1040", "f1040.1z", p("f1040.1a", "f1040.1b", "f1040.1c", "f1040.1d", "f1040.1e", "f1040.1f", "f1040.1g", "f1040.1h"), "1z. Add lines 1a through 1h.", "income"),
  sum("f1040.9", "f1040", "f1040", "f1040.9", p("f1040.1z", "f1040.2b", "f1040.3b", "f1040.4b", "f1040.5b", "f1040.6b", "f1040.7a", "f1040.8"), "9. Add lines 1z, 2b, 3b, 4b, 5b, 6b, 7a, and 8. This is your total income.", "income"),
  sum("f1040.11a", "f1040", "f1040", "f1040.11a", [{ key: "f1040.9" }, { key: "f1040.10", sign: -1 }], "11a. Subtract line 10 from line 9. This is your adjusted gross income.", "income"),
  link("f1040.11b", "f1040", "f1040", "f1040.11b", "f1040.11a", "11b. Amount from line 11a (adjusted gross income).", "income"),
  sum("f1040.14", "f1040", "f1040", "f1040.14", p("f1040.12e", "f1040.13a", "f1040.13b"), "14. Add lines 12e, 13a, and 13b.", "deductions"),
  sum("f1040.15", "f1040", "f1040", "f1040.15", [{ key: "f1040.11b" }, { key: "f1040.14", sign: -1 }], "15. Subtract line 14 from line 11b. If zero or less, enter 0. This is your taxable income.", "tax", { floor0: true }),
  sum("f1040.18", "f1040", "f1040", "f1040.18", p("f1040.16", "f1040.17"), "18. Add lines 16 and 17.", "tax"),
  sum("f1040.21", "f1040", "f1040", "f1040.21", p("f1040.19", "f1040.20"), "21. Add lines 19 and 20.", "credits"),
  sum("f1040.22", "f1040", "f1040", "f1040.22", [{ key: "f1040.18" }, { key: "f1040.21", sign: -1 }], "22. Subtract line 21 from line 18. If zero or less, enter 0.", "tax", { floor0: true }),
  sum("f1040.24", "f1040", "f1040", "f1040.24", p("f1040.22", "f1040.23"), "24. Add lines 22 and 23. This is your total tax.", "tax"),
  sum("f1040.25d", "f1040", "f1040", "f1040.25d", p("f1040.25a", "f1040.25b", "f1040.25c"), "25d. Add lines 25a through 25c.", "payments"),
  sum("f1040.32", "f1040", "f1040", "f1040.32", p("f1040.27a", "f1040.28", "f1040.29", "f1040.30", "f1040.31"), "32. Add lines 27a, 28, 29, 30, and 31. These are your total other payments and refundable credits.", "payments"),
  sum("f1040.33", "f1040", "f1040", "f1040.33", p("f1040.25d", "f1040.26", "f1040.32"), "33. Add lines 25d, 26, and 32. These are your total payments.", "payments"),
  sum("f1040.34", "f1040", "f1040", "f1040.34", [{ key: "f1040.33" }, { key: "f1040.24", sign: -1 }], "34. If line 33 is more than line 24, subtract line 24 from line 33. This is the amount you overpaid.", "payments", { floor0: true }),
  sum("f1040.37", "f1040", "f1040", "f1040.37", [{ key: "f1040.24" }, { key: "f1040.33", sign: -1 }], "37. Subtract line 33 from line 24. This is the amount you owe.", "payments", { floor0: true }),
  // carried from the schedules
  link("f1040.8", "f1040", "f1040", "f1040.8", "sch1.10", "8. Additional income from Schedule 1, line 10.", "income"),
  link("f1040.10", "f1040", "f1040", "f1040.10", "sch1.26", "10. Adjustments to income from Schedule 1, line 26.", "adjustments"),
  link("f1040.13b", "f1040", "f1040", "f1040.13b", "sch1a.38", "13b. Additional deductions from Schedule 1-A, line 38.", "deductions"),
  link("f1040.17", "f1040", "f1040", "f1040.17", "sch2.3", "17. Amount from Schedule 2, line 3.", "tax"),
  link("f1040.20", "f1040", "f1040", "f1040.20", "sch3.8", "20. Amount from Schedule 3, line 8.", "credits"),
  link("f1040.23", "f1040", "f1040", "f1040.23", "sch2.21", "23. Other taxes, including self-employment tax, from Schedule 2, line 21.", "tax"),
  link("f1040.31", "f1040", "f1040", "f1040.31", "sch3.15", "31. Amount from Schedule 3, line 15.", "payments"),
  link("f1040.2b", "f1040", "f1040", "f1040.2b", "schb.4", "4. Subtract line 3 from line 2. Enter the result here and on Form 1040 or 1040-S R, line 2b.", "income", { quoteForm: "f1040sb" }),
  link("f1040.3b", "f1040", "f1040", "f1040.3b", "schb.6", "6. Add the amounts on line 5. Enter the total here and on Form 1040 or 1040-S R, line 3b.", "income", { quoteForm: "f1040sb" }),
  link("f1040.25c", "f1040", "f1040", "f1040.25c", "f8959.24", "24. Total Additional Medicare Tax withholding. Add lines 22 and 23. Also include this amount with federal income tax withholding on Form 1040, 1040-S R, or 1040-N R, line 25c", "payments", { quoteForm: "f8959" }),
];

// ── Schedule 1 ────────────────────────────────────────────────────────────────

const SCH1: FootingRule[] = [
  sum(
    "sch1.9",
    "f1040s1",
    "sch1",
    "sch1.9",
    p("sch1.8a", "sch1.8b", "sch1.8c", "sch1.8d", "sch1.8e", "sch1.8f", "sch1.8g", "sch1.8h", "sch1.8i", "sch1.8j", "sch1.8k", "sch1.8l", "sch1.8m", "sch1.8n", "sch1.8o", "sch1.8p", "sch1.8q", "sch1.8r", "sch1.8s", "sch1.8t", "sch1.8u", "sch1.8v", "sch1.8z"),
    "9. Total other income. Add lines 8a through 8z.",
    "income"
  ),
  sum("sch1.10", "f1040s1", "sch1", "sch1.10", p("sch1.1", "sch1.2a", "sch1.3", "sch1.4", "sch1.5", "sch1.6", "sch1.7", "sch1.9"), "10. Combine lines 1 through 7 and 9. This is your additional income.", "income"),
  sum(
    "sch1.25",
    "f1040s1",
    "sch1",
    "sch1.25",
    p("sch1.24a", "sch1.24b", "sch1.24c", "sch1.24d", "sch1.24e", "sch1.24f", "sch1.24g", "sch1.24h", "sch1.24i", "sch1.24j", "sch1.24k", "sch1.24z"),
    "25. Total other adjustments. Add lines 24a through 24z.",
    "adjustments"
  ),
  sum(
    "sch1.26",
    "f1040s1",
    "sch1",
    "sch1.26",
    p("sch1.11", "sch1.12", "sch1.13", "sch1.14", "sch1.15", "sch1.16", "sch1.17", "sch1.18", "sch1.19a", "sch1.20", "sch1.21", "sch1.23", "sch1.25"),
    "26. Add lines 11 through 23 and 25. These are your adjustments to income.",
    "adjustments"
  ),
  link("sch1.3", "f1040s1", "sch1", "sch1.3", "schc.31", "31. Net profit or (loss). Subtract line 30 from line 29. If a profit, enter on both Schedule 1 (Form 1040), line 3, and on Schedule S E, line 2.", "income", { quoteForm: "f1040sc" }),
  link("sch1.15", "f1040s1", "sch1", "sch1.15", "se.13", "13. Deduction for one-half of self-employment tax. Multiply line 12 by 50% (0.50). Enter here and on Schedule 1 (Form 1040), line 15.", "adjustments", { quoteForm: "f1040sse" }),
];

// ── Schedule 2 ────────────────────────────────────────────────────────────────

const SCH2: FootingRule[] = [
  sum("sch2.1z", "f1040s2", "sch2", "sch2.1z", p("sch2.1a", "sch2.1b", "sch2.1c", "sch2.1d", "sch2.1e", "sch2.1f", "sch2.1y"), "1z. Add lines 1a through 1y.", "tax"),
  sum("sch2.3", "f1040s2", "sch2", "sch2.3", p("sch2.1z", "sch2.2"), "3. Add lines 1z and 2. Enter here and on Form 1040, 1040-S R, or 1040-N R, line 17.", "tax"),
  sum("sch2.7", "f1040s2", "sch2", "sch2.7", p("sch2.5", "sch2.6"), "7. Total additional social security and Medicare tax. Add lines 5 and 6.", "tax"),
  sum(
    "sch2.18",
    "f1040s2",
    "sch2",
    "sch2.18",
    p("sch2.17a", "sch2.17b", "sch2.17c", "sch2.17d", "sch2.17e", "sch2.17f", "sch2.17g", "sch2.17h", "sch2.17i", "sch2.17j", "sch2.17k", "sch2.17l", "sch2.17m", "sch2.17n", "sch2.17o", "sch2.17p", "sch2.17q", "sch2.17z"),
    "18. Total additional taxes. Add lines 17a through 17z.",
    "tax"
  ),
  sum(
    "sch2.21",
    "f1040s2",
    "sch2",
    "sch2.21",
    p("sch2.4", "sch2.7", "sch2.8", "sch2.9", "sch2.11", "sch2.12", "sch2.13", "sch2.14", "sch2.15", "sch2.16", "sch2.18", "sch2.19"),
    "21. Add lines 4, 7 through 16, 18, and 19. These are your total other taxes.",
    "tax"
  ),
  link("sch2.4", "f1040s2", "sch2", "sch2.4", "se.12", "12. Self-employment tax. Add lines 10 and 11. Enter here and on Schedule 2 (Form 1040), line 4", "tax", { quoteForm: "f1040sse" }),
  link("sch2.11", "f1040s2", "sch2", "sch2.11", "f8959.18", "18. Add lines 7, 13, and 17. Also include this amount on Schedule 2 (Form 1040), line 11", "tax", { quoteForm: "f8959" }),
  link("sch2.12", "f1040s2", "sch2", "sch2.12", "f8960.niit", "17. Net investment income tax for individuals. Multiply line 16 by 3.8% (0.038). Enter here and include on your tax return", "tax", { quoteForm: "f8960" }),
  link("sch2.2", "f1040s2", "sch2", "sch2.2", "f6251.amt", "11. A M T. Subtract line 10 from line 9. If zero or less, enter 0. Enter here and on Schedule 2 (Form 1040), line 2.", "tax", { quoteForm: "f6251" }),
];

// ── Schedule 3 ────────────────────────────────────────────────────────────────

const SCH3: FootingRule[] = [
  sum("sch3.7", "f1040s3", "sch3", "sch3.7", p("sch3.6a", "sch3.6b", "sch3.6c", "sch3.6d", "sch3.6f", "sch3.6g", "sch3.6h", "sch3.6i", "sch3.6j", "sch3.6k", "sch3.6l", "sch3.6m", "sch3.6z"), "7. Total other nonrefundable credits. Add lines 6a through 6z.", "credits"),
  sum("sch3.8", "f1040s3", "sch3", "sch3.8", p("sch3.1", "sch3.2", "sch3.3", "sch3.4", "sch3.5a", "sch3.5b", "sch3.7"), "8. Add lines 1 through 4, 5a, 5b, and 7. Enter here and on Form 1040, 1040-S R, or 1040-N R, line 20.", "credits"),
  sum("sch3.14", "f1040s3", "sch3", "sch3.14", p("sch3.13a", "sch3.13b", "sch3.13c", "sch3.13d", "sch3.13z"), "14. Total other payments or refundable credits. Add lines 13a through 13z.", "payments"),
  sum("sch3.15", "f1040s3", "sch3", "sch3.15", p("sch3.9", "sch3.10", "sch3.11", "sch3.12", "sch3.14"), "15. Add lines 9 through 12 and 14. Enter here and on Form 1040, 1040-S R, or 1040-N R, line 31.", "payments"),
  link("sch3.4", "f1040s3", "sch3", "sch3.4", "f8880.12", "12. Credit for qualified retirement savings contributions. Enter the smaller of line 10 or line 11 here and on Schedule 3 (Form 1040), line 4.", "credits", { quoteForm: "f8880" }),
];

// ── Schedule A ────────────────────────────────────────────────────────────────

const SCHA: FootingRule[] = [
  link("scha.2", "f1040sa", "scha", "scha.2", "f1040.11b", "2. Enter amount from Form 1040 or 1040-S R, line 11b.", "deductions"),
  sum("scha.4", "f1040sa", "scha", "scha.4", [{ key: "scha.1" }, { key: "scha.3", sign: -1 }], "4. Subtract line 3 from line 1. If line 3 is more than line 1, enter 0.", "deductions", { floor0: true }),
  sum("scha.5d", "f1040sa", "scha", "scha.5d", p("scha.5a", "scha.5b", "scha.5c"), "5d. Add lines 5a through 5c.", "deductions"),
  sum("scha.7", "f1040sa", "scha", "scha.7", p("scha.5e", "scha.6"), "7. Add lines 5e and 6.", "deductions"),
  sum("scha.8e", "f1040sa", "scha", "scha.8e", p("scha.8a", "scha.8b", "scha.8c"), "8e. Add lines 8a through 8c.", "deductions"),
  sum("scha.10", "f1040sa", "scha", "scha.10", p("scha.8e", "scha.9"), "10. Add lines 8e and 9.", "deductions"),
  sum("scha.14", "f1040sa", "scha", "scha.14", p("scha.11", "scha.12", "scha.13"), "14. Add lines 11 through 13.", "deductions"),
  sum("scha.17", "f1040sa", "scha", "scha.17", p("scha.4", "scha.7", "scha.10", "scha.14", "scha.15", "scha.16"), "17. Add the amounts in the far right column for lines 4 through 16. Also, enter this amount on Form 1040 or 1040-S R, line 12e.", "deductions"),
];

// ── Schedule B (the payer-row totals are in TABLE_RULES) ──────────────────────

const SCHB: FootingRule[] = [
  sum("schb.4", "f1040sb", "schb", "schb.4", [{ key: "schb.2" }, { key: "schb.3", sign: -1 }], "4. Subtract line 3 from line 2.", "income"),
];

// ── Schedule C ────────────────────────────────────────────────────────────────

const SCHC: FootingRule[] = [
  sum("schc.3", "f1040sc", "schc", "schc.3", [{ key: "schc.1" }, { key: "schc.2", sign: -1 }], "3. Subtract line 2 from line 1.", "income"),
  sum("schc.5", "f1040sc", "schc", "schc.5", [{ key: "schc.3" }, { key: "schc.4", sign: -1 }], "5. Gross profit. Subtract line 4 from line 3.", "income"),
  sum("schc.7", "f1040sc", "schc", "schc.7", p("schc.5", "schc.6"), "7. Gross income. Add lines 5 and 6.", "income"),
  sum(
    "schc.28",
    "f1040sc",
    "schc",
    "schc.28",
    p("schc.8", "schc.9", "schc.10", "schc.11", "schc.12", "schc.13", "schc.14", "schc.15", "schc.16a", "schc.16b", "schc.17", "schc.18", "schc.19", "schc.20a", "schc.20b", "schc.21", "schc.22", "schc.23", "schc.24a", "schc.24b", "schc.25", "schc.26", "schc.27a", "schc.27b"),
    "28. Total expenses before expenses for business use of home. Add lines 8 through 27b.",
    "income"
  ),
  sum("schc.29", "f1040sc", "schc", "schc.29", [{ key: "schc.7" }, { key: "schc.28", sign: -1 }], "29. Tentative profit or (loss). Subtract line 28 from line 7.", "income"),
  sum("schc.31", "f1040sc", "schc", "schc.31", [{ key: "schc.29" }, { key: "schc.30", sign: -1 }], "31. Net profit or (loss). Subtract line 30 from line 29.", "income"),
  sum("schc.40", "f1040sc", "schc", "schc.40", p("schc.35", "schc.36", "schc.37", "schc.38", "schc.39"), "40. Add lines 35 through 39.", "income"),
  sum("schc.42", "f1040sc", "schc", "schc.42", [{ key: "schc.40" }, { key: "schc.41", sign: -1 }], "42. Cost of goods sold. Subtract line 41 from line 40. Enter the result here and on line 4.", "income"),
  link("schc.4", "f1040sc", "schc", "schc.4", "schc.42", "4. Cost of goods sold (from line 42).", "income"),
  link("schc.27b", "f1040sc", "schc", "schc.27b", "schc.48", "27b. Other expenses (from line 48).", "income"),
];

// ── Schedule SE ───────────────────────────────────────────────────────────────

const SE: FootingRule[] = [
  link("se.2", "f1040sse", "schse", "se.2", "schc.31", "2. Net profit or (loss) from Schedule C, line 31", "income"),
  sum("se.3", "f1040sse", "schse", "se.3", [{ key: "se.1a" }, { key: "se.1b", sign: -1 }, { key: "se.2" }], "3. Combine lines 1a, 1b, and 2.", "income"),
  sum("se.4c", "f1040sse", "schse", "se.4c", p("se.4a", "se.4b"), "4c. Combine lines 4a and 4b.", "income"),
  sum("se.6", "f1040sse", "schse", "se.6", p("se.4c", "se.5b"), "6. Add lines 4c and 5b.", "income"),
  sum("se.8d", "f1040sse", "schse", "se.8d", p("se.8a", "se.8b", "se.8c"), "8d. Add lines 8a, 8b, and 8c.", "income"),
  sum("se.9", "f1040sse", "schse", "se.9", [{ key: "se.7" }, { key: "se.8d", sign: -1 }], "9. Subtract line 8d from line 7. If zero or less, enter 0 here and on line 10 and go to line 11.", "income", { floor0: true }),
  sum("se.12", "f1040sse", "schse", "se.12", p("se.10", "se.11"), "12. Self-employment tax. Add lines 10 and 11.", "tax"),
];

// ── Schedule D (cells: d proceeds, e cost, g adjustments, h gain) ─────────────

function cellRule(line: string, withG: boolean): FootingRule {
  const k = (c: string) => `schd.${line}.${c}` as LineKey;
  return {
    id: `schd.${line}.h`,
    category: "footing",
    form: "f1040sd",
    engineForm: "schd",
    total: k("h"),
    parts: [{ key: k("d") }, { key: k("e"), sign: -1 }, ...(withG ? [{ key: k("g") }] : [])],
    tolerance: 1,
    toleranceReason: SCHD_ROUNDING,
    quote: "Subtract column (e) from column (d)",
    sourceId: `f1040sd:${line}.h`,
    area: "income",
  };
}

const SCHD: FootingRule[] = [
  ...(["1a", "8a"] as const).map((l) => cellRule(l, false)),
  ...(["1b", "2", "3", "8b", "9", "10"] as const).map((l) => cellRule(l, true)),
  sum(
    "schd.7",
    "f1040sd",
    "schd",
    "schd.7",
    [{ key: "schd.1a.h" }, { key: "schd.1b.h" }, { key: "schd.2.h" }, { key: "schd.3.h" }, { key: "schd.4" }, { key: "schd.5" }, { key: "schd.6", sign: -1 }],
    "7. Net short-term capital gain or (loss). Combine lines 1a through 6 in column (h).",
    "income",
    { tolerance: 1, toleranceReason: SCHD_ROUNDING }
  ),
  sum(
    "schd.15",
    "f1040sd",
    "schd",
    "schd.15",
    [{ key: "schd.8a.h" }, { key: "schd.8b.h" }, { key: "schd.9.h" }, { key: "schd.10.h" }, { key: "schd.11" }, { key: "schd.12" }, { key: "schd.13" }, { key: "schd.14", sign: -1 }],
    "15. Net long-term capital gain or (loss). Combine lines 8a through 14 in column (h).",
    "income",
    { tolerance: 1, toleranceReason: SCHD_ROUNDING }
  ),
  sum("schd.16", "f1040sd", "schd", "schd.16", p("schd.7", "schd.15"), "16. Combine lines 7 and 15 and enter the result.", "income", { tolerance: 1, toleranceReason: SCHD_ROUNDING }),
];

// ── Form 8995, Form 8959, Schedule 1-A, Form 8960 ─────────────────────────────

const F8995: FootingRule[] = [
  link("f8995.2", "f8995", "f8995", "f8995.2", "f8995.1i", "2. Total qualified business income or (loss). Combine lines 1 i through 1 v, column (c).", "deductions"),
  sum("f8995.4", "f8995", "f8995", "f8995.4", p("f8995.2", "f8995.3"), "4. Total qualified business income. Combine lines 2 and 3. If zero or less, enter 0.", "deductions", { floor0: true }),
  sum("f8995.8", "f8995", "f8995", "f8995.8", p("f8995.6", "f8995.7"), "8. Total qualified R E I T dividends and P T P income. Combine lines 6 and 7. If zero or less, enter 0.", "deductions", { floor0: true }),
  sum("f8995.10", "f8995", "f8995", "f8995.10", p("f8995.5", "f8995.9"), "10. Qualified business income deduction before the income limitation. Add lines 5 and 9.", "deductions"),
  sum("f8995.13", "f8995", "f8995", "f8995.13", [{ key: "f8995.11" }, { key: "f8995.12", sign: -1 }], "13. Subtract line 12 from line 11. If zero or less, enter 0.", "deductions", { floor0: true }),
  link("f1040.13a", "f1040", "f8995", "f1040.13a", "f8995.15", "15. Qualified business income deduction. Enter the smaller of line 10 or line 14. Also enter this amount on the applicable line of your return", "deductions", { quoteForm: "f8995" }),
];

const F8959: FootingRule[] = [
  sum("f8959.4", "f8959", "f8959", "f8959.4", p("f8959.1", "f8959.2", "f8959.3"), "4. Add lines 1 through 3.", "tax"),
  sum("f8959.6", "f8959", "f8959", "f8959.6", [{ key: "f8959.4" }, { key: "f8959.5", sign: -1 }], "6. Subtract line 5 from line 4. If zero or less, enter 0.", "tax", { floor0: true }),
  link("f8959.10", "f8959", "f8959", "f8959.10", "f8959.4", "10. Enter the amount from line 4.", "tax"),
  sum("f8959.11", "f8959", "f8959", "f8959.11", [{ key: "f8959.9" }, { key: "f8959.10", sign: -1 }], "11. Subtract line 10 from line 9. If zero or less, enter 0.", "tax", { floor0: true }),
  sum("f8959.12", "f8959", "f8959", "f8959.12", [{ key: "f8959.8" }, { key: "f8959.11", sign: -1 }], "12. Subtract line 11 from line 8. If zero or less, enter 0.", "tax", { floor0: true }),
  sum("f8959.16", "f8959", "f8959", "f8959.16", [{ key: "f8959.14" }, { key: "f8959.15", sign: -1 }], "16. Subtract line 15 from line 14. If zero or less, enter 0.", "tax", { floor0: true }),
  sum("f8959.18", "f8959", "f8959", "f8959.18", p("f8959.7", "f8959.13", "f8959.17"), "18. Add lines 7, 13, and 17.", "tax"),
  link("f8959.20", "f8959", "f8959", "f8959.20", "f8959.1", "20. Enter the amount from line 1.", "tax"),
  sum("f8959.22", "f8959", "f8959", "f8959.22", [{ key: "f8959.19" }, { key: "f8959.21", sign: -1 }], "22. Subtract line 21 from line 19. If zero or less, enter 0.", "tax", { floor0: true }),
  sum("f8959.24", "f8959", "f8959", "f8959.24", p("f8959.22", "f8959.23"), "24. Total Additional Medicare Tax withholding. Add lines 22 and 23.", "payments"),
  link("f8959.8", "f8959", "f8959", "f8959.8", "se.6", "8. Self-employment income from Schedule S E (Form 1040), Part I, line 6. If you had a loss, enter 0.", "tax", { floor0: true }),
];

const SCH1A: FootingRule[] = [
  sum("sch1a.37", "f1040s1a", "sch1a", "sch1a.37", p("sch1a.36a", "sch1a.36b"), "37. Enhanced deduction for seniors. Add lines 36a and 36b.", "deductions"),
  sum("sch1a.38", "f1040s1a", "sch1a", "sch1a.38", p("sch1a.13", "sch1a.21", "sch1a.30", "sch1a.37"), "38. Add lines 13, 21, 30, and 37.", "deductions"),
];

// ── CT-1040 (flat form: the quote is the engine's printed-line label, see the header) ──

function ctLabel(text: string): string {
  return text;
}

const CT: FootingRule[] = [
  link("ct1040.1", "ct1040", "ct1040", "ct1040.1", "f1040.11a", ctLabel("Federal adjusted gross income (1040 line 11a)"), "state"),
  sum("ct1040.additions", "ct1040", "ct1040", "ct1040.additions", p("ct1040.s1.31", "ct1040.s1.32", "ct1040.s1.33", "ct1040.s1.34", "ct1040.s1.35", "ct1040.s1.36", "ct1040.s1.36a", "ct1040.s1.37"), ctLabel("CT Schedule 1 additions"), "state"),
  sum("ct1040.3", "ct1040", "ct1040", "ct1040.3", p("ct1040.1", "ct1040.additions"), ctLabel("Federal AGI plus Schedule 1 additions (lines 1 and 2)"), "state"),
  sum(
    "ct1040.subtractions",
    "ct1040",
    "ct1040",
    "ct1040.subtractions",
    p("ct1040.s1.39", "ct1040.s1.40", "ct1040.s1.41", "ct1040.s1.42", "ct1040.s1.43", "ct1040.s1.44", "ct1040.s1.45", "ct1040.s1.46", "ct1040.s1.47", "ct1040.s1.48", "ct1040.s1.48a", "ct1040.s1.48b", "ct1040.s1.48c", "ct1040.s1.48d", "ct1040.s1.49"),
    ctLabel("CT Schedule 1 subtractions"),
    "state"
  ),
  sum("ct1040.ctAgi", "ct1040", "ct1040", "ct1040.ctAgi", [{ key: "ct1040.3" }, { key: "ct1040.subtractions", sign: -1 }], ctLabel("Connecticut adjusted gross income"), "state"),
  sum("ct1040.8", "ct1040", "ct1040", "ct1040.8", [{ key: "ct1040.6" }, { key: "ct1040.7", sign: -1 }], ctLabel("Connecticut income tax after the credit for taxes paid to other jurisdictions (line 6 less line 7)"), "state", { floor0: true }),
  sum("ct1040.10", "ct1040", "ct1040", "ct1040.10", p("ct1040.8", "ct1040.9"), ctLabel("Connecticut income tax before credits"), "state"),
  sum("ct1040.12", "ct1040", "ct1040", "ct1040.12", [{ key: "ct1040.10" }, { key: "ct1040.11", sign: -1 }], ctLabel("Connecticut income tax after the property tax credit (line 10 less line 11)"), "state", { floor0: true }),
  sum("ct1040.14", "ct1040", "ct1040", "ct1040.14", [{ key: "ct1040.12" }, { key: "ct1040.13", sign: -1 }], ctLabel("Connecticut income tax (line 12 less line 13)"), "state", { floor0: true }),
  sum("ct1040.16", "ct1040", "ct1040", "ct1040.16", p("ct1040.14", "ct1040.15"), ctLabel("Connecticut income tax and use tax (lines 14 and 15)"), "state"),
  link("ct1040.17", "ct1040", "ct1040", "ct1040.17", "ct1040.16", ctLabel("Total tax (amount from line 16)"), "state"),
  sum("ct1040.21", "ct1040", "ct1040", "ct1040.21", p("ct1040.18", "ct1040.19", "ct1040.20", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"), ctLabel("Total payments and refundable credits (lines 18 through 20d)"), "state"),
  sum("ct1040.22", "ct1040", "ct1040", "ct1040.22", [{ key: "ct1040.21" }, { key: "ct1040.17", sign: -1 }], ctLabel("Overpayment (line 21 more than line 17)"), "state", { floor0: true }),
  sum("ct1040.26", "ct1040", "ct1040", "ct1040.26", [{ key: "ct1040.17" }, { key: "ct1040.21", sign: -1 }], ctLabel("Tax due (line 17 more than line 21)"), "state", { floor0: true }),
  sum("ct1040.30", "ct1040", "ct1040", "ct1040.30", p("ct1040.26", "ct1040.27", "ct1040.28", "ct1040.29"), ctLabel("Total amount due (lines 26 through 29)"), "state"),
  sum("ct1040.balance", "ct1040", "ct1040", "ct1040.balance", [{ key: "ct1040.17" }, { key: "ct1040.21", sign: -1 }], ctLabel("Connecticut balance due or overpayment"), "state"),
  link("ct1040.11", "ct1040", "ct1040", "ct1040.11", "ct1040.s3.67", ctLabel("Property tax credit"), "state"),
];

export const FOOTING_RULES: readonly FootingRule[] = [
  ...F1040,
  ...SCH1,
  ...SCH2,
  ...SCH3,
  ...SCHA,
  ...SCHB,
  ...SCHC,
  ...SE,
  ...SCHD,
  ...F8995,
  ...F8959,
  ...SCH1A,
  ...CT,
];

// ── Printed tables whose rows must add up to a printed line ───────────────────

export interface TableRule {
  id: string;
  form: string;
  engineForm: FormId;
  /** PdfReturnView.tables key. */
  table: "schb.interest" | "schb.dividends" | "ct.withholding" | "ct.propertyTax" | "schc.otherExpenses";
  /** Money column of the table (adapter TABLE_COLUMNS). */
  column: string;
  total: LineKey;
  quote: string;
  area: FindingArea;
}

export const TABLE_RULES: readonly TableRule[] = [
  { id: "schb.2.rows", form: "f1040sb", engineForm: "schb", table: "schb.interest", column: "amount", total: "schb.2", quote: "2. Add the amounts on line 1.", area: "income" },
  { id: "schb.6.rows", form: "f1040sb", engineForm: "schb", table: "schb.dividends", column: "amount", total: "schb.6", quote: "6. Add the amounts on line 5.", area: "income" },
  { id: "schc.48.rows", form: "f1040sc", engineForm: "schc", table: "schc.otherExpenses", column: "amount", total: "schc.48", quote: "48. Total other expenses. Enter here and on line 27b.", area: "income" },
  { id: "ct1040.18.rows", form: "ct1040", engineForm: "ct1040", table: "ct.withholding", column: "withheld", total: "ct1040.18", quote: "Connecticut income tax withheld", area: "state" },
  { id: "ct1040.s3.63.rows", form: "ct1040", engineForm: "ct1040", table: "ct.propertyTax", column: "amount", total: "ct1040.s3.63", quote: "Property tax credit: total property tax paid (lines 60 through 62)", area: "state" },
];

/**
 * Packet forms with no footing or link rule on purpose. A form map that is in FORM_MAPS but neither covered by a rule
 * (FOOTING_RULES / TABLE_RULES / the special checks in footing.ts) nor listed here fails the drift test and is reported as an
 * info finding, so a newly added form can never silently go unchecked.
 */
export const NOT_COVERED_FORMS: Readonly<Record<string, string>> = {
  // (none today: every form of the packet has rules)
};

/** Forms whose footing is checked by code in footing.ts rather than by rows of FOOTING_RULES / TABLE_RULES. */
export const SPECIAL_COVERED_FORMS: Readonly<Record<string, string>> = {
  f8949: "row (h) = (d) - (e) + (g), and the Totals rows against the Schedule D lines (footing.ts, form 8949 checks)",
};
