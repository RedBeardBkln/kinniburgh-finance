import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { CpaSummaryView } from "@/components/tax/forms/cpa-summary-view";
import { PrintButton } from "@/components/tax/forms/print-button";
import { loadCpaSummary } from "@/lib/tax-questionnaire-build";

interface PageProps {
  params: Promise<{ year: string }>;
}

// READ-ONLY and printable. Stays inside AppShell on purpose: AppShell is where the
// "2FA not verified -> /setup-2fa" redirect lives. The print stylesheet in
// app/globals.css hides the app chrome for the #cpa-summary container instead.
export default async function CpaSummaryPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  const data = await loadCpaSummary(year);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div id="cpa-summary" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/tax" className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <Link href={`/tax/forms/${year}` as Route} className="hover:underline">
              Forms {year}
            </Link>
            <span>/</span>
            <span>Questions and answers summary</span>
          </div>
          <PrintButton />
        </div>
        <CpaSummaryView data={data} />
      </div>
    </AppShell>
  );
}
