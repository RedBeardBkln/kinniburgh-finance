import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { encrypt } from "@/lib/encrypt";
import { getPlaidAccountSuggestions } from "@/lib/plaid-mapping";
import { NextResponse } from "next/server";
import { CountryCode } from "plaid";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { publicToken } = (await req.json()) as { publicToken: string };

  // Exchange public token for access token
  const exchangeRes = await getPlaidClient().itemPublicTokenExchange({
    public_token: publicToken,
  });
  const { access_token, item_id, request_id } = exchangeRes.data;
  console.log("[plaid-exchange] token exchanged", { item_id, request_id });

  // Fetch item metadata for institution info
  const itemRes = await getPlaidClient().itemGet({ access_token });
  const institutionId = itemRes.data.item.institution_id ?? undefined;
  let institutionName: string | undefined;
  if (institutionId) {
    const instRes = await getPlaidClient().institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    institutionName = instRes.data.institution.name;
  }

  // Store encrypted access token in PlaidItem
  await db.plaidItem.upsert({
    where: { itemId: item_id },
    update: {
      accessTokenEncrypted: encrypt(access_token),
      institutionId,
      institutionName,
      status: "active",
    },
    create: {
      itemId: item_id,
      accessTokenEncrypted: encrypt(access_token),
      institutionId,
      institutionName,
      status: "active",
    },
  });

  // Fetch Plaid accounts for this item, auto-matched to seeded accounts by
  // mask (last 4 digits); excludes archived accounts.
  const suggestions = await getPlaidAccountSuggestions(access_token);

  return NextResponse.json({ itemId: item_id, suggestions });
}
