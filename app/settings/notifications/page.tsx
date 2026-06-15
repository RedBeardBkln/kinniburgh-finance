import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PushSubscribeButton } from "@/components/notifications/push-subscribe-button";
import { NotifPrefsForm } from "@/components/notifications/notif-prefs-form";
import { getNotifPrefs, hasPushSubscription } from "@/actions/notifications";
import Link from "next/link";
import type { Route } from "next";

export default async function NotificationSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const [prefs, isSubscribed] = await Promise.all([getNotifPrefs(), hasPushSubscription()]);

  async function runChecks() {
    "use server";
    const secret = process.env.CRON_SECRET;
    if (!secret) return;
    await fetch(`${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/api/cron/notifications`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={"/settings" as Route} className="hover:underline">Settings</Link>
          <span>/</span>
          <span>Notifications</span>
        </div>

        <h1 className="text-2xl font-semibold">Notification Preferences</h1>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Push notifications</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Receive alerts in your browser even when the app is in the background.
            </p>
            <PushSubscribeButton initialSubscribed={isSubscribed} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Alert types</CardTitle>
          </CardHeader>
          <CardContent>
            <NotifPrefsForm initialPrefs={prefs} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Run checks now</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Manually trigger all notification checks. In production this runs nightly via Vercel Cron.
            </p>
            <form action={runChecks}>
              <button
                type="submit"
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                Run notification checks
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
