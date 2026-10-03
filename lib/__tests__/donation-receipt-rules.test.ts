import { describe, it, expect } from "vitest";
import { findDuplicateDonations, normalizeRecipient, receiptLinkNeedsConfirmation } from "@/lib/donation-receipt";
import type { DonationConflict } from "@/lib/donations";

describe("normalizeRecipient", () => {
  it("ignores case, accents, punctuation and spacing", () => {
    expect(normalizeRecipient("Connecticut  Food-Bank")).toBe("connecticut food bank");
    expect(normalizeRecipient("CONNECTICUT FOOD BANK.")).toBe("connecticut food bank");
    expect(normalizeRecipient("Café   Society")).toBe("cafe society");
  });

  it("treats & and 'and' alike", () => {
    expect(normalizeRecipient("Smith & Sons Fund")).toBe(normalizeRecipient("Smith and Sons Fund"));
  });

  it("drops a leading 'The' and trailing legal suffixes", () => {
    expect(normalizeRecipient("The Food Bank, Inc.")).toBe("food bank");
    expect(normalizeRecipient("Food Bank Incorporated")).toBe("food bank");
    expect(normalizeRecipient("Food Bank LLC")).toBe("food bank");
    expect(normalizeRecipient("Food Bank Corp")).toBe("food bank");
  });

  it("keeps words that distinguish charities (Foundation, Fund, Society)", () => {
    expect(normalizeRecipient("Hope Foundation")).not.toBe(normalizeRecipient("Hope Fund"));
    expect(normalizeRecipient("Hope Society")).toBe("hope society");
  });

  it("never reduces a name to nothing", () => {
    expect(normalizeRecipient("Inc")).toBe("inc");
    expect(normalizeRecipient("   ")).toBe("");
  });
});

describe("findDuplicateDonations", () => {
  const existing: DonationConflict[] = [
    { id: "a", dateIso: "2025-06-15", recipient: "Connecticut Food Bank", amountCents: 25000 },
    { id: "b", dateIso: "2025-06-15", recipient: "Red Cross", amountCents: 25000 },
    { id: "c", dateIso: "2025-07-15", recipient: "Connecticut Food Bank", amountCents: 25000 },
    { id: "d", dateIso: "2025-06-15", recipient: "Connecticut Food Bank", amountCents: 10000 },
  ];
  const cand = { dateIso: "2025-06-15", amountCents: 25000, recipient: "Connecticut Food Bank" };

  it("same date + amount + charity is a duplicate", () => {
    expect(findDuplicateDonations(cand, existing).map((d) => d.id)).toEqual(["a"]);
  });

  it("legal-suffix, case and punctuation variants still match", () => {
    for (const recipient of ["connecticut food bank, inc.", "The Connecticut Food Bank", "CONNECTICUT FOOD-BANK LLC"]) {
      expect(findDuplicateDonations({ ...cand, recipient }, existing).map((d) => d.id)).toEqual(["a"]);
    }
  });

  it("a different date is never a duplicate (recurring monthly gifts are legitimate)", () => {
    expect(findDuplicateDonations({ ...cand, dateIso: "2025-08-15" }, existing)).toEqual([]);
  });

  it("a different amount is never a duplicate", () => {
    expect(findDuplicateDonations({ ...cand, amountCents: 25001 }, existing)).toEqual([]);
  });

  it("same day and amount to a different charity is not a duplicate", () => {
    expect(findDuplicateDonations({ ...cand, recipient: "Habitat for Humanity" }, existing)).toEqual([]);
  });

  it("returns every matching gift", () => {
    const two = [...existing, { id: "e", dateIso: "2025-06-15", recipient: "Connecticut Food Bank Inc", amountCents: 25000 }];
    expect(findDuplicateDonations(cand, two).map((d) => d.id)).toEqual(["a", "e"]);
  });

  it("a blank recipient matches nothing", () => {
    expect(findDuplicateDonations({ ...cand, recipient: "  " }, existing)).toEqual([]);
  });
});

describe("receiptLinkNeedsConfirmation (the double-link rule)", () => {
  it("nothing linked: no confirmation needed", () => {
    expect(receiptLinkNeedsConfirmation([], undefined, false)).toBe(false);
  });

  it("already linked and not confirmed: needs confirmation", () => {
    expect(receiptLinkNeedsConfirmation([{ id: "a" }], undefined, false)).toBe(true);
  });

  it("already linked and explicitly confirmed: allowed", () => {
    expect(receiptLinkNeedsConfirmation([{ id: "a" }], undefined, true)).toBe(false);
  });

  it("the donation being edited is excluded", () => {
    expect(receiptLinkNeedsConfirmation([{ id: "a" }], "a", false)).toBe(false);
    expect(receiptLinkNeedsConfirmation([{ id: "a" }, { id: "b" }], "a", false)).toBe(true);
  });
});
