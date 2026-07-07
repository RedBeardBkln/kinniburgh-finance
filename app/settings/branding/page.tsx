import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLogoMeta } from "@/lib/settings";
import { BrandingClient } from "./branding-client";

export default async function BrandingPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const logoMeta = await getLogoMeta();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Branding</h1>
          <p className="text-sm text-muted-foreground">
            Customize the logo shown in the header, login screen, and browser icon.
          </p>
        </div>

        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle className="text-base">App Logo</CardTitle>
          </CardHeader>
          <CardContent>
            <BrandingClient hasLogo={!!logoMeta} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
