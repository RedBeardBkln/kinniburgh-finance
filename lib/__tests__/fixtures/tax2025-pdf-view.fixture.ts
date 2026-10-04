// SYNTHETIC fixture for the PDF layer tests. Every number and name here is invented
// ("Alex Example"); nothing is read from, or resembles, the real return. Money is
// whole dollars (integers), exactly as the engine hands it to the PDF layer.

import type { Headline, HeadlineAmount, RuleStatus } from "@/lib/tax2025/types";
import { fingerprintOf } from "@/lib/tax2025/pdf/format";
import type {
  LineRef,
  PdfDecision,
  PdfLine,
  PdfLineStatus,
  PdfOpenItem,
  PdfOverrideEntry,
  PdfReturnView,
} from "@/lib/tax2025/pdf/types";

export interface LineSpec {
  key: LineRef;
  formLabel: string;
  formLine: string;
  label: string;
  status?: PdfLineStatus;
  amount?: number | null;
  reason?: string | null;
  override?: PdfLine["override"];
  defaultUndecided?: string;
}

export function pdfLine(spec: LineSpec): PdfLine {
  const status = spec.status ?? "computed";
  const base: PdfLine = {
    key: spec.key,
    status,
    amount: spec.amount === undefined ? 0 : spec.amount,
    reason: spec.reason ?? null,
    formLabel: spec.formLabel,
    formLine: spec.formLine,
    label: spec.label,
  };
  if (spec.override) base.override = spec.override;
  if (spec.defaultUndecided) base.defaultUndecided = spec.defaultUndecided;
  return base;
}

/** The 17 keyed 1040 lines of the T1 trial map, all computed, with the amounts below. */
export const F1040_SYNTHETIC_AMOUNTS: Readonly<Record<string, number>> = {
  "f1040.1a": 100000,
  "f1040.2b": 1234,
  "f1040.3b": 0, // computed zero on a detail line -> printed blank
  "f1040.8": -1500, // negative -> "-1,500"
  "f1040.9": 99734,
  "f1040.10": 3000,
  "f1040.11a": 96734,
  "f1040.12e": 31500,
  "f1040.13a": 5000,
  "f1040.14": 36500,
  "f1040.15": 60234,
  "f1040.16": 6800,
  "f1040.24": 9500,
  "f1040.25d": 11000,
  "f1040.33": 11000,
  "f1040.34": 1500,
  "f1040.37": 0, // computed zero on a detail line -> blank
};

const F1040_LABELS: Readonly<Record<string, [string, string]>> = {
  "f1040.1a": ["1a", "Total amount from Form(s) W-2, box 1"],
  "f1040.2b": ["2b", "Taxable interest"],
  "f1040.3b": ["3b", "Ordinary dividends"],
  "f1040.8": ["8", "Additional income from Schedule 1, line 10"],
  "f1040.9": ["9", "Total income"],
  "f1040.10": ["10", "Adjustments to income from Schedule 1, line 26"],
  "f1040.11a": ["11a", "Adjusted gross income"],
  "f1040.12e": ["12e", "Standard deduction or itemized deductions"],
  "f1040.13a": ["13a", "Qualified business income deduction"],
  "f1040.14": ["14", "Add lines 12e, 13a, and 13b"],
  "f1040.15": ["15", "Taxable income"],
  "f1040.16": ["16", "Tax"],
  "f1040.24": ["24", "Total tax"],
  "f1040.25d": ["25d", "Add lines 25a through 25c"],
  "f1040.33": ["33", "Total payments"],
  "f1040.34": ["34", "Amount you overpaid"],
  "f1040.37": ["37", "Amount you owe"],
};

export function f1040Lines(): Partial<Record<LineRef, PdfLine>> {
  const out: Partial<Record<LineRef, PdfLine>> = {};
  for (const [key, amount] of Object.entries(F1040_SYNTHETIC_AMOUNTS)) {
    const meta = F1040_LABELS[key];
    if (!meta) throw new Error(`fixture: no label for ${key}`);
    const k = key as LineRef;
    out[k] = pdfLine({ key: k, formLabel: "Form 1040", formLine: meta[0], label: meta[1], amount });
  }
  return out;
}

function ha(status: RuleStatus, amount: number | null): HeadlineAmount {
  return { status, amount, reason: null };
}

