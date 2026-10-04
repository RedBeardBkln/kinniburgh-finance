// Test harness for the L1 checks and the seeded-defects table (plan section 9.2). NOT a test file (no .test suffix).
//
// Builds the same context production builds (lib/tax-review/l1/assemble.ts): a computed return, its effective view, the review
// sheet and CSV, the DRAFT packet filled from the real blank IRS forms, and the raw source documents. Two household fixtures:
//   cleanScenario(): wages, Schedule C, interest, dividends, standard deduction: the "clean" return. It must raise NO finding of
//                    severity medium or higher.
//   richScenario():  an "Eric-shaped" return that exercises more forms: two W-2s per person, Schedule A (mortgage, property tax),
//                    Schedule B, Schedule D with Form 8949 summary rows, Form 8959. NIIT applies there, so Form 8960 is required (its PDF
//                    exists since the Schedule 1-A / Form 8960 merge, so the rich return raises no required-form blocker).
// Real return data (names, payers, amounts) is never committed: every name and amount here is synthetic.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrokerBox, Ty2025Facts } from "@/lib/tax2025/facts";
import { applyOverrides, decisionsFromOverrides, type OverrideRow } from "@/lib/tax2025/overrides";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { listFormIds } from "@/lib/tax2025/pdf/registry";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { assembleL1Context, type AssembleHooks } from "@/lib/tax-review/l1/assemble";
import { PDFDocument, PDFTextField, type PDFForm } from "pdf-lib";
import type { L1Context, L1Packet, L1PacketFile, LineLabelTable } from "@/lib/tax-review/l1/context";
import { runL1, type L1Result } from "@/lib/tax-review/l1/run-l1";
import { atLeast, type Finding } from "@/lib/tax-review/types";
import { ERIC_ID, EVA_ID, fullFacts1b, owner } from "./tax2025-fixtures";

export const GENERATED_AT = "2026-10-05T16:00:00.000Z";

export function formsDir(): string {
  return path.join(process.cwd(), "data", "forms", "2025");
}

export function loadCatalogs(): Record<string, FormCatalog> {
  const out: Record<string, FormCatalog> = {};
  for (const m of FORM_MAPS) out[m.formId] = JSON.parse(readFileSync(path.join(formsDir(), "catalog", `${m.formId}.fields.json`), "utf8")) as FormCatalog;
  return out;
}

export function loadLineLabels(): LineLabelTable {
  const raw = JSON.parse(readFileSync(path.join(formsDir(), "line-labels.json"), "utf8")) as Record<string, Record<string, string>>;
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

export function blankFormIds(): Set<string> {
  return new Set(listFormIds());
}

// ── Raw documents ─────────────────────────────────────────────────────────────

let docCounter = 0;

export function doc(docType: string, data: Record<string, unknown>, over: Partial<RawDocument> = {}): RawDocument {
  docCounter += 1;
  return {
    id: over.id ?? `00000000-0000-4000-8000-${String(docCounter).padStart(12, "0")}`,
    docType,
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { data },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: ERIC_ID,
    documentName: null,
    ...over,
  };
}

export function w2Doc(person: string, employer: string, ein: string, wages: number, fedWithheld: number, ctWithheld: number, extra: Record<string, unknown> = {}, over: Partial<RawDocument> = {}): RawDocument {
  return doc(
    "w2",
    {
      employerName: employer,
      employerEIN: ein,
      wagesCents: wages,
      federalWithheldCents: fedWithheld,
      socialSecurityWagesCents: Math.min(wages, 17_610_000),
      socialSecurityWithheldCents: Math.round(Math.min(wages, 17_610_000) * 0.062),
      medicareWagesCents: wages,
      medicareWithheldCents: Math.round(wages * 0.0145),
      box12: [],
      box14: [],
      stateLines: [{ stateCode: "CT", stateWagesCents: wages, stateWithheldCents: ctWithheld }],
      ...extra,
    },
    { subjectUserId: person, ...over }
  );
}

export function interestDoc(payer: string, ein: string, box1: number, over: Partial<RawDocument> = {}): RawDocument {
  return doc("1099", { formVariant: "1099-INT", payerName: payer, payerEIN: ein, amountCents: box1, int_box1Cents: box1, int_box3Cents: 0, federalWithheldCents: 0 }, over);
}

export function dividendDoc(payer: string, ein: string, box1a: number, box1b: number, over: Partial<RawDocument> = {}): RawDocument {
  return doc("1099", { formVariant: "1099-DIV", payerName: payer, payerEIN: ein, amountCents: box1a, div_box1aCents: box1a, div_box1bCents: box1b, div_box2aCents: 0, federalWithheldCents: 0 }, over);
}

export interface SummaryRow {
  form?: "1099-B";
  box: BrokerBox;
  proceedsCents: number;
  costCents: number | null;
  washSaleLossDisallowedCents?: number;
}

export function brokerDoc(payer: string, ein: string, rows: SummaryRow[], over: Partial<RawDocument> = {}): RawDocument {
  return doc(
    "1099",
    {
      formVariant: "consolidated",
      variantsPresent: ["1099-B"],
      payerName: payer,
      payerEIN: ein,
      federalWithheldCents: 0,
      bSummary: rows.map((r) => ({
        form: r.form ?? "1099-B",
        box: r.box,
        proceedsCents: r.proceedsCents,
        costCents: r.costCents,
        accruedMarketDiscountCents: 0,
        washSaleLossDisallowedCents: r.washSaleLossDisallowedCents ?? 0,
        gainLossCents: null,
      })),
      sec1256AggregateCents: 0,
      otherBoxes: [],
    },
    over
  );
}

export function mortgageDoc(interest: number, principal: number, over: Partial<RawDocument> = {}): RawDocument {
  return doc("mortgage_interest", { servicerName: "Sample Lender", interestCents: interest, principalBalanceCents: principal, propertyAddress: "27 Old Barry Rd", mortgageInsurancePremiumsCents: null }, { subjectUserId: null, subjectType: "joint", ...over });
}

export function propertyTaxDoc(label: string, address: string, paid: number, taxType = "real_estate", over: Partial<RawDocument> = {}): RawDocument {
  return doc("property_tax", { jurisdictionName: label, propertyAddress: address, taxType, totalTaxBilledCents: paid, paidInTaxYearCents: paid }, { subjectUserId: null, subjectType: "joint", ...over });
}

export function rawInputs(documents: RawDocument[]): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric Sample" },
      { userId: EVA_ID, name: "Eva Sample" },
    ],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name matches the entity name" },
    documents,
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

