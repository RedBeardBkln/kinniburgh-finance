import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  SandboxItemFireWebhookRequestWebhookCodeEnum,
} from "plaid";

function getSandboxClient(): PlaidApi {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SANDBOX_SECRET;
  if (!clientId || !secret) throw new Error("PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET must be set");
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: { headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret } },
  }));
}

// One-time sandbox helper: creates a temporary sandbox item, fires a
// NEW_ACCOUNTS_AVAILABLE webhook so Plaid verifies the endpoint, then discards
// the item. Remove this route after Plaid production approval is complete.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const webhookUrl = `${new URL(req.url).origin}/api/plaid/webhook`;
  const client = getSandboxClient();

  try {
    // Create a temporary sandbox public token
    const publicTokenRes = await client.sandboxPublicTokenCreate({
      institution_id: "ins_109508",
      initial_products: [Products.Transactions],
      options: { webhook: webhookUrl },
    });

    // Exchange for an access token
    const exchangeRes = await client.itemPublicTokenExchange({
      public_token: publicTokenRes.data.public_token,
    });
    const accessToken = exchangeRes.data.access_token;

    // Fire the webhook
    const fireRes = await client.sandboxItemFireWebhook({
      access_token: accessToken,
      webhook_code: SandboxItemFireWebhookRequestWebhookCodeEnum.NewAccountsAvailable,
    });

    // Clean up — remove the temporary item
    await client.itemRemove({ access_token: accessToken }).catch(() => {});

    return NextResponse.json({
      fired: true,
      webhookUrl,
      webhookFired: fireRes.data.webhook_fired,
    });
  } catch (err) {
    let error: unknown = err instanceof Error ? err.message : String(err);
    if (err && typeof err === "object" && "response" in err) {
      const axiosErr = err as { response?: { data?: unknown } };
      if (axiosErr.response?.data) error = axiosErr.response.data;
    }
    return NextResponse.json({ fired: false, error }, { status: 500 });
  }
}
