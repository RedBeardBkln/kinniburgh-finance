import { describe, it, expect } from "vitest";
import {
  EMPTY_RECEIPT_READING,
  buildDonationPrefill,
  buildReceiptGiftView,
  readDonationReceipt,
  receiptFlags,
  type DonationReceiptReading,
  type ReceiptDocRow,
} from "@/lib/donation-receipt";

const PERSONAL = "p-1";
const BUSINESS = "b-1";

const reading = (over: Partial<DonationReceiptReading> = {}): DonationReceiptReading => ({
  ...EMPTY_RECEIPT_READING,
  organizationName: "Connecticut Food Bank",
  giftDate: "2025-06-15",
  cashAmountCents: 25000,
  readsAsWrittenAcknowledgment: true,
  noGoodsOrServicesStated: true,
  ...over,
});

describe("readDonationReceipt", () => {
  it("reads typed values and trims text", () => {
    expect(
      readDonationReceipt({
        organizationName: "  Food Bank ",
        organizationEIN: "06-1234567",
        giftDate: "2025-06-15",
        cashAmountCents: 100,
        coversMultipleGifts: false,
      })
    ).toMatchObject({
      organizationName: "Food Bank",
      organizationEIN: "06-1234567",
      giftDate: "2025-06-15",
      cashAmountCents: 100,
      coversMultipleGifts: false,
      nonCashDescription: null,
    });
  });

  it("is defensive: wrong types become null, never coerced", () => {
    const r = readDonationReceipt({
      organizationName: 5,
      cashAmountCents: "25000",
      coversMultipleGifts: "true",
      readsAsWrittenAcknowledgment: 1,
      giftDate: {},
    });
    expect(r).toEqual(EMPTY_RECEIPT_READING);
    expect(readDonationReceipt(null)).toEqual(EMPTY_RECEIPT_READING);
    expect(readDonationReceipt([1])).toEqual(EMPTY_RECEIPT_READING);
    expect(readDonationReceipt({ cashAmountCents: 250.5 }).cashAmountCents).toBeNull();
    expect(readDonationReceipt({ cashAmountCents: -5 }).cashAmountCents).toBeNull();
  });
});

