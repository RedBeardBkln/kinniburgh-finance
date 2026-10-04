import { describe, expect, it } from "vitest";
import {
  assertSafeOutgoing,
  buildOutgoingJson,
  findRedactionIssues,
  isSafeOutgoing,
  labelHouseholdMembers,
  maskEin,
  RedactionError,
  scrubPeople,
  TAXPAYER_F,
  TAXPAYER_M,
} from "@/lib/tax-review/redact";

const PEOPLE = [
  { userId: "u-eric", name: "Eric Kinniburgh" },
  { userId: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
];

describe("findRedactionIssues", () => {
  it("flags an SSN in every common shape", () => {
    for (const t of ["123-45-6789", "123 45 6789", "123456789", "123.45.6789", "SSN 078-05-1120 on file"]) {
      expect(isSafeOutgoing(t), t).toBe(false);
    }
  });
  it("flags a bare nine-digit run and any longer digit run, but not amounts with separators or short numbers", () => {
    expect(findRedactionIssues("balance 123456789")).toContain("nine_digit_run");
    expect(findRedactionIssues("acct 1234567890123")).toContain("long_digit_run");
    expect(isSafeOutgoing("Total income $1,234,567,890 and 177967 and 2025-10-05")).toBe(true);
    expect(isSafeOutgoing("line 11a is 177,967")).toBe(true);
  });
  it("flags an EIN-shaped token and accepts the masked form", () => {
    expect(findRedactionIssues("employer 12-3456789")).toContain("ein_like");
    expect(isSafeOutgoing(maskEin("employer 12-3456789"))).toBe(true);
    expect(maskEin("EIN 12-3456789 and 98-7654321")).toBe("EIN **-***6789 and **-***4321");
  });
  it("sees through zero-width characters and full-width digits", () => {
    expect(isSafeOutgoing("123​-45​-6789")).toBe(false);
    expect(isSafeOutgoing("１２３-４５-６７８９")).toBe(false);
  });
  it("allows hex digests that happen to contain a 9-digit run", () => {
    expect(isSafeOutgoing("fingerprint 0123456789ab and ffff123456789000aaaa")).toBe(true);
    // a digits-only 12 character token is a number, not a digest
    expect(isSafeOutgoing("fingerprint 012345678901")).toBe(false);
  });
  it("never echoes the refused text", () => {
    try {
      assertSafeOutgoing("my ssn is 123-45-6789", "test payload");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RedactionError);
      expect(String((e as Error).message)).not.toMatch(/123/);
      expect(String((e as Error).message)).toMatch(/test payload/);
    }
  });
});

describe("household labels (owner decision D4)", () => {
  it("labels Eric 'Taxpayer M' and Eva-Laura 'Taxpayer F' and nothing else", () => {
    const l = labelHouseholdMembers(PEOPLE);
    expect(l.unmapped).toEqual([]);
    expect(l.byUserId.get("u-eric")).toBe(TAXPAYER_M);
    expect(l.byUserId.get("u-eva")).toBe(TAXPAYER_F);
    expect(TAXPAYER_M).toBe("Taxpayer M");
    expect(TAXPAYER_F).toBe("Taxpayer F");
  });
  it("reports an unknown member as unmapped instead of guessing", () => {
    const l = labelHouseholdMembers([...PEOPLE, { userId: "u-x", name: "Someone Else" }]);
    expect(l.unmapped).toEqual(["Someone Else"]);
  });
  it("scrubs full names, first names and surnames (including hyphenated parts), case-insensitively", () => {
    const labels = labelHouseholdMembers(PEOPLE);
    const out = scrubPeople("Wages for ERIC Kinniburgh; spouse Eva-Laura Ramirez-Wisiackas (eva) at Kinniburgh Consulting, LLC; Laura.", PEOPLE, labels);
    for (const real of ["eric", "kinniburgh", "eva", "laura", "ramirez", "wisiackas"]) expect(out.toLowerCase()).not.toContain(real);
    expect(out).toContain(TAXPAYER_M);
    expect(out).toContain(TAXPAYER_F);
  });
  it("does not touch words that merely contain a name token", () => {
    const labels = labelHouseholdMembers(PEOPLE);
    expect(scrubPeople("Evaluate the Erica account", PEOPLE, labels)).toBe("Evaluate the Erica account");
  });
  it("refuses to scrub (and so to send) when a household member has no label", () => {
    const people = [...PEOPLE, { userId: "u-x", name: "Someone Else" }];
    expect(() => scrubPeople("hi", people, labelHouseholdMembers(people))).toThrow(RedactionError);
    expect(() => buildOutgoingJson({ a: 1 }, people, "payload")).toThrow(RedactionError);
  });
});

describe("buildOutgoingJson", () => {
  it("returns scrubbed, EIN-masked JSON", () => {
    const json = buildOutgoingJson({ payer: "Kinniburgh Consulting, LLC", ein: "12-3456789", amount: 177967 }, PEOPLE, "payload");
    expect(json).toContain("Taxpayer M");
    expect(json).toContain("**-***6789");
    expect(json).not.toContain("12-3456789");
    expect(json).toContain("177967");
  });
  it("rejects the whole payload when an SSN or a long account number survives", () => {
    expect(() => buildOutgoingJson({ note: "SSN 123-45-6789" }, PEOPLE, "payload")).toThrow(RedactionError);
    expect(() => buildOutgoingJson({ account: "99887766554433" }, PEOPLE, "payload")).toThrow(RedactionError);
    expect(() => buildOutgoingJson({ routing: "021000021" }, PEOPLE, "payload")).toThrow(RedactionError);
  });
});
