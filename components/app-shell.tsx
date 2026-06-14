import { Suspense } from "react";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";

const BUCKETS = [
  { slug: "personal", label: "Personal" },
  { slug: "sudden-valley", label: "Sudden Valley" },
  { slug: "ek-consulting", label: "EK Consulting" },
  { slug: "mezzo", label: "Mezzo" },
] as const;

export type BucketSlug = (typeof BUCKETS)[number]["slug"];

export const BUCKET_ENTITY_NAMES: Record<BucketSlug, string> = {
  personal: "Personal",
  "sudden-valley": "Sudden Valley Property Management, LLC",
  "ek-consulting": "Eric Kinniburgh Consulting, LLC",
  mezzo: "Mezzo",
};

interface AppShellProps {
  children: React.ReactNode;
  userName?: string;
}

export function AppShell({ children, userName }: AppShellProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Suspense fallback={<div className="h-14 border-b bg-background" />}>
        <AppHeader userName={userName} />
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
