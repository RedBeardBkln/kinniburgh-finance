"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import type { Route } from "next";
import { NotificationBell } from "@/components/notifications/notification-bell";
import type { NavBucket } from "@/lib/entity";

interface AppHeaderProps {
  userName?: string;
  unreadCount?: number;
  navBuckets: NavBucket[];
}

function inferBucketFromPathname(pathname: string): string | null {
  if (pathname.startsWith("/tax")) return "taxes";
  if (pathname.startsWith("/business/")) {
    const slug = pathname.split("/")[2];
    return slug ?? null;
  }
  return null;
}

export function AppHeader({ userName, unreadCount = 0, navBuckets }: AppHeaderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeBucket =
    inferBucketFromPathname(pathname) ?? searchParams.get("bucket") ?? "personal";

  function switchBucket(slug: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("bucket", slug);
    router.push(`${pathname}?${params.toString()}` as Route);
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="flex h-14 items-center gap-4 px-4">
        <Link href="/" className="shrink-0 text-base font-semibold">
          Banana Stand
        </Link>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {navBuckets.map(({ slug, label }) => (
            <button
              key={slug}
              onClick={() => switchBucket(slug)}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                activeBucket === slug
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NotificationBell initialUnreadCount={unreadCount} />
          {userName && (
            <span className="hidden text-sm text-muted-foreground sm:block">
              {userName}
            </span>
          )}
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
