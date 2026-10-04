// The owner-wording layer (lib/tax-wording.ts): the engine still generates sentences that say "the CPA decides";
// this layer rewords them at the render boundary. Pinned here: the rewrites read well, identifiers are never
// touched, honesty statements survive, and EVERY CPA sentence in the engine sources comes out clean.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findCpaWording,
  findFinalPackageBannedWording,
  findOwnerBannedWording,
  ownerWording,
  ownerWordingDeep,
} from "@/lib/tax-wording";

const ROOT = resolve(__dirname, "../..");

describe("ownerWording rewrites", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["the owner is not sure about X; the CPA decides.", "the owner is not sure about X; you decide."],
    ["The CPA decides the Form 8949 adjustments (column (g) and codes).", "You decide the Form 8949 adjustments (column (g) and codes)."],
    ["so the CPA works it.", "so you work it out."],
    ["the CPA works these additions (the form also needs a description).", "you work out these additions (the form also needs a description)."],
    ["Form 8889 line 6 steps 1-4 are the CPA's.", "Form 8889 line 6 steps 1-4 are yours to work out."],
    ["Schedule C line 9 is a CPA call until one is corrected.", "Schedule C line 9 is for you to decide until one is corrected."],
    ["Stated by the CPA.", "Stated by the owner."],
    ["Needs an owner/CPA statement: X", "Needs an owner statement: X"],
    ["a choice for the owner / CPA.", "a choice for the owner."],
    ["Archive the duplicate, or tell the CPA if both are real forms.", "Archive the duplicate, or check whether both are real forms."],
    ["Tell the CPA so the CT subtraction is taken.", "Make sure the CT subtraction is taken."],
    ["Review the state lines on the document and tell the CPA.", "Review the state lines on the document and note it for your records."],
    ["Give the details to the CPA; this engine does not prepare it.", "Prepare this yourself or ask a tax professional; this engine does not prepare it."],
    ["so this row needs the CPA.", "so this row needs your decision."],
    ["the total is left for the CPA.", "the total is left for you."],
    ["flagged for the CPA.", "flagged for you."],
    ["CPA to confirm. If the same bank", "Confirm yourself. If the same bank"],
    ["The CPA chose the actual-expense method (Form 8829)", "You chose the actual-expense method (Form 8829)"],
    ["The CPA must classify and report it", "You must classify and report it"],
    ["Not sure - ask the CPA", "Not sure - I need to look into this"],
    ["Needs CPA input", "Needs your input"],
    ["needs CPA judgment", "needs your decision"],
    ["undecided CPA decisions", "undecided owner decisions"],
    ["Open items for CPA (3 blocking, 2 advisory)", "Open items (3 blocking, 2 advisory)"],
    ["Acknowledged by the CPA (not blocking)", "Acknowledged by the owner (not blocking)"],
    ["Resolved by CPA override (no longer blocking)", "Resolved by owner override (no longer blocking)"],
    ["2 CPA / owner override(s) are in force", "2 owner override(s) are in force"],
    ["Drafts for your CPA to review - not tax advice.", "Drafts for you to review - not tax advice."],
    ["Prepare Schedule C draft for CPA", "Prepare Schedule C draft for your review"],
    ["ask your CPA", "ask a tax professional"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input.slice(0, 60)}"`, () => {
      expect(ownerWording(input)).toBe(expected);
    });
  }

  it("capitalises only at the start of a sentence", () => {
    expect(ownerWording("See the CPA summary for details.")).toBe("See the questions and answers summary for details.");
    expect(ownerWording("CPA summary - 2025")).toBe("Questions and answers summary - 2025");
  });

  it("is idempotent and leaves text without the word CPA untouched", () => {
    const s = "The owner decides. Needs your input. needs_cpa_judgment";
    expect(ownerWording(s)).toBe(s);
    const once = ownerWording("so the CPA decides; tell the CPA so the CT subtraction is taken.");
    expect(ownerWording(once)).toBe(once);
  });

  it("never leaves the word CPA behind, even for phrasing no rule knows", () => {
    for (const s of ["Zorp the CPA frobnicates", "ask a CPA", "CPA", "Your CPA's opinion", "the CPA"]) {
      expect(findCpaWording(ownerWording(s)), s).toEqual([]);
    }
  });
});

