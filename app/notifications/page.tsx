import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getNotifications, markAllRead } from "@/actions/notifications";
import { AlertTriangle, BarChart2, Calendar, PiggyBank, TrendingDown, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Route } from "next";

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  overspend: { label: "Budget alert", icon: <BarChart2 className="h-4 w-4" />, color: "text-orange-500" },
  low_balance: { label: "Low balance", icon: <TrendingDown className="h-4 w-4" />, color: "text-red-500" },
  accrual_shortfall: { label: "Accrual shortfall", icon: <PiggyBank className="h-4 w-4" />, color: "text-yellow-500" },
  bill_due: { label: "Bill reminder", icon: <Calendar className="h-4 w-4" />, color: "text-blue-500" },
  anomaly: { label: "Spending anomaly", icon: <AlertTriangle className="h-4 w-4" />, color: "text-purple-500" },
};

function relativeTime(date: Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const items = await getNotifications();
  const unreadCount = items.filter((i) => !i.readAt).length;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Notifications</h1>
            <p className="text-sm text-muted-foreground">
              {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
            </p>
          </div>
          {unreadCount > 0 && (
            <form
              action={async () => {
                "use server";
                await markAllRead();
              }}
            >
              <button
                type="submit"
                className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
              >
                Mark all read
              </button>
            </form>
          )}
        </div>

        <div className="rounded-lg border divide-y">
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <Bell className="h-8 w-8 opacity-30" />
              <p className="text-sm">No notifications yet.</p>
              <p className="text-xs">Run the notification check from Settings to generate alerts.</p>
            </div>
          )}
          {items.map((item) => {
            const meta = TYPE_META[item.notification.type] ?? { label: item.notification.type, icon: <Bell className="h-4 w-4" />, color: "text-muted-foreground" };
            const payload = item.notification.payload as Record<string, unknown>;
            const body = (payload["body"] as string) ?? "";
            const isUnread = !item.readAt;
            return (
              <div
                key={item.id}
                className={cn(
                  "flex items-start gap-4 px-5 py-4",
                  isUnread && "bg-accent/20"
                )}
              >
                <div className={cn("mt-0.5 shrink-0", meta.color)}>{meta.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {meta.label}
                    </span>
                    {isUnread && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
                  </div>
                  <p className="mt-0.5 text-sm">{body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {relativeTime(item.notification.createdAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
