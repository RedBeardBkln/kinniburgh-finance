"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const assetSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["real_estate", "vehicle", "other"]),
  valueCents: z.number().int().positive(),
  asOf: z.string(),
  notes: z.string().optional(),
});

export async function listManualAssets() {
  await requireAuth();
  return db.manualAsset.findMany({
    where: { archivedAt: null },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
}

export async function createManualAsset(data: z.infer<typeof assetSchema>) {
  await requireAuth();
  const parsed = assetSchema.parse(data);
  const asset = await db.manualAsset.create({
    data: { ...parsed, asOf: new Date(parsed.asOf) },
  });
  revalidatePath("/personal/net-worth");
  return asset;
}

export async function updateManualAsset(
  id: string,
  patch: Partial<z.infer<typeof assetSchema>>
) {
  await requireAuth();
  const asset = await db.manualAsset.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.category !== undefined && { category: patch.category }),
      ...(patch.valueCents !== undefined && { valueCents: patch.valueCents }),
      ...(patch.asOf !== undefined && { asOf: new Date(patch.asOf) }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    },
  });
  revalidatePath("/personal/net-worth");
  return asset;
}

export async function archiveManualAsset(id: string) {
  await requireAuth();
  await db.manualAsset.update({ where: { id }, data: { archivedAt: new Date() } });
  revalidatePath("/personal/net-worth");
}

export interface NetWorthBreakdown {
  accounts: Array<{ nickname: string; accountType: string; balanceCents: number; isLiability: boolean }>;
  manualAssets: Array<{ name: string; category: string; valueCents: number }>;
  cashValues: Array<{ policyName: string; cashValueCents: number }>;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  netWorthCents: number;
  missingBalances: string[];
}

const LIABILITY_TYPES = new Set(["credit_card", "mortgage", "loan"]);

export async function computeNetWorth(): Promise<NetWorthBreakdown> {
  await requireAuth();

  const [rawAccounts, manualAssets, policies] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null },
      select: { id: true, nickname: true, accountType: true, currentBalance: true },
    }),
    db.manualAsset.findMany({
      where: { archivedAt: null },
      select: { name: true, category: true, valueCents: true },
    }),
    db.insurancePolicy.findMany({
      where: { archivedAt: null },
      include: { cashValueEntries: { orderBy: { asOf: "desc" }, take: 1 } },
    }),
  ]);

  const missingBalances: string[] = [];
  const accountRows: NetWorthBreakdown["accounts"] = [];

  for (const a of rawAccounts) {
    if (a.currentBalance === null) {
      missingBalances.push(a.nickname);
      continue;
    }
    const isLiability = LIABILITY_TYPES.has(a.accountType);
    const balanceCents = Math.abs(Math.round(a.currentBalance.toNumber() * 100));
    accountRows.push({ nickname: a.nickname, accountType: a.accountType, balanceCents, isLiability });
  }

  const cashValues: NetWorthBreakdown["cashValues"] = policies
    .filter((p) => p.cashValueEntries.length > 0)
    .map((p) => ({
      policyName: `${p.insurer} ${p.policyType}`,
      cashValueCents: p.cashValueEntries[0]!.cashValueCents,
    }));

  // ── Totals ────────────────────────────────────────────────────────────────
  const assetAccountCents = accountRows
    .filter((a) => !a.isLiability)
    .reduce((s, a) => s + a.balanceCents, 0);

  const liabilityCents = accountRows
    .filter((a) => a.isLiability)
    .reduce((s, a) => s + a.balanceCents, 0);

  const manualAssetCents = manualAssets.reduce((s, a) => s + a.valueCents, 0);
  const cashValueCents = cashValues.reduce((s, c) => s + c.cashValueCents, 0);

  const totalAssetsCents = assetAccountCents + manualAssetCents + cashValueCents;
  const totalLiabilitiesCents = liabilityCents;
  const netWorthCents = totalAssetsCents - totalLiabilitiesCents;

  return {
    accounts: accountRows,
    manualAssets: manualAssets.map((a) => ({ name: a.name, category: a.category, valueCents: a.valueCents })),
    cashValues,
    totalAssetsCents,
    totalLiabilitiesCents,
    netWorthCents,
    missingBalances,
  };
}

export async function snapshotNetWorth() {
  await requireAuth();
  const nw = await computeNetWorth();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  await db.netWorthSnapshot.upsert({
    where: { date: today },
    create: {
      date: today,
      totalAssetsCents: nw.totalAssetsCents,
      totalLiabilitiesCents: nw.totalLiabilitiesCents,
      netWorthCents: nw.netWorthCents,
      data: nw as unknown as Prisma.InputJsonValue,
    },
    update: {
      totalAssetsCents: nw.totalAssetsCents,
      totalLiabilitiesCents: nw.totalLiabilitiesCents,
      netWorthCents: nw.netWorthCents,
      data: nw as unknown as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/personal/net-worth");
  return nw;
}
