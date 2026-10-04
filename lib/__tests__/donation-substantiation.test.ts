import { describe, it, expect } from "vitest";
import {
  flagsForDonation,
  flagsForYear,
  loggedTotals,
  ACK_THRESHOLD_CENTS,
  FORM_8283_NONCASH_TOTAL_CENTS,
  type DonationFlagInput,
} from "@/lib/donation-substantiation";

const d = (over: Partial<DonationFlagInput>): DonationFlagInput => ({
  amountCents: 10_000,
  kind: "cash",
  substantiation: "bank_record",
  receiptDocumentId: null,
  ...over,
});
const codes = (x: DonationFlagInput) => flagsForDonation(x).map((f) => f.code);

describe("thresholds (IRS Pub. 526 (2025))", () => {
  it("encodes $250 and $500 in cents", () => {
    expect(ACK_THRESHOLD_CENTS).toBe(25_000);
    expect(FORM_8283_NONCASH_TOTAL_CENTS).toBe(50_000);
  });
});

describe("flagsForDonation", () => {
  it("cash $249.99 with no record -> cash_no_record", () => {
    expect(codes(d({ amountCents: 24_999, substantiation: "none" }))).toEqual(["cash_no_record"]);
  });

  it("cash $249.99 with a bank record -> no flag", () => {
    expect(codes(d({ amountCents: 24_999, substantiation: "bank_record" }))).toEqual([]);
  });

  it("cash $250.00 with a bank record -> ack_needed_250 and not cash_no_record", () => {
    const c = codes(d({ amountCents: 25_000, substantiation: "bank_record" }));
    expect(c).toEqual(["ack_needed_250"]);
    expect(c).not.toContain("cash_no_record");
  });

  it("cash $250.00 with no record -> a single ack_needed_250 (one record flag only)", () => {
    expect(codes(d({ amountCents: 25_000, substantiation: "none" }))).toEqual(["ack_needed_250"]);
  });

  it("cash $250.00 with a written acknowledgment -> no action flag; info nudge when nothing is uploaded", () => {
    const flags = flagsForDonation(d({ amountCents: 25_000, substantiation: "written_acknowledgment" }));
    expect(flags.some((f) => f.level === "action")).toBe(false);
    expect(flags.map((f) => f.code)).toEqual(["ack_not_uploaded"]);
    expect(flags[0]!.level).toBe("info");
  });

  it("written acknowledgment with an uploaded document -> no flags at all", () => {
    expect(
      flagsForDonation(
        d({ amountCents: 25_000, substantiation: "written_acknowledgment", receiptDocumentId: "22222222-2222-4222-8222-222222222222" })
      )
    ).toEqual([]);
  });

  it("non-cash below $250 with no record -> noncash_no_record", () => {
    expect(codes(d({ kind: "noncash", amountCents: 24_999, substantiation: "none" }))).toEqual(["noncash_no_record"]);
  });

  it("non-cash $250+ with no record -> ack_needed_250", () => {
    expect(codes(d({ kind: "noncash", amountCents: 25_000, substantiation: "none" }))).toEqual(["ack_needed_250"]);
  });

  it("action flags are advisory text and never mention a deduction amount", () => {
    for (const f of flagsForDonation(d({ amountCents: 25_000, substantiation: "none" }))) {
      expect(f.message).not.toMatch(/deduct(ible)? amount|\bAGI\b/i);
    }
  });
});

describe("flagsForYear", () => {
  const nc = (amountCents: number, extra: Partial<{ archivedAt: Date | null }> = {}) => ({
    ...d({ kind: "noncash", amountCents, substantiation: "written_acknowledgment" }),
    ...extra,
  });

  it("non-cash total exactly $500.00 -> no Form 8283 flag", () => {
    expect(flagsForYear([nc(30_000), nc(20_000)])).toEqual([]);
  });

  it("non-cash total $500.01 -> CPA flag with CPA wording", () => {
    const flags = flagsForYear([nc(30_000), nc(20_001)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe("noncash_over_500_form_8283");
    expect(flags[0]!.level).toBe("cpa");
    expect(flags[0]!.message).toMatch(/You decide/);
    expect(flags[0]!.message).toMatch(/8283/);
  });

  it("excludes archived rows and cash rows from the non-cash sum", () => {
    expect(flagsForYear([nc(50_001, { archivedAt: new Date() })])).toEqual([]);
    expect(flagsForYear([d({ kind: "cash", amountCents: 900_000 }), nc(50_000)])).toEqual([]);
  });

  it("empty year -> no flags", () => {
    expect(flagsForYear([])).toEqual([]);
  });
});

describe("loggedTotals", () => {
  it("sums cash and non-cash separately and skips archived rows", () => {
    const totals = loggedTotals([
      { ...d({ kind: "cash", amountCents: 1_000 }) },
      { ...d({ kind: "cash", amountCents: 2_000 }), archivedAt: new Date() },
      { ...d({ kind: "noncash", amountCents: 500 }) },
    ]);
    expect(totals).toEqual({ cashCents: 1_000, noncashCents: 500 });
  });
});
