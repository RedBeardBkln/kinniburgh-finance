import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAllBusinessEntities } from "@/lib/entity";
import Link from "next/link";
import type { Route } from "next";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const businessEntities = await getAllBusinessEntities();
  const visibleBusinesses = businessEntities.filter((e) => e.slug && !e.hiddenInNav);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configuration, rules, and reference data for your financial workspace.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsCard
            title="Tag Rules"
            description="Automate payee-to-tag assignments for faster transaction review."
            href="/tag-rules"
          />
          <SettingsCard
            title="Documents"
            description="Tax documents, policies, and statements. Documents are archived only — never deleted."
            href="/documents"
          />
          <SettingsCard
            title="Tax Filing"
            description="Workspace checklists and filing deadlines for each entity and tax year."
            href="/tax"
          />
          <SettingsCard
            title="Notification Preferences"
            description="Configure budget alerts, low-balance warnings, bill reminders, and push notifications."
            href={"/settings/notifications" as Route}
          />
          <SettingsCard
            title="Income Sources"
            description="Payroll and recurring deposits used by the 30-day balance forecast and low-balance alerts."
            href={"/settings/income-sources" as Route}
          />
          <SettingsCard
            title="Business Entities"
            description="Show or hide business tabs, and add new business entities to the app."
            href={"/settings/entities" as Route}
          />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">GL Codes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Chart of accounts for each business entity.
              </p>
              <ul className="space-y-1.5">
                {visibleBusinesses.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`/business/${e.slug}/gl` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      {e.navLabel ?? e.name}
                    </Link>
                  </li>
                ))}
                {visibleBusinesses.length === 0 && (
                  <li className="text-sm text-muted-foreground">No business entities visible.</li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function SettingsCard({
  title,
  description,
  href,
}: {
  title: string;
  description: string;
  href: Route;
}) {
  return (
    <Link href={href}>
      <Card className="h-full transition-colors hover:bg-accent/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
