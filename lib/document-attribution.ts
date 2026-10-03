// Pure, client-safe document attribution helpers (no DB, no server imports).
//
// A Document's `entityId` is the app's OWN bucket (Personal / an LLC). This
// module covers the two separate facts the owner also needs on every document:
//   - who it PERTAINS to (a household member, or Joint) -> subjectType/subjectUserId
//   - which ISSUER/PAYER it came from (e.g. a W-2 from "Alpine Bio") -> issuerName
// Both are nullable; NULL subjectType means "Unassigned". Extraction-derived
// issuer names are only ever SUGGESTIONS computed at read time — they are never
// stored without an explicit owner action.

export type DocumentSubjectType = "person" | "joint";

export const ISSUER_MAX_LENGTH = 200;

/**
 * The docTypes that make up the household's "Tax documents" view on /documents
 * (and are routed through the tax upload path). Single source of truth for the
 * page filter, the upload form's routing, and later the forms catalog.
 */
export const TAX_DOC_TYPES = [
  "w2",
  "1099",
  "k1",
  "mortgage_interest",
  "property_tax",
  "donation_receipt",
  "tax_return",
  "extension",
] as const;

export type TaxDocType = (typeof TAX_DOC_TYPES)[number];

export function isTaxDocType(docType: string): docType is TaxDocType {
  return (TAX_DOC_TYPES as readonly string[]).includes(docType);
}

export interface ValidAttribution {
  subjectType: DocumentSubjectType | null;
  subjectUserId: string | null;
  issuerName: string | null;
}

export type AttributionValidation =
  | { ok: true; value: ValidAttribution }
  | { ok: false; error: string };

// Lenient 8-4-4-4-12 hex check (Prisma's `@default(uuid())` ids); deliberately
// not version-strict.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// C0 controls, DEL and C1 controls.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validates and normalizes an attribution triple. Never throws.
 * - subjectType: "person" | "joint" | null/undefined (= Unassigned)
 * - "person" requires a UUID subjectUserId; "joint"/null require none
 * - issuerName: trimmed, blank -> null, max 200 chars, no control characters
 */
export function validateAttribution(input: {
  subjectType: unknown;
  subjectUserId: unknown;
  issuerName: unknown;
}): AttributionValidation {
  const { subjectType, subjectUserId, issuerName } = input;

  let type: DocumentSubjectType | null;
  if (subjectType === null || subjectType === undefined) {
    type = null;
  } else if (subjectType === "person" || subjectType === "joint") {
    type = subjectType;
  } else {
    return { ok: false, error: "Invalid document owner" };
  }

  const hasUserId = subjectUserId !== null && subjectUserId !== undefined;
  let userId: string | null = null;
  if (type === "person") {
    if (typeof subjectUserId !== "string" || !UUID_RE.test(subjectUserId)) {
      return { ok: false, error: "Choose which person this document pertains to" };
    }
    userId = subjectUserId;
  } else if (hasUserId) {
    return { ok: false, error: "A person can only be set when the document pertains to a person" };
  }

  let issuer: string | null = null;
  if (issuerName !== null && issuerName !== undefined) {
    if (typeof issuerName !== "string") {
      return { ok: false, error: "Issuer must be text" };
    }
    if (CONTROL_CHARS_RE.test(issuerName)) {
      return { ok: false, error: "Issuer contains invalid characters" };
    }
    const trimmed = issuerName.trim();
    if (trimmed.length > ISSUER_MAX_LENGTH) {
      return { ok: false, error: `Issuer must be at most ${ISSUER_MAX_LENGTH} characters` };
    }
    issuer = trimmed === "" ? null : trimmed;
  }

  return { ok: true, value: { subjectType: type, subjectUserId: userId, issuerName: issuer } };
}

const PARSE_FAILURE_SUMMARY = "Could not parse extraction response.";

// docType -> the extractionData.data key that holds the issuer/payer name.
// Mirrors the mapping lib/doc-naming.ts's generateDocumentName already uses.
// Deliberately NOT mapped: tax_return (taxpayerName is a person, not an issuer)
// and property_tax (its extraction `data` is always empty).
const ISSUER_KEY_BY_DOC_TYPE: Record<string, string> = {
  w2: "employerName",
  "1099": "payerName",
  k1: "entityName",
  mortgage_interest: "servicerName",
  mortgage_statement: "servicerName",
  // A donation receipt's issuer is the charity that received the gift.
  donation_receipt: "organizationName",
};

