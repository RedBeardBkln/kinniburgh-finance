import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/tax-review-build", () => ({ loadFormData: vi.fn(), loadReviewInputs: vi.fn() }));

import { acceptedFindingsOf, entityActiveInYear, recordedDecisionsOf, scrubAddressesFor, scrubEntitiesFor } from "@/lib/tax-review-l3";
import { addressPatternSource, canonicalAddress, sameProperty } from "@/lib/tax-review/llm/address";
import { buildOwnerStatements, neutralTarget, OWNER_STATEMENTS_TY2025 } from "@/lib/tax-review/llm/owner-statements";
import { DECISION_KEYS, DECISION_REGISTRY } from "@/lib/tax2025/overrides";
import { LINE_CATALOG } from "@/lib/tax2025/line-catalog";
import { billRole, buildReviewPayload, mortgageRole, packetManifestOf, serializePayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { buildScrubber } from "@/lib/tax-review/llm/scrub";
import { PROMPT_VERSION, REVIEW_RULES, SYSTEM_PROMPT, TASKS, taskContentHash, userPrompt } from "@/lib/tax-review/llm/tasks";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { isEntityActiveForYear, isEntityUnformed } from "@/lib/tax-entities";
import { PEOPLE, richFixture } from "./tax-review-l3-harness";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import type { PropertyTaxBill } from "@/lib/tax2025/facts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ai-payload-fixes: lessons of the first live AI review (46 findings, 4 of them false because of how the payload was written).

// The real shapes from the first review (the printed forms differ in case, suffix, punctuation and town / zip).
const FORM_1098 = "27 old barry rd quaker hill ct 06375";
const TAX_BILL = "27 OLD BARRY ROAD, WATERFORD, CT 06385";
const ARBOR_SHORT = "56 Arbor Rd";
const ARBOR_BILL = "56 ARBOR ROAD, WATERFORD CT";

describe("canonical street address", () => {
  it("reads number, street name and suffix; ignores case, punctuation, town, state and zip", () => {
    expect(canonicalAddress(FORM_1098)).toEqual({ number: "27", name: "old barry", suffix: "rd" });
    expect(canonicalAddress(TAX_BILL)).toEqual({ number: "27", name: "old barry", suffix: "rd" });
    expect(canonicalAddress(ARBOR_SHORT)).toEqual({ number: "56", name: "arbor", suffix: "rd" });
    expect(canonicalAddress(ARBOR_BILL)).toEqual({ number: "56", name: "arbor", suffix: "rd" });
  });
  it("treats every suffix variant, directions, periods and units as the same street", () => {
    for (const [a, b] of [
      ["12 Elm St", "12 ELM STREET"],
      ["9 Park Ave.", "9 Park Avenue, Town CT"],
      ["4 Oak Ln", "4 oak lane"],
      ["8 Shore Dr", "8 Shore Drive"],
      ["3 Mill Ct", "3 Mill Court"],
      ["5 Bay Cir", "5 Bay Circle"],
      ["7 Rose Pl", "7 Rose Place"],
      ["10 Main Blvd", "10 Main Boulevard"],
      ["11 Ridge Pkwy", "11 Ridge Parkway"],
      ["6 Coast Hwy", "6 Coast Highway"],
      ["2 Hill Ter", "2 Hill Terrace"],
      ["1 Fox Trl", "1 Fox Trail"],
      ["100 N. Main St", "100 North Main Street"],
      ["100 N Main St Apt 4B", "100 NORTH MAIN ST, #4"],
    ] as const) {
      expect(sameProperty(a, b), `${a} / ${b}`).toBe(true);
    }
  });
  it("does not merge different houses or streets", () => {
    expect(sameProperty("27 Old Barry Rd", "29 Old Barry Rd")).toBe(false);
    expect(sameProperty("27 Old Barry Rd", "27 Barry Rd")).toBe(false);
    expect(sameProperty(ARBOR_SHORT, FORM_1098)).toBe(false);
    expect(sameProperty("12 Park Ave", "12 Park St")).toBe(false);
    expect(sameProperty(null, "27 Old Barry Rd")).toBe(false);
    expect(canonicalAddress("PO Box 12")).toBeNull();
    expect(canonicalAddress("")).toBeNull();
  });
  it("a state abbreviation that is also a street suffix (CT) does not end the street name early", () => {
    expect(canonicalAddress("27 old barry rd quaker hill ct 06375")?.name).toBe("old barry");
    expect(canonicalAddress("56 Arbor, Waterford CT")).toEqual({ number: "56", name: "arbor", suffix: null });
  });
  it("the pattern for a known street line finds every written form in free text", () => {
    const source = addressPatternSource(FORM_1098);
    expect(source).not.toBeNull();
    const re = new RegExp(source ?? "", "giu");
    for (const text of ["27 Old Barry Road", "27 OLD BARRY RD.", "27 old barry rd", "27 Old  Barry Rd"]) expect(text.replace(re, "X")).toBe("X");
    expect("29 Old Barry Rd".replace(re, "X")).toBe("29 Old Barry Rd");
  });
});

function bill(id: string, address: string, kind: PropertyTaxBill["kind"]): PropertyTaxBill {
  return { docId: id, label: "Town", basis: "doc_verified", legacyFormat: false, refs: [], taxType: "real_estate", address, billedCents: 614_300, paidInYearCents: 614_300, kind, kindBasis: "derived" };
}

describe("one property, one label (the address label artifact)", () => {
  it("1098 and the property tax bill of the primary residence get the SAME label; 56 Arbor Rd bills too", async () => {
    const f = await richFixture();
    const facts = structuredClone(f.pipeline.ctx.facts);
    facts.deductions.primaryResidenceAddress = { value: FORM_1098, basis: "derived", refs: [] };
    facts.deductions.mortgages = [{ docId: "m1", lender: "L", basis: "doc_verified", legacyFormat: false, refs: [], interestCents: 1, principalCents: 1, originationDate: null, mortgageInsuranceCents: null, pointsCents: null, box10Cents: null, propertyAddress: FORM_1098 }];
    facts.deductions.propertyTaxBills = [bill("d59a8102", TAX_BILL, "primary_residence"), bill("c68acecb", ARBOR_BILL, "other_real_estate"), bill("e1111111", ARBOR_SHORT, "other_real_estate")];
    const addresses = scrubAddressesFor(facts, FORM_1098);
    const labelOf = (a: string): string | undefined => addresses.find((x) => x.address === a)?.label;
    expect(labelOf(FORM_1098)).toBe("the primary residence");
    expect(labelOf(TAX_BILL)).toBe("the primary residence");
    expect(labelOf(ARBOR_BILL)).toBe("other property A");
    expect(labelOf(ARBOR_SHORT)).toBe("other property A");
    expect([...new Set(addresses.map((a) => a.label))]).toEqual(["the primary residence", "other property A"]);

    const payload = buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts, documents: [], bindings: [], l1Findings: [], entityLabels: ["the Consulting LLC"] }, PEOPLE);
    const out = serializePayload(payload, PEOPLE, { entities: [], addresses }).payload;
    const bills = out.deductions.propertyTaxBills;
    expect(bills.map((b) => [b["doc"], b["address"], b["documentRole"]])).toEqual([
      ["d59a8102", "the primary residence", "primary residence property tax bill"],
      ["c68acecb", "other property A", "property tax bill for other real estate (not the primary residence)"],
      ["e1111111", "other property A", "property tax bill for other real estate (not the primary residence)"],
    ]);
    expect(out.deductions.mortgages.map((m) => [m["address"], m["documentRole"]])).toEqual([["the primary residence", "mortgage interest statement (Form 1098) for the primary residence"]]);
    // privacy: no street name, house number, town or zip of either property in anything that leaves the app
    const json = JSON.stringify(out);
    expect(json.match(/.{0,40}\b(barry|arbor|waterford|quaker|0637\d|0638\d)\b.{0,40}/i)?.[0] ?? null).toBeNull();
    expect(findRedactionIssues(JSON.stringify(out))).toEqual([]);
  });

  it("free text that names a property in another spelling gets the same label (no generic label for a known property)", () => {
    const scrub = buildScrubber({ entities: [], addresses: [{ address: FORM_1098, label: "the primary residence" }, { address: TAX_BILL, label: "the primary residence" }, { address: ARBOR_BILL, label: "other property A" }] });
    expect(scrub("The primary residence is taken to be 27 Old Barry Road, Quaker Hill, CT 06375")).toBe("The primary residence is taken to be the primary residence");
    expect(scrub("tax on 56 Arbor Rd (a personal Schedule A item)")).toBe("tax on other property A (a personal Schedule A item)");
    expect(scrub("56 ARBOR ROAD, WATERFORD, CT 06385")).toBe("other property A");
    expect(scrub("27 OLD BARRY ROAD, WATERFORD, CT 06385 and 27 old barry rd quaker hill ct 06375")).toBe("the primary residence and the primary residence");
    // an unknown street is still generic
    expect(scrub("99 Maple Ave")).toBe("[property address]");
  });

  it("\"2025 CT\" (Connecticut) is not a street address: constant notes are not mangled (found in the live payload)", () => {
    const scrub = buildScrubber({ entities: [], addresses: [] });
    for (const t of ["if the 2025 CT income tax (CT-1040 line 14) is less than $1,000", "the 2025 CT-1040 instructions (line 29)", "Form CT-1040 for 2025 CT residents"]) expect(scrub(t)).toBe(t);
    // a real street that ends in Ct is still a street
    expect(scrub("14 Pine Ct")).toBe("[property address]");
    expect(scrub("14 PINE CT")).toBe("[property address]");
  });

  it("a bill the engine classified as the primary residence's is labelled so even when its address reads differently", async () => {
    const f = await richFixture();
    const facts = structuredClone(f.pipeline.ctx.facts);
    facts.deductions.primaryResidenceAddress = { value: FORM_1098, basis: "derived", refs: [] };
    facts.deductions.mortgages = [];
    facts.deductions.propertyTaxBills = [bill("b1", "27 Old Barry Rd Unit B", "primary_residence"), bill("b2", "1 Other St", "primary_residence"), bill("b3", ARBOR_SHORT, "other_real_estate")];
    const addresses = scrubAddressesFor(facts, FORM_1098);
    expect(addresses.find((a) => a.address === "1 Other St")?.label).toBe("the primary residence");
    expect(addresses.find((a) => a.address === ARBOR_SHORT)?.label).toBe("other property A");
  });

  it("the primary residence keeps its label whatever order the documents come in", async () => {
    const f = await richFixture();
    const facts = structuredClone(f.pipeline.ctx.facts);
    facts.deductions.primaryResidenceAddress = { value: null, basis: null, refs: [] } as unknown as typeof facts.deductions.primaryResidenceAddress;
    facts.deductions.mortgages = [];
    facts.deductions.propertyTaxBills = [bill("b3", ARBOR_SHORT, "other_real_estate"), bill("b1", TAX_BILL, "primary_residence")];
    const addresses = scrubAddressesFor(facts, null);
    expect(addresses.find((a) => a.address === TAX_BILL)?.label).toBe("the primary residence");
    expect(addresses.find((a) => a.address === ARBOR_SHORT)?.label).toBe("other property A");
  });

  it("role words", () => {
    expect(billRole("primary_residence")).toBe("primary residence property tax bill");
    expect(billRole("motor_vehicle")).toBe("motor vehicle property tax bill");
    expect(mortgageRole(FORM_1098, TAX_BILL)).toContain("for the primary residence");
    expect(mortgageRole(ARBOR_SHORT, TAX_BILL)).toContain("not the primary residence");
    expect(mortgageRole(null, TAX_BILL)).toContain("not identified");
  });
});

