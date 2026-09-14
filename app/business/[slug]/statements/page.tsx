import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent } from "@/components/ui/card";
import { StatementUploadForm } from "@/components/bank-statements/statement-upload-form";
import { StatementsTable } from "@/components/bank-statements/statements-table";
import { listBankStatements, listEntityAccounts } from "@/actions/bank-statements";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function BankStatementsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const entity = await getEntityBySlug(slug);
  const entityLabel = entity?.navLabel ?? entity?.name ?? slug;

  if (!entity) redirect("/business" as Route);

  const [statements, accounts] = await Promise.all([
    listBankStatements(entity.id),
    listEntityAccounts(entity.id),
  ]);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Link href={"/business" as Route} className="hover:underline">Business</Link>
              <span>/</span>
              <span>{entityLabel}</span>
            </div>
            <h1 className="text-2xl font-semibold">Bank Statements</h1>
            <p className="text-sm text-muted-foreground">
              Upload account statements. Confirmed closing balances feed the monthly,
              quarterly, and annual balance sheets.
            </p>
          </div>
          <Link
            href={`/business/${slug}/balance-sheet` as Route}
            className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            View Balance Sheets →
          </Link>
        </div>

        <StatementUploadForm entityId={entity.id} accounts={accounts} />

        <StatementsTable statements={statements} accounts={accounts} />

        <Card>
          <CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Statements are stored permanently in the tax document vault (archive only —
              never deleted). Extraction reads the statement period and per-account
              opening/closing balances; always review unconfirmed rows. Balance sheets are
              drafts for CPA review — not financial advice.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}