import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShellNav } from "./app-shell-nav";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getNavBuckets } from "@/lib/entity";
import { getLogoMeta } from "@/lib/settings";
export type { BucketSlug } from "@/lib/buckets";
export { BUCKET_ENTITY_NAMES } from "@/lib/buckets";

interface AppShellProps {
  children: React.ReactNode;
  userName?: string;
}

export async function AppShell({ children, userName }: AppShellProps) {
  const session = await auth();
  if (session?.user && !(session.user as { totpVerified?: boolean }).totpVerified) {
    redirect("/setup-2fa");
  }
  const [unreadCount, navBuckets, logoMeta] = await Promise.all([
    session?.user?.id
      ? db.notificationUser.count({ where: { userId: session.user.id, readAt: null } })
      : Promise.resolve(0),
    getNavBuckets(),
    getLogoMeta(),
  ]);
  const logoUrl = logoMeta ? "/api/logo" : null;

  const businessSlugs = navBuckets
    .filter((b) => b.type === "business")
    .map((b) => b.slug);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Suspense fallback={<div className="h-14 border-b bg-background" />}>
        <AppShellNav
          userName={userName}
          unreadCount={unreadCount}
          navBuckets={navBuckets}
          logoUrl={logoUrl}
          businessSlugs={businessSlugs}
        >
          {children}
        </AppShellNav>
      </Suspense>
    </div>
  );
}
