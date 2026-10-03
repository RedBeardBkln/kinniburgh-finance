// Formatting helpers for the PDF layer. Pure; no I/O.

import { createHash } from "node:crypto";

/**
 * How a negative whole-dollar amount is written into a field. Cosmetic, pinned by a
 * test so a change is deliberate: "leading_minus" => "-1,234".
 */
export const NEGATIVE_STYLE = "leading_minus" as const;

/** Whole dollars with thousands commas. Throws on a non-integer (money is never a float). */
export function formatDollars(amount: number): string {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`formatDollars needs a whole-dollar integer, got ${String(amount)}`);
  }
  if (amount === 0) return "0";
  const digits = Math.abs(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return amount < 0 ? `-${digits}` : digits;
}

/** Recursively key-sorted JSON, so equal data always serialises identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("canonicalJson: non-finite number");
  }
  return value;
}

/** Hex SHA-256 of the canonical JSON of `value` (the return fingerprint). */
export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** First 12 hex characters, as printed on the cover and in the page stamp. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

/** "2026-10-03" in America/New_York. */
export function formatNewYorkDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "2026-10-03 21:05 ET" style timestamp in America/New_York (EST/EDT shown by abbreviation). */
export function formatNewYorkDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

export interface SplitName {
  first: string;
  last: string;
}

/**
 * Split a single full-name string for forms with separate first/last fields: the last
 * name is the text after the final space, the first name everything before it. A
 * single token is returned as first name only. This is a GUESS (suffixes, compound
 * surnames) so fill raises an advisory "verify name split" item whenever it is used.
 */
export function splitName(full: string): SplitName {
  const t = full.trim().replace(/\s+/g, " ");
  const at = t.lastIndexOf(" ");
  if (at === -1) return { first: t, last: "" };
  return { first: t.slice(0, at), last: t.slice(at + 1) };
}
