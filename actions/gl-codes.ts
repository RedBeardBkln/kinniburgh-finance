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

const GL_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

const createSchema = z.object({
  entityId: z.string().uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  type: z.enum(GL_TYPES),
});

export async function listGlCodes(entityId: string) {
  await requireAuth();
  return db.glCode.findMany({
    where: { entityId },
    orderBy: [{ type: "asc" }, { code: "asc" }],
  });
}

export async function createGlCode(input: z.infer<typeof createSchema>) {
  await requireAuth();
  const data = createSchema.parse(input);
  await db.glCode.upsert({
    where: { entityId_code: { entityId: data.entityId, code: data.code } },
    update: { name: data.name, type: data.type },
    create: data,
  });
  revalidatePath("/business");
}

export async function updateGlCode(id: string, patch: { name?: string; type?: string }) {
  await requireAuth();
  const data = z.object({ name: z.string().min(1).max(100).optional(), type: z.enum(GL_TYPES).optional() }).parse(patch);
  await db.glCode.update({ where: { id }, data });
  revalidatePath("/business");
}

export async function deleteGlCode(id: string) {
  await requireAuth();
  const inUse = await db.transaction.count({ where: { glCodeId: id } });
  if (inUse > 0) throw new Error("GL code is in use by transactions and cannot be deleted.");
  await db.glCode.delete({ where: { id } });
  revalidatePath("/business");
}

export async function assignGlCode(transactionId: string, glCodeId: string | null) {
  const user = await requireAuth();
  await db.transaction.update({ where: { id: transactionId }, data: { glCodeId } });
  await db.auditLog.create({
    data: {
      transactionId,
      changedBy: user.id!,
      changeType: "gl_code_assigned",
      before: {},
      after: { glCodeId },
    },
  });
  revalidatePath("/business");
}
