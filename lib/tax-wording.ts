// Owner wording for the TY2025 return (ai-return-reviewer, step A1; plan section 7.2 / 7.5).
//
// Eric prepares and signs his own return: no CPA reviews it, so no OWNER-VISIBLE string may say that
// one does. Most strings are reworded at their source. The engine (`lib/tax2025/rules/**`,
// `return.ts`, `resolve-facts.ts`) generates hundreds of sentences that still say "the CPA decides";
// editing those files conflicts with the concurrent Schedule 1-A / Form 8960 branch, so this one tested
// layer rewrites them at the RENDER boundary (the sheet model, the PDF view/cover, the question pages),
// and `findCpaWording` is the guard a scan test runs over everything that is rendered.
//
// What is NOT rewritten (persisted or pinned identifiers): `needs_cpa_*` status values, `answer_cpa`,
// `confirmWithCpa`, `cpaNote`, `who: "cpa"`, the `/cpa-summary` URL. The phrase rules below only match
// the standalone word "CPA" (upper case) in prose, and never touch a lower-case identifier.
//
// Pure: no imports, no clock, no I/O.

type Rule = readonly [RegExp, string | ((match: string, ...groups: string[]) => string)];

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

/** True when `offset` starts a sentence (start of text, or after . ! ? and a space, or a line break). */
function atSentenceStart(text: string, offset: number): boolean {
  if (offset === 0) return true;
  return /(?:[.!?]\s+|\n\s*)$/.test(text.slice(Math.max(0, offset - 4), offset));
}

/**
 * A rule written in lower case: matches case-insensitively and replaces keeping the capital of the matched text
 * ("The CPA decides" -> "You decide"; "the CPA decides" -> "you decide"). A match that begins with the word CPA is
 * always upper case, so it is capitalised only at the start of a sentence.
 */
function phrase(pattern: string, replacement: string): Rule {
  return [
    new RegExp(`\\b${pattern}\\b`, "gi"),
    (match: string, ...rest: unknown[]) => {
      // rest = [...capture groups, offset, whole string]
      const whole = rest[rest.length - 1] as string;
      const offset = rest[rest.length - 2] as number;
      const groups = rest.slice(0, -2) as Array<string | undefined>;
      // `$1`, `$2` in the replacement refer to the capture groups of `pattern`.
      const filled = replacement.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d) - 1] ?? "");
      const capital = match.startsWith("CPA") ? atSentenceStart(whole, offset) : isUpper(match.charAt(0));
      return capital ? filled.charAt(0).toUpperCase() + filled.slice(1) : filled;
    },
  ];
}

// Third-person verbs that follow "the CPA": base form after "you".
const VERBS: ReadonlyArray<readonly [string, string]> = [
  ["decides", "decide"],
  ["determines", "determine"],
  ["reviews", "review"],
  ["confirms", "confirm"],
  ["prepares", "prepare"],
  ["handles", "handle"],
  ["identifies", "identify"],
  ["records", "record"],
  ["applies", "apply"],
  ["completes", "complete"],
  ["adds", "add"],
  ["keys", "key"],
  ["concludes", "conclude"],
  ["settles", "settle"],
  ["reads", "read"],
  ["uses", "use"],
  ["files", "file"],
  ["classifies", "classify"],
  ["splits", "split"],
  ["allocates", "allocate"],
  ["enters", "enter"],
  ["reconciles", "reconcile"],
  ["chooses", "choose"],
  ["chose", "chose"],
  ["can", "can"],
  ["must", "must"],
  ["may", "may"],
];

