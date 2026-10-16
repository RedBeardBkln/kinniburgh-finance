import Link from "next/link";
import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice, SetupIncompleteNotice } from "@/components/invoicing/gate-notices";
import { loadInvoiceRows } from "@/lib/invoicing/documents-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { formatCents } from "@/lib/invoicing/money";
import { DISPLAY_STATE_LABELS, nyToday } from "@/lib/invoicing/state";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function InvoicesPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed") notFound();

  const shell = (children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold">Invoices</h1>
            <p className="text-sm text-muted-foreground">Accrual view: an issued invoice counts as money owed to you until payments are applied.</p>
          </div>
          {ctx.status === "ready" && ctx.owner.allowed ? (
            <Link href={`/business/${slug}/invoices/new` as Route} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              New invoice
            </Link>
          ) : null}
        </div>
        <InvoicingNav slug={slug} active="invoices" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell(<NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell(<NeedsSetupNotice slug={slug} />);

  const today = nyToday(new Date());
  const rows = await loadInvoiceRows(ctx.entity.id, today);
  const issued = rows.filter((r) => r.status === "issued");
  const outstanding = issued.reduce((s, r) => s + r.balanceCents, 0);
  const overdue = issued.filter((r) => r.overdue).reduce((s, r) => s + r.balanceCents, 0);
  const monthPrefix = today.toISOString().slice(0, 7);
  const issuedThisMonth = issued.filter((r) => r.issueDate?.startsWith(monthPrefix)).reduce((s, r) => s + r.totalCents, 0);

  return shell(
    <>
      <SetupIncompleteNotice slug={slug} missing={ctx.profile.setupMissing} />
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Outstanding (A/R)", formatCents(outstanding)],
          ["Overdue", formatCents(overdue)],
          ["Issued this month", formatCents(issuedThisMonth)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-xl font-semibold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2">Number</th>
                  <th>Client</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2">
                      <Link className="font-medium text-primary underline" href={`/business/${slug}/invoices/${r.id}` as Route}>
                        {r.displayNumber ?? "Draft"}
                      </Link>
                    </td>
                    <td>{r.clientName}</td>
                    <td>{r.issueDate ?? "—"}</td>
                    <td>{r.dueDate ?? "—"}</td>
                    <td>
                      <Badge variant={r.state === "paid" ? "success" : r.state === "void" ? "secondary" : r.overdue ? "destructive" : "outline"}>{DISPLAY_STATE_LABELS[r.state]}</Badge>
                      {r.overdue ? <span className="ml-1 text-xs text-red-700">overdue {r.daysPastDue}d</span> : null}
                    </td>
                    <td className="text-right">{formatCents(r.totalCents)}</td>
                    <td className="text-right">{r.status === "issued" ? formatCents(r.balanceCents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
