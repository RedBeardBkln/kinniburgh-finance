// Fixtures for the Schedule D / Form 8949 PDF tests. Two sources of broker sales:
//   - realRobinhoodSales(): the REAL-shaped Robinhood consolidated 1099 summary (short box A with a $5.99 wash sale,
//     long box D with basis reported and no adjustment) pushed through the capture side's own resolvers
//     (normalizeTaxExtraction -> resolveTaxDocForCompute -> resolveFacts), exactly as the engine's end-to-end test does;
//   - salesFacts(rows): hand-made brokerSales rows for the other boxes / many brokers.
// Both are grafted on the synthetic household of tax2025-fixtures (`fullFacts`).

import type { BrokerBox, BrokerSaleFact, Ty2025Facts } from "@/lib/tax2025/facts";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { normalizeTaxExtraction } from "@/lib/tax-extraction-schema";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { Ref, Sourced, Ty2025Return } from "@/lib/tax2025/types";
import { ROBINHOOD_2025_RAW } from "../broker-summary-fixtures";
import { ERIC_ID, EVA_ID, fullFacts, owner } from "../tax2025-fixtures";

export const VIEW_OPTS = { generatedAt: "2026-10-04T16:00:00.000Z", generatedBy: "Test User" } as const;

/** The Robinhood document's brokerSales as the capture side's resolver builds them. */
export function realRobinhoodSales(): { sales: BrokerSaleFact[]; otherIncomeBoxes: Ty2025Facts["income"]["otherIncomeBoxes"] } {
  const stored = normalizeTaxExtraction("1099", {
    ...ROBINHOOD_2025_RAW,
    data: {
      ...ROBINHOOD_2025_RAW.data,
      div_box1aCents: 238,
      div_box1bCents: 200,
      div_box2aCents: 0,
      int_box1Cents: 120,
      otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2287399 }],
    },
  });
  const r = resolveTaxDocForCompute({ docType: "1099", extractionStatus: "complete", extractionData: stored, extractionCorrections: null, extractionConfirmedAt: new Date("2026-10-02T00:00:00Z") });
  const doc: RawDocument = { id: "rh", docType: "1099", taxYear: 2025, extractionStatus: r.extractionStatus, extractionData: r.extractionData, verified: r.verified, legacyFormat: r.legacyFormat, subjectType: "person", subjectUserId: ERIC_ID, documentName: null };
  const rawInputs: RawTy2025Inputs = {
    taxYear: 2025,
    people: [{ userId: ERIC_ID, name: "Eric" }, { userId: EVA_ID, name: "Eva" }],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name matches the entity name" },
    documents: [doc],
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
  const { facts } = resolveFacts(rawInputs);
  return { sales: facts.income.brokerSales, otherIncomeBoxes: facts.income.otherIncomeBoxes };
}

export interface SaleRow {
  box: BrokerBox;
  proceedsCents: number;
  costCents: number | null;
  washSaleCents?: number;
  /** Broker name (one document per broker). Default Robinhood. */
  payer?: string;
  form?: "1099-B" | "1099-DA";
}

export interface SalesOpts {
  carryoverShort?: Sourced<number>;
  carryoverLong?: Sourced<number>;
  /** The owner's "anything the broker could not know" answer in the rule's terms: true = nothing (stored inverted). */
  noBrokerAdjustments?: boolean;
  /** capital_special_rates statement: true (default) = none, false = the owner said yes, "unstated" = not stated / not sure. */
  specialRatesNone?: boolean | "unstated";
}

/** brokerSales built by hand (one document per distinct payer) on the golden household with the owner's answers given. */
export function salesFacts(rows: readonly SaleRow[], o: SalesOpts = {}): Ty2025Facts {
  const f = fullFacts();
  const byPayer = new Map<string, SaleRow[]>();
  for (const r of rows) byPayer.set(r.payer ?? "Robinhood Markets, Inc.", [...(byPayer.get(r.payer ?? "Robinhood Markets, Inc.") ?? []), r]);
  f.income.brokerSales = [...byPayer.entries()].map(([payer, rs], i): BrokerSaleFact => {
    const refs: Ref[] = [{ kind: "document", id: `doc-${i}`, label: "1099" }];
    return {
      docId: `doc-${i}`,
      payer,
      basis: "doc_verified",
      legacyFormat: false,
      refs,
      summaryRead: true,
      signalled1099B: true,
      rows: rs.map((r) => ({
        form: r.form ?? "1099-B",
        box: r.box,
        proceedsCents: r.proceedsCents,
        costCents: r.costCents,
        accruedMarketDiscountCents: 0,
        washSaleLossDisallowedCents: r.washSaleCents ?? 0,
        gainLossCents: null,
      })),
      sec1256AggregateCents: 0,
      forms1099DaPresent: rs.some((r) => r.form === "1099-DA"),
    };
  });
  f.returnAnswers.capitalGains = {
    carryoverShortCents: o.carryoverShort ?? owner(0),
    carryoverLongCents: o.carryoverLong ?? owner(0),
    salesComplete: owner(true),
    brokerAdjustments: owner(o.noBrokerAdjustments === false),
  };
  if (o.specialRatesNone === "unstated") delete f.statedNone.capital_special_rates;
  else f.statedNone.capital_special_rates = owner(o.specialRatesNone ?? true);
  f.statedNone.capital_gain_other = owner(true);
  return f;
}

/** The household facts with the real Robinhood sales and the owner's answers (cgco None, cgall Yes, cgadj No, both groups none). */
export function realFacts(): Ty2025Facts {
  const { sales, otherIncomeBoxes } = realRobinhoodSales();
  const f = fullFacts();
  f.income.brokerSales = sales;
  f.income.otherIncomeBoxes = otherIncomeBoxes;
  f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
  return f;
}

export function build(facts: Ty2025Facts): { facts: Ty2025Facts; ret: Ty2025Return; view: PdfReturnView } {
  const ret = computeTy2025Return(facts);
  return { facts, ret, view: toPdfReturnView(ret, facts, VIEW_OPTS) };
}
