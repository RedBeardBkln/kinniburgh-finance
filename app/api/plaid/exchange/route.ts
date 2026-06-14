import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { encrypt } from "@/lib/encrypt";
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
  const { access_token, item_id } = exchangeRes.data;

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

  // Fetch Plaid accounts for this item
  const accountsRes = await getPlaidClient().accountsGet({ access_token });
  const plaidAccounts = accountsRes.data.accounts;

  // Auto-match to seeded accounts by mask (last 4 digits)
  const seededAccounts = await db.account.findMany({
    select: { id: true, nickname: true, mask: true },
  });

  const suggestions = plaidAccounts.map((pa) => {
    const mask = pa.mask ?? null;
    const match = mask
      ? seededAccounts.find((sa) => sa.mask === mask)
      : undefined;
    return {
      plaidAccountId: pa.account_id,
      mask,
      name: pa.name,
      subtype: pa.subtype,
      ourAccountId: match?.id ?? null,
      ourAccountNickname: match?.nickname ?? null,
    };
  });

  return NextResponse.json({ itemId: item_id, suggestions });
}
