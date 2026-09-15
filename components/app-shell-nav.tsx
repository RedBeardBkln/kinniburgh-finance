"use client";

import { useState } from "react";
import { AppHeader } from "./app-header";
import { AppSidebar, type TaxEntityLink } from "./app-sidebar";
import type { NavBucket } from "@/lib/entity";

interface AppShellNavProps {
  userName?: string;
  unreadCount: number;
  navBuckets: NavBucket[];
  logoUrl: string | null;
  businessSlugs: string[];
  taxEntityLinks: TaxEntityLink[];
  taxFormsHref: string;
  taxMileageHref: string | null;
  children: React.ReactNode;
}

export function AppShellNav({
  userName,
  unreadCount,
  navBuckets,
  logoUrl,
  businessSlugs,
  taxEntityLinks,
  taxFormsHref,
  taxMileageHref,
  children,
}: AppShellNavProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <>
      <AppHeader
        userName={userName}
        unreadCount={unreadCount}
        navBuckets={navBuckets}
        logoUrl={logoUrl}
        onMenuClick={() => setMobileNavOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <AppSidebar
          businessSlugs={businessSlugs}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          taxEntityLinks={taxEntityLinks}
          taxFormsHref={taxFormsHref}
          taxMileageHref={taxMileageHref}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
        </main>
      </div>
    </>
  );
}
