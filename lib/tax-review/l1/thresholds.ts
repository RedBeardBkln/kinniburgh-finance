// Thresholds of the HEURISTIC checks (L1.E1 prior year, L1.E2 reasonableness). None of these is a rule of tax law: they are
// "look again" triggers chosen to be loose enough that a normal year does not trip them. Each finding they produce is labelled
// as a heuristic (citation kind "heuristic") and capped at medium, so a heuristic can never block an approval by itself.
// Changing a number here changes only how often the reviewer asks you to look twice.

export const THRESHOLDS = {
  /** Federal AGI changed by more than this fraction against the 2024 return. */
  priorAgiVariance: 0.25,
  /** Federal total tax changed by more than this fraction against the 2024 return. */
  priorTaxVariance: 0.35,
  /** Total tax above this fraction of total income. */
  effectiveRateHigh: 0.4,
  /** Self-employment tax above this fraction of Schedule C net profit (the combined 12.4% + 2.9% rates on 92.35% is lower than this). */
  seTaxRatioHigh: 0.153,
  /** Schedule C total expenses above this fraction of gross income. */
  schCExpenseRatioHigh: 0.9,
  /** Deductible meals above this fraction of Schedule C gross income. */
  mealsRatioHigh: 0.05,
  /** Gifts to charity above this fraction of AGI. */
  charityRatioHigh: 0.5,
  /** Itemized vs standard deduction within this fraction of each other: a close call worth a second look. */
  itemizeMarginClose: 0.02,
  /** Withholding above this multiple of total tax (a very large refund). */
  withholdingMultipleHigh: 1.5,
  /** Connecticut tax above this fraction of federal AGI. */
  ctTaxToAgiHigh: 0.07,
  /** Net investment income tax above this fraction of net investment income. */
  niitRatioHigh: 0.039,
} as const;
