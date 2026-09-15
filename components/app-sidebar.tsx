"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Settings, LockKeyhole, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Route } from "next";
import { inferBucketFromPathname } from "@/lib/buckets";

const TAX_BUCKET = "taxes";
const ENVELOPE_BUCKETS = ["personal", "sudden-valley"] as const;

export interface TaxEntityLink {
  slug: string;
  label: string;
  href: string;
}

interface AppSidebarProps {
  businessSlugs: string[];
  mobileOpen: boolean;
  onMobileClose: () => void;
  taxEntityLinks: TaxEntityLink[];
  taxFormsHref: string;
  taxMileageHref: string | null;
}

interface SidebarNavContentProps {
  pathname: string;
  activeBucket: string;
  isBusinessBucket: boolean;
  isTaxBucket: boolean;
  isProjectsBucket: boolean;
  isPersonalBucket: boolean;
  buildHref: (base: string) => Route;
  isActive: (base: string) => boolean;
  taxEntityLinks: TaxEntityLink[];
  taxFormsHref: string;
  taxMileageHref: string | null;
  onNavigate?: () => void;
}

function SidebarNavContent({
  pathname,
  activeBucket,
  isBusinessBucket,
  isTaxBucket,
  isProjectsBucket,
  isPersonalBucket,
  buildHref,
  isActive,
  taxEntityLinks,
  taxFormsHref,
  taxMileageHref,
  onNavigate,
}: SidebarNavContentProps) {
  const coreItems = [
    { label: "Dashboard", base: "/" },
    { label: "Transactions", base: "/transactions" },
    { label: "Budgets", base: "/budgets" },
    { label: "Forecast", base: "/forecast" },
    { label: "Accounts", base: "/accounts" },
    { label: "Advisor", base: "/advisor" },
  ];

  const envelopeItem = { label: "Envelopes", base: "/envelope" };

  const businessItems = [
    { label: "Revenue", base: `/business/${activeBucket}/revenue`, href: buildHref(`/business/${activeBucket}/revenue`) },
    { label: "Receipts", base: "/receipts", href: buildHref("/receipts") },
    {
      label: "P&L Report",
      base: `/business/${activeBucket}/pl`,
      href: buildHref(`/business/${activeBucket}/pl`),
    },
    {
      label: "Balance Sheet",
      base: `/business/${activeBucket}/balance-sheet`,
      href: buildHref(`/business/${activeBucket}/balance-sheet`),
    },
    {
      label: "Bank Statements",
      base: `/business/${activeBucket}/statements`,
      href: buildHref(`/business/${activeBucket}/statements`),
    },
    { label: "Tax Workspaces", base: "/tax", href: buildHref("/tax") },
    { label: "Debt Tracker", base: "/personal/debt-free", href: buildHref("/personal/debt-free") },
  ];

  const personalItems = [
    { label: "Income", base: "/personal/income", href: "/personal/income" as Route },
    { label: "Net Worth", base: "/personal/net-worth", href: "/personal/net-worth" as Route },
    { label: "Mortgage", base: "/personal/mortgage", href: "/personal/mortgage" as Route },
    { label: "Debt Tracker", base: "/personal/debt-free", href: "/personal/debt-free" as Route },
    { label: "Savings autopilot", base: "/personal/savings-autopilot", href: "/personal/savings-autopilot" as Route },
    { label: "Retirement", base: "/personal/retirement", href: "/personal/retirement" as Route },
    { label: "Insurance", base: "/personal/insurance", href: "/personal/insurance" as Route },
    { label: "Projects", base: "/projects", href: "/projects" as Route },
    { label: "Receipts", base: "/receipts", href: "/receipts" as Route },
  ];

  return (
    <>
      <nav className="flex-1 overflow-y-auto py-4">
        <ul className="space-y-0.5 px-2">
          {!isTaxBucket && !isProjectsBucket && (
            <>
              {coreItems.map(({ label, base }) => (
                <li key={base}>
                  <Link
                    href={buildHref(base)}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                      isActive(base)
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {label}
                  </Link>
                </li>
              ))}

              {(ENVELOPE_BUCKETS as readonly string[]).includes(activeBucket) && (
                <li>
                  <Link
                    href={buildHref(envelopeItem.base)}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                      isActive(envelopeItem.base)
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {envelopeItem.label}
                  </Link>
                </li>
              )}
            </>
          )}

          {isPersonalBucket && (
            <>
              <li className="pt-4 pb-1">
                <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Personal
                </span>
              </li>
              {personalItems.map(({ label, base, href }) => (
                <li key={base}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                      isActive(base)
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </>
          )}

          {isBusinessBucket && (
            <>
              <li className="pt-4 pb-1">
                <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Business
                </span>
              </li>
              {businessItems.map(({ label, base, href }) => (
                <li key={base}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                      isActive(base)
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </>
          )}

          {isProjectsBucket && (
            <>
              <li className="pt-4 pb-1">
                <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Projects
                </span>
              </li>
              <li>
                <Link
                  href={"/projects" as Route}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                    pathname === "/projects"
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  All projects
                </Link>
              </li>
            </>
          )}

          {isTaxBucket && (
            <>
              <li className="pt-4 pb-1">
                <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Taxes
                </span>
              </li>
              {[
                { label: "Workspaces", base: "/tax", href: "/tax" as Route },
                { label: "Documents", base: "/documents", href: "/documents" as Route },
                ...(taxMileageHref
                  ? [{ label: "Mileage", base: taxMileageHref, href: taxMileageHref as Route }]
                  : []),
                { label: "Forms", base: taxFormsHref, href: taxFormsHref as Route },
                { label: "Envelopes", base: "/envelope", href: "/envelope?bucket=taxes" as Route },
              ].map(({ label, base, href }) => (
                <li key={base}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                      isActive(base)
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {label}
                  </Link>
                </li>
              ))}

              <li className="pt-4 pb-1">
                <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Entities
                </span>
              </li>
              {taxEntityLinks.map(({ slug, label, href }) => (
                <li key={slug}>
                  <Link
                    href={href as Route}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                      pathname === href
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </>
          )}
        </ul>
      </nav>

      <div className="border-t px-2 py-3 space-y-0.5">
        <Link
          href={"/vault" as Route}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/vault")
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <LockKeyhole className="h-4 w-4" />
          Vault
        </Link>
        <Link
          href={"/tags" as Route}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/tags") && !pathname.startsWith("/tag-rules")
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Settings className="h-4 w-4" />
          Tags
        </Link>
        <Link
          href={"/tag-rules" as Route}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/tag-rules")
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Settings className="h-4 w-4" />
          Tag Rules
        </Link>
        <Link
          href={"/settings" as Route}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/settings")
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </div>
    </>
  );
}

export function AppSidebar({
  businessSlugs,
  mobileOpen,
  onMobileClose,
  taxEntityLinks,
  taxFormsHref,
  taxMileageHref,
}: AppSidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inferredBucket = inferBucketFromPathname(pathname);
  const activeBucket = inferredBucket ?? searchParams.get("bucket") ?? "personal";
  const isBusinessBucket = businessSlugs.includes(activeBucket);
  const isTaxBucket = activeBucket === TAX_BUCKET;
  const isProjectsBucket = activeBucket === "projects";
  const isPersonalBucket = !isBusinessBucket && !isTaxBucket && !isProjectsBucket;

  function buildHref(base: string): Route {
    return (activeBucket !== "personal" ? `${base}?bucket=${activeBucket}` : base) as Route;
  }

  function isActive(base: string): boolean {
    if (base === "/") return pathname === "/";
    return pathname === base || pathname.startsWith(base + "/");
  }

  // Safety net: close the mobile drawer on any pathname change, even one
  // that doesn't go through a plain <Link onClick> (e.g. a future
  // router.push call elsewhere in the tree).
  useEffect(() => {
    onMobileClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const navProps = {
    pathname,
    activeBucket,
    isBusinessBucket,
    isTaxBucket,
    isProjectsBucket,
    isPersonalBucket,
    buildHref,
    isActive,
    taxEntityLinks,
    taxFormsHref,
    taxMileageHref,
  };

  return (
    <>
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-background md:flex">
        <SidebarNavContent {...navProps} />
      </aside>

      <div
        className={cn(
          "fixed inset-0 z-50 md:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none"
        )}
        inert={!mobileOpen}
      >
        <div
          className={cn(
            "fixed inset-0 bg-black/40 transition-opacity",
            mobileOpen ? "opacity-100" : "opacity-0"
          )}
          onClick={onMobileClose}
          aria-hidden="true"
        />
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] flex-col border-r bg-background shadow-xl transition-transform",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="flex items-center justify-between border-b px-3 py-3">
            <span className="text-sm font-semibold">Menu</span>
            <button
              onClick={onMobileClose}
              aria-label="Close navigation menu"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <SidebarNavContent {...navProps} onNavigate={onMobileClose} />
        </aside>
      </div>
    </>
  );
}
