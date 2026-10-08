import { describe, expect, it } from "vitest";
import { NEVER_VISIBLE_CLASSES, FORBIDDEN_FIELDS } from "@/lib/advisor/exclusions";
import { ASSISTANT_NOTICE, noticeText } from "@/lib/advisor/notice";
import { ADVISOR_TOOLS } from "@/lib/advisor/tools/all-tools";

// The "what the assistant can see" notice is pinned against the real data boundary and tool set, the same way the AI reviewer's send notice is
// (advisor-ai-chatbot plan section 12).

const text = noticeText();

describe("the notice states the boundary", () => {
  it("says read-only, and that it cannot start the AI review or change anything", () => {
    expect(text).toMatch(/Read only/);
    expect(text).toMatch(/cannot change a transaction/);
    expect(text).toMatch(/cannot start the AI review/);
  });

  it.each([
    ["Vault", /Vault/],
    ["bank logins and tokens", /bank logins or bank connection tokens/],
    ["passwords", /passwords/],
    ["SSNs", /Social Security numbers/],
    ["EINs", /EINs/],
    ["full account and routing numbers", /full account or routing numbers/],
    ["dates of birth", /dates of birth/],
    ["street addresses", /street addresses/],
    ["original document files", /original document files/],
  ])("lists what it never sees: %s", (_n, re) => {
    expect(text).toMatch(re);
  });

  it("every never-visible class in the exclusions has a counterpart in the notice", () => {
    expect(NEVER_VISIBLE_CLASSES.length).toBeGreaterThanOrEqual(9);
    const words: Record<string, RegExp> = {
      "Vault contents": /Vault/,
      "bank logins and bank connection tokens": /bank logins/,
      "passwords and sign-in secrets": /passwords/,
      "Social Security numbers": /Social Security/,
      EINs: /EINs/,
      "full account and routing numbers": /routing numbers/,
      "dates of birth": /dates of birth/,
      "street addresses": /street addresses/,
      "original document files": /document files/,
    };
    for (const c of NEVER_VISIBLE_CLASSES) expect(text, c).toMatch(words[c] ?? new RegExp(c, "i"));
  });

  it("says what is stored, that memory means this app's own database, and that Anthropic receives the questions and lookups", () => {
    expect(text).toMatch(/visible only to you/);
    expect(text).toMatch(/never the looked-up rows/);
    expect(text).toMatch(/memory means this app's own database, not any developer tool/);
    expect(text).toMatch(/sent to Anthropic/);
    expect(text).toMatch(/Counts of questions and tokens/);
  });

  it("states the assistant is software, not a professional, and that tax figures are a draft", () => {
    expect(text).toMatch(/software, not a CPA, EA, attorney or financial planner/);
    expect(text).toMatch(/draft until you approve/);
  });

  it("mentions the kinds of data of every tool group (money and TY2025 tax)", () => {
    expect(text).toMatch(/transactions/);
    expect(text).toMatch(/budgets/);
    expect(text).toMatch(/TY2025 return/);
    expect(text).toMatch(/tax facts/);
    expect(text).toMatch(/AI review and approval status/);
  });

  it("names no forbidden column or tool internals (it is plain language)", () => {
    for (const f of FORBIDDEN_FIELDS) expect(text.includes(f), f).toBe(false);
    for (const t of ADVISOR_TOOLS) expect(text.includes(t.name), t.name).toBe(false);
  });

  it("has a heading per section and no empty item", () => {
    expect(ASSISTANT_NOTICE.map((s) => s.heading)).toEqual(["It can read", "It never sees", "What it can do", "What is stored"]);
    for (const s of ASSISTANT_NOTICE) for (const i of s.items) expect(i.length).toBeGreaterThan(20);
  });
});
