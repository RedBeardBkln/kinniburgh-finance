import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { AccountsPageClient, type SerializedAccount, type SerializedInstitution, type SerializedEntity } from "@/components/accounts/accounts-page-client";

interface PageProps {
  searchParams: Promise<{ bucket?: string }>;
}

export default async function AccountsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const entity = await getEntityBySlug(bucket);

  const [accounts, institutions, entities] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null, ...(entity && { entityId: entity.id }) },
      include: {
        institution: true,
        entity: true,
        plaidItem: true,
      },
      orderBy: [{ entity: { name: "asc" } }, { nickname: "asc" }],
    }),
    db.institution.findMany({ orderBy: { name: "asc" } }),
    db.entity.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } }),
  ]);

  const serializedAccounts: SerializedAccount[] = accounts.map((a) => ({
    id: a.id,
    nickname: a.nickname,
    mask: a.mask,
    accountType: a.accountType,
    integrationMode: a.integrationMode,
    minimumBalance: a.minimumBalance?.toString() ?? null,
    minimumBalanceFee: a.minimumBalanceFee?.toString() ?? null,
    currentBalance: a.currentBalance?.toString() ?? null,
    currentBalanceAt: a.currentBalanceAt?.toISOString() ?? null,
    entityId: a.entityId,
    entityName: a.entity.name,
    institutionId: a.institutionId,
    institutionName: a.institution.name,
    plaidStatus: a.plaidItem?.status ?? null,
    plaidItemId: a.plaidItem?.itemId ?? null,
    plaidLastSyncedAt: a.plaidItem?.lastSyncedAt?.toISOString() ?? null,
  }));

  const serializedInstitutions: SerializedInstitution[] = institutions.map((i) => ({
    id: i.id,
    name: i.name,
    plaidCoverageNotes: i.plaidCoverageNotes,
  }));

  const serializedEntities: SerializedEntity[] = entities.map((e) => ({
    id: e.id,
    name: e.name,
  }));

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <AccountsPageClient
        accounts={serializedAccounts}
        institutions={serializedInstitutions}
        entities={serializedEntities}
      />
    </AppShell>
  );
}
