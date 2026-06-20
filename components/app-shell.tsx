import { Suspense } from "react";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
export type { BucketSlug } from "@/lib/buckets";
export { BUCKET_ENTITY_NAMES } from "@/lib/buckets";

interface AppShellProps {
  children: React.ReactNode;
  userName?: string;
}

export async function AppShell({ children, userName }: AppShellProps) {
  const session = await auth();
  const unreadCount = session?.user?.id
    ? await db.notificationUser.count({ where: { userId: session.user.id, readAt: null } })
    : 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Suspense fallback={<div className="h-14 border-b bg-background" />}>
        <AppHeader userName={userName} unreadCount={unreadCount} />
      </Suspense>
      <div className="flex flex-1 overflow-hidden">
        <Suspense fallback={<div className="w-56 shrink-0 border-r" />}>
          <AppSidebar />
        </Suspense>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
