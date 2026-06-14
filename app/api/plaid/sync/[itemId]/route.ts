import { auth } from "@/lib/auth";
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
  const result = await syncPlaidTransactions(itemId);
  return NextResponse.json(result);
}
