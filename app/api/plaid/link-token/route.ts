import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { decrypt } from "@/lib/encrypt";
import { NextResponse } from "next/server";
import { Products, CountryCode } from "plaid";

function plaidErrorMessage(err: unknown): { status: number; code: string | null; message: string } {
  const response = (err as { response?: { status?: number; data?: { error_code?: string; error_message?: string; display_message?: string | null } } })?.response;
  const status = response?.status ?? 500;
  const data = response?.data;
  return {
    status,
    code: data?.error_code ?? null,
    message:
      data?.display_message ??
      data?.error_message ??
      (err instanceof Error ? err.message : "Plaid request failed"),
  };
}

/**
 * Resolves the public origin from forwarded headers. Vercel route handlers
 * see req.url on an internal host; x-forwarded-host/host carries the real
 * custom domain (e.g. bananastand.ericandeva.com), which is what OAuth
 * redirect URIs must match in the Plaid dashboard.
 */
function publicOrigin(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = forwardedHost ?? req.headers.get("host");
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const itemId = searchParams.get("itemId");

  let accessToken: string | undefined;
  if (itemId) {
    const plaidItem = await db.plaidItem.findUnique({
      where: { itemId },
      select: {
        accessTokenEncrypted: true,
        accounts: { select: { id: true }, take: 1 },
      },
    });
    // Reject itemIds that don't exist or have no mapped accounts
    if (!plaidItem || plaidItem.accounts.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    accessToken = decrypt(plaidItem.accessTokenEncrypted);
  }

  const origin = publicOrigin(req);
  const webhookUrl = `${origin}/api/plaid/webhook`;
  const redirectUri = `${origin}/accounts/connect`;

  try {
    const response = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: session.user.id! },
      client_name: "Banana Stand",
      // Update mode (re-link, accessToken present) omits `products` — Link
      // re-authorizes the item and any newly granted products are picked up.
      // New connections request Transactions + Liabilities so card statement
      // data is available from day one.
      products: accessToken ? undefined : [Products.Transactions, Products.Liabilities],
      access_token: accessToken,
      country_codes: [CountryCode.Us],
      language: "en",
      webhook: webhookUrl,
      redirect_uri: redirectUri,
    });

    return NextResponse.json({ linkToken: response.data.link_token });
  } catch (err) {
    const { status, code, message } = plaidErrorMessage(err);
    console.error("[plaid/link-token] failed", { status, code, message });

    // If the combined product list fails (some production institutions don't
    // support Liabilities in the same flow as Transactions), retry with
    // Transactions only — statement data then arrives on a later re-link
    // for institutions that do support it.
    if (!accessToken) {
      try {
        const fallback = await getPlaidClient().linkTokenCreate({
          user: { client_user_id: session.user.id! },
          client_name: "Banana Stand",
          products: [Products.Transactions],
          country_codes: [CountryCode.Us],
          language: "en",
          webhook: webhookUrl,
          redirect_uri: redirectUri,
        });
        console.warn("[plaid/link-token] fell back to Transactions-only", { originalCode: code });
        return NextResponse.json({ linkToken: fallback.data.link_token, productsGranted: "transactions" });
      } catch (fallbackErr) {
        const fb = plaidErrorMessage(fallbackErr);
        console.error("[plaid/link-token] fallback also failed", { status: fb.status, code: fb.code, message: fb.message });
        return NextResponse.json(
          { error: fb.message, code: fb.code },
          { status: fb.status >= 400 && fb.status < 600 ? fb.status : 500 }
        );
      }
    }

    return NextResponse.json(
      { error: message, code },
      { status: status >= 400 && status < 600 ? status : 500 }
    );
  }
}