import { describe, expect, it } from "vitest";
import { findRedactionIssues, labelHouseholdMembers, maskEin, scrubPeople } from "@/lib/tax-review/redact";
import { buildScrubber } from "@/lib/tax-review/llm/scrub";

// TESTER (ai-return-reviewer, final): 300 adversarial strings per new redactor shape, and 300+ legitimate strings that must NOT be
// refused (a false refusal would drop findings or break runReviewChecks). Generators are mine; seeded, so a failure is reproducible.

let seed = 20261004;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const digits = (n: number): string => Array.from({ length: n }, () => String(int(0, 9))).join("");
const flagged = (t: string): boolean => findRedactionIssues(t).length > 0;

const PREFIX = ["", "Account ", "ref: ", "see ", "the number is ", "Taxpayer M wrote ", "(", "\"", "TIN ", "payer id ", "note - "];
const SUFFIX = ["", " end", ".", ")", "\"", " and more", ", ok", " per the form"];
const wrap = (core: string): string => pick(PREFIX) + core + pick(SUFFIX);
const SEPS1 = [" ", "-", ".", "/", "_", ",", "–", "−", " "];
const ZW = ["", "", "", "​", "‍", "⁠", "­", "﻿"];
const NONASCII: Record<string, string> = { "0": "٠", "1": "١", "2": "٢", "3": "٣", "4": "٤", "5": "٥", "6": "٦", "7": "٧", "8": "٨", "9": "٩" };
const maybeNonAscii = (s: string): string => (rnd() < 0.15 ? s.replace(/[0-9]/g, (d) => NONASCII[d] ?? d) : s);

const gens: Record<string, () => string> = {
  spacedSingles: () => {
    const n = int(9, 14);
    const sep = pick(SEPS1);
    return wrap(maybeNonAscii(Array.from({ length: n }, () => String(int(0, 9))).join(sep + pick(ZW))));
  },
  splitEin: () => wrap(maybeNonAscii(`${digits(2)}${pick([" ", ".", "_", "/", "  ", " .", "–", "-", "−"])}${pick(ZW)}${digits(7)}`)),
  card4444: () => {
    let groups: string[];
    do groups = [digits(4), digits(4), digits(4), digits(4)];
    while (groups.every((g) => Number(g) >= 1990 && Number(g) <= 2100));
    const s = pick([" ", "-", ".", "/", "_", "  ", " - "]);
    return wrap(maybeNonAscii(groups.join(s)));
  },
  card465: () => wrap(maybeNonAscii([digits(4), digits(6), digits(5)].join(pick([" ", "-", ".", "/", "_"])))),
  gluedEin: () => wrap(`${pick(["EIN", "ein", "Ein:", "EIN#", "TIN", "FEIN-", "ein:", "id", "x"])}${digits(2)}${pick(["-", "–", "−"])}${digits(7)}`),
  longRun: () => wrap(digits(int(9, 17))),
  ssnVariants: () => {
    const a = digits(3), b = digits(2), c = digits(4);
    return wrap(`${a}${pick(["-", " ", ".", "_", "/", "–", ", "])}${b}${pick(["-", " ", ".", "_", "/", "–", ", "])}${c}`);
  },
};

describe("tester(final): the redactor refuses every adversarial spelling of an identifier (300 each)", () => {
  for (const [name, gen] of Object.entries(gens)) {
    it(`${name}: 300 random strings, none passes`, () => {
      const misses: string[] = [];
      for (let i = 0; i < 300; i += 1) {
        const s = gen();
        if (!flagged(s)) misses.push(JSON.stringify(s));
      }
      expect(misses, `not refused: ${misses.slice(0, 6).join(" | ")}`).toEqual([]);
    });
  }
});

