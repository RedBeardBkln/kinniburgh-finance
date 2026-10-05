// Outgoing-text guard for the AI Return Reviewer (plan section 5.5.3, owner decision D4).
//
// Everything that leaves this app toward a model, a stored finding or a message goes through here first:
//   - SSN-like text, a bare 9-digit run, any digit run of 9 or more, and an EIN-shaped token are REJECTED
//     (the caller must not send / store the text; there is no "fix it up and send anyway");
//   - EINs are MASKED when they must stay visible to a person (only the last 4 digits remain);
//   - the two household members are labelled exactly "Taxpayer M" and "Taxpayer F" (no real or first names).
//
// UUIDs (document ids) are allowed for the same reason. Hex digests (fingerprints, hashes) are allowed: a long hex token that contains at least one letter a-f is not a
// number (a random 64-hex string often contains a 9-digit run by chance, so counting it would fail most hashes).
//
// PURE: no DB, no network, no clock. No function here ever echoes the rejected text in an error message.

import { containsSsnLikeText } from "@/lib/tax-extraction-schema";

export type RedactionIssue = "ssn_like" | "nine_digit_run" | "long_digit_run" | "ein_like" | "spaced_digit_run" | "card_like";

/**
 * A hex digest token. Only WHOLE tokens of exactly 12 / 16 / 32 / 40 / 64 hex characters containing at least one letter a-f can be
 * a digest (fingerprints, sha-256 / sha-1 / md5 hashes); a number glued to letters ("123456789abc" is 12 characters but is not
 * trusted: see exemptHex) is not exempt just because it uses hex letters.
 */
const HEX_TOKEN = /(?<![0-9a-z_])(?:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{32}|[0-9a-f]{16}|[0-9a-f]{12})(?![0-9a-z_])/gi;
/** A UUID (document ids appear in review text); its last group can be twelve digits by chance. */
const UUID_TOKEN = /(?<![0-9a-z_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z_])/gi;
/**
 * NN-NNNNNNN (an employer identification number as printed). No word boundary BEFORE the digits: "EIN12-3456789" and "ein:12-3456789" are
 * EINs too (there is no \b between a letter and a number); only a number directly before or after makes it a longer number.
 */
const EIN_LIKE = /(?<!\d)\d{2}[-‐-―−]\d{7}(?!\d)/;
const EIN_ALL = /(?<!\d)(\d{2})[-‐-―−](\d{3})(\d{4})(?!\d)/g;
/** Separators people put between the groups of an identifier. */
const SEP = "[-\\s.,/_\\u2010-\\u2015\\u2212]";
/** An EIN whose two groups are split by something other than the usual dash: "12 3456789", "12.3456789", "12_3456789" (one or two separator characters). */
const EIN_SPLIT = new RegExp(`(?<!\\d)\\d{2}${SEP}{1,2}\\d{7}(?!\\d)`);
/** Nine or more single numerals with ONE separator between each ("1 2 3 4 5 6 7 8 9", "1-2-3-4-5-6-7-8-9"): a number spelled out numeral by numeral. */
const SPACED_SINGLES = new RegExp(`(?<!\\d)\\d(?:${SEP}\\d){8,}(?!\\d)`);
/** A card or account number written in groups: 4-4-4-(1 to 4) or 4-6-5 (American Express), at least one separator between the groups. */
const CARD_4444 = new RegExp(`(?<!\\d)(\\d{4})${SEP}{1,3}(\\d{4})${SEP}{1,3}(\\d{4})${SEP}{1,3}(\\d{1,4})(?!\\d)`);
const CARD_465 = new RegExp(`(?<!\\d)\\d{4}${SEP}{1,3}\\d{6}${SEP}{1,3}\\d{5}(?!\\d)`);
/** Four tax years in a row ("2022 2023 2024 2025") have the card shape but are years, not a card. */
const isYear = (g: string): boolean => g.length === 4 && Number(g) >= 1990 && Number(g) <= 2100;
/** 3-2-4 (SSN) and 3-3-3 grouping with up to three separator characters between groups. */
const GROUPED_ID = new RegExp(`(?<!\\d)(?:\\d{3}${SEP}{0,3}\\d{2}${SEP}{0,3}\\d{4}|(?<!\\d[,.])\\d{3}${SEP}{1,3}\\d{3}${SEP}{1,3}\\d{3})(?!\\d)`);
/** Invisible / format characters (zero-width, soft hyphen, bidi marks, BOM ...) that can split a digit run. */
const INVISIBLE = /[\p{Cf}­͏؜ᅟᅠ឴឵᠎ㅤﾠ]/gu;

