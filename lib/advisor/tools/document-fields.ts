// The allowlist for get_document_values (advisor-ai-chatbot-phase2 plan, section 4.1). PURE: no DB, no clock.
//
// The OUTPUT field names, labels and form references come from the typed registry TAX_SCHEMAS only, never from the keys found in a stored JSON
// value, so a poisoned key in a document can never become output. The default is DENY:
//   - allowed kinds: money, int, decimal, pct, bool, date, enum (and the columns of a list under the same rules);
//   - never: ein and mask kinds, any identifier-shaped key (isIdentifierKey), legacy fields, enumList;
//   - text: only the keys named in ALLOWED_TEXT_FIELDS (payer / employer / lender / issuer / charity / entity / jurisdiction names, a form-box
//     description). Every other text field (addresses, parcel ids, the taxpayer name, state ids, the benefit statement ...) is denied;
//   - a list is allowed only when it has at least one allowed column that is not a bare amount (a row of amounts with no code, form, date or
//     status would mean nothing), and a text column of a list is allowed only as a short upper-case code (state / box 12 codes).
// A value that survives the kind rules must also pass isCleanText (the scrubber backstop) or it is WITHHELD, never rewritten.

import { containsPrivateIdentifier } from "@/lib/tax-facts/validate";
import { redactStreetAddresses, redactText } from "@/lib/advisor/scrub";
import { dollarsOf } from "@/lib/advisor/tools/format";
import { isIdentifierKey } from "@/lib/tax-extraction-policy";
import { TAX_SCHEMAS, type FieldDef, type ScalarFieldSpec, type TaxSchemaDocType } from "@/lib/tax-extraction-schema";

/** The only free-text fields that may be returned, per schema. A new text field added to a schema is denied until it is listed here. */
export const ALLOWED_TEXT_FIELDS: Readonly<Record<TaxSchemaDocType, readonly string[]>> = {
  w2: ["employerName"],
  "1099": ["payerName"],
  form_1098: ["servicerName", "box10Description"],
  property_tax: ["jurisdictionName", "jurisdictionState"],
  k1: ["entityName"],
  tax_return: [],
  donation_receipt: ["organizationName", "nonCashDescription"],
  retirement_contribution: ["issuerName"],
};

const SCALAR_ALLOWED: ReadonlySet<string> = new Set(["money", "int", "decimal", "pct", "bool", "date", "enum"]);

/** Max length of a text value / row of text in the output. */
export const MAX_TEXT_VALUE = 80;

/** A text column of a list row is allowed only as a short upper-case code (W-2 box 12 and state codes). */
function itemAllowed(item: ScalarFieldSpec): boolean {
  if (isIdentifierKey(item.key)) return false;
  if (SCALAR_ALLOWED.has(item.kind)) return true;
  return item.kind === "text" && item.uppercase === true && item.maxLen !== undefined && item.maxLen <= 4;
}

/** The columns of a list field that may be returned (empty = the whole list is denied). */
export function allowedItemFields(def: FieldDef): readonly ScalarFieldSpec[] {
  if (def.kind !== "list" || def.itemFields === undefined) return [];
  const cols = def.itemFields.filter(itemAllowed);
  // A row of bare amounts (no code, form, date or status to say what they are) is not returned.
  return cols.some((c) => c.kind !== "money") ? cols : [];
}

export function classifyField(schemaType: TaxSchemaDocType, def: FieldDef): "allow" | "deny" {
  if (def.legacy) return "deny";
  if (isIdentifierKey(def.key)) return "deny";
  if (def.kind === "ein" || def.kind === "mask" || def.kind === "enumList") return "deny";
  if (def.kind === "list") return allowedItemFields(def).length > 0 ? "allow" : "deny";
  if (def.kind === "text") return ALLOWED_TEXT_FIELDS[schemaType].includes(def.key) ? "allow" : "deny";
  return SCALAR_ALLOWED.has(def.kind) ? "allow" : "deny";
}

export interface ReadableField {
  def: FieldDef;
  /** Registry label, form reference. */
  label: string;
  formRef: string;
  isText: boolean;
  /** The field as a scalar spec; null for a list. */
  scalar: ScalarFieldSpec | null;
}

