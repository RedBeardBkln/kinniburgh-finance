"use server";

import { auth } from "@/lib/auth";
import { z } from "zod";
import { setEntityTaxReservePct as saveTaxReservePct } from "@/lib/settings";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const schema = z.object({
  entityId: z.string().uuid(),
  pct: z.number().min(0).max(100),
});

export async function setEntityTaxReservePct(
  input: z.input<typeof schema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  await saveTaxReservePct(parsed.data.entityId, parsed.data.pct);
  revalidatePath("/business/[slug]/pl", "page");
  return { success: true };
}
