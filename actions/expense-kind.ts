"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { OVERRIDES_SETTING_KEY, parseOverrides, serializeOverrides, withOverride } from "@/lib/expense-kind";

// The owner's Fixed / Variable choice for a dashboard category (lib/expense-kind.ts). Saved by tag in one AppSetting
// JSON value (household-wide, capped at 400, no table and no migration); "auto" removes the choice so the line is sorted
// from its own history again. Starts with requireAuth(); the tag must exist; nothing sensitive is stored or logged.

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

type Result = { success: true } | { error: string };

const inputSchema = z.object({
  tagId: z.string().uuid(),
  kind: z.enum(["fixed", "variable", "auto"]),
});

export async function setExpenseKind(input: { tagId: string; kind: "fixed" | "variable" | "auto" }): Promise<Result> {
  await requireAuth();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request" };
  const { tagId, kind } = parsed.data;

  const tag = await db.tag.findUnique({ where: { id: tagId }, select: { id: true } });
  if (!tag) return { error: "That category no longer exists" };

  const current = parseOverrides(await getAppSetting(OVERRIDES_SETTING_KEY));
  const next = withOverride(current, tagId, kind === "auto" ? null : kind);
  if (!next) return { error: "Too many saved choices (400 is the limit)" };
  await setAppSetting(OVERRIDES_SETTING_KEY, serializeOverrides(next));
  revalidatePath("/");
  return { success: true };
}
