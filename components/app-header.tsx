"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import type { Route } from "next";
import { NotificationBell } from "@/components/notifications/notification-bell";
import type { NavBucket } from "@/lib/entity";
import { BananaLogo } from "@/components/logo";

interface AppHeaderProps {
  userName?: string;
  unreadCount?: number;
  navBuckets: NavBucket[];
  logoUrl?: string | null;
}

function inferBucketFromPathname(pathname: string): string | null {
  if (pathname.startsWith("/tax")) return "taxes";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/business/")) {
    const slug = pathname.split("/")[2];
    return slug ?? null;
  }
  return null;
}

export function AppHeader({ userName, unreadCount = 0, navBuckets, logoUrl }: AppHeaderProps) {
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
        <Link href="/" className="shrink-0">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Logo" className="h-7 w-auto max-w-[140px] object-contain" />
          ) : (
            <BananaLogo size="sm" />
          )}
        </Link>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {navBuckets.map(({ slug, label, type }) => {
            const isActive = activeBucket === slug;
            const cls = cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            );
            if (type === "projects" || type === "taxes") {
              const href = type === "projects" ? "/projects" : "/tax";
              return (
                <Link key={slug} href={href as Route} className={cls}>
                  {label}
                </Link>
              );
            }
            return (
              <button key={slug} onClick={() => switchBucket(slug)} className={cls}>
                {label}
              </button>
            );
          })}
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
