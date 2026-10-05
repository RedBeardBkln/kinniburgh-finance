import { describe, expect, it, vi } from "vitest";
import { SEND_NOTICE } from "@/lib/tax-review/ai-panel";
import { buildReviewPayload, serializePayload, type PayerNameMode } from "@/lib/tax-review/llm/payload";
import { PEOPLE, richFixture, SCRUB } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The "what is sent" notice (the text the owner ticks "I understand what is sent" against) is compared with the REAL payload builder's output.
// Integration tester D1: the notice said business names are removed while employer / payer / bank / lender / brokerage names were sent verbatim.
// This file fails if the payload carries a payer name and the notice denies it, or if the notice claims something is removed that the payload still holds.

const PAYER_NAMES = {
  employer: "ZEBRA PAYROLL PARTNERS, INC.",
  bank: "QUOKKA SAVINGS BANK, N.A.",
  brokerage: "NARWHAL SECURITIES LLC",
  lender: "OCELOT LOAN SERVICING, LLC",
};
const HOUSEHOLD_PLANTS = ["Eric Sample", "Eva Sample", "Sample Consulting, LLC", "27 Old Barry Rd", "98-7654321", "4111222233334444"];

async function sentWith(mode: PayerNameMode | undefined): Promise<string> {
  const f = await richFixture();
  const facts = structuredClone(f.pipeline.ctx.facts);
  const w2 = facts.income.w2s[0];
  const interest = facts.income.interest[0];
  const dividend = facts.income.dividends[0];
  const broker = facts.income.brokerSales[0];
  if (w2 === undefined || interest === undefined || dividend === undefined || broker === undefined) throw new Error("the rich fixture is missing an income row");
  w2.employer = PAYER_NAMES.employer;
  interest.payer = PAYER_NAMES.bank;
  dividend.payer = PAYER_NAMES.brokerage;
  broker.payer = PAYER_NAMES.brokerage;
  const other = facts.income.otherIncomeBoxes[0];
  if (other !== undefined) other.payer = PAYER_NAMES.lender;
  // things the notice says are removed: the household, the entity, the street, an EIN and an account number sitting inside payer text
  const out = serializePayload(
    buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts, documents: [], bindings: [], l1Findings: [], entityLabels: SCRUB.entities.map((e) => e.label), ...(mode !== undefined ? { payerNames: mode } : {}) }, PEOPLE),
    PEOPLE,
    SCRUB
  );
  return out.json;
}

