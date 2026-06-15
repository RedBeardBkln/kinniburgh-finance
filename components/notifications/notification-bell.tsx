"use client";

import { useState, useEffect, useRef } from "react";
import { Bell, AlertTriangle, TrendingDown, PiggyBank, Calendar, BarChart2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getNotifications, markRead, markAllRead } from "@/actions/notifications";

type NotifRow = Awaited<ReturnType<typeof getNotifications>>[number];

const TYPE_ICONS: Record<string, React.ReactNode> = {
  overspend: <BarChart2 className="h-4 w-4 text-orange-500 shrink-0" />,
  low_balance: <TrendingDown className="h-4 w-4 text-red-500 shrink-0" />,
  accrual_shortfall: <PiggyBank className="h-4 w-4 text-yellow-500 shrink-0" />,
  bill_due: <Calendar className="h-4 w-4 text-blue-500 shrink-0" />,
  anomaly: <AlertTriangle className="h-4 w-4 text-purple-500 shrink-0" />,
};

function relativeTime(date: Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Props {
  initialUnreadCount: number;
}

export function NotificationBell({ initialUnreadCount }: Props) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnreadCount);
  const [items, setItems] = useState<NotifRow[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Register service worker on mount
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  async function openDropdown() {
    setOpen((v) => !v);
    if (!open) {
      setLoading(true);
      const rows = await getNotifications();
      setItems(rows);
      setUnread(rows.filter((r) => !r.readAt).length);
      setLoading(false);
    }
  }

  async function handleMarkRead(nuId: string) {
    await markRead(nuId);
    setItems((prev) => prev.map((i) => (i.id === nuId ? { ...i, readAt: new Date() } : i)));
    setUnread((n) => Math.max(0, n - 1));
  }

  async function handleMarkAllRead() {
    await markAllRead();
    setItems((prev) => prev.map((i) => ({ ...i, readAt: new Date() })));
    setUnread(0);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={openDropdown}
        aria-label="Notifications"
        className="relative rounded-md p-2 text-muted-foreground hover:bg-accent"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button onClick={handleMarkAllRead} className="text-xs text-primary hover:underline">
                  Mark all read
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</div>
            )}
            {!loading && items.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No notifications yet.
              </div>
            )}
            {!loading &&
              items.slice(0, 10).map((item) => {
                const payload = item.notification.payload as Record<string, unknown>;
                const body = (payload["body"] as string) ?? "";
                const type = item.notification.type;
                const isUnread = !item.readAt;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex items-start gap-3 border-b px-4 py-3 last:border-0",
                      isUnread ? "bg-accent/30" : "opacity-70"
                    )}
                  >
                    <div className="mt-0.5">{TYPE_ICONS[type] ?? <Bell className="h-4 w-4 shrink-0" />}</div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-relaxed">{body}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {relativeTime(item.notification.createdAt)}
                      </p>
                    </div>
                    {isUnread && (
                      <button
                        onClick={() => handleMarkRead(item.id)}
                        className="shrink-0 text-[10px] text-primary hover:underline"
                      >
                        Read
                      </button>
                    )}
                  </div>
                );
              })}
          </div>

          <div className="border-t px-4 py-2">
            <a href="/notifications" className="text-xs text-primary hover:underline">
              View all notifications →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
