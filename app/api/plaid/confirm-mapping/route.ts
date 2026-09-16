import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { createAccountsFromPlaidMapping } from "@/lib/plaid-mapping";
import { ACCOUNT_TYPE_VALUES } from "@/lib/account-types";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({
  itemId: z.string(),
  mappings: z.array(z.object({
    plaidAccountId: z.string(),
    ourAccountId: z.string().uuid(),
  })).default([]),
  newAccounts: z.array(z.object({
    plaidAccountId: z.string(),
    entityId: z.string().uuid(),
    nickname: z.string().min(1).max(100),
    accountType: z.enum(ACCOUNT_TYPE_VALUES),
    mask: z.string().max(10).optional(),
  })).default([]),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());
    const { itemId, mappings, newAccounts } = body;

    const plaidItem = await db.plaidItem.findUnique({ where: { itemId } });
    if (!plaidItem) {
      return NextResponse.json({ error: "PlaidItem not found" }, { status: 404 });
    }

    // Create brand-new accounts first (creates/reuses the Institution too), so
    // they're wired to plaidAccountId/plaidItemId before syncPlaidTransactions
    // runs below.
    await createAccountsFromPlaidMapping(itemId, newAccounts);

    // Write plaidAccountId + plaidItemId + integrationMode on each mapped account
    await Promise.all(
      mappings.map(({ plaidAccountId, ourAccountId }) =>
        db.account.update({
          where: { id: ourAccountId },
          data: {
            plaidAccountId,
            plaidItemId: itemId,
            integrationMode: "plaid",
            currentBalance: null, // will be updated from Plaid sync
          },
        })
      )
    );

    // Update Institution coverage notes if we have institution info
    if (plaidItem.institutionId && plaidItem.institutionName) {
      // Find institution by matching the first mapped account's institutionId
      const firstAccount = await db.account.findFirst({
        where: { plaidItemId: itemId },
        include: { institution: true },
      });
      if (firstAccount) {
        await db.institution.update({
          where: { id: firstAccount.institutionId },
          data: {
            plaidInstitutionId: plaidItem.institutionId,
            plaidCoverageNotes: "supported",
          },
        });
      }
    }

    // Run initial transaction sync
    const { added, modified, removed } = await syncPlaidTransactions(itemId);

    return NextResponse.json({ synced: added + modified, added, modified, removed });
  } catch (err) {
    // Converts thrown errors (zod validation, createAccountsFromPlaidMapping's
    // deliberate owner-facing messages for duplicate-nickname/already-mapped
    // collisions, etc.) into a JSON body instead of letting them fall through
    // to Next.js's empty-body 500 for an uncaught Route Handler throw.
    // Mirrors app/api/plaid/pending-accounts/[itemId]/route.ts's catch pattern.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