describe("buildDonationPrefill", () => {
  it("a cash gift: $250.00 from 25000 cents, written acknowledgment, recipient and date", () => {
    expect(buildDonationPrefill(reading())).toEqual({
      date: "2025-06-15",
      recipient: "Connecticut Food Bank",
      amount: "250.00",
      kind: "cash",
      substantiation: "written_acknowledgment",
      notes: "",
    });
  });

  it("formats cents with integer math (19.99 stays 19.99)", () => {
    expect(buildDonationPrefill(reading({ cashAmountCents: 1999 })).amount).toBe("19.99");
    expect(buildDonationPrefill(reading({ cashAmountCents: 5 })).amount).toBe("0.05");
  });

  it("a non-cash gift: amount left blank (the letter does not value goods), description in the notes", () => {
    const p = buildDonationPrefill(reading({ cashAmountCents: null, nonCashDescription: "Three bags of winter coats" }));
    expect(p.kind).toBe("noncash");
    expect(p.amount).toBe("");
    expect(p.notes).toBe("Non-cash items per the letter: Three bags of winter coats");
  });

  it("cash AND non-cash: the cash gift wins, the description is kept in the notes", () => {
    const p = buildDonationPrefill(reading({ nonCashDescription: "Coats" }));
    expect(p.kind).toBe("cash");
    expect(p.amount).toBe("250.00");
    expect(p.notes).toContain("Coats");
  });

  it("cash amount of 0 is not a gift amount", () => {
    expect(buildDonationPrefill(reading({ cashAmountCents: 0 })).amount).toBe("");
    expect(buildDonationPrefill(reading({ cashAmountCents: 0, nonCashDescription: "Books" })).kind).toBe("noncash");
  });

  it("no date: blank, never today", () => {
    expect(buildDonationPrefill(reading({ giftDate: null })).date).toBe("");
  });

  it("an out-of-range or impossible date is blank", () => {
    expect(buildDonationPrefill(reading({ giftDate: "1999-12-31" })).date).toBe("");
    expect(buildDonationPrefill(reading({ giftDate: "2101-01-01" })).date).toBe("");
    expect(buildDonationPrefill(reading({ giftDate: "2025-02-30" })).date).toBe("");
  });

  it("evidence: written_acknowledgment only when the reading says so (false and unknown -> none)", () => {
    expect(buildDonationPrefill(reading({ readsAsWrittenAcknowledgment: true })).substantiation).toBe(
      "written_acknowledgment"
    );
    expect(buildDonationPrefill(reading({ readsAsWrittenAcknowledgment: false })).substantiation).toBe("none");
    expect(buildDonationPrefill(reading({ readsAsWrittenAcknowledgment: null })).substantiation).toBe("none");
  });

  describe("evidence needs the goods-or-services question answered (IRS written acknowledgment)", () => {
    it("reads as acknowledgment + 'no goods or services' true -> written_acknowledgment", () => {
      expect(
        buildDonationPrefill(
          reading({ readsAsWrittenAcknowledgment: true, noGoodsOrServicesStated: true, benefitStatement: null })
        ).substantiation
      ).toBe("written_acknowledgment");
    });

    it("reads as acknowledgment + goods provided (false) with a value text -> written_acknowledgment", () => {
      expect(
        buildDonationPrefill(
          reading({
            readsAsWrittenAcknowledgment: true,
            noGoodsOrServicesStated: false,
            benefitStatement: "Dinner valued at $40",
          })
        ).substantiation
      ).toBe("written_acknowledgment");
    });

    it("a benefit text alone (tri-state silent) also counts as answering the question", () => {
      expect(
        buildDonationPrefill(
          reading({ readsAsWrittenAcknowledgment: true, noGoodsOrServicesStated: null, benefitStatement: "Gala ticket" })
        ).substantiation
      ).toBe("written_acknowledgment");
    });

    it("reads as acknowledgment but silent on goods or services (null, no text) -> none", () => {
      const p = buildDonationPrefill(
        reading({ readsAsWrittenAcknowledgment: true, noGoodsOrServicesStated: null, benefitStatement: null })
      );
      expect(p.substantiation).toBe("none");
      // Nothing else about the prefill changes.
      expect(p).toMatchObject({ date: "2025-06-15", recipient: "Connecticut Food Bank", amount: "250.00", kind: "cash" });
    });

    it("not an acknowledgment -> none even when goods or services are answered", () => {
      expect(
        buildDonationPrefill(
          reading({ readsAsWrittenAcknowledgment: false, noGoodsOrServicesStated: true })
        ).substantiation
      ).toBe("none");
      expect(
        buildDonationPrefill(
          reading({ readsAsWrittenAcknowledgment: null, noGoodsOrServicesStated: true })
        ).substantiation
      ).toBe("none");
    });
  });

  it("puts the printed EIN and the multiple-gifts note into the editable notes", () => {
    const p = buildDonationPrefill(reading({ organizationEIN: "06-1234567", coversMultipleGifts: true }));
    expect(p.notes).toBe("EIN 06-1234567 (as printed on the letter)\nLetter lists more than one gift");
  });

  it("an empty reading yields an empty prefill (cash, none) - nothing invented", () => {
    expect(buildDonationPrefill(EMPTY_RECEIPT_READING)).toEqual({
      date: "",
      recipient: "",
      amount: "",
      kind: "cash",
      substantiation: "none",
      notes: "",
    });
  });
});

