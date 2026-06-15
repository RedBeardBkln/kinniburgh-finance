import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { TransactionTagsEditor } from "@/components/transactions/transaction-tags-editor";
import { CreateRuleForm } from "@/components/transactions/create-rule-form";
import type { Route } from "next";

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { id } = await params;

  const [tx, allTags] = await Promise.all([
    db.transaction.findUnique({
      where: { id },
      include: {
        account: { include: { institution: true } },
        entity: true,
        tags: { include: { tag: true } },
        glCode: true,
      },
    }),
    db.tag.findMany({
      orderBy: { name: "asc" },
    }),
  ]);

  if (!tx) notFound();

  const amount = new Prisma.Decimal(tx.amount);
  const isOutflow = amount.isNegative();
  const currentTagIds = tx.tags.map((t) => t.tagId);
  const absAmount = amount.abs().toNumber();
  const defaultAmount = absAmount.toFixed(2);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6 max-w-2xl">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href={"/transactions" as Route} className="hover:underline">
              Transactions
            </Link>
            <span>/</span>
            <span>Detail</span>
          </div>
          <h1 className="text-2xl font-semibold">
            {tx.payeeRaw ?? tx.payeeNormalized ?? "Transaction"}
          </h1>
        </div>

        {/* Details */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Date</dt>
              <dd>
                {tx.postedAt.toLocaleDateString("en-US", {
                  timeZone: "America/New_York",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </dd>

              <dt className="text-muted-foreground">Amount</dt>
              <dd className={`font-medium tabular-nums ${isOutflow ? "text-destructive" : "text-green-600"}`}>
                {isOutflow ? "−" : "+"}
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(absAmount)}
              </dd>

              <dt className="text-muted-foreground">Account</dt>
              <dd>
                {tx.account.nickname}
                <span className="ml-1 text-muted-foreground">···{tx.account.mask}</span>
              </dd>

              <dt className="text-muted-foreground">Entity</dt>
              <dd>{tx.entity?.name ?? "—"}</dd>

              {tx.description && (
                <>
                  <dt className="text-muted-foreground">Description</dt>
                  <dd>{tx.description}</dd>
                </>
              )}

              {tx.payeeNormalized && tx.payeeNormalized !== tx.payeeRaw && (
                <>
                  <dt className="text-muted-foreground">Normalized payee</dt>
                  <dd className="font-mono text-xs">{tx.payeeNormalized}</dd>
                </>
              )}

              {tx.glCode && (
                <>
                  <dt className="text-muted-foreground">GL code</dt>
                  <dd>
                    {tx.glCode.code}
                    <span className="text-muted-foreground ml-1">— {tx.glCode.name}</span>
                  </dd>
                </>
              )}

              <dt className="text-muted-foreground">Status</dt>
              <dd>
                {tx.pending ? (
                  <Badge variant="secondary">Pending</Badge>
                ) : (
                  <Badge variant="outline">Posted</Badge>
                )}
                {tx.transferPairId && (
                  <Badge variant="secondary" className="ml-2">Transfer</Badge>
                )}
              </dd>
            </dl>
          </CardContent>
        </Card>

        {/* Tags */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Tags</CardTitle>
          </CardHeader>
          <CardContent>
            <TransactionTagsEditor
              transactionId={id}
              allTags={allTags.map((t) => ({
                id: t.id,
                name: t.name,
                shortName: t.shortName,
                parentId: t.parentId,
              }))}
              initialTagIds={currentTagIds}
            />
          </CardContent>
        </Card>

        {/* Create rule */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Create tag rule</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Save a rule to automatically tag future transactions with this payee.
            </p>
            <CreateRuleForm
              allTags={allTags.map((t) => ({
                id: t.id,
                name: t.name,
                shortName: t.shortName,
                parentId: t.parentId,
              }))}
              defaultPayee={tx.payeeNormalized ?? tx.payeeRaw ?? ""}
              defaultAmount={defaultAmount}
              accountId={tx.accountId}
            />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
