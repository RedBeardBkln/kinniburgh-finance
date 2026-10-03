import { describe, it, expect } from "vitest";
import { normalizeDonationInput } from "@/lib/donations";

const base = {
  date: "2025-06-15",
  recipient: "  Food Bank  ",
  amount: "$1,250.50",
  kind: "cash",
  substantiation: "bank_record",
};

describe("normalizeDonationInput", () => {
  it("normalizes a valid cash gift", () => {
    const r = normalizeDonationInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.date.toISOString()).toBe("2025-06-15T12:00:00.000Z");
      expect(r.value.recipient).toBe("Food Bank");
      expect(r.value.amountCents).toBe(125050);
      expect(r.value.kind).toBe("cash");
      expect(r.value.substantiation).toBe("bank_record");
      expect(r.value.receiptDocumentId).toBeNull();
      expect(r.value.notes).toBeNull();
    }
  });

  it("keeps notes and a valid receipt id", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const r = normalizeDonationInput({ ...base, receiptDocumentId: id, notes: " thanks " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.receiptDocumentId).toBe(id);
      expect(r.value.notes).toBe("thanks");
    }
  });

  it("rejects a bad receipt uuid", () => {
    expect(normalizeDonationInput({ ...base, receiptDocumentId: "not-a-uuid" }).ok).toBe(false);
  });

  it("rejects non-cash gifts documented only by a bank record", () => {
    const r = normalizeDonationInput({ ...base, kind: "noncash", substantiation: "bank_record" });
    expect(r.ok).toBe(false);
    expect(normalizeDonationInput({ ...base, kind: "noncash", substantiation: "written_acknowledgment" }).ok).toBe(true);
    expect(normalizeDonationInput({ ...base, kind: "noncash", substantiation: "none" }).ok).toBe(true);
  });

  it("rejects an empty recipient, bad amounts, bad dates and unknown enums", () => {
    expect(normalizeDonationInput({ ...base, recipient: "   " }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, amount: "0" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, amount: "12.345" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, amount: "-5" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, date: "2025-02-30" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, kind: "stock" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, substantiation: "verbal" }).ok).toBe(false);
    expect(normalizeDonationInput(null).ok).toBe(false);
  });

  it("rejects an over-long recipient and notes", () => {
    expect(normalizeDonationInput({ ...base, recipient: "x".repeat(201) }).ok).toBe(false);
    expect(normalizeDonationInput({ ...base, notes: "x".repeat(2001) }).ok).toBe(false);
  });
});
