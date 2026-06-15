import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import type { Route } from "next";

const BUSINESS_ENTITIES = [
  { slug: "sudden-valley", name: "Sudden Valley" },
  { slug: "ek-consulting", name: "EK Consulting" },
  { slug: "mezzo", name: "Mezzo" },
] as const;

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

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
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">GL Codes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Chart of accounts for each business entity.
              </p>
              <ul className="space-y-1.5">
                {BUSINESS_ENTITIES.map(({ slug, name }) => (
                  <li key={slug}>
                    <Link
                      href={`/business/${slug}/gl` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      {name}
                    </Link>
                  </li>
                ))}
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
