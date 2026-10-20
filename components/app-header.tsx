"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Route } from "next";
import { NotificationBell } from "@/components/notifications/notification-bell";
import type { NavBucket } from "@/lib/entity";
import { bucketPathFor, inferBucketFromPathname } from "@/lib/buckets";
import { BananaLogo } from "@/components/logo";

interface AppHeaderProps {
  userName?: string;
  unreadCount?: number;
  navBuckets: NavBucket[];
  logoUrl?: string | null;
  onMenuClick: () => void;
}

export function AppHeader({ userName, unreadCount = 0, navBuckets, logoUrl, onMenuClick }: AppHeaderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeBucket =
    inferBucketFromPathname(pathname) ?? searchParams.get("bucket") ?? "personal";
  const activeTabRef = useRef<HTMLElement | null>(null);

  // Phones: the tabs are their own swipeable row, so bring the active one (e.g. Projects or Taxes at the end) into view.
  // Only below md and only "nearest", so the page itself never scrolls.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 767.98px)").matches) return;
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeBucket]);

  function switchBucket(slug: string) {
    const nextPath = bucketPathFor(pathname, slug);
    const params = new URLSearchParams(searchParams.toString());
    params.set("bucket", slug);
    router.push(`${nextPath}?${params.toString()}` as Route);
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="flex items-center gap-4 px-4 md:h-14 max-md:min-h-14 max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-0 max-md:pt-2">
        <button
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent max-md:p-3 md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/" className="shrink-0">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Logo" className="h-7 w-auto max-w-[140px] object-contain max-md:max-w-[110px]" />
          ) : (
            <BananaLogo size="sm" />
          )}
        </Link>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto max-md:order-last max-md:-mx-4 max-md:basis-full max-md:px-4 max-md:pb-2 max-md:pt-1">
          {navBuckets.map(({ slug, label, type }) => {
            const isActive = activeBucket === slug;
            const cls = cn(
              "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors max-md:py-2.5",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            );
            if (type === "projects" || type === "taxes") {
              const href = type === "projects" ? "/projects" : "/tax";
              return (
                <Link key={slug} href={href as Route} className={cls} ref={isActive ? (el) => { activeTabRef.current = el; } : undefined}>
                  {label}
                </Link>
              );
            }
            return (
              <button key={slug} onClick={() => switchBucket(slug)} className={cls} ref={isActive ? (el) => { activeTabRef.current = el; } : undefined}>
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2 max-md:ml-auto">
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