describe("entities of the tax year", () => {
  const rows = [
    { name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null, archivedAt: null },
    { name: "Sudden Valley Property Management, LLC", slug: "sudden-valley", type: "business", foundedDate: new Date("2026-02-01T00:00:00.000Z"), taxStatusNotes: null, archivedAt: null },
    { name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: "Single-member LLC, disregarded entity", archivedAt: null },
    { name: "Mezzo", slug: "mezzo", type: "business", foundedDate: null, taxStatusNotes: "Not yet formed/registered as of June 2026. Expense tracking only until formation date/state is recorded.", archivedAt: null },
  ];
  it("2025: only the Consulting LLC is listed; Sudden Valley (formed Feb 2026) and the unformed Mezzo are not", () => {
    const { labels, entities } = scrubEntitiesFor(rows, 2025);
    expect(labels).toEqual(["the Consulting LLC"]);
    expect(entities.map((e) => e.label)).toEqual(["[business name removed]", "the Consulting LLC", "[business name removed]"]);
  });
  it("their names are still scrubbed from document text, to a neutral placeholder that names nothing", () => {
    const scrub = buildScrubber({ entities: scrubEntitiesFor(rows, 2025).entities, addresses: [] });
    expect(scrub("Mezzo and Sudden Valley Property Management, LLC and EK Consulting")).toBe("[business name removed] and [business name removed] and the Consulting LLC");
  });
  it("2026: Sudden Valley is listed (formed), Mezzo still is not", () => {
    expect(scrubEntitiesFor(rows, 2026).labels).toEqual(["the Property Management LLC", "the Consulting LLC"]);
  });
  it("an archived business is not listed; a row without formation facts is taken as active", () => {
    expect(entityActiveInYear({ name: "X", slug: "x", archivedAt: new Date() }, 2025)).toBe(false);
    expect(entityActiveInYear({ name: "X", slug: "x" }, 2025)).toBe(true);
    expect(scrubEntitiesFor([{ name: "Acme", slug: "acme", type: "business", archivedAt: new Date() }], 2025).labels).toEqual([]);
  });
  it("isEntityUnformed follows the entity record (no formation date and notes say not yet formed)", () => {
    expect(isEntityUnformed({ type: "business", foundedDate: null, taxStatusNotes: rows[3]?.taxStatusNotes ?? null })).toBe(true);
    expect(isEntityUnformed({ type: "business", foundedDate: new Date("2026-02-01"), taxStatusNotes: "not yet formed" })).toBe(false);
    expect(isEntityUnformed({ type: "business", foundedDate: null, taxStatusNotes: null })).toBe(false);
    expect(isEntityUnformed({ type: "personal", foundedDate: null, taxStatusNotes: "not yet formed" })).toBe(false);
    expect(isEntityActiveForYear({ type: "business", foundedDate: new Date("2026-02-01"), taxStatusNotes: null }, 2025)).toBe(false);
  });
});

