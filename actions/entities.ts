"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

function toSlug(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function toggleEntityVisibility(entityId: string, hidden: boolean) {
  await requireAuth();
  await db.entity.update({
    where: { id: entityId },
    data: { hiddenInNav: hidden },
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings/entities");
}

export async function createBusinessEntity(input: {
  fullName: string;
  navLabel: string;
  slug?: string;
}) {
  await requireAuth();

  const slug = (input.slug?.trim() || toSlug(input.navLabel)).toLowerCase();

  if (!slug) throw new Error("Slug cannot be empty");
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Slug may only contain lowercase letters, numbers, and hyphens");
  }

  const reserved = ["personal", "taxes"];
  if (reserved.includes(slug)) {
    throw new Error(`"${slug}" is a reserved slug`);
  }

  const entity = await db.entity.create({
    data: {
      name: input.fullName.trim(),
      navLabel: input.navLabel.trim(),
      slug,
      type: "business",
      hiddenInNav: false,
    },
  });

  revalidatePath("/", "layout");
  revalidatePath("/settings/entities");
  return { id: entity.id, slug: entity.slug };
}

export async function updateEntityNavLabel(entityId: string, navLabel: string) {
  await requireAuth();
  await db.entity.update({
    where: { id: entityId },
    data: { navLabel: navLabel.trim() },
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings/entities");
}
