"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Route } from "next";

const BUSINESS_BUCKETS = ["sudden-valley", "ek-consulting", "mezzo"] as const;

const COMMON_ITEMS = [
  { label: "Transactions", base: "/transactions" },
  { label: "Budgets", base: "/budgets" },
  { label: "Envelopes", base: "/envelope" },
  { label: "Forecast", base: "/forecast" },
  { label: "Accounts", base: "/accounts" },
];

export function AppSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeBucket = searchParams.get("bucket") ?? "personal";
  const isBusinessBucket = (BUSINESS_BUCKETS as readonly string[]).includes(activeBucket);

  function buildHref(base: string): Route {
    return (activeBucket !== "personal" ? `${base}?bucket=${activeBucket}` : base) as Route;
  }

  function isActive(base: string): boolean {
    return pathname === base || pathname.startsWith(base + "/");
  }

  const businessItems = [
    { label: "Receipts", base: "/receipts", href: buildHref("/receipts") },
    {
      label: "P&L Report",
      base: `/business/${activeBucket}/pl`,
      href: `/business/${activeBucket}/pl` as Route,
    },
    { label: "Taxes", base: "/tax", href: buildHref("/tax") },
  ];

  const personalItems = [
    { label: "Net Worth", base: "/personal/net-worth", href: "/personal/net-worth" as Route },
    { label: "Mortgage", base: "/personal/mortgage", href: "/personal/mortgage" as Route },
    { label: "Debt-Free", base: "/personal/debt-free", href: "/personal/debt-free" as Route },
    { label: "Savings autopilot", base: "/personal/savings-autopilot", href: "/personal/savings-autopilot" as Route },
    { label: "Retirement", base: "/personal/retirement", href: "/personal/retirement" as Route },
    { label: "Insurance", base: "/personal/insurance", href: "/personal/insurance" as Route },
    { label: "Projects", base: "/personal/projects", href: "/personal/projects" as Route },
  ];

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-background">
      <nav className="flex-1 overflow-y-auto py-4">
        <ul className="space-y-0.5 px-2">
          {COMMON_ITEMS.map(({ label, base }) => (
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

          {!isBusinessBucket && (
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
        </ul>
      </nav>

      <div className="border-t px-2 py-3">
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
