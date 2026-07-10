import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { DebtDashboard } from "@/components/personal/debt-dashboard";

const DEBT_TYPES = ["credit_card", "mortgage", "loan"];

export default async function DebtFreePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [accounts, debtDetails, tags] = await Promise.all([
    db.account.findMany({
      where: { accountType: { in: DEBT_TYPES }, archivedAt: null },
      select: {
        id: true,
        nickname: true,
        mask: true,
        accountType: true,
        integrationMode: true,
        currentBalance: true,
        currentBalanceAt: true,
        plaidItemId: true,
        institution: { select: { name: true } },
        entity: { select: { name: true } },
        debtDetail: { select: { id: true } },
      },
      orderBy: { nickname: "asc" },
    }),
    db.debtDetail.findMany({
      include: {
        account: {
          select: {
            id: true,
            nickname: true,
            mask: true,
            accountType: true,
            integrationMode: true,
            currentBalance: true,
            institution: { select: { name: true } },
            entity: { select: { name: true } },
          },
        },
        tag: { select: { id: true, name: true, shortName: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    db.tag.findMany({ orderBy: { name: "asc" } }),
  ]);

  // Accounts that don't yet have a DebtDetail
  const linkedAccountIds = new Set(debtDetails.map((d) => d.accountId).filter(Boolean));
  const unlinkedAccounts = accounts
    .filter((a) => !linkedAccountIds.has(a.id))
    .map((a) => ({
      id: a.id,
      nickname: a.nickname,
      mask: a.mask,
      accountType: a.accountType,
      currentBalance: a.currentBalance?.toFixed(2) ?? null,
      institutionName: a.institution.name,
      entityName: a.entity.name,
    }));

  // Serialize DebtDetail records
  const serializedDebts = debtDetails.map((d) => ({
    id: d.id,
    accountId: d.accountId,
    name: d.name,
    originalBalanceCents: d.originalBalanceCents,
    manualBalanceCents: d.manualBalanceCents,
    interestRate: d.interestRate?.toFixed(3) ?? null,
    monthlyPaymentCents: d.monthlyPaymentCents,
    paymentDay: d.paymentDay,
    tagId: d.tagId,
    tagName: d.tag?.name ?? null,
    tagShortName: d.tag?.shortName ?? null,
    notes: d.notes,
    sortOrder: d.sortOrder,
    accountNickname: d.account?.nickname ?? null,
    accountMask: d.account?.mask ?? null,
    accountType: d.account?.accountType ?? null,
    accountIntegrationMode: d.account?.integrationMode ?? null,
    accountBalance: d.account?.currentBalance?.toFixed(2) ?? null,
    institutionName: d.account?.institution?.name ?? null,
    entityName: d.account?.entity?.name ?? null,
  }));

  // CC accounts for the payoff calculator
  const ccAccounts = accounts
    .filter((a) => a.accountType === "credit_card")
    .map((a) => ({
      id: a.id,
      nickname: a.nickname,
      mask: a.mask,
      currentBalanceStr: a.currentBalance?.toFixed(2) ?? null,
    }));

  const serializedTags = tags.map((t) => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
  }));

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <DebtDashboard
        debts={serializedDebts}
        unlinkedAccounts={unlinkedAccounts}
        tags={serializedTags}
        ccAccounts={ccAccounts}
      />
    </AppShell>
  );
}