// ── legitimate text that must pass ───────────────────────────────────────────────────────────────────────
const FORMS = ["8949", "8959", "8960", "8995", "6251", "1040", "2210", "8283", "4562", "8829", "1116", "5695", "8863", "8962"];
const hex = (n: number): string => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
/** 12 / 16-character hex tokens are exempt only without a 9-digit run (by design, documented); the app's own digests of that length are 12 / 16 hex slices. */
const hexNo9 = (n: number): string => {
  for (;;) {
    const h = hex(n);
    if (!/[0-9]{9,}/.test(h)) return h;
  }
};
const money = (): string => {
  const whole = int(0, 9) === 0 ? int(1, 9_999_999) : int(1, 999_999);
  const s = whole.toLocaleString("en-US");
  return pick(["$", "", "$", "(", "-$"]) + s + pick(["", "", ".00", ".83", ".5"]) + (s.length && false ? "" : "");
};
const lineRef = (): string => `${pick(["Form 1040", "Schedule 1", "Schedule A", "Schedule D", "Form 8960", "Form 8995", "Form 6251", "Form 8959", "Schedule 2", "CT-1040"])} line ${pick(["1a", "1z", "5d", "8z", "9b", "12", "16", "17", "37", "25a", "2b", "11a"])}`;
const legit: Record<string, () => string> = {
  formLists: () => `Forms ${Array.from({ length: int(2, 7) }, () => pick(FORMS)).join(pick([", ", ", ", " and ", "; ", ", and "]))} apply.`.replace(/ and apply/, " apply"),
  years: () => pick([`tax years ${pick(["2022", "2023"])}, 2024 and 2025`, "2022 2023 2024 2025", "2021-2022-2023-2024", "years 2019, 2020, 2021, 2022, 2023", "TY2025", "the 2025 return, 2026 estimates"]),
  amounts: () => `${lineRef()} is ${money()} and ${lineRef()} is ${money()}`,
  amountList: () => `Totals: ${Array.from({ length: int(2, 6) }, () => money()).join(pick([" ; ", " and ", " | "]))}`,
  digests: () => pick([`fingerprint ${hex(64)}`, `fp ${hexNo9(12)}`, `key ${hexNo9(16)}`, `sha256 ${hex(64)} ok`, `fp12 ${hexNo9(12)} run`, `id ${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`]),
  lineRefs: () => `${lineRef()} plus ${lineRef()} less ${lineRef()}`,
  dates: () => pick([`2025-12-31`, `12/31/2025`, `10/04/2026 22:21`, `April 15, 2026`, `filed 2026-10-15 at 09:30`, `01-02-2026`]),
  ratios: () => `ratio ${int(1, 99)} / ${int(100, 999)} and ${int(1, 99)}.${int(1, 99)}%`,
  smallLists: () => `pages ${Array.from({ length: int(2, 8) }, () => int(1, 9)).join(" ")} of ${int(10, 99)}`,
  taxTable: () => `Tax Table row ${int(1, 99)},${String(int(0, 999)).padStart(3, "0")}-${int(1, 99)},${String(int(0, 999)).padStart(3, "0")} gives ${money()}`,
  prose: () => pick([
    "The engine prints 0 where the printed form says to enter the smaller of the two lines.",
    "Taxpayer M and Taxpayer F: W-2 box 1 total 273,291; Medicare wages 273,832; excess 23,832.",
    "L2.diff.f8995.16 differs by $9,010 (engine 0, recomputed (9,010)).",
    "Form 8960 line 12 = 6,314; NIIT 3.8% x 6,314 = 240; Schedule 2 line 21 = 454.",
    "Document 3 of 12 (W-2, FOX FARM BREWERY, LLC) verified; box 12 code DD 8,000.",
    "Page 1 of 9, 2 of 9, 3 of 9 ... 9 of 9.",
  ]),
};

describe("tester(final): legitimate text is NOT refused (300+ strings per kind)", () => {
  for (const [name, gen] of Object.entries(legit)) {
    it(`${name}: 300 random strings, none refused`, () => {
      const refused: string[] = [];
      for (let i = 0; i < 300; i += 1) {
        const s = gen();
        const issues = findRedactionIssues(s);
        if (issues.length > 0) refused.push(`${JSON.stringify(s)} => ${issues.join(",")}`);
      }
      expect(refused, `false refusals: ${refused.slice(0, 6).join(" | ")}`).toEqual([]);
    });
  }
});

// ── probes whose behaviour is documented, not asserted either way (the report lists the answers) ───────────
describe("tester(final): borderline strings (recorded, not asserted)", () => {
  const PROBES = [
    "Forms 8949 8959 8960 8995",
    "Forms 8949 8959 8960 8995 6251",
    "Schedule 1 lines 1, 2, 3, 4, 5, 6, 7, 8, 9",
    "lines 1 2 3 4 5 6 7 8 9",
    "Form 1040 lines 1 through 9",
    "Tax Table 100 150 200 250 300 350 400 450 500",
    "12 3456789",
    "EIN12-3456789",
    "4111 1111 1111 1111",
    "4-4-4 123 4567 8901",
    "Schedule 2 lines 4, 6, 7 and 8, 9, 10, 11, 12",
  ];
  it("prints how each one is classified", () => {
    const rows = PROBES.map((p) => `${JSON.stringify(p)} => ${findRedactionIssues(p).join(",") || "ok"}`);
    console.log("PROBES\n" + rows.join("\n"));
    expect(rows.length).toBe(PROBES.length);
  });
});

