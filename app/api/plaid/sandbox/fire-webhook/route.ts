import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { decrypt } from "@/lib/encrypt";
import { NextResponse } from "next/server";

// One-time sandbox helper: fires a NEW_ACCOUNTS_AVAILABLE webhook against the
// first PlaidItem in the database so Plaid can verify the webhook endpoint works.
// Remove this route after Plaid production approval is complete.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const item = await db.plaidItem.findFirst({
    select: { itemId: true, accessTokenEncrypted: true },
  });
  if (!item) {
    return NextResponse.json({ error: "No PlaidItems found" }, { status: 404 });
  }

  const accessToken = decrypt(item.accessTokenEncrypted);
  const webhookUrl = `${new URL(req.url).origin}/api/plaid/webhook`;

  const response = await getPlaidClient().sandboxItemFireWebhook({
    access_token: accessToken,
    webhook_code: "NEW_ACCOUNTS_AVAILABLE",
  });

  return NextResponse.json({
    fired: true,
    itemId: item.itemId,
    webhookUrl,
    webhookFired: response.data.webhook_fired,
  });
}