describe("receiptFlags - goods and services (CPA flag, no arithmetic)", () => {
  const codes = (r: DonationReceiptReading, mode?: "prefill" | "saved") => receiptFlags(r, { mode }).map((f) => f.code);

  it("explicitly provided: CPA flag", () => {
    const f = receiptFlags(reading({ noGoodsOrServicesStated: false, benefitStatement: "Dinner for two" }));
    expect(f.find((x) => x.code === "receipt_goods_services")).toMatchObject({ level: "cpa" });
    expect(f[0]!.message).toContain("Dinner for two");
    expect(f[0]!.message).toMatch(/you decide/);
  });

  it("explicit 'provided' with no description still flags, saying there is no description", () => {
    const f = receiptFlags(reading({ noGoodsOrServicesStated: false, benefitStatement: null }));
    expect(f[0]).toMatchObject({ code: "receipt_goods_services", level: "cpa" });
    expect(f[0]!.message).toContain("no description");
  });

  it("a benefit statement without an explicit 'none' flags for the CPA", () => {
    expect(codes(reading({ noGoodsOrServicesStated: null, benefitStatement: "Gala ticket" }))).toContain(
      "receipt_goods_services"
    );
  });

  it("explicit 'none' plus benefit text is a wording conflict (info), not a CPA flag", () => {
    const c = codes(reading({ noGoodsOrServicesStated: true, benefitStatement: "Dinner" }));
    expect(c).toContain("receipt_ack_wording_conflict");
    expect(c).not.toContain("receipt_goods_services");
  });

  it("explicit 'none' without text: no goods/services flag at all", () => {
    const c = codes(reading({ noGoodsOrServicesStated: true, benefitStatement: null }));
    expect(c).not.toContain("receipt_goods_services");
    expect(c).not.toContain("receipt_goods_services_not_stated");
    expect(c).not.toContain("receipt_ack_wording_conflict");
  });

  it("silence is never treated as 'no goods or services': both unknown -> not-stated info with the IRS source", () => {
    const f = receiptFlags(reading({ noGoodsOrServicesStated: null, benefitStatement: null }));
    const flag = f.find((x) => x.code === "receipt_goods_services_not_stated");
    expect(flag).toMatchObject({ level: "info" });
    expect(flag!.message).toMatch(/normally/);
    expect(flag!.message).toContain("IRS, Charitable contributions - written acknowledgments");
    expect(f.some((x) => x.code === "receipt_goods_services")).toBe(false);
  });

  it("not-stated copy: says the letter does not state it, lists all three IRS alternatives, points to the charity or CPA", () => {
    const flag = receiptFlags(reading({ noGoodsOrServicesStated: null, benefitStatement: null })).find(
      (x) => x.code === "receipt_goods_services_not_stated"
    );
    expect(flag!.message).toContain("does not state whether goods or services were provided");
    expect(flag!.message).toMatch(/states that none were/);
    expect(flag!.message).toMatch(/good-faith estimate/);
    expect(flag!.message).toMatch(/entirely intangible religious benefits/);
    expect(flag!.message).toMatch(/No record yet/);
    expect(flag!.message).toMatch(/complete acknowledgment/);
    expect(flag!.message).toMatch(/a tax professional/);
    // Still no arithmetic or dollar figure.
    expect(flag!.message).not.toMatch(/\$\d/);
  });

  it("not-stated copy in saved mode does not claim the record type was left alone", () => {
    const flag = receiptFlags(reading({ noGoodsOrServicesStated: null, benefitStatement: null }), { mode: "saved" }).find(
      (x) => x.code === "receipt_goods_services_not_stated"
    );
    expect(flag!.message).not.toMatch(/No record yet/);
    expect(flag!.message).toMatch(/complete acknowledgment/);
  });

  it("computes no reduced or deductible amount: a receipt with cash 25000 and benefit '$40' never produces 210", () => {
    const all = receiptFlags(
      reading({ cashAmountCents: 25000, noGoodsOrServicesStated: false, benefitStatement: "Dinner valued at $40" }),
      { mode: "prefill" }
    );
    for (const f of all) {
      expect(f.message).not.toContain("210");
      expect(f.message).not.toContain("$210");
      expect(f.message).not.toContain("21000");
    }
    // The only number that can appear is the receipt's own quoted benefit text.
    expect(all.map((f) => f.message).join(" ").match(/\d+/g)?.sort()).toEqual(["40"]);
  });

  it("quotes at most 200 characters of the benefit text", () => {
    const f = receiptFlags(reading({ noGoodsOrServicesStated: false, benefitStatement: "x".repeat(450) }));
    expect(f[0]!.message).toContain("x".repeat(200));
    expect(f[0]!.message).not.toContain("x".repeat(201));
  });
});

