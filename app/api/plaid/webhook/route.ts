import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { getPlaidClient } from "@/lib/plaid";
import { NextResponse } from "next/server";

// Cache JWK public keys by kid. On verification failure we evict and re-fetch
// once to handle Plaid key rotation gracefully.
const keyCache = new Map<string, JsonWebKey>();

async function fetchJwk(kid: string): Promise<JsonWebKey> {
  const res = await getPlaidClient().webhookVerificationKeyGet({ key_id: kid });
  const jwk = res.data.key as JsonWebKey;
  keyCache.set(kid, jwk);
  return jwk;
}

async function verifyWithKey(
  jwk: JsonWebKey,
  parts: string[],
  rawBody: string,
  iat: number,
): Promise<boolean> {
  // Freshness: reject JWTs older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (now - iat > 300) return false;

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, "base64url");
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    signedData,
  );
}

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
  if (typeof payload.iat !== "number") throw new Error("Missing iat");

  // Try cached key first; on failure evict and retry once (handles Plaid key rotation)
  let jwk = keyCache.get(header.kid) ?? await fetchJwk(header.kid);
  let valid = await verifyWithKey(jwk, parts, rawBody, payload.iat);

  if (!valid && keyCache.has(header.kid)) {
    keyCache.delete(header.kid);
    jwk = await fetchJwk(header.kid);
    valid = await verifyWithKey(jwk, parts, rawBody, payload.iat);
  }

  if (!valid) throw new Error("Invalid JWT signature or stale token");

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
    console.error("[plaid-webhook] Verification failed:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "Webhook verification failed" }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as {
    webhook_type: string;
    webhook_code: string;
    item_id: string;
    error?: { error_code?: string };
    consent_expiration_time?: string;
  };

  const { webhook_type, webhook_code, item_id } = body;

  if (webhook_type === "TRANSACTIONS" && webhook_code === "SYNC_UPDATES_AVAILABLE") {
    // Fire-and-forget — return 200 immediately, process async
    syncPlaidTransactions(item_id).catch((err: unknown) => {
      console.error("[plaid-webhook] sync failed:", item_id, err instanceof Error ? err.message : err);
    });
  }

  if (webhook_type === "ITEM") {
    if (webhook_code === "ERROR") {
      const errorCode = body.error?.error_code;
      await db.plaidItem.updateMany({
        where: { itemId: item_id },
        data: { status: errorCode === "ITEM_LOGIN_REQUIRED" ? "requires_login" : "error" },
      });
    }

    if (webhook_code === "PENDING_EXPIRATION") {
      // Plaid sends this ~7 days before a user's consent expires at their institution.
      // Update status and expiry so the UI can prompt re-authentication.
      const consentExpiresAt = body.consent_expiration_time
        ? new Date(body.consent_expiration_time)
        : null;
      await db.plaidItem.updateMany({
        where: { itemId: item_id },
        data: {
          status: "pending_expiration",
          ...(consentExpiresAt && { consentExpiresAt }),
        },
      });
    }

    if (webhook_code === "USER_PERMISSION_REVOKED") {
      // User revoked access at their institution. Mark item so the UI can prompt re-link.
      await db.plaidItem.updateMany({
        where: { itemId: item_id },
        data: { status: "requires_login" },
      });
      // Mark all accounts on this item as disconnected
      await db.account.updateMany({
        where: { plaidItemId: item_id },
        data: { integrationMode: "manual_entry" },
      });
    }

    if (webhook_code === "LOGIN_REPAIRED") {
      await db.plaidItem.updateMany({
        where: { itemId: item_id },
        data: { status: "active" },
      });
    }

    // NEW_ACCOUNTS_AVAILABLE: new accounts detected on the item.
    // No automated action — user initiates re-link manually if desired.
    // Acknowledged here so Plaid receives a 200.
  }

  return NextResponse.json({ received: true });
}
