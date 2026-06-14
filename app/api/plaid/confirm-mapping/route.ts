import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { NextResponse } from "next/server";
import { z } from "zod";

const schema = z.object({
  itemId: z.string(),
  mappings: z.array(z.object({
    plaidAccountId: z.string(),
    ourAccountId: z.string().uuid(),
  })),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = schema.parse(await req.json());
  const { itemId, mappings } = body;

  const plaidItem = await db.plaidItem.findUnique({ where: { itemId } });
  if (!plaidItem) {
    return NextResponse.json({ error: "PlaidItem not found" }, { status: 404 });
  }

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
}
