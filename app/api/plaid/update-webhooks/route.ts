import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { decrypt } from "@/lib/encrypt";
import { NextResponse } from "next/server";

// One-time POST to register the webhook URL on all existing PlaidItems.
// Only callable by an authenticated owner. Safe to call multiple times.

function publicOrigin(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = forwardedHost ?? req.headers.get("host");
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const webhookUrl = `${publicOrigin(req)}/api/plaid/webhook`;

  const items = await db.plaidItem.findMany({
    select: { itemId: true, accessTokenEncrypted: true },
  });

  const results: { itemId: string; status: string }[] = [];

  for (const item of items) {
    try {
      const accessToken = decrypt(item.accessTokenEncrypted);
      await getPlaidClient().itemWebhookUpdate({
        access_token: accessToken,
        webhook: webhookUrl,
      });
      results.push({ itemId: item.itemId, status: "updated" });
    } catch (err) {
      results.push({ itemId: item.itemId, status: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return NextResponse.json({ webhookUrl, results });
}
