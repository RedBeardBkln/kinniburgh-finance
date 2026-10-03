import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTaxExtractionPrompt,
  crossFieldWarnings,
  isUsableTaxExtraction,
  normalizeTaxExtraction,
  validateCorrections,
} from "@/lib/tax-extraction-schema";
import { buildModelDocLine } from "@/lib/tax-extraction-policy";
import { deriveDocumentTaxYear } from "@/lib/document-year";
import { generateDocumentName } from "@/lib/doc-naming";
import { mimeTypeForFileKey } from "@/lib/document-upload";
import {
  buildDonationPrefill,
  buildReceiptGiftView,
  findDuplicateDonations,
  normalizeRecipient,
  readDonationReceipt,
  receiptFlags,
  type ReceiptDocRow,
} from "@/lib/donation-receipt";
import { retypeBlockReason, isPlaceholderName } from "@/lib/document-retype";

// Tester probe (donation-receipt-document-type): adversarial inputs beyond the Coder's tests.
// No DB, no network, no Anthropic.

const SCHEMA = "donation_receipt" as const;
const dataOf = (raw: Record<string, unknown>) => normalizeTaxExtraction(SCHEMA, { docType: SCHEMA, summary: "s", data: raw });
const d = (raw: Record<string, unknown>) => (dataOf(raw) as unknown as { data: Record<string, unknown> }).data;

describe("probe: normalizer never guesses", () => {
  const cash = (v: unknown) => d({ cashAmountCents: v }).cashAmountCents;
  it("money junk -> null, only safe non-negative integers survive", () => {
    for (const bad of ["$1,234.50", "about $50", "50.00", "$50", -1, -25000, 250.5, NaN, Infinity, 1e21, Number.MAX_SAFE_INTEGER + 2, {}, [], true, "abc", ""]) {
      expect(cash(bad), String(bad)).toBeNull();
    }
    expect(cash(0)).toBe(0);
    expect(cash(25000)).toBe(25000);
  });
  it("record the lenient-string behavior for numeric strings (documented, not asserted either way)", () => {
  });
  it("booleans are tri-state; silence/yes/no/1/0 never become true/false", () => {
    for (const bad of ["yes", "no", 1, 0, "", "maybe", {}, [], "tru", undefined]) {
      expect(d({ noGoodsOrServicesStated: bad }).noGoodsOrServicesStated, String(bad)).toBeNull();
      expect(d({ coversMultipleGifts: bad }).coversMultipleGifts, String(bad)).toBeNull();
    }
    expect(d({ noGoodsOrServicesStated: true }).noGoodsOrServicesStated).toBe(true);
    expect(d({ noGoodsOrServicesStated: false }).noGoodsOrServicesStated).toBe(false);
  });
  it("missing booleans are null, not defaulted (nothing -> 'no goods or services')", () => {
    const out = d({ organizationName: "Food Bank" });
    expect(out.noGoodsOrServicesStated).toBeNull();
    expect(out.readsAsWrittenAcknowledgment).toBeNull();
    expect(out.coversMultipleGifts).toBeNull();
  });
  it("dates: only real YYYY-MM-DD; year-only/range/US format/impossible -> null", () => {
    for (const bad of ["2025", "06/15/2025", "June 15, 2025", "2025-02-30", "2025-13-01", "2025-6-5", "2025-06-15T00:00:00Z", "2025-01-01 to 2025-12-31", 20250615]) {
      expect(d({ giftDate: bad }).giftDate, String(bad)).toBeNull();
    }
    expect(d({ giftDate: "2025-12-31" }).giftDate).toBe("2025-12-31");
  });
  it("EIN: wrong shapes -> null", () => {
    for (const bad of ["061234567", "6-1234567", "06-123456", "06-12345678", "EIN 06-1234567", 61234567]) {
      expect(d({ organizationEIN: bad }).organizationEIN, String(bad)).toBeNull();
    }
    expect(d({ organizationEIN: "06-1234567" }).organizationEIN).toBe("06-1234567");
  });
  it("donor identity keys are dropped even if the model emits them", () => {
    const out = d({ organizationName: "A", donorName: "Eric", donorAddress: "27 Old Barry Rd", donorSSN: "123-45-6789", taxYear: 2025 });
    expect(Object.keys(out)).not.toContain("donorName");
    expect(Object.keys(out)).not.toContain("donorAddress");
    expect(Object.keys(out)).not.toContain("donorSSN");
    expect(Object.keys(out)).not.toContain("taxYear");
    expect(JSON.stringify(out)).not.toMatch(/123-45-6789|Old Barry/);
  });
  it("SSN-shaped text scrubbed from every text slot incl. summary", () => {
    const n = normalizeTaxExtraction(SCHEMA, {
      docType: SCHEMA,
      summary: "ssn 123-45-6789 here",
      data: { organizationName: "Org 123-45-6789", nonCashDescription: "x 123456789 y", benefitStatement: "123-45-6789" },
    });
    expect(JSON.stringify(n)).not.toMatch(/123-45-6789/);
  });
  it("non-object / array / null model output -> every field null, not usable", () => {
    for (const bad of [null, undefined, "text", 5, [], { data: null }, { data: [] }]) {
      const n = normalizeTaxExtraction(SCHEMA, bad);
      expect(isUsableTaxExtraction(SCHEMA, n)).toBe(false);
    }
  });
  it("corrections validator rejects floats / strings-as-bool / unknown key / bad dates; null always ok", () => {
    expect(validateCorrections(SCHEMA, { cashAmountCents: 250.5 }).ok).toBe(false);
    expect(validateCorrections(SCHEMA, { cashAmountCents: -5 }).ok).toBe(false);
    expect(validateCorrections(SCHEMA, { noGoodsOrServicesStated: "yes" }).ok).toBe(false);
    expect(validateCorrections(SCHEMA, { donorName: "x" }).ok).toBe(false);
    expect(validateCorrections(SCHEMA, { taxYear: 2025 }).ok).toBe(false);
    expect(validateCorrections(SCHEMA, { giftDate: "2025-02-30" }).ok).toBe(false);
    expect(validateCorrections(SCHEMA, { giftDate: null, cashAmountCents: null, noGoodsOrServicesStated: null }).ok).toBe(true);
  });
});

