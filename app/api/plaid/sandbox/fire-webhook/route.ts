import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { decrypt } from "@/lib/encrypt";
import { NextResponse } from "next/server";
import { SandboxItemFireWebhookRequestWebhookCodeEnum } from "plaid";

// One-time sandbox helper: fires a NEW_ACCOUNTS_AVAILABLE webhook against the
// first working PlaidItem so Plaid can verify the webhook endpoint works.
// Remove this route after Plaid production approval is complete.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const items = await db.plaidItem.findMany({
    select: { itemId: true, accessTokenEncrypted: true },
  });

  if (items.length === 0) {
    return NextResponse.json({ error: "No PlaidItems found" }, { status: 404 });
  }

  const webhookUrl = `${new URL(req.url).origin}/api/plaid/webhook`;
  const errors: { itemId: string; error: string }[] = [];

  for (const item of items) {
    try {
      const accessToken = decrypt(item.accessTokenEncrypted);
      const response = await getPlaidClient().sandboxItemFireWebhook({
        access_token: accessToken,
        webhook_code: SandboxItemFireWebhookRequestWebhookCodeEnum.NewAccountsAvailable,
      });
      return NextResponse.json({
        fired: true,
        itemId: item.itemId,
        webhookUrl,
        webhookFired: response.data.webhook_fired,
      });
    } catch (err) {
      let errorDetail: unknown = err instanceof Error ? err.message : String(err);
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: unknown } };
        if (axiosErr.response?.data) errorDetail = axiosErr.response.data;
      }
      errors.push({ itemId: item.itemId, error: errorDetail });
    }
  }

  return NextResponse.json({ fired: false, errors }, { status: 500 });
}
