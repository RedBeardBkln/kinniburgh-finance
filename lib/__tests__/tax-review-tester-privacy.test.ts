import { describe, expect, it } from "vitest";
import { buildOutgoingJson, findRedactionIssues, labelHouseholdMembers, maskEin, scrubPeople } from "@/lib/tax-review/redact";
import { buildScrubber } from "@/lib/tax-review/llm/scrub";
import { verifyQuote } from "@/lib/tax-review/llm/sources";
import { loadSourcePack } from "@/lib/tax-review-sources";

// TESTER (reviewer-all), privacy fuzz of the redactor and scrubber with adversarial inputs, plus the quote verifier.
// Tables say what SHOULD be refused / replaced. Cases the implementation misses are listed in GAPS_* and asserted as they behave today,
// so a fix flips them loudly; the report lists each gap.

const PEOPLE = [
  { userId: "u1", name: "Eric Kinniburgh" },
  { userId: "u2", name: "Eva-Laura Ramirez-Wisiackas" },
];

const flagged = (s: string): boolean => findRedactionIssues(s).length > 0;

const MUST_FLAG: [string, string][] = [
  ["plain ssn", "123-45-6789"],
  ["ssn spaces", "123 45 6789"],
  ["ssn dots", "123.45.6789"],
  ["ssn underscore", "123_45_6789"],
  ["ssn slash", "123/45/6789"],
  ["ssn comma", "123,45,6789"],
  ["ssn mixed seps", "123 - 45 - 6789"],
  ["ssn en-dash", "123–45–6789"],
  ["ssn minus sign", "123−45−6789"],
  ["nine digits", "123456789"],
  ["nine digits in a sentence", "payer id 123456789 shown"],
  ["ten digits", "1234567890"],
  ["fullwidth digits", "１２３４５６７８９"],
  ["arabic-indic digits", "١٢٣٤٥٦٧٨٩"],
  ["devanagari digits", "१२३४५६७८९"],
  ["zero-width inside run", "12345​6789"],
  ["zero-width between every digit", "1​2​3​4​5​6​7​8​9​0"],
  ["soft hyphen inside run", "12345­6789"],
  ["bidi mark inside run", "12345‎6789"],
  ["bom inside run", "12345﻿6789"],
  ["word joiner inside run", "12345⁠6789"],
  ["ein dash", "12-3456789"],
  ["ein en dash", "12–3456789"],
  ["hex glued digits (letters before)", "abc123456789"],
  ["hex glued digits (letters after)", "123456789abc"],
  ["hex glued both", "ab123456789cd"],
  ["16-digit card number", "4111111111111111"],
  ["12-digit account", "123456789012"],
  ["ssn glued to letters", "SSN123456789"],
  ["ssn as 3-6", "123 456789"],
  ["ssn as 5-4", "12345 6789"],
  ["nine digits split by newline", "123\n45\n6789"],
  ["ssn with trailing text", "123-45-6789."],
  ["ssn in json", JSON.stringify({ a: { b: ["x", "123-45-6789"] } })],
];

// inputs that SHOULD be refused but the guard (shape-based) does not catch today
const GAPS_REDACTION: [string, string][] = [
  ["single digits spaced", "1 2 3 4 5 6 7 8 9"],
  ["ein with a space", "12 3456789"],
  ["card number in 4-4-4-4", "4111 1111 1111 1111"],
  ["account number in 4-4-4", "1234 5678 9012"],
  ["ssn words", "one two three four five six seven eight nine"],
  ["ein glued to a word (no word boundary before the digits)", "EIN12-3456789"],
];

const MUST_PASS: [string, string][] = [
  ["a dollar amount", "$1,234,567"],
  ["a plain number", "273291"],
  ["8 digits", "12345678"],
  ["a line key", "f1040.9"],
  ["a sha256 digest", "a".repeat(64)],
  ["a 64-hex digest holding a 9-digit run", `${"1234567890".repeat(1)}${"b".repeat(54)}`],
  ["a uuid", "123e4567-e89b-12d3-a456-426614174000"],
  ["a 16-hex finding key", "0123abcd4567ef89"],
  ["a date", "2025-12-31"],
  ["a form number", "Form 8995-A"],
  ["a thousands-grouped amount", "1,234,567,890"], // grouped by commas of 3: documented as intended
];

describe("tester: redactor refuses identifier-shaped text", () => {
  for (const [name, text] of MUST_FLAG) it(`refuses: ${name}`, () => expect(flagged(text), name).toBe(true));
  for (const [name, text] of MUST_PASS) it(`allows: ${name}`, () => expect(flagged(text), name).toBe(false));
});

describe("tester: redactor GAPS (shape-based guard; asserted as they behave today)", () => {
  for (const [name, text] of GAPS_REDACTION) it(`not caught today: ${name}`, () => expect(flagged(text), `${name}: if this fails the gap was fixed`).toBe(false));
});

