"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export interface DebtDetailInput {
  id?: string;
  accountId?: string | null;
  name: string;
  originalBalanceCents?: number | null;
  manualBalanceCents?: number | null;
  interestRate?: number | null;
  monthlyPaymentCents?: number | null;
  paymentDay?: number | null;
  tagId?: string | null;
  notes?: string | null;
  sortOrder?: number;
}

export async function listDebtDetails() {
  return db.debtDetail.findMany({
    include: {
      account: {
        select: {
          id: true,
          nickname: true,
          mask: true,
          accountType: true,
          integrationMode: true,
          currentBalance: true,
          currentBalanceAt: true,
          plaidItemId: true,
          institution: { select: { name: true } },
          entity: { select: { name: true } },
        },
      },
      tag: { select: { id: true, name: true, shortName: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function upsertDebtDetail(input: DebtDetailInput) {
  const data = {
    name: input.name,
    accountId: input.accountId ?? null,
    originalBalanceCents: input.originalBalanceCents ?? null,
    manualBalanceCents: input.manualBalanceCents ?? null,
    interestRate: input.interestRate != null ? String(input.interestRate) : null,
    monthlyPaymentCents: input.monthlyPaymentCents ?? null,
    paymentDay: input.paymentDay ?? null,
    tagId: input.tagId ?? null,
    notes: input.notes ?? null,
    sortOrder: input.sortOrder ?? 0,
  };

  const result = input.id
    ? await db.debtDetail.update({ where: { id: input.id }, data })
    : await db.debtDetail.create({ data });

  revalidatePath("/personal/debt-free");
  return result;
}

export async function deleteDebtDetail(id: string) {
  await db.debtDetail.delete({ where: { id } });
  revalidatePath("/personal/debt-free");
}
