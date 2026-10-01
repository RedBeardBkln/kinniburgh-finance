import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { listGlCodes, listArchivedGlCodes } from "@/actions/gl-codes";
import { listTagMappingsForEntity } from "@/actions/gl-code-mappings";
import { GlPageClient } from "@/components/business/gl-page-client";
import { TagGlMappingSection } from "@/components/business/tag-gl-mapping-section";
import { ExcludedFromPlSection } from "@/components/business/excluded-from-pl-section";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

// `from`/`to` are user-controlled query strings: only accept values that parse
// to a real date, otherwise fall back to "all periods".
function parseDateParam(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function GlPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const sp = await searchParams;
  const entity = await getEntityBySlug(slug);
  const entityLabel = entity?.navLabel ?? entity?.name ?? slug;

  if (!entity) redirect("/business" as Route);

  const fromParam = parseDateParam(sp.from);
  const toParam = parseDateParam(sp.to);
  const postedAtFilter =
    fromParam || toParam
      ? { postedAt: { ...(fromParam ? { gte: fromParam } : {}), ...(toParam ? { lte: toParam } : {}) } }
      : {};

  // Transactions coded to a non-revenue/non-expense GL code are silently left
  // off the P&L (see computePL). Same definition as isPLGlType: "not a P&L type".
  const excludedWhere = {
    entityId: entity.id,
    archivedAt: null,
    transferPairId: null,
    glCode: { type: { notIn: ["revenue", "expense"] } },
    ...postedAtFilter,
  };

  const [glCodes, archivedGlCodes, uncodedTxs, tagMappings, excludedTxs, excludedCount] = await Promise.all([
    listGlCodes(entity.id),
    listArchivedGlCodes(entity.id),
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
    listTagMappingsForEntity(entity.id),
    db.transaction.findMany({
      where: excludedWhere,
      include: { account: true, glCode: true },
      orderBy: { postedAt: "desc" },
      take: 100,
    }),
    db.transaction.count({ where: excludedWhere }),
  ]);

  const uncodedRows = uncodedTxs.map((tx) => ({
    id: tx.id,
    postedAt: tx.postedAt.toISOString(),
    payeeRaw: tx.payeeRaw,
    payeeNormalized: tx.payeeNormalized,
    amount: tx.amount.toString(),
    accountNickname: tx.account.nickname,
  }));

  const excludedRows = excludedTxs.flatMap((tx) =>
    tx.glCode
      ? [
          {
            id: tx.id,
            postedAt: tx.postedAt.toISOString(),
            payee: tx.payeeRaw ?? tx.payeeNormalized ?? "—",
            accountNickname: tx.account.nickname,
            amount: tx.amount.toString(),
            glCodeId: tx.glCode.id,
            glCode: tx.glCode.code,
            glName: tx.glCode.name,
            glType: tx.glCode.type,
          },
        ]
      : []
  );

  const excludedPeriodLabel =
    fromParam || toParam
      ? `${fromParam ? fromParam.toISOString().slice(0, 10) : "start"} – ${toParam ? toParam.toISOString().slice(0, 10) : "present"}`
      : null;

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
          archivedGlCodes={archivedGlCodes.map((g) => ({ id: g.id, code: g.code, name: g.name, type: g.type }))}
          uncodedTransactions={uncodedRows}
        />

        {excludedCount > 0 && (
          <ExcludedFromPlSection
            glCodes={glCodes.map((g) => ({ id: g.id, code: g.code, name: g.name, type: g.type }))}
            rows={excludedRows}
            totalCount={excludedCount}
            periodLabel={excludedPeriodLabel}
          />
        )}

        <TagGlMappingSection
          entityId={entity.id}
          glCodes={glCodes.map((g) => ({ id: g.id, code: g.code, name: g.name, type: g.type }))}
          inUse={tagMappings.inUse}
          unused={tagMappings.unused}
        />
      </div>
    </AppShell>
  );
}
