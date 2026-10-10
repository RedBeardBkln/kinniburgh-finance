// Heating-oil price history (owner input on /forecast). Pure: no database, no clock (callers pass `today`), no Next.js.
//
// Storage (no migration): one AppSetting row per entity, key `oil_price_history:<entityId>`, JSON array of
//   { id, effectiveOn: "YYYY-MM-DD", pricePerGal: "3.4990" (a decimal STRING, never a float), note?, removed?, addedAt? }
// capped at OIL_PRICE_CAP entries. Nothing is ever deleted: "remove" sets `removed: true`, so the row stays as history
// and the cap counts it. Two live entries on the same date: the later one in the array wins (a correction is a new entry).
// The price is what the owner types; this module only validates and parses it, it never invents or fetches one.

import { Decimal } from "@prisma/client/runtime/library";

export const OIL_PRICE_CAP = 60;
export const OIL_PRICE_MAX = 20; // dollars per gallon, a sanity bound (a typo like 349 for 3.49)
export const OIL_PRICE_MIN = 1; // dollars per gallon, a sanity bound (a typo like 0.35 for 3.50)
export const OIL_NOTE_MAX = 120;
export const OIL_PRICE_MAX_DECIMALS = 4;
/** An effective date may be at most this many days after today (a price announced for next week). */
export const OIL_PRICE_FUTURE_DAYS = 30;
const EARLIEST_DATE = "2015-01-01";

export interface OilPriceEntry {
  id: string;
  /** YYYY-MM-DD */
  effectiveOn: string;
  /** Decimal string with 2 to 4 decimals, e.g. "3.4990". */
  pricePerGal: string;
  note?: string;
  removed?: true;
  /** ISO timestamp the entry was added (audit only). */
  addedAt?: string;
}

export function oilPriceKey(entityId: string): string {
  return `oil_price_history:${entityId}`;
}

// ── "Not heating oil" marks on McCarthy rows ────────────────────────────────────
// Tags on McCarthy rows are not reliable (a furnace repair, the yearly service and a split oil fill all carry mixed
// tags), so the owner marks the rows that are NOT heating oil, one click each. Stored per site entity in an AppSetting
// JSON array of TRANSACTION IDS only (key `oil_not_heating:<entityId>`), capped. The transactions are never changed.

export const OIL_EXCLUDED_CAP = 200;
const TX_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export function oilExcludedKey(entityId: string): string {
  return `oil_not_heating:${entityId}`;
}

export function parseExcludedIds(raw: string | null | undefined): { ids: string[]; corrupt: boolean } {
  if (raw === null || raw === undefined || raw.trim() === "") return { ids: [], corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ids: [], corrupt: true };
  }
  if (!Array.isArray(parsed)) return { ids: [], corrupt: true };
  const ids: string[] = [];
  for (const v of parsed) {
    if (typeof v === "string" && TX_ID_RE.test(v) && !ids.includes(v)) ids.push(v);
    if (ids.length >= OIL_EXCLUDED_CAP) break;
  }
  return { ids, corrupt: false };
}

export function serializeExcludedIds(ids: readonly string[]): string {
  return JSON.stringify(ids.slice(0, OIL_EXCLUDED_CAP));
}

/** Idempotent on/off. Turning on an id already present, or off an id absent, changes nothing. A new id at the cap is refused. */
export function setExcluded(ids: readonly string[], id: string, excluded: boolean): Checked<string[]> {
  if (!TX_ID_RE.test(id)) return { ok: false, error: "That transaction id is not valid." };
  const has = ids.includes(id);
  if (excluded) {
    if (has) return { ok: true, value: [...ids] };
    if (ids.length >= OIL_EXCLUDED_CAP) return { ok: false, error: `You have marked ${OIL_EXCLUDED_CAP} charges already; count some again before marking more.` };
    return { ok: true, value: [...ids, id] };
  }
  return { ok: true, value: ids.filter((x) => x !== id) };
}

/** AppSetting key of the owner's opt-in (default off): the estimate replaces hand-entered accrual draws in forecasts. */
export const REPLACE_DRAWS_KEY = "seasonal_replace_draws";

