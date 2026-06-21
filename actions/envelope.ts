"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  generateTransferOccurrences,
  generateBillOccurrences,
  generateIncomeOccurrences,
  buildAccountForecast,
  findBreachDays,
  computeSuggestedTransferIncrease,
  type ScheduleEvent,
} from "@/lib/forecast";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function getEnvelopeSummary() {
  const [transfers, bills, accruals, incomes] = await Promise.all([
    db.scheduledTransfer.findMany({
      include: { fromAccount: true, toAccount: true },
      orderBy: { createdAt: "asc" },
    }),
    db.scheduledBill.findMany({
      where: { active: true },
      include: { account: { include: { institution: true } }, entity: true },
      orderBy: [{ account: { nickname: "asc" } }, { payee: "asc" }],
    }),
    db.accrualEnvelope.findMany({
      include: { account: true },
      orderBy: { name: "asc" },
    }),
    db.incomeSource.findMany({
      where: { active: true },
      include: { account: true, entity: true },
      orderBy: { description: "asc" },
    }),
  ]);

  // Determine if the Slush Funds proposal is still pending
  // (no active transfer from x2566 → x3612 exists yet)
  const slushAccount = await db.account.findFirst({
    where: { nickname: "Slush Funds" },
  });
  const primaryAccount = await db.account.findFirst({
    where: { nickname: "Primary Checking" },
  });

  const slushTransferExists =
    slushAccount && primaryAccount
      ? transfers.some(
          (t) =>
            t.active &&
            t.fromAccountId === primaryAccount.id &&
            t.toAccountId === slushAccount.id
        )
      : false;

  return {
    transfers,
    bills,
    accruals,
    incomes,
    slushTransferExists,
    slushAccountId: slushAccount?.id ?? null,
    primaryAccountId: primaryAccount?.id ?? null,
  };
}

// ── Slush Funds proposal approval ────────────────────────────────────────────

const approveSlushSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  dayOfWeek: z.number().int().min(0).max(6),
});

export async function approveSlushFundsTransfer(
  input: z.infer<typeof approveSlushSchema>
) {
  await requireAuth();
  const { amount, dayOfWeek } = approveSlushSchema.parse(input);

  const [primary, slush] = await Promise.all([
    db.account.findFirst({ where: { nickname: "Primary Checking" } }),
    db.account.findFirst({ where: { nickname: "Slush Funds" } }),
  ]);
  if (!primary || !slush) throw new Error("Accounts not found");

  // Guard: don't create a duplicate
  const existing = await db.scheduledTransfer.findFirst({
    where: { fromAccountId: primary.id, toAccountId: slush.id, active: true },
  });
  if (existing) throw new Error("Slush Funds transfer already exists");

  await db.scheduledTransfer.create({
    data: {
      fromAccountId: primary.id,
      toAccountId: slush.id,
      amount: new Prisma.Decimal(amount),
      cadence: "weekly",
      dayRules: { dayOfWeek },
      purpose: "Slush Funds / Home projects (owner-approved)",
      active: true,
    },
  });

  revalidatePath("/envelope");
  revalidatePath("/forecast");
  return { success: true };
}

// ── Update scheduled transfer ─────────────────────────────────────────────────

const updateTransferSchema = z.object({
  id: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  dayRules: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
});

export async function updateScheduledTransfer(
  input: z.infer<typeof updateTransferSchema>
) {
  await requireAuth();
  const { id, ...patch } = updateTransferSchema.parse(input);

  const data: Prisma.ScheduledTransferUpdateInput = {};
  if (patch.amount !== undefined) data.amount = new Prisma.Decimal(patch.amount);
  if (patch.dayRules !== undefined) data.dayRules = patch.dayRules as Prisma.InputJsonValue;
  if (patch.active !== undefined) data.active = patch.active;

  await db.scheduledTransfer.update({ where: { id }, data });

  revalidatePath("/envelope");
  revalidatePath("/forecast");
  return { success: true };
}

