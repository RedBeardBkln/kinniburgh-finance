// pdf-lib's standard fonts (Helvetica) encode WinAnsi only and THROW on any other
// character. Every string that reaches a PDF goes through sanitizeWinAnsi first, so
// a stray curly quote, emoji or accented letter in a payer name can never abort a
// whole packet (plan section 6.4).

const WIN_ANSI_EXTRAS: ReadonlySet<number> = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019,
  0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiCodePoint(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRAS.has(cp);
}

/** Replacements applied before the generic fallback; ASCII output keeps fields plain. */
const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/…/g, "..."],
  [/[•●▪]/g, "*"],
  [/™/g, "(TM)"],
  [/[   -   　]/g, " "],
  [/[​-‍⁠﻿]/g, ""],
];

/**
 * Make a string safe for WinAnsi standard fonts: typographic characters become ASCII,
 * control characters (including newlines) become a space, accents that WinAnsi cannot
 * hold are stripped, and anything still unencodable becomes "?". Never throws.
 */
export function sanitizeWinAnsi(input: string): string {
  let s = input;
  for (const [re, rep] of REPLACEMENTS) s = s.replace(re, rep);
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isWinAnsiCodePoint(cp)) {
      out += ch;
      continue;
    }
    const stripped = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    let ok = stripped.length > 0;
    for (const c of stripped) {
      const ccp = c.codePointAt(0);
      if (ccp === undefined || !isWinAnsiCodePoint(ccp)) ok = false;
    }
    out += ok ? stripped : "?";
  }
  return out;
}
