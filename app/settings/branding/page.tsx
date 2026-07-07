import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLogoMeta, getFaviconMeta } from "@/lib/settings";
import { BrandingClient } from "./branding-client";

export default async function BrandingPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [logoMeta, faviconMeta] = await Promise.all([getLogoMeta(), getFaviconMeta()]);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Branding</h1>
          <p className="text-sm text-muted-foreground">
            Customize the logo and favicon shown across the app.
          </p>
        </div>

        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle className="text-base">App Logo</CardTitle>
          </CardHeader>
          <CardContent>
            <BrandingClient hasLogo={!!logoMeta} hasFavicon={!!faviconMeta} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
