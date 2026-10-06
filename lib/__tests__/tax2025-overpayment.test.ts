// The overpayment choice (decisions X7 / X8): parse / format / split helpers in lib/tax2025/overpayment.ts, and the
// registry plumbing around them (what may be STORED versus what the sheet may LIST).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  OVERPAYMENT_MODES,
  formatOverpaymentChoice,
  formatWholeDollars,
  isStoredOverpaymentChoice,
  overpaymentChoiceLabel,
  overpaymentPreview,
  parseOverpaymentAmount,
  parseOverpaymentChoice,
  splitOverpayment,
} from "@/lib/tax2025/overpayment";
import {
  DECISION_REGISTRY,
  canonicalDecisionChoice,
  decisionChoices,
  isListableDecisionChoice,
  isOverpaymentDecisionKey,
  isValidDecisionChoice,
} from "@/lib/tax2025/overrides";

describe("parseOverpaymentChoice", () => {
  it("accepts the three forms and gives the canonical text", () => {
    expect(parseOverpaymentChoice("refund_all")).toEqual({ ok: true, mode: "refund_all", appliedDollars: null, canonical: "refund_all" });
    expect(parseOverpaymentChoice("apply_all")).toEqual({ ok: true, mode: "apply_all", appliedDollars: null, canonical: "apply_all" });
    expect(parseOverpaymentChoice("apply_amount:5000")).toEqual({ ok: true, mode: "apply_amount", appliedDollars: 5000, canonical: "apply_amount:5000" });
  });
  it("accepts a dollar sign, thousands commas and surrounding spaces and stores the plain digits", () => {
    for (const t of ["apply_amount:$5,000", "apply_amount: 5000 ", " apply_amount:5,000", "apply_amount:$ 5000"]) {
      const p = parseOverpaymentChoice(t);
      expect(p.ok, t).toBe(true);
      if (p.ok) expect(p.canonical, t).toBe("apply_amount:5000");
    }
    expect(parseOverpaymentChoice("apply_amount:1").ok).toBe(true);
    expect(parseOverpaymentChoice("apply_amount:9999999").ok).toBe(true);
  });
  it("refuses a bare apply_amount, zero, negative, cents, text, too many digits, and extra parts", () => {
    for (const t of ["", "apply_amount", "apply_amount:", "apply_amount:0", "apply_amount:-5", "apply_amount:100.50", "apply_amount:abc", "apply_amount:99999999", "refund_all:5", "apply_all:1", "REFUND_ALL", "refund", "apply_amount:5000x", "apply_amount:5 000", "apply_amount:1,00", "apply_amount:00"]) {
      expect(parseOverpaymentChoice(t).ok, JSON.stringify(t)).toBe(false);
    }
  });
  it("says why: cents get the whole-dollars message", () => {
    const p = parseOverpaymentChoice("apply_amount:100.50");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toBe("Enter whole dollars: the form takes whole dollars.");
    const p2 = parseOverpaymentAmount("12.");
    expect(p2.ok).toBe(false);
  });
  it("is stable: parse(canonical) is canonical, and isStoredOverpaymentChoice only accepts canonical text", () => {
    for (const t of ["refund_all", "apply_all", "apply_amount:1", "apply_amount:16054"]) {
      const p = parseOverpaymentChoice(t);
      expect(p.ok && p.canonical).toBe(t);
      expect(isStoredOverpaymentChoice(t)).toBe(true);
    }
    expect(isStoredOverpaymentChoice("apply_amount:$5,000")).toBe(false);
    expect(isStoredOverpaymentChoice("apply_amount")).toBe(false);
  });
  it("formatOverpaymentChoice and the labels read like the dialog", () => {
    expect(formatOverpaymentChoice("refund_all", null)).toBe("refund_all");
    expect(formatOverpaymentChoice("apply_amount", 5000)).toBe("apply_amount:5000");
    expect(overpaymentChoiceLabel("refund_all")).toBe("Refund all");
    expect(overpaymentChoiceLabel("apply_all")).toBe("Apply all to 2026");
    expect(overpaymentChoiceLabel("apply_amount:5000")).toBe("Apply $5,000 to 2026");
    expect(overpaymentChoiceLabel("nonsense")).toBeNull();
    expect(formatWholeDollars(16054)).toBe("$16,054");
    expect(formatWholeDollars(0)).toBe("$0");
  });
});

