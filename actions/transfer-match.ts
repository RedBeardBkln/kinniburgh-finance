"use server";

import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { setAppSetting } from "@/lib/settings";
import { resolveCloserForUser } from "@/lib/tax-year-close-owner";
import {
  ONE_SIDED_SETTING_KEY,
  runTransferMatchingEngine,
  type TransferMatchSummary,
} from "@/lib/transfer-match-runner";

async function requireAuth(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user.id;
}

// ── Manually trigger TD Bank transfer detection/linking ─────────────────────
// Any signed-in user can run the pairing. Only the OWNER's click (his account, resolveCloserForUser: the same
// ambiguity-means-nobody rule as the tax year close and invoicing) is the go-ahead for the one-sided marking: it switches
// the gate on (so the daily cron and sync keep marking from now on) and runs the one-sided pass right away. A non-owner,
// or a failed owner check, runs the engine with its default (marks only if the owner already switched the gate on) and
// never writes the setting; it does not throw, so pairing stays available to everyone. To stop future marking, delete
// the AppSetting.

export async function runTransferMatchingNow(): Promise<TransferMatchSummary> {
  const userId = await requireAuth();
  const owner = await resolveCloserForUser(userId);
  let summary: TransferMatchSummary;
  if (owner.allowed) {
    await setAppSetting(ONE_SIDED_SETTING_KEY, "1");
    summary = await runTransferMatchingEngine("manual", { oneSided: "run" });
  } else {
    summary = await runTransferMatchingEngine("manual");
  }
  revalidatePath("/envelope");
  revalidatePath("/transactions");
  return summary;
}