/**
 * Source of a regular expression (flag "u" required) that matches `phrase` even when invisible / format characters (zero-width space or joiner,
 * soft hyphen, bidi mark, BOM ...) are written between its characters or around its spaces: "Kinni" + U+200B + "burgh" still matches "Kinniburgh".
 * An invisible character that SEPARATES two words ("Eric" + U+200B + "Kinniburgh") counts as the space of the phrase. Used by the name and
 * street scrubbers, so an adversarial spelling cannot hide a name from them.
 */
export function invisibleTolerant(phrase: string): string {
  const gap = `${INVISIBLE.source}*`;
  const words = phrase.trim().split(/\s+/).map((word) => [...word].map(escapeRegExp).join(gap));
  return words.join(`(?:\\s|${INVISIBLE.source})+`);
}

/** Text as it is scanned: NFKC, invisible characters removed, every Unicode decimal numeral read as a numeral (ASCII ones keep their value). */
function scanText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\p{Nd}/gu, (c) => (/[0-9]/.test(c) ? c : "0"));
}

/** A 12 / 16 character hex token that carries a 9+ digit run is a number with letters glued on, not a digest; 32 / 40 / 64 character tokens are digests. */
function exemptHex(token: string): boolean {
  if (!/[a-f]/i.test(token)) return false;
  if (token.length >= 32) return true;
  return !/\d{9,}/.test(token);
}

function normalise(text: string): string {
  return text.normalize("NFKC");
}

/** Which kinds of taxpayer / account identifier the text looks like. Empty = nothing found. */
export function findRedactionIssues(text: string): RedactionIssue[] {
  const t = scanText(text);
  const issues: RedactionIssue[] = [];
  // Digests and UUIDs are taken out BEFORE every shape test, not only before the digit-run test: a random 64-hex fingerprint part holds
  // a 9-digit run by chance (about 4 in 10), and the grouped-identifier test has no word boundary, so on the raw text it refused the
  // run's own stored config (found by the live read-only run of reviewer-all).
  const withoutDigests = t.replace(UUID_TOKEN, " ").replace(HEX_TOKEN, (m) => (exemptHex(m) ? " " : m));
  if (containsSsnLikeText(withoutDigests) || GROUPED_ID.test(withoutDigests)) issues.push("ssn_like");
  if (EIN_LIKE.test(withoutDigests) || EIN_SPLIT.test(withoutDigests)) issues.push("ein_like");
  if (SPACED_SINGLES.test(withoutDigests)) issues.push("spaced_digit_run");
  const card = CARD_4444.exec(withoutDigests);
  if ((card !== null && !card.slice(1, 5).every(isYear)) || CARD_465.test(withoutDigests)) issues.push("card_like");
  for (const m of withoutDigests.matchAll(/\d{9,}/g)) {
    issues.push(m[0].length === 9 ? "nine_digit_run" : "long_digit_run");
    break;
  }
  return [...new Set(issues)];
}

export function isSafeOutgoing(text: string): boolean {
  return findRedactionIssues(text).length === 0;
}

export class RedactionError extends Error {
  readonly issues: readonly RedactionIssue[];
  constructor(where: string, issues: readonly RedactionIssue[]) {
    // Never echo the text: it is exactly the thing that must not leave.
    super(`outgoing text refused at ${where}: ${issues.join(", ")}`);
    this.name = "RedactionError";
    this.issues = issues;
  }
}

/** Throws RedactionError (without the text) when the text looks like an SSN, an EIN or a long digit run. */
export function assertSafeOutgoing(text: string, where: string): void {
  const issues = findRedactionIssues(text);
  if (issues.length > 0) throw new RedactionError(where, issues);
}

/** "12-3456789" -> "**-***6789": only the last four digits stay. Text without an EIN is returned unchanged. */
export function maskEin(text: string): string {
  return normalise(text).replace(INVISIBLE, "").replace(EIN_ALL, (_m, _a: string, _b: string, last: string) => `**-***${last}`);
}

// ── Household labels (owner decision D4) ──────────────────────────────────────

export const TAXPAYER_M = "Taxpayer M";
export const TAXPAYER_F = "Taxpayer F";

