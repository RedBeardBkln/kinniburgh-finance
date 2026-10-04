import { describe, expect, it, vi } from "vitest";
import { buildReviewPayload, indexPayload, plainRuleStatus, serializePayload } from "@/lib/tax-review/llm/payload";
import { addressVariants, buildScrubber, entityVariants, GENERIC_ADDRESS_LABEL, scrubDeep } from "@/lib/tax-review/llm/scrub";
import { findRedactionIssues, RedactionError } from "@/lib/tax-review/redact";
import { PEOPLE, richFixture, SCRUB } from "./tax-review-l3-harness";
import { ERIC_ID } from "./tax2025-fixtures";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Privacy of what is sent to the model (ai-return-reviewer, B3; owner decisions): "Taxpayer M" / "Taxpayer F" only, EINs masked,
// street addresses and business names replaced by generic labels, and the whole payload refused if anything identifier-shaped is left.

describe("scrubber", () => {
  const scrub = buildScrubber({
    entities: [
      { name: "Eric Kinniburgh Consulting, LLC", label: "the Consulting LLC", aliases: ["EK Consulting", "EKC"] },
      { name: "Sudden Valley Property Management, LLC", label: "the Property Management LLC", aliases: ["Sudden Valley"] },
      { name: "Mezzo", label: "the third business entity" },
    ],
    addresses: [{ address: "56 Arbor Rd, Greenwich, CT 06830", label: "other property A" }],
  });
  it("replaces entity names, their short forms and the name without the legal suffix, case-insensitively", () => {
    expect(scrub("Schedule C of Eric Kinniburgh Consulting, LLC")).toBe("Schedule C of the Consulting LLC");
    expect(scrub("eric kinniburgh consulting llc and EK CONSULTING and ekc")).toBe("the Consulting LLC and the Consulting LLC and the Consulting LLC");
    expect(scrub("Sudden Valley Property Management LLC / sudden valley")).toBe("the Property Management LLC / the Property Management LLC");
    expect(scrub("Mezzo income")).toBe("the third business entity income");
  });
  it("does not touch a longer word that merely contains a short form", () => {
    expect(scrub("Mezzosoprano ekcellent")).toBe("Mezzosoprano ekcellent");
  });
  it("replaces known addresses (street line and full line) and any generic street address", () => {
    expect(scrub("tax bill for 56 Arbor Rd")).toBe("tax bill for other property A");
    expect(scrub("56 arbor rd, Greenwich, CT 06830")).toBe("other property A");
    expect(scrub("27 Old Barry Rd")).toBe(GENERIC_ADDRESS_LABEL);
    expect(scrub("1200 N. Main Street Apt 4B and 5 Elm Ave.")).toBe(`${GENERIC_ADDRESS_LABEL} and ${GENERIC_ADDRESS_LABEL}`);
    expect(scrub("14 PINE HILL ROAD")).toBe(GENERIC_ADDRESS_LABEL);
  });
  it("leaves ordinary return text alone", () => {
    for (const t of ["Schedule A line 5a State and local income taxes", "Form 1040 line 25a federal income tax withheld", "2025 estimated tax payments 4 of 4", "Total of lines 1a through 1h", "1099-B box A short-term, basis reported", "Form 8949 Part I box 1 row 3 (see attached statement)"]) expect(scrub(t)).toBe(t);
  });
  it("scrubDeep rewrites keys and string values only", () => {
    const out = scrubDeep({ "56 Arbor Rd": 5, list: ["Mezzo", 3, null, true], nested: { a: "EKC" } }, scrub);
    expect(out).toEqual({ "other property A": 5, list: ["the third business entity", 3, null, true], nested: { a: "the Consulting LLC" } });
  });
  it("variants: entity without its legal suffix, address street line", () => {
    expect(entityVariants({ name: "Acme Widgets, Inc.", label: "x" })).toContain("Acme Widgets");
    expect(addressVariants("12 Oak St, Town, CT 06000")).toEqual(["12 Oak St, Town, CT 06000", "12 Oak St"]);
  });
});

