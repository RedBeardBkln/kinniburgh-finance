import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { ItemForm, ItemRow } from "@/components/invoicing/item-forms";
import { loadGlCodes, loadItems } from "@/lib/invoicing/catalog-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { REIMBURSABLE_GROSS_DEFAULT_NOTE } from "@/lib/invoicing/items";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ItemsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed") notFound();

  const shell = (children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Reimbursable items</h1>
          <p className="text-sm text-muted-foreground">A catalog of pass-through items (no stock counts). Pick one on an invoice line to copy its price.</p>
        </div>
        <InvoicingNav slug={slug} active="items" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell(<NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell(<NeedsSetupNotice slug={slug} />);

  const [items, gl] = await Promise.all([loadItems(ctx.entity.id), loadGlCodes(ctx.entity.id)]);
  const incomeAccounts = gl.filter((g) => g.type === "revenue");
  // Read-only for everyone but the owner (decided here, on the server; the actions refuse a non-owner too).
  const readOnly = !ctx.owner.allowed;

  return shell(
    <>
      <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">{REIMBURSABLE_GROSS_DEFAULT_NOTE}</div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2">Item</th>
                  <th>Unit</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Billed price</th>
                  <th>Income account</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <ItemRow key={i.id} slug={slug} item={i} glOptions={incomeAccounts} readOnly={readOnly} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      {readOnly ? (
        <p className="text-sm text-muted-foreground">View only. Only the owner can add or change items.</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add an item</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemForm slug={slug} glOptions={incomeAccounts} defaultGlId={ctx.profile.glMap?.billableIncome ?? null} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
