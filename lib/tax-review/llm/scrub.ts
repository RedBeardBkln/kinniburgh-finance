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

import { invisibleTolerant } from "@/lib/tax-review/redact";
import { addressPatternSource } from "@/lib/tax-review/llm/address";

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
// A number straight followed by "CT" is not a street ("the 2025 CT income tax", "2025 CT-1040": Connecticut, not "Court"); the first live review
// sent "[property address] income tax" and "[property address]-1040" in two constant notes because of it (ai-payload-fixes).
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}[A-Za-z]?(?!\\s+(?:CT|Ct)\\b)\\s+(?:(?:[A-Z][A-Za-z0-9.'-]*|[NSEW]\\.?)\\s+){0,4}(?:${SUFFIX_ALT})\\b\\.?(?:\\s*(?:#|Apt\\.?|Unit|Ste\\.?|Suite)\\s*[A-Za-z0-9-]+)?`,
  "g"
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegex(phrase: string): RegExp {
  // spaces in the phrase match any run of whitespace; boundaries are "not a letter or digit" on both sides; zero-width and other invisible characters
  // written inside the phrase or around its spaces do not hide it (invisibleTolerant)
  return new RegExp(`(?<![\\p{L}\\p{N}])${invisibleTolerant(phrase)}(?![\\p{L}\\p{N}])`, "giu");
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

const STATES = "CT|NY|MA|RI|NJ|PA|VT|NH|ME|FL|DE|MD|CA|TX|VA|NC|SC|GA|OH|IL|Connecticut";
// "<Town words>, CT 06375" written after a street address that was just replaced by a label
const TOWN_STATE_ZIP = `(?:,?\\s+[A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,2},?\\s+(?:${STATES})\\b\\.?\\s*\\d{5}(?:-\\d{4})?)`;
// a state and zip left on their own ("CT 06375")
const STATE_ZIP = new RegExp(`,?\\s*\\b(?:${STATES})\\b\\.?\\s+\\d{5}(?:-\\d{4})?\\b`, "gi");

export function buildScrubber(config: ScrubConfig): Scrubber {
  const labels = [...new Set([GENERIC_ADDRESS_LABEL, ...config.addresses.map((a) => a.label)])];
  const tails = labels.map((l) => new RegExp(`(${escapeRegExp(l)})${TOWN_STATE_ZIP}`, "gi"));
  const entityRules = config.entities
    .flatMap((e) => entityVariants(e).map((v) => ({ re: wordRegex(v), label: e.label, len: v.length })))
    .sort((a, b) => b.len - a.len);
  const addressRules = config.addresses
    .flatMap((a) => addressVariants(a.address).map((v) => ({ re: wordRegex(v), label: a.label, len: v.length })))
    .sort((a, b) => b.len - a.len);
  // every written form of a known street line (Rd / Road, case, punctuation, a different town or zip after it) is the same property: one
  // label for all of them, wherever the text came from (a document, a form, a rule reason, a finding)
  const canonicalRules = config.addresses.flatMap((a) => {
    const source = addressPatternSource(a.address);
    return source === null ? [] : [{ re: new RegExp(source, "giu"), label: a.label }];
  });
  const once = (text: string): string => {
    let out = text.normalize("NFKC");
    for (const r of entityRules) out = out.replace(r.re, r.label);
    for (const r of addressRules) out = out.replace(r.re, r.label);
    for (const r of canonicalRules) out = out.replace(r.re, r.label);
    out = out.replace(STREET_ADDRESS, GENERIC_ADDRESS_LABEL);
    // whatever town / state / zip followed the street goes with it, then any state and zip left alone
    for (const t of tails) out = out.replace(t, "$1");
    return out.replace(STATE_ZIP, "");
  };
  return once;
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
