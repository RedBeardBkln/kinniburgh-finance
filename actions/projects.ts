"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { Decimal } from "@prisma/client/runtime/library";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const createSchema = z.object({
  name: z.string().min(1, "Name required"),
  description: z.string().optional(),
  entityId: z.string().optional(),
  budget: z.number().positive("Budget must be positive"),
  targetDate: z.string().optional(),
  accountId: z.string().optional(),
});

export async function listProjects() {
  await requireAuth();
  return db.project.findMany({
    where: { archivedAt: null },
    include: {
      entity: { select: { id: true, name: true, navLabel: true, slug: true } },
      account: { select: { id: true, nickname: true, mask: true } },
      _count: { select: { transactions: { where: { archivedAt: null } }, receipts: { where: { archivedAt: null } } } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
}

export async function getProject(id: string) {
  await requireAuth();
  return db.project.findUnique({
    where: { id },
    include: {
      entity: { select: { id: true, name: true, navLabel: true, slug: true } },
      account: { select: { id: true, nickname: true, mask: true } },
    },
  });
}

export async function getProjectSpend(projectId: string): Promise<{
  transactionTotal: Decimal;
  receiptTotal: Decimal;
  total: Decimal;
}> {
  await requireAuth();
  const [txRows, receiptRows] = await Promise.all([
    db.transaction.findMany({
      where: { projectId, archivedAt: null },
      select: { amount: true },
    }),
    db.receipt.findMany({
      where: { projectId, archivedAt: null, total: { not: null } },
      select: { total: true },
    }),
  ]);

  // Transactions: outflows are negative — take absolute value of negative amounts as spend
  const transactionTotal = txRows.reduce((sum, t) => {
    const amt = new Decimal(t.amount.toString());
    return sum.plus(amt.isNegative() ? amt.abs() : new Decimal(0));
  }, new Decimal(0));

  const receiptTotal = receiptRows.reduce((sum, r) => {
    return sum.plus(new Decimal(r.total!.toString()).abs());
  }, new Decimal(0));

  return {
    transactionTotal,
    receiptTotal,
    total: transactionTotal.plus(receiptTotal),
  };
}

export async function getProjectTransactions(projectId: string) {
  await requireAuth();
  return db.transaction.findMany({
    where: { projectId, archivedAt: null },
    include: {
      account: { select: { id: true, nickname: true, mask: true, entityId: true } },
      entity: { select: { id: true, name: true, navLabel: true } },
      tags: { include: { tag: { select: { id: true, name: true, shortName: true } } } },
    },
    orderBy: { postedAt: "desc" },
  });
}

export async function getProjectReceipts(projectId: string) {
  await requireAuth();
  return db.receipt.findMany({
    where: { projectId, archivedAt: null },
    include: { entity: { select: { id: true, name: true, navLabel: true } } },
    orderBy: { receiptDate: "desc" },
  });
}

export async function createProject(data: z.infer<typeof createSchema>) {
  await requireAuth();
  const parsed = createSchema.parse(data);
  const project = await db.project.create({
    data: {
      name: parsed.name,
      description: parsed.description,
      entityId: parsed.entityId ?? null,
      budget: parsed.budget,
      targetDate: parsed.targetDate ? new Date(parsed.targetDate) : undefined,
      accountId: parsed.accountId ?? null,
    },
  });
  revalidatePath("/projects");
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    entityId: string | null;
    budget: number;
    targetDate: string | null;
    status: string;
  }>
) {
  await requireAuth();
  const project = await db.project.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.entityId !== undefined && { entityId: patch.entityId }),
      ...(patch.budget !== undefined && { budget: patch.budget }),
      ...(patch.targetDate !== undefined && {
        targetDate: patch.targetDate ? new Date(patch.targetDate) : null,
      }),
      ...(patch.status !== undefined && { status: patch.status }),
    },
  });
  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
  return project;
}

export async function archiveProject(id: string) {
  await requireAuth();
  await db.project.update({ where: { id }, data: { archivedAt: new Date() } });
  revalidatePath("/projects");
}

export async function assignTransactionToProject(
  transactionId: string,
  projectId: string | null
) {
  await requireAuth();
  await db.transaction.update({
    where: { id: transactionId, archivedAt: null },
    data: { projectId },
  });
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

export async function assignReceiptToProject(
  receiptId: string,
  projectId: string | null
) {
  await requireAuth();
  await db.receipt.update({
    where: { id: receiptId, archivedAt: null },
    data: { projectId },
  });
  if (projectId) revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

/** Legacy: was used by old savings-goal Slush Funds page. Kept for backward compat. */
export async function proposedTransferAmount(accountId: string): Promise<{
  hasTransfer: boolean;
  suggestedWeeklyCents: number;
}> {
  await requireAuth();
  const existing = await db.scheduledTransfer.findFirst({
    where: { toAccountId: accountId, active: true },
  });
  return { hasTransfer: !!existing, suggestedWeeklyCents: 27700 };
}
