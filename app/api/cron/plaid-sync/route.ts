import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";

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

  console.log(`[cron/plaid-sync] ${succeeded} succeeded, ${failed} failed`);

  return NextResponse.json({ synced: succeeded, failed, items: summary });
}