describe("identifiers and persisted values are not rewritten", () => {
  it("lower-case identifier values and keys pass through ownerWordingDeep unchanged", () => {
    const model = {
      status: "needs_cpa_judgment",
      who: "cpa",
      basis: "answer_cpa",
      href: "/tax/forms/2025/cpa-summary",
      cpaNote: "The CPA decides.",
      nested: [{ authority: "cpa", text: "Needs CPA input" }],
      n: 3,
      flag: true,
      nothing: null,
    };
    expect(ownerWordingDeep(model)).toEqual({
      status: "needs_cpa_judgment",
      who: "cpa",
      basis: "answer_cpa",
      href: "/tax/forms/2025/cpa-summary",
      cpaNote: "You decide.",
      nested: [{ authority: "cpa", text: "Needs your input" }],
      n: 3,
      flag: true,
      nothing: null,
    });
  });

  it("keeps what the OWNER typed with an override: the reason tail of a note and an override record's reason / by", () => {
    const note = "Advisor override: was $1 computed, now $2, by Eric (per advisor, recorded earlier) on 2026-10-05, reason: the CPA said so";
    expect(ownerWording(note)).toBe(note);
    expect(ownerWording("The CPA decides; Owner override: now $2, reason: the CPA said so")).toBe("You decide; Owner override: now $2, reason: the CPA said so");
    const record = { id: "x", version: 1, authority: "cpa", reason: "the CPA said so", by: "the CPA", label: "set by the CPA" };
    expect(ownerWordingDeep(record)).toEqual({ ...record, label: "set by a tax professional" });
  });

  it("does not mutate its input and keeps non-plain objects (Date) as they are", () => {
    const d = new Date("2026-10-04T00:00:00Z");
    const input = { text: "the CPA decides", when: d };
    const out = ownerWordingDeep(input);
    expect(input.text).toBe("the CPA decides");
    expect(out.when).toBe(d);
  });
});

describe("honesty statements keep the word", () => {
  it("'not a CPA' and the backstop line are allowed and are not rewritten", () => {
    const honest = "The AI Return Reviewer is not a CPA, EA or other licensed professional. A one-time review by an enrolled agent, CPA or tax attorney can help.";
    expect(ownerWording(honest)).toBe(honest);
    expect(findOwnerBannedWording(honest)).toEqual([]);
  });

  it("any other use is reported", () => {
    expect(findOwnerBannedWording("Reviewed by your CPA")).toContain("CPA");
    expect(findOwnerBannedWording("A certified public accountant reviewed it")).toContain("certified public accountant");
    expect(findOwnerBannedWording("professionally reviewed")).toContain("professionally reviewed");
    expect(findOwnerBannedWording("a licensed preparer")).toContain("licensed (claim)");
  });

  it("identifier-shaped uses are not reported", () => {
    for (const s of ["needs_cpa_judgment", "confirmWithCpa", "cpaNote", "/tax/forms/2025/cpa-summary", "answer_cpa", "needsCpaInput"]) {
      expect(findOwnerBannedWording(s), s).toEqual([]);
    }
  });
});

describe("final package banned wording", () => {
  it("flags every banned token", () => {
    const bad: ReadonlyArray<readonly [string, string]> = [
      ["Prepared by Claude", "Claude"],
      ["Checked by the AI reviewer", "AI"],
      ["generated by artificial intelligence", "artificial"],
      ["DRAFT computed by Banana Stand", "Banana Stand"],
      ["made by this app", "this app"],
      ["DRAFT - not approved", "draft"],
      ["provisional figures", "provisional"],
      ["an estimate", "estimate"],
      ["computed by the engine", "computed by"],
      ["reviewed by someone", "reviewed by"],
      ["under review", "review"],
      ["an override is in force", "override"],
      ["for the CPA", "CPA"],
      ["Prepared by Jane Doe, CPA", "preparer other than owner"],
    ];
    for (const [text, name] of bad) expect(findFinalPackageBannedWording(text), text).toContain(name);
  });

  it("accepts the self-prepared line and ordinary package text", () => {
    for (const s of [
      "Prepared by Eric Kinniburgh (self-prepared)",
      "Approved by owner on 2026-10-08 18:30 EDT",
      "Tax year 2025 - Form 1040 and CT-1040 - married filing jointly",
      "Enter by hand before filing",
      "The paid preparer, firm and PTIN boxes stay blank on a return you prepared yourself.",
    ]) {
      expect(findFinalPackageBannedWording(s), s).toEqual([]);
    }
  });
});

// ── Every CPA sentence in the engine comes out clean ──────────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g;

describe("every owner-visible CPA sentence in the source comes out clean", () => {
  const roots = ["lib/tax2025", "lib", "actions", "components/tax", "app/tax"].map((r) => join(ROOT, r));
  const files = [...new Set(roots.flatMap((r) => sourceFiles(r)))].filter((f) => !/tax-wording\.ts$/.test(f));

  it("finds the CPA strings it is meant to guard (not vacuous)", () => {
    let count = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      STRING_LITERAL.lastIndex = 0;
      for (let m = STRING_LITERAL.exec(text); m !== null; m = STRING_LITERAL.exec(text)) {
        if (/\bCPA\b/.test(m[1] ?? m[2] ?? m[3] ?? "")) count += 1;
      }
    }
    expect(count).toBeGreaterThan(30);
  });

  it("ownerWording leaves no standalone CPA in any string literal", () => {
    const leftovers: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      STRING_LITERAL.lastIndex = 0;
      for (let m = STRING_LITERAL.exec(text); m !== null; m = STRING_LITERAL.exec(text)) {
        const s = m[1] ?? m[2] ?? m[3] ?? "";
        if (!/\bCPA\b/.test(s)) continue;
        const out = ownerWording(s);
        if (findCpaWording(out).length > 0) leftovers.push(`${f}: ${out.slice(0, 120)}`);
      }
    }
    expect(leftovers).toEqual([]);
  });
});