/** First-name rules for the two household members. Anything else is unmapped (and a payload refuses to build). */
export const HOUSEHOLD_LABEL_RULES: ReadonlyArray<{ label: string; firstNames: readonly string[] }> = [
  { label: TAXPAYER_M, firstNames: ["eric"] },
  { label: TAXPAYER_F, firstNames: ["eva", "eva-laura"] },
];

export interface HouseholdPerson {
  userId: string;
  name: string;
}

export interface HouseholdLabels {
  /** userId -> label for every person that matched a rule. */
  byUserId: ReadonlyMap<string, string>;
  /** Names that matched no rule (the caller must stop: sending an unlabelled name is not allowed). */
  unmapped: string[];
}

function firstToken(name: string): string {
  return normalise(name).trim().toLowerCase().split(/\s+/)[0] ?? "";
}

export function labelHouseholdMembers(people: readonly HouseholdPerson[]): HouseholdLabels {
  const byUserId = new Map<string, string>();
  const unmapped: string[] = [];
  const used = new Set<string>();
  for (const p of people) {
    const first = firstToken(p.name);
    const rule = HOUSEHOLD_LABEL_RULES.find((r) => r.firstNames.includes(first));
    if (rule === undefined || used.has(rule.label)) {
      unmapped.push(p.name);
      continue;
    }
    used.add(rule.label);
    byUserId.set(p.userId, rule.label);
  }
  return { byUserId, unmapped };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every name token worth replacing for one person: each whitespace token and each hyphen-separated part (3+ letters). */
function nameTokens(name: string): string[] {
  const out = new Set<string>();
  const full = normalise(name).trim();
  if (full.length >= 3) out.add(full);
  for (const tok of full.split(/\s+/)) {
    if (tok.length >= 3) out.add(tok);
    for (const part of tok.split("-")) if (part.length >= 3) out.add(part);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of a household member's name (full name, each word, each hyphenated part) with the member's
 * label, case-insensitively and on word boundaries. A word shared by both members becomes "the Taxpayers". Throws
 * RedactionError("unmapped household member") when a person has no label: sending the real name is never the fallback.
 */
export function scrubPeople(text: string, people: readonly HouseholdPerson[], labels: HouseholdLabels): string {
  if (labels.unmapped.length > 0) throw new RedactionError("household labels (unlabelled member)", []);
  let out = normalise(text);
  const owners = new Map<string, Set<string>>();
  for (const p of people) {
    const label = labels.byUserId.get(p.userId);
    if (label === undefined) continue;
    for (const tok of nameTokens(p.name)) {
      const key = tok.toLowerCase();
      const set = owners.get(key) ?? new Set<string>();
      set.add(label);
      owners.set(key, set);
    }
  }
  const ordered = [...owners.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [token, set] of ordered) {
    const label = set.size === 1 ? [...set][0] ?? "" : "the Taxpayers";
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${invisibleTolerant(token)}(?![\\p{L}\\p{N}])`, "giu"), label);
  }
  return out;
}

/**
 * The value of a JSON field named key / findingKey / evidenceHash that is exactly 16 hex characters: a finding's key or evidence hash,
 * a digest the reviewer itself generates (lib/tax-review/types.ts) and the model needs to refer to a finding. About one in ten of them
 * holds a 9-digit run by chance and a 16-character token cannot be told from a number by its shape (see exemptHex), so these are
 * excluded from the CHECK, by field name and exact shape only (the stored finding row excludes them for the same reason). The same
 * 16 hex characters anywhere else in the text, or under another field name, are still refused when they hold a 9-digit run.
 */
const OWN_KEY_FIELD = /("(?:key|findingKey|evidenceHash)"\s*:\s*")[0-9a-f]{16}(")/g;

/**
 * The only way a payload becomes outgoing text: serialise, scrub the household names, mask EINs, then refuse the whole
 * payload if anything identifier-shaped is still there. Returns the exact string that may be sent.
 */
export function buildOutgoingJson(value: unknown, people: readonly HouseholdPerson[], where: string): string {
  const labels = labelHouseholdMembers(people);
  if (labels.unmapped.length > 0) throw new RedactionError(`${where} (unlabelled household member)`, []);
  const scrubbed = maskEin(scrubPeople(JSON.stringify(value), people, labels));
  // what is SENT is `scrubbed`; what is CHECKED has our own finding keys taken out (see OWN_KEY_FIELD)
  assertSafeOutgoing(scrubbed.replace(OWN_KEY_FIELD, "$1$2"), where);
  return scrubbed;
}

