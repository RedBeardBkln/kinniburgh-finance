// Pure paystub helpers — safe to import from client components and tests.
// No Node-only or SDK imports allowed in this file.

// ── Types ─────────────────────────────────────────────────────────────────────

export type PayFrequency = "semi_monthly" | "biweekly" | "weekly" | "monthly";

export interface LabeledAmount {
  label: string;
  amountCents: number;
}

export interface ExtractedPaystub {
  employeeName: string | null;
  employerName: string | null;
  payPeriodStart: string | null; // YYYY-MM-DD
  payPeriodEnd: string | null;   // YYYY-MM-DD
  payDate: string | null;        // YYYY-MM-DD
  payFrequency: PayFrequency | null;
  grossPayCents: number | null;
  pretaxDeductions: LabeledAmount[];
  taxesCents: number | null;
  taxBreakdown: LabeledAmount[];
  additionalWithholding: LabeledAmount[];
  netPayCents: number | null;
  raw: string;
}

export const EMPTY_PAYSTUB: Omit<ExtractedPaystub, "raw"> = {
  employeeName: null,
  employerName: null,
  payPeriodStart: null,
  payPeriodEnd: null,
  payDate: null,
  payFrequency: null,
  grossPayCents: null,
  pretaxDeductions: [],
  taxesCents: null,
  taxBreakdown: [],
  additionalWithholding: [],
  netPayCents: null,
};

// ── Parsing ───────────────────────────────────────────────────────────────────

function toCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function toLabeledAmounts(value: unknown): LabeledAmount[] {
  if (!Array.isArray(value)) return [];
  const result: LabeledAmount[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const label = (item as Record<string, unknown>)["label"];
    const amountCents = toCents((item as Record<string, unknown>)["amountCents"]);
    if (typeof label === "string" && label.length > 0 && amountCents !== null) {
      result.push({ label, amountCents });
    }
  }
  return result;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null;
}

const FREQUENCIES: PayFrequency[] = ["semi_monthly", "biweekly", "weekly", "monthly"];

export function parseExtractedPaystub(text: string): ExtractedPaystub {
  const raw = text.trim();
  try {
    const jsonText = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const frequency =
      typeof parsed.payFrequency === "string" &&
      FREQUENCIES.includes(parsed.payFrequency as PayFrequency)
        ? (parsed.payFrequency as PayFrequency)
        : null;
    return {
      employeeName: typeof parsed.employeeName === "string" ? parsed.employeeName : null,
      employerName: typeof parsed.employerName === "string" ? parsed.employerName : null,
      payPeriodStart: toIsoDate(parsed.payPeriodStart),
      payPeriodEnd: toIsoDate(parsed.payPeriodEnd),
      payDate: toIsoDate(parsed.payDate),
      payFrequency: frequency,
      grossPayCents: toCents(parsed.grossPayCents),
      pretaxDeductions: toLabeledAmounts(parsed.pretaxDeductions),
      taxesCents: toCents(parsed.taxesCents),
      taxBreakdown: toLabeledAmounts(parsed.taxBreakdown),
      additionalWithholding: toLabeledAmounts(parsed.additionalWithholding),
      netPayCents: toCents(parsed.netPayCents),
      raw,
    };
  } catch {
    return { ...EMPTY_PAYSTUB, raw };
  }
}

// ── Math verification ──────────────────────────────────────────────────────────

export interface PaystubMath {
  pretaxTotalCents: number;
  taxesTotalCents: number | null;
  computedNetCents: number | null;
  /** computed net − stated net; 0 = perfectly balanced */
  balanceDiffCents: number | null;
  /** True when taxBreakdown items sum to the stated taxesCents total */
  taxesBreakdownBalanced: boolean | null;
  isBalanced: boolean | null;
}

export function verifyPaystubMath(input: {
  grossPayCents: number | null;
  pretaxDeductions: LabeledAmount[];
  taxesCents: number | null;
  taxBreakdown: LabeledAmount[];
  netPayCents: number | null;
}): PaystubMath {
  const pretaxTotalCents = input.pretaxDeductions.reduce((s, d) => s + d.amountCents, 0);

  const taxesTotalCents =
    input.taxesCents ??
    (input.taxBreakdown.length > 0
      ? input.taxBreakdown.reduce((s, t) => s + t.amountCents, 0)
      : null);

  const taxesBreakdownBalanced =
    input.taxesCents === null || input.taxBreakdown.length === 0
      ? null
      : input.taxesCents === input.taxBreakdown.reduce((s, t) => s + t.amountCents, 0);

  if (input.grossPayCents === null || input.netPayCents === null || taxesTotalCents === null) {
    return {
      pretaxTotalCents,
      taxesTotalCents,
      computedNetCents: null,
      balanceDiffCents: null,
      taxesBreakdownBalanced,
      isBalanced: null,
    };
  }

  const computedNetCents = input.grossPayCents - pretaxTotalCents - taxesTotalCents;
  const balanceDiffCents = computedNetCents - input.netPayCents;

  return {
    pretaxTotalCents,
    taxesTotalCents,
    computedNetCents,
    balanceDiffCents,
    taxesBreakdownBalanced,
    isBalanced: balanceDiffCents === 0,
  };
}

// ── Cadence inference ─────────────────────────────────────────────────────────

const DAY_MS = 86400000;

/**
 * Infers pay frequency from period start/end dates and the anchor day-of-month
 * of the pay date. Returns null when ambiguous or when dates are missing.
 */
export function inferPayFrequency(
  payPeriodStart: string | null,
  payPeriodEnd: string | null,
  payDate: string | null
): PayFrequency | null {
  if (!payPeriodStart || !payPeriodEnd) return null;

  const start = new Date(`${payPeriodStart}T00:00:00Z`);
  const end = new Date(`${payPeriodEnd}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return null;

  // Inclusive day count between period start and end
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;

  if (days >= 6 && days <= 8) return "weekly";
  if (days >= 13 && days <= 18) {
    // Could be biweekly or semi-monthly — disambiguate via calendar position.
    const startDay = start.getUTCDate();
    const endDay = end.getUTCDate();
    if (startDay === 1 && endDay >= 13 && endDay <= 16) return "semi_monthly";
    if (endDay >= 27 && endDay <= 31 && startDay >= 13 && startDay <= 16) return "semi_monthly";
    return "biweekly";
  }
  if (days >= 28 && days <= 35) {
    // 28-31 day period = a full calendar month (single pay period)
    return "monthly";
  }

  // Fallback: use payDate day-of-month pattern for common semi-monthly anchors
  if (payDate) {
    const payDateParsed = new Date(`${payDate}T00:00:00Z`);
    if (!isNaN(payDateParsed.getTime())) {
      const day = payDateParsed.getUTCDate();
      if (day === 15 || day === 30 || day === 1 || day === 16 || day === 31) {
        return "semi_monthly";
      }
    }
  }

  return null;
}