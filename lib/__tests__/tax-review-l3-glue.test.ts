import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tax-review-build", () => ({ loadFormData: vi.fn(), loadReviewInputs: vi.fn() }));

import { scrubAddressesFor, scrubEntitiesFor } from "@/lib/tax-review-l3";
import { buildScrubber } from "@/lib/tax-review/llm/scrub";
import { fullFacts1b } from "./tax2025-fixtures";

// The DB-aware preparation (lib/tax-review-l3.ts): which names and addresses are scrubbed, and that it only READS.

describe("entity names to generic labels", () => {
  const rows = [
    { name: "Personal", slug: "personal" },
    { name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" },
    { name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" },
    { name: "Mezzo", slug: "mezzo" },
    { name: "Some New Venture Inc.", slug: "new-venture" },
    { name: "Unslugged Co", slug: null },
  ];
  it("labels the known businesses by slug, the unknown ones by number, and leaves the personal entity alone", () => {
    const { entities, labels } = scrubEntitiesFor(rows);
    expect(entities.map((e) => e.label)).toEqual(["the Property Management LLC", "the Consulting LLC", "the third business entity", "business entity 1", "business entity 2"]);
    expect(labels).toHaveLength(5);
    const scrub = buildScrubber({ entities, addresses: [] });
    expect(scrub("Schedule C of Eric Kinniburgh Consulting, LLC and EKC and Sudden Valley and Mezzo and Some New Venture")).toBe("Schedule C of the Consulting LLC and the Consulting LLC and the Property Management LLC and the third business entity and business entity 1");
    expect(scrub("Personal finances")).toBe("Personal finances");
  });
});

describe("addresses to generic labels", () => {
  it("maps the primary residence and every other known address, once each", () => {
    const f = fullFacts1b();
    f.deductions.primaryResidenceAddress = { value: "27 Old Barry Rd", basis: "derived", refs: [] };
    f.deductions.mortgages = [{ docId: "m", lender: "L", basis: "doc_verified", legacyFormat: false, refs: [], interestCents: 1, principalCents: 1, originationDate: null, mortgageInsuranceCents: null, pointsCents: null, box10Cents: null, propertyAddress: "27 Old Barry Rd, Town, CT 06000" }];
    f.deductions.propertyTaxBills = [
      { docId: "b1", label: "Town", basis: "doc_verified", legacyFormat: false, refs: [], taxType: "real_estate", address: "56 Arbor Rd", billedCents: 1, paidInYearCents: 1, kind: "other_real_estate", kindBasis: "answer_owner" },
      { docId: "b2", label: "Town", basis: "doc_verified", legacyFormat: false, refs: [], taxType: "real_estate", address: "56 arbor rd", billedCents: 1, paidInYearCents: 1, kind: "other_real_estate", kindBasis: "answer_owner" },
    ];
    const out = scrubAddressesFor(f, "27 Old Barry Rd");
    expect([...new Set(out.map((a) => a.label))]).toEqual(["the primary residence", "other property A"]);
    const scrub = buildScrubber({ entities: [], addresses: out });
    expect(scrub("bill for 56 Arbor Rd and 27 Old Barry Rd, Town, CT 06000")).toBe("bill for other property A and the primary residence");
  });
});

describe("the preparation is read-only", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "tax-review-l3.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("reads (findMany) and never writes, never calls a model, never logs the payload", () => {
    for (const banned of [/\.create\(/, /\.createMany\(/, /\.update\(/, /\.updateMany\(/, /\.delete\(/, /\.upsert\(/, /\$executeRaw/, /auditLog/, /@anthropic-ai/, /tax-review-anthropic/, /console\.log/]) expect(banned.test(src), String(banned)).toBe(false);
    expect(src).toContain("entity.findMany");
  });
  it("the read-only script uses the in-memory store and never the database store or an insert", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts", "tax-review", "run-ai-review.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(script).toContain("MemoryRunStore");
    for (const banned of [/tax-review-l3-store/, /dbAiRunStore/, /insertReviewRun/, /insertDisposition/, /insertApproval/, /\.create\(/, /\.update\(/, /\.delete\(/, /auditLog/, /actions\//, /ANTHROPIC_API_KEY/]) expect(banned.test(script), String(banned)).toBe(false);
    // nothing is sent without --yes
    expect(script).toMatch(/if \(!go\) \{[\s\S]*Nothing was sent/);
  });
});
