"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Settings, LockKeyhole } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Route } from "next";

const TAX_BUCKET = "taxes";
const ENVELOPE_BUCKETS = ["personal", "taxes", "sudden-valley"] as const;

interface AppSidebarProps {
  businessSlugs: string[];
}

export function AppSidebar({ businessSlugs }: AppSidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeBucket = searchParams.get("bucket") ?? "personal";
  const isBusinessBucket = businessSlugs.includes(activeBucket);
  const isTaxBucket = activeBucket === TAX_BUCKET;
  const isProjectsBucket = pathname.startsWith("/projects");
  const isPersonalBucket = !isBusinessBucket && !isTaxBucket && !isProjectsBucket;

  function buildHref(base: string): Route {
    return (activeBucket !== "personal" ? `${base}?bucket=${activeBucket}` : base) as Route;
  }

  function isActive(base: string): boolean {
    if (base === "/") return pathname === "/";
    return pathname === base || pathname.startsWith(base + "/");
  }

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
    { label: "Receipts", base: "/receipts", href: buildHref("/receipts") },
    {
      label: "P&L Report",
      base: `/business/${activeBucket}/pl`,
      href: buildHref(`/business/${activeBucket}/pl`),
    },
    { label: "Tax Workspaces", base: "/tax", href: buildHref("/tax") },
    { label: "Debt Tracker", base: "/personal/debt-free", href: "/personal/debt-free" as Route },
  ];

  const personalItems = [
    { label: "Net Worth", base: "/personal/net-worth", href: "/personal/net-worth" as Route },
    { label: "Mortgage", base: "/personal/mortgage", href: "/personal/mortgage" as Route },
    { label: "Debt-Free", base: "/personal/debt-free", href: "/personal/debt-free" as Route },
    { label: "Savings autopilot", base: "/personal/savings-autopilot", href: "/personal/savings-autopilot" as Route },
    { label: "Retirement", base: "/personal/retirement", href: "/personal/retirement" as Route },
    { label: "Insurance", base: "/personal/insurance", href: "/personal/insurance" as Route },
    { label: "Projects", base: "/projects", href: "/projects" as Route },
    { label: "Receipts", base: "/receipts", href: "/receipts" as Route },
  ];

  const taxItems = [
    { label: "Tax Workspaces", base: "/tax", href: "/tax" as Route },
    { label: "Documents", base: "/documents", href: "/documents" as Route },
    { label: "Mileage", base: "/personal/mileage", href: "/personal/mileage" as Route },
  ];

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-background">
      <nav className="flex-1 overflow-y-auto py-4">
        <ul className="space-y-0.5 px-2">
          {coreItems.map(({ label, base }) => (
            <li key={base}>
              <Link
                href={buildHref(base)}
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
              {taxItems.map(({ label, base, href }) => (
                <li key={base}>
                  <Link
                    href={href}
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
        </ul>
      </nav>

      <div className="border-t px-2 py-3 space-y-0.5">
        <Link
          href={"/vault" as Route}
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
    </aside>
  );
}