// A payload built from the rich fixture with real-shaped entities and addresses.
async function payloadFor(ownerRecords?: NonNullable<Parameters<typeof buildReviewPayload>[0]["ownerRecords"]>): Promise<{ payload: ReviewPayload; json: string }> {
  const f = await richFixture();
  const facts = structuredClone(f.pipeline.ctx.facts);
  facts.deductions.primaryResidenceAddress = { value: FORM_1098, basis: "derived", refs: [] };
  facts.deductions.propertyTaxBills = [bill("d59a8102", TAX_BILL, "primary_residence"), bill("c68acecb", ARBOR_BILL, "other_real_estate")];
  const bindings = bindFiles(f.pipeline.ctx, await readPacketFiles(f.pipeline.ctx.packet.files));
  const entities = scrubEntitiesFor(
    [
      { name: "Sudden Valley Property Management, LLC", slug: "sudden-valley", type: "business", foundedDate: new Date("2026-02-01T00:00:00.000Z"), taxStatusNotes: null, archivedAt: null },
      { name: "Eric Sample Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: null, archivedAt: null },
      { name: "Mezzo", slug: "mezzo", type: "business", foundedDate: null, taxStatusNotes: "Not yet formed/registered", archivedAt: null },
    ],
    2025
  );
  const payload = buildReviewPayload(
    {
      ret: f.pipeline.ret,
      view: f.pipeline.ctx.view,
      facts,
      documents: (f.pipeline.ctx.raw?.documents ?? []).map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, extractionStatus: d.extractionStatus, subjectType: d.subjectType, subjectUserId: d.subjectUserId })),
      bindings,
      l1Findings: f.l1Findings,
      entityLabels: entities.labels,
      ...(ownerRecords === undefined ? {} : { ownerRecords }),
    },
    PEOPLE
  );
  const s = serializePayload(payload, PEOPLE, { entities: entities.entities, addresses: scrubAddressesFor(facts, FORM_1098) });
  return { payload: s.payload, json: s.json };
}

