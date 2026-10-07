import { describe, it, expect } from "vitest";
import {
  canonicalPercent,
  containsPrivateIdentifier,
  validateFactDraft,
  validateFactKey,
  validateFactValue,
  validateReason,
  type FactDraft,
} from "@/lib/tax-facts/validate";
import { parseDollarsToCents } from "@/lib/tax-facts/group";

const draft = (over: Partial<FactDraft> = {}): FactDraft => ({
  factKey: "household.filing_status",
  category: "household",
  label: "Filing status",
  taxYear: 2025,
  valueKind: "choice",
  valueText: "mfj",
  carryPolicy: "reconfirm",
  sourceKind: "owner_statement",
  ...over,
});

describe("fact key", () => {
  it.each(["household.filing_status", "decision.x1.home_office_method", "a.b", "property.arbor_rd_56.use", "estate.form_1041_2024_filed"])(
    "accepts %s",
    (k) => expect(validateFactKey(k).ok).toBe(true)
  );
  it.each(["", "nodots", "Upper.case", "a..b", ".a.b", "a.b.", "a b.c", "a.b.c.d.e.f.g", `a.${"x".repeat(80)}`, "a-b.c"])("rejects %j", (k) =>
    expect(validateFactKey(k).ok).toBe(false)
  );
  it("rejects a key that looks like an identifier", () => {
    expect(validateFactKey("a.123456789").ok).toBe(false);
  });
});

describe("value per kind", () => {
  it("money_cents: safe integer cents only, no text", () => {
    expect(validateFactValue("money_cents", 1430000, null)).toEqual({ ok: true, value: { valueCents: 1430000, valueText: null } });
    expect(validateFactValue("money_cents", 12.5, null).ok).toBe(false);
    expect(validateFactValue("money_cents", null, null).ok).toBe(false);
    expect(validateFactValue("money_cents", Number.MAX_SAFE_INTEGER + 2, null).ok).toBe(false);
    expect(validateFactValue("money_cents", 100, "text").ok).toBe(false);
    // the column is a Postgres INTEGER: the validator must refuse what the column cannot hold
    expect(validateFactValue("money_cents", 2_147_483_647, null).ok).toBe(true);
    expect(validateFactValue("money_cents", -2_147_483_647, null).ok).toBe(true);
    expect(validateFactValue("money_cents", 2_147_483_648, null).ok).toBe(false);
    expect(validateFactValue("money_cents", -2_147_483_648, null).ok).toBe(false);
    expect(validateFactValue("money_cents", 100_000_000_000, null).ok).toBe(false);
  });
  it("percent: 0 to 100, one decimal, canonical", () => {
    expect(validateFactValue("percent", null, "50")).toEqual({ ok: true, value: { valueCents: null, valueText: "50" } });
    expect(validateFactValue("percent", null, "12.5")).toEqual({ ok: true, value: { valueCents: null, valueText: "12.5" } });
    expect(validateFactValue("percent", null, "50.0")).toEqual({ ok: true, value: { valueCents: null, valueText: "50" } });
    expect(validateFactValue("percent", null, "100").ok).toBe(true);
    expect(validateFactValue("percent", null, "100.1").ok).toBe(false);
    expect(validateFactValue("percent", null, "12.55").ok).toBe(false);
    expect(validateFactValue("percent", null, "-1").ok).toBe(false);
    expect(canonicalPercent("abc")).toBeNull();
  });
  it("bool: yes or no only", () => {
    expect(validateFactValue("bool", null, "yes").ok).toBe(true);
    expect(validateFactValue("bool", null, "no").ok).toBe(true);
    expect(validateFactValue("bool", null, "maybe").ok).toBe(false);
    expect(validateFactValue("bool", null, "").ok).toBe(false);
  });
  it("choice: short id without spaces", () => {
    expect(validateFactValue("choice", null, "refund_all").ok).toBe(true);
    expect(validateFactValue("choice", null, "apply_amount:100").ok).toBe(true);
    expect(validateFactValue("choice", null, "refund all").ok).toBe(false);
    expect(validateFactValue("choice", null, "A").ok).toBe(false);
    expect(validateFactValue("choice", null, "x".repeat(41)).ok).toBe(false);
  });
  it("text kinds: required, at most 600 characters, no cents", () => {
    for (const kind of ["text", "none_statement", "open_item"] as const) {
      expect(validateFactValue(kind, null, "No margin or investment interest").ok).toBe(true);
      expect(validateFactValue(kind, null, "  ").ok).toBe(false);
      expect(validateFactValue(kind, null, "x".repeat(601)).ok).toBe(false);
      expect(validateFactValue(kind, 5, "text").ok).toBe(false);
    }
    expect(validateFactValue("text", null, "x".repeat(600)).ok).toBe(true);
  });
});