describe("tester: hex-field exemption cannot be abused from DATA (only from code)", () => {
  const people = PEOPLE;
  it("a payer name that tries to forge a key field is escaped by JSON and still refused", () => {
    for (const evil of ['x","key":"4111111111111111', 'x\\",\\"key\\":\\"123456789012345\\', '","findingKey":"1234567890123456","a":"']) {
      expect(() => buildOutgoingJson({ payer: evil }, people, "t"), evil).toThrow(/refused/);
    }
  });
  it("only an exact 16-hex value under key / findingKey / evidenceHash is exempt; all else with a 9-digit run is refused", () => {
    const k = "1234567890abcdef";
    expect(buildOutgoingJson({ key: k }, people, "t")).toContain(k);
    expect(buildOutgoingJson({ findingKey: k }, people, "t")).toContain(k);
    expect(buildOutgoingJson({ evidenceHash: k }, people, "t")).toContain(k);
    for (const bad of [{ keys: k }, { Key: k }, { id: k }, { key: `${k}0` }, { key: k.slice(0, 15) }, { key: { x: k } }, [k], { key: [k] }, { note: `key ${k}` }]) {
      expect(() => buildOutgoingJson(bad, people, "t"), JSON.stringify(bad)).toThrow(/refused/);
    }
  });
  it("EXEMPTION GAP (code-only path): a 16-DIGIT value under a field named key is not refused (no letter required)", () => {
    // all-digit 16 characters match the exemption shape; harmless today because every `key` field in the payload is a line key or a sha-256 slice,
    // but any future payload field called `key` that carries data would let an account number through
    expect(() => buildOutgoingJson({ key: "4111111111111111" }, people, "t")).not.toThrow();
  });
  it("the digest exemption (32/40/64 hex with a letter) lets a number through when it is dressed as a digest (code-only path; data cannot choose its token shape)", () => {
    const smuggled = `123456789${"0".repeat(22)}a`; // 32 hex chars, one letter, a 9-digit run
    expect(smuggled).toHaveLength(32);
    expect(flagged(smuggled)).toBe(false);
    const sixtyFour = `123456789${"0".repeat(54)}a`;
    expect(flagged(sixtyFour)).toBe(false);
  });
  it("a uuid-shaped token is exempt wholesale (even if its groups hold an SSN)", () => {
    expect(flagged("12345678-9000-4000-8000-000000000000")).toBe(false);
  });
});

// ── names, streets, entities ─────────────────────────────────────────────────────────────────────────────
const SCRUB = buildScrubber({
  entities: [
    { name: "Eric Kinniburgh Consulting, LLC", label: "the Consulting LLC", aliases: ["EK Consulting", "EKC"] },
    { name: "Sudden Valley Property Management LLC", label: "the Property Management LLC", aliases: ["Sudden Valley"] },
  ],
  addresses: [
    { address: "56 Arbor Rd, Mystic, CT 06355", label: "other property A" },
    { address: "27 Old Barry Rd, Stonington, CT 06378", label: "the primary residence" },
  ],
});
const full = (s: string): string => buildOutgoingJson({ t: SCRUB(s) }, PEOPLE, "t");
const LEAKS = ["kinniburgh", "ramirez", "wisiackas", "eric", "eva", "arbor", "barry", "mystic", "stonington", "06355", "06378", "sudden valley", "kinniburgh consulting"];
const leaks = (out: string): string[] => LEAKS.filter((l) => out.toLowerCase().includes(l));

const MUST_SCRUB: [string, string][] = [
  ["exact address", "56 Arbor Rd, Mystic, CT 06355"],
  ["address no commas", "56 Arbor Rd Mystic CT 06355"],
  ["street only", "56 Arbor Rd"],
  ["street only upper", "56 ARBOR RD"],
  ["street only lower", "56 arbor rd"],
  ["street word suffix", "56 Arbor Road"],
  ["street word suffix upper", "56 ARBOR ROAD"],
  ["street word suffix period", "56 Arbor Rd."],
  ["fullwidth number", "５６ Arbor Rd"],
  ["old barry", "27 Old Barry Rd"],
  ["old barry upper", "27 OLD BARRY RD"],
  ["old barry lower", "27 old barry rd"],
  ["old barry with unit", "27 Old Barry Rd Apt 2"],
  ["entity", "Eric Kinniburgh Consulting, LLC"],
  ["entity no comma", "Eric Kinniburgh Consulting LLC"],
  ["entity upper", "ERIC KINNIBURGH CONSULTING, LLC"],
  ["entity alias", "EK Consulting"],
  ["sudden valley", "Sudden Valley Property Management LLC"],
  ["names", "Eric Kinniburgh and Eva-Laura Ramirez-Wisiackas"],
  ["names upper", "ERIC KINNIBURGH"],
  ["names lower", "eva-laura ramirez-wisiackas"],
  ["name possessive", "Eric's return, Eva's W-2"],
  ["name part only", "Wisiackas"],
  ["name hyphen part", "Ramirez"],
  ["name with comma order", "Kinniburgh, Eric"],
  ["initial plus surname", "E. Kinniburgh"],
  ["fullwidth name", "Ｅric Kinniburgh"],
  ["name in a possessive entity", "Kinniburgh's consulting"],
];

