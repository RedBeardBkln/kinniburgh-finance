import Link from "next/link";
import type { Route } from "next";

// In-page navigation for the invoicing screens. (The main sidebar entries are task 1.13, not built yet; until then these links are
// the way between the invoicing pages.)

const ITEMS = [
  { key: "invoices", label: "Invoices", path: "invoices" },
  { key: "clients", label: "Clients", path: "clients" },
  { key: "items", label: "Items", path: "items" },
  { key: "settings", label: "Settings", path: "invoicing/settings" },
] as const;

export function InvoicingNav({ slug, active }: { slug: string; active: (typeof ITEMS)[number]["key"] }) {
  return (
    <nav aria-label="Invoicing" className="flex flex-wrap gap-1 border-b pb-2">
      {ITEMS.map((i) => (
        <Link
          key={i.key}
          href={`/business/${slug}/${i.path}` as Route}
          className={`rounded-md px-3 py-1.5 text-sm ${i.key === active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