describe("receiptFlags - other advisory flags", () => {
  const codes = (r: DonationReceiptReading, mode?: "prefill" | "saved") => receiptFlags(r, { mode }).map((f) => f.code);

  it("not-an-acknowledgment, multiple gifts, cash+noncash and non-cash-value-needed", () => {
    expect(codes(reading({ readsAsWrittenAcknowledgment: false }))).toContain("receipt_not_acknowledgment");
    expect(codes(reading({ coversMultipleGifts: true, giftDate: null, cashAmountCents: null }))).toContain(
      "receipt_multiple_gifts"
    );
    expect(codes(reading({ nonCashDescription: "Coats" }))).toContain("receipt_cash_and_noncash");
    expect(codes(reading({ cashAmountCents: null, nonCashDescription: "Coats" }))).toContain(
      "receipt_noncash_value_needed"
    );
  });

  it("saved mode keeps only the flags that are still true of a saved gift", () => {
    const r = reading({
      noGoodsOrServicesStated: false,
      benefitStatement: "Dinner",
      readsAsWrittenAcknowledgment: false,
      coversMultipleGifts: true,
      nonCashDescription: "Coats",
    });
    const saved = codes(r, "saved");
    expect(saved).toEqual(["receipt_goods_services", "receipt_not_acknowledgment"]);
    expect(codes(r, "prefill")).toEqual(
      expect.arrayContaining(["receipt_multiple_gifts", "receipt_cash_and_noncash"])
    );
  });
});

