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

export type RedactionIssue = "ssn_like" | "nine_digit_run" | "long_digit_run" | "ein_like";

/** A hex token (digest, fingerprint): 12 to 64 hex characters containing at least one letter. */
const HEX_TOKEN = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,64}\b/gi;
/** A UUID (document ids appear in review text); its last group can be twelve digits by chance. */
const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** NN-NNNNNNN (an employer identification number as printed). */
const EIN_LIKE = /\b\d{2}[-‐-―−]\d{7}\b/;
const EIN_ALL = /\b(\d{2})[-‐-―−](\d{3})(\d{4})\b/g;

function normalise(text: string): string {
  return text.normalize("NFKC");
}

/** Which kinds of taxpayer / account identifier the text looks like. Empty = nothing found. */
export function findRedactionIssues(text: string): RedactionIssue[] {
  const t = normalise(text);
  const issues: RedactionIssue[] = [];
  if (containsSsnLikeText(t)) issues.push("ssn_like");
  if (EIN_LIKE.test(t)) issues.push("ein_like");
  const withoutHex = t.replace(UUID_TOKEN, " ").replace(HEX_TOKEN, " ");
  for (const m of withoutHex.matchAll(/\d{9,}/g)) {
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
  return normalise(text).replace(EIN_ALL, (_m, _a: string, _b: string, last: string) => `**-***${last}`);
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
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "giu"), label);
  }
  return out;
}

/**
 * The only way a payload becomes outgoing text: serialise, scrub the household names, mask EINs, then refuse the whole
 * payload if anything identifier-shaped is still there. Returns the exact string that may be sent.
 */
export function buildOutgoingJson(value: unknown, people: readonly HouseholdPerson[], where: string): string {
  const labels = labelHouseholdMembers(people);
  if (labels.unmapped.length > 0) throw new RedactionError(`${where} (unlabelled household member)`, []);
  const scrubbed = maskEin(scrubPeople(JSON.stringify(value), people, labels));
  assertSafeOutgoing(scrubbed, where);
  return scrubbed;
}