const RULES: readonly Rule[] = [
  // ── Whole names of things (most specific first) ────────────────────────────────────────────────
  phrase("not sure - ask the CPA", "not sure - I need to look into this"),
  phrase("needs CPA \\(rule unverified\\)", "rule not verified (needs a professional's input or your own research)"),
  phrase("needs CPA review \\(rule not verified\\)", "rule not verified (needs a professional's input or your own research)"),
  phrase("needs CPA judgment", "needs your decision"),
  phrase("needs CPA decision", "needs your decision"),
  phrase("needs CPA input", "needs your input"),
  phrase("needs CPA review", "needs your review"),
  phrase("needs a CPA decision", "needs your decision"),
  phrase("needs a CPA's review", "needs your review"),
  phrase("needs (?:the )?CPA's review", "needs your review"),
  phrase("needs (?:the )?CPA\\b", "needs your decision"),
  phrase("need (?:the )?CPA's review", "need your review"),
  phrase("need (?:the )?CPA\\b", "need your decision"),
  phrase("CPA review required", "a professional's review is advised"),
  phrase("CPA review sheet", "return review sheet"),
  phrase("CPA review is still required", "your own review is still required"),
  phrase("for CPA review", "for your review"),
  phrase("CPA review", "your review"),
  phrase("CPA sign-off checklist", "sign-off checklist"),
  phrase("CPA sign-off", "your own sign-off"),
  phrase("CPA summary", "questions and answers summary"),
  phrase("an? (?:CPA ?/ ?owner|owner ?/ ?CPA) decision", "an owner decision"),
  phrase("an? CPA decision", "your decision"),
  phrase("CPA decisions", "owner decisions"),
  phrase("CPA decision", "owner decision"),
  phrase("(?:CPA|owner) ?/ ?(?:owner|CPA) (override)(s)?", "owner $1$2"),
  phrase("an? CPA (override)(s)?", "an owner $1$2"),
  phrase("(?:per )?CPA (override)(s)?", "owner $1$2"),
  phrase("CPA answer", "recorded answer (professional's)"),
  phrase("CPA-input", "owner-input"),
  phrase("CPA-facing", "review"),
  phrase("CPA-stated", "owner-stated"),
  phrase("CPA bundle", "accountant bundle"),
  phrase("CPA contact", "tax professional contact"),
  phrase("owner ?/ ?CPA", "owner"),
  phrase("owner and the CPA", "owner"),
  phrase("owner and CPA", "owner"),
  phrase("open items for (?:the )?CPA", "open items"),
  phrase("open questions for (?:the )?CPA", "open questions"),
  phrase("note for (?:the )?CPA", "note"),
  phrase("facts for (?:the |your )?CPA", "facts for your return"),
  phrase("acknowledged by (?:the )?CPA", "acknowledged by the owner"),
  phrase("stated by (?:the )?CPA", "stated by the owner"),
  phrase("supplied by (?:the )?CPA", "supplied by the owner"),
  phrase("(drafts?) for (?:the |your )?CPA to review", "$1 for you to review"),
  phrase("for (?:the |your )?CPA to review", "for you to review"),
  phrase("(?:the |your )?CPA to review", "you to review"),
  phrase("(drafts?) for (?:the |your )?CPA", "$1 for your review"),
  phrase("reviewed by (?:a|the|your) CPA", "reviewed by you"),
  phrase("computed for CPA review", "not yet approved"),
  phrase("the CPA is the preparer of record", "you are the preparer of record"),
  phrase("the CPA files", "you file"),
  phrase("the CPA figures them", "you figure them out"),
  phrase("the CPA works them", "you work them out"),
  phrase("the CPA records the decision", "you record the decision"),
  phrase("your CPA('s)? sign-off", "your own sign-off"),
  phrase("your CPA's software", "your tax software"),
  phrase("your CPA's call", "your decision"),
  phrase("(?:the )?CPA's call", "your decision"),
  phrase("your CPA's figure", "your figure"),
  phrase("your CPA's", "your"),
  phrase("a CPA must bless it", "get a professional's opinion on it"),
  phrase("a CPA question", "a question for you or a tax professional"),
  phrase("(is|are) the CPA's", "$1 yours to work out"),
  phrase("(is|are) (?:a|an) CPA (?:call|matter|item|decision)", "$1 for you to decide"),
  phrase("a CPA (?:call|matter|item)", "your call"),
  phrase("a CPA decision", "your decision"),
  phrase("the CPA's review", "your review"),
  phrase("the CPA's (?:own )?", "your "),
  phrase("(?:the )?CPA decides or supplies the rule", "you decide or supply the rule"),
  phrase("left (?:to|for) (?:the )?CPA", "left for you"),
  phrase("goes to (?:the |your )?CPA", "is yours to decide"),
  phrase("flagged for (?:the )?CPA", "flagged for you"),
  phrase("give the details to (?:the )?CPA", "prepare this yourself or ask a tax professional"),
  phrase("give the 1099-DIV to (?:the )?CPA, who uses", "use"),
  phrase("CPA to confirm no", "confirm yourself that no"),
  phrase("and tell (?:the |your )?CPA", "and note it for your records"),
  phrase("tell (?:the |your )?CPA so ([^.]+)", "make sure $1"),
  phrase("tell (?:the |your )?CPA if", "check whether"),
  phrase("CPA to check", "to check"),
  phrase("CPA to confirm none apply", "confirm none apply"),
  phrase("CPA to confirm(?= (?:the|material|that|whether)\\b)", "you confirm"),
  phrase("CPA to confirm", "confirm yourself"),
  phrase("confirm with (?:the |your )?CPA", "confirm with a tax professional if unsure"),
  phrase("tell (?:the |your )?CPA so", "decide so"),
  phrase("tell (?:the |your )?CPA if", "decide yourself if"),
  phrase("tell (?:the |your )?CPA", "keep a note for yourself"),
  phrase("give (?:the )?CPA the", "keep the"),
  phrase("give (?:the )?CPA", "keep"),
  phrase("with (?:the |your )?CPA", "with a tax professional"),
  phrase("(?:the |your )?CPA works (it|them) out", "you work $1 out"),
  phrase("(?:the |your )?CPA works it", "you work it out"),
  phrase("(?:the |your )?CPA works (this|these) (\\w+)", "you work out $1 $2"),
  phrase("(?:the |your )?CPA works", "you work out"),
  phrase("(?:the |your )?CPA figures (it|them)", "you figure $1 out"),
  phrase("(?:the |your )?CPA figures", "you figure out"),
  phrase("(?:the |your )?CPA decides", "you decide"),
  // Generic "the CPA <verb>" -> "you <verb>".
  ...VERBS.map(([third, base]) => phrase(`(?:the |your )?CPA ${third}\\b`, `you ${base}`)),
  // ── Residual: any standalone "CPA" left (case-sensitive, so identifiers such as cpa / needs_cpa_ stay) ──
];

