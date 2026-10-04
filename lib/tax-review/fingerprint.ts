// Return fingerprint v2 (plan section 5.2): binds a review run, an approval and a clean-copy download to EXACTLY ONE
// state of the return. The PDF view's own fingerprint (adapter.ts) already covers the effective lines, open items,
// decisions, headline, tables, forms-required and override metadata; v2 adds everything that can change a printed
// number without changing those: the engine version, the household answers behind the checkboxes, the printed
// names, the resolved facts, the document set and its effective extraction (owner corrections / re-verification),
// the questionnaire answers and the override rows.
//
// PURE: no DB, no clock. The loaders hand over plain rows; only digests are kept, so a fingerprint (and its stored
// parts) never contains a value, a name or a document's text.

import { canonicalJson, fingerprintOf } from "@/lib/tax2025/pdf/format";
import { sha256Hex } from "@/lib/tax-review/types";

export const FINGERPRINT_VERSION = 2;

/** The effective facts of one document as the engine saw them (a RawDocument subset; extractionData is digested, never kept). */
export interface FingerprintDocumentInput {
  id: string;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  verified: boolean;
  legacyFormat: boolean;
  reextractIncomplete?: boolean;
  subjectType: string | null;
  subjectUserId: string | null;
  /** The EFFECTIVE extraction (owner corrections overlaid), exactly what the engine read. */
  extractionData: unknown;
}

export interface FingerprintQuestionnaireInput {
  questionnaireId: string;
  definitionVersion: number | string | null;
  /** The stored answers (JSON). */
  answers: unknown;
}

/** An override row as stored; the free-text reason is NOT hashed here (the view fingerprint covers it). */
export interface FingerprintOverrideInput {
  id: string;
  version: number;
  targetKind: string;
  targetKey: string;
  valueKind: string;
  valueCents: number | null;
  valueText: string | null;
  authority: string;
  archivedAt: Date | string | null;
}

export interface FingerprintInput {
  engineVersion: string;
  /** PdfReturnView.fingerprint. */
  viewFingerprint: string;
  /** PdfReturnView.answers. */
  answers: unknown;
  /** PdfReturnView.header (the names printed on the forms). */
  header: unknown;
  /** Ty2025Facts (JSON-safe). Only its digest is kept. */
  facts: unknown;
  documents: readonly FingerprintDocumentInput[];
  questionnaires: readonly FingerprintQuestionnaireInput[];
  overrides: readonly FingerprintOverrideInput[];
  /** The decisions in force (PdfReturnView.decisions or Ty2025Return.decisions). */
  decisions: unknown;
}

/** Digest of each input group: stored on the run so "what changed since the review" can be named without any value. */
export interface FingerprintParts {
  engine: string;
  view: string;
  answers: string;
  header: string;
  facts: string;
  documents: string;
  questionnaires: string;
  overrides: string;
  decisions: string;
}

export const FINGERPRINT_PART_NAMES: readonly (keyof FingerprintParts)[] = [
  "engine",
  "view",
  "answers",
  "header",
  "facts",
  "documents",
  "questionnaires",
  "overrides",
  "decisions",
];

export interface ReturnFingerprint {
  /** 64 hex. */
  fingerprint: string;
  parts: FingerprintParts;
}

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value ?? null));
}

function sortedBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

/** One digest row per document: identity, status flags and the digest of the effective extraction. */
export function documentRowsForFingerprint(documents: readonly FingerprintDocumentInput[]): unknown[] {
  return sortedBy(documents, (d) => d.id).map((d) => ({
    id: d.id,
    docType: d.docType,
    taxYear: d.taxYear,
    extractionStatus: d.extractionStatus,
    verified: d.verified,
    legacyFormat: d.legacyFormat,
    reextractIncomplete: d.reextractIncomplete === true,
    subjectType: d.subjectType,
    subjectUserId: d.subjectUserId,
    data: digest(d.extractionData),
  }));
}

export function computeReturnFingerprint(input: FingerprintInput): ReturnFingerprint {
  const parts: FingerprintParts = {
    engine: sha256Hex(input.engineVersion),
    view: sha256Hex(input.viewFingerprint),
    answers: digest(input.answers),
    header: digest(input.header),
    facts: digest(input.facts),
    documents: digest(documentRowsForFingerprint(input.documents)),
    questionnaires: digest(
      sortedBy(input.questionnaires, (q) => q.questionnaireId).map((q) => ({
        id: q.questionnaireId,
        version: q.definitionVersion,
        answers: digest(q.answers),
      }))
    ),
    overrides: digest(
      sortedBy(input.overrides, (o) => o.id).map((o) => ({
        id: o.id,
        version: o.version,
        targetKind: o.targetKind,
        targetKey: o.targetKey,
        valueKind: o.valueKind,
        valueCents: o.valueCents,
        valueText: o.valueText,
        authority: o.authority,
        archived: o.archivedAt !== null,
      }))
    ),
    decisions: digest(input.decisions),
  };
  const fingerprint = fingerprintOf({ v: FINGERPRINT_VERSION, parts });
  return { fingerprint, parts };
}

/** Names of the input groups whose digest differs (empty = same state). Used for the "stale: what changed" message. */
export function changedFingerprintParts(a: FingerprintParts, b: FingerprintParts): (keyof FingerprintParts)[] {
  return FINGERPRINT_PART_NAMES.filter((n) => a[n] !== b[n]);
}

const PART_LABELS: Readonly<Record<keyof FingerprintParts, string>> = {
  engine: "the calculation engine version",
  view: "a computed line, open item or decision",
  answers: "a household answer printed on the forms",
  header: "a name printed on the forms",
  facts: "the facts the return is computed from",
  documents: "a document or its verified / corrected reading",
  questionnaires: "a questionnaire answer",
  overrides: "an override",
  decisions: "a recorded decision",
};

export function describeFingerprintParts(names: readonly (keyof FingerprintParts)[]): string {
  return names.map((n) => PART_LABELS[n]).join("; ");
}

export function shortFp(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}
