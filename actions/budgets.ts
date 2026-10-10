"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { isLumpSumFrequency, isValidAnnualDay } from "@/lib/annual-bill";
import { currentPeriodNY } from "@/lib/month-spend";
import { addChangesEarlierMonth, formatPeriodLabel, isTooFarAhead } from "@/lib/budget-materialize";
import {
  BUDGET_TX_OPTIONS,
  BudgetRefusal,
  STALE_LINE_MESSAGE,
  TOO_FAR_AHEAD_MESSAGE,
  endLine,
  entitiesHoldingTag,
  lineIsInView,
  lockBudgetWrites,
  materializeForEdit,
  readBudgetRowsForWrite,
  type BudgetWriteRow,
} from "@/lib/budget-materialize-build";

// Every Budget action names a line by a LOCATOR { entityId, tagId, period } and never by a Budget id: a month with no
// row of its own shows carried lines (the carry-forward view) whose ids are synthetic, and the first change in such a
// month saves the whole carried set as real rows in the SAME transaction as the change (copy-on-first-edit,
// lib/budget-materialize*.ts). Each write runs in one interactive transaction that takes a global advisory lock first,
// so a double click or two tabs cannot create or overwrite anything twice.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthorized");
  return { id };
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const LocatorSchema = z.object({
  entityId: z.string().uuid(),
  tagId: z.string().uuid(),
  period: z.string().regex(PERIOD_PATTERN),
});

export type BudgetLineLocator = z.infer<typeof LocatorSchema>;

const UpdateSchema = z.object({
  budgeted: z
    .string()
    .trim()
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
    .optional(),
});

/** Runs the body inside one interactive transaction, lock first. A BudgetRefusal rolls everything back as a plain error. */
async function inBudgetTransaction<T>(
  body: (tx: Prisma.TransactionClient, rows: BudgetWriteRow[]) => Promise<T>
): Promise<T | { error: string }> {
  try {
    return await db.$transaction(async (tx) => {
      await lockBudgetWrites(tx);
      const rows = await readBudgetRowsForWrite(tx);
      return body(tx, rows);
    }, BUDGET_TX_OPTIONS);
  } catch (err) {
    if (err instanceof BudgetRefusal) return { error: err.message };
    throw err;
  }
}

function tooFarAhead(period: string): boolean {
  return isTooFarAhead(period, currentPeriodNY(new Date()));
}

export async function updateBudgetLine(
  locator: BudgetLineLocator,
  budgeted: string
): Promise<{ success: true } | { error: string }> {
  const user = await requireAuth();

  const loc = LocatorSchema.safeParse(locator);
  if (!loc.success) return { error: "Invalid budget line" };
  const parsed = UpdateSchema.safeParse({ budgeted });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid amount" };
  }
  if (tooFarAhead(loc.data.period)) return { error: TOO_FAR_AHEAD_MESSAGE };

  const budgetedDecimal = parsed.data.budgeted ? new Prisma.Decimal(parsed.data.budgeted) : null;

  const result = await inBudgetTransaction(async (tx, rows) => {
    if (!lineIsInView(rows, loc.data)) throw new BudgetRefusal(STALE_LINE_MESSAGE);
    await materializeForEdit(tx, user.id, rows, loc.data.entityId, loc.data.period);
    const current = await tx.budget.findUnique({
      where: { tagId_entityId_period: { tagId: loc.data.tagId, entityId: loc.data.entityId, period: loc.data.period } },
      select: { id: true },
    });
    if (!current) throw new BudgetRefusal(STALE_LINE_MESSAGE);
    await tx.budget.update({ where: { id: current.id }, data: { budgeted: budgetedDecimal } });
    return { success: true as const };
  });

  if ("success" in result) revalidateAll();
  return result;
}

// ── Annual-frequency validation ───────────────────────────────────────────────

const AMOUNT_DUE_REGEX = /^\d+(\.\d{1,2})?$/;

/**
 * An annual or semi-annual line needs a due month + day, the amount due, and a monthly set-aside
 * (the budget amount) — without the set-aside there is nothing accruing to check.
 * Returns an error message, or null when valid. Callers pass the EFFECTIVE values
 * (after merging with what's already stored on an update).
 */