// adversarial spellings the scrubber does not handle today
const SCRUB_GAPS: [string, string, string][] = [
  ["zero-width inside a surname", "Kinni​burgh", "kinni"],
  ["zero-width inside a first name", "Er​ic", "er"],
  ["zero-width inside a known street", "56 Ar​bor Rd", "arbor"],
  ["street name alone (no number)", "the Arbor Rd property", "arbor"],
  ["street with a different suffix, lower case", "56 arbor road", "arbor"],
  ["unknown lower-case address", "14 elm street", "elm"],
  ["unknown address, one-letter suffix typo", "14 Elm Streeet", "elm"],
  ["town on its own", "in Mystic", "mystic"],
  ["homoglyph in surname (Cyrillic i)", "Kinnіburgh", "kinn"],
  ["name split across a line break", "Eric\nKinniburgh", ""],
];

describe("tester: names, streets and entities are replaced before anything is sent", () => {
  for (const [name, text] of MUST_SCRUB) {
    it(`scrubs: ${name}`, () => {
      const out = full(text);
      expect(leaks(out), `${name}: ${out}`).toEqual([]);
    });
  }
});

describe("tester: scrubber GAPS (asserted as they behave today)", () => {
  for (const [name, text, mustLeak] of SCRUB_GAPS) {
    it(`not scrubbed today: ${name}`, () => {
      const out = full(text).toLowerCase();
      if (mustLeak === "") return; // informational
      expect(out.includes(mustLeak), `${name}: if this fails the gap was fixed (${out})`).toBe(true);
    });
  }
});

describe("tester: ein masking and household labels", () => {
  it("masks an EIN to the last four", () => {
    expect(maskEin("EIN 12-3456789")).toBe("EIN **-***6789");
    expect(maskEin("EIN 12–3456789")).toBe("EIN **-***6789");
  });
  it("a person with no label rule stops the payload (never sent with the real name)", () => {
    expect(() => buildOutgoingJson({ a: 1 }, [{ userId: "u9", name: "Somebody Else" }], "t")).toThrow();
    const l = labelHouseholdMembers([{ userId: "u9", name: "Somebody Else" }]);
    expect(() => scrubPeople("x", [{ userId: "u9", name: "Somebody Else" }], l)).toThrow();
  });
});

// ── quote verifier ───────────────────────────────────────────────────────────────────────────────────────
describe("tester: the quote verifier", () => {
  const pack = loadSourcePack();
  const sample = "The basis of property you buy is usually its cost, including the purchase price and any costs of purchase, such as commissions.";
  it("accepts a verbatim quote (case and whitespace insensitive)", () => {
    expect(verifyQuote(pack, "i8949", sample)).toBe(true);
    expect(verifyQuote(pack, "i8949", `  ${sample.toUpperCase()}\n`)).toBe(true);
  });
  it("rejects: too short, altered word, another source, unknown source, empty, null", () => {
    expect(verifyQuote(pack, "i8949", "The basis of property you buy")).toBe(false); // 29 chars
    expect(verifyQuote(pack, "i8949", sample.replace("usually", "never"))).toBe(false);
    expect(verifyQuote(pack, "i1040sb", sample)).toBe(false);
    expect(verifyQuote(pack, "nope", sample)).toBe(false);
    expect(verifyQuote(pack, "i8949", "")).toBe(false);
    expect(verifyQuote(pack, "i8949", null)).toBe(false);
    expect(verifyQuote(pack, "i8949", undefined)).toBe(false);
  });
  it("rejects a paraphrase and a quote stitched from two places", () => {
    expect(verifyQuote(pack, "i8949", "The basis of property you buy is its price. The basis of property you buy is its price.")).toBe(false);
    expect(verifyQuote(pack, "i8949", "The basis of property you buy is usually its cost, including the purchase price and any costs of purchase, such as commissions. Report the sale on Form 8949 Part II.")).toBe(false);
  });
  it("QUOTE VERIFIER GAP: a quote with no words in it (dot leaders / digits) can verify against a form's leader dots or number runs", () => {
    const dots = verifyQuote(pack, "i8960", `${". ".repeat(20)}`.trim());
    const dotsAnywhere = ["i8960", "i8995", "i2210", "p587", "i1040gi", "ct1040i"].filter((id) => verifyQuote(pack, id, ". . . . . . . . . . . . . . . . . . . . . . "));
    // record what happens today (the report says whether it is a defect)
    console.log("dot-leader quote verifies:", dots, "sources:", dotsAnywhere.join(","));
  });
});
