import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { UploadClient, type TransactionContext } from "./upload-client";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ bucket?: string; transactionId?: string }>;
}

export default async function ReceiptUploadPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const entity = await getEntityBySlug(bucket);
  const entityLabel = entity?.navLabel ?? entity?.name ?? "All Entities";

  let transactionContext: TransactionContext | null = null;
  if (params.transactionId) {
    const tx = await db.transaction.findUnique({
      where: { id: params.transactionId, archivedAt: null },
      include: { entity: true, account: true },
    });
    if (tx) {
      transactionContext = {
        id: tx.id,
        payeeRaw: tx.payeeRaw,
        postedAt: tx.postedAt.toISOString().split("T")[0]!,
        amount: new Prisma.Decimal(tx.amount).abs().toString(),
        entityLabel: tx.entity.navLabel ?? tx.entity.name,
        accountId: tx.accountId,
      };
    }
  }

  return (
    <AppShell>
      <UploadClient entityLabel={entityLabel} transactionContext={transactionContext} />
    </AppShell>
  );
}
