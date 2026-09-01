import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { db } from "@/lib/db";
import { DuplicateLogClient } from "@/components/settings/duplicate-log-client";
import type { Route } from "next";

export default async function DuplicateLogPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [actions, undoneCount] = await Promise.all([
    db.dedupAction.findMany({
      where: { undoneAt: null },
      orderBy: { createdAt: "desc" },
    }),
    db.dedupAction.count({ where: { undoneAt: { not: null } } }),
  ]);

  const accountNames = new Map(
    (
      await db.account.findMany({
        where: { archivedAt: null },
        select: { id: true, nickname: true, mask: true },
      })
    ).map((a) => [a.id, { nickname: a.nickname, mask: a.mask }])
  );

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <a href="/settings" className="hover:underline">Settings</a>
            <span>/</span>
            <span>Duplicate Log</span>
          </div>
          <h1 className="text-2xl font-semibold">Duplicate Transaction Log</h1>
          <p className="text-sm text-muted-foreground">
            Exact duplicates (same date, amount, payee, and account) are removed automatically
            after each daily bank sync. Every removal is logged here and can be reversed —
            the restored transaction returns to the list and is protected from re-removal.
          </p>
        </div>

        <DuplicateLogClient
          actions={actions.map((a) => ({
            id: a.id,
            duplicateTxId: a.duplicateTxId,
            keptTxId: a.keptTxId,
            accountNickname:
              accountNames.get(a.accountId)?.nickname ?? "Unknown account",
            accountMask: accountNames.get(a.accountId)?.mask ?? null,
            postedAt: a.postedAt.toISOString(),
            amount: a.amount.toString(),
            payeeNormalized: a.payeeNormalized,
            detectedBy: a.detectedBy,
            createdAt: a.createdAt.toISOString(),
          }))}
          undoneCount={undoneCount}
        />
      </div>
    </AppShell>
  );
}