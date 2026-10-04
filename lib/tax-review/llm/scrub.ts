// Scrubbing of street addresses and entity names to generic labels before anything is sent to the model
// (ai-return-reviewer, B3; owner decision: the model sees only "Taxpayer M" / "Taxpayer F", EINs are masked, and street addresses
// and business names are replaced by generic labels).
//
// This sits IN FRONT of lib/tax-review/redact.ts (people names, EIN masking, the final identifier guard). Order matters: an entity
// name such as "Eric Kinniburgh Consulting, LLC" contains a person's name, so entities are replaced first, then addresses, then
// (in buildOutgoingJson) the people. Replacement is case-insensitive and on word boundaries; known addresses are matched exactly
// (street line and full line), and a generic street-address pattern catches any other "<number> <Street Name> <suffix>".
//
// PURE: no DB, no network, no clock.

export interface ScrubEntity {
  name: string;
  label: string;
  /** Short forms people use ("EK Consulting", "EKC"). */
  aliases?: string[];
}

export interface ScrubAddress {
  address: string;
  label: string;
}

export interface ScrubConfig {
  entities: readonly ScrubEntity[];
  addresses: readonly ScrubAddress[];
}

export const GENERIC_ADDRESS_LABEL = "[property address]";

const SUFFIXES = [
  "Rd", "Road", "St", "Street", "Ave", "Avenue", "Ln", "Lane", "Dr", "Drive", "Ct", "Court", "Way", "Blvd", "Boulevard", "Pl", "Ter", "Terrace",
  "Hwy", "Highway", "Cir", "Circle", "Pkwy", "Parkway", "Trl", "Trail",
];
const SUFFIX_ALT = [...SUFFIXES, ...SUFFIXES.map((s) => s.toUpperCase())].join("|");
// "56 Arbor Rd", "27 Old Barry Rd.", "1200 N. Main Street Apt 4B": a number, up to four capitalised words, a street suffix, an optional unit.
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}[A-Za-z]?\\s+(?:(?:[A-Z][A-Za-z0-9.'-]*|[NSEW]\\.?)\\s+){0,4}(?:${SUFFIX_ALT})\\b\\.?(?:\\s*(?:#|Apt\\.?|Unit|Ste\\.?|Suite)\\s*[A-Za-z0-9-]+)?`,
  "g"
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegex(phrase: string): RegExp {
  // spaces in the phrase match any run of whitespace; boundaries are "not a letter or digit" on both sides
  const body = phrase.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

const LEGAL_SUFFIX = /[\s,]*\b(?:L\.?L\.?C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Ltd\.?|L\.?P\.?)\s*$/i;

/** "Eric Kinniburgh Consulting, LLC" -> ["Eric Kinniburgh Consulting, LLC", "Eric Kinniburgh Consulting"]. */
export function entityVariants(entity: ScrubEntity): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    const t = s.normalize("NFKC").trim();
    if (t.length >= 3) out.add(t);
  };
  add(entity.name);
  const base = entity.name.replace(LEGAL_SUFFIX, "");
  add(base);
  const suffix = LEGAL_SUFFIX.exec(entity.name)?.[0]?.replace(/^[\s,]+/, "").trim();
  if (suffix !== undefined && suffix !== "") {
    // the same name written with and without the comma before the legal suffix
    add(`${base.trim()} ${suffix}`);
    add(`${base.trim()}, ${suffix}`);
  }
  for (const a of entity.aliases ?? []) add(a);
  return [...out];
}

/** The street line (before the first comma) and the full line of a known address. */
export function addressVariants(address: string): string[] {
  const full = address.normalize("NFKC").replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  if (full.length >= 5) out.add(full);
  const street = full.split(",")[0]?.trim() ?? "";
  if (street.length >= 5 && /\d/.test(street)) out.add(street);
  return [...out];
}

export type Scrubber = (text: string) => string;

export function buildScrubber(config: ScrubConfig): Scrubber {
  const entityRules = config.entities
    .flatMap((e) => entityVariants(e).map((v) => ({ re: wordRegex(v), label: e.label, len: v.length })))
    .sort((a, b) => b.len - a.len);
  const addressRules = config.addresses
    .flatMap((a) => addressVariants(a.address).map((v) => ({ re: wordRegex(v), label: a.label, len: v.length })))
    .sort((a, b) => b.len - a.len);
  return (text: string): string => {
    let out = text.normalize("NFKC");
    for (const r of entityRules) out = out.replace(r.re, r.label);
    for (const r of addressRules) out = out.replace(r.re, r.label);
    out = out.replace(STREET_ADDRESS, GENERIC_ADDRESS_LABEL);
    return out;
  };
}

/** Applies `scrub` to every string VALUE (and every key) of a JSON-safe value. Numbers, booleans and null pass through. */
export function scrubDeep<T>(value: T, scrub: Scrubber): T {
  if (typeof value === "string") return scrub(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[scrub(k)] = scrubDeep(v, scrub);
    return out as T;
  }
  return value;
}
