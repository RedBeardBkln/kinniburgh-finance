import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAllBusinessEntities } from "@/lib/entity";
import { EntitiesClient } from "@/components/settings/entities-client";

export default async function EntitiesSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const entities = await getAllBusinessEntities();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Business Entities</h1>
          <p className="text-sm text-muted-foreground">
            Show or hide business tabs in the navigation, and add new business entities.
            Personal and Taxes tabs are always visible.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Business tabs</CardTitle>
          </CardHeader>
          <CardContent>
            <EntitiesClient entities={entities} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