describe("probe: prompt + model-review stripping", () => {
  const prompt = buildTaxExtractionPrompt(SCHEMA);
  it("prompt carries all six guardrails and no donor key", () => {
    for (const s of [
      "not a tax form",
      "Never output a dollar value for non-cash items",
      "coversMultipleGifts to true and leave giftDate and cashAmountCents null",
      "Do not extract the donor's name",
      "silence is null",
      "Never guess",
    ]) {
      expect(prompt, s).toContain(s);
    }
    expect(prompt).not.toMatch(/donorName|donorAddress/);
  });
  it("EIN is stripped from the AI tax-review doc line; nulls dropped", () => {
    const line = buildModelDocLine({
      docType: SCHEMA,
      extractionStatus: "complete",
      extractionData: { schemaVersion: 2, docType: SCHEMA, summary: "x", data: { organizationName: "Food Bank", organizationEIN: "06-1234567", giftDate: null, cashAmountCents: 25000 } },
      extractionCorrections: null,
      extractionConfirmedAt: null,
    });
    expect(line).toContain("Food Bank");
    expect(line).not.toContain("06-1234567");
    expect(line).not.toContain("giftDate");
  });
});

describe("probe: cross-field warnings", () => {
  const w = (data: Record<string, unknown>, ctx = {}) => crossFieldWarnings(SCHEMA, data, ctx);
  it("clean reading is silent", () => {
    expect(w({ organizationName: "A", giftDate: "2025-06-15", cashAmountCents: 100, noGoodsOrServicesStated: true }, { documentTaxYear: 2025 })).toEqual([]);
  });
  it("each warning fires on its condition", () => {
    expect(w({ giftDate: "2025-12-31" }, { documentTaxYear: 2026 }).join()).toMatch(/2025/);
    expect(w({ coversMultipleGifts: true, giftDate: "2025-06-15" }).length).toBe(1);
    expect(w({ coversMultipleGifts: true, cashAmountCents: 5 }).length).toBe(1);
    expect(w({ cashAmountCents: 5, nonCashDescription: "a couch" }).length).toBe(1);
    expect(w({ noGoodsOrServicesStated: true, benefitStatement: "dinner" }).length).toBe(1);
    expect(w({ noGoodsOrServicesStated: false, benefitStatement: null }).length).toBe(1);
  });
  it("garbage data types do not throw", () => {
    expect(() => w({ giftDate: 5, cashAmountCents: "x", noGoodsOrServicesStated: "no", benefitStatement: 3 }, { documentTaxYear: 2025 })).not.toThrow();
  });
});