describe("what the payload says about entities", () => {
  it("lists only the Consulting LLC, and never names Sudden Valley or Mezzo", async () => {
    const { payload, json } = await payloadFor();
    expect(payload.meta.entities).toEqual(["the Consulting LLC"]);
    expect(json).not.toMatch(/mezzo|sudden valley|third business|Property Management/i);
    expect(payload.ownerStatements.confirmed[0]).toBe("No business other than the Consulting LLC existed or had activity in 2025.");
  });
});

describe("packet manifest", () => {
  it("names every printed form (the flat CT-1040 included) and the forms the engine decided are not needed", async () => {
    const { payload } = await payloadFor();
    const m = payload.meta.packetManifest;
    expect(m).toMatch(/^PRINTED PACKET, all \d+ forms/);
    for (const name of ["Form 1040", "Schedule 1-A", "Schedule A", "Schedule C", "Schedule D", "Form 8949", "Form 8959", "Form 8960", "Form 8995", "CT-1040 (printed as a flat form with overlaid fields)"]) expect(m, name).toContain(name);
    expect(m).toContain("NOT missing from the packet");
  });
  it("is in the data of EVERY task (each task reads a different part of the packet)", async () => {
    const { payload } = await payloadFor();
    const ctx = { priorFindings: [], register: [] };
    for (const t of TASKS) {
      const slice = JSON.stringify(t.slice(payload, ctx));
      expect(slice, t.id).toContain("PRINTED PACKET");
      expect(slice, t.id).toContain("CT-1040");
      expect(slice, t.id).toContain("ownerStatements");
    }
  });
  it("c1, c2, c3 read their forms by the real file ids; d1 and d2 read the CT-1040 text", async () => {
    const { payload } = await payloadFor();
    const ctx = { priorFindings: [], register: [] };
    const formsOf = (id: string): string[] => {
      const t = TASKS.find((x) => x.id === id);
      const forms = (t?.slice(payload, ctx)["forms"] ?? []) as { formId: string }[];
      return [...new Set(forms.map((x) => x.formId))].sort();
    };
    const have = new Set(payload.forms.map((x) => x.formId));
    const only = (ids: string[]): string[] => ids.filter((x) => have.has(x)).sort();
    expect(formsOf("c1")).toEqual(only(["f1040", "f1040s1", "f1040s2", "f1040s3"]));
    expect(formsOf("c2")).toEqual(only(["f1040sa", "f1040sb", "f1040sc", "f1040sd", "f1040sse", "f8949"]));
    expect(formsOf("c3")).toEqual(only(["f1040s1a", "f8959", "f8960", "f8995"]));
    expect(formsOf("c1").length).toBeGreaterThan(1);
    expect(formsOf("c2")).toContain("f1040sa");
    expect(formsOf("d1")).toEqual(["ct1040"]);
    expect(formsOf("d2")).toEqual(["ct1040"]);
  });
  it("lists a required form that is in the packet under its file id as printed (Form 1040), and a form that is not as not printed", () => {
    const ret = { formsRequired: { f1040: { required: true, reason: "The return." }, schc: { required: true, reason: "x" }, schse: { required: false, reason: "Net earnings are under the $400 floor. More words that are cut." }, f6251: { required: true, reason: "x" } } } as unknown as Parameters<typeof packetManifestOf>[1];
    const b = (formId: string, engineFormId?: string): Parameters<typeof packetManifestOf>[0][number] => ({ file: { formId, name: `${formId}.pdf`, fields: new Map() }, map: engineFormId === undefined ? null : ({ formId, engineFormId } as never), view: null }) as never;
    const m = packetManifestOf([b("f1040"), b("f1040sc", "schc")], ret);
    expect(m).toContain("): Form 1040; Schedule C.");
    expect(m).toContain("all 2 forms");
    expect(m).toContain("not needed, so they are not in the packet: Schedule SE (Net earnings are under the $400 floor.)");
    expect(m).toContain("required or undecided and not printed: Form 6251 (required but not printed in this packet).");
    expect(m).not.toContain("Form 1040 (required");
  });
  it("with no printed packet read the line says so instead of listing every form as missing", () => {
    const ret = { formsRequired: { f1040: { required: true, reason: "The return." } } } as unknown as Parameters<typeof packetManifestOf>[1];
    expect(packetManifestOf([], ret)).toContain("could not be read");
  });
});

