import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { DebtDashboard } from "@/components/personal/debt-dashboard";

const DEBT_TYPES = ["credit_card", "mortgage", "loan"];

export default async function DebtFreePage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { bucket } = await searchParams;

  // Resolve entity when a business bucket is active
  const entityFilter =
    bucket && bucket !== "personal" && bucket !== "taxes"
      ? await db.entity.findFirst({ where: { slug: bucket } })
      : null;

  const [accounts, tags] = await Promise.all([
    db.account.findMany({
      where: {
        accountType: { in: DEBT_TYPES },
        archivedAt: null,
        ...(entityFilter ? { entityId: entityFilter.id } : {}),
      },
      select: {
        id: true,
        nickname: true,
        mask: true,
        accountType: true,
        integrationMode: true,
        currentBalance: true,
        institution: { select: { name: true } },
        entity: { select: { name: true } },
        debtDetail: {
          select: {
            id: true,
            originalBalanceCents: true,
            manualBalanceCents: true,
            interestRate: true,
            monthlyPaymentCents: true,
            paymentDay: true,
            tagId: true,
            notes: true,
            sortOrder: true,
            tag: { select: { id: true, name: true, shortName: true } },
          },
        },
      },
      orderBy: [{ entity: { name: "asc" } }, { nickname: "asc" }],
    }),
    db.tag.findMany({ orderBy: { name: "asc" } }),
  ]);

  // Standalone debts only shown in the all-entities (Personal) view
  const standaloneDebts = entityFilter
    ? []
    : await db.debtDetail.findMany({
        where: { accountId: null },
        select: {
          id: true,
          name: true,
          originalBalanceCents: true,
          manualBalanceCents: true,
          interestRate: true,
          monthlyPaymentCents: true,
          paymentDay: true,
          tagId: true,
          notes: true,
          sortOrder: true,
          tag: { select: { id: true, name: true, shortName: true } },
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });

  const serializedAccounts = accounts.map((a) => ({
    id: a.id,
    nickname: a.nickname,
    mask: a.mask,
    accountType: a.accountType,
    integrationMode: a.integrationMode,
    currentBalance: a.currentBalance?.toFixed(2) ?? null,
    institutionName: a.institution.name,
    entityName: a.entity.name,
    debtDetail: a.debtDetail
      ? {
          id: a.debtDetail.id,
          originalBalanceCents: a.debtDetail.originalBalanceCents,
          manualBalanceCents: a.debtDetail.manualBalanceCents,
          interestRate: a.debtDetail.interestRate?.toFixed(3) ?? null,
          monthlyPaymentCents: a.debtDetail.monthlyPaymentCents,
          paymentDay: a.debtDetail.paymentDay,
          tagId: a.debtDetail.tagId,
          tagName: a.debtDetail.tag?.name ?? null,
          tagShortName: a.debtDetail.tag?.shortName ?? null,
          notes: a.debtDetail.notes,
          sortOrder: a.debtDetail.sortOrder,
        }
      : null,
  }));

  const serializedStandaloneDebts = standaloneDebts.map((d) => ({
    id: d.id,
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
  }));

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
        accounts={serializedAccounts}
        standaloneDebts={serializedStandaloneDebts}
        tags={serializedTags}
        ccAccounts={ccAccounts}
      />
    </AppShell>
  );
}