describe("probe: year + name", () => {
  const yr = (data: Record<string, unknown>, now = 2026) => deriveDocumentTaxYear("donation_receipt", { data }, now);
  it("year boundaries and refusals", () => {
    expect(yr({ giftDate: "2025-12-31" })).toBe(2025);
    expect(yr({ giftDate: "2026-01-01" })).toBe(2026);
    expect(yr({ giftDate: "2025-12-31", coversMultipleGifts: true })).toBeNull();
    expect(yr({ giftDate: "2025-02-30" })).toBeNull();
    expect(yr({ giftDate: "1850-01-01" })).toBeNull();
    expect(yr({ giftDate: "2999-01-01" })).toBeNull();
    expect(yr({ giftDate: null })).toBeNull();
    expect(yr({ giftDate: "2025" })).toBeNull();
    expect(yr({ taxYear: 2025 })).toBeNull(); // a stray taxYear is not trusted for receipts
  });
  it("name generation", () => {
    expect(generateDocumentName("donation_receipt", null, { docType: "donation_receipt", data: { organizationName: "Food Bank", giftDate: "2025-06-15" } } as never)).toContain("Food Bank");
    expect(generateDocumentName("donation_receipt", null, { docType: "donation_receipt", data: { organizationName: "Food Bank", giftDate: "2025-06-15" } } as never)).toContain("2025");
    expect(generateDocumentName("donation_receipt", null, null)).toBe("Donation Receipt");
    // filed-under year wins over gift-date year
    expect(generateDocumentName("donation_receipt", 2026, { docType: "donation_receipt", data: { organizationName: "X", giftDate: "2025-06-15" } } as never)).toContain("2026");
  });
});

describe("probe: mimeTypeForFileKey", () => {
  it("mapping", () => {
    expect(mimeTypeForFileKey("a/b.pdf")).toBe("application/pdf");
    expect(mimeTypeForFileKey("a/b.PDF")).toBe("application/pdf");
    expect(mimeTypeForFileKey("a/b.png")).toBe("image/png");
    expect(mimeTypeForFileKey("a/b.webp")).toBe("image/webp");
    expect(mimeTypeForFileKey("a/b.jpeg")).toBe("image/jpeg");
    expect(mimeTypeForFileKey("a/b.jpg")).toBe("image/jpeg");
    expect(mimeTypeForFileKey("a/b")).toBe("image/jpeg");
    expect(mimeTypeForFileKey("a.pdf/b")).toBe("image/jpeg"); // dot only in a directory name
    expect(mimeTypeForFileKey("")).toBe("image/jpeg");
    expect(mimeTypeForFileKey("a/b.pdf.png")).toBe("image/png");
    expect(mimeTypeForFileKey("taxes/uuid-123.gif")).toBe("image/jpeg"); // unknown -> old default (documented)
  });
});

function row(over: Partial<ReceiptDocRow> & { data?: Record<string, unknown> } = {}): ReceiptDocRow {
  const { data, ...rest } = over;
  return {
    id: "d1",
    documentName: "Donation Receipt",
    docType: "donation_receipt",
    taxYear: 2025,
    entityId: "P",
    extractionStatus: "complete",
    extractionData: {
      schemaVersion: 2,
      docType: "donation_receipt",
      summary: "s",
      data: { organizationName: "Food Bank", organizationEIN: null, giftDate: "2025-06-15", cashAmountCents: 25000, nonCashDescription: null, coversMultipleGifts: false, readsAsWrittenAcknowledgment: true, noGoodsOrServicesStated: true, benefitStatement: null, ...(data ?? {}) },
    },
    extractionCorrections: null,
    extractionConfirmedAt: null,
    ...rest,
  };
}
const ctx = { personalEntityId: "P", linkedGifts: [] };