export function parseReplaceDraws(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const PRICE_RE = /^\d{1,3}(?:\.\d{1,4})?$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Normalises a typed price to a decimal string with 2 to 4 decimals ("3.5" becomes "3.50", "3.499" stays). Rejects
 * zero, negatives, more than 4 decimals, a non-number and anything above OIL_PRICE_MAX dollars a gallon.
 */
export function normalizePrice(input: unknown): Checked<string> {
  const raw = typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : typeof input === "string" ? input.trim().replace(/^\$/, "") : "";
  if (raw === "") return { ok: false, error: "Enter a price per gallon, for example 3.499." };
  if (/e/i.test(raw) || !PRICE_RE.test(raw)) {
    return { ok: false, error: `Enter the price as dollars per gallon with at most ${OIL_PRICE_MAX_DECIMALS} decimals, for example 3.499.` };
  }
  const d = new Decimal(raw);
  if (!d.greaterThan(0)) return { ok: false, error: "The price must be greater than zero." };
  if (d.lessThan(OIL_PRICE_MIN)) {
    return { ok: false, error: `A price under $${OIL_PRICE_MIN.toFixed(2)} a gallon is probably a typing slip (for example 0.35 for 3.50). Check it and enter the full price per gallon.` };
  }
  if (d.greaterThan(OIL_PRICE_MAX)) return { ok: false, error: `A price above $${OIL_PRICE_MAX} a gallon looks like a typing slip; check it.` };
  const places = raw.includes(".") ? (raw.split(".")[1] as string).length : 0;
  return { ok: true, value: d.toFixed(Math.max(2, Math.min(OIL_PRICE_MAX_DECIMALS, places))) };
}

export interface OilPriceInput {
  effectiveOn: unknown;
  pricePerGal: unknown;
  note?: unknown;
}

/** Validates one owner entry. `today` is the America/New_York calendar date as UTC midnight (the caller supplies it). */
export function validateOilPriceInput(input: OilPriceInput, today: Date): Checked<{ effectiveOn: string; pricePerGal: string; note?: string }> {
  if (!isIsoDate(input.effectiveOn)) return { ok: false, error: "Enter the date the price took effect." };
  if (input.effectiveOn < EARLIEST_DATE) return { ok: false, error: "That date is too far in the past." };
  const latest = isoOf(new Date(today.getTime() + OIL_PRICE_FUTURE_DAYS * 86_400_000));
  if (input.effectiveOn > latest) return { ok: false, error: `The date cannot be more than ${OIL_PRICE_FUTURE_DAYS} days ahead.` };
  const price = normalizePrice(input.pricePerGal);
  if (!price.ok) return price;
  let note: string | undefined;
  if (input.note !== undefined && input.note !== null && input.note !== "") {
    if (typeof input.note !== "string") return { ok: false, error: "The note must be text." };
    const trimmed = input.note.trim();
    if (trimmed.length > OIL_NOTE_MAX) return { ok: false, error: `Keep the note to ${OIL_NOTE_MAX} characters.` };
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, error: "The note has characters that cannot be saved." };
    if (trimmed !== "") note = trimmed;
  }
  return { ok: true, value: { effectiveOn: input.effectiveOn, pricePerGal: price.value, ...(note !== undefined ? { note } : {}) } };
}

export interface ParsedPrices {
  entries: OilPriceEntry[];
  /** True when the stored value exists but could not be read as a list (the caller must not overwrite it blindly). */
  corrupt: boolean;
}

/** Tolerant parse of the stored JSON. Entries that fail validation are dropped; an absent value is an empty list. */
export function parseOilPrices(raw: string | null | undefined): ParsedPrices {
  if (raw === null || raw === undefined || raw.trim() === "") return { entries: [], corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], corrupt: true };
  }
  if (!Array.isArray(parsed)) return { entries: [], corrupt: true };
  const entries: OilPriceEntry[] = [];
  const ids = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = o["id"];
    const effectiveOn = o["effectiveOn"];
    const price = o["pricePerGal"];
    if (typeof id !== "string" || id === "" || ids.has(id)) continue;
    if (!isIsoDate(effectiveOn) || typeof price !== "string") continue;
    const normalized = normalizePrice(price);
    if (!normalized.ok) continue;
    ids.add(id);
    const note = typeof o["note"] === "string" && o["note"].length <= OIL_NOTE_MAX ? (o["note"] as string) : undefined;
    entries.push({
      id,
      effectiveOn,
      pricePerGal: normalized.value,
      ...(note !== undefined ? { note } : {}),
      ...(o["removed"] === true ? { removed: true as const } : {}),
      ...(typeof o["addedAt"] === "string" ? { addedAt: o["addedAt"] as string } : {}),
    });
    if (entries.length >= OIL_PRICE_CAP) break;
  }
  return { entries, corrupt: false };
}

export function serializeOilPrices(entries: readonly OilPriceEntry[]): string {
  return JSON.stringify(entries.slice(0, OIL_PRICE_CAP));
}

/** The prices in force: not removed, one per date (the later entry in the array wins), oldest first. */
export function activeOilPrices(entries: readonly OilPriceEntry[]): OilPriceEntry[] {
  const byDate = new Map<string, OilPriceEntry>();
  for (const e of entries) {
    if (e.removed) continue;
    byDate.set(e.effectiveOn, e);
  }
  return [...byDate.values()].sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : a.effectiveOn > b.effectiveOn ? 1 : 0));
}

/** The price in force on `date` (YYYY-MM-DD): the latest active entry on or before it, else null. */
export function priceOn(active: readonly OilPriceEntry[], date: string): OilPriceEntry | null {
  let hit: OilPriceEntry | null = null;
  for (const e of active) {
    if (e.effectiveOn <= date) hit = e;
    else break;
  }
  return hit;
}

/** Adds an entry. Fails (no change) at the cap. `id` and `addedAt` come from the caller (no clock or randomness here). */
export function appendOilPrice(
  entries: readonly OilPriceEntry[],
  entry: { id: string; effectiveOn: string; pricePerGal: string; note?: string; addedAt: string }
): Checked<OilPriceEntry[]> {
  if (entries.length >= OIL_PRICE_CAP) {
    return { ok: false, error: `The price list is full (${OIL_PRICE_CAP} entries including removed ones).` };
  }
  return { ok: true, value: [...entries, { ...entry }] };
}

/** Marks an entry removed (kept as history). Unknown id: an error; already removed: no change. */
export function markOilPriceRemoved(entries: readonly OilPriceEntry[], id: string): Checked<OilPriceEntry[]> {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: "That price entry was not found." };
  return { ok: true, value: entries.map((e, i) => (i === idx ? { ...e, removed: true as const } : e)) };
}
