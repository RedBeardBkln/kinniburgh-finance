import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { getPlaidClient } from "@/lib/plaid";
import { NextResponse } from "next/server";

// Cache public keys by kid to avoid repeated Plaid API calls per request.
const keyCache = new Map<string, JsonWebKey>();

async function verifyPlaidWebhook(rawBody: string, verificationToken: string): Promise<void> {
  const parts = verificationToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed verification token");

  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as {
    iat?: number;
    request_body_sha256?: string;
  };

  if (header.alg !== "ES256") throw new Error(`Unexpected algorithm: ${header.alg}`);
  if (!header.kid) throw new Error("Missing kid");

  let jwk = keyCache.get(header.kid);
  if (!jwk) {
    const res = await getPlaidClient().webhookVerificationKeyGet({ key_id: header.kid });
    jwk = res.data.key as JsonWebKey;
    keyCache.set(header.kid, jwk);
  }

  // JWT must be fresh (5-minute window)
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== "number" || now - payload.iat > 300) {
    throw new Error("Webhook JWT is stale");
  }

  // Verify JWT signature
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, "base64url");
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    signedData,
  );
  if (!valid) throw new Error("Invalid JWT signature");

  // Verify body hash
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const bodyHash = Buffer.from(hashBuffer).toString("hex");
  if (bodyHash !== payload.request_body_sha256) throw new Error("Body hash mismatch");
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  const verificationToken = req.headers.get("Plaid-Verification");
  if (!verificationToken) {
    return NextResponse.json({ error: "Missing Plaid-Verification header" }, { status: 400 });
  }

  try {
    await verifyPlaidWebhook(rawBody, verificationToken);
  } catch (err) {
    console.error("[plaid-webhook] Verification failed:", err);
    return NextResponse.json({ error: "Webhook verification failed" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as {
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
