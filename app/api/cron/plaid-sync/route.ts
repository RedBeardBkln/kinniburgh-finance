import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncPlaidTransactions, autoTagUncategorizedTransactions } from "@/lib/plaid-sync";
import { runDuplicateDetectionEngine } from "@/lib/dedupe-runner";
import { runTransferMatchingEngine, type TransferMatchSummary } from "@/lib/transfer-match-runner";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await db.plaidItem.findMany({
    where: { status: "active" },
    select: { itemId: true },
  });

  const results = await Promise.allSettled(
    items.map((item) => syncPlaidTransactions(item.itemId)),
  );

  const summary = results.map((r, i) => ({
    itemId: items[i]!.itemId,
    status: r.status,
    ...(r.status === "fulfilled"
      ? { added: r.value.added, modified: r.value.modified, removed: r.value.removed }
      : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }),
  }));

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - succeeded;

  // TD Bank internal-transfer detection/linking must run BEFORE both
  // auto-tagging and the dedupe sweep below — until transferPairId is set
  // on these rows, dedupe's (accountId, day, amount, payeeNormalized)
  // grouping would otherwise treat a genuine same-day/same-amount transfer
  // collision (e.g. two real $2350 mortgage-funding transfers) as an exact
  // duplicate and archive one, and auto-tagging would miss the chance to
  // apply transfer-specific tagging to newly-linked rows.
  let transferMatch: TransferMatchSummary | { error: string } | null = null;
  try {
    transferMatch = await runTransferMatchingEngine("cron");
  } catch (err) {
    transferMatch = { error: err instanceof Error ? err.message : String(err) };
  }

  const autoTag = await autoTagUncategorizedTransactions();

  // Background duplicate sweep: exact matches are archived + logged (undoable
  // in Settings → Duplicate Log)
  let dedupe: { archived: number; groups: number } | { error: string } | null = null;
  try {
    dedupe = await runDuplicateDetectionEngine("cron");
  } catch (err) {
    dedupe = { error: err instanceof Error ? err.message : String(err) };
  }

  console.log(
    `[cron/plaid-sync] ${succeeded} succeeded, ${failed} failed; auto-tagged ${autoTag.tagged}/${autoTag.scanned} uncategorized`,
  );
  if (transferMatch && "matchedPairs" in transferMatch && transferMatch.matchedPairs > 0) {
    console.log(
      `[cron/plaid-sync] transfer-match linked ${transferMatch.matchedPairs} pair(s), ${transferMatch.tiedToSchedule} tied to a schedule, ${transferMatch.leftUnmatched} left unmatched`
    );
  }
  if (dedupe && "archived" in dedupe && dedupe.archived > 0) {
    console.log(`[cron/plaid-sync] dedupe archived ${dedupe.archived} duplicate(s) across ${dedupe.groups} group(s)`);
  }

  return NextResponse.json({ synced: succeeded, failed, items: summary, autoTag, transferMatch, dedupe });
}
