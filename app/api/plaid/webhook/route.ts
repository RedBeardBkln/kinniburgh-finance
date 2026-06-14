import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { NextResponse } from "next/server";

// Plaid sends webhooks to this endpoint.
// In sandbox: trigger via Plaid dashboard or /sandbox/item/fire_webhook.
// In production: set Webhook URL in Plaid dashboard to https://your-domain/api/plaid/webhook

export async function POST(req: Request) {
  const body = (await req.json()) as {
    webhook_type: string;
    webhook_code: string;
    item_id: string;
    error?: { error_code?: string };
  };

  const { webhook_type, webhook_code, item_id } = body;

  if (webhook_type === "TRANSACTIONS" && webhook_code === "SYNC_UPDATES_AVAILABLE") {
    // Fire-and-forget; errors logged but we must return 200 immediately
    syncPlaidTransactions(item_id).catch((err: unknown) => {
      console.error("[plaid-webhook] syncPlaidTransactions failed:", item_id, err);
    });
  }

  if (webhook_type === "ITEM" && webhook_code === "ERROR") {
    const errorCode = body.error?.error_code;
    if (errorCode === "ITEM_LOGIN_REQUIRED") {
      await db.plaidItem.updateMany({
        where: { itemId: item_id },
        data: { status: "requires_login" },
      });
    } else {
      await db.plaidItem.updateMany({
        where: { itemId: item_id },
        data: { status: "error" },
      });
    }
  }

  return NextResponse.json({ received: true });
}
