// TESTER (independent) redaction fuzz + store-boundary probes for ai-return-reviewer UNIT X.
// `it.fails` = a CONFIRMED DEFECT recorded in 03-test-report-X.md: the assertion states the correct behaviour and currently
// does not hold; when the Coder fixes it, vitest reports the test as failing ("expected to fail") and the `.fails` is removed.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { buildOutgoingJson, isSafeOutgoing, labelHouseholdMembers, maskEin, RedactionError, scrubPeople } from "@/lib/tax-review/redact";
import { insertReviewRun, type ReviewStoreDb } from "@/lib/tax-review-store";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

const ZW = ["​", "‌", "‍", "⁠", "﻿", "­"];

describe("redaction: what IS refused (regression)", () => {
  const refused: [string, string][] = [
    ["ssn dashes", "123-45-6789"],
    ["ssn spaces", "123 45 6789"],
    ["ssn dots", "123.45.6789"],
    ["ssn bare", "123456789"],
    ["ssn mixed", "123 - 45 - 6789"],
    ["ssn full-width", "１２３－４５－６７８９"],
    ["ssn full-width bare", "１２３４５６７８９"],
    ["ssn newline", "123\n45\n6789"],
    ["ssn nbsp", "123 45 6789"],
    ["routing 9", "021000021"],
    ["account 10", "1234567890"],
    ["zip+4 bare", "068311234"],
    ["EIN dash", "12-3456789"],
    ["EIN en-dash", "12–3456789"],
    ["EIN text", "EIN 12-3456789"],
    ["currency 9 digits", "$123456789"],
    ["negative 9 digits", "-123456789"],
    ["trailing dot", "123456789."],
    ...ZW.map((z): [string, string] => [`ssn with zero-width U+${z.charCodeAt(0).toString(16)}`, `123${z}45${z}6789`]),
    ...ZW.map((z): [string, string] => [`9-run with zero-width U+${z.charCodeAt(0).toString(16)}`, `12345${z}6789`]),
  ];
  it.each(refused)("%s", (_n, s) => expect(isSafeOutgoing(s)).toBe(false));
  it("legit text is not refused", () => {
    for (const s of ["$1,234,567 of wages", "fingerprint 4dd661066a07", "a".repeat(64), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "00000000-0000-4000-8000-000000000001", "line 1a is 273,291", "year 2025", "12-34", "1234567", "12345678"]) {
      expect(isSafeOutgoing(s), s).toBe(true);
    }
  });
});

describe("redaction DEFECTS (it.fails): identifier-shaped text that is NOT refused", () => {
  it("a 10+ digit run split by a zero-width character is refused (the SSN check strips invisible characters, the digit-run check does not)", () => {
    for (const z of ZW) expect(isSafeOutgoing(`1234${z}567890`), `U+${z.charCodeAt(0).toString(16)}`).toBe(false);
  });
  it("a 12-digit run followed by hex letters is refused (the hex-digest exemption swallows it)", () => {
    for (const s of ["123456789abc", "1234567890ab", "123456789face", "abc123456789"]) expect(isSafeOutgoing(s), s).toBe(false);
  });
  it("a nine-digit SSN written with non-ASCII decimal digits is refused (NFKC does not map Arabic-Indic / Devanagari / Thai digits)", () => {
    for (const s of ["١٢٣٤٥٦٧٨٩", "१२३४५६७८९", "๑๒๓๔๕๖๗๘๙"]) expect(isSafeOutgoing(s), s).toBe(false);
  });
  it("an SSN-shaped 3-2-4 group joined by , / _ is refused", () => {
    for (const s of ["123,45,6789", "123/45/6789", "123_45_6789"]) expect(isSafeOutgoing(s), s).toBe(false);
  });
  it("a grouped 9-digit number (3-3-3) is refused", () => {
    for (const s of ["123 456 789", "123-456-789"]) expect(isSafeOutgoing(s), s).toBe(false);
  });
});

describe("EIN masking and household labels", () => {
  const people = [
    { userId: "u1", name: "Eric Kinniburgh" },
    { userId: "u2", name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  it("masks EINs to the last four", () => {
    expect(maskEin("12-3456789 and 98-7654321")).toBe("**-***6789 and **-***4321");
    expect(maskEin("12‐3456789")).toBe("**-***6789");
    expect(maskEin("no ein")).toBe("no ein");
  });
  it("labels Eric 'Taxpayer M' and Eva-Laura 'Taxpayer F'; scrubs every name variant (case, possessive, part, hyphen parts, full-width, zero-width)", () => {
    const labels = labelHouseholdMembers(people);
    expect(labels.byUserId.get("u1")).toBe("Taxpayer M");
    expect(labels.byUserId.get("u2")).toBe("Taxpayer F");
    for (const v of ["Eric Kinniburgh", "ERIC KINNIBURGH", "eric", "Eric's W-2", "Kinniburgh, Eric", "Eva-Laura Ramirez-Wisiackas", "Eva Laura Ramirez Wisiackas", "EVA", "Eva-Laura", "Ramirez-Wisiackas", "Wisiackas", "Ramirez", "Laura", "Ｅｒｉｃ", "Eric​Kinniburgh", "Eric,Kinniburgh", "ERIC.KINNIBURGH", "Eva‑Laura"]) {
      const out = scrubPeople(`W-2 for ${v} ok`, people, labels);
      expect(out, v).not.toMatch(/kinniburgh|ramirez|wisiackas|\beric\b|\beva\b|\blaura\b/i);
    }
  });
  it("an unmapped member makes the payload refuse; an SSN payload is refused; the error never echoes the text", () => {
    expect(() => buildOutgoingJson({ a: 1 }, [{ userId: "x", name: "Someone Else" }], "t")).toThrow(RedactionError);
    expect(() => buildOutgoingJson({ a: "123-45-6789" }, people, "t")).toThrow(RedactionError);
    try {
      buildOutgoingJson({ a: "987-65-4321" }, people, "t");
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/987|4321/);
    }
    const out = buildOutgoingJson({ payer: "Acme", ein: "12-3456789", who: "Eric Kinniburgh, Eva-Laura Ramirez-Wisiackas", amount: 12345 }, people, "t");
    expect(out).toContain("**-***6789");
    expect(out).not.toMatch(/Eric|Kinniburgh|Eva|Ramirez|Wisiackas|3456789/);
  });
});

describe("store boundary", () => {
  const good = makeFinding({ layer: "L1", check: "L1.x", severity: "info", area: "process", message: "ok", recommendedAction: "ok", acceptable: true });
  function capture() {
    const created: unknown[] = [];
    const tx = {
      taxReviewRun: { create: vi.fn(async ({ data }: { data: unknown }) => ({ ...(data as object), id: "r1", startedAt: new Date() })) },
      taxReviewFinding: {
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
          created.push(...data);
          return { count: data.length };
        }),
      },
    };
    const store = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as ReviewStoreDb;
    return { store, created };
  }
  const run = (store: ReviewStoreDb, findings: Finding[]) =>
    insertReviewRun({ taxYear: 2025, entityId: "e", fingerprint: "a".repeat(64), engineVersion: "x", startedById: null, startedByName: "Owner", config: {}, l1Summary: {}, l2Summary: {}, findings }, store);
  it("a finding that carries SSN-like text never reaches the table (the store comment promises it; only the shape is validated)", async () => {
    const { store, created } = capture();
    await expect(run(store, [{ ...good, message: "SSN 123-45-6789 on file" }])).rejects.toThrow();
    expect(created.length).toBe(0);
  });
});
