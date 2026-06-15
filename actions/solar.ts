"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const solarEntrySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  billAmountCents: z.number().int().min(0),
  usageKwh: z.number().min(0).optional(),
  gridCreditCents: z.number().int().min(0).optional(),
  documentId: z.string().uuid().optional(),
});

export async function listSolarEntries() {
  await requireAuth();
  return db.solarEntry.findMany({
    orderBy: { period: "asc" },
  });
}

export async function addSolarEntry(input: z.infer<typeof solarEntrySchema>) {
  await requireAuth();
  const data = solarEntrySchema.parse(input);
  const entry = await db.solarEntry.create({
    data: {
      ...data,
      usageKwh: data.usageKwh != null ? new Prisma.Decimal(data.usageKwh) : null,
    },
  });
  revalidatePath("/personal/solar");
  return entry;
}

export async function updateSolarEntry(
  id: string,
  input: Partial<z.infer<typeof solarEntrySchema>>
) {
  await requireAuth();
  const entry = await db.solarEntry.update({
    where: { id },
    data: {
      ...input,
      usageKwh: input.usageKwh != null ? new Prisma.Decimal(input.usageKwh) : undefined,
    },
  });
  revalidatePath("/personal/solar");
  return entry;
}
