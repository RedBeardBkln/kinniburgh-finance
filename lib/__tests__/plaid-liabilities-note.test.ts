import { describe, expect, it } from "vitest";
import { liabilitiesErrorNote } from "@/lib/plaid-liabilities-note";

describe("liabilitiesErrorNote", () => {
  it("says nothing for a login with no card or loan accounts (TD Bank checking + savings)", () => {
    expect(liabilitiesErrorNote("NO_LIABILITY_ACCOUNTS", "the item has no liability accounts")).toBeNull();
  });

  it("keeps the specific notes for the known codes", () => {
    expect(liabilitiesErrorNote("PRODUCTS_NOT_SUPPORTED", "x")).toMatch(/does not provide statement data/);
    expect(liabilitiesErrorNote("INVALID_PRODUCT", "x")).toMatch(/never granted/);
    expect(liabilitiesErrorNote("ADDITIONAL_CONSENT_REQUIRED", "x")).toMatch(/one more consent step/);
  });

  it("falls back to the code, then the message", () => {
    expect(liabilitiesErrorNote("SOMETHING_ELSE", "x")).toBe("Statement data unavailable: SOMETHING_ELSE");
    expect(liabilitiesErrorNote(null, "timeout")).toBe("Statement data unavailable: timeout");
  });
});
