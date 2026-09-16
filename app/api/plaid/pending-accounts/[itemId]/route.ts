import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encrypt";
import { getPlaidAccountSuggestions } from "@/lib/plaid-mapping";
import { NextResponse } from "next/server";

/**
 * Resume mapping for a PlaidItem that already has a valid, encrypted access
 * token but zero linked Account rows (e.g. the item succeeded at the Plaid
 * level but nothing matched an existing Account to map onto). Reuses the
 * stored access token directly — skips Plaid Link entirely since auth is
 * already done.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { itemId } = await params;

  const plaidItem = await db.plaidItem.findUnique({ where: { itemId } });
  if (!plaidItem) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const accessToken = decrypt(plaidItem.accessTokenEncrypted);

  try {
    const suggestions = await getPlaidAccountSuggestions(accessToken);
    return NextResponse.json({
      itemId,
      institutionName: plaidItem.institutionName,
      suggestions,
    });
  } catch (err: unknown) {
    const plaidError = (err as { response?: { data?: { error_code?: string; error_message?: string } } })
      ?.response?.data;

    if (plaidError?.error_code === "ITEM_LOGIN_REQUIRED") {
      // Matches lib/plaid-sync.ts's existing error-handling pattern.
      await db.plaidItem.update({ where: { itemId }, data: { status: "requires_login" } });
      return NextResponse.json(
        {
          error: "This connection needs to be re-authenticated before it can be mapped.",
          code: "ITEM_LOGIN_REQUIRED",
        },
        { status: 409 }
      );
    }

    console.error("[plaid/pending-accounts] failed", { itemId, code: plaidError?.error_code ?? null });
    return NextResponse.json(
      { error: plaidError?.error_message ?? "Failed to fetch pending accounts" },
      { status: 500 }
    );
  }
}
