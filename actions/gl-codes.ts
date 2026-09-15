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

const GL_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;

const createSchema = z.object({
  entityId: z.string().uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  type: z.enum(GL_TYPES),
});

export async function listGlCodes(entityId: string) {
  await requireAuth();
  return db.glCode.findMany({
    where: { entityId, archivedAt: null },
    orderBy: [{ type: "asc" }, { code: "asc" }],
  });
}

export async function listArchivedGlCodes(entityId: string) {
  await requireAuth();
  return db.glCode.findMany({
    where: { entityId, archivedAt: { not: null } },
    orderBy: [{ type: "asc" }, { code: "asc" }],
  });
}

export async function createGlCode(input: z.infer<typeof createSchema>) {
  await requireAuth();
  const data = createSchema.parse(input);
  const glCode = await db.glCode.upsert({
    where: { entityId_code: { entityId: data.entityId, code: data.code } },
    update: { name: data.name, type: data.type, archivedAt: null },
    create: data,
  });
  revalidatePath("/business");
  return { id: glCode.id, code: glCode.code, name: glCode.name, type: glCode.type };
}

export async function updateGlCode(id: string, patch: { name?: string; type?: string }) {
  await requireAuth();
  const data = z.object({ name: z.string().min(1).max(100).optional(), type: z.enum(GL_TYPES).optional() }).parse(patch);
  await db.glCode.update({ where: { id }, data });
  revalidatePath("/business");
}

export async function deleteGlCode(id: string): Promise<{ mode: "deleted" | "archived" }> {
  await requireAuth();
  const inUse = await db.transaction.count({ where: { glCodeId: id } });
  const mappedByTags = await db.tagGlCodeMapping.count({ where: { glCodeId: id } });

  if (inUse === 0 && mappedByTags === 0) {
    await db.glCode.delete({ where: { id } });
    revalidatePath("/business");
    return { mode: "deleted" };
  }

  await db.$transaction([
    db.glCode.update({ where: { id }, data: { archivedAt: new Date() } }),
    ...(mappedByTags > 0 ? [db.tagGlCodeMapping.deleteMany({ where: { glCodeId: id } })] : []),
  ]);
  revalidatePath("/business");
  return { mode: "archived" };
}

export async function restoreGlCode(id: string) {
  await requireAuth();
  await db.glCode.update({ where: { id }, data: { archivedAt: null } });
  revalidatePath("/business");
}

export async function getGlCodeUsageImpact(
  id: string
): Promise<{ transactionCount: number; distinctPeriods: number }> {
  await requireAuth();
  const [transactionCount, periodRows] = await Promise.all([
    db.transaction.count({ where: { glCodeId: id } }),
    db.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(DISTINCT to_char("postedAt", 'YYYY-MM')) AS cnt
      FROM "Transaction"
      WHERE "glCodeId" = ${id}
    `,
  ]);
  const distinctPeriods = Number(periodRows[0]?.cnt ?? 0);
  return { transactionCount, distinctPeriods };
}

const ImportRowSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  type: z.enum(GL_TYPES),
});

export async function importGlCodes(
  entityId: string,
  rows: z.infer<typeof ImportRowSchema>[]
): Promise<{ imported: number; errors: string[] }> {
  await requireAuth();
  z.string().uuid().parse(entityId);

  const errors: string[] = [];
  let imported = 0;

  for (let i = 0; i < rows.length; i++) {
    const result = ImportRowSchema.safeParse(rows[i]);
    if (!result.success) {
      errors.push(`Row ${i + 1}: ${result.error.issues.map((e) => e.message).join(", ")}`);
      continue;
    }
    const { code, name, type } = result.data;
    await db.glCode.upsert({
      where: { entityId_code: { entityId, code } },
      update: { name, type, archivedAt: null },
      create: { entityId, code, name, type },
    });
    imported++;
  }

  revalidatePath("/business");
  return { imported, errors };
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
