"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encrypt";
import { getVaultSession } from "@/lib/vault-session";
import { revalidatePath } from "next/cache";

async function requireVaultAccess() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const hasVault = await getVaultSession(session.user.id);
  if (!hasVault) throw new Error("Vault session required");
  return session.user.id;
}

export interface VaultField {
  key: string;
  value: string;
}

export interface VaultEntryDecrypted {
  id: string;
  name: string;
  category: string;
  institution: string | null;
  fields: VaultField[];
  notes: string | null;
  sortOrder: number;
}

export async function listVaultEntries(): Promise<VaultEntryDecrypted[]> {
  await requireVaultAccess();

  const entries = await db.vaultEntry.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  return entries.map((e) => {
    const data = JSON.parse(decrypt(e.dataEncrypted)) as { fields: VaultField[] };
    return {
      id: e.id,
      name: e.name,
      category: e.category,
      institution: e.institution,
      fields: data.fields,
      notes: e.notes,
      sortOrder: e.sortOrder,
    };
  });
}

export async function createVaultEntry(input: {
  name: string;
  category: string;
  institution?: string;
  fields: VaultField[];
  notes?: string;
}): Promise<{ id: string }> {
  await requireVaultAccess();

  const dataEncrypted = encrypt(JSON.stringify({ fields: input.fields }));
  const entry = await db.vaultEntry.create({
    data: {
      name: input.name,
      category: input.category,
      institution: input.institution ?? null,
      dataEncrypted,
      notes: input.notes ?? null,
    },
  });

  revalidatePath("/vault");
  return { id: entry.id };
}

export async function updateVaultEntry(
  id: string,
  input: {
    name?: string;
    category?: string;
    institution?: string | null;
    fields?: VaultField[];
    notes?: string | null;
  }
): Promise<void> {
  await requireVaultAccess();

  const existing = await db.vaultEntry.findUnique({ where: { id } });
  if (!existing) throw new Error("Not found");

  let dataEncrypted = existing.dataEncrypted;
  if (input.fields !== undefined) {
    dataEncrypted = encrypt(JSON.stringify({ fields: input.fields }));
  }

  await db.vaultEntry.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.institution !== undefined && { institution: input.institution }),
      ...(input.fields !== undefined && { dataEncrypted }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
  });

  revalidatePath("/vault");
}

export async function deleteVaultEntry(id: string): Promise<void> {
  await requireVaultAccess();
  await db.vaultEntry.delete({ where: { id } });
  revalidatePath("/vault");
}
