// Pure helpers around the 1099 sales summary (`bSummary`) and the "re-read with the new fields" flow
// (schedule-d-capture). Client-safe: no DB, no server imports, no clock.
//
//   - readBrokerSummary: the EFFECTIVE extraction data of a 1099 document -> typed category rows plus the three
//     states the engine and the review screen need to tell apart:
//       summary read (bSummary is a list, possibly empty), signalled-but-unread (the older read mentions a
//       1099-B and bSummary is null) and "no sales" (no 1099-B signal and bSummary null).
//   - snapshot / compare: the NON-IDENTIFYING values of a 1099 (money boxes, form types; never a name, EIN or
//     number) before and after a forced re-read, so the owner can see exactly what the new read changed.

import {
  BSUMMARY_BOXES,
  BSUMMARY_FORMS,
  getTaxSchema,
  formatCentsDisplay,
} from "@/lib/tax-extraction-schema";

export type BrokerForm = (typeof BSUMMARY_FORMS)[number];
export type BrokerBox = (typeof BSUMMARY_BOXES)[number];

export interface BrokerSummaryRow {
  form: BrokerForm | null;
  box: BrokerBox | null;
  proceedsCents: number | null;
  costCents: number | null;
  accruedMarketDiscountCents: number | null;
  washSaleLossDisallowedCents: number | null;
  gainLossCents: number | null;
}

export interface BrokerSummaryRead {
  /** bSummary is a list in the effective data (possibly empty = read, no sales). */
  summaryRead: boolean;
  rows: BrokerSummaryRow[];
  sec1256AggregateCents: number | null;
  /** The (older) read mentions a 1099-B: variantsPresent has it, or an otherBoxes entry is a 1099-B box. */
  signalled1099B: boolean;
  /** variantsPresent has 1099-DA or a summary row is a 1099-DA row. */
  forms1099DaPresent: boolean;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : null;
}

/** Reads the sales summary state from a 1099 document's effective `data` object (extractionData.data). */
export function readBrokerSummary(data: unknown): BrokerSummaryRead {
  const d: Rec = isRecord(data) ? data : {};
  const rowsRaw = d.bSummary;
  const summaryRead = Array.isArray(rowsRaw);
  const rows: BrokerSummaryRow[] = summaryRead
    ? (rowsRaw as unknown[]).filter(isRecord).map((r) => ({
        form: oneOf(BSUMMARY_FORMS, r.form),
        box: oneOf(BSUMMARY_BOXES, r.box),
        proceedsCents: int(r.proceedsCents),
        costCents: int(r.costCents),
        accruedMarketDiscountCents: int(r.accruedMarketDiscountCents),
        washSaleLossDisallowedCents: int(r.washSaleLossDisallowedCents),
        gainLossCents: int(r.gainLossCents),
      }))
    : [];
  const variants = Array.isArray(d.variantsPresent) ? d.variantsPresent : [];
  const otherBoxes = Array.isArray(d.otherBoxes) ? d.otherBoxes : [];
  const signalled1099B =
    variants.includes("1099-B") || d.formVariant === "1099-B" || otherBoxes.some((b) => isRecord(b) && b.variant === "1099-B");
  return {
    summaryRead,
    rows,
    sec1256AggregateCents: int(d.sec1256AggregateCents),
    signalled1099B,
    forms1099DaPresent: variants.includes("1099-DA") || rows.some((r) => r.form === "1099-DA"),
  };
}

/** The "Re-read this document with the new fields" offer: a 1099 whose sales summary was never read (bSummary is null or absent). */
export function offersSummaryReread(data: unknown): boolean {
  const d: Rec = isRecord(data) ? data : {};
  return !Array.isArray(d.bSummary);
}

// ── Before / after of a re-read ───────────────────────────────────────────────

export interface ValueSnapshotRow {
  key: string;
  label: string;
  /** Display text ("$1,234.56", "consolidated", "1099-DIV, 1099-B") or "-" when blank. */
  text: string;
}

/** Keys the sales summary capture adds; never part of the before/after comparison of the OLD boxes. */
const NEW_KEYS: ReadonlySet<string> = new Set(["bSummary", "sec1256AggregateCents", "bSummaryTotalProceedsCents", "bSummaryTotalGainCents"]);

/**
 * The non-identifying values of a 1099 (the form type(s) and every money box, as display text). Names, EINs and
 * state IDs are deliberately NOT included: the snapshot is returned to the browser and shown beside the document.
 */
export function snapshotNonIdentifying1099(data: unknown): ValueSnapshotRow[] {
  const d: Rec = isRecord(data) ? data : {};
  const out: ValueSnapshotRow[] = [];
  for (const def of getTaxSchema("1099").fields) {
    if (NEW_KEYS.has(def.key)) continue;
    const value = d[def.key];
    if (def.kind === "money") {
      out.push({ key: def.key, label: def.label, text: typeof value === "number" ? formatCentsDisplay(value) : "-" });
    } else if (def.key === "formVariant") {
      out.push({ key: def.key, label: def.label, text: typeof value === "string" && value !== "" ? value : "-" });
    } else if (def.key === "variantsPresent") {
      out.push({
        key: def.key,
        label: def.label,
        text: Array.isArray(value) && value.length > 0 ? value.filter((v): v is string => typeof v === "string").join(", ") : "-",
      });
    }
  }
  return out;
}

export interface ValueComparisonRow extends ValueSnapshotRow {
  before: string;
  after: string;
  changed: boolean;
}

/** Pairs the before and after snapshots by key (the registry order); `changed` when the display text differs. */
export function compareSnapshots(before: readonly ValueSnapshotRow[], after: readonly ValueSnapshotRow[]): ValueComparisonRow[] {
  const afterByKey = new Map(after.map((r) => [r.key, r]));
  return before.map((b) => {
    const a = afterByKey.get(b.key);
    const afterText = a ? a.text : "-";
    return { key: b.key, label: b.label, text: afterText, before: b.text, after: afterText, changed: b.text !== afterText };
  });
}
