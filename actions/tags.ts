"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

function requireAuth() {
  return auth().then((session) => {
    if (!session?.user?.id) throw new Error("Unauthorized");
    return session.user;
  });
}

export interface TagWithCounts {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
  txCount: number;
  ruleCount: number;
  childCount: number;
}

export async function listTagsWithCounts(): Promise<TagWithCounts[]> {
  await requireAuth();
  const tags = await db.tag.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { transactions: true, tagRules: true, children: true } },
    },
  });
  return tags.map((t) => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    parentId: t.parentId,
    txCount: t._count.transactions,
    ruleCount: t._count.tagRules,
    childCount: t._count.children,
  }));
}

const createSchema = z.object({
  shortName: z.string().min(1).max(100).trim(),
  parentId: z.string().uuid().optional(),
});

export async function createTag(
  input: z.input<typeof createSchema>
): Promise<{ id: string }> {
  await requireAuth();
  const { shortName, parentId } = createSchema.parse(input);

  let name = shortName;
  if (parentId) {
    const parent = await db.tag.findUnique({ where: { id: parentId } });
    if (!parent) throw new Error("Parent tag not found");
    name = `${parent.name} / ${shortName}`;
  }

  const tag = await db.tag.create({
    data: { name, shortName, parentId: parentId ?? null },
  });
  revalidatePath("/tags");
  revalidatePath("/tag-rules");
  return { id: tag.id };
}

const updateSchema = z.object({
  shortName: z.string().min(1).max(100).trim(),
  parentId: z.string().uuid().nullable().optional(),
});

export async function updateTag(
  id: string,
  patch: z.input<typeof updateSchema>
): Promise<void> {
  await requireAuth();
  const { shortName, parentId } = updateSchema.parse(patch);

  const oldTag = await db.tag.findUnique({ where: { id } });
  if (!oldTag) throw new Error("Tag not found");

  let name = shortName;
  if (parentId) {
    const parent = await db.tag.findUnique({ where: { id: parentId } });
    if (!parent) throw new Error("Parent tag not found");
    name = `${parent.name} / ${shortName}`;
  }

  await db.tag.update({
    where: { id },
    data: { name, shortName, parentId: parentId ?? null },
  });

  // Cascade rename to all descendants
  if (oldTag.name !== name) {
    await cascadeRename(id, oldTag.name, name);
  }

  revalidatePath("/tags");
  revalidatePath("/tag-rules");
}

async function cascadeRename(
  parentId: string,
  oldParentName: string,
  newParentName: string
): Promise<void> {
  const children = await db.tag.findMany({ where: { parentId } });
  for (const child of children) {
    const newChildName = child.name.replace(oldParentName, newParentName);
    await db.tag.update({ where: { id: child.id }, data: { name: newChildName } });
    await cascadeRename(child.id, child.name, newChildName);
  }
}

export async function deleteTag(id: string): Promise<void> {
  await requireAuth();

  const [childCount, txCount, ruleCount] = await Promise.all([
    db.tag.count({ where: { parentId: id } }),
    db.transactionTag.count({ where: { tagId: id } }),
    db.tagRule.count({ where: { tagId: id } }),
  ]);

  if (childCount > 0) {
    throw new Error(
      `Cannot delete: ${childCount} child tag${childCount !== 1 ? "s" : ""} must be deleted first.`
    );
  }
  if (txCount > 0 || ruleCount > 0) {
    throw new Error(
      `Cannot delete: tag is used by ${txCount} transaction${txCount !== 1 ? "s" : ""} and ${ruleCount} rule${ruleCount !== 1 ? "s" : ""}.`
    );
  }

  await db.tag.delete({ where: { id } });
  revalidatePath("/tags");
  revalidatePath("/tag-rules");
}
