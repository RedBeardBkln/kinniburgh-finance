"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveGlCodeForTags, autoAssignGlCodes } from "@/lib/gl-code-resolver";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

// ─── Mapping list (tags-in-use + unused-tag affordance) ────────────────────

export interface TagMappingRow {
  tagId: string;
  tagName: string;
  usageCount: number;
  glCodeId: string | null;
}

export interface UnusedTagOption {
  id: string;
  name: string;
}

export async function listTagMappingsForEntity(entityId: string): Promise<{
  inUse: TagMappingRow[];
  unused: UnusedTagOption[];
}> {
  await requireAuth();
  z.string().uuid().parse(entityId);

  const [tagUsage, mappings, allTags] = await Promise.all([
    db.transactionTag.groupBy({
      by: ["tagId"],
      where: { transaction: { entityId, archivedAt: null } },
      _count: { tagId: true },
    }),
    db.tagGlCodeMapping.findMany({ where: { entityId } }),
    db.tag.findMany({ select: { id: true, name: true } }),
  ]);

  const tagNameById = new Map(allTags.map((t) => [t.id, t.name]));
  const mappingByTagId = new Map(mappings.map((m) => [m.tagId, m.glCodeId]));

  const inUse: TagMappingRow[] = tagUsage
    .map((u) => ({
      tagId: u.tagId,
      tagName: tagNameById.get(u.tagId) ?? u.tagId,
      usageCount: u._count.tagId,
      glCodeId: mappingByTagId.get(u.tagId) ?? null,
    }))
    .sort((a, b) => b.usageCount - a.usageCount || a.tagName.localeCompare(b.tagName));

  const inUseIds = new Set(inUse.map((r) => r.tagId));
  const unused: UnusedTagOption[] = allTags
    .filter((t) => !inUseIds.has(t.id))
    .map((t) => ({ id: t.id, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { inUse, unused };
}

// ─── Upsert / unset a single mapping ────────────────────────────────────────

const upsertSchema = z.object({
  entityId: z.string().uuid(),
  tagId: z.string().uuid(),
  glCodeId: z.string().uuid(),
});

export async function upsertTagGlMapping(
  entityId: string,
  tagId: string,
  glCodeId: string
): Promise<void> {
  await requireAuth();
  const data = upsertSchema.parse({ entityId, tagId, glCodeId });

  // GlCode's entity-scoping has no DB-level composite FK against this mapping
  // table (see schema.prisma comment above TagGlCodeMapping) — enforce it here.
  const glCode = await db.glCode.findUnique({ where: { id: data.glCodeId } });
  if (!glCode || glCode.entityId !== data.entityId) {
    throw new Error("That GL code does not belong to this entity.");
  }

  await db.tagGlCodeMapping.upsert({
    where: { entityId_tagId: { entityId: data.entityId, tagId: data.tagId } },
    update: { glCodeId: data.glCodeId },
    create: data,
  });

  revalidatePath("/business");
}

export async function unsetTagGlMapping(entityId: string, tagId: string): Promise<void> {
  await requireAuth();
  z.string().uuid().parse(entityId);
  z.string().uuid().parse(tagId);

  await db.tagGlCodeMapping.deleteMany({ where: { entityId, tagId } });
  revalidatePath("/business");
}

// ─── Backfill preview / apply ───────────────────────────────────────────────

export interface BackfillMatch {
  id: string;
  postedAt: string;
  payeeRaw: string | null;
  amount: string;
  tagNames: string[];
  resolvedGlCodeLabel: string;
}

export interface BackfillConflictRow {
  id: string;
  payeeRaw: string | null;
  tagNames: string[];
}

export interface BackfillPreview {
  wouldAssign: BackfillMatch[];
  noMappingCount: number;
  conflicts: BackfillConflictRow[];
}

export async function previewGlCodeBackfill(entityId: string): Promise<BackfillPreview> {
  await requireAuth();
  z.string().uuid().parse(entityId);

  const [mappings, glCodes, transactions] = await Promise.all([
    db.tagGlCodeMapping.findMany({ where: { entityId } }),
    db.glCode.findMany({ where: { entityId } }),
    db.transaction.findMany({
      where: {
        entityId,
        archivedAt: null,
        transferPairId: null,
        glCodeId: null,
        tags: { some: {} },
      },
      select: {
        id: true,
        postedAt: true,
        payeeRaw: true,
        payeeNormalized: true,
        amount: true,
        tags: { select: { tag: { select: { id: true, name: true } } } },
      },
      orderBy: [{ postedAt: "desc" }, { id: "asc" }],
    }),
  ]);

  const mappingMap = new Map(mappings.map((m) => [m.tagId, m.glCodeId]));
  const glCodeById = new Map(glCodes.map((g) => [g.id, g]));

  const wouldAssign: BackfillMatch[] = [];
  const conflicts: BackfillConflictRow[] = [];
  let noMappingCount = 0;

  for (const tx of transactions) {
    const tagIds = tx.tags.map((t) => t.tag.id);
    const tagNames = tx.tags.map((t) => t.tag.name);
    const resolution = resolveGlCodeForTags(tagIds, mappingMap);

    if (resolution.status === "no_mapping") {
      noMappingCount++;
    } else if (resolution.status === "conflict") {
      conflicts.push({ id: tx.id, payeeRaw: tx.payeeRaw ?? tx.payeeNormalized, tagNames });
    } else {
      const gl = glCodeById.get(resolution.glCodeId);
      wouldAssign.push({
        id: tx.id,
        postedAt: tx.postedAt.toISOString(),
        payeeRaw: tx.payeeRaw ?? tx.payeeNormalized,
        amount: new Prisma.Decimal(tx.amount).toString(),
        tagNames,
        resolvedGlCodeLabel: gl ? `${gl.code} ${gl.name}` : "—",
      });
    }
  }

  return { wouldAssign, noMappingCount, conflicts };
}

export async function applyGlCodeBackfill(
  transactionIds: string[]
): Promise<{ assigned: number }> {
  const user = await requireAuth();
  const ids = z.array(z.string().uuid()).parse(transactionIds);
  if (ids.length === 0) return { assigned: 0 };

  // Re-resolve server-side — never trust a client-supplied GL code.
  const transactions = await db.transaction.findMany({
    where: { id: { in: ids }, archivedAt: null, glCodeId: null },
    select: {
      id: true,
      entityId: true,
      tags: { select: { tagId: true } },
    },
  });

  const entries = transactions.map((tx) => ({
    transactionId: tx.id,
    entityId: tx.entityId,
    tagIds: tx.tags.map((t) => t.tagId),
  }));

  const result = await autoAssignGlCodes(entries, user.id!);
  revalidatePath("/business");
  return result;
}
