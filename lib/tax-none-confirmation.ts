// "None this year" as a first-class answer for the donation log and the
// fixed-asset registers. It rides on the planning-question mechanism (no new
// table): the owner answers one of three bank questions with "none". Pure, no DB.

export const NONE_CONFIRMATION_KEYS = {
  donations: "donations_none",
  fixedAssetsEkc: "fixed_assets_ekc",
  fixedAssetsSv: "fixed_assets_sv",
} as const;

export type NoneConfirmationKey = (typeof NONE_CONFIRMATION_KEYS)[keyof typeof NONE_CONFIRMATION_KEYS];

/** The three keys as a list (the allow-list for clearTaxQuestionAnswerByKey). */
export const NONE_CONFIRMATION_KEY_LIST: readonly string[] = Object.values(NONE_CONFIRMATION_KEYS);

export interface NoneConfirmationQuestion {
  key: string;
  answer: unknown;
  skippedReason: string | null;
}

/**
 * True only when the owner answered exactly "none" and did not skip it. Stricter
 * than a generic "is answered": answering "some" ("I'll enter them") must NOT
 * satisfy the line.
 */
export function isNoneConfirmed(questions: readonly NoneConfirmationQuestion[], key: string): boolean {
  const q = questions.find((x) => x.key === key);
  return !!q && q.answer === "none" && !q.skippedReason;
}
