// Pure draft <-> value conversion for the tax review form
// (components/documents/tax-review-client.tsx). Kept in lib so it is unit
// tested and shares the schema registry's kinds. Client-safe: no DB, no server
// imports.
//
// The form edits plain strings (what an <input> holds). Converting a draft to a
// typed value is strict: money is parsed from dollars with dollarsInputToCents
// (integer cents, never a float), and an empty input means "blank on the form"
// (null). The server re-validates everything with validateCorrections.

import { jsonEqual } from "@/lib/extraction-corrections";
import {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCentsDisplay,
  getTaxSchema,
  sumInstallmentsDueInYear,
  type FieldDef,
  type ScalarFieldSpec,
  type TaxSchemaDocType,
} from "@/lib/tax-extraction-schema";

export type RowDraft = Record<string, string>;

export interface FieldDraft {
  /** Scalar fields: what the input holds ("" = blank on the form). */
  text: string;
  /** list fields: one entry per row, item key -> input text. */
  rows: RowDraft[];
  /** enumList fields: the checked options. */
  checked: string[];
}

export type ConvertResult = { ok: true; value: unknown } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Scalars ───────────────────────────────────────────────────────────────────

export function scalarToText(spec: ScalarFieldSpec, value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (spec.kind) {
    case "money":
      return typeof value === "number" && Number.isSafeInteger(value) ? centsToDollarsInput(value) : "";
    case "bool":
      return value === true ? "true" : value === false ? "false" : "";
    default:
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
}

export function textToScalar(spec: ScalarFieldSpec, text: string): ConvertResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  switch (spec.kind) {
    case "money": {
      const cents = dollarsInputToCents(trimmed, { allowNegative: spec.signed === true });
      if (cents === null) {
        return {
          ok: false,
          error: `${spec.label}: enter dollars like 1,234.56${spec.signed ? "" : " (not negative)"}`,
        };
      }
      return { ok: true, value: cents };
    }
    case "int": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${spec.label}: enter a whole number` };
      return { ok: true, value: Number(trimmed) };
    }
    case "decimal":
    case "pct": {
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, error: `${spec.label}: enter a number` };
      return { ok: true, value: Number(trimmed) };
    }
    case "bool":
      if (trimmed === "true") return { ok: true, value: true };
      if (trimmed === "false") return { ok: true, value: false };
      return { ok: false, error: `${spec.label}: choose yes or no` };
    default:
      return { ok: true, value: trimmed };
  }
}

// ── Whole fields ──────────────────────────────────────────────────────────────

export function draftFromValue(def: FieldDef, value: unknown): FieldDraft {
  const draft: FieldDraft = { text: "", rows: [], checked: [] };
  if (def.kind === "list") {
    const items = def.itemFields ?? [];
    if (Array.isArray(value)) {
      draft.rows = value.filter(isRecord).map((row) => {
        const out: RowDraft = {};
        for (const item of items) out[item.key] = scalarToText(item, row[item.key]);
        return out;
      });
    }
  } else if (def.kind === "enumList") {
    if (Array.isArray(value)) draft.checked = value.filter((v): v is string => typeof v === "string");
  } else {
    draft.text = scalarToText(def as ScalarFieldSpec, value);
  }
  return draft;
}

export function emptyRow(def: FieldDef): RowDraft {
  const row: RowDraft = {};
  for (const item of def.itemFields ?? []) row[item.key] = "";
  return row;
}

export function valueFromDraft(def: FieldDef, draft: FieldDraft): ConvertResult {
  if (def.kind === "list") {
    const items = def.itemFields ?? [];
    const rows: Record<string, unknown>[] = [];
    for (const rowDraft of draft.rows) {
      const row: Record<string, unknown> = {};
      let any = false;
      for (const item of items) {
        const c = textToScalar(item, rowDraft[item.key] ?? "");
        if (!c.ok) return { ok: false, error: `${def.label}: ${c.error}` };
        row[item.key] = c.value;
        if (c.value !== null) any = true;
      }
      if (any) rows.push(row);
    }
    return { ok: true, value: rows.length > 0 ? rows : null };
  }
  if (def.kind === "enumList") {
    return { ok: true, value: draft.checked.length > 0 ? [...draft.checked] : null };
  }
  return textToScalar(def as ScalarFieldSpec, draft.text);
}

/** Empty lists and null are the same "nothing" for change detection. */
function nothingIfEmpty(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

export interface BuiltCorrections {
  /** key -> value for every visible field whose value differs from the AI value. */
  fields: Record<string, unknown>;
  /** field key -> message for drafts that could not be parsed. */
  errors: Record<string, string>;
}

/**
 * Builds the COMPLETE override set to send to the save/confirm actions: every
 * visible field whose value differs from the AI value. Hidden fields are not
 * included (they are derived or not applicable).
 */
export function buildCorrectionFields(
  schemaType: TaxSchemaDocType,
  drafts: Record<string, FieldDraft>,
  aiData: Record<string, unknown>,
  visibleKeys: ReadonlySet<string>
): BuiltCorrections {
  const fields: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const def of getTaxSchema(schemaType).fields) {
    if (!visibleKeys.has(def.key)) continue;
    const draft = drafts[def.key];
    if (!draft) continue;
    const result = valueFromDraft(def, draft);
    if (!result.ok) {
      errors[def.key] = result.error;
      continue;
    }
    if (!jsonEqual(nothingIfEmpty(result.value), nothingIfEmpty(aiData[def.key]))) {
      fields[def.key] = result.value;
    }
  }
  return { fields, errors };
}

/** true when the draft's value differs from `compareTo` (used for the "changed" marker). */
export function draftDiffers(def: FieldDef, draft: FieldDraft, compareTo: unknown): boolean {
  const result = valueFromDraft(def, draft);
  if (!result.ok) return true;
  return !jsonEqual(nothingIfEmpty(result.value), nothingIfEmpty(compareTo));
}

// ── Display ───────────────────────────────────────────────────────────────────

export function formatScalarForDisplay(spec: ScalarFieldSpec, value: unknown): string {
  if (value === null || value === undefined) return "-";
  switch (spec.kind) {
    case "money":
      return typeof value === "number" ? formatCentsDisplay(value) : "-";
    case "bool":
      return value === true ? "Yes" : value === false ? "No" : "-";
    case "pct":
      return typeof value === "number" ? `${value}%` : "-";
    default:
      return String(value);
  }
}

export function formatValueForDisplay(def: FieldDef, value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (def.kind === "list") {
    if (!Array.isArray(value) || value.length === 0) return "-";
    const items = def.itemFields ?? [];
    return value
      .filter(isRecord)
      .map((row) =>
        items
          .map((item) => formatScalarForDisplay(item, row[item.key]))
          .filter((s) => s !== "-")
          .join(" ")
      )
      .join("; ");
  }
  if (def.kind === "enumList") {
    return Array.isArray(value) && value.length > 0 ? value.join(", ") : "-";
  }
  return formatScalarForDisplay(def as ScalarFieldSpec, value);
}

// ── Property tax helper ───────────────────────────────────────────────────────

/**
 * The review page's helper for the owner-entered "paid in the tax year" box:
 * the sum of installments due in `taxYear`, as a dollars string to PRE-FILL the
 * input. It is only a suggestion (assumes each was paid when due); nothing is
 * saved until the owner clicks Save or Confirm. null when nothing to sum.
 */
export function suggestPaidInTaxYear(
  installmentsDef: FieldDef,
  installmentsDraft: FieldDraft,
  taxYear: number
): { cents: number; dollars: string } | null {
  const value = valueFromDraft(installmentsDef, installmentsDraft);
  if (!value.ok) return null;
  const cents = sumInstallmentsDueInYear(value.value, taxYear);
  return cents === null ? null : { cents, dollars: centsToDollarsInput(cents) };
}