// ── Update accrual balance ────────────────────────────────────────────────────

export async function updateAccrualBalance(id: string, balance: string) {
  const user = await requireAuth();

  const envelope = await db.accrualEnvelope.findUnique({ where: { id } });
  if (!envelope) throw new Error("Accrual envelope not found");

  const newBalance = new Prisma.Decimal(balance);
  const oldBalance = new Prisma.Decimal(envelope.currentBalance);

  await db.accrualEnvelope.update({
    where: { id },
    data: { currentBalance: newBalance },
  });

  await db.auditLog.create({
    data: {
      changedBy: user.id!,
      changeType: "accrual_balance_update",
      before: { envelopeId: id, balance: oldBalance.toString() },
      after: { envelopeId: id, balance: newBalance.toString() },
    },
  });

  revalidatePath("/envelope");
  revalidatePath("/forecast");
  return { success: true };
}

// ── Set account balance (for forecast starting point) ────────────────────────

export async function setAccountBalance(accountId: string, balance: string) {
  await requireAuth();

  await db.account.update({
    where: { id: accountId },
    data: {
      currentBalance: new Prisma.Decimal(balance),
      currentBalanceAt: new Date(),
    },
  });

  revalidatePath("/forecast");
  return { success: true };
}

// ── Upsert income source ──────────────────────────────────────────────────────

const incomeSourceSchema = z.object({
  id: z.string().uuid().optional(),
  entityId: z.string().uuid(),
  accountId: z.string().uuid(),
  description: z.string().min(1).max(100),
  cadence: z.enum(["semi_monthly", "biweekly", "monthly", "weekly"]),
  dayRules: z.record(z.unknown()),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  active: z.boolean().default(true),
});

export async function upsertIncomeSource(
  input: z.infer<typeof incomeSourceSchema>
) {
  await requireAuth();
  const parsed = incomeSourceSchema.parse(input);

  if (parsed.id) {
    await db.incomeSource.update({
      where: { id: parsed.id },
      data: {
        description: parsed.description,
        cadence: parsed.cadence,
        dayRules: parsed.dayRules as Prisma.InputJsonValue,
        amount: new Prisma.Decimal(parsed.amount),
        active: parsed.active,
      },
    });
  } else {
    await db.incomeSource.create({
      data: {
        entityId: parsed.entityId,
        accountId: parsed.accountId,
        description: parsed.description,
        cadence: parsed.cadence,
        dayRules: parsed.dayRules as Prisma.InputJsonValue,
        amount: new Prisma.Decimal(parsed.amount),
        active: parsed.active,
      },
    });
  }

  revalidatePath("/forecast");
  return { success: true };
}

// ── Envelope solvency forecast ────────────────────────────────────────────────

export interface EnvelopeForecastResult {
  accountId: string;
  accountName: string;
  mask: string;
  currentBalance: number | null;
  minimumBalance: number;
  minimumBalanceFee: number;
  breachDays: number;
  firstBreachDate: string | null;
  worstBalance: number | null;
  suggestedIncrease: number | null;
  incomingTransferId: string | null;
  incomingTransferCadence: string | null;
  feeAppliedThisPeriod: boolean;
  billsThisMonth: { payee: string; dueDay: number | null; expectedAmount: number | null }[];
}

