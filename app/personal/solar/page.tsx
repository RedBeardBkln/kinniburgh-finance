import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { listSolarEntries } from "@/actions/solar";
import { SolarTracker } from "@/components/solar/solar-tracker";
import type { Route } from "next";

export default async function SolarPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const entries = await listSolarEntries();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Solar ROI Tracker</h1>
          <p className="text-sm text-muted-foreground">
            Track Eversource bill savings and grid credits from your solar installation.
          </p>
        </div>

        <SolarTracker
          entries={entries.map((e) => ({
            id: e.id,
            period: e.period,
            billAmountCents: e.billAmountCents,
            usageKwh: e.usageKwh ? parseFloat(e.usageKwh.toString()) : null,
            gridCreditCents: e.gridCreditCents,
          }))}
        />
      </div>
    </AppShell>
  );
}