const RESIDUAL: Rule = [/\b(?:(?:the|your|a|an) )?CPA\b/g, "a tax professional"];

const REASON_MARKER = ", reason: ";

/** Rewrite owner-visible prose so it never implies that a CPA reviews or prepares the return. */
export function ownerWording(text: string): string {
  if (!/CPA/i.test(text)) return text;
  // The reason an owner typed with an override is HIS record (formatOverrideNote ends with ", reason: <text>"): the
  // app's own words before it are reworded, his words are never altered.
  const reasonAt = text.indexOf(REASON_MARKER);
  if (reasonAt !== -1) return ownerWording(text.slice(0, reasonAt)) + text.slice(reasonAt);
  // Honesty statements ("not a CPA") are the one place the word is wanted: park them while the rules run.
  const parked: string[] = [];
  let out = text;
  for (const re of HONESTY_ALLOWLIST) {
    out = out.replace(re, (m) => {
      parked.push(m);
      return `\u0001${parked.length - 1}\u0001`;
    });
  }
  for (const [re, rep] of RULES) {
    re.lastIndex = 0;
    out = out.replace(re, rep as never);
  }
  RESIDUAL[0].lastIndex = 0;
  out = out.replace(RESIDUAL[0], RESIDUAL[1] as string);
  return out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => parked[Number(i)] ?? "");
}

