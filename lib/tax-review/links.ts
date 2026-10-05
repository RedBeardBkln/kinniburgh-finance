// Deep links for the Final review page (final-review-deep-links): every finding, register entry, by-hand item, info statement and
// gate row gets one or more clearly labelled links to the exact place that can fix it (a line of the review sheet, the filled form
// PDF, the form's card on the Forms page, a document, a question, a decision).
//
// PURE: no DB, no network, no clock, no fs. Everything it needs about the CURRENT return arrives in a plain JSON `LinkContext` built on
// the server (lib/tax-review/links-context.ts): which lines and decisions exist on the review sheet, which printed page a line is on,
// which documents exist. The same function runs on the server and in the browser.
//
// SAFETY (tested with hostile finding text): an href is ONLY ever built from
//   - a fixed route template (this file, nowhere else),
//   - a slug made by lib/tax-anchors.ts ([a-z0-9-]),
//   - an id that was looked up in the context (a form id, a document UUID, a decision id the sheet shows, a line the sheet has),
//   - an integer page number.
// Free text of a finding (message, ruleTag, evidence notes, a model's form / line strings) is never copied into an href; it can only
// SELECT something that already exists in the context. Every href is finally checked by isSafeLinkHref.
//
// Wording is owner-facing and plain ("Open on the review sheet: Schedule A line 8a"); nothing here changes the gate or an approval.

import {
  conflictAnchorId,
  decisionAnchorId,
  FORMS_PAGE_ANCHORS,
  lineAnchorId,
  openItemAnchorId,
  questionAnchorId,
  REVIEW_ANCHORS,
  SHEET_ANCHORS,
} from "@/lib/tax-anchors";
import type { FindingArea } from "@/lib/tax-review/types";

// ── Output ────────────────────────────────────────────────────────────────────

/**
 * sheet = the return review sheet; pdf = a filled form (new tab); forms = the Forms page; document = a document's review page or the
 * Documents list; question = a questionnaire; decision = an owner decision on the sheet; jump = a place on THIS (Final review) page.
 */
export type LinkKind = "sheet" | "pdf" | "forms" | "document" | "question" | "decision" | "jump";

export interface FindingLink {
  kind: LinkKind;
  /** Owner-facing text of the link, e.g. "Open on the review sheet: Schedule A line 8a". */
  label: string;
  href: string;
  /** Only the PDF opens in a new tab; everything else stays in this tab. */
  newTab: boolean;
}

// ── Context (plain JSON, built on the server) ─────────────────────────────────

export interface FormLinkInfo {
  /** The form's name as printed ("Schedule A", "Form 8949"). */
  label: string;
  /** The filled-PDF form id when the PDF route can serve it, else null. */
  pdf: string | null;
  /** The id of the form's card on the Forms page (lib/tax-forms.ts), or null when it has no card. */
  card: string | null;
  /** The anchor id of the form's block of lines on the review sheet, or null when the sheet has no lines for it. */
  group: string | null;
}

export interface LinkContext {
  year: 2025;
  /** Line key -> "Schedule A line 8a" for every line that has a row on the review sheet. */
  sheetLines: Record<string, string>;
  /** Decision id ("X1") -> its label and whether a choice is recorded (the card then says "Change decision"), for every decision card on the sheet. */
  decisions: Record<string, { label: string; recorded: boolean }>;
  /** Open item id -> fnv1a(its plain text), for every open item on the sheet. */
  openItems: Record<string, string>;
  /** Anchor ids (conflictAnchorId) of the conflicts on the sheet. */
  conflicts: string[];
  /** Document id -> a short label ("W-2 2025") for every document that feeds the return. */
  documents: Record<string, string>;
  /** Every form key a finding may carry (the PDF form id or the engine's form id) -> what is known about the form. */
  forms: Record<string, FormLinkInfo>;
  /** Line key -> "<pdf form id>:<1-based page>" where the filled form prints the line. */
  linePdf: Record<string, string>;
  /** "<pdf form id>|<short field name>" -> 1-based page, only for fields NOT on page 1. */
  fieldPages: Record<string, number>;
  /** PDF form id -> 1-based page that carries the signature boxes. */
  signaturePages: Record<string, number>;
  /** Engine rule id -> the line keys the rule produces. */
  ruleLines: Record<string, string[]>;
}

/** A context that knows nothing: every finding then falls back to its area's section (never to a dead link). */
export const EMPTY_LINK_CONTEXT: LinkContext = {
  year: 2025,
  sheetLines: {},
  decisions: {},
  openItems: {},
  conflicts: [],
  documents: {},
  forms: {},
  linePdf: {},
  fieldPages: {},
  signaturePages: {},
  ruleLines: {},
};

/** What a finding exposes to this module (a FindingDto and a Finding both fit). */
export interface LinkableFinding {
  check: string;
  area: string;
  formKey?: string | null;
  lineKey?: string | null;
  /** Only present on a finding straight from a run (the database does not store it). */
  ruleTag?: string | null;
  message: string;
  evidence: readonly { ref: string }[];
}

// ── Routes (the ONLY place an href is written) ────────────────────────────────

export const LINK_YEAR = 2025 as const;
const BASE = `/tax/forms/${LINK_YEAR}`;
export const SHEET_PATH = `${BASE}/return`;
export const FORMS_PATH = BASE;
export const FINAL_REVIEW_PATH = `${BASE}/final-review`;
const PDF_BASE = `/api/tax/forms/${LINK_YEAR}/pdf`;
export const DOCUMENTS_LIST_PATH = `/documents?view=tax&year=${LINK_YEAR}`;
export const RETURN_COMPLETENESS_QUESTIONNAIRE = "return-completeness";

/** The consulting business's URL slug (the same constant lib/tax-review-build.ts reads the entity by). */
export const EKC_SLUG = "ek-consulting";
export const PLANNING_PATH = `/tax/personal/${LINK_YEAR}`;
export const FIXED_ASSETS_PATH = `/tax/fixed-assets/${LINK_YEAR}`;
export const DONATIONS_PATH = `/tax/donations/${LINK_YEAR}`;
export const BOOKS_GL_PATH = `/business/${EKC_SLUG}/gl`;
export const BOOKS_MILEAGE_PATH = `/business/${EKC_SLUG}/mileage`;

const sheetHref = (anchor: string): string => `${SHEET_PATH}#${anchor}`;
const formsHref = (anchor: string): string => `${FORMS_PATH}#${anchor}`;
const questionnaireHref = (id: string, nodeId?: string): string => `${BASE}/questionnaire/${id}${nodeId === undefined ? "" : `#${questionAnchorId(nodeId)}`}`;
const documentHref = (id: string): string => `/documents/${id}/review`;
/** `?view=1` asks the route for an inline PDF (so the viewer opens it and honours #page=); without it the route answers an attachment. */
const pdfHref = (formId: string, page: number | null): string => `${PDF_BASE}/${formId}?view=1${page !== null && page > 1 ? `#page=${page}` : ""}`;

/** The last line of defence: an href must be one of the fixed shapes below and carry nothing else. */
const SAFE_HREF = new RegExp(
  [
    `^(?:`,
    `${BASE}(?:/return|/final-review|/questionnaire/[a-z0-9-]{1,60})?(?:#[A-Za-z0-9_-]{1,120})?`,
    `|/documents(?:\\?view=tax&year=${LINK_YEAR}|/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/review)`,
    `|${PDF_BASE}/[a-z0-9]{2,20}\\?view=1(?:#page=[0-9]{1,3})?`,
    `|/tax/(?:personal|fixed-assets|donations)/${LINK_YEAR}`,
    `|/business/${EKC_SLUG}/(?:gl|mileage)`,
    `|#[A-Za-z0-9_-]{1,120}`,
    `)$`,
  ].join(""),
);

