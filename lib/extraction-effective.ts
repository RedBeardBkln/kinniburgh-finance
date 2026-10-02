// "Effective" extraction values: the AI output with the owner's corrections
// overlaid (document-extraction-status-and-review, pass 2).
//
// Pure and defensive: it NEVER throws on malformed JSON (it returns the AI data
// untouched), and it never mutates its inputs. extractionData itself is never
// edited by the owner; corrections live in Document.extractionCorrections and
// win over the AI value for the keys they cover. A corrected `null` overrides an
// AI value ("this box is blank on the form").
//
// Consumers (the Forms page / tax-compute loaders, wired in pass 3) hand the
// returned `extractionData` to the existing resolvers, which keep reading
// `extractionData.data.<flatKey>` exactly as before.

import { deriveLegacyKeys, getFieldDef, schemaTypeForDocType } from "@/lib/tax-extraction-schema";

export interface EffectiveExtractionInput {
  /** Raw Document.docType (mortgage_interest etc.). */
  docType: string;
  extractionData: unknown;
  extractionCorrections: unknown;
  extractionConfirmedAt: Date | null;
}

export interface EffectiveExtraction {
  /** The AI object with `data` overlaid by corrections (same shape as the stored extractionData). */
  extractionData: unknown;
  verified: boolean;
  /** Registry keys the owner corrected (inapplicable overlay keys excluded). */
  correctedKeys: string[];
  schemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSchemaVersion(extractionData: unknown): number {
  if (!isRecord(extractionData)) return 1;
  const v = extractionData.schemaVersion;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/** The corrected `value` for each overlay entry, keyed by data key (malformed entries skipped). */
export function readCorrectionValues(corrections: unknown): Record<string, unknown> {
  if (!isRecord(corrections) || !isRecord(corrections.fields)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(corrections.fields)) {
    if (isRecord(entry) && "value" in entry) out[key] = entry.value;
  }
  return out;
}

export function resolveEffectiveExtraction(input: EffectiveExtractionInput): EffectiveExtraction {
  const { extractionData } = input;
  const verified = input.extractionConfirmedAt !== null && input.extractionConfirmedAt !== undefined;
  const schemaVersion = readSchemaVersion(extractionData);
  const schemaType = schemaTypeForDocType(input.docType);

  if (!schemaType || !isRecord(extractionData)) {
    return { extractionData, verified, correctedKeys: [], schemaVersion };
  }

  const corrections = readCorrectionValues(input.extractionCorrections);
  const correctedKeys = Object.keys(corrections).filter((key) => getFieldDef(schemaType, key) !== undefined);
  if (correctedKeys.length === 0 && !isRecord(extractionData.data)) {
    return { extractionData, verified, correctedKeys: [], schemaVersion };
  }

  let data: Record<string, unknown> = { ...(isRecord(extractionData.data) ? extractionData.data : {}) };
  for (const key of correctedKeys) data[key] = corrections[key];
  // Older resolvers read the flat legacy keys; keep them consistent with the
  // structured fields unless the owner corrected the legacy key itself.
  data = deriveLegacyKeys(schemaType, data, !correctedKeys.includes("stateWithheldCents"));

  return { extractionData: { ...extractionData, data }, verified, correctedKeys, schemaVersion };
}

export interface CorrectionView {
  value: unknown;
  /** What the AI said when the key was first corrected. */
  aiValue: unknown;
}

/**
 * The overlay entries that apply to this docType's CURRENT schema, for the
 * review screen. Keys a retype left inert are ignored (not deleted from the DB).
 */
export function readCorrectionEntries(docType: string, corrections: unknown): Record<string, CorrectionView> {
  const schemaType = schemaTypeForDocType(docType);
  const out: Record<string, CorrectionView> = {};
  if (!schemaType || !isRecord(corrections) || !isRecord(corrections.fields)) return out;
  for (const [key, entry] of Object.entries(corrections.fields)) {
    if (!getFieldDef(schemaType, key) || !isRecord(entry) || !("value" in entry)) continue;
    out[key] = { value: entry.value, aiValue: "aiValue" in entry ? entry.aiValue : null };
  }
  return out;
}
