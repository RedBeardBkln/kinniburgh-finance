// Canonical form of a US street address, so the SAME property always gets the SAME generic label everywhere in the AI review payload
// (ai-payload-fixes). The first live review saw the primary residence written two ways, "27 old barry rd quaker hill ct 06375" on the
// Form 1098 and "27 OLD BARRY ROAD, WATERFORD, CT 06385" on the property tax bill; the two became DIFFERENT labels ("the primary
// residence" and "other property A"), and the model concluded that the home's property tax was missing. Two spellings of one street
// line are one property: case, punctuation, spacing, the street suffix (Rd / Road, St / Street ...), the direction words (N / North)
// and whatever town, state or zip follows the street are not part of the identity. The identity is the HOUSE NUMBER + the STREET NAME
// (+ the street suffix when both written forms have one).
//
// PURE: no DB, no network, no clock.

/** Every written form of a street suffix, by its canonical short form. */
export const SUFFIX_FORMS: Readonly<Record<string, readonly string[]>> = {
  rd: ["rd", "road"],
  st: ["st", "street"],
  ave: ["ave", "av", "avenue"],
  ln: ["ln", "lane"],
  dr: ["dr", "drive"],
  ct: ["ct", "court"],
  cir: ["cir", "circle"],
  pl: ["pl", "place"],
  blvd: ["blvd", "boulevard"],
  pkwy: ["pkwy", "parkway"],
  hwy: ["hwy", "highway"],
  ter: ["ter", "terr", "terrace"],
  trl: ["trl", "trail"],
  way: ["way"],
  sq: ["sq", "square"],
  pt: ["pt", "point"],
  xing: ["xing", "crossing"],
};

/** Every written form of a direction word, by its canonical short form. */
export const DIRECTION_FORMS: Readonly<Record<string, readonly string[]>> = {
  n: ["n", "north"],
  s: ["s", "south"],
  e: ["e", "east"],
  w: ["w", "west"],
  ne: ["ne", "northeast"],
  nw: ["nw", "northwest"],
  se: ["se", "southeast"],
  sw: ["sw", "southwest"],
};

const SUFFIX_CANON = new Map<string, string>(Object.entries(SUFFIX_FORMS).flatMap(([canon, forms]) => forms.map((f): [string, string] => [f, canon])));
const DIRECTION_CANON = new Map<string, string>(Object.entries(DIRECTION_FORMS).flatMap(([canon, forms]) => forms.map((f): [string, string] => [f, canon])));

export interface CanonicalAddress {
  /** House number as written, lower case ("27", "12a"). */
  number: string;
  /** Street name words, lower case, directions in short form ("old barry", "n main"). */
  name: string;
  /** Canonical short street suffix ("rd"), or null when the written form has none. */
  suffix: string | null;
}

/**
 * The street line of an address in canonical form, or null when it does not start with a house number followed by a street name.
 * Whatever follows the street suffix (town, state, zip, direction, unit) is ignored; when there is a comma, only what precedes it is read.
 */
export function canonicalAddress(raw: string | null | undefined): CanonicalAddress | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.normalize("NFKC").toLowerCase();
  const comma = s.indexOf(",");
  if (comma >= 0) s = s.slice(0, comma);
  s = s
    .replace(/[.'’`]/g, "")
    .replace(/[-–—_/]/g, " ")
    .replace(/#/g, " # ")
    .replace(/\s+/g, " ")
    .trim();
  // a unit is not part of the identity of the street line
  const unit = /(?:^|\s)(?:apt|apartment|unit|ste|suite|#)(?:\s|$)/.exec(s);
  if (unit !== null) s = s.slice(0, unit.index).trim();
  const tokens = s.split(" ").filter((t) => t !== "");
  const number = tokens[0];
  if (number === undefined || !/^\d{1,6}[a-z]?$/.test(number) || tokens.length < 2) return null;
  // the first suffix word that has at least one name word before it ("27 old barry rd quaker hill ct" -> "rd", not the state "ct")
  let at = -1;
  for (let i = 2; i < tokens.length; i += 1) {
    if (SUFFIX_CANON.has(tokens[i] ?? "")) {
      at = i;
      break;
    }
  }
  const nameTokens = (at >= 0 ? tokens.slice(1, at) : tokens.slice(1, 5)).filter((t) => !/^\d{5}(?:-\d{4})?$/.test(t));
  if (nameTokens.length === 0) return null;
  const name = nameTokens.map((t) => DIRECTION_CANON.get(t) ?? t).join(" ");
  return { number, name, suffix: at >= 0 ? (SUFFIX_CANON.get(tokens[at] ?? "") ?? null) : null };
}

/** True when two street lines are the same property: same house number and street name; suffixes must agree when both have one. */
export function sameProperty(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalAddress(a);
  const cb = canonicalAddress(b);
  if (ca === null || cb === null) {
    // not street-shaped: equal only when the whole text is equal after case / punctuation / spacing are removed
    const flat = (x: string | null | undefined): string => (x ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return flat(a) !== "" && flat(a) === flat(b);
  }
  if (ca.number !== cb.number || ca.name !== cb.name) return false;
  return ca.suffix === null || cb.suffix === null || ca.suffix === cb.suffix;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One name word as a pattern: its written variants (a direction word) and tolerant of an apostrophe or period inside it. */
function wordPattern(token: string): string {
  const forms = DIRECTION_FORMS[token];
  if (forms !== undefined) return `(?:${forms.map(escapeRegExp).join("|")})\\.?`;
  return [...token].map(escapeRegExp).join("['’.`]?");
}

/**
 * A case-insensitive pattern (flags "giu") that finds EVERY written form of this street line in free text: "27 Old Barry Rd",
 * "27 OLD BARRY ROAD", "27 old barry rd." The town, state and zip that may follow are removed by the scrubber's tail rule, not here.
 * Returns null when the address is not street-shaped.
 */
export function addressPatternSource(raw: string): string | null {
  const c = canonicalAddress(raw);
  if (c === null) return null;
  const words = c.name.split(" ").map(wordPattern).join("[\\s,.\\-–—]+");
  const anySuffix = Object.values(SUFFIX_FORMS).flat();
  const forms = c.suffix === null ? anySuffix : (SUFFIX_FORMS[c.suffix] ?? [c.suffix]);
  const suffix = `(?:[\\s,.\\-–—]+(?:${forms.map(escapeRegExp).join("|")})\\b\\.?)${c.suffix === null ? "?" : ""}`;
  return `(?<![\\p{L}\\p{N}])${escapeRegExp(c.number)}[\\s,.\\-–—]+${words}${suffix}(?![\\p{L}\\p{N}])`;
}