export interface Scenario {
  name: string;
  facts: Ty2025Facts;
  raw: RawTy2025Inputs;
  overrideRows: OverrideRow[];
}

/** Graft the document-derived facts of `raw` onto the golden household (every owner answer given), as the PDF fixtures do. */
function graft(raw: RawTy2025Inputs, base: Ty2025Facts): Ty2025Facts {
  const r = resolveFacts(raw).facts;
  const f = structuredClone(base);
  f.income.w2s = r.income.w2s;
  f.income.w2Unusable = r.income.w2Unusable;
  f.income.interest = r.income.interest;
  f.income.dividends = r.income.dividends;
  f.income.otherIncomeBoxes = r.income.otherIncomeBoxes;
  f.income.brokerSales = r.income.brokerSales;
  f.deductions.mortgages = r.deductions.mortgages;
  f.deductions.propertyTaxBills = r.deductions.propertyTaxBills;
  f.payments.federal1099WithheldCents = r.payments.federal1099WithheldCents;
  f.household.people = [
    { userId: ERIC_ID, name: "Eric Sample" },
    { userId: EVA_ID, name: "Eva Sample" },
  ];
  return f;
}

export function cleanDocs(): RawDocument[] {
  docCounter = 0;
  return [
    w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 9_000_000, 1_100_000, 300_000),
    w2Doc(EVA_ID, "Brewery Sample LLC", "22-2222222", 4_000_000, 400_000, 120_000),
    interestDoc("Sample Bank", "33-3333333", 50_000),
    dividendDoc("Sample Brokerage", "44-4444444", 100_000, 80_000),
    mortgageDoc(1_888_269, 40_000_000),
    propertyTaxDoc("Town of Sample", "27 Old Barry Rd", 600_000),
  ];
}

export function richDocs(): RawDocument[] {
  docCounter = 0;
  return [
    w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 15_000_000, 2_700_000, 600_000, { box12: [{ code: "D", amountCents: 1_500_000 }], retirementPlan: true }),
    w2Doc(ERIC_ID, "Second Sample Employer", "55-5555555", 4_500_000, 600_000, 150_000),
    w2Doc(EVA_ID, "Brewery Sample LLC", "22-2222222", 9_000_000, 1_000_000, 250_000),
    interestDoc("Sample Bank", "33-3333333", 180_000),
    dividendDoc("Sample Fund Co", "44-4444444", 250_000, 200_000),
    brokerDoc("Sample Brokerage A", "66-6666666", [
      { box: "A", proceedsCents: 2_287_399, costCents: 1_732_278, washSaleLossDisallowedCents: 599 },
      { box: "D", proceedsCents: 5_000_050, costCents: 4_100_025 },
    ]),
    brokerDoc("Sample Brokerage B", "77-7777777", [{ box: "B", proceedsCents: 120_075, costCents: 100_040 }]),
    mortgageDoc(2_450_000, 38_000_000),
    propertyTaxDoc("Town of Sample", "27 Old Barry Rd", 900_000),
    propertyTaxDoc("Town of Sample", "27 Old Barry Rd", 45_000, "motor_vehicle", { id: "00000000-0000-4000-8000-0000000000aa" }),
  ];
}