/** The allowed fields of a schema, in registry order. */
export function readableFields(schemaType: TaxSchemaDocType): ReadableField[] {
  return TAX_SCHEMAS[schemaType].fields
    .filter((def) => classifyField(schemaType, def) === "allow")
    .map((def) => ({ def, label: def.label, formRef: def.formRef, isText: def.kind === "text", scalar: def.kind === "list" || def.kind === "enumList" ? null : { ...def, kind: def.kind } }));
}

// ── the scrubber backstop ────────────────────────────────────────────────────

/**
 * True when a string is safe to return as it stands. Anything that would need REWRITING fails (it is withheld instead): an identifier-shaped
 * number (SSN, EIN, account or card number, spaced or grouped digits), a date of birth, an e-mail address, a street address, an invisible or
 * control character. Whitespace runs are collapsed first, so a value is only judged on its visible text.
 */
export function isCleanText(raw: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(raw)) return false;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return false;
  if (containsPrivateIdentifier(collapsed)) return false;
  if (redactText(collapsed) !== collapsed) return false;
  if (redactStreetAddresses(collapsed) !== collapsed) return false;
  return true;
}

// ── value conversion ─────────────────────────────────────────────────────────

export type OutValue = string | number | boolean;
export type Converted = { ok: true; value: OutValue } | { ok: false; reason: "blank" | "withheld" };

const BLANK = { ok: false, reason: "blank" } as const;
const WITHHELD = { ok: false, reason: "withheld" } as const;

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

/**
 * Convert one stored scalar to its output value under the field's own rules. `payerNames: "generic"` withholds every text value.
 * Money is returned as dollars (stored as integer cents; a non-integer is withheld), a date must be a real calendar date, an enum must be one of
 * the registry's options (and is shown by its plain-language label), numbers must be finite and in range, text must be clean and is clipped.
 */
export function convertScalar(spec: ScalarFieldSpec, raw: unknown, payerNames: "keep" | "generic"): Converted {
  if (isBlank(raw)) return BLANK;
  switch (spec.kind) {
    case "money": {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return WITHHELD;
      if (raw < 0 && spec.signed !== true) return WITHHELD;
      const dollars = dollarsOf(raw);
      return dollars === null ? WITHHELD : { ok: true, value: dollars };
    }
    case "int":
      return typeof raw === "number" && Number.isSafeInteger(raw) && (spec.min === undefined || raw >= spec.min) && (spec.max === undefined || raw <= spec.max) ? { ok: true, value: raw } : WITHHELD;
    case "decimal":
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? { ok: true, value: raw } : WITHHELD;
    case "pct":
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? { ok: true, value: raw } : WITHHELD;
    case "bool":
      return typeof raw === "boolean" ? { ok: true, value: raw } : WITHHELD;
    case "date":
      return typeof raw === "string" && isRealDate(raw) ? { ok: true, value: raw } : WITHHELD;
    case "enum": {
      if (typeof raw !== "string" || spec.options === undefined || !spec.options.includes(raw)) return WITHHELD;
      return { ok: true, value: spec.optionLabels?.[raw] ?? raw };
    }
    case "text": {
      if (typeof raw !== "string") return WITHHELD;
      const isCode = spec.uppercase === true && spec.maxLen !== undefined && spec.maxLen <= 4;
      // Names of payers, employers, lenders, issuers and charities follow the reviewer's TAX_REVIEW_PAYER_NAMES setting; a short code does not.
      if (payerNames === "generic" && !isCode) return WITHHELD;
      if (!isCleanText(raw)) return WITHHELD;
      const collapsed = raw.replace(/\s+/g, " ").trim();
      if (isCode && !/^[A-Z0-9]{1,4}$/.test(collapsed)) return WITHHELD;
      return { ok: true, value: collapsed.length <= MAX_TEXT_VALUE ? collapsed : `${collapsed.slice(0, MAX_TEXT_VALUE - 1).trimEnd()}…` };
    }
    default:
      return WITHHELD;
  }
}