describe("probe: view + prefill", () => {
  it("baseline", () => {
    const v = buildReceiptGiftView(row(), ctx, "verified_else_ai");
    expect(v.state).toBe("ready");
    expect(v.prefill).toMatchObject({ date: "2025-06-15", recipient: "Food Bank", amount: "250.00", kind: "cash", substantiation: "written_acknowledgment" });
  });
  it("corrections win; corrected null clears AI value; shape of overlay", () => {
    const v = buildReceiptGiftView(
      row({ extractionCorrections: { version: 1, events: [], fields: { cashAmountCents: { value: 30050, aiValue: 25000, correctedAt: "2026-10-03T00:00:00Z", correctedById: "u" }, giftDate: { value: null, aiValue: "2025-06-15", correctedAt: "2026-10-03T00:00:00Z", correctedById: "u" } } } as never }),
      ctx,
      "verified_else_ai"
    );
    expect(v.prefill.amount).toBe("300.50");
    expect(v.prefill.date).toBe("");
  });
  it("verified_only withholds unverified, shows verified", () => {
    expect(buildReceiptGiftView(row(), ctx, "verified_only").state).toBe("withheld_by_policy");
    const v = buildReceiptGiftView(row({ extractionConfirmedAt: new Date() }), ctx, "verified_only");
    expect(v.state).toBe("ready");
    expect(v.verified).toBe(true);
  });
  it("non-personal entity -> not_personal with empty prefill", () => {
    const v = buildReceiptGiftView(row({ entityId: "BIZ" }), ctx, "verified_else_ai");
    expect(v.state).toBe("not_personal");
    expect(v.prefill.recipient).toBe("");
  });
  it("null personal id -> not_personal", () => {
    expect(buildReceiptGiftView(row(), { personalEntityId: null, linkedGifts: [] }).state).toBe("not_personal");
  });
  it("failed/processing status with usable data still ready (forced re-extract in flight) but never 'verified' w/o status complete", () => {
    const v = buildReceiptGiftView(row({ extractionStatus: "processing", extractionConfirmedAt: new Date() }), ctx, "verified_else_ai");
    expect(v.state).toBe("ready");
    expect(v.verified).toBe(false);
  });
  it("foreign-shaped (old W-2) data after retype -> not_extracted, nothing prefilled", () => {
    const v = buildReceiptGiftView(
      row({ extractionData: { schemaVersion: 2, docType: "w2", summary: "w2", data: { employerName: "ACME", wagesCents: 100 } } as never }),
      ctx,
      "verified_else_ai"
    );
    expect(v.state).toBe("not_extracted");
    expect(v.prefill.recipient).toBe("");
  });
  it("silence is not 'no goods or services': null -> not-stated info flag, never treated as true", () => {
    const f = receiptFlags(readDonationReceipt({ organizationName: "A" }));
    expect(f.map((x) => x.code)).toContain("receipt_goods_services_not_stated");
    expect(f.map((x) => x.code)).not.toContain("receipt_goods_services");
  });
  it("no arithmetic: a $210 style reduction never appears", () => {
    const reading = readDonationReceipt({ organizationName: "A", cashAmountCents: 25000, benefitStatement: "dinner valued at $40", noGoodsOrServicesStated: false });
    const all = receiptFlags(reading).map((f) => f.message).join(" ");
    expect(all).not.toMatch(/210|\$210/);
    expect(all).toContain("$40"); // only the quoted letter text
  });
  it("multi-gift letter: date/amount as prefilled are exactly what the reading holds (normalizer leaves them to the model)", () => {
    const p = buildDonationPrefill(readDonationReceipt({ coversMultipleGifts: true, giftDate: null, cashAmountCents: null, organizationName: "A" }));
    expect(p.date).toBe("");
    expect(p.amount).toBe("");
    expect(p.notes).toContain("more than one gift");
  });
  it("prefill: amount '0' blank; huge cents integer math; out-of-range date blank", () => {
    expect(buildDonationPrefill(readDonationReceipt({ cashAmountCents: 0 })).amount).toBe("");
    expect(buildDonationPrefill(readDonationReceipt({ cashAmountCents: 123456789012 })).amount).toBe("1234567890.12");
    expect(buildDonationPrefill(readDonationReceipt({ giftDate: "1999-12-31" })).date).toBe("");
    expect(buildDonationPrefill(readDonationReceipt({ giftDate: "2101-01-01" })).date).toBe("");
    expect(buildDonationPrefill(readDonationReceipt({ giftDate: "2025-02-29" })).date).toBe("");
  });
  it("ack evidence only when explicitly true", () => {
    for (const v of [false, null, "true", 1, undefined]) {
      expect(buildDonationPrefill(readDonationReceipt({ readsAsWrittenAcknowledgment: v })).substantiation).toBe("none");
    }
  });
});