describe("owner statements", () => {
  it("carries the owner-confirmed TY2025 facts, labelled as not verified by documents", async () => {
    const { payload } = await payloadFor();
    const o = payload.ownerStatements;
    expect(o.version).toBe(3);
    expect(o.label).toMatch(/NOT verified by documents/);
    expect(o.label).toMatch(/do not ask the owner to confirm it again/);
    const text = o.confirmed.join("\n");
    for (const needle of [
      "No other information returns (Form 1099-NEC, 1099-MISC or 1099-K) were issued to the Consulting LLC for 2025 beyond the ones among the documents",
      "no residential clean energy credit (Form 5695) carryforward from 2024",
      "No Connecticut estimated tax payments were made for 2025, and no 2024 Connecticut balance was paid in 2025",
      "No margin interest or investment interest was paid in 2025",
      "software and apps expenses in the books are all for the Consulting LLC and cover tax year 2025",
      "Taxpayer M materially participates in the Consulting LLC",
      "The $7,000 traditional IRA contribution (Taxpayer M) was made in 2025",
      "that property was not offered for rent in 2025",
      // the estate facts (estate-owner-statements-2: the owner's correction of 2026-10-06)
      "Taxpayer F's mother died in August 2024. Taxpayer F was the sole beneficiary",
      "inherited the house (other property A) and the other assets from it, and is the executor. The estate is closed and all distributions were completed in 2025",
      "a Form 1041 was filed for the estate's 2024 tax year; the owner has not yet re-read what it reported",
      "The owner recalls the estate's bank interest as under $2 and saw no Form 1099-INT, 1099-DIV or 1099-B under the estate's number",
      "Taxpayer F received no Schedule K-1 (Form 1041) and no Form 1099 for 2025 from the estate, or from the estate of her mother's late husband",
      "The inheritance itself is not reported as income",
      "to renovate other property A",
      "The renovations, about $90,000, were all in 2025. They are capital improvements and are not deducted",
      "No energy-efficiency or solar improvements were made to other property A",
      "OPEN, not a confirmed fact: the bonds the estate cashed were US savings bonds, but the redemption record and any Form 1099-INT cannot be found",
      "the bank requires an in-person visit with valid probate papers, and the executor's letter has expired), so the interest is unknown",
      "That interest would be reported under the redeemer's number (the estate's), not Taxpayer F's. Do not assume an amount",
      "The deed made Taxpayer F a joint tenant with right of survivorship in other property A (the owner says it was not a gift). The deed is undated",
      "OPEN, not a confirmed fact: whether a gift tax return was needed is unresolved",
      "The basis of other property A is not needed for 2025: there was no sale of it and no depreciation on it in 2025",
    ]) expect(text, needle).toContain(needle);
    expect(text).toContain("doc:c68acecb");
  });
  it("the estate statements carry no name, street, town, zip or identifier, never say no Form 1041 was required, mention the deed transfer only in statement 7, and state the open items as OPEN", async () => {
    const estateList = OWNER_STATEMENTS_TY2025.slice(8);
    expect(estateList).toHaveLength(8);
    const DEED_WORDS = /\bgift|joint tenan|survivorship|\bdeed\b/i;
    // statement 7 (the deed) is the only statement that may use the deed-transfer words; every other statement, estate or not, must not
    const deedIdx = estateList.findIndex((t) => DEED_WORDS.test(t));
    expect(deedIdx).toBe(6);
    expect(estateList[deedIdx]).toMatch(/joint tenant with right of survivorship/);
    expect(estateList[deedIdx]).toMatch(/not a gift/);
    expect(estateList[deedIdx]).toMatch(/deed is undated/);
    const elsewhere = [...OWNER_STATEMENTS_TY2025.slice(0, 8), ...estateList.filter((_, i) => i !== deedIdx)].join("\n");
    expect(elsewhere).not.toMatch(DEED_WORDS);
    const estate = estateList.join("\n");
    expect(estate).not.toMatch(/barry|arbor|waterford|quaker|\bCT\b|0638\d|\bEIN\b|\bSSN\b|\bCPA\b|mezzo|sudden valley/i);
    // the first version said no Form 1041 was required: that was wrong and must never come back
    expect(OWNER_STATEMENTS_TY2025.join("\n")).not.toMatch(/no Form 1041 (?:filing )?was required|far less than \$600/i);
    expect(estate).toMatch(/a Form 1041 was filed for the estate's 2024 tax year/);
    expect(estate).not.toMatch(/\b\d{2}-\d{7}\b|\b\d{3}-\d{2}-\d{4}\b/);
    expect(findRedactionIssues(estate)).toEqual([]);
    expect(estate).toMatch(/OPEN, not a confirmed fact: the bonds the estate cashed were US savings bonds/);
    expect(estate).toMatch(/OPEN, not a confirmed fact: whether a gift tax return was needed is unresolved/);
    // the whole payload (with the real scrubbers) still carries them and still leaks nothing
    const { json } = await payloadFor();
    expect(json).toContain("sole beneficiary");
    // in the whole payload the deed-transfer words appear only in statement 7
    expect(json.match(/joint tenan/gi)).toHaveLength(1);
    // (the charity wording of the return, "gifts to charity", is not a deed transfer: only the two gift phrases of statement 7 are counted)
    expect(json.match(/not a gift\b|\bgift tax return/gi)).toHaveLength(2);
    expect(json.match(/\bdeed\b/gi)).toHaveLength(2);
    expect(json).not.toMatch(/\bbarry\b|\barbor\b|waterford|quaker|\bEric Sample\b|mezzo|sudden valley/i);
  });
  it("the allow-list is explicit and ties a statement to a document only when the document exists", () => {
    expect(OWNER_STATEMENTS_TY2025).toHaveLength(16);
    const none = buildOwnerStatements({ tdInterestAliases: [], otherPropertyBillAliases: [], documentAliases: new Set(), statedNone: [], recordedDecisions: [], acceptedFindings: [] });
    expect(none.confirmed).toEqual([...OWNER_STATEMENTS_TY2025]);
    const some = buildOwnerStatements({ tdInterestAliases: ["0cc0dce2"], otherPropertyBillAliases: [], documentAliases: new Set(["c20de682"]), statedNone: ["solar_credit"], recordedDecisions: [], acceptedFindings: [] });
    expect(some.confirmed).toContain("On the bank Form 1099-INT doc:0cc0dce2, box 4 (federal income tax withheld) is zero.");
    expect(some.confirmed).toContain("doc:c20de682 is a 2026 document: disregard it for the 2025 return.");
    expect(some.statedNone).toEqual(["solar_credit"]);
  });
  it("carries recorded decisions with their reasons and accepted findings with theirs; drops a reason that looks like an identifier", () => {
    const o = buildOwnerStatements({
      tdInterestAliases: [],
      otherPropertyBillAliases: [],
      documentAliases: new Set(),
      statedNone: [],
      recordedDecisions: [
        { kind: "decision", target: "homeOfficeMethod", value: "simplified", reason: "Simplified method: the barn office is small." },
        { kind: "line", target: "f1040.9", value: "1234", reason: "SSN 123-45-6789 on the notice" },
      ],
      acceptedFindings: [
        { key: "L3.x.1", about: "Check the figure", reason: "Confirmed with the bank." },
        { key: "L3.x.2", about: null, reason: "   " },
      ],
    });
    // the decision is sent under the engine's decision id, never under its registry key
    expect(o.recordedDecisions).toEqual([{ kind: "decision", target: "X1", value: "simplified", reason: "Simplified method: the barn office is small." }]);
    expect(o.acceptedFindings).toEqual([{ key: "L3.x.1", about: "Check the figure", reason: "Confirmed with the bank." }]);
  });
  it("leaves out an accepted finding or a reason that brings back a business that did not exist in 2025 (old generic labels, placeholders, names)", () => {
    const o = buildOwnerStatements({
      tdInterestAliases: [],
      otherPropertyBillAliases: [],
      documentAliases: new Set(),
      statedNone: [],
      recordedDecisions: [{ kind: "decision", target: "x", value: "y", reason: "The other entity, Mezzo, is not formed" }],
      acceptedFindings: [
        { key: "k1", about: "The household lists three entities: the Property Management LLC, the Consulting LLC and the third business entity.", reason: "The other two entities did not conduct business in 2025." },
        { key: "k2", about: "Check [business name removed]", reason: "ok" },
        { key: "k3", about: "Fine finding", reason: "Sudden Valley was formed in 2026" },
        { key: "k4", about: "Fine finding", reason: "Confirmed." },
      ],
    });
    expect(o.recordedDecisions).toEqual([]);
    expect(o.acceptedFindings.map((f) => f.key)).toEqual(["k4"]);
  });
  it("recordedDecisionsOf keeps active override rows only; acceptedFindingsOf keeps the latest disposition per finding, accepted only", () => {
    const row = (over: Partial<OverrideRow>): OverrideRow => ({ id: "i", taxYear: 2025, targetKind: "decision", targetKey: "k", version: 1, valueKind: "choice", valueCents: null, valueText: "simplified", computedSnapshot: {}, authority: "owner", reason: "because", setByName: "x", setAt: new Date(0), archivedAt: null, ...over });
    const rows = recordedDecisionsOf([row({}), row({ archivedAt: new Date(1) }), row({ targetKind: "line", targetKey: "f1040.9", valueKind: "money_cents", valueCents: 123_456, valueText: null })]);
    expect(rows).toEqual([
      { kind: "decision", target: "k", value: "simplified", reason: "because" },
      { kind: "line", target: "f1040.9", value: "1235", reason: "because" },
    ]);
    const acc = acceptedFindingsOf(
      [
        { findingKey: "a", evidenceHash: "h", action: "accepted", reason: "r1", at: "2026-10-01T00:00:00Z" },
        { findingKey: "b", evidenceHash: "h", action: "accepted", reason: "r2", at: "2026-10-01T00:00:00Z" },
        { findingKey: "b", evidenceHash: "h", action: "reopened", reason: "", at: "2026-10-02T00:00:00Z" },
      ],
      new Map([["a", "what a said"]])
    );
    expect(acc).toEqual([{ key: "a", about: "what a said", reason: "r1" }]);
  });
  it("is advisory only: the engine and the rules never read it", () => {
    for (const f of ["lib/tax2025/return.ts", "lib/tax2025/resolve-facts.ts", "lib/tax2025/constants.ts", "lib/tax-review/gate.ts", "lib/tax-review/l1/run-l1.ts"]) expect(readFileSync(path.join(process.cwd(), f), "utf8"), f).not.toMatch(/llm\/owner-statements/);
  });
});

describe("the prompt rules", () => {
  it("tell the model not to re-ask for confirmed items, to read the manifest and the entities, and bumped the version", () => {
    expect(REVIEW_RULES).toContain("do not ask him to confirm them again");
    expect(REVIEW_RULES).toContain("You may still add a finding");
    expect(REVIEW_RULES).toContain("meta.packetManifest");
    expect(REVIEW_RULES).toContain("meta.entities");
    expect(REVIEW_RULES).toContain("documentRole");
    expect(REVIEW_RULES).not.toMatch(/Mezzo|Sudden Valley/i);
    expect(PROMPT_VERSION).toBe("l3-prompts-3");
  });
  it("are sent with every task, after its instruction and before the data; the system prompt and the instructions are untouched", () => {
    for (const t of TASKS) {
      const u = userPrompt(t, "{}", "");
      expect(u, t.id).toContain(REVIEW_RULES);
      expect(u.indexOf(REVIEW_RULES), t.id).toBeGreaterThan(u.indexOf(t.instruction));
      expect(u.indexOf(REVIEW_RULES), t.id).toBeLessThan(u.indexOf("<data>"));
      expect(taskContentHash(t), t.id).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(SYSTEM_PROMPT).not.toContain("ownerStatements");
  });
});

// ── review round: a decision's registry key names a property ("arborRoadPropertyTax"); keys were never checked ──────────────────────
// The search is case-insensitive over KEYS and values, camelCase-aware, and has NO word boundary for the long names (a \b never matches
// inside "arborRoadPropertyTax"). The short names (eric, eva) are read per word of the camelCase / snake_case split, otherwise "generic" and
// "evaluate" would hit. SAFE_HARBOR_* constant ids contain "arbor" and are the one known safe false hit.
function leakingNames(value: unknown): string[] {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        parts.push(k);
        walk(x);
      }
    }
  };
  walk(value);
  const raw = parts.join("\n").replace(/safe[_\s-]*harbor/gi, " ").replace(/harbor/gi, " ").toLowerCase();
  const split = parts.join("\n").replace(/safe[_\s-]*harbor/gi, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.:/-]+/g, " ").toLowerCase();
  const found: string[] = [];
  for (const n of ["barry", "arbor", "waterford", "quaker", "kinniburgh", "mezzo", "sudden valley", "suddenvalley", "ramirez", "wisiackas"]) {
    if (raw.includes(n) || split.includes(n)) found.push(n);
  }
  for (const n of ["eric", "eva", "laura"]) if (new RegExp(`\\b${n}\\b`).test(split)) found.push(n);
  return found;
}