export async function getEnvelopeForecastData(): Promise<EnvelopeForecastResult[]> {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + 30 * 86400000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const accounts = await db.account.findMany({
    where: {
      archivedAt: null,
      minimumBalance: { not: null },
      accountType: "checking",
    },
    include: {
      scheduledTransfersTo: { where: { active: true } },
      scheduledTransfersFrom: { where: { active: true } },
      scheduledBills: { where: { active: true } },
      incomeSources: { where: { active: true } },
    },
  });

  const results: EnvelopeForecastResult[] = [];

  for (const account of accounts) {
    const minimumBalance = new Prisma.Decimal(account.minimumBalance!);
    const minimumBalanceFee = account.minimumBalanceFee
      ? new Prisma.Decimal(account.minimumBalanceFee).toNumber()
      : 15;

    // Collect events: inbound transfers, outbound transfers, bills, income
    const events: ScheduleEvent[] = [];
    for (const t of account.scheduledTransfersTo) {
      events.push(
        ...generateTransferOccurrences(t, from, to).filter((e) => e.accountId === account.id)
      );
    }
    for (const t of account.scheduledTransfersFrom) {
      events.push(
        ...generateTransferOccurrences(t, from, to).filter((e) => e.accountId === account.id)
      );
    }
    for (const b of account.scheduledBills) {
      events.push(...generateBillOccurrences(b, from, to));
    }
    for (const s of account.incomeSources) {
      events.push(...generateIncomeOccurrences(s, from, to));
    }

    // Transfer occurrence dates for suggested-increase calculation
    const transferDates = events
      .filter((e) => e.type === "transfer_in")
      .map((e) => e.date);

    // The primary incoming transfer (for label in UI)
    const primaryTransfer = account.scheduledTransfersTo[0] ?? null;

    if (account.currentBalance === null) {
      results.push({
        accountId: account.id,
        accountName: account.nickname,
        mask: account.mask ?? "",
        currentBalance: null,
        minimumBalance: minimumBalance.toNumber(),
        minimumBalanceFee,
        breachDays: 0,
        firstBreachDate: null,
        worstBalance: null,
        suggestedIncrease: null,
        incomingTransferId: primaryTransfer?.id ?? null,
        incomingTransferCadence: primaryTransfer?.cadence ?? null,
        feeAppliedThisPeriod: false,
        billsThisMonth: account.scheduledBills.map((b) => ({
          payee: b.payee,
          dueDay: b.autopayDay,
          expectedAmount: b.expectedAmount ? new Prisma.Decimal(b.expectedAmount).toNumber() : null,
        })),
      });
      continue;
    }

    const forecast = buildAccountForecast(
      new Prisma.Decimal(account.currentBalance),
      events,
      minimumBalance,
      from,
      to
    );

    const breachDaysList = findBreachDays(forecast);
    const firstBreachDate = breachDaysList[0]?.date.toISOString().slice(0, 10) ?? null;

    let worstBalance: Prisma.Decimal | null = null;
    for (const d of forecast) {
      if (worstBalance === null || d.balanceAfter.lessThan(worstBalance)) {
        worstBalance = d.balanceAfter;
      }
    }

    const suggestedIncreaseDecimal = computeSuggestedTransferIncrease(
      forecast,
      minimumBalance,
      transferDates
    );

    const feeAppliedThisPeriod = !!(await db.transaction.findFirst({
      where: {
        accountId: account.id,
        description: "TD Bank Minimum Balance Fee",
        postedAt: { gte: monthStart },
      },
    }));

    results.push({
      accountId: account.id,
      accountName: account.nickname,
      mask: account.mask ?? "",
      currentBalance: new Prisma.Decimal(account.currentBalance).toNumber(),
      minimumBalance: minimumBalance.toNumber(),
      minimumBalanceFee,
      breachDays: breachDaysList.length,
      firstBreachDate,
      worstBalance: worstBalance?.toNumber() ?? null,
      suggestedIncrease: suggestedIncreaseDecimal?.toNumber() ?? null,
      incomingTransferId: primaryTransfer?.id ?? null,
      incomingTransferCadence: primaryTransfer?.cadence ?? null,
      feeAppliedThisPeriod,
      billsThisMonth: account.scheduledBills.map((b) => ({
        payee: b.payee,
        dueDay: b.autopayDay,
        expectedAmount: b.expectedAmount ? new Prisma.Decimal(b.expectedAmount).toNumber() : null,
      })),
    });
  }

  return results;
}
