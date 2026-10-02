"use server";

// Archive a bank statement from a tax workspace's "Other years" list.
// Soft-archive only (tax data is never hard-deleted): sets archivedAt on the
// Document and its linked BankStatement together.

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { evaluateStatementArchive } from "@/lib/statement-archive";
import { archiveDocumentWithStatement } from "@/lib/statement-archive-runner";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user as { id: string };
}

const archiveSchema = z.object({
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
});

export async function archiveWorkspaceStatement(
  input: { workspaceId: string; documentId: string },
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { workspaceId, documentId } = parsed.data;

  const workspace = await db.taxWorkspace.findUnique({
    where: { id: workspaceId },
    select: { entityId: true },
  });
  if (!workspace) return { error: "Workspace not found" };

  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { entityId: true, docType: true, archivedAt: true },
  });

  const decision = evaluateStatementArchive({ workspaceEntityId: workspace.entityId, doc });
  if (!decision.ok) return { error: decision.error };

  const result = await archiveDocumentWithStatement(documentId, { entityId: workspace.entityId });
  if (!result.documentArchived) return { error: "Statement is already archived" };

  revalidatePath("/tax");
  revalidatePath("/documents");
  revalidatePath("/business");
  return { success: true as const };
}