describe("recorded decisions are sent under the engine decision id, never under the registry key", () => {
  it("every registry key maps to its decision id; unknown keys and odd shapes become neutral words", () => {
    for (const [key, meta] of Object.entries(DECISION_REGISTRY)) expect(neutralTarget("decision", key), key).toBe(meta.decisionId);
    expect(neutralTarget("decision", "arborRoadPropertyTax")).toBe("X5");
    expect(neutralTarget("decision", "someFutureKey")).toBe("decision");
    expect(neutralTarget("decision", "constructor")).toBe("decision");
    expect(neutralTarget("line", "f1040.9a_Arbor")).toBe("line");
    expect(neutralTarget("line", "Arbor Road line")).toBe("line");
    expect(neutralTarget("rule_ack", "arborRoadRule")).toBe("rule");
    expect(neutralTarget("anything", "arbor")).toBe("record");
  });
  it("every line key of the engine catalog survives unchanged (nothing useful is lost)", () => {
    for (const m of LINE_CATALOG) expect(neutralTarget("line", m.key), m.key).toBe(m.key);
  });
  it("the real shape of the live leak: a decision on 56 Arbor Rd is X5 in the whole payload, keys and values", async () => {
    const records = DECISION_KEYS.map((k) => ({ kind: "decision", target: k, value: "schedule_a", reason: "Chosen on the notice." }));
    const { payload, json } = await payloadFor({ recordedDecisions: [...records, { kind: "line", target: "f1040.9", value: "100", reason: "Per the notice." }, { kind: "rule_ack", target: "arborRoadRule", value: null, reason: "Reviewed." }], acceptedFindings: [] });
    expect(payload.ownerStatements.recordedDecisions.map((d) => d.target)).toEqual(["X1", "X2", "X3", "X5", "f1040.9", "rule"]);
    expect(json).toContain("\"target\":\"X5\"");
    expect(leakingNames(JSON.parse(json))).toEqual([]);
  });
  it("the leak check itself catches a camelCase key (it would have caught the live defect)", () => {
    expect(leakingNames({ target: "arborRoadPropertyTax" })).toEqual(["arbor"]);
    expect(leakingNames({ arborRoad: 1 })).toEqual(["arbor"]);
    expect(leakingNames({ note: "Eric Smith, Sudden Valley" }).sort()).toEqual(["eric", "sudden valley"]);
    expect(leakingNames({ id: "SAFE_HARBOR_100K", note: "a generic numeric evaluation" })).toEqual([]);
  });
});

