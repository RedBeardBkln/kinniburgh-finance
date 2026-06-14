import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { listGlCodes } from "@/actions/gl-codes";
import { GlPageClient } from "@/components/business/gl-page-client";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
}

const LABEL_MAP: Partial<Record<BucketSlug, string>> = {
  "sudden-valley": "Sudden Valley PM",
  "ek-consulting": "EK Consulting",
  mezzo: "Mezzo",
};

export default async function GlPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const entityLabel = LABEL_MAP[slug as BucketSlug] ?? slug;
  const entityName = BUCKET_ENTITY_NAMES[slug as BucketSlug];
  if (!entityName) redirect("/business" as Route);

  const entity = await db.entity.findFirst({ where: { name: entityName } });
  if (!entity) redirect("/business" as Route);

  const [glCodes, uncodedTxs] = await Promise.all([
    listGlCodes(entity.id),
    db.transaction.findMany({
      where: {
        entityId: entity.id,
        archivedAt: null,
        glCodeId: null,
        transferPairId: null,
      },
      include: { account: true },
      orderBy: { postedAt: "desc" },
      take: 100,
    }),
  ]);

  const uncodedRows = uncodedTxs.map((tx) => ({
    id: tx.id,
    postedAt: tx.postedAt.toISOString(),
    payeeRaw: tx.payeeRaw,
    payeeNormalized: tx.payeeNormalized,
    amount: tx.amount.toString(),
    accountNickname: tx.account.nickname,
  }));

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href={"/business" as Route} className="hover:underline">Business</Link>
            <span>/</span>
            <span>{entityLabel}</span>
          </div>
          <h1 className="text-2xl font-semibold">GL Codes &amp; Coding Queue</h1>
          <p className="text-sm text-muted-foreground">
            Assign GL codes to categorize transactions for P&amp;L reporting.
            {uncodedTxs.length > 0 && (
              <> <span className="font-medium text-amber-600">{uncodedTxs.length} transactions</span> need coding.</>
            )}
          </p>
        </div>

        <GlPageClient
          entityId={entity.id}
          glCodes={glCodes.map((g) => ({ id: g.id, code: g.code, name: g.name, type: g.type }))}
          uncodedTransactions={uncodedRows}
        />
      </div>
    </AppShell>
  );
}
