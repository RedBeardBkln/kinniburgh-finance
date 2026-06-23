"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export interface DashboardTransaction {
  id: string;
  postedAt: string;
  payeeRaw: string;
  amount: string;
  amountNum: number;
  tagIds: string[];
}

export async function getTagTransactions(
  tagId: string,
  period: string,
  entityId?: string
): Promise<DashboardTransaction[]> {
  await requireAuth();

  const parts = period.split("-").map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      transferPairId: null,
      postedAt: { gte: monthStart, lt: monthEnd },
      tags: { some: { tagId } },
      ...(entityId ? { entityId } : {}),
    },
    include: {
      tags: { select: { tagId: true } },
    },
    orderBy: { postedAt: "desc" },
    take: 200,
  });

  return transactions.map((tx) => {
    const amount = new Prisma.Decimal(tx.amount);
    return {
      id: tx.id,
      postedAt: tx.postedAt.toISOString(),
      payeeRaw: tx.payeeRaw ?? tx.payeeNormalized ?? "—",
      amount: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amount.toNumber()),
      amountNum: amount.toNumber(),
      tagIds: tx.tags.map((t) => t.tagId),
    };
  });
}