/**
 * Apply ownerWording to every string leaf of a JSON-like value (arrays and plain objects are copied; other
 * values are returned as is). Keys are never rewritten and the rule set only matches the upper-case word, so a
 * persisted identifier value ("cpa", "needs_cpa_judgment", "answer_cpa") passes through unchanged.
 */
export function ownerWordingDeep<T>(value: T): T {
  if (typeof value === "string") return ownerWording(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => ownerWordingDeep(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return value;
    const record = value as Record<string, unknown>;
    // A recorded override (it has an authority and a version) carries text the OWNER typed: keep it as he wrote it.
    const isOverrideRecord = "authority" in record && "version" in record;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = isOverrideRecord && (k === "reason" || k === "by" || k === "setByName") ? v : ownerWordingDeep(v);
    }
    return out as T;
  }
  return value;
}

// ── Guards (used by the scan tests and by the final-package check) ───────────────────────────────

/**
 * Words that must not reach any rendered owner-visible output: the standalone word CPA (any case, but not as
 * part of an identifier such as needs_cpa_judgment, cpaNote or cpa-summary), and claims of professional
 * certification or review.
 */
const OWNER_BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["CPA", /(?<![A-Za-z0-9_-])cpa(?![A-Za-z0-9_-])/i],
  ["certified public accountant", /certified public accountant/i],
  ["professionally reviewed", /professionally reviewed/i],
  // A claim of licensure ("a licensed professional reviewed it"); an IRS/CT quote such as "a taxpayer licensed under Chapter 420f" is not one.
  ["licensed (claim)", /\blicensed (?:tax |public )?(?:professional|preparer|accountant|agent|expert)/i],
];

/** Honesty statements that may name the profession (the reviewer is NOT one). Matched text is removed before scanning. */
export const HONESTY_ALLOWLIST: readonly RegExp[] = [
  /(?:not|no|nor|never)\b[^.]{0,40}licensed (?:tax )?professionals?/gi,
  /not a CPA\b/gi,
  /enrolled agent, CPA or tax attorney/gi,
  /not a licensed (?:tax )?professional/gi,
  /not a licensed CPA(?:\/EA)?/gi,
  /(?:no|without a|not reviewed by a) (?:licensed )?CPA\b/gi,
];

/** Names of banned wording found in `text` ([] = clean). */
export function findOwnerBannedWording(text: string): string[] {
  let scan = text;
  for (const re of HONESTY_ALLOWLIST) scan = scan.replace(re, " ");
  return OWNER_BANNED.filter(([, re]) => re.test(scan)).map(([name]) => name);
}

/** Back-compat name used by the plan: the standalone word "CPA" only. */
export function findCpaWording(text: string): string[] {
  return findOwnerBannedWording(text).filter((n) => n === "CPA");
}

/**
 * The FINAL package (clean forms, attachments, package index, document properties) must read like a return an
 * individual prepared: no draft marker, no mention of how it was computed or checked, no tool names.
 * (plan 5.7 / 7.5). A real IRS form label that contains one of these words is not scanned: only text WE write is.
 */
const FINAL_BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["Claude", /claude/i],
  ["AI", /\bAI\b/],
  ["artificial", /artificial/i],
  ["Banana Stand", /banana\s*stand/i],
  ["this app", /\bthis (?:app|platform|system|software)\b/i],
  ["draft", /\bdraft/i],
  ["provisional", /provisional/i],
  ["estimate", /\bestimat/i],
  ["computed by", /computed (?:by|for|from)/i],
  ["reviewed by", /reviewed by/i],
  ["review", /\breview/i],
  ["override", /\boverrid/i],
  ["CPA", /\bCPA\b/i],
  ["preparer other than owner", /\bprepared by (?!Eric Kinniburgh \(self-prepared\))/i],
  ["engine", /\bengine\b/i],
];

/** Names of banned wording found in text we wrote into the final package ([] = clean). */
export function findFinalPackageBannedWording(text: string): string[] {
  return FINAL_BANNED.filter(([, re]) => re.test(text)).map(([name]) => name);
}
