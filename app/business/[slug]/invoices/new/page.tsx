import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { InvoicingNav } from "@/components/invoicing/invoicing-nav";
import { NeedsSetupNotice, NotMigratedNotice } from "@/components/invoicing/gate-notices";
import { InvoiceEditor } from "@/components/invoicing/invoice-editor";
import { loadClients } from "@/lib/invoicing/clients-build";
import { loadCostTransactionOptions, loadGlCodes, loadItems } from "@/lib/invoicing/catalog-build";
import { loadInvoicingContext } from "@/lib/invoicing/gate-build";
import { nyToday } from "@/lib/invoicing/state";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ client?: string }>;
}

export default async function NewInvoicePage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login" as Route);
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await loadInvoicingContext(slug, session.user.id);
  if (ctx.status === "not_allowed") notFound();

  const shell = (children: React.ReactNode) => (
    <AppShell userName={session.user?.name ?? undefined}>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">New invoice</h1>
        <InvoicingNav slug={slug} active="invoices" />
        {children}
      </div>
    </AppShell>
  );
  if (ctx.status === "not_migrated") return shell(<NotMigratedNotice />);
  if (ctx.status === "needs_setup") return shell(<NeedsSetupNotice slug={slug} />);

  // Drafting and issuing invoices is owner-only; anyone else is shown the invoices read-only (the actions refuse a non-owner too).
  if (!ctx.owner.allowed) {
    return shell(
      <Card>
        <CardContent className="py-6 text-sm">
          Only the owner can create or edit invoices. You can view invoices, clients, items and payments, and download an invoice PDF.
        </CardContent>
      </Card>
    );
  }

  const today = nyToday(new Date());
  const [clients, items, gl, costs] = await Promise.all([
    loadClients(ctx.entity.id),
    loadItems(ctx.entity.id),
    loadGlCodes(ctx.entity.id),
    loadCostTransactionOptions(ctx.entity.id, today),
  ]);
  if (clients.length === 0) {
    return shell(
      <Card>
        <CardContent className="py-6 text-sm">Add a client first (Clients tab), then come back to create an invoice.</CardContent>
      </Card>
    );
  }
  const incomeAccounts = gl.filter((g) => g.type === "revenue");
  const services = incomeAccounts.find((g) => g.name.trim().toLowerCase() === "services") ?? null;

  return shell(
    <InvoiceEditor
      slug={slug}
      clients={clients.map((c) => ({ id: c.id, name: c.name, defaultNetDays: c.defaultNetDays, defaultTaxable: c.defaultTaxable }))}
      items={items}
      glOptions={incomeAccounts}
      costOptions={costs}
      defaultGlId={services?.id ?? null}
      profile={{
        defaultNetDays: ctx.profile.defaultNetDays,
        termsLabel: ctx.profile.termsLabel,
        einLast4: ctx.profile.einLast4,
        includeRemitToByDefault: ctx.profile.includeRemitToByDefault,
        hasRemitBank: ctx.profile.hasRemitBank,
        hasMailing: Boolean(ctx.profile.remitToMailingAddress),
      }}
      canIssue={ctx.owner.allowed}
      setupMissing={ctx.profile.setupMissing}
      preselectClientId={sp.client}
    />
  );
}
