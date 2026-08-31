"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { LabeledAmount, PayFrequency } from "@/lib/paystub-extract";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

// ── List paystubs ─────────────────────────────────────────────────────────────

export async function listPaystubs(entityId: string) {
  await requireAuth();
  return db.paystub.findMany({
    where: { entityId, archivedAt: null },
    orderBy: [{ payDate: "desc" }, { createdAt: "desc" }],
  });
}

// ── Confirm paystub (review + fix extraction) ─────────────────────────────────

const labeledAmountSchema = z.object({
  label: z.string().min(1).max(100),
  amountCents: z.number().int(),
});

const FREQUENCIES = ["semi_monthly", "biweekly", "weekly", "monthly"] as const;

const confirmSchema = z.object({
  paystubId: z.string().uuid(),
  employeeName: z.string().max(255).optional(),
  employerName: z.string().max(255).optional(),
  payPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  payPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payFrequency: z.enum(FREQUENCIES),
  grossPayCents: z.number().int().nonnegative(),
  pretaxDeductions: z.array(labeledAmountSchema).default([]),
  taxesCents: z.number().int().nonnegative(),
  taxBreakdown: z.array(labeledAmountSchema).default([]),
  additionalWithholding: z.array(labeledAmountSchema).default([]),
  netPayCents: z.number().int().nonnegative(),
  notes: z.string().max(500).optional(),
});

export type ConfirmPaystubInput = z.input<typeof confirmSchema>;

export async function confirmPaystub(
  input: ConfirmPaystubInput
): Promise<{ success: true; balanceDiffCents: number } | { error: string }> {
  const user = await requireAuth();

  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const paystub = await db.paystub.findUnique({ where: { id: data.paystubId } });
  if (!paystub || paystub.archivedAt) return { error: "Paystub not found" };

  const pretaxTotal = data.pretaxDeductions.reduce((s, d) => s + d.amountCents, 0);
  const balanceDiffCents =
    data.grossPayCents - pretaxTotal - data.taxesCents - data.netPayCents;

  await db.paystub.update({
    where: { id: data.paystubId },
    data: {
      employeeName: data.employeeName ?? null,
      employerName: data.employerName ?? null,
      payPeriodStart: data.payPeriodStart
        ? new Date(`${data.payPeriodStart}T00:00:00Z`)
        : null,
      payPeriodEnd: data.payPeriodEnd ? new Date(`${data.payPeriodEnd}T00:00:00Z`) : null,
      payDate: new Date(`${data.payDate}T00:00:00Z`),
      payFrequency: data.payFrequency,
      grossPayCents: data.grossPayCents,
      pretaxDeductions: data.pretaxDeductions as unknown as never,
      taxesCents: data.taxesCents,
      taxBreakdown: data.taxBreakdown as unknown as never,
      additionalWithholding: data.additionalWithholding as unknown as never,
      netPayCents: data.netPayCents,
      balanceDiffCents,
      notes: data.notes ?? null,
      confirmedAt: new Date(),
      confirmedById: user.id,
    },
  });

  revalidatePath("/personal/income");
  revalidatePath(`/personal/income/${data.paystubId}`);
  return { success: true, balanceDiffCents };
}

// ── Sync paystub to IncomeSource (forecast tie-in) ─────────────────────────────

/**
 * Creates or updates the IncomeSource for an employee so the cash-flow
 * forecast reflects actual pay cadence and net take-home per paycheck.
 * The gross amount is used so pre-tax deductions still show as income in,
 * consistent with how budgets and actuals are tracked at the account level.
 */
export async function syncPaystubToIncomeSource(
  paystubId: string,
  accountId: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const paystub = await db.paystub.findUnique({ where: { id: paystubId } });
  if (!paystub || paystub.archivedAt) return { error: "Paystub not found" };
  if (!paystub.payFrequency) return { error: "Paystub has no pay frequency set" };
  if (!paystub.payDate) return { error: "Paystub has no pay date set" };

  const account = await db.account.findUnique({ where: { id: accountId, archivedAt: null } });
  if (!account) return { error: "Account not found" };
  if (account.entityId !== paystub.entityId) {
    return { error: "Account belongs to a different entity" };
  }

  const description = `${paystub.employeeName ?? "Employee"} payroll (${paystub.employerName ?? "employer"})`;

  let dayRules: Record<string, unknown>;
  if (paystub.payFrequency === "semi_monthly") {
    const payDay = paystub.payDate.getUTCDate();
    // Anchor on the stub's pay day and its mirror (15/30, 15/31, 16/30…)
    const second = payDay <= 15 ? 30 : 15;
    dayRules = { daysOfMonth: [Math.min(payDay, second), Math.max(payDay, second)] };
  } else if (paystub.payFrequency === "biweekly") {
    dayRules = { intervalDays: 14, anchorDate: paystub.payDate.toISOString().slice(0, 10) };
  } else if (paystub.payFrequency === "weekly") {
    dayRules = { dayOfWeek: paystub.payDate.getUTCDay() };
  } else {
    dayRules = { dayOfMonth: paystub.payDate.getUTCDate() };
  }

  const existing = await db.incomeSource.findFirst({
    where: { entityId: paystub.entityId, description },
  });

  const grossDollars = paystub.grossPayCents !== null ? paystub.grossPayCents / 100 : null;
  if (grossDollars === null) return { error: "Paystub has no gross pay amount" };

  if (existing) {
    await db.incomeSource.update({
      where: { id: existing.id },
      data: {
        accountId,
        cadence: paystub.payFrequency,
        dayRules: dayRules as unknown as never,
        amount: grossDollars.toFixed(2),
        active: true,
      },
    });
  } else {
    await db.incomeSource.create({
      data: {
        entityId: paystub.entityId,
        accountId,
        description,
        cadence: paystub.payFrequency,
        dayRules: dayRules as unknown as never,
        amount: grossDollars.toFixed(2),
        active: true,
      },
    });
  }

  revalidatePath("/personal/income");
  revalidatePath("/forecast");
  revalidatePath("/settings/income-sources");
  return { success: true };
}

// ── Archive paystub ───────────────────────────────────────────────────────────

export async function archivePaystub(paystubId: string): Promise<void> {
  await requireAuth();
  await db.paystub.update({
    where: { id: paystubId },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/personal/income");
}