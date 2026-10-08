// Insurance policy reads for the assistant. DB-aware, explicit select only: insurer, type, face amount, premium, dates and the latest cash value.
// The policy number, the linked document, the notes and the Vault are never selected.

import { db } from "@/lib/db";

export interface InsuranceRow {
  policyType: string;
  insurer: string;
  faceAmountCents: number | null;
  monthlyPremiumCents: number | null;
  effectiveDate: Date | null;
  expiryDate: Date | null;
  entity: { name: string };
  cashValueEntries: { asOf: Date; cashValueCents: number }[];
}

export const INSURANCE_CAP = 30;

export async function loadInsurance(opts: { entity?: string }): Promise<InsuranceRow[]> {
  return db.insurancePolicy.findMany({
    where: {
      archivedAt: null,
      ...(opts.entity !== undefined
        ? { entity: { OR: [{ name: { equals: opts.entity, mode: "insensitive" as const } }, { slug: { equals: opts.entity, mode: "insensitive" as const } }] } }
        : {}),
    },
    orderBy: [{ insurer: "asc" }, { id: "asc" }],
    take: INSURANCE_CAP,
    select: {
      policyType: true,
      insurer: true,
      faceAmountCents: true,
      monthlyPremiumCents: true,
      effectiveDate: true,
      expiryDate: true,
      entity: { select: { name: true } },
      cashValueEntries: { orderBy: { asOf: "desc" }, take: 1, select: { asOf: true, cashValueCents: true } },
    },
  });
}