/** What a reader of `notice` would be misled about, given the payload that was really built. Empty = the notice is accurate. */
export function noticeContradictions(notice: string, payloadJson: string, mode: PayerNameMode): string[] {
  const problems: string[] = [];
  const n = notice.replace(/\s+/g, " ");
  const sentPayerNames = Object.values(PAYER_NAMES).filter((name) => payloadJson.includes(name));
  if (sentPayerNames.length > 0) {
    // names ARE sent: the notice must say so (payers, employers, banks, lenders, brokerages) ...
    for (const word of ["employers", "banks", "lenders", "brokerages"]) if (!new RegExp(word, "i").test(n)) problems.push(`the notice does not mention ${word} although payer names are sent`);
    if (!/\bARE sent\b/.test(n)) problems.push("the notice does not say that payer names ARE sent");
    // ... and must not deny it, in any phrasing ("business names are removed", "employer names removed", "no names are sent" ...)
    const denial = /(business|employer|payer|bank|lender|brokerage)s?['’]? names[^.]*\b(are |is )?(removed|redacted|replaced|never sent|not sent|stripped)/i;
    if (denial.test(n)) problems.push("the notice says business / payer names are removed");
    if (/no names|names are not sent|without (any )?names/i.test(n)) problems.push("the notice says no names are sent");
    // the switch must be named so the owner knows how to change it
    if (!/TAX_REVIEW_PAYER_NAMES=generic/.test(n)) problems.push("the notice does not name the generic setting");
  }
  if (mode === "keep" && sentPayerNames.length === 0) problems.push("test setup: no payer name reached the payload in keep mode");
  // what the notice lists as removed must really be absent
  const claimsRemoved = (word: RegExp): boolean => word.test(n);
  for (const plant of HOUSEHOLD_PLANTS.slice(0, 2)) if (claimsRemoved(/household names/i) && payloadJson.includes(plant)) problems.push(`the notice says household names are removed but "${plant}" is in the payload`);
  if (claimsRemoved(/street addresses/i) && payloadJson.includes("Old Barry")) problems.push("the notice says street addresses are removed but one is in the payload");
  if (claimsRemoved(/business entities/i) && payloadJson.includes("Sample Consulting")) problems.push("the notice says your own business entity names are removed but one is in the payload");
  return problems;
}

describe("the 'what is sent' notice matches the real payload", () => {
  it("default mode (payer names kept): payer / employer / bank / brokerage names are in the payload and the notice says so", async () => {
    const json = await sentWith(undefined);
    for (const name of [PAYER_NAMES.employer, PAYER_NAMES.bank, PAYER_NAMES.brokerage]) expect(json, name).toContain(name);
    expect(noticeContradictions(SEND_NOTICE, json, "keep")).toEqual([]);
    expect(SEND_NOTICE).toMatch(/ARE sent/);
    expect(SEND_NOTICE).toMatch(/TAX_REVIEW_PAYER_NAMES=generic/);
    for (const w of ["employers", "payroll", "banks", "lenders", "brokerages"]) expect(SEND_NOTICE).toContain(w);
  });
  it("everything the notice lists as removed is really absent from the payload; EINs are cut to their last four digits", async () => {
    const f = await richFixture();
    const facts = structuredClone(f.pipeline.ctx.facts);
    const w2 = facts.income.w2s[0];
    if (w2 === undefined) throw new Error("no W-2");
    w2.employer = "ZEBRA PAYROLL PARTNERS, INC. 98-7654321";
    const json = serializePayload(buildReviewPayload({ ret: f.pipeline.ret, view: f.pipeline.ctx.view, facts, documents: [], bindings: [], l1Findings: [], entityLabels: SCRUB.entities.map((e) => e.label) }, PEOPLE), PEOPLE, SCRUB).json;
    expect(json).not.toMatch(/Eric|Eva|Sample/);
    expect(json).not.toContain("Old Barry");
    expect(json).not.toContain("98-7654321");
    expect(json).not.toContain("987654321");
    expect(json).toContain("**-***4321");
    expect(json).toContain("Taxpayer M");
    expect(json).toContain("Taxpayer F");
    expect(SEND_NOTICE).toMatch(/Taxpayer M/);
    expect(SEND_NOTICE).toMatch(/Taxpayer F/);
    expect(SEND_NOTICE).toMatch(/Household names, street addresses, the names of your own business entities, Social Security numbers and account numbers are removed/);
    expect(SEND_NOTICE).toMatch(/employer identification numbers are cut to their last four digits/);
    expect(SEND_NOTICE).toMatch(/Nothing is sent until you start/);
  });
  it("'generic' mode: no payer name is sent (the setting the notice names really does what it says)", async () => {
    const json = await sentWith("generic");
    for (const name of Object.values(PAYER_NAMES)) expect(json, name).not.toContain(name);
    expect(json).toMatch(/Employer A/);
    expect(json).toMatch(/Payer [A-Z]/);
  });
  it("the checker has teeth: the earlier notice (which denied that business names are sent) is flagged against the same payload", async () => {
    const json = await sentWith(undefined);
    const OLD =
      "This sends a redacted summary of the return to Anthropic's API and uses your API credit. The household appears only as \"Taxpayer M\" and \"Taxpayer F\"; names, street addresses, business names, employer ids and account numbers are removed before anything leaves the app. Nothing is sent until you start.";
    const problems = noticeContradictions(OLD, json, "keep");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(/does not say that payer names ARE sent/);
    // a notice that merely appends "payer names are removed" is flagged too
    expect(noticeContradictions(`${SEND_NOTICE} Employer names are removed.`, json, "keep").join(" | ")).toMatch(/removed/);
    // a notice that lists street addresses as removed while one is sent is flagged
    expect(noticeContradictions(SEND_NOTICE, `${json} 27 Old Barry Rd`, "keep").join(" | ")).toMatch(/street addresses are removed but one is in the payload/);
  });
});
