import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { CalendarCheck, FileBarChart } from "lucide-react";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function ReportsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const reports = [
    {
      href: "/personal/reports/weekly" as Route,
      icon: CalendarCheck,
      title: "Weekly check-in",
      text: "Where the current month stands: budget used against the month gone, spending by week, every category against its budget, the last 7 days and what is coming up. One page, mostly charts.",
    },
    {
      href: "/personal/reports/monthly" as Route,
      icon: FileBarChart,
      title: "Month-end summary",
      text: "Every budget category for a month: budgeted, spent and what is left, with the overspent lines and the money outside any line. One page.",
    },
  ];

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-muted-foreground">Printable one-page reports for the Personal budget. Open one and press Print.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {reports.map(({ href, icon: Icon, title, text }) => (
            <Link key={href} href={href} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Icon className="h-5 w-5 text-primary" />
                    {title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{text}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
