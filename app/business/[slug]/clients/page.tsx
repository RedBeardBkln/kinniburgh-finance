import Link from "next/link";
import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { ClientForm } from "@/components/invoicing/client-forms";
import { loadClients } from "@/lib/invoicing/clients-build";
import { loadInvoiceRows } from "@/lib/invoicing/documents-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { formatCents } from "@/lib/invoicing/money";
import { nyToday } from "@/lib/invoicing/state";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ClientsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug } = await params;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed") notFound();

  const shell = (children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground">Who you invoice: contacts, EIN, W-9 and balances.</p>
        </div>
        <InvoicingNav slug={slug} active="clients" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell(<NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell(<NeedsSetupNotice slug={slug} />);

  const [clients, invoices] = await Promise.all([loadClients(ctx.entity.id), loadInvoiceRows(ctx.entity.id, nyToday(new Date()))]);
  const balance = new Map<string, number>();
  for (const i of invoices) if (i.status === "issued") balance.set(i.clientId, (balance.get(i.clientId) ?? 0) + i.balanceCents);

  return shell(
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All clients</CardTitle>
        </CardHeader>
        <CardContent>
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground">No clients yet.</p>
          ) : (
            <TableScroll>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2">Client</th>
                    <th>Invoice recipient</th>
                    <th>W-9</th>
                    <th className="text-right">Open balance</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const recipients = c.contacts.filter((x) => x.receivesInvoices);
                    return (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-2">
                          <Link className="font-medium text-primary underline" href={`/business/${slug}/clients/${c.id}` as Route}>
                            {c.name}
                          </Link>
                        </td>
                        <td>{recipients.length > 0 ? recipients.map((r) => r.name).join(", ") : <span className="text-muted-foreground">none set</span>}</td>
                        <td>{c.w9OnFile ? "On file" : <span className="text-muted-foreground">Not on file</span>}</td>
                        <td className="text-right">{formatCents(balance.get(c.id) ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
        </CardContent>
      </Card>
      {ctx.owner.allowed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a client</CardTitle>
          </CardHeader>
          <CardContent>
            <ClientForm slug={slug} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">View only. Only the owner can add or change clients.</p>
      )}
    </>
  );
}
