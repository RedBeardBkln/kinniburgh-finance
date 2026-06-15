import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { DebtFreeCalculator } from "@/components/personal/debt-free-calculator";

export default async function DebtFreePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const personalEntity = await db.entity.findFirst({ where: { name: "Personal" } });

  const accounts = personalEntity
    ? await db.account.findMany({
        where: {
          entityId: personalEntity.id,
          accountType: "credit_card",
          archivedAt: null,
        },
        select: {
          id: true,
          nickname: true,
          mask: true,
          currentBalance: true,
        },
        orderBy: { nickname: "asc" },
      })
    : [];

  const serialized = accounts.map((a) => ({
    id: a.id,
    nickname: a.nickname,
    mask: a.mask,
    currentBalanceStr: a.currentBalance?.toFixed(2) ?? null,
  }));

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <DebtFreeCalculator accounts={serialized} />
    </AppShell>
  );
}
