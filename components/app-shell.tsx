import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getNavBuckets } from "@/lib/entity";
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
  const [unreadCount, navBuckets] = await Promise.all([
    session?.user?.id
      ? db.notificationUser.count({ where: { userId: session.user.id, readAt: null } })
      : Promise.resolve(0),
    getNavBuckets(),
  ]);

  const businessSlugs = navBuckets
    .filter((b) => b.type === "business")
    .map((b) => b.slug);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Suspense fallback={<div className="h-14 border-b bg-background" />}>
        <AppHeader userName={userName} unreadCount={unreadCount} navBuckets={navBuckets} />
      </Suspense>
      <div className="flex flex-1 overflow-hidden">
        <Suspense fallback={<div className="w-56 shrink-0 border-r" />}>
          <AppSidebar businessSlugs={businessSlugs} />
        </Suspense>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