/** Facts for `docs`: the golden household with its answers, the document-derived facts grafted on, then `tweak`. */
export function scenarioFor(name: string, docs: RawDocument[], tweak: (f: Ty2025Facts) => void = () => undefined): Scenario {
  const raw = rawInputs(docs);
  const facts = graft(raw, fullFacts1b());
  tweak(facts);
  return { name, facts, raw, overrideRows: [] };
}

/** Wages, Schedule C, interest and dividends, the standard deduction. A 2024 return close enough to 2025 that nothing trips a variance. */
export function cleanScenario(docs: RawDocument[] = cleanDocs(), tweak: (f: Ty2025Facts) => void = () => undefined): Scenario {
  return scenarioFor("clean", docs, (f) => {
    f.priorYear = { totalTaxCents: owner(2_600_000), agiCents: owner(17_000_000), filingStatus: owner("mfj") };
    tweak(f);
  });
}

/** Two W-2s for Eric, one for Eva, itemized deductions, interest and dividends over the Schedule B limit, Robinhood-style summaries. */
export function richScenario(docs: RawDocument[] = richDocs(), tweak: (f: Ty2025Facts) => void = () => undefined): Scenario {
  return scenarioFor("rich", docs, (f) => {
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
    f.income.dividendBoxes2b2dConfirmedZero = true;
    const eric = f.returnAnswers.people.find((p) => p.userId === ERIC_ID);
    if (eric) eric.deferralsCents = owner(1_500_000);
    f.priorYear = { totalTaxCents: owner(8_000_000), agiCents: owner(34_000_000), filingStatus: owner("mfj") };
    tweak(f);
  });
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface Pipeline {
  ctx: L1Context;
  ret: Ty2025Return;
}

export interface PipelineOptions {
  mode?: "draft" | "final";
  /** Change the computed return AFTER the engine ran (e.g. nudge a line by $1). */
  mutateRet?: (ret: Ty2025Return) => void;
  /** Replace the maps used to FILL the packet. */
  fillMaps?: readonly FormMap[];
  hooks?: AssembleHooks;
  /** Also build the final package the way the ?final=1 route does (production does). */
  includeFinalPackage?: boolean;
}

export async function buildPipeline(s: Scenario, opts: PipelineOptions = {}): Promise<Pipeline> {
  const decisions = decisionsFromOverrides(s.overrideRows);
  const ret = computeTy2025Return(s.facts, decisions);
  opts.mutateRet?.(ret);
  const effective = applyOverrides(ret, s.overrideRows);
  const ctx = await assembleL1Context(
    {
      ret,
      effective,
      facts: s.facts,
      raw: s.raw,
      overrideRows: s.overrideRows,
      maps: opts.fillMaps ?? FORM_MAPS,
      mode: opts.mode ?? "draft",
      generatedAt: GENERATED_AT,
      generatedBy: "Test User",
      ekcName: "Sample Consulting, LLC",
      catalogs: loadCatalogs(),
      lineLabels: loadLineLabels(),
      blankFormIds: blankFormIds(),
      sheetDocuments: s.raw.documents.map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, legacyFormat: d.legacyFormat, subjectType: d.subjectType })),
      ...(opts.includeFinalPackage === true ? { includeFinalPackage: true } : {}),
    },
    opts.hooks
  );
  return { ctx, ret };
}

export async function runPipeline(s: Scenario, opts: PipelineOptions = {}): Promise<{ pipeline: Pipeline; result: L1Result }> {
  const pipeline = await buildPipeline(s, opts);
  return { pipeline, result: await runL1(pipeline.ctx) };
}

/** Findings at severity medium or higher. */
export function significant(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => atLeast(f.severity, "medium"));
}

export function describeFindings(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.severity} ${f.check}: ${f.message.slice(0, 160)}`);
}

// ── PDF editing helpers for the seeded defects ────────────────────────────────

/** Replace the bytes of one packet file after editing its AcroForm with pdf-lib (a "hand edit" after the engine ran). */
export async function editPacketFile(packet: L1Packet, name: string, edit: (form: PDFForm, doc: PDFDocument) => void): Promise<void> {
  const files = packet.files as L1PacketFile[];
  const i = files.findIndex((f) => f.name === name);
  const current = files[i];
  if (i === -1 || current === undefined) throw new Error(`no packet file ${name}`);
  const doc = await PDFDocument.load(current.bytes, { updateMetadata: false });
  edit(doc.getForm(), doc);
  files[i] = { ...current, bytes: await doc.save({ updateFieldAppearances: false }) };
}

export function setText(form: PDFForm, field: string, value: string): void {
  const f = form.getFieldMaybe(field);
  if (!(f instanceof PDFTextField)) throw new Error(`not a text field: ${field}`);
  f.setText(value);
}

/** The AcroForm field a map prints a line in. */
export function fieldOfLine(map: FormMap, line: string): string {
  const e = map.lines.find((l) => l.kind === "money" && l.line === line);
  if (!e || e.kind !== "money") throw new Error(`map ${map.formId} has no field for ${line}`);
  return e.field;
}
