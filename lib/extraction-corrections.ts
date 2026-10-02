// Pure helpers for the owner-corrections overlay stored in
// Document.extractionCorrections (document-extraction-status-and-review).
//
// Shape (plan section 4.3):
//   { version: 1,
//     fields: { <dataKey>: { value, aiValue, correctedAt, correctedById } },
//     events: [{ type, at, by }] }   // capped, newest last
//
// The overlay is OWNER-written metadata layered over the AI output in
// extractionData; extractionData itself is never edited. This module is the pure
// side: reading the overlay defensively (countCorrections), computing the next
// overlay from an owner submission (applyCorrectionSet: aiValue kept from the
// first correction, inert keys preserved) and appending audit events. The
// actions that persist it live in actions/document-verification.ts.

export const EXTRACTION_EVENT_CAP = 50;

export type ExtractionEventType = "corrected" | "confirmed" | "unverified" | "re-extracted";

export interface ExtractionEvent {
  type: ExtractionEventType;
  at: string; // ISO timestamp
  by: string; // user id
}

export interface ExtractionCorrections {
  version: 1;
  fields: Record<string, unknown>;
  events: ExtractionEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEvents(base: Record<string, unknown>): ExtractionEvent[] {
  return Array.isArray(base.events)
    ? base.events.filter(
        (e): e is ExtractionEvent =>
          isRecord(e) && typeof e.type === "string" && typeof e.at === "string" && typeof e.by === "string"
      )
    : [];
}

/** Number of fields the owner has corrected. Tolerates null/malformed JSON (returns 0). */
export function countCorrections(corrections: unknown): number {
  if (!isRecord(corrections)) return 0;
  const fields = corrections.fields;
  return isRecord(fields) ? Object.keys(fields).length : 0;
}

export interface CorrectionEntry {
  /** The owner's value (null = "blank on the form"). */
  value: unknown;
  /** What the AI said when this key was FIRST corrected (kept across re-corrections). */
  aiValue: unknown;
  correctedAt: string; // ISO
  correctedById: string;
}

/** Structural equality for JSON values (objects compared key-order-insensitively). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!jsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

export interface AppliedCorrections {
  overlay: ExtractionCorrections;
  /** true when the set of corrected values actually changed. */
  changed: boolean;
}

/**
 * Computes the new overlay when the owner submits the COMPLETE set of values
 * they want to override (key -> value). Rules:
 *  - a submitted value equal to the current AI value is not a correction (dropped)
 *  - `aiValue` is kept from the FIRST correction of a key; re-correcting a key
 *    updates value/correctedAt/by only when the value actually changed
 *  - keys the owner no longer overrides are removed (reverted to the AI value)
 *  - entries for keys outside `knownKeys` (a retype left them inert) are kept
 *    untouched: never deleted
 *  - when anything changed a "corrected" event is appended (events capped)
 * Pure: inputs are not mutated.
 */
export function applyCorrectionSet(
  existing: unknown,
  submitted: Record<string, unknown>,
  aiData: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  now: string,
  by: string
): AppliedCorrections {
  const base = isRecord(existing) ? existing : {};
  const existingFields = isRecord(base.fields) ? base.fields : {};

  const nextFields: Record<string, unknown> = {};
  // Inert entries (not in the current schema) are preserved as-is.
  for (const [key, entry] of Object.entries(existingFields)) {
    if (!knownKeys.has(key)) nextFields[key] = entry;
  }

  for (const [key, value] of Object.entries(submitted)) {
    const currentAi = aiData[key] ?? null;
    if (jsonEqual(value, currentAi)) continue; // not a correction
    const prior = existingFields[key];
    if (isRecord(prior) && "value" in prior && jsonEqual(prior.value, value)) {
      nextFields[key] = prior; // unchanged: keep who/when
      continue;
    }
    const entry: CorrectionEntry = {
      value,
      aiValue: isRecord(prior) && "aiValue" in prior ? prior.aiValue : currentAi,
      correctedAt: now,
      correctedById: by,
    };
    nextFields[key] = entry;
  }

  const allKeys = new Set([...Object.keys(existingFields), ...Object.keys(nextFields)]);
  let changed = false;
  for (const key of allKeys) {
    const before = existingFields[key];
    const after = nextFields[key];
    if (before === undefined || after === undefined) {
      changed = true;
      break;
    }
    const beforeValue = isRecord(before) ? before.value : undefined;
    const afterValue = isRecord(after) ? after.value : undefined;
    if (!jsonEqual(beforeValue, afterValue)) {
      changed = true;
      break;
    }
  }

  const withFields = { ...base, fields: nextFields };
  // Only a real change adds a "corrected" event; otherwise the prior events stay exactly as they were.
  const overlay: ExtractionCorrections = changed
    ? appendExtractionEvent(withFields, { type: "corrected", at: now, by })
    : { version: 1, fields: nextFields, events: readEvents(base) };
  return { overlay, changed };
}

/**
 * Returns a new overlay with `event` appended (events capped at
 * EXTRACTION_EVENT_CAP, oldest dropped). Existing `fields` are preserved
 * untouched; a null/malformed overlay becomes an empty one. Never throws.
 */
export function appendExtractionEvent(corrections: unknown, event: ExtractionEvent): ExtractionCorrections {
  const base = isRecord(corrections) ? corrections : {};
  const fields = isRecord(base.fields) ? base.fields : {};
  const priorEvents = readEvents(base);
  const events = [...priorEvents, event].slice(-EXTRACTION_EVENT_CAP);
  return { version: 1, fields, events };
}
