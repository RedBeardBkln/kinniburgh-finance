"use server";

import { auth } from "@/lib/auth";
import { loadAdvisorConfig } from "@/lib/advisor/config";
import { checkLimits, windowStart } from "@/lib/advisor/limits";
import * as store from "@/lib/advisor/store";

// Read-only usage numbers for the slide-over's usage line (questions left today, fresh tokens in the last 24 hours). Counts only: no text,
// no cost. Fail-soft: until the assistant's tables exist (or on any read error) the numbers are null and the line simply shows less.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

export interface MyAdvisorUsage {
  turnsLeft: number | null;
  tokens24h: number | null;
}

export async function getMyAdvisorUsage(): Promise<MyAdvisorUsage> {
  const user = await requireAuth();
  const read = await store.safeRead(() => store.sumUsageSince(user.id, windowStart(new Date())));
  if (read.state !== "ok") return { turnsLeft: null, tokens24h: null };
  const decision = checkLimits(loadAdvisorConfig(), read.value.user, read.value.household);
  return { turnsLeft: decision.ok ? decision.turnsLeft : 0, tokens24h: read.value.user.freshTokens };
}