export function isSafeLinkHref(href: string): boolean {
  return SAFE_HREF.test(href);
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINE_SHAPE = /^[a-z][a-z0-9]*(?:\.[A-Za-z0-9_]+)+$/;
const FORM_KEY_SHAPE = /^[a-z0-9]{2,20}$/;
const DECISION_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,15}$/;
const MAX_LINKS = 8;
const MAX_LINES = 3;
const MAX_DOCUMENTS = 3;

/** Short clean text for a label: control characters out, collapsed, cut. A label is only ever text, never part of an href. */
function cleanLabel(s: string, max = 60): string {
  const t = s.replace(/[\u0000-\u001f\u007f<>"`]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** A small stable hash (FNV-1a, 32 bit) of whitespace-normalised text: how a stored finding message is matched to an open item of the sheet. */
export function fnv1a(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const linkOf = (kind: LinkKind, label: string, href: string, newTab = false): FindingLink | null => (isSafeLinkHref(href) ? { kind, label, href, newTab } : null);

// ── Named sections ────────────────────────────────────────────────────────────

export type SectionKey = "formsNeedsInput" | "summary" | "federal" | "connecticut" | "decisions" | "openItems" | "documents" | "overrides" | "attestations" | "pdfSection" | "documentsList" | "runChecks" | "gate" | "byHand";

const SECTIONS: Readonly<Record<SectionKey, { kind: LinkKind; label: string; href: string }>> = {
  summary: { kind: "sheet", label: "Open on the review sheet: summary and totals", href: sheetHref(SHEET_ANCHORS.summary) },
  federal: { kind: "sheet", label: "Open on the review sheet: federal return lines", href: sheetHref(SHEET_ANCHORS.federal) },
  connecticut: { kind: "sheet", label: "Open on the review sheet: Connecticut return lines", href: sheetHref(SHEET_ANCHORS.connecticut) },
  decisions: { kind: "sheet", label: "Open on the review sheet: your decisions", href: sheetHref(SHEET_ANCHORS.decisions) },
  openItems: { kind: "sheet", label: "Open on the review sheet: open items", href: sheetHref(SHEET_ANCHORS.openItems) },
  documents: { kind: "sheet", label: "Open on the review sheet: document index", href: sheetHref(SHEET_ANCHORS.documents) },
  overrides: { kind: "sheet", label: "Open on the review sheet: overrides in force", href: sheetHref(SHEET_ANCHORS.overrides) },
  attestations: { kind: "sheet", label: "Open on the review sheet: yes/no questions printed on the return", href: sheetHref(SHEET_ANCHORS.attestations) },
  pdfSection: { kind: "forms", label: "Open the Forms page: filled PDF forms", href: formsHref(FORMS_PAGE_ANCHORS.pdf) },
  formsNeedsInput: { kind: "forms", label: "Open the Forms page: forms that need your input", href: formsHref(FORMS_PAGE_ANCHORS.needsInput) },
  documentsList: { kind: "document", label: "Open the Documents list", href: DOCUMENTS_LIST_PATH },
  runChecks: { kind: "jump", label: "Jump to: run the checks", href: `#${REVIEW_ANCHORS.runChecks}` },
  gate: { kind: "jump", label: "Jump to: what must be green", href: `#${REVIEW_ANCHORS.gate}` },
  byHand: { kind: "jump", label: "Jump to: what you do by hand", href: `#${REVIEW_ANCHORS.byHand}` },
};

export const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];

export function sectionLink(key: SectionKey): FindingLink {
  const s = SECTIONS[key];
  return { kind: s.kind, label: s.label, href: s.href, newTab: false };
}

/** Where a finding goes when nothing more specific can be resolved: the section of its area. Every area has one (a test pins it). */
export const AREA_FALLBACK: Readonly<Record<FindingArea, SectionKey>> = {
  income: "federal",
  adjustments: "federal",
  deductions: "federal",
  credits: "federal",
  payments: "federal",
  tax: "federal",
  state: "connecticut",
  forms: "pdfSection",
  process: "openItems",
  packaging: "pdfSection",
  privacy: "pdfSection",
};

// ── Forms and pages ───────────────────────────────────────────────────────────

function formInfo(ctx: LinkContext, key: string | null | undefined): FormLinkInfo | null {
  if (key === null || key === undefined || !FORM_KEY_SHAPE.test(key) || !has(ctx.forms, key)) return null;
  return ctx.forms[key] ?? null;
}

function parseLinePdf(ctx: LinkContext, lineKey: string): { formId: string; page: number } | null {
  if (!has(ctx.linePdf, lineKey)) return null;
  const v = ctx.linePdf[lineKey] ?? "";
  const at = v.lastIndexOf(":");
  if (at <= 0) return null;
  const formId = v.slice(0, at);
  const page = Number(v.slice(at + 1));
  return FORM_KEY_SHAPE.test(formId) && Number.isInteger(page) && page >= 1 && page <= 999 ? { formId, page } : null;
}

// ── Check rules ───────────────────────────────────────────────────────────────

/** Extras a check family adds on top of what its data already resolves (lines, forms, documents, decisions and conflicts are always resolved from the data). */
export interface LinkExtras {
  /** Which questionnaire the question links go to: derived from the answer the finding names ("answers"), or the Return completeness page ("completeness"). */
  question?: "answers" | "completeness";
  /** Fixed named sections to add. */
  sections?: readonly SectionKey[];
  /** Match the finding to an open item of the sheet. */
  openItem?: boolean;
  /** The finding is about a headline figure: link to the sheet's headline table. */
  headline?: boolean;
  /** Lines the check is about although its finding names none (a fixed list; each is used only when the sheet has it). */
  lines?: readonly string[];
}

export interface LinkRule {
  /** A check id prefix, or a RegExp tested against the whole check id. The FIRST rule that matches is used. */
  match: string | RegExp;
  /** One line: why these targets (documentation for the next person who adds a check). */
  note: string;
  extras: LinkExtras;
}

/**
 * One rule per check family the L1 / L2 / L3 layers can emit. A coverage test enumerates every check id literal in lib/tax-review and fails
 * when one matches no rule here, so a new check cannot ship without a decision about where its link goes.
 */
export const LINK_RULES: readonly LinkRule[] = [
  { match: /^L1\.runner\./, note: "a check could not run or an input was missing: run the checks again", extras: { sections: ["runChecks"] } },

  { match: /^L1\.B1\.(more)$/, note: "more printed-value differences than listed: the filled forms", extras: { sections: ["pdfSection"] } },
  { match: /^L1\.B1\./, note: "a printed value differs from the return: the line, the form page", extras: {} },
  { match: /^L1\.B2\./, note: "ink on a form that should be blank: the form", extras: {} },
  { match: /^L1\.B3\./, note: "a printed line label differs: the line and the form page", extras: {} },
  { match: /^L1\.B4\./, note: "a checkbox or answer differs: the question and the form", extras: { question: "answers", sections: ["attestations"] } },
  { match: /^L1\.B5\./, note: "lines the engine does not model: the form", extras: {} },
  { match: /^L1\.B6\./, note: "the clean copy / final package check: the form and the PDF section", extras: { sections: ["pdfSection"] } },

  { match: /^L1\.C1\.(w2-tips|w2-overtime|w2-deferrals)$/, note: "a W-2 box that the questionnaire contradicts: the document and the question", extras: { question: "completeness" } },
  { match: /^L1\.C1\.(no-documents|doc-unusable|doc-not-reflected|k1|1099b-missing-category|other-boxes|w2-no-person|w2-person|property-tax)$/, note: "a document problem: the document", extras: { sections: ["documentsList"] } },
  { match: /^L1\.C1\./, note: "a document total versus a line: the line and the documents", extras: {} },
  { match: /^L1\.C2\.estimate-repeat$/, note: "an estimated payment repeated: the payment answers", extras: { question: "completeness" } },
  { match: /^L1\.C2\.books-interest$/, note: "interest in the books and on a 1099: the line and the documents", extras: { lines: ["f1040.2b"], sections: ["documentsList"] } },
  { match: /^L1\.C2\./, note: "a possible duplicate document: the documents", extras: { sections: ["documentsList"] } },

  { match: /^L1\.D1\.incomplete$/, note: "the return is not complete: the summary and the open items", extras: { sections: ["summary", "openItems"] } },
  { match: /^L1\.D1\.blocking-item$/, note: "a blocking open item: the item, its lines", extras: { openItem: true, sections: ["openItems"] } },
  { match: /^L1\.D1\.blocked-lines$/, note: "money lines without an amount: the lines and the open items", extras: { sections: ["openItems"] } },
  { match: /^L1\.D2\.decision$/, note: "a decision still at its default: record the decision", extras: {} },
  { match: /^L1\.D2\.conflict$/, note: "two sources disagree: the conflict", extras: { sections: ["openItems"] } },
  { match: /^L1\.D2\.unverified-docs$/, note: "unverified documents: the document index and the documents", extras: { sections: ["documents", "documentsList"] } },
  { match: /^L1\.D2\.derived-inputs$/, note: "inferred inputs: the summary counters", extras: { sections: ["summary"] } },
  { match: /^L1\.D2\.header-answer$/, note: "a yes/no question not answered: the question", extras: { question: "answers", sections: ["attestations"] } },
  { match: /^L1\.D3\./, note: "overrides in force: the line and the overrides panel", extras: { sections: ["overrides"] } },
  { match: /^L1\.D4\.pdf$/, note: "text that looks like an identifier on a form: the form", extras: {} },
  { match: /^L1\.D4\./, note: "text that looks like an identifier on the cover: the filled PDF forms", extras: { sections: ["pdfSection"] } },
  { match: /^L1\.D5\.cover$/, note: "a headline figure shown as 0 on the cover: the summary", extras: { sections: ["summary"] } },
  { match: /^L1\.D5\./, note: "a line shown as 0 instead of blank, or informational: the line", extras: {} },

  { match: /^L1\.E1\./, note: "prior-year comparison: the line and the documents", extras: { sections: ["documentsList"] } },
  { match: /^L1\.E2\./, note: "a figure that looks unusual: the line", extras: {} },

  { match: /^L1\.F1\./, note: "a total that does not foot: the line and the form page", extras: {} },
  { match: /^L1\.F2\.headline\./, note: "a headline that does not match its lines: the lines and the headline", extras: { headline: true } },
  { match: /^L1\.F2\./, note: "a form rule between two lines: the line and the form page", extras: {} },
  { match: /^L1\.F3\./, note: "a form with no footing rule: the form", extras: {} },

  { match: /^L1\.G1\./, note: "a required form the packet cannot contain: the form and the PDF section", extras: { sections: ["pdfSection"] } },
  { match: /^L1\.G2\.by-hand$/, note: "lines that stay blank: the by-hand list", extras: { sections: ["byHand"] } },
  { match: /^L1\.G2\./, note: "how a form is filed: the form and the by-hand list", extras: { sections: ["byHand"] } },

  { match: /^L1\.X1\.headline-/, note: "a headline differs between outputs: the summary", extras: { sections: ["summary"], headline: true } },
  { match: /^L1\.X1\./, note: "two outputs show a different figure for a line: the line on the sheet", extras: {} },

  { match: /^L2\.diff\.head\./, note: "the recalculation differs on a headline: the lines and the headline", extras: { headline: true } },
  { match: /^L2\.diff\./, note: "the recalculation differs on a line: the line and the form page", extras: {} },
  { match: /^L2\.forms\./, note: "the recalculation disagrees about a form: the form and the PDF section", extras: { sections: ["pdfSection"] } },
  { match: /^L2\.coverage$/, note: "what the recalculation covers: the checklist", extras: { sections: ["gate"] } },

  { match: /^L3\./, note: "an AI finding: whatever line, form, document or headline it names (each validated against the return)", extras: { headline: true } },
];

export interface ResolvedRule {
  rule: LinkRule;
  /** false = no explicit rule matched (the generic data-driven links plus the area fallback are used). */
  explicit: boolean;
}

const GENERIC_RULE: LinkRule = { match: /^/, note: "unknown check: data-driven links and the area fallback", extras: {} };

export function linkRuleFor(check: string): ResolvedRule {
  for (const rule of LINK_RULES) {
    const hit = typeof rule.match === "string" ? check.startsWith(rule.match) : rule.match.test(check);
    if (hit) return { rule, explicit: true };
  }
  return { rule: GENERIC_RULE, explicit: false };
}

// ── The finding's data ────────────────────────────────────────────────────────

function lineKeysOf(f: LinkableFinding, ctx: LinkContext): string[] {
  const out: string[] = [];
  const add = (k: string | null | undefined): void => {
    if (k === null || k === undefined || !LINE_SHAPE.test(k) || out.includes(k)) return;
    if (has(ctx.sheetLines, k) || has(ctx.linePdf, k)) out.push(k);
  };
  add(f.lineKey);
  for (const e of f.evidence) {
    const ref = e.ref;
    const colon = ref.indexOf(":");
    if (colon === -1) add(ref);
    else if (ref.startsWith("sheet:") || ref.startsWith("csv:")) add(ref.slice(colon + 1));
  }
  return out;
}

function documentIdsOf(f: LinkableFinding, ctx: LinkContext): string[] {
  const out: string[] = [];
  for (const e of f.evidence) {
    if (!e.ref.startsWith("doc:")) continue;
    const id = e.ref.slice(4);
    if (UUID.test(id) && has(ctx.documents, id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function decisionIdsOf(f: LinkableFinding, ctx: LinkContext): string[] {
  const out: string[] = [];
  const add = (id: string): void => {
    if (DECISION_SHAPE.test(id) && has(ctx.decisions, id) && !out.includes(id)) out.push(id);
  };
  for (const e of f.evidence) if (e.ref.startsWith("check:decision.")) add(e.ref.slice("check:decision.".length));
  if (f.check.startsWith("L1.D2.decision") && f.ruleTag !== null && f.ruleTag !== undefined) add(f.ruleTag);
  return out;
}

/** The link to a decision's card on the sheet: "Record this decision" until a choice is recorded, then "Change this decision" (what the card's own button says). */
export function decisionLink(ctx: LinkContext, id: string): FindingLink | null {
  if (!DECISION_SHAPE.test(id) || !has(ctx.decisions, id)) return null;
  const d = ctx.decisions[id];
  return linkOf("decision", `${d?.recorded === true ? "Change this decision" : "Record this decision"}: ${id} (${cleanLabel(d?.label ?? id, 50)})`, sheetHref(decisionAnchorId(id)));
}

function conflictAnchorsOf(f: LinkableFinding, ctx: LinkContext): string[] {
  const out: string[] = [];
  for (const e of f.evidence) {
    if (!e.ref.startsWith("check:conflict.")) continue;
    const id = conflictAnchorId(e.ref.slice("check:conflict.".length));
    if (ctx.conflicts.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

const BLOCKING_ITEM_PREFIX = /^Blocking item \([^)]*\): /;

function openItemIdOf(f: LinkableFinding, ctx: LinkContext): string | null {
  if (f.ruleTag !== null && f.ruleTag !== undefined && has(ctx.openItems, f.ruleTag)) return f.ruleTag;
  const m = BLOCKING_ITEM_PREFIX.exec(f.message);
  if (m === null) return null;
  const want = fnv1a(f.message.slice(m[0].length));
  for (const [id, h] of Object.entries(ctx.openItems)) if (h === want) return id;
  return null;
}

/** The form keys a finding mentions: its own formKey, `form:<id>` and `pdf:<id>:<field>` evidence. */
function formKeysOf(f: LinkableFinding): string[] {
  const out: string[] = [];
  const add = (k: string | null | undefined): void => {
    if (k !== null && k !== undefined && FORM_KEY_SHAPE.test(k) && !out.includes(k)) out.push(k);
  };
  add(f.formKey);
  for (const e of f.evidence) {
    if (e.ref.startsWith("form:")) add(e.ref.slice(5));
    else if (e.ref.startsWith("pdf:")) add(e.ref.split(":")[1]);
  }
  return out;
}

function fieldPageOf(f: LinkableFinding, ctx: LinkContext): { formId: string; page: number } | null {
  for (const e of f.evidence) {
    if (!e.ref.startsWith("pdf:")) continue;
    const parts = e.ref.split(":");
    const formKey = parts[1];
    const short = parts.slice(2).join(":");
    const info = formInfo(ctx, formKey);
    if (info === null || info.pdf === null || short === "") continue;
    const k = `${info.pdf}|${short}`;
    return { formId: info.pdf, page: has(ctx.fieldPages, k) ? (ctx.fieldPages[k] ?? 1) : 1 };
  }
  return null;
}

const ANSWER_NODES: Readonly<Record<string, { node: string; label: string }>> = {
  "digital-assets": { node: "digital", label: "digital assets" },
  digitalAssets: { node: "digital", label: "digital assets" },
  "foreign-accounts": { node: "foreign", label: "foreign accounts" },
  foreignAccounts: { node: "foreign", label: "foreign accounts" },
  foreignTrust: { node: "foreign", label: "foreign accounts and trusts" },
  fincenRequired: { node: "foreign", label: "foreign accounts" },
};

function questionLinks(f: LinkableFinding, mode: "answers" | "completeness"): FindingLink[] {
  const out: FindingLink[] = [];
  if (mode === "answers") {
    for (const e of f.evidence) {
      if (!e.ref.startsWith("check:answer.")) continue;
      const hit = ANSWER_NODES[e.ref.slice("check:answer.".length)];
      if (hit === undefined) continue;
      const l = linkOf("question", `Answer this question: ${hit.label}`, questionnaireHref(RETURN_COMPLETENESS_QUESTIONNAIRE, hit.node));
      if (l !== null && !out.some((x) => x.href === l.href)) out.push(l);
    }
    if (out.length > 0) return out;
  }
  const page = linkOf("question", "Answer this question: Return completeness questions", questionnaireHref(RETURN_COMPLETENESS_QUESTIONNAIRE));
  return page === null ? [] : [page];
}

function headlineSection(f: LinkableFinding): FindingLink[] {
  const out: FindingLink[] = [];
  for (const e of f.evidence) {
    if (!e.ref.startsWith("head:")) continue;
    const key = e.ref.slice(5).toLowerCase();
    const ct = key.startsWith("connecticut") || key.startsWith("ct ") || key.startsWith("ct");
    const l = linkOf("sheet", ct ? "Open on the review sheet: Connecticut totals" : "Open on the review sheet: federal totals", sheetHref(ct ? SHEET_ANCHORS.headlineConnecticut : SHEET_ANCHORS.headlineFederal));
    if (l !== null && !out.some((x) => x.href === l.href)) out.push(l);
  }
  return out;
}

// ── findingLinks ──────────────────────────────────────────────────────────────

/**
 * The links for one finding, most useful first: an action (record the decision, answer the question, the open item), the lines on the
 * review sheet, the printed form (PDF, on the right page when known) and its Forms page card, the documents, then the named sections the
 * check family adds. A finding with nothing resolvable gets the section of its area, so there is always at least one link.
 */
export function findingLinks(f: LinkableFinding, ctx: LinkContext): FindingLink[] {
  const { rule } = linkRuleFor(f.check);
  const out: FindingLink[] = [];
  const push = (l: FindingLink | null): void => {
    if (l !== null && out.length < MAX_LINKS && !out.some((x) => x.href === l.href)) out.push(l);
  };

  // 1. actions
  for (const id of decisionIdsOf(f, ctx)) push(decisionLink(ctx, id));
  if (rule.extras.question !== undefined) for (const l of questionLinks(f, rule.extras.question)) push(l);
  if (rule.extras.openItem === true) {
    const id = openItemIdOf(f, ctx);
    if (id !== null) push(linkOf("sheet", "Open on the review sheet: this open item", sheetHref(openItemAnchorId(id))));
  }
  for (const a of conflictAnchorsOf(f, ctx)) push(linkOf("sheet", "Open on the review sheet: this conflict between sources", sheetHref(a)));

  // 2. lines on the sheet
  const lines = lineKeysOf(f, ctx);
  for (const k of rule.extras.lines ?? []) if (!lines.includes(k) && (has(ctx.sheetLines, k) || has(ctx.linePdf, k))) lines.push(k);
  let federalFallback = false;
  let ctFallback = false;
  for (const k of lines.slice(0, MAX_LINES)) {
    if (has(ctx.sheetLines, k)) push(linkOf("sheet", `Open on the review sheet: ${cleanLabel(ctx.sheetLines[k] ?? k, 70)}`, sheetHref(lineAnchorId(k))));
    else if (k.startsWith("ct1040.")) ctFallback = true;
    else federalFallback = true;
  }
  if (federalFallback) push(sectionLink("federal"));
  if (ctFallback) push(sectionLink("connecticut"));
  if (rule.extras.headline === true) for (const l of headlineSection(f)) push(l);

  // 3. the printed form: a named PDF field first, then the first line's page, then the form itself
  const forms = formKeysOf(f).map((k) => formInfo(ctx, k)).filter((x): x is FormLinkInfo => x !== null);
  let pdf: { formId: string; page: number | null } | null = fieldPageOf(f, ctx);
  if (pdf === null) {
    for (const k of lines) {
      const hit = parseLinePdf(ctx, k);
      if (hit !== null) {
        pdf = hit;
        break;
      }
    }
  }
  if (pdf === null) {
    const first = forms.find((x) => x.pdf !== null);
    if (first !== undefined && first.pdf !== null) pdf = { formId: first.pdf, page: null };
  }
  let pdfInfo: FormLinkInfo | null = null;
  if (pdf !== null) {
    pdfInfo = Object.values(ctx.forms).find((x) => x.pdf === pdf?.formId) ?? null;
    const name = pdfInfo?.label ?? pdf.formId;
    const where = pdf.page !== null && pdf.page > 1 ? `PDF, page ${pdf.page}` : "PDF";
    push(linkOf("pdf", `Open the form: ${cleanLabel(name, 40)} (${where})`, pdfHref(pdf.formId, pdf.page), true));
  }
  // the form's block on the sheet (when the finding has no line of its own) and its Forms page card
  const lead = pdfInfo ?? forms[0] ?? null;
  if (lines.length === 0 && lead !== null && lead.group !== null) push(linkOf("sheet", `Open on the review sheet: ${cleanLabel(lead.label, 40)}`, sheetHref(lead.group)));
  if (lead !== null && lead.card !== null) push(linkOf("forms", `Open the Forms page card: ${cleanLabel(lead.label, 40)}`, formsHref(lead.card)));

  // 4. documents
  const docs = documentIdsOf(f, ctx);
  for (const id of docs.slice(0, MAX_DOCUMENTS)) push(linkOf("document", `Open the document: ${cleanLabel(ctx.documents[id] ?? "document", 50)}`, documentHref(id)));

  // 5. sections the check family adds
  for (const s of rule.extras.sections ?? []) push(sectionLink(s));

  // 6. never a dead end
  if (out.length === 0) push(sectionLink(has(AREA_FALLBACK, f.area) ? AREA_FALLBACK[f.area as FindingArea] : "openItems"));
  return out;
}

// ── The judgments register ────────────────────────────────────────────────────

/** Where each "not verified in specs/09" register item points (the register ids come from lib/tax-review/llm/register.ts SPEC09_ITEMS). */
export const SPEC09_TARGETS: Readonly<Record<string, { lines?: readonly string[]; decisions?: readonly string[]; formKey?: string; question?: boolean }>> = {
  charitable_agi_limits: { lines: ["scha.11", "scha.12", "scha.13", "scha.14"] },
  mortgage_points: { lines: ["scha.8a", "scha.8c"] },
  ct_ss_pension_worksheets: { lines: ["ct1040.ctAgi"], question: true },
  home_office_actual_and_depreciation: { decisions: ["X1", "X2"], formKey: "f8829" },
  se_health_insurance_eligibility: { lines: ["sch1.17"], formKey: "f7206", question: true },
  form_2210_annualized: { formKey: "f2210" },
};

export interface LinkableRegisterEntry {
  id: string;
  origin?: string;
}

/** Links for one entry of the judgments register (decision, rule, answer, informational line, unverified-law item). */
export function registerLinks(entry: LinkableRegisterEntry, ctx: LinkContext): FindingLink[] {
  const out: FindingLink[] = [];
  const push = (l: FindingLink | null): void => {
    if (l !== null && out.length < MAX_LINKS && !out.some((x) => x.href === l.href)) out.push(l);
  };
  const colon = entry.id.indexOf(":");
  const kind = colon === -1 ? "" : entry.id.slice(0, colon);
  const rest = colon === -1 ? "" : entry.id.slice(colon + 1);
  const lineLinks = (keys: readonly string[]): void => {
    for (const k of keys.filter((x) => LINE_SHAPE.test(x) && (has(ctx.sheetLines, x) || has(ctx.linePdf, x))).slice(0, MAX_LINES)) {
      if (has(ctx.sheetLines, k)) push(linkOf("sheet", `Open on the review sheet: ${cleanLabel(ctx.sheetLines[k] ?? k, 70)}`, sheetHref(lineAnchorId(k))));
    }
    const first = keys.map((k) => (LINE_SHAPE.test(k) ? parseLinePdf(ctx, k) : null)).find((x) => x !== null);
    if (first !== undefined && first !== null) {
      const info = Object.values(ctx.forms).find((x) => x.pdf === first.formId);
      push(linkOf("pdf", `Open the form: ${cleanLabel(info?.label ?? first.formId, 40)} (${first.page > 1 ? `PDF, page ${first.page}` : "PDF"})`, pdfHref(first.formId, first.page), true));
    }
  };
  const decisionOf = (id: string): void => push(decisionLink(ctx, id));
  const cardLink = (formKey: string | undefined): void => {
    const info = formInfo(ctx, formKey);
    if (info !== null && info.card !== null) push(linkOf("forms", `Open the Forms page card: ${cleanLabel(info.label, 40)}`, formsHref(info.card)));
  };

  if (kind === "decision") {
    decisionOf(rest);
  } else if (kind === "rule") {
    lineLinks(has(ctx.ruleLines, rest) ? (ctx.ruleLines[rest] ?? []) : []);
  } else if (kind === "answer") {
    for (const l of questionLinks({ check: "", area: "process", message: "", evidence: [] }, "completeness")) push(l);
  } else if (kind === "info") {
    lineLinks([rest]);
  } else if (kind === "spec09" && has(SPEC09_TARGETS, rest)) {
    const t = SPEC09_TARGETS[rest];
    for (const d of t?.decisions ?? []) decisionOf(d);
    lineLinks(t?.lines ?? []);
    cardLink(t?.formKey);
    if (t?.question === true) for (const l of questionLinks({ check: "", area: "process", message: "", evidence: [] }, "completeness")) push(l);
  }
  if (out.length === 0) push(sectionLink(kind === "answer" ? "openItems" : "decisions"));
  return out;
}

// ── "To do by hand" and the information cards ─────────────────────────────────

interface ByHandTarget {
  match: RegExp;
  /** [formId, line keys on the sheet]; null = nothing to open (the item is about something the app never holds). */
  target: { lines?: readonly string[]; pdf?: string; signature?: string; sections?: readonly SectionKey[] } | null;
}

/** Where each "To do by hand" item points. Every entry of BY_HAND (lib/tax2025/pdf/final-package.ts) is covered by a test. */
export const BY_HAND_TARGETS: readonly ByHandTarget[] = [
  { match: /^Social security numbers/, target: { pdf: "f1040" } },
  { match: /^Employer identification numbers/, target: { sections: ["pdfSection"] } },
  { match: /^Dates of birth/, target: { pdf: "f1040" } },
  { match: /^Bank routing and account numbers/, target: { pdf: "f1040", lines: ["f1040.35a"] } },
  { match: /^Identity protection PINs/, target: { signature: "f1040" } },
  { match: /^Signatures and signing dates/, target: { signature: "f1040" } },
  { match: /^Occupations, phone numbers/, target: { signature: "f1040" } },
  { match: /^Form 1040 lines 35a and 36/, target: { lines: ["f1040.35a", "f1040.36"], pdf: "f1040" } },
  { match: /^Form 1040 line 7b/, target: { lines: ["f1040.7b"], pdf: "f1040" } },
  { match: /^CT-1040 lines 23, 24 and 24a/, target: { lines: ["ct1040.23", "ct1040.24"], pdf: "ct1040" } },
];

/** Links for one "To do by hand" item. An item with no target (or a target the context cannot resolve) gets none: it is about paper the app does not hold. */
export function byHandLinks(text: string, ctx: LinkContext): FindingLink[] {
  const hit = BY_HAND_TARGETS.find((t) => t.match.test(text));
  if (hit === undefined || hit.target === null) return [];
  const t = hit.target;
  const out: FindingLink[] = [];
  const push = (l: FindingLink | null): void => {
    if (l !== null && out.length < MAX_LINKS && !out.some((x) => x.href === l.href)) out.push(l);
  };
  for (const k of t.lines ?? []) if (has(ctx.sheetLines, k)) push(linkOf("sheet", `Open on the review sheet: ${cleanLabel(ctx.sheetLines[k] ?? k, 70)}`, sheetHref(lineAnchorId(k))));
  const formId = t.signature ?? t.pdf;
  const info = formId === undefined ? null : (Object.values(ctx.forms).find((x) => x.pdf === formId) ?? null);
  if (formId !== undefined && info !== null) {
    const sig = t.signature !== undefined && has(ctx.signaturePages, formId) ? (ctx.signaturePages[formId] ?? null) : null;
    const lineHit = (t.lines ?? []).map((k) => parseLinePdf(ctx, k)).find((x) => x !== null);
    const page = sig ?? (lineHit?.formId === formId ? lineHit.page : null);
    push(linkOf("pdf", `Open the form: ${cleanLabel(info.label, 40)} (${page !== null && page > 1 ? `PDF, page ${page}` : "PDF"})`, pdfHref(formId, page), true));
  }
  for (const s of t.sections ?? []) push(sectionLink(s));
  return out;
}

/** Where each "information card" statement points (ids from lib/tax-review/info-cards.ts). A statement about outside rules has no target. */
export const INFO_TARGETS: Readonly<Record<string, { pdf?: string; signature?: string; lines?: readonly string[]; sections?: readonly SectionKey[] } | null>> = {
  fed_joint_sign: { signature: "f1040" },
  fed_paper_handwritten: { signature: "f1040" },
  fed_efile_pin_joint: { signature: "f1040" },
  fed_form_8453: null,
  fed_8949_statement: { pdf: "f8949", sections: ["byHand"] },
  fed_direct_pay: { lines: ["f1040.37"], pdf: "f1040" },
  fed_free_file: null,
  ct_joint_sign: { signature: "ct1040" },
  ct_joint_liability: { signature: "ct1040" },
  keep_records: { sections: ["documentsList"] },
  amend: null,
  amend_deadline: null,
};

/** Links for one information-card statement. */
export function infoLinks(statementId: string, ctx: LinkContext): FindingLink[] {
  if (!has(INFO_TARGETS, statementId)) return [];
  const t = INFO_TARGETS[statementId];
  if (t === null || t === undefined) return [];
  const out: FindingLink[] = [];
  const push = (l: FindingLink | null): void => {
    if (l !== null && out.length < MAX_LINKS && !out.some((x) => x.href === l.href)) out.push(l);
  };
  for (const k of t.lines ?? []) if (has(ctx.sheetLines, k)) push(linkOf("sheet", `Open on the review sheet: ${cleanLabel(ctx.sheetLines[k] ?? k, 70)}`, sheetHref(lineAnchorId(k))));
  const formId = t.signature ?? t.pdf;
  const info = formId === undefined ? null : (Object.values(ctx.forms).find((x) => x.pdf === formId) ?? null);
  if (formId !== undefined && info !== null) {
    const page = t.signature !== undefined && has(ctx.signaturePages, formId) ? (ctx.signaturePages[formId] ?? null) : null;
    push(linkOf("pdf", `Open the form: ${cleanLabel(info.label, 40)} (${page !== null && page > 1 ? `PDF, page ${page}` : "PDF"})`, pdfHref(formId, page), true));
  }
  for (const s of t.sections ?? []) push(sectionLink(s));
  return out;
}

// ── The gate checklist ────────────────────────────────────────────────────────

/** The hash grammar of the findings filter: "#findings-gating", "#findings-gating-l1" ... (ui.ts filtersFromHash reads it). */
export const FINDINGS_HASH = {
  all: "findings-all",
  gating: "findings-gating",
  gatingL1: "findings-gating-l1",
  gatingL2: "findings-gating-l2",
  gatingL3: "findings-gating-l3",
} as const;

/** The window event a "findings" jump sends so the findings table applies the filter even when the URL fragment does not change. */
export const REVIEW_FILTER_EVENT = "tax-review:filter";

export interface GateJumpInput {
  items: readonly { id: string; state: "pass" | "fail" | "not_run"; detail: string }[];
  /** The findings of the run the gate reads (open ones are used). */
  findings: readonly (LinkableFinding & { status: "open" | "accepted"; gating: boolean; layer: string })[];
}

const jump = (label: string, hash: string): FindingLink => ({ kind: "jump", label, href: `#${hash}`, newTab: false });

/** For each gate row that is not green: the places to go to fix it. Nothing here changes the gate. */
export function gateLinks(input: GateJumpInput, ctx: LinkContext): Record<string, FindingLink[]> {
  const out: Record<string, FindingLink[]> = {};
  const open = input.findings.filter((f) => f.status === "open");
  for (const item of input.items) {
    if (item.state === "pass") continue;
    const links: FindingLink[] = [];
    const push = (l: FindingLink | null): void => {
      if (l !== null && links.length < MAX_LINKS && !links.some((x) => x.href === l.href)) links.push(l);
    };
    if (item.id === "fingerprint") {
      push(sectionLink("runChecks"));
    } else if (item.id === "engine") {
      push(sectionLink("openItems"));
      if (/override/i.test(item.detail)) push(sectionLink("overrides"));
    } else if (item.id === "l1" || item.id === "l2" || item.id === "l3") {
      const layer = item.id.toUpperCase();
      const what = item.id === "l1" ? "deterministic-check" : item.id === "l2" ? "independent-recalculation" : "AI-review";
      if (item.state === "not_run") {
        push(item.id === "l3" ? jump("Jump to: the AI review step", REVIEW_ANCHORS.aiReview) : sectionLink("runChecks"));
      } else {
        const hash = item.id === "l1" ? FINDINGS_HASH.gatingL1 : item.id === "l2" ? FINDINGS_HASH.gatingL2 : FINDINGS_HASH.gatingL3;
        push(jump(`Jump to: the ${what} items that block approval`, hash));
        // fixable right now: decisions at their default, unanswered questions, open blocking items
        const fixable = open.filter((f) => f.layer === layer && f.gating);
        let n = 0;
        for (const f of fixable) {
          for (const l of findingLinks(f, ctx).filter((x) => x.kind === "decision" || x.kind === "question" || (x.kind === "sheet" && x.label.endsWith("this open item")))) {
            if (n < 6 && !links.some((x) => x.href === l.href)) {
              push(l);
              n += 1;
            }
          }
        }
      }
    } else if (item.id === "verdict") {
      push(jump("Jump to: every open item that blocks approval", FINDINGS_HASH.gating));
    }
    if (links.length > 0) out[item.id] = links;
  }
  return out;
}

// ── Sources (refs) of an open item or of one side of a conflict ──────────────

export interface LinkRefLike {
  kind: string;
  id: string;
  label: string;
}

const NODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const GROUP_SHAPE = /^[a-z][a-z0-9_]{1,40}$/;

const questionLink = (label: string, nodeId?: string): FindingLink | null => linkOf("question", `Answer this question: ${cleanLabel(label.replace(/_/g, " "), 60)}`, questionnaireHref(RETURN_COMPLETENESS_QUESTIONNAIRE, nodeId));

/**
 * The link for ONE source the engine attached to an item or a conflict candidate: a document -> its review screen, an answer -> the
 * question, a books entry -> the books, a planning answer -> the planning questions, a decision -> its card. Anything else (a constant,
 * an unknown kind, an id that is not in the context) gives no link.
 */
export function refLink(ref: LinkRefLike, ctx: LinkContext): FindingLink | null {
  switch (ref.kind) {
    case "document":
    case "paystub":
      // the source's own name ("1099-INT from <payer>") tells apart several documents of one kind; the context's short label is the fallback
      if (UUID.test(ref.id) && has(ctx.documents, ref.id)) return linkOf("document", `Open the document: ${cleanLabel(ref.label !== "" ? ref.label : (ctx.documents[ref.id] ?? "document"), 60)}`, documentHref(ref.id));
      return ref.kind === "paystub" ? sectionLink("documentsList") : null;
    case "questionnaire": {
      const rc = `${RETURN_COMPLETENESS_QUESTIONNAIRE}.`;
      if (ref.id.startsWith(rc) && NODE_SHAPE.test(ref.id.slice(rc.length))) return questionLink(ref.label, ref.id.slice(rc.length));
      if (ref.id.startsWith("none:") && GROUP_SHAPE.test(ref.id.slice(5))) return questionLink(ref.id.slice(5).replace(/_/g, " "), `g_${ref.id.slice(5)}`);
      return questionLink(ref.label);
    }
    case "planning":
      return linkOf("question", `Answer this question: ${cleanLabel(ref.label, 50)} (planning questions)`, PLANNING_PATH);
    case "gl":
      return linkOf("document", `Open the books: GL accounts of EK Consulting${ref.label !== "" ? ` (${cleanLabel(ref.label, 40)})` : ""}`, BOOKS_GL_PATH);
    case "mileage":
      return linkOf("document", "Open the books: mileage of EK Consulting", BOOKS_MILEAGE_PATH);
    case "fixed_asset":
      return linkOf("document", "Open the fixed assets", FIXED_ASSETS_PATH);
    case "donation":
      return linkOf("document", "Open the donation log", DONATIONS_PATH);
    case "decision":
      return decisionLink(ctx, ref.id);
    default:
      return null;
  }
}

// ── Open items of the review sheet ────────────────────────────────────────────

export interface LinkableOpenItem {
  id: string;
  /** routeOpenItem: "owner" = an answer / verification / upload only the owner can give; "cpa" = the owner's own decision (legacy identifier); "derived" = nothing to do. */
  who: string;
  lines: readonly { key: string }[];
  refs: readonly LinkRefLike[];
}

export interface OpenItemExtras {
  /** The question the item id itself names: "none:<group>" -> that group's question, "attest:digital|foreign" -> that header question. */
  node?: "none" | "attest";
  /** A page-level question link: the Return completeness questions, or the planning questions. */
  question?: "completeness" | "planning";
  /** The item id carries the id(s) of the document(s) it is about (after the first colon). */
  docFromId?: boolean;
  /** The item is about the consulting business's books (GL accounts). */
  books?: boolean;
  /** The fix is a document that is not on file yet or has to be re-read: the Documents page (upload, review). */
  upload?: boolean;
  /** The fix is to look at the documents already on file (confirm an address, a figure): the Documents list. */
  documents?: boolean;
  /** The id names a header question without saying which ("schd-digital-answer"): the digital assets question. */
  attestNode?: "digital" | "foreign";
  /** The form whose Forms-page card and printed form the item is about, when it names no line of its own. */
  form?: string;
  /** Named sections of the sheet / Forms page. */
  sections?: readonly SectionKey[];
  /** The id names an owner decision ("decision:X1"). */
  decision?: boolean;
}

export interface OpenItemRule {
  match: RegExp;
  note: string;
  extras: OpenItemExtras;
}

/**
 * One rule per family of open-item ids the engine can emit (lib/tax2025/return.ts, resolve-facts.ts, rules/schedule-d.ts, overrides.ts).
 * A coverage test scans those files for every id and fails when one matches no rule, so a new item cannot ship without a decision about where
 * its link goes. Whatever else the item carries (its lines, its sources) is always resolved from the item's own data.
 */
export const OPEN_ITEM_RULES: readonly OpenItemRule[] = [
  { match: /^decision:/, note: "a decision still at its default: record it", extras: { decision: true } },
  { match: /^rule:/, note: "a rule that needs an input or a judgment: its lines, the form, and the owner's question", extras: {} },
  { match: /^info:/, note: "a line that is deliberately not estimated: the line and the form", extras: {} },
  { match: /^none:/, note: "a 'none of these' statement: that group's question", extras: { node: "none" } },
  { match: /^attest:/, note: "a yes/no question printed on the return: that question", extras: { node: "attest", sections: ["attestations"] } },
  { match: /^state-refund-worksheet$/, note: "the state refund worksheet: its line and the 1099-G", extras: { upload: true } },
  { match: /^solar-5695$/, note: "no 2025 clean energy credit: Schedule 3 line", extras: { form: "f1040s3" } },
  { match: /^assumptions-no-ct-sales-tax-or-other$/, note: "standing assumption: the forms that need the owner's input", extras: { sections: ["formsNeedsInput"] } },
  { match: /^books-interest-routed$/, note: "interest in the books: the books", extras: { books: true } },
  { match: /^scha-mortgage-insurance-not-deductible$/, note: "mortgage insurance: the Schedule A line and the 1098", extras: { upload: true } },
  { match: /^(ct-schedule1-other-specify|sch1a-owner-statements|niit-sch-c-nonpassive|niit-allocation-9b|qbi-carryforward-out|other-income-allocation)$/, note: "a statement the owner gives in the Return completeness questions", extras: { question: "completeness" } },
  { match: /^schd-(reconciliation:|unread$|other-sales$)/, note: "Schedule D / Form 8949 does not tie to the broker documents: the lines, Form 8949 and the documents", extras: { form: "f8949", upload: true } },
  { match: /^schd-(adjustments-owner|1256-or-1099da|special-rates)$/, note: "a capital-gain statement only the owner can give: the lines and the question", extras: { form: "f8949", question: "completeness" } },
  { match: /^schd-digital-answer$/, note: "the digital assets answer drives Schedule D: that question", extras: { form: "f8949", attestNode: "digital" } },
  { match: /^schd-/, note: "Schedule D / Form 8949 explanation: the lines and Form 8949", extras: { form: "f8949" } },
  { match: /^doc-duplicate:/, note: "two documents that look the same: both documents", extras: { docFromId: true } },
  { match: /^(doc-unverified|doc-legacy|w2-unusable|w2-no-person|w2-non-ct-state|legacy-1099-withholding|broker-summary-unread|broker-row-incomplete|form1098-no-interest|bill-no-paid|bill-unclassified):/, note: "a problem with one document: that document", extras: { docFromId: true } },
  { match: /^w2-no-ein:/, note: "a W-2 without an employer ID: the documents", extras: { upload: true } },
  { match: /^(form1098-multiple-properties|no-second-property-bill|prior-year-return|paystub-withholding-not-added)$/, note: "a document that is missing or needs a look: the Documents page", extras: { upload: true } },
  { match: /^primary-residence-derived$/, note: "an address taken from a document: the documents on file", extras: { documents: true } },
  { match: /^(other-income-boxes|dividend-boxes-2b-2d|interest-box3|foreign-tax-paid)$/, note: "a 1099 box the app does not read: the documents and the question", extras: { question: "completeness", upload: true } },
  { match: /^(filing-status-unanswered|filing-status-not-mfj)$/, note: "filing status: the planning questions", extras: { question: "planning" } },
  { match: /^estimates-combined-unsplittable$/, note: "estimated payments given as one figure: the question that holds them", extras: { question: "completeness" } },
  { match: /^schedule-c-owner-(unknown|derived)$/, note: "who owns the consulting business: Schedule C", extras: { form: "f1040sc" } },
  { match: /^(ekc-uncoded-transactions|gl-sign-flip:)/, note: "bookkeeping of the consulting business: the GL accounts", extras: { books: true } },
  { match: /^return-completeness-(not-started|stale)$|^rc-person-unmatched:/, note: "the Return completeness questions", extras: { question: "completeness" } },
  { match: /^override-/, note: "an override on the sheet: the overrides panel", extras: { sections: ["overrides"] } },
];

export function openItemRuleFor(id: string): { rule: OpenItemRule; explicit: boolean } {
  const rule = OPEN_ITEM_RULES.find((r) => r.match.test(id));
  return rule === undefined ? { rule: { match: /^/, note: "unknown item: the lines, the sources and the fallback", extras: {} }, explicit: false } : { rule, explicit: true };
}

const ATTEST_NODES: Readonly<Record<string, { node: string; label: string }>> = {
  digital: { node: "digital", label: "digital assets" },
  foreign: { node: "foreign", label: "foreign accounts and trusts" },
};

/** Links for the lines an item names: their rows on the sheet, then the printed form (on the line's page) and its Forms-page card. */
function lineLinksFor(keys: readonly string[], ctx: LinkContext, label: string, push: (l: FindingLink | null) => void): { pdfDone: boolean } {
  let federalFallback = false;
  let ctFallback = false;
  const known = keys.filter((k) => LINE_SHAPE.test(k) && (has(ctx.sheetLines, k) || has(ctx.linePdf, k)));
  for (const k of known.slice(0, MAX_LINES)) {
    if (has(ctx.sheetLines, k)) push(linkOf("sheet", `${label}: ${cleanLabel(ctx.sheetLines[k] ?? k, 70)}`, sheetHref(lineAnchorId(k))));
    else if (k.startsWith("ct1040.")) ctFallback = true;
    else federalFallback = true;
  }
  if (federalFallback) push(sectionLink("federal"));
  if (ctFallback) push(sectionLink("connecticut"));
  const first = known.map((k) => parseLinePdf(ctx, k)).find((x) => x !== null);
  if (first !== undefined && first !== null) {
    const info = Object.values(ctx.forms).find((x) => x.pdf === first.formId);
    push(linkOf("pdf", `Open the form: ${cleanLabel(info?.label ?? first.formId, 40)} (${first.page > 1 ? `PDF, page ${first.page}` : "PDF"})`, pdfHref(first.formId, first.page), true));
    if (info?.card !== null && info?.card !== undefined) push(linkOf("forms", `Open the Forms page card: ${cleanLabel(info.label, 40)}`, formsHref(info.card)));
    return { pdfDone: true };
  }
  return { pdfDone: false };
}

const MAX_ITEM_LINKS = 7;

/**
 * Where to go to answer or resolve one open item (also used for the matching owner-homework entry, which is the same item): the lines it
 * names on the sheet, the printed form and its card, the documents and answers it was built from, a decision's card, the questions, the books,
 * or the Documents page. An item with nothing resolvable still gets one link (the owner's questions, or the Forms page), never a dead end.
 */
export function openItemLinks(item: LinkableOpenItem, ctx: LinkContext): FindingLink[] {
  const { rule } = openItemRuleFor(item.id);
  const x = rule.extras;
  const out: FindingLink[] = [];
  const push = (l: FindingLink | null): void => {
    if (l !== null && out.length < MAX_ITEM_LINKS && !out.some((y) => y.href === l.href)) out.push(l);
  };
  const colon = item.id.indexOf(":");
  const rest = colon === -1 ? "" : item.id.slice(colon + 1);

  // 1. what the item asks for
  if (x.decision === true) push(decisionLink(ctx, rest));
  if (x.node === "none" && GROUP_SHAPE.test(rest)) push(questionLink(rest.replace(/_/g, " "), `g_${rest}`));
  if (x.attestNode !== undefined) {
    const a = ATTEST_NODES[x.attestNode];
    if (a !== undefined) push(questionLink(a.label, a.node));
  }
  if (x.node === "attest" && has(ATTEST_NODES, rest)) {
    const a = ATTEST_NODES[rest];
    if (a !== undefined) push(questionLink(a.label, a.node));
  }
  if (x.docFromId === true) {
    for (const part of rest.split(":")) if (UUID.test(part) && has(ctx.documents, part)) push(linkOf("document", `Open the document: ${cleanLabel(ctx.documents[part] ?? "document", 50)}`, documentHref(part)));
  }

  // 2. the lines the item names, then the printed form
  const lineKeys = item.lines.map((l) => l.key);
  const keys = lineKeys.length > 0 ? lineKeys : item.id.startsWith("info:") && LINE_SHAPE.test(rest) ? [rest] : [];
  const { pdfDone } = lineLinksFor(keys, ctx, "Open the line on the sheet", push);
  if (!pdfDone && x.form !== undefined) {
    const info = formInfo(ctx, x.form);
    if (info !== null) {
      if (info.pdf !== null) push(linkOf("pdf", `Open the form: ${cleanLabel(info.label, 40)} (PDF)`, pdfHref(info.pdf, null), true));
      if (info.card !== null) push(linkOf("forms", `Open the Forms page card: ${cleanLabel(info.label, 40)}`, formsHref(info.card)));
    }
  }

  // 3. the sources the engine attached
  for (const r of item.refs) push(refLink(r, ctx));

  // 4. fixed extras of the family
  if (x.question === "completeness") push(questionLink("Return completeness questions"));
  if (x.question === "planning") push(linkOf("question", "Answer this question: planning questions", PLANNING_PATH));
  if (x.books === true) push(linkOf("document", "Open the books: GL accounts of EK Consulting", BOOKS_GL_PATH));
  if (x.upload === true) push(linkOf("document", "Upload a document: Documents page", DOCUMENTS_LIST_PATH));
  if (x.documents === true) push(sectionLink("documentsList"));
  for (const s of x.sections ?? []) push(sectionLink(s));

  // 5. an item the owner must answer always has somewhere to answer it; anything else has the Forms page
  if (out.length === 0) push(item.who === "owner" ? questionLink("Return completeness questions") : sectionLink("formsNeedsInput"));
  return out;
}

// ── Conflicts between sources ─────────────────────────────────────────────────

export interface LinkableConflict {
  factKey: string;
  candidates: readonly { refs: readonly LinkRefLike[] }[];
}

/** One link per source that disagrees (the document's review screen, the answer, the books entry ...); with none resolvable, the Forms page. */
export function conflictLinks(conflict: LinkableConflict, ctx: LinkContext): FindingLink[] {
  const out: FindingLink[] = [];
  const push = (l: FindingLink | null): void => {
    if (l !== null && out.length < MAX_ITEM_LINKS && !out.some((y) => y.href === l.href)) out.push(l);
  };
  for (const c of conflict.candidates) for (const r of c.refs) push(refLink(r, ctx));
  if (out.length === 0) push(sectionLink("formsNeedsInput"));
  return out;
}