describe("the payload that leaves the app", () => {
  it("contains no real or first names, no address, no business name, no EIN, no identifier-shaped text", async () => {
    const f = await richFixture();
    const json = f.serialized.json;
    expect(json).not.toMatch(/\bEric\b|\bEva\b|Eva-Laura|Old Barry|Sample Consulting/i);
    expect(json).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|\b\d{9}\b/);
    expect(findRedactionIssues(json)).toEqual([]);
    expect(json).toContain("Taxpayer M");
    expect(json).toContain("Taxpayer F");
  });
  it("never says CPA and never carries the engine's status identifiers that contain it", async () => {
    const f = await richFixture();
    expect(f.serialized.json).not.toMatch(/\bCPA\b|needs_cpa|cpaNote|confirmWithCpa/i);
    expect(plainRuleStatus("needs_cpa_judgment")).toBe("needs_owner_decision");
    expect(plainRuleStatus("needs_cpa_rule_unverified")).toBe("rule_unverified");
    expect(plainRuleStatus("computed")).toBe("computed");
  });
  it("is deterministic for the same return and well under a megabyte", async () => {
    const f = await richFixture();
    const again = serializePayload(buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts: f.pipeline.ctx.facts, documents: [], bindings: [], l1Findings: [], entityLabels: [] }, PEOPLE), PEOPLE, SCRUB);
    const twice = serializePayload(buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts: f.pipeline.ctx.facts, documents: [], bindings: [], l1Findings: [], entityLabels: [] }, PEOPLE), PEOPLE, SCRUB);
    expect(again.json).toBe(twice.json);
    expect(f.serialized.bytes).toBeLessThan(1_000_000);
  });
  it("carries the return as computed: every line with its status and whole-dollar amount, the headline, the rules and the printed form text", async () => {
    const f = await richFixture();
    const p = f.payload;
    expect(p.meta.taxYear).toBe(2025);
    expect(p.lines.length).toBeGreaterThan(100);
    const agi = p.lines.find((l) => l.key === "f1040.11a");
    expect(agi?.amount).toBe(f.pipeline.ctx.view.lines["f1040.11a"]?.amount);
    expect(p.rules.length).toBeGreaterThan(5);
    expect(p.forms.find((x) => x.formId === "f1040")?.rows.length).toBeGreaterThan(5);
    expect(p.documents.length).toBe(f.pipeline.ctx.raw?.documents.length);
    expect(p.documents.every((d) => d.alias.length >= 8)).toBe(true);
    expect(p.income.w2.length).toBe(3);
    // never a document name, a raw extraction or a bank-style number key
    expect(JSON.stringify(p)).not.toMatch(/documentName|extractionData|routing ?number|account ?number/i);
  });
  it("the index the validators use knows every line, every headline row and every document alias", async () => {
    const f = await richFixture();
    const idx = indexPayload(f.payload);
    for (const l of f.payload.lines) expect(idx.lines.get(l.key)?.amount).toBe(l.amount);
    expect([...idx.headRows.keys()].sort()).toEqual(["agi", "balance", "ctAgi", "ctBalance", "ctPayments", "ctTax", "taxableIncome", "totalPayments", "totalTax"]);
    for (const d of f.payload.documents) expect(idx.docs.has(d.alias)).toBe(true);
    expect(idx.numbers.size).toBeGreaterThan(50);
  });
});

describe("fuzz: identifying text planted in the data never reaches the outgoing text", () => {
  const plants: { name: string; value: string; expect: "scrubbed" | "refused" }[] = [
    { name: "household first name", value: "Paid to Eric by wire", expect: "scrubbed" },
    { name: "spouse hyphenated name", value: "Eva-Laura Sample refund", expect: "scrubbed" },
    { name: "surname alone", value: "SAMPLE household", expect: "scrubbed" },
    { name: "entity name", value: "Sample Consulting, LLC payroll", expect: "scrubbed" },
    { name: "entity short form", value: "EK Consulting books", expect: "scrubbed" },
    { name: "known address", value: "27 Old Barry Rd statement", expect: "scrubbed" },
    { name: "unknown street address", value: "56 Arbor Rd", expect: "scrubbed" },
    { name: "apartment address", value: "1200 N. Main Street Apt 4B", expect: "scrubbed" },
    { name: "EIN", value: "Payer 12-3456789", expect: "scrubbed" },
    { name: "SSN with dashes", value: "123-45-6789", expect: "refused" },
    { name: "SSN with spaces", value: "123 45 6789", expect: "refused" },
    { name: "bare nine digits", value: "acct 123456789", expect: "refused" },
    { name: "long account number", value: "acct 1234567890123", expect: "refused" },
    { name: "full-width digits", value: "１２３－４５－６７８９", expect: "refused" },
  ];
  for (const plant of plants) {
    it(`${plant.name}: ${plant.expect}`, async () => {
      const f = await richFixture();
      const facts = structuredClone(f.pipeline.ctx.facts);
      const w2 = facts.income.w2s[0];
      if (w2 === undefined) throw new Error("fixture has no W-2");
      w2.employer = plant.value;
      const interest = facts.income.interest[0];
      if (interest !== undefined) interest.payer = plant.value;
      const build = () => serializePayload(buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts, documents: [], bindings: [], l1Findings: [], entityLabels: [] }, PEOPLE), PEOPLE, SCRUB);
      if (plant.expect === "refused") {
        let message = "";
        try {
          build();
        } catch (err) {
          expect(err).toBeInstanceOf(RedactionError);
          message = err instanceof Error ? err.message : "";
        }
        expect(message).not.toBe("");
        expect(message).not.toMatch(/123|456|789/);
      } else {
        const out = build().json;
        const hit = /\bEric\b|\bEva\b|Eva-Laura|Sample Consulting|EK Consulting|Old Barry|bArborb|Main Street|12-3456789/i.exec(out);
        expect(hit === null ? null : `[${hit[0]}] ${out.slice(Math.max(0, hit.index - 20), hit.index + 20)}`.replace(/\s+/g, "_")).toBeNull();
        expect(findRedactionIssues(out)).toEqual([]);
      }
    });
  }
  it("an unlabelled household member refuses the whole payload (the real name is never the fallback)", async () => {
    const f = await richFixture();
    const people = [...PEOPLE, { userId: "u3", name: "Zed Stranger" }];
    expect(() => serializePayload(buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts: f.pipeline.ctx.facts, documents: [], bindings: [], l1Findings: [], entityLabels: [] }, people), people, SCRUB)).toThrow(RedactionError);
  });
  it("a document's person is a label, never a name", async () => {
    const f = await richFixture();
    const people = PEOPLE;
    const doc = f.pipeline.ctx.raw?.documents[0];
    if (doc === undefined) throw new Error("no document");
    const p = buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts: f.pipeline.ctx.facts, documents: [{ id: doc.id, docType: doc.docType, taxYear: doc.taxYear, verified: doc.verified, extractionStatus: doc.extractionStatus, subjectType: "person", subjectUserId: ERIC_ID }], bindings: [], l1Findings: [], entityLabels: [] }, people);
    expect(p.documents[0]?.person).toBe("Taxpayer M");
  });
});