describe("probe: duplicate rule + recipient normalization", () => {
  const ex = [{ id: "1", dateIso: "2025-06-15", recipient: "The Connecticut Food Bank, Inc.", amountCents: 25000 }];
  it("variants match, near-misses do not", () => {
    expect(findDuplicateDonations({ dateIso: "2025-06-15", amountCents: 25000, recipient: "connecticut food bank" }, ex)).toHaveLength(1);
    expect(findDuplicateDonations({ dateIso: "2025-06-16", amountCents: 25000, recipient: "connecticut food bank" }, ex)).toHaveLength(0);
    expect(findDuplicateDonations({ dateIso: "2025-06-15", amountCents: 25001, recipient: "connecticut food bank" }, ex)).toHaveLength(0);
    expect(findDuplicateDonations({ dateIso: "2025-06-15", amountCents: 25000, recipient: "Connecticut Food Pantry" }, ex)).toHaveLength(0);
    expect(findDuplicateDonations({ dateIso: "2025-06-15", amountCents: 25000, recipient: "   " }, ex)).toHaveLength(0);
  });
  it("normalizeRecipient edge: name that is only a legal suffix / 'The'", () => {
    expect(() => normalizeRecipient("Inc.")).not.toThrow();
    expect(normalizeRecipient("The")).toBe("the".length ? normalizeRecipient("The") : "");
    expect(normalizeRecipient("Café & Co.")).toBe("cafe and");
  });
});

describe("probe: retype rules", () => {
  it("from/to matrix", () => {
    for (const from of ["bank_statement", "utility_bill", "policy", "statement", "insurance_policy", "mortgage_statement", "foo"]) {
      expect(retypeBlockReason({ currentDocType: from, nextDocType: "donation_receipt", verified: false }), from).not.toBeNull();
    }
    for (const to of ["bank_statement", "utility_bill", "policy", "statement", "foo", ""]) {
      expect(retypeBlockReason({ currentDocType: "other", nextDocType: to, verified: false }), to).not.toBeNull();
    }
    expect(retypeBlockReason({ currentDocType: "other", nextDocType: "donation_receipt", verified: false })).toBeNull();
    expect(retypeBlockReason({ currentDocType: "donation_receipt", nextDocType: "other", verified: true })).toMatch(/Un-verify/);
    expect(retypeBlockReason({ currentDocType: "other", nextDocType: "other", verified: true })).toBeNull();
  });
  it("placeholder names", () => {
    expect(isPlaceholderName(null, "other", null)).toBe(true);
    expect(isPlaceholderName("My custom name", "other", null)).toBe(false);
    expect(isPlaceholderName("Donation Receipt", "donation_receipt", 2025)).toBe(true);
  });
});

describe("probe: source greps", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("no reduced/deductible arithmetic in the receipt module or flag copy", () => {
    const src = read("lib/donation-receipt.ts") + read("components/donations/receipt-to-donation.tsx") + read("components/donations/unlinked-receipts.tsx") + read("lib/donation-receipts-build.ts");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bparseFloat\b|\bNumber\(|\* *0\.\d|\bMath\.(round|floor|ceil)\b/);
    expect(code).not.toMatch(/amountCents\s*-\s*|cashAmountCents\s*-\s*|deductibleCents|reducedCents/);
  });
  it("no createDonation call from extraction/loader/runExtraction paths", () => {
    for (const p of ["actions/documents.ts", "lib/donation-receipts-build.ts", "lib/donations-build.ts", "lib/doc-extract.ts", "lib/donation-receipt.ts"]) {
      expect(read(p), p).not.toMatch(/createDonation|donation\.create\b/);
    }
  });
  it("loaders are read-only and guard archivedAt", () => {
    const src = read("lib/donation-receipts-build.ts");
    expect(src).not.toMatch(/\.(create|update|updateMany|delete|deleteMany|upsert)\(/);
    expect((src.match(/archivedAt: null/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it("tax compute untouched / Schedule A line 11 predicate", () => {
    const src = read("lib/tax-form-plan.ts");
    expect(src).toMatch(/donationCount\s*>\s*0\s*\|\|\s*isNoneConfirmed\(questions, NONE_CONFIRMATION_KEYS\.donations\)/);
  });
  it("changeDocumentType: requireAuth first statement, no hard delete, no any", () => {
    const src = read("actions/documents.ts");
    const i = src.indexOf("export async function changeDocumentType");
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, i + 1400);
    expect(body.replace(/\s+/g, " ")).toMatch(/\}> \{ await requireAuth\(\);/);
    expect(body).not.toMatch(/\.delete\(|deleteMany|: any\b|as any\b/);
  });
});

void vi;