// ── the scrubber ───────────────────────────────────────────────────────────────────────────────────────────
const PEOPLE = [
  { userId: "u1", name: "Eric Kinniburgh" },
  { userId: "u2", name: "Eva-Laura Ramirez-Wisiackas" },
];
const LABELS = labelHouseholdMembers(PEOPLE);
const SCRUB = buildScrubber({
  entities: [
    { name: "Eric Kinniburgh Consulting, LLC", label: "the Consulting LLC", aliases: ["EK Consulting"] },
    { name: "Sudden Valley Property Management LLC", label: "the Property Management LLC" },
    { name: "Mezzo", label: "the Mezzo entity" },
  ],
  addresses: [
    { address: "56 Arbor Rd, Stonington, CT 06378", label: "the other property" },
    { address: "27 Old Barry Rd, Mystic, CT 06355", label: "the primary residence" },
  ],
});

function interleave(phrase: string, ch: string, every: number): string {
  return [...phrase].map((c, i) => (c !== " " && i % every === 0 ? c + ch : c)).join("");
}

describe("tester(final): the zero-width-tolerant scrubbers hide no name and street (300 adversarial strings)", () => {
  const NAMES = ["Eric Kinniburgh", "Eva-Laura Ramirez-Wisiackas", "Wisiackas", "Ramirez", "Kinniburgh", "Eva", "Eric"];
  const STREETS = ["56 Arbor Rd", "27 Old Barry Rd"];
  const ENTITIES = ["Eric Kinniburgh Consulting, LLC", "Sudden Valley Property Management LLC", "Mezzo", "EK Consulting"];
  const ZWS = ["​", "‌", "‍", "⁠", "­", "‎", "‬"];
  it("people: names with zero-width characters inside, around, and between words are replaced", () => {
    const leaks: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const name = pick(NAMES);
      const z = pick(ZWS);
      const variant = pick([interleave(name, z, int(1, 3)), name.replace(/ /g, " " + z), name.replace(/ /g, z + " "), z + name + z, name.replace(/ /g, z)]);
      const text = `payer ${variant} paid 100`;
      const out = scrubPeople(text, PEOPLE, LABELS).normalize("NFKC").replace(/[\p{Cf}­]/gu, "");
      if (/Kinniburgh|Ramirez|Wisiackas|\bEva\b|\bEric\b|\bLaura\b/i.test(out)) leaks.push(`${JSON.stringify(variant)} -> ${JSON.stringify(out)}`);
    }
    expect(leaks, leaks.slice(0, 5).join(" | ")).toEqual([]);
  });
  it("streets and entities: replaced through zero-width characters (the same ZW set, never FEFF)", () => {
    const leaks: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const target = pick([...STREETS, ...ENTITIES]);
      const z = pick(ZWS);
      const variant = pick([interleave(target, z, int(1, 3)), target.replace(/ /g, " " + z), target.replace(/ /g, z + " "), target.replace(/ /g, z)]);
      const out = SCRUB(`see ${variant} here`).replace(/the (?:Mezzo entity|Consulting LLC|Property Management LLC)/g, "").normalize("NFKC").replace(/[\p{Cf}­]/gu, "");
      if (/Arbor|Barry|Kinniburgh|Sudden Valley|Mezzo|EK Consulting/i.test(out)) leaks.push(`${JSON.stringify(variant)} -> ${JSON.stringify(out)}`);
    }
    expect(leaks, leaks.slice(0, 5).join(" | ")).toEqual([]);
  });
  it("EIN masking: only the last four digits survive, also glued to a word", () => {
    for (const s of ["EIN12-3456789", "ein:12-3456789", "12-3456789", "(12–3456789)"]) {
      const out = maskEin(s);
      expect(out, s).not.toMatch(/3456/);
      expect(out, s).toContain("**-***6789");
    }
  });
});