/**
 * Reads a suggested issuer from a document's stored extraction, or null.
 * Pure and defensive: accepts anything for `extractionData` (a Prisma Json
 * value), never throws, ignores blank/non-string values and the
 * parse-failure stub. The result is a SUGGESTION only.
 */
export function suggestIssuerFromExtraction(docType: string, extractionData: unknown): string | null {
  const key = ISSUER_KEY_BY_DOC_TYPE[docType];
  if (!key) return null;
  if (typeof extractionData !== "object" || extractionData === null || Array.isArray(extractionData)) {
    return null;
  }
  const record = extractionData as Record<string, unknown>;
  if (record["summary"] === PARSE_FAILURE_SUMMARY) return null;
  const data = record["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed.slice(0, ISSUER_MAX_LENGTH);
}

export interface PersonRef {
  id: string;
  name: string;
}

/** "Eric Kinniburgh" -> "Eric"; "Eva-Laura Ramirez-Wisiackas" -> "Eva-Laura". */
export function shortPersonName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? first : "Unknown";
}

export interface AttributionDisplay {
  /** Human label: "Eric", "Eva-Laura", "Joint (Eric & Eva-Laura)", "Unassigned". */
  label: string;
  /** False for Unassigned (including a "person" whose User row no longer exists). */
  assigned: boolean;
}

/**
 * Display label for a document's subject. `people` is the full household user
 * list (used to name the Joint pair); `subjectUser` is the document's resolved
 * relation (null if unset or if the user vanished — SetNull -> Unassigned).
 */
export function attributionLabel(
  doc: { subjectType: string | null; subjectUser: PersonRef | null },
  people: readonly PersonRef[]
): AttributionDisplay {
  if (doc.subjectType === "joint") {
    const names = people.map((p) => shortPersonName(p.name));
    return {
      label: names.length === 2 ? `Joint (${names[0]} & ${names[1]})` : "Joint",
      assigned: true,
    };
  }
  if (doc.subjectType === "person" && doc.subjectUser) {
    return { label: shortPersonName(doc.subjectUser.name), assigned: true };
  }
  return { label: "Unassigned", assigned: false };
}

/** Value used by the person <select>: "", "joint", or a user id. */
export function subjectToSelectValue(subjectType: string | null, subjectUserId: string | null): string {
  if (subjectType === "joint") return "joint";
  if (subjectType === "person" && subjectUserId) return subjectUserId;
  return "";
}

/** The editor's form state, derived from a document's CURRENT saved attribution. */
export function initialEditState(doc: {
  subjectType: string | null;
  subjectUserId: string | null;
  issuerName: string | null;
}): { subjectValue: string; issuer: string } {
  return {
    subjectValue: subjectToSelectValue(doc.subjectType, doc.subjectUserId),
    issuer: doc.issuerName ?? "",
  };
}

/**
 * Builds the full-replacement payload for updateDocumentAttribution from the
 * editor's form state (select value + issuer text).
 */
export function buildAttributionPayload(
  documentId: string,
  subjectValue: string,
  issuer: string
): {
  documentId: string;
  subjectType: DocumentSubjectType | null;
  subjectUserId: string | null;
  issuerName: string;
} {
  const { subjectType, subjectUserId } = selectValueToSubject(subjectValue);
  return { documentId, subjectType, subjectUserId, issuerName: issuer };
}

/**
 * True when the select's current value is a person id that is not in the
 * people list — the select then needs an explicit "Unknown person" option so
 * it doesn't render blank (and so Save can't silently change the person).
 */
export function needsUnknownPersonOption(selectValue: string, people: readonly PersonRef[]): boolean {
  if (selectValue === "" || selectValue === "joint") return false;
  return !people.some((p) => p.id === selectValue);
}

export const UNKNOWN_PERSON_LABEL = "Unknown person";

/** Inverse of subjectToSelectValue — maps a <select> value to the action's fields. */
export function selectValueToSubject(value: string): {
  subjectType: DocumentSubjectType | null;
  subjectUserId: string | null;
} {
  if (value === "") return { subjectType: null, subjectUserId: null };
  if (value === "joint") return { subjectType: "joint", subjectUserId: null };
  return { subjectType: "person", subjectUserId: value };
}
