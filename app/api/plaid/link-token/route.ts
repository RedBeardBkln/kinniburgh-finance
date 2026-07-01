import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { decrypt } from "@/lib/encrypt";
import { NextResponse } from "next/server";
import { Products, CountryCode } from "plaid";

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

  const webhookUrl = `${process.env.NEXTAUTH_URL ?? "https://www.ericandeva.com"}/api/plaid/webhook`;

  const response = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: session.user.id! },
    client_name: "Banana Stand",
    products: accessToken ? undefined : [Products.Transactions],
    access_token: accessToken,
    country_codes: [CountryCode.Us],
    language: "en",
    webhook: webhookUrl,
  });

  return NextResponse.json({ linkToken: response.data.link_token });
}
