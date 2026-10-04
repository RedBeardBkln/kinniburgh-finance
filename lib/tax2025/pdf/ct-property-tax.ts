// CT-1040 Schedule 3 (property tax credit) rows: lines 60 (primary residence), 61 (Auto 1)
// and 62 (Auto 2, married filing jointly only). The rule is the engine's own
// (rules/ct.ts computeCtPropertyTaxCredit): ONLY a primary residence and up to
// CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ motor vehicles qualify (largest paid first);
// any other real estate (56 Arbor Rd in 2025) and other personal property never appear on
// Schedule 3, and an unclassified bill is never guessed into a row.
//
// Pure. The adapter calls this with facts.deductions.propertyTaxBills and puts the rows into
// view.tables["ct.propertyTax"] (cells: description, amount).

import { K } from "@/lib/tax2025/constants";
import type { PropertyTaxBill } from "@/lib/tax2025/facts";
import { centsToDollars, roundLine } from "@/lib/tax2025/money";
import type { PdfTableRow } from "@/lib/tax2025/pdf/types";

export const CT_PROPERTY_TABLE_COLUMNS = { label: "description", amount: "amount" } as const;

export interface CtPropertyTaxRows {
  /** Rows in form order: primary residence, auto 1, auto 2 (at most 3). */
  rows: PdfTableRow[];
  /** Labels of the bills left off Schedule 3 (other real estate / other personal property / unclassified / over the vehicle limit). */
  excluded: string[];
}

function wholeDollars(cents: number): number {
  return roundLine(centsToDollars(cents)).toNumber();
}

function describe(b: PropertyTaxBill, preferAddress: boolean): string {
  const text = preferAddress ? (b.address ?? b.label) : b.label;
  return text.trim() === "" ? b.label : text.trim();
}

export function ctPropertyTaxRows(bills: readonly PropertyTaxBill[]): CtPropertyTaxRows {
  const maxVehicles = K.CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ.value;
  const rows: PdfTableRow[] = [];
  const excluded: string[] = [];

  const primary = bills.filter((b) => b.kind === "primary_residence");
  if (primary.length > 0) {
    // One row for the home: every primary-residence bill paid in the year, added (the engine adds them too).
    const paid = primary.map((b) => b.paidInYearCents);
    const total = paid.every((c): c is number => c !== null) ? paid.reduce((s, c) => s + c, 0) : null;
    rows.push({
      cells: {
        [CT_PROPERTY_TABLE_COLUMNS.label]: primary.map((b) => describe(b, true)).join("; "),
        [CT_PROPERTY_TABLE_COLUMNS.amount]: total === null ? null : wholeDollars(total),
      },
    });
  }

  // Vehicles: largest paid first, at most the form's limit; an unpaid (null) amount sorts last.
  const vehicles = bills
    .filter((b) => b.kind === "motor_vehicle")
    .sort((a, b) => (b.paidInYearCents ?? -1) - (a.paidInYearCents ?? -1));
  // The vehicle rows start at line 61, so a missing primary residence leaves its row blank (empty cells).
  if (primary.length === 0 && vehicles.length > 0) rows.push({ cells: {} });
  for (const v of vehicles.slice(0, maxVehicles)) {
    rows.push({
      cells: {
        [CT_PROPERTY_TABLE_COLUMNS.label]: describe(v, false),
        [CT_PROPERTY_TABLE_COLUMNS.amount]: v.paidInYearCents === null ? null : wholeDollars(v.paidInYearCents),
      },
    });
  }
  for (const v of vehicles.slice(maxVehicles)) excluded.push(v.label);

  for (const b of bills) {
    if (b.kind === "other_real_estate" || b.kind === "other_personal_property" || b.kind === "unclassified") excluded.push(b.label);
  }
  return { rows, excluded };
}
