import { describe, expect, it } from "vitest";
import { ADDRESS_REMOVED, redactStreetAddresses, redactText, safeDescriptive, safeField, scrubDeep } from "@/lib/advisor/scrub";

// redactStreetAddresses is a HEURISTIC for owner-typed descriptive fields; every address here is synthetic.

describe("redactStreetAddresses", () => {
  it("replaces number + street words + suffix", () => {
    expect(redactStreetAddresses("Barn at 12 Maple Rd")).toBe(`Barn at ${ADDRESS_REMOVED}`);
    expect(redactStreetAddresses("400 Old Mill Road")).toBe(ADDRESS_REMOVED);
    expect(redactStreetAddresses("Deck, 7 Elm Street.")).toBe(`Deck, ${ADDRESS_REMOVED}`);
    expect(redactStreetAddresses("1 Main Ave and 22 Lake View Dr")).toBe(`${ADDRESS_REMOVED} and ${ADDRESS_REMOVED}`);
  });

  it("covers each suffix in the list", () => {
    for (const s of ["Rd", "Road", "St", "Street", "Ave", "Avenue", "Ln", "Lane", "Dr", "Drive", "Ct", "Court", "Blvd", "Way", "Pl", "Place", "Cir", "Hwy", "Pkwy", "Ter"]) {
      expect(redactStreetAddresses(`55 Pine ${s}`), s).toBe(ADDRESS_REMOVED);
    }
  });

  it("leaves ordinary numbers and words alone", () => {
    for (const s of ["2025 Schedule C", "3 months", "Rd", "Roof replacement 2024", "Section 179 deduction", "12 payments of 100", "Form 1099-INT", "Invoice 4411 paid"]) {
      expect(redactStreetAddresses(s), s).toBe(s);
    }
  });

  it("documented limits: an address without a leading number, or with a lower-case street word, passes", () => {
    expect(redactStreetAddresses("the barn on the old road")).toBe("the barn on the old road");
    expect(redactStreetAddresses("12 maple rd")).toBe("12 maple rd");
    expect(redactStreetAddresses("Maple Rd")).toBe("Maple Rd");
  });

  it("is not part of redactText, safeField or scrubDeep (shapers apply it to descriptive fields only)", () => {
    expect(redactText("12 Maple Rd")).toBe("12 Maple Rd");
    expect(safeField("12 Maple Rd", 40)).toBe("12 Maple Rd");
    expect(scrubDeep({ a: "12 Maple Rd" })).toEqual({ a: "12 Maple Rd" });
  });

  it("is idempotent", () => {
    const once = redactStreetAddresses("Shed at 12 Maple Rd");
    expect(redactStreetAddresses(once)).toBe(once);
  });

  it("safeDescriptive removes the address first, then applies the usual identifier redaction and clip", () => {
    expect(safeDescriptive("Camera at 12 Maple Rd, ref 123-45-6789", 80)).toBe(`Camera at ${ADDRESS_REMOVED}, ref [number removed]`);
    expect(safeDescriptive(null, 10)).toBe("");
    expect(safeDescriptive("A\u200b long   description   here", 12).length).toBeLessThanOrEqual(12);
  });
});
