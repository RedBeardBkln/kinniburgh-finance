// In-page anchors shared by the pages that carry them (the return review sheet, the Forms page, the Final review page) and by the
// code that links to them (lib/tax-review/links.ts). ONE slug function builds every id, so the id written on a row and the fragment
// written in a link can never drift apart: both sides call the helpers below, and a test round-trips every line key of the catalog.
//
// PURE and tiny (no imports): safe in server and client bundles. An anchor is [a-z0-9-] only, so it is always URL-safe and can never
// carry a quote, a space, a slash or a script into a link.

/** Lower case, every run of characters outside a-z0-9 becomes one dash, no leading or trailing dash, never empty. */
export function anchorSlug(text: string, max = 100): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return s === "" ? "x" : s;
}

/** A line of the return ("scha.8a" -> "line-scha-8a"): the id of its row on the review sheet. */
export const lineAnchorId = (lineKey: string): string => `line-${anchorSlug(lineKey)}`;
/** An owner decision ("X1" -> "decision-x1"): the id of its card on the review sheet. */
export const decisionAnchorId = (decisionId: string): string => `decision-${anchorSlug(decisionId)}`;
/** An open item of the return (its engine id) on the review sheet. */
export const openItemAnchorId = (itemId: string): string => `item-${anchorSlug(itemId)}`;
/** A conflict between sources (its fact key, cut to 80 characters the way a finding's evidence cuts it). */
export const conflictAnchorId = (factKey: string): string => `conflict-${anchorSlug(factKey.slice(0, 80))}`;
/** A document row of the review sheet's document index. */
export const documentAnchorId = (documentId: string): string => `doc-${anchorSlug(documentId)}`;
/** A form's block of lines on the review sheet (the form's printed name: "Schedule A" -> "form-schedule-a"). */
export const formGroupAnchorId = (formLabel: string): string => `form-${anchorSlug(formLabel)}`;
/** A "homework" line (something the owner still has to answer or verify) on the review sheet. */
export const homeworkAnchorId = (itemId: string): string => `homework-${anchorSlug(itemId)}`;

/** The six printed parts of the review sheet, and the named blocks inside them. */
export const SHEET_ANCHORS = {
  summary: "part-1",
  federal: "part-2",
  connecticut: "part-3",
  decisions: "part-4",
  openItems: "part-5",
  documents: "part-6",
  overrides: "overrides",
  attestations: "attestations",
  headlineFederal: "headline-federal",
  headlineConnecticut: "headline-connecticut",
} as const;

/** The sections of the Forms page. (Each form's card already carries its own id: the card id from lib/tax-forms.ts.) */
export const FORMS_PAGE_ANCHORS = {
  federal: "forms-federal",
  connecticut: "forms-connecticut",
  needsInput: "forms-needs-input",
  business: "forms-business",
  pdf: "filled-pdf-forms",
} as const;

/** The blocks of the Final review page. */
export const REVIEW_ANCHORS = {
  runChecks: "run-checks",
  gate: "review-gate",
  aiReview: "ai-review",
  findings: "review-findings",
  register: "review-register",
  byHand: "review-byhand",
  infoCards: "review-info-cards",
} as const;

/** The id a gate checklist row carries (gate item id: "l1" -> "gate-item-l1"). */
export const gateItemAnchorId = (itemId: string): string => `gate-item-${anchorSlug(itemId)}`;

/** Questions of a questionnaire page carry `q-<node id>` (components/tax/forms/questionnaire-runner.tsx). */
export const questionAnchorId = (nodeId: string): string => `q-${nodeId}`;