function annualScheduleError(v: {
  payMonth: number | null | undefined;
  payDay: number | null | undefined;
  annualAmountDue: string | null | undefined;
  budgeted: string | null | undefined;
}): string | null {
  if (v.payMonth == null || v.payDay == null) return "Due month and day are required for an annual or semi-annual budget line";
  if (!isValidAnnualDay(v.payMonth, v.payDay)) return "That day does not exist in the selected month";
  if (!v.annualAmountDue || !AMOUNT_DUE_REGEX.test(v.annualAmountDue) || new Prisma.Decimal(v.annualAmountDue).lte(0)) {
    return "Amount due is required for an annual or semi-annual budget line (e.g. 4200.00)";
  }
  if (!v.budgeted || new Prisma.Decimal(v.budgeted).lte(0)) {
    return "A monthly budget amount is required for an annual or semi-annual line — it is the amount set aside each month";
  }
  return null;
}

// ── Internal helper ───────────────────────────────────────────────────────────

async function upsertBudgetBill(
  tx: Prisma.TransactionClient,
  tagId: string,
  entityId: string,
  accountId: string,
  budgeted: string | null,
  payDay: number | null,
  frequency: string,
  payDayOfWeek: number | null,
  biweeklyAnchorDate: Date | null,
  payMonth: number | null,
  annualAmountDue: string | null
) {
  const tag = await tx.tag.findUnique({ where: { id: tagId } });
  if (!tag) return;

  const expectedAmount = budgeted ? new Prisma.Decimal(budgeted) : null;
  const isLumpSum = isLumpSumFrequency(frequency);
  // For an annual bill, expectedAmount stays the MONTHLY set-aside (same
  // convention as every other frequency) and annualBudget holds the total due.
  const annualBudget = isLumpSum && annualAmountDue ? new Prisma.Decimal(annualAmountDue) : undefined;

  await tx.scheduledBill.upsert({
    where: { budgetTagId_budgetEntityId: { budgetTagId: tagId, budgetEntityId: entityId } },
    create: {
      accountId,
      entityId,
      payee: tag.shortName,
      amountType: "static",
      expectedAmount,
      autopayDay: payDay,
      frequency,
      payDayOfWeek,
      biweeklyAnchorDate,
      payMonth: isLumpSum ? payMonth : null,
      ...(annualBudget && { annualBudget }),
      budgetTagId: tagId,
      budgetEntityId: entityId,
      active: true,
    },
    update: {
      accountId,
      expectedAmount,
      autopayDay: payDay,
      frequency,
      payDayOfWeek,
      biweeklyAnchorDate,
      payMonth: isLumpSum ? payMonth : null,
      ...(annualBudget && { annualBudget }),
      // An annual/semi-annual bill is paid in one lump on its due date; an accrued-type
      // bill would ignore that schedule, so the line's choice wins.
      ...(isLumpSum && { amountType: "static" }),
      active: true,
    },
  });
}

function revalidateAll() {
  revalidatePath("/budgets");
  revalidatePath("/envelope");
  revalidatePath("/forecast");
  // The dashboard reads the same effective rows.
  revalidatePath("/");
}