describe("splitOverpayment (whole dollars, hand table)", () => {
  it("refund all, apply all, a stated amount", () => {
    expect(splitOverpayment(16054, "refund_all", null)).toEqual({ refunded: 16054, applied: 0 });
    expect(splitOverpayment(16054, "apply_all", null)).toEqual({ refunded: 0, applied: 16054 });
    expect(splitOverpayment(16054, "apply_amount", 5000)).toEqual({ refunded: 11054, applied: 5000 });
    expect(splitOverpayment(904, "apply_amount", 400)).toEqual({ refunded: 504, applied: 400 });
  });
  it("the edges: exactly everything, one dollar, and more than is available (null: the caller blocks)", () => {
    expect(splitOverpayment(904, "apply_amount", 904)).toEqual({ refunded: 0, applied: 904 });
    expect(splitOverpayment(904, "apply_amount", 1)).toEqual({ refunded: 903, applied: 1 });
    expect(splitOverpayment(904, "apply_amount", 905)).toBeNull();
    expect(splitOverpayment(904, "apply_amount", 0)).toBeNull();
    expect(splitOverpayment(904, "apply_amount", null)).toBeNull();
    expect(splitOverpayment(0, "refund_all", null)).toEqual({ refunded: 0, applied: 0 });
  });
  it("refunded + applied is always the available amount (sweep)", () => {
    for (let avail = 0; avail <= 60; avail++) {
      for (let a = 1; a <= 70; a++) {
        const s = splitOverpayment(avail, "apply_amount", a);
        if (a > avail) expect(s).toBeNull();
        else expect(s !== null && s.refunded + s.applied === avail && s.applied === a).toBe(true);
      }
    }
  });
  it("the dialog preview", () => {
    expect(overpaymentPreview(16054, "apply_amount", "5000")).toBe("Refunded: $11,054; applied to 2026: $5,000");
    expect(overpaymentPreview(16054, "refund_all", "")).toBe("Refunded: $16,054; applied to 2026: $0");
    expect(overpaymentPreview(16054, "apply_all", "")).toBe("Refunded: $0; applied to 2026: $16,054");
    expect(overpaymentPreview(16054, "apply_amount", "16055")).toBeNull();
    expect(overpaymentPreview(16054, "apply_amount", "12.5")).toBeNull();
    expect(overpaymentPreview(16054, "apply_amount", "")).toBeNull();
  });
});

describe("the registry: what may be stored versus what the sheet may list", () => {
  it("X7 and X8 are registry decisions with the bare modes as their listable choices", () => {
    expect(DECISION_REGISTRY.federalOverpayment.decisionId).toBe("X7");
    expect(DECISION_REGISTRY.ctOverpayment.decisionId).toBe("X8");
    expect([...decisionChoices("federalOverpayment")]).toEqual([...OVERPAYMENT_MODES]);
    expect(isOverpaymentDecisionKey("federalOverpayment")).toBe(true);
    expect(isOverpaymentDecisionKey("homeOfficeMethod")).toBe(false);
  });
  it("storable: the three parseable forms, never a bare apply_amount; listable: the three bare ids, never no_election or a stored amount", () => {
    for (const key of ["federalOverpayment", "ctOverpayment"] as const) {
      expect(isValidDecisionChoice(key, "refund_all")).toBe(true);
      expect(isValidDecisionChoice(key, "apply_all")).toBe(true);
      expect(isValidDecisionChoice(key, "apply_amount:5000")).toBe(true);
      expect(isValidDecisionChoice(key, "apply_amount")).toBe(false);
      expect(isValidDecisionChoice(key, "no_election")).toBe(false);
      expect(isValidDecisionChoice(key, "schedule_a")).toBe(false);
      expect(isListableDecisionChoice(key, "apply_amount")).toBe(true);
      expect(isListableDecisionChoice(key, "refund_all")).toBe(true);
      expect(isListableDecisionChoice(key, "no_election")).toBe(false);
      expect(isListableDecisionChoice(key, "apply_amount:5000")).toBe(false);
      expect(canonicalDecisionChoice(key, "apply_amount:$5,000")).toBe("apply_amount:5000");
    }
    // the older decisions are unchanged: registry ids only
    expect(isValidDecisionChoice("homeOfficeMethod", "actual")).toBe(true);
    expect(isValidDecisionChoice("homeOfficeMethod", "refund_all")).toBe(false);
    expect(canonicalDecisionChoice("homeOfficeMethod", "actual")).toBe("actual");
  });
});

describe("structural pins for lib/tax2025/overpayment.ts", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "tax2025", "overpayment.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  it("imports nothing (client-safe)", () => {
    expect(/^\s*import\s/m.test(code)).toBe(false);
  });
  it("uses no float parsing and no Math rounding (integer arithmetic only)", () => {
    expect(/\bparseFloat\b|Number\(\s*["'`]|Math\.(round|floor|ceil|trunc)\b|toFixed\(/.test(code)).toBe(false);
  });
});
