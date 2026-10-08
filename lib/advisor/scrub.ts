// The assistant's central scrubber (plan section 4.3). PURE: no DB, no network, no clock.
//
// It runs on EVERY tool result, on every stored or streamed string (assistant text, user text, titles, argument summaries) and
// rejects identifier-like memory notes. Values that look like an SSN, EIN, account / card number or a date of birth are REPLACED
// ("[number removed]"), never echoed; if anything still looks like one afterwards the whole text is withheld. The classification
// oracle is `findRedactionIssues` (the same function the AI Return Reviewer's outgoing-text guard uses), so the two cannot drift.

import { findRedactionIssues } from "@/lib/tax-review/redact";
import { containsPrivateIdentifier, privacyError, type Checked } from "@/lib/tax-facts/validate";
import { FORBIDDEN_OUTPUT_KEY_PATTERN } from "@/lib/advisor/exclusions";

export const NUMBER_REMOVED = "[number removed]";
export const EMAIL_REMOVED = "[email removed]";
export const TEXT_WITHHELD = "[text withheld: looked like an identifier]";

export class ScrubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrubError";
  }
}

/** Invisible / format characters (zero-width, soft hyphen, bidi marks, BOM ...) that can split a digit run or hide text. */
const INVISIBLE = /[\p{Cf}­͏؜ᅟᅠ឴឵᠎ㅤﾠ]/gu;
/** Control characters other than tab / newline. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const UUID_TOKEN = /(?<![0-9a-z_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z_])/gi;
const HEX_TOKEN = /(?<![0-9a-z_])(?:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{32}|[0-9a-f]{16}|[0-9a-f]{12})(?![0-9a-z_])/gi;
/** A run of digits with up to three separator characters between digits: the unit the oracle is asked about. */
const DIGIT_SPAN = /\d(?:[-‐-―−\s.,/_]{0,3}\d)*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const EMAIL_TEST = new RegExp(EMAIL.source);
/** A birth word followed by a date ("DOB: 1/2/1980", "born on March 3, 1971", "date of birth 03-04-1980"). */
const BIRTH_DATE_VALUE =
  /\b(?:date\s+of\s+birth|birth\s*date|dob|born(?:\s+on)?)\b[\s:=-]{0,4}(?:\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{2,4})/gi;

/** A 12 / 16 character hex token that carries a 9+ digit run is a number with letters glued on, not a digest (same rule as redact.ts). */
function exemptHex(token: string): boolean {
  if (!/[a-f]/i.test(token)) return false;
  if (token.length >= 32) return true;
  return !/\d{9,}/.test(token);
}

/** NFKC, invisible characters removed, every non-ASCII decimal numeral read as a numeral (as the oracle scans it), control characters dropped. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(CONTROL, " ")
    .replace(/\p{Nd}/gu, (c) => (/[0-9]/.test(c) ? c : "0"));
}

/**
 * Replace identifier-shaped numbers, e-mail addresses and "date of birth <date>" values. Newlines are kept (assistant text is
 * markdown). Never throws and never echoes a removed value.
 */
export function redactText(input: string): string {
  if (input === "") return input;
  let text = normalizeText(input);

  // Digests and UUIDs are not numbers: park them so the number passes cannot touch them.
  const parked: string[] = [];
  const park = (m: string): string => {
    parked.push(m);
    return `\u0001${letters(parked.length - 1)}\u0001`;
  };
  text = text.replace(UUID_TOKEN, park).replace(HEX_TOKEN, (m) => (exemptHex(m) ? park(m) : m));

  text = text.replace(BIRTH_DATE_VALUE, NUMBER_REMOVED).replace(EMAIL, EMAIL_REMOVED);
  text = text.replace(DIGIT_SPAN, (span) => (findRedactionIssues(span).length > 0 ? NUMBER_REMOVED : span));

  text = text.replace(/\u0001([a-z]+)\u0001/g, (_m, l: string) => parked[fromLetters(l)] ?? "");
  // Belt and braces: a shape that spans two of the units above, or one the span pass did not see, withholds the whole text.
  if (findRedactionIssues(text).length > 0) return TEXT_WITHHELD;
  return text;
}

function letters(n: number): string {
  let out = "";
  let v = n;
  do {
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26) - 1;
  } while (v >= 0);
  return out;
}

function fromLetters(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n - 1;
}

/** Whitespace-collapse (incl. newlines) + length cap with an ellipsis. For payees, memos, notes, names, titles. */
export function clip(s: string | null | undefined, max: number): string {
  if (s === null || s === undefined) return "";
  const collapsed = normalizeText(s).replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** clip + redact: the shape for any free-text field a tool returns. */
export function safeField(s: string | null | undefined, max: number): string {
  // Redact first (the replacement is longer than a short number), then clip, so the cap holds and a number is never cut half way.
  return clip(redactText(s ?? ""), max);
}

const MAX_DEPTH = 24;

/**
 * Walk plain objects / arrays, redact every string leaf, leave numbers / booleans / null alone. Throws ScrubError when an object key
 * matches FORBIDDEN_OUTPUT_KEY_PATTERN (a tool that tries to return `accessToken` fails loudly) or when the structure is too deep.
 */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) throw new ScrubError("value nested too deeply");
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1)) as unknown as T;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OUTPUT_KEY_PATTERN.test(k)) throw new ScrubError("forbidden key in output");
    if (v === undefined) continue;
    out[k] = scrubDeep(v, depth + 1);
  }
  return out as T;
}

export const MEMORY_NOTE_MAX = 400;

/**
 * A memory note is user-authored standing context: an identifier-like note is REJECTED (never rewritten, never echoed). The error names
 * only the field. Returns the whitespace-collapsed text.
 */
export function scrubMemoryNote(raw: string): Checked<string> {
  const stripped = normalizeText(raw);
  const text = stripped.replace(/\s+/g, " ").trim();
  if (text.length === 0) return { ok: false, error: "The note is required." };
  if (text.length > MEMORY_NOTE_MAX) return { ok: false, error: `The note must be ${MEMORY_NOTE_MAX} characters or fewer.` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "The note contains characters that are not allowed." };
  if (containsPrivateIdentifier(text) || findRedactionIssues(text).length > 0) return { ok: false, error: privacyError("note") };
  if (EMAIL_TEST.test(text)) return { ok: false, error: "The note looks like it contains an e-mail address; remove it." };
  return { ok: true, value: text };
}

export interface RedactedUserText {
  text: string;
  /** True when something that looked like an identifier was replaced. */
  changed: boolean;
}

/** A chat message typed by the user: identifier-shaped numbers are replaced (rejecting the whole message would be hostile), and the UI says so. */
export function redactUserText(raw: string): RedactedUserText {
  const cleaned = normalizeText(raw).replace(/\r\n/g, "\n").trim();
  const text = redactText(cleaned);
  return { text, changed: text !== cleaned };
}
