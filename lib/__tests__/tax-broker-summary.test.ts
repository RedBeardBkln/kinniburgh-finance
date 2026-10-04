import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareSnapshots,
  offersSummaryReread,
  readBrokerSummary,
  snapshotNonIdentifying1099,
} from "@/lib/tax-broker-summary";
import { normalizeTaxExtraction } from "@/lib/tax-extraction-schema";
import { ROBINHOOD_2025_RAW } from "@/lib/__tests__/broker-summary-fixtures";

const robinhood = normalizeTaxExtraction("1099", ROBINHOOD_2025_RAW).data;

describe("readBrokerSummary: the three states", () => {
  it("summary read: bSummary is a list (rows typed, cents kept)", () => {
    const r = readBrokerSummary(robinhood);
    expect(r.summaryRead).toBe(true);
    expect(r.signalled1099B).toBe(true); // variantsPresent has 1099-B
    expect(r.forms1099DaPresent).toBe(false);
    expect(r.sec1256AggregateCents).toBe(0);
    expect(r.rows.map((x) => [x.form, x.box, x.proceedsCents, x.costCents, x.washSaleLossDisallowedCents])).toEqual([
      ["1099-B", "A", 587231, 528550, 599],
      ["1099-B", "D", 1700168, 1203728, 0],
    ]);
  });

  it("signalled but unread: an older read that mentions a 1099-B (variantsPresent, formVariant or an otherBoxes entry) with bSummary null", () => {
    for (const data of [
      { variantsPresent: ["1099-DIV", "1099-B"], bSummary: null },
      { formVariant: "1099-B" },
      { otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 1 }] },
    ]) {
      const r = readBrokerSummary(data);
      expect(r.summaryRead, JSON.stringify(data)).toBe(false);
      expect(r.signalled1099B, JSON.stringify(data)).toBe(true);
      expect(r.rows).toEqual([]);
    }
  });

  it("no sales: a 1099-INT with bSummary null is neither read nor signalled; [] is read and none", () => {
    const interestOnly = readBrokerSummary({ formVariant: "1099-INT", variantsPresent: ["1099-INT"], int_box1Cents: 112432 });
    expect(interestOnly).toMatchObject({ summaryRead: false, signalled1099B: false, forms1099DaPresent: false, sec1256AggregateCents: null });
    expect(readBrokerSummary({ bSummary: [] })).toMatchObject({ summaryRead: true, rows: [] });
  });

  it("a malformed row keeps its numbers but never a bad enum value; 1099-DA is detected from the rows too", () => {
    const r = readBrokerSummary({ bSummary: [{ form: "x", box: "Q", proceedsCents: 5 }, { form: "1099-DA", box: "H", proceedsCents: 9, costCents: null }] });
    expect(r.rows[0]).toMatchObject({ form: null, box: null, proceedsCents: 5 });
    expect(r.forms1099DaPresent).toBe(true);
  });

  it("tolerates garbage input without throwing", () => {
    for (const x of [null, undefined, "x", 5, [], { bSummary: "nope" }]) expect(() => readBrokerSummary(x)).not.toThrow();
  });
});

describe("offersSummaryReread", () => {
  it("is true while bSummary is null or absent, false once it is a list (even an empty one)", () => {
    expect(offersSummaryReread({ int_box1Cents: 1 })).toBe(true);
    expect(offersSummaryReread({ bSummary: null })).toBe(true);
    expect(offersSummaryReread({ bSummary: [] })).toBe(false);
    expect(offersSummaryReread(robinhood)).toBe(false);
    expect(offersSummaryReread(undefined)).toBe(true);
  });
});

describe("before / after snapshot of a re-read", () => {
  const oldRead = {
    formVariant: "consolidated",
    variantsPresent: ["1099-DIV", "1099-B"],
    payerName: "Robinhood Markets, Inc.",
    payerEIN: "46-4136152",
    int_box1Cents: 120,
    div_box1aCents: 238,
    federalWithheldCents: 0,
    stateLines: [{ stateCode: "CT", statePayerId: "99999", stateIncomeCents: 1, stateWithheldCents: 1 }],
    bSummary: null,
  };

  it("holds only the form types and money boxes: no name, EIN, state id or sales rows", () => {
    const snap = snapshotNonIdentifying1099(oldRead);
    const text = JSON.stringify(snap);
    expect(text).not.toContain("Robinhood");
    expect(text).not.toContain("46-4136152");
    expect(text).not.toContain("99999");
    expect(snap.find((r) => r.key === "int_box1Cents")?.text).toBe("$1.20");
    expect(snap.find((r) => r.key === "div_box1aCents")?.text).toBe("$2.38");
    expect(snap.find((r) => r.key === "federalWithheldCents")?.text).toBe("$0.00");
    expect(snap.find((r) => r.key === "nec_box1Cents")?.text).toBe("-");
    expect(snap.find((r) => r.key === "formVariant")?.text).toBe("consolidated");
    expect(snap.find((r) => r.key === "variantsPresent")?.text).toBe("1099-DIV, 1099-B");
    for (const k of ["bSummary", "sec1256AggregateCents", "bSummaryTotalProceedsCents", "payerName", "payerEIN"]) {
      expect(snap.some((r) => r.key === k), k).toBe(false);
    }
  });

  it("marks only the values that differ", () => {
    const before = snapshotNonIdentifying1099(oldRead);
    const after = snapshotNonIdentifying1099({ ...oldRead, div_box1aCents: 240, variantsPresent: ["1099-DIV", "1099-B"] });
    const cmp = compareSnapshots(before, after);
    expect(cmp.filter((r) => r.changed).map((r) => [r.key, r.before, r.after])).toEqual([["div_box1aCents", "$2.38", "$2.40"]]);
    expect(compareSnapshots(before, before).some((r) => r.changed)).toBe(false);
  });
});

describe("the re-read panel (source pins)", () => {
  const panel = readFileSync(resolve(__dirname, "../../components/documents/reread-sales-summary-panel.tsx"), "utf8");

  it("never uses a browser confirm box; the explanation is inline", () => {
    expect(panel).not.toMatch(/window\.confirm|\bconfirm\(/);
    expect(panel).toMatch(/What a re-read does/);
  });

  it("says that the verification is removed and must be redone, and that old values are shown before and after", () => {
    expect(panel).toMatch(/The verification will be removed/);
    expect(panel).toMatch(/confirm it again/);
    expect(panel).toMatch(/Before the re-read/);
    expect(panel).toMatch(/After the re-read/);
    expect(panel).toMatch(/Re-read this document with the new fields/);
  });

  it("calls the dedicated server action, not the generic one", () => {
    expect(panel).toMatch(/rereadDocumentWithSalesSummary\(\{ documentId \}\)/);
    expect(panel).not.toMatch(/runDocumentExtraction/);
  });
});
