import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { NextResponse } from "next/server";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { itemId } = await params;

  // Verify the item exists and has at least one linked account in our DB
  const item = await db.plaidItem.findUnique({
    where: { itemId },
    select: { itemId: true, accounts: { select: { id: true }, take: 1 } },
  });
  if (!item || item.accounts.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await syncPlaidTransactions(itemId);
  return NextResponse.json(result);
}