export const COMPLETE_HEADLINE: Headline = {
  complete: true,
  federal: {
    agi: ha("computed", 96734),
    taxableIncome: ha("computed", 60234),
    totalTax: ha("computed", 9500),
    totalPayments: ha("computed", 11000),
    balance: ha("computed", -1500),
  },
  connecticut: {
    ctAgi: ha("computed", 96734),
    tax: ha("computed", 3100),
    totalPayments: ha("computed", 3300),
    balance: ha("computed", -200),
  },
  blockingItemCount: 0,
  unverifiedDocumentCount: 0,
  derivedInputCount: 0,
  undecidedDecisionCount: 0,
  caveats: [],
  provisional: null,
};

export const INCOMPLETE_HEADLINE: Headline = {
  complete: false,
  federal: {
    agi: ha("missing_input", null),
    taxableIncome: ha("missing_input", null),
    totalTax: ha("missing_input", null),
    totalPayments: ha("missing_input", null),
    balance: ha("missing_input", null),
  },
  connecticut: {
    ctAgi: ha("missing_input", null),
    tax: ha("missing_input", null),
    totalPayments: ha("missing_input", null),
    balance: ha("missing_input", null),
  },
  blockingItemCount: 2,
  unverifiedDocumentCount: 0,
  derivedInputCount: 0,
  undecidedDecisionCount: 0,
  caveats: [],
  provisional: {
    note: "Estimate with unresolved lines treated as $0 (synthetic).",
    assumedZeroLines: ["f1040.2b", "sch1.3"],
    assumedFacts: [],
    lines: {},
    agi: 90000,
    taxableIncome: 55000,
    totalTax: 8000,
    totalPayments: 7000,
    federalBalance: 1000,
    ctTax: 2900,
    ctPayments: 3000,
    ctBalance: -100,
  },
};

export function makeOpenItems(count: number): PdfOpenItem[] {
  const items: PdfOpenItem[] = [];
  for (let i = 1; i <= count; i++) {
    items.push({
      id: `oi-${String(i).padStart(3, "0")}`,
      severity: i % 3 === 0 ? "advisory" : "blocking",
      formLabel: i % 2 === 0 ? "Schedule C" : "Form 1040",
      lineKeys: [i % 2 === 0 ? "schc.8" : "f1040.2b"],
      message: `Synthetic open item number ${i}: confirm the amount shown against the source document before filing.`,
      action: `Synthetic action ${i}: ask the owner for the missing paper and record the answer.`,
    });
  }
  return items;
}

export interface ViewOptions {
  lines?: Partial<Record<LineRef, PdfLine>>;
  openItems?: PdfOpenItem[];
  decisions?: PdfDecision[];
  overrides?: PdfOverrideEntry[];
  answers?: PdfReturnView["answers"];
  headline?: Headline;
  header?: Partial<PdfReturnView["header"]>;
  tables?: PdfReturnView["tables"];
  citations?: string[];
  acknowledged?: PdfReturnView["acknowledged"];
  overrideNotice?: Partial<PdfReturnView["overrideNotice"]>;
  resolvedByOverride?: PdfReturnView["resolvedByOverride"];
}

export function makeView(opts: ViewOptions = {}): PdfReturnView {
  const lines = opts.lines ?? f1040Lines();
  const openItems = opts.openItems ?? [];
  const decisions = opts.decisions ?? [];
  const headline = opts.headline ?? COMPLETE_HEADLINE;
  return {
    taxYear: 2025,
    filingStatus: "mfj",
    generatedAt: "2026-10-04T02:30:00.000Z", // 2026-10-03 22:30 in New York
    generatedBy: "Test Runner (synthetic)",
    fingerprint: fingerprintOf({ lines, openItems, decisions, headline }),
    lines,
    header: {
      householdNames: "Alex Example and Sam Q Example",
      taxpayerName: "Alex Example",
      spouseName: "Sam Q Example",
      ekcName: "Example Consulting, LLC",
      ...opts.header,
    },
    answers: opts.answers ?? { filingStatus: "mfj" },
    tables: opts.tables ?? {},
    openItems,
    decisions,
    overrides: opts.overrides ?? [],
    overrideNotice: { totalsNotRecomputed: false, dependents: [], headlineMarks: [], engineChanged: [], count: 0, ...opts.overrideNotice },
    resolvedByOverride: opts.resolvedByOverride ?? [],
    acknowledged: opts.acknowledged ?? [],
    headline,
    citations: opts.citations ?? ["fed.std_deduction_mfj_2025", "fed.brackets_mfj_2025"],
  };
}
