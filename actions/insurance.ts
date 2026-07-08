"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const policySchema = z.object({
  entityId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  policyType: z.enum(["term", "whole", "ul", "property", "auto", "motorcycle", "other"]),
  insurer: z.string().min(1).max(200),
  policyNumber: z.string().max(100).optional(),
  faceAmountCents: z.number().int().positive().optional(),
  monthlyPremiumCents: z.number().int().positive().optional(),
  effectiveDate: z.string().optional(),
  expiryDate: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export async function listPolicies(entityId?: string) {
  await requireAuth();
  return db.insurancePolicy.findMany({
    where: {
      archivedAt: null,
      ...(entityId && { entityId }),
    },
    include: {
      cashValueEntries: { orderBy: { asOf: "asc" } },
      document: { select: { id: true, extractionStatus: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function createPolicy(input: z.infer<typeof policySchema>) {
  await requireAuth();
  const data = policySchema.parse(input);
  const policy = await db.insurancePolicy.create({
    data: {
      ...data,
      effectiveDate: data.effectiveDate ? new Date(data.effectiveDate) : null,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
    },
  });
  revalidatePath("/personal/insurance");
  return policy;
}

export async function updatePolicy(
  id: string,
  input: Partial<z.infer<typeof policySchema>>
) {
  await requireAuth();
  const policy = await db.insurancePolicy.update({
    where: { id },
    data: {
      ...input,
      effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : undefined,
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
    },
  });
  revalidatePath("/personal/insurance");
  return policy;
}

export async function archivePolicy(id: string) {
  await requireAuth();
  await db.insurancePolicy.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/personal/insurance");
}

export async function addCashValueEntry(
  policyId: string,
  input: { asOf: string; cashValueCents: number; notes?: string }
) {
  await requireAuth();
  const entry = await db.policyCashValue.create({
    data: {
      policyId,
      asOf: new Date(input.asOf),
      cashValueCents: input.cashValueCents,
      notes: input.notes,
    },
  });
  revalidatePath("/personal/insurance");
  return entry;
}