describe("tester(final): the zero-width scrubber must not hang (ReDoS)", () => {
  // D2 (tester final report), FIXED: the word gap of invisibleTolerant() is one character class (it was (?:s|<invisible class>)+ with U+FEFF in both, 2^N backtracking).
  // followed by a mismatch backtracks 2^n ways. Measured: 14 characters = 4-10 s, 16 characters = about 80 s. A ZWSP run is linear.
  it("a ZWSP run followed by a mismatch is fast (control)", () => {
    const t = Date.now();
    SCRUB("56" + "​".repeat(40) + "Arbor" + "​".repeat(40) + "Rx");
    expect(Date.now() - t).toBeLessThan(200);
  });
  it("a U+FEFF run followed by a mismatch is fast (12 characters already takes 0.25-0.6 s)", () => {
    const t = Date.now();
    SCRUB("56" + "﻿".repeat(12) + "Arbor" + "﻿".repeat(12) + "Rx");
    SCRUB("Eric" + "﻿".repeat(12) + "Kinniburgh" + "﻿".repeat(12) + "Consulti");
    expect(Date.now() - t).toBeLessThan(100);
  });
});

// ── the quote verifier (minimum letters / words) against the REAL pinned source pack ───────────────────────────
import { loadSourcePack } from "@/lib/tax-review-sources";
import { hasEnoughWords, normalizeForQuote, verifyQuote } from "@/lib/tax-review/llm/sources";

describe("tester(final): verifyQuote on the real pinned sources", () => {
  const pack = loadSourcePack();
  const ids = Object.keys(pack.texts);
  it("real sentences from every source still verify (10 per source), dot leaders / number runs / letter strings do not", () => {
    expect(ids.length).toBeGreaterThanOrEqual(6);
    let checked = 0;
    const misses: string[] = [];
    for (const id of ids) {
      const lines = (pack.texts[id] ?? "").split(/\r?\n/).filter((l) => l.replace(/\s+/g, " ").trim().length >= 90 && /\p{L}{3,}/u.test(l));
      expect(lines.length, id).toBeGreaterThan(20);
      for (let i = 0; i < 10; i += 1) {
        const line = pick(lines).replace(/\s+/g, " ").trim();
        const start = line.indexOf(" ", int(0, Math.max(0, line.length - 80))) + 1;
        const quote = line.slice(start, start + 70);
        if (!hasEnoughWords(normalizeForQuote(quote)) || quote.length < 40) continue;
        checked += 1;
        if (!verifyQuote(pack, id, quote)) misses.push(`${id}: ${JSON.stringify(quote)}`);
      }
    }
    expect(checked).toBeGreaterThan(40);
    // a handful of extraction oddities (ligatures, hyphenation) may exist; report them but they must be rare
    expect(misses.length, misses.slice(0, 5).join(" | ")).toBeLessThanOrEqual(Math.ceil(checked * 0.05));
    // hollow strings that occur verbatim in the sources never verify
    let leaders = 0;
    for (const id of ids) {
      const text = pack.texts[id] ?? "";
      for (const m of text.matchAll(/(?:\. ?){20,}/g)) {
        leaders += 1;
        expect(verifyQuote(pack, id, m[0]), `${id} leader`).toBe(false);
        if (leaders > 50) break;
      }
      for (const m of text.matchAll(/(?:\d[\d,.]*\s+){10,}/g)) expect(verifyQuote(pack, id, m[0]), `${id} number run`).toBe(false);
    }
    expect(leaders).toBeGreaterThan(0);
  });
  it("boundaries: 19 letters / 5 words, 20 letters / 4 words, 20 letters / 5 words, letter-by-letter", () => {
    expect(hasEnoughWords("aaaa bbbb cccc dddd eee")).toBe(false); // 19 letters, 5 words
    expect(hasEnoughWords("aaaa bbbb cccc dddd eeee")).toBe(true); // 20 letters, 5 words
    expect(hasEnoughWords("ab cd ef gh ij")).toBe(false); // 10 letters
    expect(hasEnoughWords("abcdefghij klmnopqrs tu vwx yz")).toBe(true); // 24 letters, 5 words
    expect(hasEnoughWords("abcdefghijklmnopqrst uvwxyzabcd efghijklmn opqrstuvwx")).toBe(false); // 4 words
    expect(hasEnoughWords("a b c d e f g h i j k l m n o p q r s t u v w x y z")).toBe(false); // 26 letters, no word of 2+
    expect(hasEnoughWords("1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24")).toBe(false);
  });
});