describe("buildReceiptGiftView (reads only through resolveTaxDocForCompute)", () => {
  const AI = {
    docType: "donation_receipt",
    schemaVersion: 2,
    summary: "Receipt",
    data: {
      organizationName: "Connecticut Food Bank",
      organizationEIN: null,
      giftDate: "2025-06-15",
      cashAmountCents: 25000,
      nonCashDescription: null,
      coversMultipleGifts: false,
      readsAsWrittenAcknowledgment: true,
      noGoodsOrServicesStated: true,
      benefitStatement: null,
    },
  };
  const corr = (fields: Record<string, unknown>) => ({
    version: 1,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, aiValue: null, correctedAt: "2026-10-03T00:00:00Z", correctedById: "u" }])
    ),
    events: [],
  });
  const row = (over: Partial<ReceiptDocRow> = {}): ReceiptDocRow => ({
    id: "doc-1",
    documentName: "Donation Receipt - Food Bank (2025)",
    docType: "donation_receipt",
    taxYear: 2025,
    entityId: PERSONAL,
    extractionStatus: "complete",
    extractionData: AI,
    extractionCorrections: null,
    extractionConfirmedAt: null,
    ...over,
  });
  const ctx = { personalEntityId: PERSONAL, linkedGifts: [] };

  it("ready: prefill from the AI reading, labelled unverified, with a summary", () => {
    const v = buildReceiptGiftView(row(), ctx);
    expect(v.state).toBe("ready");
    expect(v.verified).toBe(false);
    expect(v.prefill).toMatchObject({ amount: "250.00", date: "2025-06-15", substantiation: "written_acknowledgment" });
    expect(v.summary).toBe("Connecticut Food Bank - Jun 15, 2025 - $250.00");
  });

  it("verified: labelled verified", () => {
    const v = buildReceiptGiftView(row({ extractionConfirmedAt: new Date() }), ctx);
    expect(v.verified).toBe(true);
  });

  it("corrections win over the AI value, and a corrected null clears it", () => {
    const v = buildReceiptGiftView(
      row({ extractionCorrections: corr({ cashAmountCents: 30000, giftDate: null, organizationName: "Food Bank Inc." }) }),
      ctx
    );
    expect(v.prefill.amount).toBe("300.00");
    expect(v.prefill.date).toBe("");
    expect(v.prefill.recipient).toBe("Food Bank Inc.");
    expect(v.correctionCount).toBe(3);
  });

  it("verified_only policy withholds an unverified reading (empty prefill) but not a verified one", () => {
    const withheld = buildReceiptGiftView(row(), ctx, "verified_only");
    expect(withheld.state).toBe("withheld_by_policy");
    expect(withheld.prefill.amount).toBe("");
    expect(withheld.prefill.recipient).toBe("");
    expect(buildReceiptGiftView(row({ extractionConfirmedAt: new Date() }), ctx, "verified_only").state).toBe("ready");
  });

  describe("acknowledgment evidence when the letter is silent on goods or services", () => {
    const SILENT = {
      ...AI,
      data: { ...AI.data, noGoodsOrServicesStated: null, benefitStatement: null },
    };

    it("silent AI reading -> evidence 'none' plus the not-stated flag", () => {
      const v = buildReceiptGiftView(row({ extractionData: SILENT }), ctx);
      expect(v.state).toBe("ready");
      expect(v.prefill.substantiation).toBe("none");
      expect(v.flags.map((f) => f.code)).toContain("receipt_goods_services_not_stated");
    });

    it("an owner correction that fills the silent field flips the prefill to written_acknowledgment", () => {
      const v = buildReceiptGiftView(
        row({ extractionData: SILENT, extractionCorrections: corr({ noGoodsOrServicesStated: true }) }),
        ctx
      );
      expect(v.prefill.substantiation).toBe("written_acknowledgment");
      expect(v.flags.map((f) => f.code)).not.toContain("receipt_goods_services_not_stated");
    });

    it("a corrected benefit text also flips it; correcting the answer back to null flips it to none", () => {
      expect(
        buildReceiptGiftView(
          row({ extractionData: SILENT, extractionCorrections: corr({ benefitStatement: "Dinner for two" }) }),
          ctx
        ).prefill.substantiation
      ).toBe("written_acknowledgment");
      expect(
        buildReceiptGiftView(row({ extractionCorrections: corr({ noGoodsOrServicesStated: null }) }), ctx).prefill
          .substantiation
      ).toBe("none");
    });

    it("verified_only still withholds an unverified silent or complete reading; a verified one follows the rule", () => {
      expect(buildReceiptGiftView(row(), ctx, "verified_only").prefill.substantiation).toBe("none");
      expect(buildReceiptGiftView(row({ extractionData: SILENT }), ctx, "verified_only").state).toBe(
        "withheld_by_policy"
      );
      const verifiedComplete = buildReceiptGiftView(row({ extractionConfirmedAt: new Date() }), ctx, "verified_only");
      expect(verifiedComplete.prefill.substantiation).toBe("written_acknowledgment");
      const verifiedSilent = buildReceiptGiftView(
        row({ extractionData: SILENT, extractionConfirmedAt: new Date() }),
        ctx,
        "verified_only"
      );
      expect(verifiedSilent.state).toBe("ready");
      expect(verifiedSilent.prefill.substantiation).toBe("none");
    });
  });

  it("not extracted / unusable reading -> not_extracted with an empty prefill", () => {
    for (const over of [
      { extractionStatus: null, extractionData: null },
      { extractionStatus: "failed", extractionData: null },
      { extractionData: { docType: "donation_receipt", summary: "x", data: {} } },
      { extractionData: { docType: "w2", summary: "x", data: { taxYear: 2025, wagesCents: 5 } } },
    ]) {
      const v = buildReceiptGiftView(row(over), ctx);
      expect(v.state).toBe("not_extracted");
      expect(v.prefill.recipient).toBe("");
      expect(v.flags).toEqual([]);
    }
  });

  it("a receipt filed under another bucket is not_personal (no prefill)", () => {
    const v = buildReceiptGiftView(row({ entityId: BUSINESS }), ctx);
    expect(v.state).toBe("not_personal");
    expect(v.prefill.recipient).toBe("");
    expect(buildReceiptGiftView(row(), { personalEntityId: null, linkedGifts: [] }).state).toBe("not_personal");
  });

  it("carries the linked gifts through and a placeholder name when the document has none", () => {
    const gift = { id: "g1", dateIso: "2025-06-15", dateLabel: "Jun 15, 2025", recipient: "Food Bank", amountCents: 25000, year: 2025 };
    const v = buildReceiptGiftView(row({ documentName: null }), { personalEntityId: PERSONAL, linkedGifts: [gift] });
    expect(v.linkedGifts).toEqual([gift]);
    expect(v.name).toBe("Donation receipt");
  });

  it("source check: the loader and the view never create a donation or read raw extractionData for values", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const f of ["lib/donation-receipt.ts", "lib/donation-receipts-build.ts"]) {
      const src = readFileSync(resolve(__dirname, "../../", f), "utf8");
      expect(src, f).not.toMatch(/createDonation|donation\.create|\.update\(|\.updateMany\(|\.delete/);
      expect(src, f).not.toMatch(/:\s*any\b|as any\b/);
    }
  });
});
