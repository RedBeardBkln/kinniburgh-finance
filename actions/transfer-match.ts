"use server";

import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { runTransferMatchingEngine, type TransferMatchSummary } from "@/lib/transfer-match-runner";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

// ── Manually trigger TD Bank transfer detection/linking ─────────────────────

export async function runTransferMatchingNow(): Promise<TransferMatchSummary> {
  await requireAuth();
  const summary = await runTransferMatchingEngine("manual");
  revalidatePath("/envelope");
  revalidatePath("/transactions");
  return summary;
}