// ── Create ────────────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  tagId: z.string().uuid(),
  entityId: z.string().uuid(),
  accountId: z.string().uuid(),
  period: z.string().regex(PERIOD_PATTERN),
  budgeted: z
    .string()
    .trim()
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
    .optional(),
  payDay: z.number().int().min(1).max(31).optional(),
  frequency: z.enum(["monthly", "weekly", "biweekly", "annual", "semiannual"]).optional(),
  payDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  biweeklyAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  payMonth: z.number().int().min(1).max(12).nullable().optional(),
  annualAmountDue: z.string().trim().nullable().optional(),
})
  .refine((data) => data.frequency !== "weekly" || data.payDayOfWeek != null, {
    message: "Day of week is required for a weekly budget line",
    path: ["payDayOfWeek"],
  })
  .refine(
    (data) =>
      data.frequency !== "biweekly" ||
      (data.payDayOfWeek != null && data.biweeklyAnchorDate != null),
    {
      message: "Day of week and anchor date are required for a biweekly budget line",
      path: ["biweeklyAnchorDate"],
    }
  )
  .superRefine((data, ctx) => {
    if (!isLumpSumFrequency(data.frequency)) return;
    const message = annualScheduleError({
      payMonth: data.payMonth,
      payDay: data.payDay,
      annualAmountDue: data.annualAmountDue,
      budgeted: data.budgeted,
    });
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

export async function createBudget(
  input: z.infer<typeof CreateSchema>
): Promise<{ success: true } | { error: string }> {
  const user = await requireAuth();

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const {
    tagId,
    entityId,
    accountId,
    period,
    budgeted,
    payDay,
    frequency,
    payDayOfWeek,
    biweeklyAnchorDate,
    payMonth,
    annualAmountDue,
  } = parsed.data;
  if (tooFarAhead(period)) return { error: TOO_FAR_AHEAD_MESSAGE };

  const budgetedDecimal = budgeted ? new Prisma.Decimal(budgeted) : null;
  const effectiveFrequency = frequency ?? "monthly";
  const effectivePayDayOfWeek = payDayOfWeek ?? null;
  const effectiveBiweeklyAnchorDate = biweeklyAnchorDate ? new Date(biweeklyAnchorDate) : null;
  const isLumpSum = isLumpSumFrequency(effectiveFrequency);
  const effectivePayMonth = isLumpSum ? payMonth ?? null : null;
  const effectiveAnnualAmountDue = isLumpSum && annualAmountDue ? new Prisma.Decimal(annualAmountDue) : null;

  const result = await inBudgetTransaction(async (tx, rows) => {
    // A tag can only be budgeted by one entity per period, household-wide — the UI's Add Budget Line dropdown already
    // hides tags used by ANY entity this period, but that's just a filtered list; enforce it here too so a stale
    // dropdown or a direct call can't create a cross-entity duplicate. The check reads the EFFECTIVE view (a carried
    // line counts, exactly like on the screen), inside the lock.
    const holders = entitiesHoldingTag(rows, tagId, period);
    if (holders.length > 0) {
      if (holders.includes(entityId)) throw new BudgetRefusal("This tag already has a budget line this period.");
      const other = await tx.entity.findUnique({ where: { id: holders[0] as string }, select: { name: true } });
      throw new BudgetRefusal(`This tag already has a budget line under ${other?.name ?? "another entity"} this period.`);
    }

    // Adding (or re-adding) a line must change nothing but its own month onward.
    const touched = addChangesEarlierMonth(rows, { entityId, tagId, period });
    if (touched) {
      throw new BudgetRefusal(
        `Adding this line here would also make it appear in ${formatPeriodLabel(touched)}, an earlier month that has no budget lines. Add it to that month first, or choose that month instead.`
      );
    }

    await materializeForEdit(tx, user.id, rows, entityId, period);

    await tx.budget.create({
      data: {
        tagId,
        entityId,
        accountId,
        period,
        budgeted: budgetedDecimal,
        payDay: payDay ?? null,
        frequency: effectiveFrequency,
        payDayOfWeek: effectivePayDayOfWeek,
        biweeklyAnchorDate: effectiveBiweeklyAnchorDate,
        payMonth: effectivePayMonth,
        annualAmountDue: effectiveAnnualAmountDue,
      },
    });

    if (
      payDay !== undefined ||
      effectiveFrequency === "weekly" ||
      effectiveFrequency === "biweekly" ||
      isLumpSum
    ) {
      await upsertBudgetBill(
        tx,
        tagId,
        entityId,
        accountId,
        budgeted ?? null,
        payDay ?? null,
        effectiveFrequency,
        effectivePayDayOfWeek,
        effectiveBiweeklyAnchorDate,
        effectivePayMonth,
        annualAmountDue ?? null
      );
    }
    return { success: true as const };
  });

  if ("success" in result) revalidateAll();
  return result;
}

// ── Update ────────────────────────────────────────────────────────────────────

const UpdateBudgetSchema = z.object({
  budgeted: z
    .string()
    .trim()
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
    .optional(),
  payDay: z.number().int().min(1).max(31).nullable().optional(),
  accountId: z.string().uuid().optional(),
  applyToFuture: z.boolean().optional(),
  frequency: z.enum(["monthly", "weekly", "biweekly", "annual", "semiannual"]).optional(),
  payDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  biweeklyAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  payMonth: z.number().int().min(1).max(12).nullable().optional(),
  annualAmountDue: z.string().trim().nullable().optional(),
})
  .refine((data) => data.frequency !== "weekly" || data.payDayOfWeek != null, {
    message: "Day of week is required for a weekly budget line",
    path: ["payDayOfWeek"],
  })
  .refine(
    (data) =>
      data.frequency !== "biweekly" ||
      (data.payDayOfWeek != null && data.biweeklyAnchorDate != null),
    {
      message: "Day of week and anchor date are required for a biweekly budget line",
      path: ["biweeklyAnchorDate"],
    }
  );

export async function updateBudget(
  locator: BudgetLineLocator,
  input: z.infer<typeof UpdateBudgetSchema>
): Promise<{ success: true } | { error: string }> {
  const user = await requireAuth();

  const loc = LocatorSchema.safeParse(locator);
  if (!loc.success) return { error: "Invalid budget line" };
  const parsed = UpdateBudgetSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  if (tooFarAhead(loc.data.period)) return { error: TOO_FAR_AHEAD_MESSAGE };

  const {
    budgeted,
    payDay,
    accountId,
    applyToFuture,
    frequency,
    payDayOfWeek,
    biweeklyAnchorDate,
    payMonth,
    annualAmountDue,
  } = parsed.data;

  const result = await inBudgetTransaction(async (tx, rows) => {
    if (!lineIsInView(rows, loc.data)) throw new BudgetRefusal(STALE_LINE_MESSAGE);
    await materializeForEdit(tx, user.id, rows, loc.data.entityId, loc.data.period);

    const current = await tx.budget.findUnique({
      where: { tagId_entityId_period: { tagId: loc.data.tagId, entityId: loc.data.entityId, period: loc.data.period } },
    });
    if (!current) throw new BudgetRefusal(STALE_LINE_MESSAGE);

    const effectiveFrequency = frequency !== undefined ? frequency : current.frequency;
    const isLumpSum = isLumpSumFrequency(effectiveFrequency);
    // Leaving annual clears the annual-only fields; staying annual keeps what's stored
    // unless the caller supplied a new value.
    const effectivePayMonth = isLumpSum ? (payMonth !== undefined ? payMonth : current.payMonth) : null;
    const effectiveAnnualAmountDue = isLumpSum
      ? annualAmountDue !== undefined
        ? annualAmountDue
        : current.annualAmountDue !== null
          ? current.annualAmountDue.toString()
          : null
      : null;

    // Three distinguishable states: omitted (undefined — no change), explicit
    // blank ("" — clear to auto-sum), explicit value.
    const newBudgetedRaw = budgeted !== undefined ? (budgeted === "" ? null : budgeted) : undefined;
    const newBiweeklyAnchorDate =
      biweeklyAnchorDate !== undefined ? (biweeklyAnchorDate ? new Date(biweeklyAnchorDate) : null) : undefined;

    if (isLumpSum) {
      const message = annualScheduleError({
        payMonth: effectivePayMonth,
        payDay: payDay !== undefined ? payDay : current.payDay,
        annualAmountDue: effectiveAnnualAmountDue,
        budgeted:
          newBudgetedRaw !== undefined ? newBudgetedRaw : current.budgeted !== null ? current.budgeted.toString() : null,
      });
      if (message) throw new BudgetRefusal(message);
    }

    const updateData: Prisma.BudgetUpdateInput = {};
    if (newBudgetedRaw !== undefined) {
      updateData.budgeted = newBudgetedRaw ? new Prisma.Decimal(newBudgetedRaw) : null;
    }
    if (payDay !== undefined) updateData.payDay = payDay;
    if (accountId !== undefined) updateData.account = { connect: { id: accountId } };
    if (frequency !== undefined) updateData.frequency = frequency;
    if (payDayOfWeek !== undefined) updateData.payDayOfWeek = payDayOfWeek;
    if (newBiweeklyAnchorDate !== undefined) updateData.biweeklyAnchorDate = newBiweeklyAnchorDate;
    // Only touch the annual-only columns when frequency is being set or they're supplied.
    if (frequency !== undefined || payMonth !== undefined || annualAmountDue !== undefined) {
      updateData.payMonth = effectivePayMonth;
      updateData.annualAmountDue = effectiveAnnualAmountDue ? new Prisma.Decimal(effectiveAnnualAmountDue) : null;
    }

    await tx.budget.update({ where: { id: current.id }, data: updateData });

    if (
      applyToFuture &&
      (payDay !== undefined ||
        accountId !== undefined ||
        frequency !== undefined ||
        payDayOfWeek !== undefined ||
        newBiweeklyAnchorDate !== undefined ||
        payMonth !== undefined ||
        annualAmountDue !== undefined)
    ) {
      // Only EXISTING later rows of this line are pushed. A later month that is still only carried follows by itself
      // (it carries from the latest row), and the months before this one are never touched.
      const futureBudgets = await tx.budget.findMany({
        where: {
          tagId: current.tagId,
          entityId: current.entityId,
          period: { gt: current.period },
        },
      });
      for (const fb of futureBudgets) {
        const fbData: Prisma.BudgetUpdateInput = {};
        if (payDay !== undefined) fbData.payDay = payDay;
        // accountId requires a relation update — update per record for the future periods
        if (accountId !== undefined) fbData.account = { connect: { id: accountId } };
        if (frequency !== undefined) fbData.frequency = frequency;
        if (payDayOfWeek !== undefined) fbData.payDayOfWeek = payDayOfWeek;
        if (newBiweeklyAnchorDate !== undefined) fbData.biweeklyAnchorDate = newBiweeklyAnchorDate;
        if (frequency !== undefined || payMonth !== undefined || annualAmountDue !== undefined) {
          fbData.payMonth = effectivePayMonth;
          fbData.annualAmountDue = effectiveAnnualAmountDue ? new Prisma.Decimal(effectiveAnnualAmountDue) : null;
        }
        await tx.budget.update({ where: { id: fb.id }, data: fbData });
      }
    }

    const effectivePayDay = payDay !== undefined ? payDay : current.payDay;
    const effectiveAccountId = accountId ?? current.accountId;
    const effectiveBudgeted =
      newBudgetedRaw !== undefined ? newBudgetedRaw : current.budgeted !== null ? current.budgeted.toString() : null;
    const effectivePayDayOfWeek = payDayOfWeek !== undefined ? payDayOfWeek : current.payDayOfWeek;
    const effectiveBiweeklyAnchorDate =
      newBiweeklyAnchorDate !== undefined ? newBiweeklyAnchorDate : current.biweeklyAnchorDate;

    if (
      (effectivePayDay !== null && effectivePayDay !== undefined) ||
      effectiveFrequency === "weekly" ||
      effectiveFrequency === "biweekly" ||
      isLumpSum
    ) {
      await upsertBudgetBill(
        tx,
        current.tagId,
        current.entityId,
        effectiveAccountId,
        effectiveBudgeted,
        effectivePayDay ?? null,
        effectiveFrequency,
        effectivePayDayOfWeek,
        effectiveBiweeklyAnchorDate,
        effectivePayMonth,
        effectiveAnnualAmountDue
      );
    } else if (payDay === null) {
      await tx.scheduledBill.updateMany({
        where: { budgetTagId: current.tagId, budgetEntityId: current.entityId },
        data: { active: false },
      });
    }
    return { success: true as const };
  });

  if ("success" in result) revalidateAll();
  return result;
}

// ── Additional recurring buffer ────────────────────────────────────────────────

export async function updateBudgetAdditionalAmount(
  locator: BudgetLineLocator,
  amountCents: number
): Promise<{ success: true } | { error: string }> {
  const user = await requireAuth();
  const loc = LocatorSchema.safeParse(locator);
  if (!loc.success) return { error: "Invalid budget line" };
  if (!Number.isInteger(amountCents) || amountCents < 0)
    return { error: "Amount must be a non-negative integer (cents)" };
  if (tooFarAhead(loc.data.period)) return { error: TOO_FAR_AHEAD_MESSAGE };

  const result = await inBudgetTransaction(async (tx, rows) => {
    if (!lineIsInView(rows, loc.data)) throw new BudgetRefusal(STALE_LINE_MESSAGE);
    await materializeForEdit(tx, user.id, rows, loc.data.entityId, loc.data.period);
    const current = await tx.budget.findUnique({
      where: { tagId_entityId_period: { tagId: loc.data.tagId, entityId: loc.data.entityId, period: loc.data.period } },
      select: { id: true },
    });
    if (!current) throw new BudgetRefusal(STALE_LINE_MESSAGE);
    // The additional amount is a per-month top-up: it is set on this month's row only and is never carried forward.
    await tx.budget.update({
      where: { id: current.id },
      data: { additionalAmountCents: new Prisma.Decimal(amountCents) },
    });
    return { success: true as const };
  });

  if ("success" in result) revalidateAll();
  return result;
}

// ── Delete = end the line from this month on ──────────────────────────────────

export async function deleteBudget(
  locator: BudgetLineLocator
): Promise<{ success: true; removedMonths: number } | { error: string }> {
  const user = await requireAuth();
  const loc = LocatorSchema.safeParse(locator);
  if (!loc.success) return { error: "Invalid budget line" };
  if (tooFarAhead(loc.data.period)) return { error: TOO_FAR_AHEAD_MESSAGE };

  const result = await inBudgetTransaction(async (tx, rows) => {
    const ended = await endLine(tx, user.id, rows, loc.data);
    if (!ended.ok) {
      // Already gone (a second click, or another tab got there first): the end state is what was asked for.
      if (ended.reason === "not_in_view") return { success: true as const, removedMonths: 0 };
      throw new BudgetRefusal(
        `This is the only line left in ${formatPeriodLabel(ended.frontier)}; add another line or remove it from the earlier month.`
      );
    }

    await tx.scheduledBill.updateMany({
      where: { budgetTagId: loc.data.tagId, budgetEntityId: loc.data.entityId },
      data: { active: false },
    });
    return { success: true as const, removedMonths: ended.removedMonths };
  });

  if ("success" in result) revalidateAll();
  return result;
}
