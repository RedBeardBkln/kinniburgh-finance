import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listTagRules, deleteTagRule } from "@/actions/tag-rules";
import { db } from "@/lib/db";
import { TagRulesClient } from "@/components/tag-rules/tag-rules-client";
import { flattenTagTree, buildTagTree } from "@/lib/tags";

export default async function TagRulesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [rules, rawTags, accounts] = await Promise.all([
    listTagRules(),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    db.account.findMany({
      where: { archivedAt: null },
      select: { id: true, nickname: true, mask: true },
      orderBy: { nickname: "asc" },
    }),
  ]);

  const allTags = flattenTagTree(
    buildTagTree(rawTags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName, parentId: t.parentId })))
  );

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Tag Rules</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Payee patterns mapped to tags — applied automatically when transactions are imported or synced.
          </p>
        </div>

        <TagRulesClient
          initialRules={rules.map((r) => ({
            id: r.id,
            payeePattern: r.payeePattern ?? "",
            tagId: r.tagId,
            tagName: r.tag.shortName,
            amountMin: r.amountMin?.toString() ?? null,
            amountMax: r.amountMax?.toString() ?? null,
            accountId: r.accountId ?? null,
            accountNickname: r.account?.nickname ?? null,
            accountIds: r.accountIds ? JSON.parse(r.accountIds) : null,
            confidence: r.confidence,
          }))}
          allTags={allTags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName, parentId: t.parentId }))}
          accounts={accounts.map((a) => ({ id: a.id, nickname: a.nickname, mask: a.mask }))}
        />
      </div>
    </AppShell>
  );
}