describe("privacy guard", () => {
  const bad = [
    "123-45-6789",
    "123456789",
    "12-3456789",
    "12 - 3456789",
    "account 1234567",
    "my date of birth is in May",
    "DOB: May",
    "born on a Tuesday",
    "1234 5678 9012 3456",
  ];
  it.each(bad)("flags %j", (t) => expect(containsPrivateIdentifier(t)).toBe(true));

  const good = ["1,894.50", "14,300", "No margin or investment interest", "TY2025 W-2 box 1 total 273,291", "Aug 2024", "2019 deed 90%"];
  it.each(good)("accepts %j", (t) => expect(containsPrivateIdentifier(t)).toBe(false));

  it("is applied to every free-text field of a fact, and the error never echoes the text", () => {
    for (const over of [
      { label: "Filing 123-45-6789" },
      { valueKind: "text", valueText: "ein 12-3456789" },
      { sourceRef: "see 123456789" },
    ] as Partial<FactDraft>[]) {
      const r = validateFactDraft(draft(over));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/\d{5}/);
    }
    const r = validateReason("my SSN 123-45-6789", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("6789");
  });
});

describe("reason", () => {
  it("is optional only when allowed, 3 to 500 characters", () => {
    expect(validateReason("", false)).toEqual({ ok: true, value: null });
    expect(validateReason(undefined, false)).toEqual({ ok: true, value: null });
    expect(validateReason("", true).ok).toBe(false);
    expect(validateReason("ab", true).ok).toBe(false);
    expect(validateReason("abc", true)).toEqual({ ok: true, value: "abc" });
    expect(validateReason("x".repeat(500), true).ok).toBe(true);
    expect(validateReason("x".repeat(501), true).ok).toBe(false);
  });
});

describe("whole fact", () => {
  it("accepts a valid fact and canonicalises", () => {
    const r = validateFactDraft(draft({ valueKind: "percent", valueText: "50.0", factKey: "decision.x6.pct", category: "decision" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.valueText).toBe("50");
  });
  it("rejects unknown vocabulary and bad years", () => {
    expect(validateFactDraft(draft({ category: "nope" })).ok).toBe(false);
    expect(validateFactDraft(draft({ valueKind: "nope" })).ok).toBe(false);
    expect(validateFactDraft(draft({ carryPolicy: "nope" })).ok).toBe(false);
    expect(validateFactDraft(draft({ sourceKind: "nope" })).ok).toBe(false);
    expect(validateFactDraft(draft({ taxYear: 1999 })).ok).toBe(false);
    expect(validateFactDraft(draft({ taxYear: 2025.5 })).ok).toBe(false);
    expect(validateFactDraft(draft({ label: "" })).ok).toBe(false);
    expect(validateFactDraft(draft({ label: "x".repeat(121) })).ok).toBe(false);
  });
  it("an open item uses the open item category and kind together, with the stable placeholder policy", () => {
    expect(validateFactDraft(draft({ category: "open_item", valueKind: "open_item", valueText: "Question", carryPolicy: "stable" })).ok).toBe(true);
    expect(validateFactDraft(draft({ category: "open_item", valueKind: "text", valueText: "Question" })).ok).toBe(false);
    expect(validateFactDraft(draft({ category: "household", valueKind: "open_item", valueText: "Question", carryPolicy: "stable" })).ok).toBe(false);
    expect(validateFactDraft(draft({ category: "open_item", valueKind: "open_item", valueText: "Question", carryPolicy: "reconfirm" })).ok).toBe(false);
  });
});

describe("parseDollarsToCents", () => {
  it("reads plain dollar amounts in integer cents", () => {
    expect(parseDollarsToCents("14,300")).toBe(1430000);
    expect(parseDollarsToCents("14300.5")).toBe(1430050);
    expect(parseDollarsToCents("0.07")).toBe(7);
    expect(parseDollarsToCents("-5")).toBe(-500);
    expect(parseDollarsToCents("1.234")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("1,23")).toBeNull();
  });
});
