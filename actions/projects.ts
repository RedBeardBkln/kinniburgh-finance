"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { z } from "zod";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const createSchema = z.object({
  name: z.string().min(1, "Name required"),
  description: z.string().optional(),
  targetAmount: z.number().positive("Target must be positive"),
  targetDate: z.string().optional(),
  accountId: z.string().optional(),
});

export async function listProjects() {
  await requireAuth();
  return db.project.findMany({
    where: { archivedAt: null },
    include: { account: { select: { id: true, nickname: true, mask: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
}

export async function createProject(data: z.infer<typeof createSchema>) {
  await requireAuth();
  const parsed = createSchema.parse(data);
  const project = await db.project.create({
    data: {
      name: parsed.name,
      description: parsed.description,
      targetAmount: parsed.targetAmount,
      targetDate: parsed.targetDate ? new Date(parsed.targetDate) : undefined,
      accountId: parsed.accountId ?? null,
    },
  });
  revalidatePath("/personal/projects");
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    targetAmount: number;
    savedAmount: number;
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
      ...(patch.targetAmount !== undefined && { targetAmount: patch.targetAmount }),
      ...(patch.savedAmount !== undefined && { savedAmount: patch.savedAmount }),
      ...(patch.targetDate !== undefined && {
        targetDate: patch.targetDate ? new Date(patch.targetDate) : null,
      }),
      ...(patch.status !== undefined && { status: patch.status }),
    },
  });
  revalidatePath("/personal/projects");
  return project;
}

export async function archiveProject(id: string) {
  await requireAuth();
  await db.project.update({ where: { id }, data: { archivedAt: new Date() } });
  revalidatePath("/personal/projects");
}

export async function proposedTransferAmount(accountId: string): Promise<{
  hasTransfer: boolean;
  suggestedWeeklyCents: number;
}> {
  await requireAuth();
  const existing = await db.scheduledTransfer.findFirst({
    where: { toAccountId: accountId, active: true },
  });
  // $277/wk ≈ $1,200/mo (Home Improvements $400 + Home Repair $800)
  return { hasTransfer: !!existing, suggestedWeeklyCents: 27700 };
}