describe("tester gaps G1-G3 (address scrubber)", () => {
  it("G1: zero-width characters inside a written address do not hide it, and do not make two spellings two properties", () => {
    const scrub = buildScrubber({ entities: [], addresses: [{ address: FORM_1098, label: "the primary residence" }] });
    for (const zw of ["​", "‌", "‍", "‎", "‏", "⁠", "﻿", "­"]) {
      expect(scrub(`27${zw} Old${zw} Barry${zw} Rd`), `U+${zw.charCodeAt(0).toString(16)}`).toBe("the primary residence");
      expect(scrub(`2${zw}7 Old${zw}Barry R${zw}oad, Waterford, CT 06385`), `U+${zw.charCodeAt(0).toString(16)}`).toBe("the primary residence");
      expect(sameProperty("27 Old Barry Rd", `27 Old${zw}Barry Rd`)).toBe(true);
      expect(sameProperty("27 Old Barry Rd", `27 Old Barry R${zw}oad`)).toBe(true);
    }
  });
  it("G2: a street name that contains a suffix word keeps it; a different final suffix is a different property", () => {
    expect(canonicalAddress("30 Pine Point Rd")).toEqual({ number: "30", name: "pine point", suffix: "rd" });
    expect(sameProperty("30 Pine Point Rd", "30 Pine Point Ln")).toBe(false);
    expect(sameProperty("100 Park Place Dr", "100 Park Place Ln")).toBe(false);
    expect(sameProperty("30 Pine Point Rd", "30 PINE POINT ROAD, Waterford, CT 06385")).toBe(true);
    expect(sameProperty("30 Pine Point Rd Quaker Hill CT 06375", "30 pine point road")).toBe(true);
    // the state "CT" is still not the suffix when an earlier suffix word exists, and a street that ends in Ct still is
    expect(canonicalAddress(FORM_1098)).toEqual({ number: "27", name: "old barry", suffix: "rd" });
    expect(canonicalAddress("14 Pine Ct")).toEqual({ number: "14", name: "pine", suffix: "ct" });
    expect(sameProperty("14 Pine Ct", "14 Pine Court, Town, CT 06375")).toBe(true);
    expect(sameProperty("14 Pine Ct", "14 Pine St")).toBe(false);
    // the pattern for a name that contains a suffix word finds the street and not the other one
    const scrub = buildScrubber({ entities: [], addresses: [{ address: "30 Pine Point Rd", label: "the primary residence" }] });
    expect(scrub("on 30 Pine Point Road")).toBe("on the primary residence");
    expect(scrub("on 30 Pine Point Ln")).toBe("on [property address]");
  });
  it("G3: a town and state with no zip after a replaced known street are removed; ordinary words after a label are not", () => {
    const scrub = buildScrubber({ entities: [], addresses: [{ address: FORM_1098, label: "the primary residence" }] });
    expect(scrub("see 27 Old Barry Rd, Waterford, CT for details")).toBe("see the primary residence for details");
    expect(scrub("27 OLD BARRY ROAD, Quaker Hill, CT.")).toBe("the primary residence");
    expect(scrub("27 Old Barry Rd, East Lyme CT 06333 and more")).toBe("the primary residence and more");
    expect(scrub("27 Old Barry Rd is the primary residence for me, Eric ME")).toBe("the primary residence is the primary residence for me, Eric ME");
    expect(scrub("27 Old Barry Rd, the home, was sold in ct")).toBe("the primary residence, the home, was sold in ct");
  });
});
